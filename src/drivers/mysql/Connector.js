const { _ } = require('@genx/july');
const { tryRequire } = require('@genx/sys');
const mysql = tryRequire('mysql2/promise');
const Connector = require('../../Connector');
const { ApplicationError, InvalidArgument } = require('../../utils/Errors');
const { isQuoted } = require('../../utils/lang');
const ntol = require('number-to-letter');

/**
 * MySQL data storage connector.
 * @class
 * @extends Connector
 */
class MySQLConnector extends Connector {
    /**
     * Transaction isolation level
     * {@link https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html}
     * @member {object}
     */
    static IsolationLevels = Object.freeze({
        RepeatableRead: 'REPEATABLE READ',
        ReadCommitted: 'READ COMMITTED',
        ReadUncommitted: 'READ UNCOMMITTED',
        Rerializable: 'SERIALIZABLE',
    });

    escape = mysql.escape;
    escapeId = mysql.escapeId;
    format = mysql.format;
    raw = mysql.raw;
    queryCount = (alias, fieldName) => ({
        type: 'function',
        name: 'COUNT',
        args: [fieldName || '*'],
        alias: alias || 'count',
    });

    $call = (name, alias, args) => ({ type: 'function', name, alias, args });
    $as = (name, alias) => ({ type: 'column', name, alias });

    // in mysql, null value comparison will never return true, even null != 1
    nullOrIs = (fieldName, value) => [
        { [fieldName]: { $exists: false } },
        { [fieldName]: { $eq: value } },
    ];

    updatedCount = (context) => context.result.affectedRows;
    deletedCount = (context) => context.result.affectedRows;

    typeCast(value) {
        const t = typeof value;

        if (t === 'boolean') return value ? 1 : 0;

        if (t === 'object') {
            if (value != null && value.isLuxonDateTime) {
                return value.toISO({ includeOffset: false });
            }
        }

        return value;
    }

    /**
     * @param {string} name
     * @param {object} options
     * @property {boolean} [options.usePreparedStatement] - Flat to use prepared statement to improve query performance.
     * @property {boolean} [options.logStatement] - Flag to log executed SQL statement.
     */
    constructor(connectionString, options) {
        super('mysql', connectionString, options);

        this.relational = true;
        this.acitveConnections = new Set();
        this.executedCount = 0;
    }

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {
        if (this.acitveConnections.size > 0) {
            for (const conn of this.acitveConnections) {
                await this.disconnect_(conn);
            }
        }

        if (this.pool) {
            this.log(
                'debug',
                `Close connection pool to ${this.currentConnectionString}`
            );
            await this.pool.end();
            delete this.pool;
        }
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<MySQLConnection>}
     */
    async connect_(options) {
        let csKey = this.connectionString;
        if (!this.currentConnectionString) {
            this.currentConnectionString = csKey;
        }

        if (options) {
            const connProps = {};

            if (options.createDatabase) {
                // remove the database from connection
                connProps.database = '';
            }

            connProps.options = _.pick(options, ['multipleStatements']);

            csKey = this.makeNewConnectionString(connProps);
        }

        if (csKey !== this.currentConnectionString) {
            await this.end_();
            this.currentConnectionString = csKey;
        }

        if (!this.pool) {
            this.log('debug', `Create connection pool to ${csKey}`);
            this.pool = mysql.createPool(csKey);
        }

        const conn = await this.pool.getConnection();
        this.acitveConnections.add(conn);

        this.log('debug', `Connect to ${csKey}`);

        return conn;
    }

    /**
     * Close a database connection.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async disconnect_(conn) {
        this.log('debug', `Disconnect from ${this.currentConnectionString}`);
        this.acitveConnections.delete(conn);
        return conn.release();
    }

    /**
     * Start a transaction.
     * @param {object} options - Options
     * @property {string} [options.isolationLevel]
     */
    async beginTransaction_(options) {
        const conn = await this.connect_();

        if (options && options.isolationLevel) {
            // only allow valid option value to avoid injection attach
            const isolationLevel = _.find(
                MySQLConnector.IsolationLevels,
                (value, key) =>
                    options.isolationLevel === key ||
                    options.isolationLevel === value
            );
            if (!isolationLevel) {
                throw new ApplicationError(
                    `Invalid isolation level: "${isolationLevel}"!"`
                );
            }

            await conn.query(
                'SET SESSION TRANSACTION ISOLATION LEVEL ' + isolationLevel
            );
        }

        const [ret] = await conn.query('SELECT @@autocommit;');
        conn.$$autocommit = ret[0]['@@autocommit'];

        await conn.query('SET SESSION autocommit=0;');
        await conn.query('START TRANSACTION;');

        this.log('verbose', 'Begins a new transaction.');
        return conn;
    }

    /**
     * Commit a transaction.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async commit_(conn) {
        await conn.query('COMMIT;');
        this.log(
            'verbose',
            `Commits a transaction. Previous autocommit=${conn.$$autocommit}`
        );
        if (conn.$$autocommit) {
            await conn.query('SET SESSION autocommit=1;');
            delete conn.$$autocommit;
        }

        return this.disconnect_(conn);
    }

    /**
     * Rollback a transaction.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async rollback_(conn) {
        await conn.query('ROLLBACK;');
        this.log(
            'verbose',
            `Rollbacks a transaction. Previous autocommit=${conn.$$autocommit}`
        );
        if (conn.$$autocommit) {
            await conn.query('SET SESSION autocommit=1;');
            delete conn.$$autocommit;
        }

        return this.disconnect_(conn);
    }

    /**
     * Execute the sql statement.
     *
     * @param {String} sql - The SQL statement to execute.
     * @param {object} params - Parameters to be placed into the SQL statement.
     * @param {object} [options] - Execution options.
     * @property {boolean} [options.usePreparedStatement] - Whether to use prepared statement which is cached and re-used by connection.
     * @property {boolean} [options.rowsAsArray] - To receive rows as array of columns instead of hash with column name as key.
     * @property {MySQLConnection} [options.connection] - Existing connection.
     */
    async execute_(sql, params, options) {
        let conn;

        try {
            conn = await this._getConnection_(options);

            if (
                this.options.usePreparedStatement ||
                (options && options.usePreparedStatement)
            ) {
                if (this.options.logStatement) {
                    this.log('verbose', conn.format(sql, params));
                }

                if (options && options.rowsAsArray) {
                    return await conn.execute(
                        { sql, rowsAsArray: true },
                        params
                    );
                }

                const [rows1] = await conn.execute(sql, params);
                this.executedCount++;

                return rows1;
            }

            if (this.options.logStatement) {
                this.log('verbose', conn.format(sql, params));
            }

            if (options && options.rowsAsArray) {
                const result = await conn.query(
                    { sql, rowsAsArray: true },
                    params
                );
                this.executedCount++;
                return result;
            }

            const [rows2] = await conn.query(sql, params);
            this.executedCount++;

            return rows2;
        } catch (err) {
            err.info || (err.info = {});
            err.info.sql = _.truncate(sql, { length: 200 });
            err.info.params = params;

            throw err;
        } finally {
            conn && (await this._releaseConnection_(conn, options));
        }
    }

    async ping_() {
        const [ping] = await this.execute_('SELECT 1 AS result');
        return ping && ping.result === 1;
    }

    /**
     * Create a new entity.
     * @param {string} model
     * @param {object} data
     * @param {*} options
     */
    async create_(model, data, options) {
        if (!data || _.isEmpty(data)) {
            throw new ApplicationError(`Creating with empty "${model}" data.`);
        }

        const { insertIgnore, ...restOptions } = options || {};

        const sql = `INSERT ${insertIgnore ? 'IGNORE ' : ''}INTO ?? SET ?`;
        const params = [model];
        params.push(data);

        return this.execute_(sql, params, restOptions);
    }

    /**
     * Create a new entity or update the old one if duplicate key found.
     * @param {*} model
     * @param {*} data
     * @param {*} uniqueKeys
     * @param {*} options
     * @param {object} dataOnInsert - When no duplicate record exists, extra data for inserting
     * @returns
     */
    async upsertOne_(model, data, uniqueKeys, options, dataOnInsert) {
        if (!data || _.isEmpty(data)) {
            throw new ApplicationError(`Creating with empty "${model}" data.`);
        }

        const dataWithoutUK = _.omit(data, uniqueKeys);
        const insertData = { ...data, ...dataOnInsert };

        if (_.isEmpty(dataWithoutUK)) {
            // if dupliate, dont need to update
            return this.create_(model, insertData, {
                ...options,
                insertIgnore: true,
            });
        }

        const sql = `INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ?`;
        const params = [model];
        params.push(insertData);
        params.push(dataWithoutUK);

        const result = await this.execute_(sql, params, options);

        return {
            upsert: true,
            ...result,
        };
    }

    /**
     * Insert many records or update existings if duplicate key found.
     * @param {*} model
     * @param {array} dataArrayOnInsert
     * @param {*} uniqueKeys
     * @param {*} options
     * @param {object} dataExprOnUpdate - When duplicate record exists, the actual data used for updating
     * @returns
     */
    async upsertMany_(
        model,
        fieldsOnInsert,
        dataArrayOnInsert,
        dataExprOnUpdate,
        options
    ) {
        if (!dataArrayOnInsert || _.isEmpty(dataArrayOnInsert)) {
            throw new ApplicationError(
                `Upserting with empty "${model}" insert data.`
            );
        }

        if (!Array.isArray(dataArrayOnInsert)) {
            throw new ApplicationError(
                '"data" to bulk upsert should be an array of records.'
            );
        }

        if (!dataExprOnUpdate || _.isEmpty(dataExprOnUpdate)) {
            throw new ApplicationError(
                `Upserting with empty "${model}" update data.`
            );
        }

        if (!Array.isArray(fieldsOnInsert)) {
            throw new ApplicationError(
                '"fields" to bulk upsert should be an array of field names.'
            );
        }

        const sql = `INSERT INTO ?? (${fieldsOnInsert
            .map((f) => this.escapeId(f))
            .join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ?`;
        const params = [model];
        params.push(dataArrayOnInsert);
        params.push(dataExprOnUpdate);

        return this.execute_(sql, params, options);
    }

    /**
     * Insert many records in one SQL
     * @param {*} model
     * @param {*} fields
     * @param {*} data
     * @param {*} options
     * @returns
     */
    async insertMany_(model, fields, data, options) {
        if (!data || _.isEmpty(data)) {
            throw new ApplicationError(`Creating with empty "${model}" data.`);
        }

        if (!Array.isArray(data)) {
            throw new ApplicationError(
                '"data" to bulk insert should be an array of records.'
            );
        }

        if (!Array.isArray(fields)) {
            throw new ApplicationError(
                '"fields" to bulk insert should be an array of field names.'
            );
        }

        const { insertIgnore, ...restOptions } = options || {};

        const sql = `INSERT ${insertIgnore ? 'IGNORE ' : ''}INTO ?? (${fields
            .map((f) => this.escapeId(f))
            .join(', ')}) VALUES ?`;
        const params = [model];
        params.push(data);

        return this.execute_(sql, params, restOptions);
    }

    insertOne_ = this.create_;

    /**
     * Update an existing entity.
     * @param {string} model
     * @param {object} data
     * @param {*} query
     * @param {*} queryOptions
     * @param {*} connOptions
     */
    async update_(model, data, query, queryOptions, connOptions) {
        if (_.isEmpty(data)) {
            throw new InvalidArgument('Data record is empty.', {
                model,
                query,
            });
        }

        const params = [];
        const aliasMap = { [model]: 'A' };
        let joinings;
        let hasJoining = false;
        const joiningParams = [];

        if (queryOptions && queryOptions.$relationships) {
            joinings = this._joinAssociations(
                queryOptions.$relationships,
                model,
                'A',
                aliasMap,
                1,
                joiningParams
            );
            hasJoining = model;
        }

        let sql = 'UPDATE ' + mysql.escapeId(model);

        if (hasJoining) {
            joiningParams.forEach((p) => params.push(p));
            sql += ' A ' + joinings.join(' ');
        }

        if ((queryOptions && queryOptions.$requireSplitColumns) || hasJoining) {
            sql +=
                ' SET ' +
                this._splitColumnsAsInput(
                    data,
                    params,
                    hasJoining,
                    aliasMap
                ).join(',');
        } else {
            params.push(data);
            sql += ' SET ?';
        }

        if (query) {
            const whereClause = this._joinCondition(
                query,
                params,
                null,
                hasJoining,
                aliasMap
            );
            if (whereClause) {
                sql += ' WHERE ' + whereClause;
            }
        }

        return this.execute_(sql, params, connOptions);
    }

    updateOne_ = this.update_;

    /**
     * Replace an existing entity or create a new one.
     * @param {string} model
     * @param {object} data
     * @param {*} options
     */
    async replace_(model, data, options) {
        const params = [model, data];

        const sql = 'REPLACE ?? SET ?';

        return this.execute_(sql, params, options);
    }

    /**
     * Remove an existing entity.
     * @param {string} model
     * @param {*} query
     * @param {*} deleteOptions
     * @param {*} options
     */
    async delete_(model, query, deleteOptions, options) {
        const params = [model];
        const aliasMap = { [model]: 'A' };
        let joinings;
        let hasJoining = false;
        const joiningParams = [];

        if (deleteOptions && deleteOptions.$relationships) {
            joinings = this._joinAssociations(
                deleteOptions.$relationships,
                model,
                'A',
                aliasMap,
                1,
                joiningParams
            );
            hasJoining = model;
        }

        let sql;

        if (hasJoining) {
            joiningParams.forEach((p) => params.push(p));
            sql = 'DELETE A FROM ?? A ' + joinings.join(' ');
        } else {
            sql = 'DELETE FROM ??';
        }

        const whereClause = this._joinCondition(
            query,
            params,
            null,
            hasJoining,
            aliasMap
        );
        if (whereClause) {
            sql += ' WHERE ' + whereClause;
        }

        return this.execute_(sql, params, options);
    }

    /**
     * Perform select operation.
     * @param {*} model
     * @param {*} condition
     * @param {*} connOptions
     */
    async find_(model, condition, connOptions) {
        const sqlInfo = this.buildQuery(model, condition);

        let result, totalCount;

        if (sqlInfo.countSql) {
            const [countResult] = await this.execute_(
                sqlInfo.countSql,
                sqlInfo.params,
                connOptions
            );
            totalCount = countResult.count;
        }

        if (sqlInfo.hasJoining) {
            connOptions = { ...connOptions, rowsAsArray: true };
            result = await this.execute_(
                sqlInfo.sql,
                sqlInfo.params,
                connOptions
            );

            const reverseAliasMap = _.reduce(
                sqlInfo.aliasMap,
                (result, alias, nodePath) => {
                    result[alias] = nodePath
                        .split('.')
                        .slice(
                            1
                        ) /* .map(n => ':' + n) changed to be padding by orm and can be customized with other key getter */;
                    return result;
                },
                {}
            );

            if (sqlInfo.countSql) {
                return result.concat(reverseAliasMap, totalCount);
            }

            return result.concat(reverseAliasMap);
        } else if (condition.$skipOrm) {
            connOptions = { ...connOptions, rowsAsArray: true };
        }

        result = await this.execute_(sqlInfo.sql, sqlInfo.params, connOptions);

        if (sqlInfo.countSql) {
            return [result, totalCount];
        }

        return result;
    }

    /**
     * Build sql statement.
     * @param {*} model
     * @param {*} condition
     */
    buildQuery(
        model,
        {
            $relationships,
            $projection,
            $query,
            $groupBy,
            $orderBy,
            $offset,
            $limit,
            $totalCount,
        }
    ) {
        const params = [];
        const aliasMap = { [model]: 'A' };
        let joinings;
        let hasJoining = false;
        const joiningParams = [];

        // build alias map first
        // cache params
        if ($relationships) {
            joinings = this._joinAssociations(
                $relationships,
                model,
                'A',
                aliasMap,
                1,
                joiningParams
            );
            hasJoining = model;
        }

        const selectColomns = $projection
            ? this._buildColumns($projection, params, hasJoining, aliasMap)
            : '*';

        let sql = ' FROM ' + mysql.escapeId(model);

        // move cached joining params into params
        // should according to the place of clause in a sql

        if (hasJoining) {
            joiningParams.forEach((p) => params.push(p));
            sql += ' A ' + joinings.join(' ');
        }

        if ($query) {
            const whereClause = this._joinCondition(
                $query,
                params,
                null,
                hasJoining,
                aliasMap
            );
            if (whereClause) {
                sql += ' WHERE ' + whereClause;
            }
        }

        if ($groupBy) {
            sql +=
                ' ' +
                this._buildGroupBy($groupBy, params, hasJoining, aliasMap);
        }

        if ($orderBy) {
            sql += ' ' + this._buildOrderBy($orderBy, hasJoining, aliasMap);
        }

        const result = { params, hasJoining, aliasMap };

        if ($totalCount) {
            let countSubject;

            if (typeof $totalCount === 'string') {
                countSubject =
                    'DISTINCT(' +
                    this._escapeIdWithAlias($totalCount, hasJoining, aliasMap) +
                    ')';
            } else {
                countSubject = '*';
            }

            result.countSql = `SELECT COUNT(${countSubject}) AS count` + sql;
        }

        sql = 'SELECT ' + selectColomns + sql;

        if (_.isInteger($limit) && $limit > 0) {
            if (_.isInteger($offset) && $offset > 0) {
                sql += ' LIMIT ?, ?';
                params.push($offset);
                params.push($limit);
            } else {
                sql += ' LIMIT ?';
                params.push($limit);
            }
        } else if (_.isInteger($offset) && $offset > 0) {
            sql += ' LIMIT ?, 1000';
            params.push($offset);
        }

        result.sql = sql;

        return result;
    }

    getInsertedId(result) {
        return result && typeof result.insertId === 'number'
            ? result.insertId
            : undefined;
    }

    getNumOfAffectedRows(result) {
        return result && typeof result.affectedRows === 'number'
            ? result.affectedRows
            : undefined;
    }

    _generateAlias(index, anchor) {
        const alias = ntol(index);

        if (this.options.verboseAlias) {
            return _.snakeCase(anchor).toUpperCase() + '_' + alias;
        }

        return alias;
    }

    /**
     * Extract associations into joining clauses.
     *  {
     *      entity: <remote entity>
     *      joinType: 'LEFT JOIN|INNER JOIN|FULL OUTER JOIN'
     *      anchor: 'local property to place the remote entity'
     *      localField: <local field to join>
     *      remoteField: <remote field to join>
     *      subAssociations: { ... }
     *  }
     *
     * @param {*} associations
     * @param {*} parentAliasKey
     * @param {*} parentAlias
     * @param {*} aliasMap
     * @param {*} params
     */
    _joinAssociations(
        associations,
        parentAliasKey,
        parentAlias,
        aliasMap,
        startId,
        params
    ) {
        let joinings = [];

        _.each(associations, (assocInfo, anchor) => {
            const alias =
                assocInfo.alias || this._generateAlias(startId++, anchor);
            let { joinType, on } = assocInfo;

            joinType || (joinType = 'LEFT JOIN');

            if (assocInfo.sql) {
                if (assocInfo.output) {
                    aliasMap[parentAliasKey + '.' + alias] = alias;
                }

                assocInfo.params.forEach((p) => params.push(p));
                joinings.push(
                    `${joinType} (${
                        assocInfo.sql
                    }) ${alias} ON ${this._joinCondition(
                        on,
                        params,
                        null,
                        parentAliasKey,
                        aliasMap
                    )}`
                );

                return;
            }

            const { entity, subAssocs } = assocInfo;
            const aliasKey = parentAliasKey + '.' + anchor;
            aliasMap[aliasKey] = alias;

            if (subAssocs) {
                const subJoinings = this._joinAssociations(
                    subAssocs,
                    aliasKey,
                    alias,
                    aliasMap,
                    startId,
                    params
                );
                startId += subJoinings.length;

                joinings.push(
                    `${joinType} ${mysql.escapeId(
                        entity
                    )} ${alias} ON ${this._joinCondition(
                        on,
                        params,
                        null,
                        parentAliasKey,
                        aliasMap
                    )}`
                );
                joinings = joinings.concat(subJoinings);
            } else {
                joinings.push(
                    `${joinType} ${mysql.escapeId(
                        entity
                    )} ${alias} ON ${this._joinCondition(
                        on,
                        params,
                        null,
                        parentAliasKey,
                        aliasMap
                    )}`
                );
            }
        });

        return joinings;
    }

    /**
     * SQL condition representation
     *   Rules:
     *     default:
     *        array: OR
     *        kv-pair: AND
     *     $all:
     *        array: AND
     *     $any:
     *        kv-pair: OR
     *     $not:
     *        array: not ( or )
     *        kv-pair: not ( and )
     * @param {object} condition
     * @param {array} params
     */
    _joinCondition(condition, params, joinOperator, hasJoining, aliasMap) {
        if (Array.isArray(condition)) {
            if (!joinOperator) {
                joinOperator = 'OR';
            }
            return condition
                .map(
                    (c) =>
                        '(' +
                        this._joinCondition(
                            c,
                            params,
                            null,
                            hasJoining,
                            aliasMap
                        ) +
                        ')'
                )
                .join(` ${joinOperator} `);
        }

        if (_.isPlainObject(condition)) {
            if (!joinOperator) {
                joinOperator = 'AND';
            }

            return _.map(condition, (value, key) => {
                if (
                    key === '$all' ||
                    key === '$and' ||
                    key.startsWith('$and_')
                ) {
                    // for avoiding dupliate, $or_1, $or_2 is valid
                    if (!Array.isArray(value) && !_.isPlainObject(value)) {
                        throw new Error(
                            '"$and" operator value should be an array or plain object.'
                        );
                    }

                    return (
                        '(' +
                        this._joinCondition(
                            value,
                            params,
                            'AND',
                            hasJoining,
                            aliasMap
                        ) +
                        ')'
                    );
                }

                if (key === '$any' || key === '$or' || key.startsWith('$or_')) {
                    // for avoiding dupliate, $or_1, $or_2 is valid
                    if (!Array.isArray(value) && !_.isPlainObject(value)) {
                        throw new Error(
                            '"$or" operator value should be an array or plain object.'
                        );
                    }

                    return (
                        '(' +
                        this._joinCondition(
                            value,
                            params,
                            'OR',
                            hasJoining,
                            aliasMap
                        ) +
                        ')'
                    );
                }

                if (key === '$not') {
                    if (Array.isArray(value)) {
                        if (value.length === 0) {
                            throw new Error(
                                '"$not" operator value should be non-empty.'
                            );
                        }

                        return (
                            'NOT (' +
                            this._joinCondition(
                                value,
                                params,
                                null,
                                hasJoining,
                                aliasMap
                            ) +
                            ')'
                        );
                    }

                    if (_.isPlainObject(value)) {
                        if (_.isEmpty(value)) {
                            throw new Error(
                                '"$not" operator value should be non-empty.'
                            );
                        }

                        return (
                            'NOT (' +
                            this._joinCondition(
                                value,
                                params,
                                null,
                                hasJoining,
                                aliasMap
                            ) +
                            ')'
                        );
                    }

                    if (typeof value !== 'string') {
                        throw new Error('Unsupported condition!');
                    }

                    return 'NOT (' + condition + ')';
                }

                if (
                    (key === '$expr' || key.startsWith('$expr_')) &&
                    value.oorType &&
                    value.oorType === 'BinaryExpression'
                ) {
                    const left = this._packValue(
                        value.left,
                        params,
                        hasJoining,
                        aliasMap
                    );
                    const right = this._packValue(
                        value.right,
                        params,
                        hasJoining,
                        aliasMap
                    );
                    return left + ` ${value.op} ` + right;
                }

                return this._wrapCondition(
                    key,
                    value,
                    params,
                    hasJoining,
                    aliasMap
                );
            }).join(` ${joinOperator} `);
        }

        if (typeof condition !== 'string') {
            throw new Error(
                'Unsupported condition!\n Value: ' + JSON.stringify(condition)
            );
        }

        return condition;
    }

    _replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) {
        const parts = fieldName.split('.');
        if (parts.length > 1) {
            const actualFieldName = parts.pop();
            const aliasKey = mainEntity + '.' + parts.join('.');
            const alias = aliasMap[aliasKey];
            if (!alias) {
                throw new InvalidArgument(
                    `Column reference "${fieldName}" not found in populated associations.`,
                    {
                        entity: mainEntity,
                        alias: aliasKey,
                        aliasMap,
                    }
                );
            }

            return (
                alias +
                '.' +
                (actualFieldName === '*'
                    ? '*'
                    : mysql.escapeId(actualFieldName))
            );
        }

        if (aliasMap[fieldName] === fieldName) {
            return mysql.escapeId(fieldName);
        }

        return (
            aliasMap[mainEntity] +
            '.' +
            (fieldName === '*' ? '*' : mysql.escapeId(fieldName))
        );
    }

    _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
        if (mainEntity) {
            return this._replaceFieldNameWithAlias(
                fieldName,
                mainEntity,
                aliasMap
            );
        }

        return fieldName === '*' ? fieldName : mysql.escapeId(fieldName);
    }

    _splitColumnsAsInput(data, params, hasJoining, aliasMap) {
        return _.map(data, (v, fieldName) => {
            return (
                this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) +
                '=' +
                this._packValue(v, params, hasJoining, aliasMap)
            );
        });
    }

    _packArray(array, params, hasJoining, aliasMap) {
        return array
            .map((value) =>
                this._packValue(value, params, hasJoining, aliasMap)
            )
            .join(',');
    }

    _packValue(value, params, hasJoining, aliasMap) {
        if (_.isPlainObject(value)) {
            if (value.oorType) {
                switch (value.oorType) {
                    case 'ColumnReference':
                        return this._escapeIdWithAlias(
                            value.name,
                            hasJoining,
                            aliasMap
                        );

                    case 'Function':
                        return (
                            value.name +
                            '(' +
                            (value.args
                                ? this._packArray(
                                      value.args,
                                      params,
                                      hasJoining,
                                      aliasMap
                                  )
                                : '') +
                            ')'
                        );

                    case 'Raw':
                        return value.statement;

                    case 'Query':
                        return this._joinCondition(
                            value.query,
                            params,
                            null,
                            hasJoining,
                            aliasMap
                        );

                    case 'BinaryExpression': {
                        const left = this._packValue(
                            value.left,
                            params,
                            hasJoining,
                            aliasMap
                        );
                        const right = this._packValue(
                            value.right,
                            params,
                            hasJoining,
                            aliasMap
                        );
                        return left + ` ${value.op} ` + right;
                    }

                    default:
                        throw new Error(`Unknown oor type: ${value.oorType}`);
                }
            }

            value = JSON.stringify(value);
        }

        params.push(value);
        return '?';
    }

    /**
     * Wrap a condition clause
     *
     * Value can be a literal or a plain condition object.
     *   1. fieldName, <literal>
     *   2. fieldName, { normal object }
     *
     * @param {string} fieldName
     * @param {*} value
     * @param {array} params
     */
    _wrapCondition(fieldName, value, params, hasJoining, aliasMap, inject) {
        if (_.isNil(value)) {
            return (
                this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) +
                ' IS NULL'
            );
        }

        if (Array.isArray(value)) {
            return this._wrapCondition(
                fieldName,
                { $in: value },
                params,
                hasJoining,
                aliasMap,
                inject
            );
        }

        if (_.isPlainObject(value)) {
            if (value.oorType) {
                return (
                    this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) +
                    ' = ' +
                    this._packValue(value, params, hasJoining, aliasMap)
                );
            }

            const hasOperator = _.find(
                Object.keys(value),
                (k) => k && k[0] === '$'
            );

            if (hasOperator) {
                return _.map(value, (v, k) => {
                    if (k && k[0] === '$') {
                        // operator
                        switch (k) {
                            case '$exist':
                            case '$exists':
                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) + (v ? ' IS NOT NULL' : 'IS NULL')
                                );

                            case '$eq':
                            case '$equal':
                                return this._wrapCondition(
                                    fieldName,
                                    v,
                                    params,
                                    hasJoining,
                                    aliasMap,
                                    inject
                                );

                            case '$ne':
                            case '$neq':
                            case '$notEqual':
                                if (_.isNil(v)) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) + ' IS NOT NULL'
                                    );
                                }

                                v = this.typeCast(v);

                                if (inject) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) +
                                        ' <> ' +
                                        v
                                    );
                                }

                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) +
                                    ` <> ${this._packValue(
                                        v,
                                        params,
                                        hasJoining,
                                        aliasMap
                                    )}`
                                );

                            case '$>':
                            case '$gt':
                            case '$greaterThan':
                                v = this.typeCast(v);

                                if (inject) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) +
                                        ' > ' +
                                        v
                                    );
                                }

                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) +
                                    ` > ${this._packValue(
                                        v,
                                        params,
                                        hasJoining,
                                        aliasMap
                                    )}`
                                );

                            case '$>=':
                            case '$gte':
                            case '$greaterThanOrEqual':
                                v = this.typeCast(v);

                                if (inject) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) +
                                        ' >= ' +
                                        v
                                    );
                                }

                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) +
                                    ` >= ${this._packValue(
                                        v,
                                        params,
                                        hasJoining,
                                        aliasMap
                                    )}`
                                );

                            case '$<':
                            case '$lt':
                            case '$lessThan':
                                v = this.typeCast(v);

                                if (inject) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) +
                                        ' < ' +
                                        v
                                    );
                                }

                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) +
                                    ` < ${this._packValue(
                                        v,
                                        params,
                                        hasJoining,
                                        aliasMap
                                    )}`
                                );

                            case '$<=':
                            case '$lte':
                            case '$lessThanOrEqual':
                                v = this.typeCast(v);

                                if (inject) {
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) +
                                        ' <= ' +
                                        v
                                    );
                                }

                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) +
                                    ` <= ${this._packValue(
                                        v,
                                        params,
                                        hasJoining,
                                        aliasMap
                                    )}`
                                );

                            case '$in':
                                if (
                                    _.isPlainObject(v) &&
                                    v.oorType === 'DataSet'
                                ) {
                                    const sqlInfo = this.buildQuery(
                                        v.model,
                                        v.query
                                    );
                                    sqlInfo.params &&
                                        sqlInfo.params.forEach((p) =>
                                            params.push(p)
                                        );

                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) + ` IN (${sqlInfo.sql})`
                                    );
                                } else {
                                    if (!Array.isArray(v)) {
                                        throw new Error(
                                            'The value should be an array when using "$in" operator.'
                                        );
                                    }

                                    if (inject) {
                                        return (
                                            this._escapeIdWithAlias(
                                                fieldName,
                                                hasJoining,
                                                aliasMap
                                            ) + ` IN (${v})`
                                        );
                                    }

                                    params.push(v);
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) + ' IN (?)'
                                    );
                                }

                            case '$nin':
                            case '$notIn':
                                if (
                                    _.isPlainObject(v) &&
                                    v.oorType === 'DataSet'
                                ) {
                                    const sqlInfo = this.buildQuery(
                                        v.model,
                                        v.query
                                    );
                                    sqlInfo.params &&
                                        sqlInfo.params.forEach((p) =>
                                            params.push(p)
                                        );

                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) + ` NOT IN (${sqlInfo.sql})`
                                    );
                                } else {
                                    if (!Array.isArray(v)) {
                                        throw new Error(
                                            'The value should be an array when using "$in" operator.'
                                        );
                                    }

                                    if (inject) {
                                        return (
                                            this._escapeIdWithAlias(
                                                fieldName,
                                                hasJoining,
                                                aliasMap
                                            ) + ` NOT IN (${v})`
                                        );
                                    }

                                    params.push(v);
                                    return (
                                        this._escapeIdWithAlias(
                                            fieldName,
                                            hasJoining,
                                            aliasMap
                                        ) + ' NOT IN (?)'
                                    );
                                }

                            case '$startWith':
                            case '$startsWith':
                                if (typeof v !== 'string') {
                                    throw new Error(
                                        'The value should be a string when using "$startWith" operator.'
                                    );
                                }

                                params.push(`${v}%`);
                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) + ' LIKE ?'
                                );

                            case '$endWith':
                            case '$endsWith':
                                if (typeof v !== 'string') {
                                    throw new Error(
                                        'The value should be a string when using "$endWith" operator.'
                                    );
                                }

                                params.push(`%${v}`);
                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) + ' LIKE ?'
                                );

                            case '$like':
                            case '$likes':
                                if (typeof v !== 'string') {
                                    throw new Error(
                                        'The value should be a string when using "$like" operator.'
                                    );
                                }

                                params.push(`%${v}%`);
                                return (
                                    this._escapeIdWithAlias(
                                        fieldName,
                                        hasJoining,
                                        aliasMap
                                    ) + ' LIKE ?'
                                );

                            case '$has':
                                if (
                                    typeof v !== 'string' ||
                                    v.indexOf(',') >= 0
                                ) {
                                    throw new Error(
                                        'The value should be a string without "," when using "$has" operator.'
                                    );
                                }

                                params.push(v);
                                return `FIND_IN_SET(?, ${this._escapeIdWithAlias(
                                    fieldName,
                                    hasJoining,
                                    aliasMap
                                )}) > 0`;

                            default:
                                throw new Error(
                                    `Unsupported condition operator: "${k}"!`
                                );
                        }
                    } else {
                        throw new Error(
                            'Operator should not be mixed with condition value.'
                        );
                    }
                }).join(' AND ');
            }

            params.push(JSON.stringify(value));
            return (
                this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) +
                ' = ?'
            );
        }

        value = this.typeCast(value);

        if (inject) {
            return (
                this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) +
                ' = ' +
                value
            );
        }

        params.push(value);
        return (
            this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?'
        );
    }

    _buildColumns(columns, params, hasJoining, aliasMap) {
        return _.map(_.castArray(columns), (col) =>
            this._buildColumn(col, params, hasJoining, aliasMap)
        ).join(', ');
    }

    _buildColumn(col, params, hasJoining, aliasMap) {
        if (typeof col === 'string') {
            // it's a string if it's quoted when passed in
            return isQuoted(col)
                ? col
                : this._escapeIdWithAlias(col, hasJoining, aliasMap);
        }

        if (typeof col === 'number') {
            return col;
        }

        if (_.isPlainObject(col)) {
            if (col.alias) {
                const lastDotIndex = col.alias.lastIndexOf('.');
                let alias =
                    lastDotIndex > 0
                        ? col.alias.substr(lastDotIndex + 1)
                        : col.alias;

                if (lastDotIndex > 0) {
                    if (!hasJoining) {
                        throw new InvalidArgument(
                            'Cascade alias is not allowed when the query has no associated entity populated.',
                            {
                                alias: col.alias,
                            }
                        );
                    }

                    const fullPath =
                        hasJoining + '.' + col.alias.substr(0, lastDotIndex);
                    const aliasPrefix = aliasMap[fullPath];
                    if (!aliasPrefix) {
                        throw new InvalidArgument(
                            `Invalid cascade alias. "${fullPath}" not found in associations.`,
                            {
                                alias: col.alias,
                            }
                        );
                    }

                    alias = aliasPrefix + '$' + alias;
                }

                aliasMap[alias] = alias;

                return (
                    this._buildColumn(
                        _.omit(col, ['alias']),
                        params,
                        hasJoining,
                        aliasMap
                    ) +
                    ' AS ' +
                    mysql.escapeId(alias)
                );
            }

            if (col.type === 'function') {
                const name = col.name.toUpperCase();
                if (
                    name === 'COUNT' &&
                    col.args.length === 1 &&
                    col.args[0] === '*'
                ) {
                    return 'COUNT(*)';
                }

                return (
                    name +
                    '(' +
                    (col.prefix ? `${col.prefix.toUpperCase()} ` : '') +
                    (col.args
                        ? this._buildColumns(
                              col.args,
                              params,
                              hasJoining,
                              aliasMap
                          )
                        : '') +
                    ')'
                );
            }

            if (col.type === 'expression') {
                return this._joinCondition(
                    col.expr,
                    params,
                    null,
                    hasJoining,
                    aliasMap
                );
            }

            if (col.type === 'column') {
                return this._escapeIdWithAlias(col.name, hasJoining, aliasMap);
            }
        }

        throw new ApplicationError(
            `Unknow column syntax: ${JSON.stringify(col)}`
        );
    }

    _buildGroupBy(groupBy, params, hasJoining, aliasMap) {
        if (typeof groupBy === 'string')
            return (
                'GROUP BY ' +
                this._escapeIdWithAlias(groupBy, hasJoining, aliasMap)
            );

        if (Array.isArray(groupBy))
            return (
                'GROUP BY ' +
                groupBy
                    .map((by) =>
                        this._escapeIdWithAlias(by, hasJoining, aliasMap)
                    )
                    .join(', ')
            );

        if (_.isPlainObject(groupBy)) {
            const { columns, having } = groupBy;

            if (!columns || !Array.isArray(columns)) {
                throw new ApplicationError(
                    `Invalid group by syntax: ${JSON.stringify(groupBy)}`
                );
            }

            let groupByClause = this._buildGroupBy(columns);
            const havingCluse =
                having &&
                this._joinCondition(having, params, null, hasJoining, aliasMap);
            if (havingCluse) {
                groupByClause += ' HAVING ' + havingCluse;
            }

            return groupByClause;
        }

        throw new ApplicationError(
            `Unknown group by syntax: ${JSON.stringify(groupBy)}`
        );
    }

    _buildOrderBy(orderBy, hasJoining, aliasMap) {
        if (typeof orderBy === 'string')
            return (
                'ORDER BY ' +
                this._escapeIdWithAlias(orderBy, hasJoining, aliasMap)
            );

        if (Array.isArray(orderBy))
            return (
                'ORDER BY ' +
                orderBy
                    .map((by) =>
                        this._escapeIdWithAlias(by, hasJoining, aliasMap)
                    )
                    .join(', ')
            );

        if (_.isPlainObject(orderBy)) {
            return (
                'ORDER BY ' +
                _.map(
                    orderBy,
                    (asc, col) =>
                        this._escapeIdWithAlias(col, hasJoining, aliasMap) +
                        (asc === false || asc === -1 ? ' DESC' : '')
                ).join(', ')
            );
        }

        throw new ApplicationError(
            `Unknown order by syntax: ${JSON.stringify(orderBy)}`
        );
    }

    async _getConnection_(options) {
        return options && options.connection
            ? options.connection
            : this.connect_(options);
    }

    async _releaseConnection_(conn, options) {
        if (!options || !options.connection) {
            return this.disconnect_(conn);
        }
    }
}

MySQLConnector.driverLib = mysql;

module.exports = MySQLConnector;

"use strict";

require("source-map-support/register");
const {
  _
} = require('@genx/july');
const {
  tryRequire
} = require('@genx/sys');
const mysql = tryRequire('mysql2/promise');
const Connector = require('../../Connector');
const {
  ApplicationError,
  InvalidArgument
} = require('../../utils/Errors');
const {
  isQuoted
} = require('../../utils/lang');
const ntol = require('number-to-letter');
const assert = require('assert');
const validator = require('../../Validators');
const connSym = Symbol.for('conn');
class MySQLConnector extends Connector {
  typeCast(value) {
    const t = typeof value;
    if (t === 'boolean') return value ? 1 : 0;
    if (t === 'object') {
      if (value != null && value.isLuxonDateTime) {
        return value.toISO({
          includeOffset: false
        });
      }
    }
    return value;
  }
  constructor(connectionString, options) {
    if (typeof connectionString === 'object') {
      assert(connectionString.host, 'Connection host is required.');
      assert(connectionString.user, 'Connection username is required.');
      assert(connectionString.password, 'Connection password is required.');
      assert(connectionString.database, 'Connection database name is required.');
      if (!connectionString.port) connectionString.port = 3306;
    }
    super('mysql', connectionString, options);
    this.escape = mysql.escape;
    this.escapeId = mysql.escapeId;
    this.format = mysql.format;
    this.raw = mysql.raw;
    this.queryCount = (alias, fieldName) => ({
      type: 'function',
      name: 'COUNT',
      args: [fieldName || '*'],
      alias: alias || 'count'
    });
    this.$call = (name, alias, args, extra) => ({
      ...extra,
      type: 'function',
      name,
      alias,
      args
    });
    this.$as = (name, alias) => ({
      type: 'column',
      name,
      alias
    });
    this.nullOrIs = (fieldName, value) => [{
      [fieldName]: {
        $exists: false
      }
    }, {
      [fieldName]: {
        $eq: value
      }
    }];
    this.updatedCount = context => context.result.affectedRows;
    this.deletedCount = context => context.result.affectedRows;
    this.insertOne_ = this.create_;
    this.updateOne_ = this.update_;
    this.relational = true;
    this.acitveConnections = new Set();
    this.executedCount = 0;
  }
  async end_() {
    if (this.acitveConnections.size > 0) {
      for (const conn of this.acitveConnections) {
        await this.disconnect_(conn);
      }
    }
    if (this.pool) {
      await this.pool.end();
      this.log('verbose', `Close connection pool "${this.pool[connSym]}".`);
      delete this.pool;
    }
  }
  async connect_(options) {
    if (options) {
      const connProps = {};
      if (options.createDatabase) {
        connProps.database = '';
      }
      if (options.multipleStatements) {
        connProps.options = {
          multipleStatements: true
        };
      }
      const csKey = _.isEmpty(connProps) ? null : this.makeNewConnectionString(connProps);
      if (csKey && csKey !== this.connectionString) {
        const conn = await mysql.createConnection(csKey);
        conn[connSym] = this.getConnectionStringWithoutCredential(csKey);
        this.log('verbose', `Create non-pool connection to "${conn[connSym]}".`);
        return conn;
      }
    }
    if (!this.pool) {
      this.pool = mysql.createPool(this.connectionString);
      this.pool[connSym] = this.getConnectionStringWithoutCredential();
      this.log('verbose', `Create connection pool to "${this.pool[connSym]}".`);
    }
    const conn = await this.pool.getConnection();
    this.acitveConnections.add(conn);
    this.log('debug', `Get connection from pool "${this.pool[connSym]}".`);
    return conn;
  }
  async disconnect_(conn) {
    if (this.acitveConnections.has(conn)) {
      this.log('debug', `Release connection to pool "${this.pool[connSym]}".`);
      this.acitveConnections.delete(conn);
      return conn.release();
    } else {
      this.log('verbose', `Disconnect non-pool connection from "${conn[connSym]}".`);
      return conn.end();
    }
  }
  async beginTransaction_(options) {
    const conn = await this.connect_();
    if (options && options.isolationLevel) {
      const isolationLevel = _.find(MySQLConnector.IsolationLevels, (value, key) => options.isolationLevel === key || options.isolationLevel === value);
      if (!isolationLevel) {
        throw new ApplicationError(`Invalid isolation level: "${isolationLevel}"!"`);
      }
      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolationLevel);
      this.log('verbose', `Change isolation level to: ${isolationLevel}`);
    }
    const [ret] = await conn.query('SELECT @@autocommit;');
    conn.$$autocommit = ret[0]['@@autocommit'];
    await conn.query('SET SESSION autocommit=0;');
    await conn.query('START TRANSACTION;');
    this.log('verbose', 'Begins a new transaction.');
    return conn;
  }
  async commit_(conn) {
    await conn.query('COMMIT;');
    this.log('verbose', `Commits a transaction. Previous autocommit=${conn.$$autocommit}`);
    if (conn.$$autocommit) {
      await conn.query('SET SESSION autocommit=1;');
      delete conn.$$autocommit;
    }
    return this.disconnect_(conn);
  }
  async rollback_(conn) {
    await conn.query('ROLLBACK;');
    this.log('verbose', `Rollbacks a transaction. Previous autocommit=${conn.$$autocommit}`);
    if (conn.$$autocommit) {
      await conn.query('SET SESSION autocommit=1;');
      delete conn.$$autocommit;
    }
    return this.disconnect_(conn);
  }
  async execute_(sql, params, options) {
    let conn;
    try {
      conn = await this._getConnection_(options);
      if (this.options.usePreparedStatement || options && options.usePreparedStatement) {
        if (this.options.logStatement) {
          this.log('verbose', conn.format(sql, params));
        }
        if (options && options.rowsAsArray) {
          const rows = await conn.execute({
            sql,
            rowsAsArray: true
          }, params);
          this.executedCount++;
          return rows;
        }
        const [rows1] = await conn.execute(sql, params);
        this.executedCount++;
        return rows1;
      }
      if (this.options.logStatement) {
        this.log('verbose', conn.format(sql, params));
      }
      if (options && options.rowsAsArray) {
        const result = await conn.query({
          sql,
          rowsAsArray: true
        }, params);
        this.executedCount++;
        return result;
      }
      const [rows2] = await conn.query(sql, params);
      this.executedCount++;
      return rows2;
    } catch (err) {
      err.info || (err.info = {});
      err.info.sql = _.truncate(sql, {
        length: 200
      });
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
  async create_(model, data, options) {
    if (!data || _.isEmpty(data)) {
      throw new ApplicationError(`Creating with empty "${model}" data.`);
    }
    const {
      insertIgnore,
      ...restOptions
    } = options || {};
    const sql = `INSERT ${insertIgnore ? 'IGNORE ' : ''}INTO ?? SET ?`;
    const params = [model];
    params.push(data);
    return this.execute_(sql, params, restOptions);
  }
  async upsertOne_(model, data, uniqueKeys, options, dataOnInsert) {
    if (!data || _.isEmpty(data)) {
      throw new ApplicationError(`Creating with empty "${model}" data.`);
    }
    const dataWithoutUK = _.omit(data, uniqueKeys);
    const insertData = {
      ...data,
      ...dataOnInsert
    };
    if (_.isEmpty(dataWithoutUK)) {
      return this.create_(model, insertData, {
        ...options,
        insertIgnore: true
      });
    }
    const sql = `INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ?`;
    const params = [model];
    params.push(insertData);
    params.push(dataWithoutUK);
    const result = await this.execute_(sql, params, options);
    return {
      upsert: true,
      ...result
    };
  }
  async upsertMany_(model, fieldsOnInsert, dataArrayOnInsert, dataExprOnUpdate, options) {
    if (!dataArrayOnInsert || _.isEmpty(dataArrayOnInsert)) {
      throw new ApplicationError(`Upserting with empty "${model}" insert data.`);
    }
    if (!Array.isArray(dataArrayOnInsert)) {
      throw new ApplicationError('"data" to bulk upsert should be an array of records.');
    }
    if (!dataExprOnUpdate || _.isEmpty(dataExprOnUpdate)) {
      throw new ApplicationError(`Upserting with empty "${model}" update data.`);
    }
    if (!Array.isArray(fieldsOnInsert)) {
      throw new ApplicationError('"fields" to bulk upsert should be an array of field names.');
    }
    const sql = `INSERT INTO ?? (${fieldsOnInsert.map(f => this.escapeId(f)).join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ?`;
    const params = [model];
    params.push(dataArrayOnInsert);
    params.push(dataExprOnUpdate);
    return this.execute_(sql, params, options);
  }
  async insertMany_(model, fields, data, options) {
    if (!data || _.isEmpty(data)) {
      throw new ApplicationError(`Creating with empty "${model}" data.`);
    }
    if (!Array.isArray(data)) {
      throw new ApplicationError('"data" to bulk insert should be an array of records.');
    }
    if (!Array.isArray(fields)) {
      throw new ApplicationError('"fields" to bulk insert should be an array of field names.');
    }
    const {
      insertIgnore,
      ...restOptions
    } = options || {};
    const sql = `INSERT ${insertIgnore ? 'IGNORE ' : ''}INTO ?? (${fields.map(f => this.escapeId(f)).join(', ')}) VALUES ?`;
    const params = [model];
    params.push(data);
    return this.execute_(sql, params, restOptions);
  }
  async update_(model, data, query, queryOptions, connOptions) {
    if (_.isEmpty(data)) {
      throw new InvalidArgument('Data record is empty.', {
        model,
        query
      });
    }
    const params = [];
    const aliasMap = {
      [model]: 'A'
    };
    let joinings;
    let hasJoining = false;
    const joiningParams = [];
    if (queryOptions && queryOptions.$relationships) {
      joinings = this._joinAssociations(queryOptions.$relationships, model, aliasMap, 1, joiningParams);
      hasJoining = model;
    }
    let sql = 'UPDATE ' + mysql.escapeId(model);
    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
      sql += ' A ' + joinings.join(' ');
    }
    if (queryOptions && queryOptions.$requireSplitColumns || hasJoining) {
      sql += ' SET ' + this._splitColumnsAsInput(data, params, hasJoining, aliasMap).join(',');
    } else {
      params.push(data);
      sql += ' SET ?';
    }
    let hasWhere = false;
    if (query) {
      const whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);
      if (whereClause) {
        sql += ' WHERE ' + whereClause;
        hasWhere = true;
      }
    }
    if (!hasWhere) {
      throw new ApplicationError('Update without where clause is not allowed.');
    }
    if (connOptions && connOptions.returnUpdated) {
      if (connOptions.connection) {
        throw new ApplicationError('Since "returnUpdated" will create a new connection with "multipleStatements" enabled, it cannot be used within a transaction.');
      }
      connOptions = {
        ...connOptions,
        multipleStatements: 1
      };
      let {
        keyField
      } = connOptions.returnUpdated;
      keyField = this.escapeId(keyField);
      if (queryOptions && _.isInteger(queryOptions.$limit)) {
        sql += ` AND (SELECT @key := ${keyField})`;
        sql += ` LIMIT ${queryOptions.$limit}`;
        sql = `SET @key := null; ${sql}; SELECT @key;`;
        const [_1, _result, [_changedKeys]] = await this.execute_(sql, params, connOptions);
        return [_result, _changedKeys['@key']];
      }
      const {
        separator = ','
      } = connOptions.returnUpdated;
      const quotedSeparator = this.escape(separator);
      sql += ` AND (SELECT find_in_set(${keyField}, @keys := CONCAT_WS(${quotedSeparator}, ${keyField}, @keys)))`;
      sql = `SET @keys := null; ${sql}; SELECT @keys;`;
      const [_1, _result, [_changedKeys]] = await this.execute_(sql, params, connOptions);
      return [_result, _changedKeys['@keys'] ? _changedKeys['@keys'].toString().split(separator) : []];
    }
    if (queryOptions && _.isInteger(queryOptions.$limit)) {
      sql += ` LIMIT ${queryOptions.$limit}`;
    }
    return this.execute_(sql, params, connOptions);
  }
  async replace_(model, data, options) {
    const params = [model, data];
    const sql = 'REPLACE ?? SET ?';
    return this.execute_(sql, params, options);
  }
  async delete_(model, query, deleteOptions, options) {
    const params = [model];
    const aliasMap = {
      [model]: 'A'
    };
    let joinings;
    let hasJoining = false;
    const joiningParams = [];
    if (deleteOptions && deleteOptions.$relationships) {
      joinings = this._joinAssociations(deleteOptions.$relationships, model, aliasMap, 1, joiningParams);
      hasJoining = model;
    }
    let sql;
    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
      sql = 'DELETE A FROM ?? A ' + joinings.join(' ');
    } else {
      sql = 'DELETE FROM ??';
    }
    const whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);
    if (whereClause) {
      sql += ' WHERE ' + whereClause;
    }
    return this.execute_(sql, params, options);
  }
  async find_(model, condition, connOptions) {
    const sqlInfo = this.buildQuery(model, condition);
    return this._executeQuery_(sqlInfo, condition, connOptions);
  }
  async aggregate_(model, pipeline, connOptions) {
    if (!Array.isArray(pipeline) || pipeline.length === 0) {
      throw new InvalidArgument('"pipeline" should be an unempty array.');
    }
    const [startingQuery, ..._pipeline] = pipeline;
    let query = this.buildQuery(model, startingQuery);
    _pipeline.forEach((stage, i) => {
      let _params = query.params;
      query = this.buildQuery({
        sql: query.sql,
        alias: `_STAGE_${i}`
      }, stage);
      query.params = _params.concat(query.params);
    });
    return this._executeQuery_(query, null, connOptions);
  }
  _buildCTEHeader(model) {
    let fromTable = mysql.escapeId(model);
    let withTables = '';
    if (typeof model === 'object') {
      const {
        sql: subSql,
        alias
      } = model;
      model = alias;
      fromTable = alias;
      withTables = `WITH ${alias} AS (${subSql}) `;
    }
    return {
      fromTable,
      withTables,
      model
    };
  }
  buildQuery(model, {
    $relationships,
    $projection,
    $query,
    $groupBy,
    $orderBy,
    $offset,
    $limit,
    $totalCount,
    $key
  }) {
    const hasTotalCount = $totalCount;
    let needDistinctForLimit = $limit != null && $limit > 0 || $offset != null && $offset > 0;
    const {
      fromTable,
      withTables,
      model: _model
    } = this._buildCTEHeader(model);
    model = _model;
    const aliasMap = {
      [model]: 'A'
    };
    let joinings;
    let hasJoining = false;
    const joiningParams = [];
    if ($relationships) {
      joinings = this._joinAssociations($relationships, model, aliasMap, 1, joiningParams);
      hasJoining = model;
    }
    needDistinctForLimit &&= hasJoining && _.isEmpty($groupBy);
    const countParams = hasTotalCount ? joiningParams.concat() : null;
    const selectParams = [];
    const selectColomns = $projection ? this._buildColumns($projection, selectParams, hasJoining, aliasMap) : '*';
    let fromClause = ' FROM ' + fromTable;
    let fromAndJoin = fromClause;
    if (joinings) {
      fromAndJoin += ' A ' + joinings.join(' ');
    }
    let whereClause = '';
    const whereParams = [];
    if ($query) {
      whereClause = this._joinCondition($query, whereParams, null, hasJoining, aliasMap);
      if (whereClause) {
        whereClause = ' WHERE ' + whereClause;
        if (countParams) {
          whereParams.forEach(p => {
            countParams.push(p);
          });
        }
      }
    }
    let groupByClause = '';
    const groupByParams = [];
    if ($groupBy) {
      groupByClause += ' ' + this._buildGroupBy($groupBy, groupByParams, hasJoining, aliasMap);
      if (countParams) {
        groupByParams.forEach(p => {
          countParams.push(p);
        });
      }
    }
    let orderByClause = '';
    if ($orderBy) {
      orderByClause += ' ' + this._buildOrderBy($orderBy, hasJoining, aliasMap);
    }
    const limitOffetParams = [];
    let limitOffset = this._buildLimitOffset($limit, $offset, limitOffetParams);
    const result = {
      hasJoining,
      aliasMap
    };
    let distinctField;
    if (hasTotalCount || needDistinctForLimit) {
      distinctField = this._escapeIdWithAlias(typeof $totalCount === 'string' ? $totalCount : $key, hasJoining, aliasMap);
    }
    if (hasTotalCount) {
      const countSubject = 'DISTINCT(' + distinctField + ')';
      result.countSql = withTables + `SELECT COUNT(${countSubject}) AS count` + fromAndJoin + whereClause + groupByClause;
      result.countParams = countParams;
    }
    if (needDistinctForLimit) {
      const distinctFieldWithAlias = `${distinctField} AS key_`;
      const keysSql = orderByClause ? `WITH records_ AS (SELECT ${distinctFieldWithAlias}, ROW_NUMBER() OVER(${orderByClause}) AS row_${fromAndJoin}${whereClause}${groupByClause}) SELECT key_ FROM records_ GROUP BY key_ ORDER BY row_${limitOffset}` : `WITH records_ AS (SELECT ${distinctFieldWithAlias}${fromAndJoin}${whereClause}${groupByClause}) SELECT key_ FROM records_ GROUP BY key_${limitOffset}`;
      const keySqlAliasIndex = Object.keys(aliasMap).length;
      const keySqlAnchor = ntol(keySqlAliasIndex);
      this._joinAssociation({
        sql: keysSql,
        params: joiningParams.concat(whereParams, groupByParams, limitOffetParams),
        joinType: 'INNER JOIN',
        on: {
          [$key]: {
            oorType: 'ColumnReference',
            name: `${keySqlAnchor}.key_`
          }
        },
        output: true
      }, keySqlAnchor, joinings, model, aliasMap, keySqlAliasIndex, joiningParams);
      fromAndJoin = fromClause + ' A ' + joinings.join(' ');
      result.sql = withTables + 'SELECT ' + selectColomns + fromAndJoin + whereClause + groupByClause + orderByClause;
      result.params = selectParams.concat(joiningParams, whereParams, groupByParams);
    } else {
      result.sql = withTables + 'SELECT ' + selectColomns + fromAndJoin + whereClause + groupByClause + orderByClause + limitOffset;
      result.params = selectParams.concat(joiningParams, whereParams, groupByParams, limitOffetParams);
    }
    return result;
  }
  _buildLimitOffset($limit, $offset, params) {
    let sql = '';
    if (_.isInteger($limit) && $limit > 0) {
      if (_.isInteger($offset) && $offset > 0) {
        sql = ' LIMIT ?, ?';
        params.push($offset);
        params.push($limit);
      } else {
        sql = ' LIMIT ?';
        params.push($limit);
      }
    } else if (_.isInteger($offset) && $offset > 0) {
      sql = ` LIMIT ?, ${Number.MAX_SAFE_INTEGER}`;
      params.push($offset);
    }
    return sql;
  }
  getInsertedId(result) {
    return result && typeof result.insertId === 'number' ? result.insertId : undefined;
  }
  getNumOfAffectedRows(result) {
    return result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
  }
  async _executeQuery_(query, queryOptions, connOptions) {
    let result, totalCount;
    if (query.countSql) {
      const [countResult] = await this.execute_(query.countSql, query.countParams, connOptions);
      totalCount = countResult.count;
    }
    if (query.hasJoining) {
      connOptions = {
        ...connOptions,
        rowsAsArray: true
      };
      result = await this.execute_(query.sql, query.params, connOptions);
      const reverseAliasMap = _.reduce(query.aliasMap, (result, alias, nodePath) => {
        result[alias] = nodePath.split('.').slice(1);
        return result;
      }, {});
      if (query.countSql) {
        return result.concat([reverseAliasMap, totalCount]);
      }
      return result.concat([reverseAliasMap]);
    } else if (queryOptions != null && queryOptions.$skipOrm) {
      connOptions = {
        ...connOptions,
        rowsAsArray: true
      };
    }
    result = await this.execute_(query.sql, query.params, connOptions);
    if (query.countSql) {
      return [result, totalCount];
    }
    return result;
  }
  _generateAlias(index, anchor) {
    if (this.options.verboseAlias) {
      return `${_.snakeCase(anchor).toUpperCase()}${index}`;
    }
    return ntol(index);
  }
  _joinAssociations(associations, parentAliasKey, aliasMap, startId, params) {
    let joinings = [];
    _.each(associations, (assocInfo, anchor) => {
      startId = this._joinAssociation(assocInfo, anchor, joinings, parentAliasKey, aliasMap, startId, params);
    });
    return joinings;
  }
  _joinAssociation(assocInfo, anchor, joinings, parentAliasKey, aliasMap, startId, params) {
    const alias = assocInfo.alias || this._generateAlias(startId++, anchor);
    let {
      joinType,
      on
    } = assocInfo;
    joinType || (joinType = 'LEFT JOIN');
    if (assocInfo.sql) {
      if (assocInfo.output) {
        aliasMap[parentAliasKey + '.' + alias] = alias;
      }
      assocInfo.params.forEach(p => params.push(p));
      joinings.push(`${joinType} (${assocInfo.sql}) ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
      return startId;
    }
    const {
      entity,
      subAssocs
    } = assocInfo;
    const aliasKey = parentAliasKey + '.' + anchor;
    aliasMap[aliasKey] = alias;
    if (subAssocs) {
      const subJoinings = this._joinAssociations(subAssocs, aliasKey, aliasMap, startId, params);
      startId += subJoinings.length;
      joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
      subJoinings.forEach(sj => joinings.push(sj));
    } else {
      joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
    }
    return startId;
  }
  _joinCondition(condition, params, joinOperator, hasJoining, aliasMap) {
    if (Array.isArray(condition)) {
      if (!joinOperator) {
        joinOperator = 'OR';
      }
      return condition.map(c => '(' + this._joinCondition(c, params, null, hasJoining, aliasMap) + ')').join(` ${joinOperator} `);
    }
    if (_.isPlainObject(condition)) {
      if (condition.oorType) {
        return this._packValue(condition, params, hasJoining, aliasMap);
      }
      if (!joinOperator) {
        joinOperator = 'AND';
      }
      return _.map(condition, (value, key) => {
        if (key === '$all' || key === '$and' || key.startsWith('$and_')) {
          if (!Array.isArray(value) && !_.isPlainObject(value)) {
            throw new Error('"$and" operator value should be an array or plain object.');
          }
          return '(' + this._joinCondition(value, params, 'AND', hasJoining, aliasMap) + ')';
        }
        if (key === '$any' || key === '$or' || key.startsWith('$or_')) {
          if (!Array.isArray(value) && !_.isPlainObject(value)) {
            throw new Error('"$or" operator value should be an array or plain object.');
          }
          return '(' + this._joinCondition(value, params, 'OR', hasJoining, aliasMap) + ')';
        }
        if (key === '$not') {
          if (Array.isArray(value)) {
            if (value.length === 0) {
              throw new Error('"$not" operator value should be non-empty.');
            }
            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }
          if (_.isPlainObject(value)) {
            if (_.isEmpty(value)) {
              throw new Error('"$not" operator value should be non-empty.');
            }
            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }
          if (typeof value !== 'string') {
            throw new Error('Unsupported condition!');
          }
          return 'NOT (' + condition + ')';
        }
        if ((key === '$expr' || key.startsWith('$expr_')) && value.oorType && value.oorType === 'BinaryExpression') {
          const left = this._packValue(value.left, params, hasJoining, aliasMap);
          const right = this._packValue(value.right, params, hasJoining, aliasMap);
          return left + ` ${value.op} ` + right;
        }
        return this._wrapCondition(key, value, params, hasJoining, aliasMap);
      }).join(` ${joinOperator} `);
    }
    if (typeof condition !== 'string') {
      throw new Error('Unsupported condition!\n Value: ' + JSON.stringify(condition));
    }
    return condition;
  }
  _replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) {
    if (fieldName.startsWith('::')) {
      return mysql.escapeId(fieldName.substring(2));
    }
    const parts = fieldName.split('.');
    if (parts.length > 1) {
      const actualFieldName = parts.pop();
      const aliasKey = mainEntity + '.' + parts.join('.');
      const alias = aliasMap[aliasKey];
      if (!alias) {
        throw new InvalidArgument(`Column reference "${fieldName}" not found in populated associations.`, {
          entity: mainEntity,
          alias: aliasKey,
          aliasMap
        });
      }
      return alias + '.' + (actualFieldName === '*' ? '*' : mysql.escapeId(actualFieldName));
    }
    if (aliasMap[fieldName] === fieldName) {
      return mysql.escapeId(fieldName);
    }
    return aliasMap[mainEntity] + '.' + (fieldName === '*' ? '*' : mysql.escapeId(fieldName));
  }
  _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
    if (mainEntity) {
      return this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap);
    }
    return fieldName === '*' ? fieldName : mysql.escapeId(fieldName);
  }
  _splitColumnsAsInput(data, params, hasJoining, aliasMap) {
    return _.map(data, (v, fieldName) => {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + '=' + this._packValue(v, params, hasJoining, aliasMap);
    });
  }
  _packArray(array, params, hasJoining, aliasMap) {
    return array.map(value => this._packValue(value, params, hasJoining, aliasMap)).join(',');
  }
  _packValue(value, params, hasJoining, aliasMap) {
    if (_.isPlainObject(value)) {
      if (value.oorType) {
        switch (value.oorType) {
          case 'ColumnReference':
            return this._escapeIdWithAlias(value.name, hasJoining, aliasMap);
          case 'Function':
            return value.name + '(' + (value.args ? this._packArray(value.args, params, hasJoining, aliasMap) : '') + ')';
          case 'Raw':
            return value.statement;
          case 'Query':
            return this._joinCondition(value.query, params, null, hasJoining, aliasMap);
          case 'BinaryExpression':
            {
              const left = this._packValue(value.left, params, hasJoining, aliasMap);
              const right = this._packValue(value.right, params, hasJoining, aliasMap);
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
  _wrapCondition(fieldName, value, params, hasJoining, aliasMap, inject) {
    if (_.isNil(value)) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
    }
    if (Array.isArray(value)) {
      return this._wrapCondition(fieldName, {
        $in: value
      }, params, hasJoining, aliasMap, inject);
    }
    if (_.isPlainObject(value)) {
      if (value.oorType) {
        return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + this._packValue(value, params, hasJoining, aliasMap);
      }
      const hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');
      if (hasOperator) {
        return _.map(value, (v, k) => {
          if (k && k[0] === '$') {
            switch (k) {
              case '$exist':
              case '$exists':
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + (v ? ' IS NOT NULL' : 'IS NULL');
              case '$eq':
              case '$equal':
                return this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, inject);
              case '$ne':
              case '$neq':
              case '$notEqual':
                if (_.isNil(v)) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NOT NULL';
                }
                v = this.typeCast(v);
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ' + v;
                }
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` <> ${this._packValue(v, params, hasJoining, aliasMap)}`;
              case '$>':
              case '$gt':
              case '$greaterThan':
                v = this.typeCast(v);
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ' + v;
                }
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` > ${this._packValue(v, params, hasJoining, aliasMap)}`;
              case '$>=':
              case '$gte':
              case '$greaterThanOrEqual':
                v = this.typeCast(v);
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ' + v;
                }
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` >= ${this._packValue(v, params, hasJoining, aliasMap)}`;
              case '$<':
              case '$lt':
              case '$lessThan':
                v = this.typeCast(v);
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ' + v;
                }
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` < ${this._packValue(v, params, hasJoining, aliasMap)}`;
              case '$<=':
              case '$lte':
              case '$lessThanOrEqual':
                v = this.typeCast(v);
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ' + v;
                }
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` <= ${this._packValue(v, params, hasJoining, aliasMap)}`;
              case '$in':
                if (_.isPlainObject(v) && v.oorType === 'DataSet') {
                  const sqlInfo = this.buildQuery(v.model, v.query);
                  sqlInfo.params && sqlInfo.params.forEach(p => params.push(p));
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${sqlInfo.sql})`;
                } else {
                  if (!Array.isArray(v)) {
                    throw new Error('The value should be an array when using "$in" operator.');
                  }
                  if (inject) {
                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${v})`;
                  }
                  params.push(v);
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';
                }
              case '$nin':
              case '$notIn':
                if (_.isPlainObject(v) && v.oorType === 'DataSet') {
                  const sqlInfo = this.buildQuery(v.model, v.query);
                  sqlInfo.params && sqlInfo.params.forEach(p => params.push(p));
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${sqlInfo.sql})`;
                } else {
                  if (!Array.isArray(v)) {
                    throw new Error('The value should be an array when using "$in" operator.');
                  }
                  if (inject) {
                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${v})`;
                  }
                  params.push(v);
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';
                }
              case '$startWith':
              case '$startsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$startWith" operator.');
                }
                params.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';
              case '$endWith':
              case '$endsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }
                params.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';
              case '$like':
              case '$likes':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$like" operator.');
                }
                params.push(`%${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';
              case '$has':
                if (typeof v !== 'string' || v.indexOf(',') >= 0) {
                  throw new Error('The value should be a string without "," when using "$has" operator.');
                }
                params.push(v);
                return `FIND_IN_SET(?, ${this._escapeIdWithAlias(fieldName, hasJoining, aliasMap)}) > 0`;
              default:
                throw new Error(`Unsupported condition operator: "${k}"!`);
            }
          } else {
            throw new Error('Operator should not be mixed with condition value.');
          }
        }).join(' AND ');
      }
      params.push(JSON.stringify(value));
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
    }
    value = this.typeCast(value);
    if (inject) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + value;
    }
    params.push(value);
    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
  }
  _buildColumns(columns, params, hasJoining, aliasMap) {
    return _.map(_.castArray(columns), col => this._buildColumn(col, params, hasJoining, aliasMap)).join(', ');
  }
  _buildColumn(col, params, hasJoining, aliasMap) {
    if (typeof col === 'string') {
      return isQuoted(col) ? col : this._escapeIdWithAlias(col, hasJoining, aliasMap);
    }
    if (typeof col === 'number') {
      return col;
    }
    if (_.isPlainObject(col)) {
      if (col.alias) {
        const lastDotIndex = col.alias.lastIndexOf('.');
        let alias = lastDotIndex > 0 ? col.alias.substr(lastDotIndex + 1) : col.alias;
        if (lastDotIndex > 0) {
          if (!hasJoining) {
            throw new InvalidArgument('Cascade alias is not allowed when the query has no associated entity populated.', {
              alias: col.alias
            });
          }
          const fullPath = hasJoining + '.' + col.alias.substr(0, lastDotIndex);
          const aliasPrefix = aliasMap[fullPath];
          if (!aliasPrefix) {
            throw new InvalidArgument(`Invalid cascade alias. "${fullPath}" not found in associations.`, {
              alias: col.alias
            });
          }
          alias = aliasPrefix + '$' + alias;
        }
        aliasMap[alias] = alias;
        return this._buildColumn(_.omit(col, ['alias']), params, hasJoining, aliasMap) + ' AS ' + mysql.escapeId(alias);
      }
      if (col.type === 'function') {
        const name = col.name.toUpperCase();
        if (name === 'COUNT' && col.args.length === 1 && col.args[0] === '*') {
          return 'COUNT(*)';
        }
        if (MySQLConnector.windowFunctions.has(name)) {
          if (!col.over) {
            throw new InvalidArgument(`"${name}" function requires over clause.`);
          }
        } else if (!MySQLConnector.windowableFunctions.has(name) && col.over) {
          throw new InvalidArgument(`"${name}" function does not support over clause.`);
        }
        let funcClause = name + '(' + (col.prefix ? `${col.prefix.toUpperCase()} ` : '') + (col.args ? this._buildColumns(col.args, params, hasJoining, aliasMap) : '') + ')';
        if (col.over) {
          funcClause += ' OVER(';
          if (col.over.$partitionBy) {
            funcClause += this._buildPartitionBy(col.over.$partitionBy, hasJoining, aliasMap);
          }
          if (col.over.$orderBy) {
            if (!funcClause.endsWith('(')) {
              funcClause += ' ';
            }
            funcClause += this._buildOrderBy(col.over.$orderBy, hasJoining, aliasMap);
          }
          funcClause += ')';
        }
        return funcClause;
      }
      if (col.type === 'expression') {
        return this._joinCondition(col.expr, params, null, hasJoining, aliasMap);
      }
      if (col.type === 'column') {
        return this._escapeIdWithAlias(col.name, hasJoining, aliasMap);
      }
    }
    throw new ApplicationError(`Unknow column syntax: ${JSON.stringify(col)}`);
  }
  _buildGroupByColumn(groupBy, hasJoining, aliasMap) {
    if (typeof groupBy === 'string') {
      return isQuoted(groupBy) ? groupBy : this._escapeIdWithAlias(groupBy, hasJoining, aliasMap);
    }
    if (typeof groupBy === 'object') {
      if (groupBy.alias) {
        return this._escapeIdWithAlias(groupBy.alias, hasJoining, aliasMap);
      }
    }
    throw new ApplicationError(`Unknown GROUP BY syntax: ${JSON.stringify(groupBy)}`);
  }
  _buildGroupByList(groupBy, hasJoining, aliasMap) {
    if (Array.isArray(groupBy)) {
      return 'GROUP BY ' + groupBy.map(by => this._buildGroupByColumn(by, hasJoining, aliasMap)).join(', ');
    }
    return 'GROUP BY ' + this._buildGroupByColumn(groupBy, hasJoining, aliasMap);
  }
  _buildGroupBy(groupBy, params, hasJoining, aliasMap) {
    if (_.isPlainObject(groupBy)) {
      const {
        columns,
        having
      } = groupBy;
      if (!columns || !Array.isArray(columns)) {
        throw new ApplicationError(`Invalid group by syntax: ${JSON.stringify(groupBy)}`);
      }
      let groupByClause = this._buildGroupByList(columns, hasJoining, aliasMap);
      const havingCluse = having && this._joinCondition(having, params, null, hasJoining, aliasMap);
      if (havingCluse) {
        groupByClause += ' HAVING ' + havingCluse;
      }
      return groupByClause;
    }
    return this._buildGroupByList(groupBy, hasJoining, aliasMap);
  }
  _buildPartitionBy(partitionBy, hasJoining, aliasMap) {
    if (typeof partitionBy === 'string') {
      return 'PARTITION BY ' + this._escapeIdWithAlias(partitionBy, hasJoining, aliasMap);
    }
    if (Array.isArray(partitionBy)) {
      return 'PARTITION BY ' + partitionBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');
    }
    throw new ApplicationError(`Unknown PARTITION BY syntax: ${JSON.stringify(partitionBy)}`);
  }
  _buildOrderBy(orderBy, hasJoining, aliasMap) {
    if (typeof orderBy === 'string') {
      return 'ORDER BY ' + this._escapeIdWithAlias(orderBy, hasJoining, aliasMap);
    }
    if (Array.isArray(orderBy)) return 'ORDER BY ' + orderBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');
    if (_.isPlainObject(orderBy)) {
      return 'ORDER BY ' + _.map(orderBy, (asc, col) => this._escapeIdWithAlias(col, hasJoining, aliasMap) + (asc === false || asc === -1 ? ' DESC' : '')).join(', ');
    }
    throw new ApplicationError(`Unknown ORDER BY syntax: ${JSON.stringify(orderBy)}`);
  }
  async _getConnection_(options) {
    return options && options.connection ? options.connection : this.connect_(options);
  }
  async _releaseConnection_(conn, options) {
    if (!options || !options.connection) {
      return this.disconnect_(conn);
    }
  }
}
MySQLConnector.IsolationLevels = Object.freeze({
  RepeatableRead: 'REPEATABLE READ',
  ReadCommitted: 'READ COMMITTED',
  ReadUncommitted: 'READ UNCOMMITTED',
  Rerializable: 'SERIALIZABLE'
});
MySQLConnector.windowFunctions = new Set(['CUME_DIST', 'DENSE_RANK', 'FIRST_VALUE', 'LAG', 'LAST_VALUE', 'LEAD', 'NTH_VALUE', 'NTILE', 'PERCENT_RANK', 'RANK', 'ROW_NUMBER']);
MySQLConnector.windowableFunctions = new Set(['AVG', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'COUNT', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'MAX', 'MIN', 'STDDEV_POP', 'STDDEV', 'STD', 'STDDEV_SAMP', 'SUM', 'VAR_POP', 'VARIANCE', 'VAR_SAMP']);
MySQLConnector.driverLib = mysql;
module.exports = MySQLConnector;
//# sourceMappingURL=Connector.js.map
"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const {
  tryRequire
} = require('@genx/sys');

const mysql = tryRequire('mysql2/promise', __dirname);

const Connector = require('../../Connector');

const {
  ApplicationError,
  InvalidArgument
} = require('../../utils/Errors');

const {
  isQuoted
} = require('../../utils/lang');

const ntol = require('number-to-letter');

class MySQLConnector extends Connector {
  typeCast(value) {
    const t = typeof value;
    if (t === "boolean") return value ? 1 : 0;

    if (t === "object") {
      if (value != null && value.isLuxonDateTime) {
        return value.toISO({
          includeOffset: false
        });
      }
    }

    return value;
  }

  constructor(connectionString, options) {
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

    this.$call = (name, alias, args) => ({
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
  }

  async end_() {
    if (this.acitveConnections.size > 0) {
      for (let conn of this.acitveConnections) {
        await this.disconnect_(conn);
      }

      ;

      if (!(this.acitveConnections.size === 0)) {
        throw new Error("Assertion failed: this.acitveConnections.size === 0");
      }
    }

    if (this.pool) {
      this.log('debug', `Close connection pool to ${this.currentConnectionString}`);
      await this.pool.end();
      delete this.pool;
    }
  }

  async connect_(options) {
    let csKey = this.connectionString;

    if (!this.currentConnectionString) {
      this.currentConnectionString = csKey;
    }

    if (options) {
      let connProps = {};

      if (options.createDatabase) {
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

    let conn = await this.pool.getConnection();
    this.acitveConnections.add(conn);
    this.log('debug', `Connect to ${csKey}`);
    return conn;
  }

  async disconnect_(conn) {
    this.log('debug', `Disconnect from ${this.currentConnectionString}`);
    this.acitveConnections.delete(conn);
    return conn.release();
  }

  async beginTransaction_(options) {
    const conn = await this.connect_();

    if (options && options.isolationLevel) {
      const isolationLevel = _.find(MySQLConnector.IsolationLevels, (value, key) => options.isolationLevel === key || options.isolationLevel === value);

      if (!isolationLevel) {
        throw new ApplicationError(`Invalid isolation level: "${isolationLevel}"!"`);
      }

      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolationLevel);
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
          return await conn.execute({
            sql,
            rowsAsArray: true
          }, params);
        }

        let [rows1] = await conn.execute(sql, params);
        return rows1;
      }

      if (this.options.logStatement) {
        this.log('verbose', conn.format(sql, params));
      }

      if (options && options.rowsAsArray) {
        return await conn.query({
          sql,
          rowsAsArray: true
        }, params);
      }

      let [rows2] = await conn.query(sql, params);
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
    let [ping] = await this.execute_('SELECT 1 AS result');
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
    let sql = `INSERT ${insertIgnore ? "IGNORE " : ""}INTO ?? SET ?`;
    let params = [model];
    params.push(data);
    return this.execute_(sql, params, restOptions);
  }

  async upsertOne_(model, data, uniqueKeys, options, dataOnInsert) {
    if (!data || _.isEmpty(data)) {
      throw new ApplicationError(`Creating with empty "${model}" data.`);
    }

    let dataWithoutUK = _.omit(data, uniqueKeys);

    let insertData = { ...data,
      ...dataOnInsert
    };

    if (_.isEmpty(dataWithoutUK)) {
      return this.create_(model, insertData, { ...options,
        insertIgnore: true
      });
    }

    let sql = `INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ?`;
    let params = [model];
    params.push(insertData);
    params.push(dataWithoutUK);
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

    data.forEach(row => {
      if (!Array.isArray(row)) {
        throw new ApplicationError('Element of "data" array to bulk insert should be an array of record values.');
      }
    });
    const {
      insertIgnore,
      ...restOptions
    } = options || {};
    let sql = `INSERT ${insertIgnore ? "IGNORE " : ""}INTO ?? (${fields.map(f => this.escapeId(f)).join(', ')}) VALUES ?`;
    let params = [model];
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

    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false,
        joiningParams = [];

    if (queryOptions && queryOptions.$relationships) {
      joinings = this._joinAssociations(queryOptions.$relationships, model, 'A', aliasMap, 1, joiningParams);
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

    if (query) {
      let whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);

      if (whereClause) {
        sql += ' WHERE ' + whereClause;
      }
    }

    return this.execute_(sql, params, connOptions);
  }

  async replace_(model, data, options) {
    let params = [model, data];
    let sql = 'REPLACE ?? SET ?';
    return this.execute_(sql, params, options);
  }

  async delete_(model, query, deleteOptions, options) {
    let params = [model],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false,
        joiningParams = [];

    if (deleteOptions && deleteOptions.$relationships) {
      joinings = this._joinAssociations(deleteOptions.$relationships, model, 'A', aliasMap, 1, joiningParams);
      hasJoining = model;
    }

    let sql;

    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
      sql = 'DELETE A FROM ?? A ' + joinings.join(' ');
    } else {
      sql = 'DELETE FROM ??';
    }

    let whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);

    if (whereClause) {
      sql += ' WHERE ' + whereClause;
    }

    return this.execute_(sql, params, options);
  }

  async find_(model, condition, connOptions) {
    let sqlInfo = this.buildQuery(model, condition);
    let result, totalCount;

    if (sqlInfo.countSql) {
      let [countResult] = await this.execute_(sqlInfo.countSql, sqlInfo.params, connOptions);
      totalCount = countResult['count'];
    }

    if (sqlInfo.hasJoining) {
      connOptions = { ...connOptions,
        rowsAsArray: true
      };
      result = await this.execute_(sqlInfo.sql, sqlInfo.params, connOptions);

      let reverseAliasMap = _.reduce(sqlInfo.aliasMap, (result, alias, nodePath) => {
        result[alias] = nodePath.split('.').slice(1);
        return result;
      }, {});

      if (sqlInfo.countSql) {
        return result.concat(reverseAliasMap, totalCount);
      }

      return result.concat(reverseAliasMap);
    } else if (condition.$skipOrm) {
      connOptions = { ...connOptions,
        rowsAsArray: true
      };
    }

    result = await this.execute_(sqlInfo.sql, sqlInfo.params, connOptions);

    if (sqlInfo.countSql) {
      return [result, totalCount];
    }

    return result;
  }

  buildQuery(model, {
    $relationships,
    $projection,
    $query,
    $groupBy,
    $orderBy,
    $offset,
    $limit,
    $totalCount
  }) {
    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false,
        joiningParams = [];

    if ($relationships) {
      joinings = this._joinAssociations($relationships, model, 'A', aliasMap, 1, joiningParams);
      hasJoining = model;
    }

    let selectColomns = $projection ? this._buildColumns($projection, params, hasJoining, aliasMap) : '*';
    let sql = ' FROM ' + mysql.escapeId(model);

    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
      sql += ' A ' + joinings.join(' ');
    }

    if ($query) {
      let whereClause = this._joinCondition($query, params, null, hasJoining, aliasMap);

      if (whereClause) {
        sql += ' WHERE ' + whereClause;
      }
    }

    if ($groupBy) {
      sql += ' ' + this._buildGroupBy($groupBy, params, hasJoining, aliasMap);
    }

    if ($orderBy) {
      sql += ' ' + this._buildOrderBy($orderBy, hasJoining, aliasMap);
    }

    let result = {
      params,
      hasJoining,
      aliasMap
    };

    if ($totalCount) {
      let countSubject;

      if (typeof $totalCount === 'string') {
        countSubject = 'DISTINCT(' + this._escapeIdWithAlias($totalCount, hasJoining, aliasMap) + ')';
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
    return result && typeof result.insertId === 'number' ? result.insertId : undefined;
  }

  getNumOfAffectedRows(result) {
    return result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
  }

  _generateAlias(index, anchor) {
    let alias = ntol(index);

    if (this.options.verboseAlias) {
      return _.snakeCase(anchor).toUpperCase() + '_' + alias;
    }

    return alias;
  }

  _joinAssociations(associations, parentAliasKey, parentAlias, aliasMap, startId, params) {
    let joinings = [];

    _.each(associations, (assocInfo, anchor) => {
      let alias = assocInfo.alias || this._generateAlias(startId++, anchor);

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
        return;
      }

      let {
        entity,
        subAssocs
      } = assocInfo;
      let aliasKey = parentAliasKey + '.' + anchor;
      aliasMap[aliasKey] = alias;

      if (subAssocs) {
        let subJoinings = this._joinAssociations(subAssocs, aliasKey, alias, aliasMap, startId, params);

        startId += subJoinings.length;
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
        joinings = joinings.concat(subJoinings);
      } else {
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
      }
    });

    return joinings;
  }

  _joinCondition(condition, params, joinOperator, hasJoining, aliasMap) {
    if (Array.isArray(condition)) {
      if (!joinOperator) {
        joinOperator = 'OR';
      }

      return condition.map(c => '(' + this._joinCondition(c, params, null, hasJoining, aliasMap) + ')').join(` ${joinOperator} `);
    }

    if (_.isPlainObject(condition)) {
      if (!joinOperator) {
        joinOperator = 'AND';
      }

      return _.map(condition, (value, key) => {
        if (key === '$all' || key === '$and' || key.startsWith('$and_')) {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$and" operator value should be an array or plain object.');
          }

          return '(' + this._joinCondition(value, params, 'AND', hasJoining, aliasMap) + ')';
        }

        if (key === '$any' || key === '$or' || key.startsWith('$or_')) {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$or" operator value should be an array or plain object.');
          }

          return '(' + this._joinCondition(value, params, 'OR', hasJoining, aliasMap) + ')';
        }

        if (key === '$not') {
          if (Array.isArray(value)) {
            if (!(value.length > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }

          if (_.isPlainObject(value)) {
            let numOfElement = Object.keys(value).length;

            if (!(numOfElement > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }

          if (!(typeof value === 'string')) {
            throw new Error('Unsupported condition!');
          }

          return 'NOT (' + condition + ')';
        }

        if ((key === '$expr' || key.startsWith('$expr_')) && value.oorType && value.oorType === 'BinaryExpression') {
          let left = this._packValue(value.left, params, hasJoining, aliasMap);

          let right = this._packValue(value.right, params, hasJoining, aliasMap);

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
    let parts = fieldName.split('.');

    if (parts.length > 1) {
      let actualFieldName = parts.pop();
      let aliasKey = mainEntity + '.' + parts.join('.');
      let alias = aliasMap[aliasKey];

      if (!alias) {
        throw new InvalidArgument(`Column reference "${fieldName}" not found in populated associations.`, {
          entity: mainEntity,
          alias: aliasKey,
          aliasMap
        });
      }

      return alias + '.' + (actualFieldName === '*' ? '*' : mysql.escapeId(actualFieldName));
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
      if (!(fieldName.indexOf('.') === -1)) {
        throw new Error('Column of direct input data cannot be a dot-separated name.');
      }

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

          case 'BinaryExpression':
            let left = this._packValue(value.left, params, hasJoining, aliasMap);

            let right = this._packValue(value.right, params, hasJoining, aliasMap);

            return left + ` ${value.op} ` + right;

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

      let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

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

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$endWith':
              case '$endsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$like':
              case '$likes':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$like" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`%${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$has':
                if (typeof v !== 'string' || v.indexOf(',') >= 0) {
                  throw new Error('The value should be a string without "," when using "$has" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
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

      if (!!inject) {
        throw new Error("Assertion failed: !inject");
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
        if (!(typeof col.alias === 'string')) {
          throw new Error("Assertion failed: typeof col.alias === 'string'");
        }

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

        return this._buildColumn(_.omit(col, ['alias']), params, hasJoining, aliasMap) + ' AS ' + mysql.escapeId(alias);
      }

      if (col.type === 'function') {
        let name = col.name.toUpperCase();

        if (name === 'COUNT' && col.args.length === 1 && col.args[0] === '*') {
          return 'COUNT(*)';
        }

        return name + '(' + (col.prefix ? `${col.prefix.toUpperCase()} ` : "") + (col.args ? this._buildColumns(col.args, params, hasJoining, aliasMap) : '') + ')';
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

  _buildGroupBy(groupBy, params, hasJoining, aliasMap) {
    if (typeof groupBy === 'string') return 'GROUP BY ' + this._escapeIdWithAlias(groupBy, hasJoining, aliasMap);
    if (Array.isArray(groupBy)) return 'GROUP BY ' + groupBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');

    if (_.isPlainObject(groupBy)) {
      let {
        columns,
        having
      } = groupBy;

      if (!columns || !Array.isArray(columns)) {
        throw new ApplicationError(`Invalid group by syntax: ${JSON.stringify(groupBy)}`);
      }

      let groupByClause = this._buildGroupBy(columns);

      let havingCluse = having && this._joinCondition(having, params, null, hasJoining, aliasMap);

      if (havingCluse) {
        groupByClause += ' HAVING ' + havingCluse;
      }

      return groupByClause;
    }

    throw new ApplicationError(`Unknown group by syntax: ${JSON.stringify(groupBy)}`);
  }

  _buildOrderBy(orderBy, hasJoining, aliasMap) {
    if (typeof orderBy === 'string') return 'ORDER BY ' + this._escapeIdWithAlias(orderBy, hasJoining, aliasMap);
    if (Array.isArray(orderBy)) return 'ORDER BY ' + orderBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');

    if (_.isPlainObject(orderBy)) {
      return 'ORDER BY ' + _.map(orderBy, (asc, col) => this._escapeIdWithAlias(col, hasJoining, aliasMap) + (asc === false || asc == '-1' ? ' DESC' : '')).join(', ');
    }

    throw new ApplicationError(`Unknown order by syntax: ${JSON.stringify(orderBy)}`);
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
MySQLConnector.driverLib = mysql;
module.exports = MySQLConnector;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIl9fZGlybmFtZSIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsIm50b2wiLCJNeVNRTENvbm5lY3RvciIsInR5cGVDYXN0IiwidmFsdWUiLCJ0IiwiaXNMdXhvbkRhdGVUaW1lIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwicXVlcnlDb3VudCIsImFsaWFzIiwiZmllbGROYW1lIiwidHlwZSIsIm5hbWUiLCJhcmdzIiwiJGNhbGwiLCIkYXMiLCJudWxsT3JJcyIsIiRleGlzdHMiLCIkZXEiLCJ1cGRhdGVkQ291bnQiLCJjb250ZXh0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwiZGVsZXRlZENvdW50IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIlNldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFPbkluc2VydCIsImRhdGFXaXRob3V0VUsiLCJvbWl0IiwiaW5zZXJ0RGF0YSIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZGVsZXRlT3B0aW9ucyIsImZpbmRfIiwiY29uZGl0aW9uIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsImNvbmNhdCIsIiRza2lwT3JtIiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsImxhc3REb3RJbmRleCIsImxhc3RJbmRleE9mIiwic3Vic3RyIiwiZnVsbFBhdGgiLCJhbGlhc1ByZWZpeCIsInByZWZpeCIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBUUMsT0FBTyxDQUFDLFlBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsV0FBRCxDQUE5Qjs7QUFDQSxNQUFNRSxLQUFLLEdBQUdELFVBQVUsQ0FBQyxnQkFBRCxFQUFtQkUsU0FBbkIsQ0FBeEI7O0FBQ0EsTUFBTUMsU0FBUyxHQUFHSixPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSyxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBd0NOLE9BQU8sQ0FBQyxvQkFBRCxDQUFyRDs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBO0FBQUYsSUFBZVAsT0FBTyxDQUFDLGtCQUFELENBQTVCOztBQUNBLE1BQU1RLElBQUksR0FBR1IsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQU9BLE1BQU1TLGNBQU4sU0FBNkJMLFNBQTdCLENBQXVDO0FBaUNuQ00sRUFBQUEsUUFBUSxDQUFDQyxLQUFELEVBQVE7QUFDWixVQUFNQyxDQUFDLEdBQUcsT0FBT0QsS0FBakI7QUFFQSxRQUFJQyxDQUFDLEtBQUssU0FBVixFQUFxQixPQUFPRCxLQUFLLEdBQUcsQ0FBSCxHQUFPLENBQW5COztBQUVyQixRQUFJQyxDQUFDLEtBQUssUUFBVixFQUFvQjtBQUNoQixVQUFJRCxLQUFLLElBQUksSUFBVCxJQUFpQkEsS0FBSyxDQUFDRSxlQUEzQixFQUE0QztBQUN4QyxlQUFPRixLQUFLLENBQUNHLEtBQU4sQ0FBWTtBQUFFQyxVQUFBQSxhQUFhLEVBQUU7QUFBakIsU0FBWixDQUFQO0FBQ0g7QUFDSjs7QUFFRCxXQUFPSixLQUFQO0FB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QUErQjtBQUMzQixXQUFRQSxPQUFPLElBQUlBLE9BQU8sQ0FBQ21OLFVBQXBCLEdBQWtDbk4sT0FBTyxDQUFDbU4sVUFBMUMsR0FBdUQsS0FBSy9LLFFBQUwsQ0FBY3BDLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNd0UsbUJBQU4sQ0FBMEIxQyxJQUExQixFQUFnQzlCLE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQ21OLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS3BMLFdBQUwsQ0FBaUJELElBQWpCLENBQVA7QUFDSDtBQUNKOztBQS9qQ2tDOztBQUFqQ3ZDLGMsQ0FNSzRELGUsR0FBa0JxSCxNQUFNLENBQUM0QyxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUE0akM3QmpPLGNBQWMsQ0FBQ2tPLFNBQWYsR0FBMkJ6TyxLQUEzQjtBQUVBME8sTUFBTSxDQUFDQyxPQUFQLEdBQWlCcE8sY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8gfSA9IHJlcXVpcmUoJ0BnZW54L2p1bHknKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnQGdlbngvc3lzJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJywgX19kaXJuYW1lKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG4gICAgcXVlcnlDb3VudCA9IChhbGlhcywgZmllbGROYW1lKSA9PiAoe1xuICAgICAgICB0eXBlOiAnZnVuY3Rpb24nLFxuICAgICAgICBuYW1lOiAnQ09VTlQnLFxuICAgICAgICBhcmdzOiBbIGZpZWxkTmFtZSB8fCAnKicgXSxcbiAgICAgICAgYWxpYXM6IGFsaWFzIHx8ICdjb3VudCdcbiAgICB9KTsgXG5cbiAgICAkY2FsbCA9IChuYW1lLCBhbGlhcywgYXJncykgPT4gKHsgdHlwZTogJ2Z1bmN0aW9uJywgbmFtZSwgYWxpYXMsIGFyZ3MgfSk7XG4gICAgJGFzID0gKG5hbWUsIGFsaWFzKSA9PiAoeyB0eXBlOiAnY29sdW1uJywgbmFtZSwgYWxpYXMgfSk7XG5cbiAgICAvL2luIG15c3FsLCBudWxsIHZhbHVlIGNvbXBhcmlzb24gd2lsbCBuZXZlciByZXR1cm4gdHJ1ZSwgZXZlbiBudWxsICE9IDFcbiAgICBudWxsT3JJcyA9IChmaWVsZE5hbWUsIHZhbHVlKSA9PiBbeyBbZmllbGROYW1lXTogeyAkZXhpc3RzOiBmYWxzZSB9IH0sIHsgW2ZpZWxkTmFtZV06IHsgJGVxOiB2YWx1ZSB9IH1dO1xuXG4gICAgdXBkYXRlZENvdW50ID0gKGNvbnRleHQpID0+IGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cztcbiAgICBkZWxldGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuXG4gICAgdHlwZUNhc3QodmFsdWUpIHtcbiAgICAgICAgY29uc3QgdCA9IHR5cGVvZiB2YWx1ZTtcblxuICAgICAgICBpZiAodCA9PT0gXCJib29sZWFuXCIpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh0ID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUgIT0gbnVsbCAmJiB2YWx1ZS5pc0x1eG9uRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBTZXQoKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGlmICh0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID09PSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMucG9vbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENsb3NlIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5wb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5wb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5hZGQoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENvbm5lY3QgdG8gJHtjc0tleX1gKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYERpc2Nvbm5lY3QgZnJvbSAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGNvbnN0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBbIHJldCBdID0gYXdhaXQgY29ubi5xdWVyeSgnU0VMRUNUIEBAYXV0b2NvbW1pdDsnKTsgICAgICAgIFxuICAgICAgICBjb25uLiQkYXV0b2NvbW1pdCA9IHJldFswXVsnQEBhdXRvY29tbWl0J107ICAgICAgICBcblxuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTA7Jyk7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NUQVJUIFRSQU5TQUNUSU9OOycpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ0NPTU1JVDsnKTsgICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBDb21taXRzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1JPTExCQUNLOycpO1xuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LiAgICAgXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIGVyci5pbmZvIHx8IChlcnIuaW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnNxbCA9IF8udHJ1bmNhdGUoc3FsLCB7IGxlbmd0aDogMjAwIH0pO1xuICAgICAgICAgICAgZXJyLmluZm8ucGFyYW1zID0gcGFyYW1zO1xuXG4gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSBvciB1cGRhdGUgdGhlIG9sZCBvbmUgaWYgZHVwbGljYXRlIGtleSBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwc2VydE9uZV8obW9kZWwsIGRhdGEsIHVuaXF1ZUtleXMsIG9wdGlvbnMsIGRhdGFPbkluc2VydCkge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkYXRhV2l0aG91dFVLID0gXy5vbWl0KGRhdGEsIHVuaXF1ZUtleXMpO1xuICAgICAgICBsZXQgaW5zZXJ0RGF0YSA9IHsgLi4uZGF0YSwgLi4uZGF0YU9uSW5zZXJ0IH07XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhV2l0aG91dFVLKSkge1xuICAgICAgICAgICAgLy9pZiBkdXBsaWF0ZSwgZG9udCBuZWVkIHRvIHVwZGF0ZVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhtb2RlbCwgaW5zZXJ0RGF0YSwgeyAuLi5vcHRpb25zLCBpbnNlcnRJZ25vcmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCBJTlRPID8/IFNFVCA/IE9OIERVUExJQ0FURSBLRVkgVVBEQVRFID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChpbnNlcnREYXRhKTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YVdpdGhvdXRVSyk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBhc3luYyBpbnNlcnRNYW55Xyhtb2RlbCwgZmllbGRzLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJkYXRhXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZHMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZmllbGRzXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWVzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICBkYXRhLmZvckVhY2gocm93ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignRWxlbWVudCBvZiBcImRhdGFcIiBhcnJheSB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3JkIHZhbHVlcy4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMpIHx8IGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCAnICsgdGhpcy5fc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKS5qb2luKCcsJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCA/JztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHVwZGF0ZU9uZV8gPSB0aGlzLnVwZGF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gZGVsZXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgcXVlcnksIGRlbGV0ZU9wdGlvbnMsIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChkZWxldGVPcHRpb25zICYmIGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgQSBGUk9NID8/IEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgRlJPTSA/Pyc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICAgXG4gICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS8qLm1hcChuID0+ICc6JyArIG4pIGNoYW5nZWQgdG8gYmUgcGFkZGluZyBieSBvcm0gYW5kIGNhbiBiZSBjdXN0b21pemVkIHdpdGggb3RoZXIga2V5IGdldHRlciAqLztcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uZGl0aW9uLiRza2lwT3JtKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHsgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRvcmRlckJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRPcmRlckJ5KCRvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVzdWx0ID0geyBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwIH07ICAgICAgICBcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdC5jb3VudFNxbCA9IGBTRUxFQ1QgQ09VTlQoJHtjb3VudFN1YmplY3R9KSBBUyBjb3VudGAgKyBzcWw7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgPSAnU0VMRUNUICcgKyBzZWxlY3RDb2xvbW5zICsgc3FsOyAgICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCAxMDAwJztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnNxbCA9IHNxbDtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUFsaWFzKGluZGV4LCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChpbmRleCk7XG5cbiAgICAgICAgaWYgKHRoaXMub3B0aW9ucy52ZXJib3NlQWxpYXMpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnNuYWtlQ2FzZShhbmNob3IpLnRvVXBwZXJDYXNlKCkgKyAnXycgKyBhbGlhcztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGFzc29jaWF0aW9ucyBpbnRvIGpvaW5pbmcgY2xhdXNlcy5cbiAgICAgKiAge1xuICAgICAqICAgICAgZW50aXR5OiA8cmVtb3RlIGVudGl0eT5cbiAgICAgKiAgICAgIGpvaW5UeXBlOiAnTEVGVCBKT0lOfElOTkVSIEpPSU58RlVMTCBPVVRFUiBKT0lOJ1xuICAgICAqICAgICAgYW5jaG9yOiAnbG9jYWwgcHJvcGVydHkgdG8gcGxhY2UgdGhlIHJlbW90ZSBlbnRpdHknXG4gICAgICogICAgICBsb2NhbEZpZWxkOiA8bG9jYWwgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHJlbW90ZUZpZWxkOiA8cmVtb3RlIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICBzdWJBc3NvY2lhdGlvbnM6IHsgLi4uIH1cbiAgICAgKiAgfVxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NpYXRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXNLZXkgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhcyBcbiAgICAgKiBAcGFyYW0geyp9IGFsaWFzTWFwIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQXNzb2NpYXRpb25zKGFzc29jaWF0aW9ucywgcGFyZW50QWxpYXNLZXksIHBhcmVudEFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKSB7XG4gICAgICAgIGxldCBqb2luaW5ncyA9IFtdO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyAgICAgICAgICAgICBcbiAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NzLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleS5zdGFydHNXaXRoKCckYW5kXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InIHx8IGtleS5zdGFydHNXaXRoKCckb3JfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoKGtleSA9PT0gJyRleHByJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGV4cHJfJykpICYmIHZhbHVlLm9vclR5cGUgJiYgdmFsdWUub29yVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBtYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpO1xuICAgICAgICAgICAgbGV0IGFsaWFzID0gYWxpYXNNYXBbYWxpYXNLZXldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYENvbHVtbiByZWZlcmVuY2UgXCIke2ZpZWxkTmFtZX1cIiBub3QgZm91bmQgaW4gcG9wdWxhdGVkIGFzc29jaWF0aW9ucy5gLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogbWFpbkVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGFsaWFzS2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyAoYWN0dWFsRmllbGROYW1lID09PSAnKicgPyAnKicgOiBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhc01hcFttYWluRW50aXR5XSArICcuJyArIChmaWVsZE5hbWUgPT09ICcqJyA/ICcqJyA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7ICAgXG5cbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAoZmllbGROYW1lID09PSAnKicpID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBfLm1hcChkYXRhLCAodiwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xLCAnQ29sdW1uIG9mIGRpcmVjdCBpbnB1dCBkYXRhIGNhbm5vdCBiZSBhIGRvdC1zZXBhcmF0ZWQgbmFtZS4nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnPScgKyB0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9wYWNrQXJyYXkoYXJyYXksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIGFycmF5Lm1hcCh2YWx1ZSA9PiB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsJyk7XG4gICAgfVxuXG4gICAgX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQ29sdW1uUmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyh2YWx1ZS5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnRnVuY3Rpb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyAodmFsdWUuYXJncyA/IHRoaXMuX3BhY2tBcnJheSh2YWx1ZS5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG5cbiAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvb3IgdHlwZTogJHt2YWx1ZS5vb3JUeXBlfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFsdWUgPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiAnPyc7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB7ICRpbjogdmFsdWUgfSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICh2ID8gJyBJUyBOT1QgTlVMTCcgOiAnSVMgTlVMTCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCA8PiAke3RoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX1gO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCA+ICR7dGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApfWA7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgID49ICR7dGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApfWA7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCA8ICR7dGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApfWA7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDw9JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgPD0gJHt0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9YDtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHYpICYmIHYub29yVHlwZSA9PT0gJ0RhdGFTZXQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkodi5tb2RlbCwgdi5xdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxJbmZvLnBhcmFtcyAmJiBzcWxJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHYpICYmIHYub29yVHlwZSA9PT0gJ0RhdGFTZXQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkodi5tb2RlbCwgdi5xdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxJbmZvLnBhcmFtcyAmJiBzcWxJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHtzcWxJbmZvLnNxbH0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHsgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kc1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGVuZFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlcyc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGhhcyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycgfHwgdi5pbmRleE9mKCcsJykgPj0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdpdGhvdXQgXCIsXCIgd2hlbiB1c2luZyBcIiRoYXNcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYEZJTkRfSU5fU0VUKD8sICR7dGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9KSA+IDBgO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgcGFyYW1zLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlID0gdGhpcy50eXBlQ2FzdCh2YWx1ZSk7XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIGNvbnN0IGxhc3REb3RJbmRleCA9IGNvbC5hbGlhcy5sYXN0SW5kZXhPZignLicpO1xuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGxhc3REb3RJbmRleCA+IDAgPyBjb2wuYWxpYXMuc3Vic3RyKGxhc3REb3RJbmRleCsxKSA6IGNvbC5hbGlhcztcblxuICAgICAgICAgICAgICAgIGlmIChsYXN0RG90SW5kZXggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaGFzSm9pbmluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2FzY2FkZSBhbGlhcyBpcyBub3QgYWxsb3dlZCB3aGVuIHRoZSBxdWVyeSBoYXMgbm8gYXNzb2NpYXRlZCBlbnRpdHkgcG9wdWxhdGVkLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhczogY29sLmFsaWFzXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gaGFzSm9pbmluZyArICcuJyArIGNvbC5hbGlhcy5zdWJzdHIoMCwgbGFzdERvdEluZGV4KTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYWxpYXNQcmVmaXggPSBhbGlhc01hcFtmdWxsUGF0aF07XG4gICAgICAgICAgICAgICAgICAgIGlmICghYWxpYXNQcmVmaXgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEludmFsaWQgY2FzY2FkZSBhbGlhcy4gXCIke2Z1bGxQYXRofVwiIG5vdCBmb3VuZCBpbiBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBhbGlhc1ByZWZpeCArICckJyArIGFsaWFzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5hbWUgPSBjb2wubmFtZS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgICAgIGlmIChuYW1lID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBuYW1lICsgJygnICsgKGNvbC5wcmVmaXggPyBgJHtjb2wucHJlZml4LnRvVXBwZXJDYXNlKCl9IGAgOiBcIlwiKSArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdjb2x1bW4nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbC5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
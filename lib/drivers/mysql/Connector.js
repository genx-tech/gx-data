"use strict";

require("source-map-support/register");

const {
  _,
  eachAsync_,
  setValueByPath
} = require('rk-utils');

const {
  tryRequire
} = require('../../utils/lib');

const mysql = tryRequire('mysql2/promise');

const Connector = require('../../Connector');

const {
  ApplicationError,
  InvalidArgument
} = require('../../utils/Errors');

const {
  isQuoted,
  isPrimitive
} = require('../../utils/lang');

const ntol = require('number-to-letter');

class MySQLConnector extends Connector {
  typeCast(value) {
    const t = typeof value;
    if (t === "boolean") return value ? 1 : 0;

    if (t === "object") {
      if (value.isLuxonDateTime) {
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
        console.log(mainEntity, aliasKey, aliasMap);
        let msg = `Unknown column reference: ${fieldName}. Please check $association value.`;
        throw new InvalidArgument(msg);
      }

      return alias + '.' + mysql.escapeId(actualFieldName);
    }

    return aliasMap[mainEntity] + '.' + (fieldName === '*' ? fieldName : mysql.escapeId(fieldName));
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

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';

              case '$>':
              case '$gt':
              case '$greaterThan':
                v = this.typeCast(v);

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ?';

              case '$>=':
              case '$gte':
              case '$greaterThanOrEqual':
                v = this.typeCast(v);

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ?';

              case '$<':
              case '$lt':
              case '$lessThan':
                v = this.typeCast(v);

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ?';

              case '$<=':
              case '$lte':
              case '$lessThanOrEqual':
                v = this.typeCast(v);

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ?';

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCJudWxsT3JJcyIsIiRleGlzdHMiLCIkZXEiLCJ1cGRhdGVkQ291bnQiLCJjb250ZXh0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwiZGVsZXRlZENvdW50IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIlNldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFPbkluc2VydCIsImRhdGFXaXRob3V0VUsiLCJvbWl0IiwiaW5zZXJ0RGF0YSIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZGVsZXRlT3B0aW9ucyIsImZpbmRfIiwiY29uZGl0aW9uIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsImNvbmNhdCIsIiRza2lwT3JtIiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJjb25zb2xlIiwibXNnIiwidiIsImluZGV4T2YiLCJfcGFja0FycmF5IiwiYXJyYXkiLCJpbmplY3QiLCJpc05pbCIsIiRpbiIsImhhc09wZXJhdG9yIiwiayIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJsYXN0RG90SW5kZXgiLCJsYXN0SW5kZXhPZiIsInN1YnN0ciIsImZ1bGxQYXRoIiwiYWxpYXNQcmVmaXgiLCJwcmVmaXgiLCJleHByIiwiZ3JvdXBCeSIsImJ5IiwiaGF2aW5nIiwiZ3JvdXBCeUNsYXVzZSIsImhhdmluZ0NsdXNlIiwib3JkZXJCeSIsImFzYyIsImNvbm5lY3Rpb24iLCJmcmVlemUiLCJSZXBlYXRhYmxlUmVhZCIsIlJlYWRDb21taXR0ZWQiLCJSZWFkVW5jb21taXR0ZWQiLCJSZXJpYWxpemFibGUiLCJkcml2ZXJMaWIiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DQyxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBaUJELE9BQU8sQ0FBQyxpQkFBRCxDQUE5Qjs7QUFDQSxNQUFNRSxLQUFLLEdBQUdELFVBQVUsQ0FBQyxnQkFBRCxDQUF4Qjs7QUFDQSxNQUFNRSxTQUFTLEdBQUdILE9BQU8sQ0FBQyxpQkFBRCxDQUF6Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUF3Q0wsT0FBTyxDQUFDLG9CQUFELENBQXJEOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsUUFBRjtBQUFZQyxFQUFBQTtBQUFaLElBQTRCUCxPQUFPLENBQUMsa0JBQUQsQ0FBekM7O0FBQ0EsTUFBTVEsSUFBSSxHQUFHUixPQUFPLENBQUMsa0JBQUQsQ0FBcEI7O0FBT0EsTUFBTVMsY0FBTixTQUE2Qk4sU0FBN0IsQ0FBdUM7QUE0Qm5DTyxFQUFBQSxRQUFRLENBQUNDLEtBQUQsRUFBUTtBQUNaLFVBQU1DLENBQUMsR0FBRyxPQUFPRCxLQUFqQjtBQUVBLFFBQUlDLENBQUMsS0FBSyxTQUFWLEVBQXFCLE9BQU9ELEtBQUssR0FBRyxDQUFILEdBQU8sQ0FBbkI7O0FBRXJCLFFBQUlDLENBQUMsS0FBSyxRQUFWLEVBQW9CO0FBQ2hCLFVBQUlELEtBQUssQ0FBQ0UsZUFBVixFQUEyQjtBQUN2QixlQUFPRixLQUFLLENBQUNHLEtBQU4sQ0FBWTtBQUFFQyxVQUFBQSxh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dFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9saWInKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuICAgIHF1ZXJ5Q291bnQgPSAoYWxpYXMsIGZpZWxkTmFtZSkgPT4gKHtcbiAgICAgICAgdHlwZTogJ2Z1bmN0aW9uJyxcbiAgICAgICAgbmFtZTogJ0NPVU5UJyxcbiAgICAgICAgYXJnczogWyBmaWVsZE5hbWUgfHwgJyonIF0sXG4gICAgICAgIGFsaWFzOiBhbGlhcyB8fCAnY291bnQnXG4gICAgfSk7IFxuICAgIG51bGxPcklzID0gKGZpZWxkTmFtZSwgdmFsdWUpID0+IFt7IFtmaWVsZE5hbWVdOiB7ICRleGlzdHM6IGZhbHNlIH0gfSwgeyBbZmllbGROYW1lXTogeyAkZXE6IHZhbHVlIH0gfV07XG5cbiAgICB1cGRhdGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuICAgIGRlbGV0ZWRDb3VudCA9IChjb250ZXh0KSA9PiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3M7XG5cbiAgICB0eXBlQ2FzdCh2YWx1ZSkge1xuICAgICAgICBjb25zdCB0ID0gdHlwZW9mIHZhbHVlO1xuXG4gICAgICAgIGlmICh0ID09PSBcImJvb2xlYW5cIikgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5pc0x1eG9uRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBTZXQoKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGlmICh0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID09PSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMucG9vbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENsb3NlIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5wb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5wb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5hZGQoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENvbm5lY3QgdG8gJHtjc0tleX1gKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYERpc2Nvbm5lY3QgZnJvbSAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGNvbnN0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBbIHJldCBdID0gYXdhaXQgY29ubi5xdWVyeSgnU0VMRUNUIEBAYXV0b2NvbW1pdDsnKTsgICAgICAgIFxuICAgICAgICBjb25uLiQkYXV0b2NvbW1pdCA9IHJldFswXVsnQEBhdXRvY29tbWl0J107ICAgICAgICBcblxuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTA7Jyk7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NUQVJUIFRSQU5TQUNUSU9OOycpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ0NPTU1JVDsnKTsgICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBDb21taXRzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1JPTExCQUNLOycpO1xuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LiAgICAgXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIGVyci5pbmZvIHx8IChlcnIuaW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnNxbCA9IF8udHJ1bmNhdGUoc3FsLCB7IGxlbmd0aDogMjAwIH0pO1xuICAgICAgICAgICAgZXJyLmluZm8ucGFyYW1zID0gcGFyYW1zO1xuXG4gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSBvciB1cGRhdGUgdGhlIG9sZCBvbmUgaWYgZHVwbGljYXRlIGtleSBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwc2VydE9uZV8obW9kZWwsIGRhdGEsIHVuaXF1ZUtleXMsIG9wdGlvbnMsIGRhdGFPbkluc2VydCkge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkYXRhV2l0aG91dFVLID0gXy5vbWl0KGRhdGEsIHVuaXF1ZUtleXMpO1xuICAgICAgICBsZXQgaW5zZXJ0RGF0YSA9IHsgLi4uZGF0YSwgLi4uZGF0YU9uSW5zZXJ0IH07XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhV2l0aG91dFVLKSkge1xuICAgICAgICAgICAgLy9pZiBkdXBsaWF0ZSwgZG9udCBuZWVkIHRvIHVwZGF0ZVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhtb2RlbCwgaW5zZXJ0RGF0YSwgeyAuLi5vcHRpb25zLCBpbnNlcnRJZ25vcmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCBJTlRPID8/IFNFVCA/IE9OIERVUExJQ0FURSBLRVkgVVBEQVRFID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChpbnNlcnREYXRhKTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YVdpdGhvdXRVSyk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBhc3luYyBpbnNlcnRNYW55Xyhtb2RlbCwgZmllbGRzLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJkYXRhXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZHMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZmllbGRzXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWVzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICBkYXRhLmZvckVhY2gocm93ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignRWxlbWVudCBvZiBcImRhdGFcIiBhcnJheSB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3JkIHZhbHVlcy4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMpIHx8IGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCAnICsgdGhpcy5fc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKS5qb2luKCcsJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCA/JztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHVwZGF0ZU9uZV8gPSB0aGlzLnVwZGF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gZGVsZXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgcXVlcnksIGRlbGV0ZU9wdGlvbnMsIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChkZWxldGVPcHRpb25zICYmIGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgQSBGUk9NID8/IEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgRlJPTSA/Pyc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICAgXG4gICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS8qLm1hcChuID0+ICc6JyArIG4pIGNoYW5nZWQgdG8gYmUgcGFkZGluZyBieSBvcm0gYW5kIGNhbiBiZSBjdXN0b21pemVkIHdpdGggb3RoZXIga2V5IGdldHRlciAqLztcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uZGl0aW9uLiRza2lwT3JtKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pOyBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUFsaWFzKGluZGV4LCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChpbmRleCk7XG5cbiAgICAgICAgaWYgKHRoaXMub3B0aW9ucy52ZXJib3NlQWxpYXMpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnNuYWtlQ2FzZShhbmNob3IpLnRvVXBwZXJDYXNlKCkgKyAnXycgKyBhbGlhcztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGFzc29jaWF0aW9ucyBpbnRvIGpvaW5pbmcgY2xhdXNlcy5cbiAgICAgKiAge1xuICAgICAqICAgICAgZW50aXR5OiA8cmVtb3RlIGVudGl0eT5cbiAgICAgKiAgICAgIGpvaW5UeXBlOiAnTEVGVCBKT0lOfElOTkVSIEpPSU58RlVMTCBPVVRFUiBKT0lOJ1xuICAgICAqICAgICAgYW5jaG9yOiAnbG9jYWwgcHJvcGVydHkgdG8gcGxhY2UgdGhlIHJlbW90ZSBlbnRpdHknXG4gICAgICogICAgICBsb2NhbEZpZWxkOiA8bG9jYWwgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHJlbW90ZUZpZWxkOiA8cmVtb3RlIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICBzdWJBc3NvY2lhdGlvbnM6IHsgLi4uIH1cbiAgICAgKiAgfVxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NpYXRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXNLZXkgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhcyBcbiAgICAgKiBAcGFyYW0geyp9IGFsaWFzTWFwIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQXNzb2NpYXRpb25zKGFzc29jaWF0aW9ucywgcGFyZW50QWxpYXNLZXksIHBhcmVudEFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKSB7XG4gICAgICAgIGxldCBqb2luaW5ncyA9IFtdO1xuXG4gICAgICAgIC8vY29uc29sZS5sb2coJ2Fzc29jaWF0aW9uczonLCBPYmplY3Qua2V5cyhhc3NvY2lhdGlvbnMpKTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2cobWFpbkVudGl0eSwgYWxpYXNLZXksIGFsaWFzTWFwKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX0uIFBsZWFzZSBjaGVjayAkYXNzb2NpYXRpb24gdmFsdWUuYDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBfLm1hcChkYXRhLCAodiwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xLCAnQ29sdW1uIG9mIGRpcmVjdCBpbnB1dCBkYXRhIGNhbm5vdCBiZSBhIGRvdC1zZXBhcmF0ZWQgbmFtZS4nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnPScgKyB0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9wYWNrQXJyYXkoYXJyYXksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIGFycmF5Lm1hcCh2YWx1ZSA9PiB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsJyk7XG4gICAgfVxuXG4gICAgX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQ29sdW1uUmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyh2YWx1ZS5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnRnVuY3Rpb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyAodmFsdWUuYXJncyA/IHRoaXMuX3BhY2tBcnJheSh2YWx1ZS5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG5cbiAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvb3IgdHlwZTogJHt2YWx1ZS5vb3JUeXBlfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFsdWUgPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiAnPyc7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB7ICRpbjogdmFsdWUgfSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICh2ID8gJyBJUyBOT1QgTlVMTCcgOiAnSVMgTlVMTCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzogICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ID8nO1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHtzcWxJbmZvLnNxbH0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5pbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckYXBwbHknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYXJncyA9IHZhbHVlLmFyZ3MgPyBbIGZpZWxkTmFtZSBdLmNvbmNhdCh2YWx1ZS5hcmdzKSA6IFsgZmllbGROYW1lIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJykgPSAnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGhhcyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycgfHwgdi5pbmRleE9mKCcsJykgPj0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdpdGhvdXQgXCIsXCIgd2hlbiB1c2luZyBcIiRoYXNcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYEZJTkRfSU5fU0VUKD8sICR7dGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9KSA+IDBgO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgcGFyYW1zLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlID0gdGhpcy50eXBlQ2FzdCh2YWx1ZSk7XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIGNvbnN0IGxhc3REb3RJbmRleCA9IGNvbC5hbGlhcy5sYXN0SW5kZXhPZignLicpO1xuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGxhc3REb3RJbmRleCA+IDAgPyBjb2wuYWxpYXMuc3Vic3RyKGxhc3REb3RJbmRleCsxKSA6IGNvbC5hbGlhcztcblxuICAgICAgICAgICAgICAgIGlmIChsYXN0RG90SW5kZXggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaGFzSm9pbmluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2FzY2FkZSBhbGlhcyBpcyBub3QgYWxsb3dlZCB3aGVuIHRoZSBxdWVyeSBoYXMgbm8gYXNzb2NpYXRlZCBlbnRpdHkgcG9wdWxhdGVkLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhczogY29sLmFsaWFzXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gaGFzSm9pbmluZyArICcuJyArIGNvbC5hbGlhcy5zdWJzdHIoMCwgbGFzdERvdEluZGV4KTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYWxpYXNQcmVmaXggPSBhbGlhc01hcFtmdWxsUGF0aF07XG4gICAgICAgICAgICAgICAgICAgIGlmICghYWxpYXNQcmVmaXgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEludmFsaWQgY2FzY2FkZSBhbGlhcy4gXCIke2Z1bGxQYXRofVwiIG5vdCBmb3VuZCBpbiBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBhbGlhc1ByZWZpeCArICckJyArIGFsaWFzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5hbWUgPSBjb2wubmFtZS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgICAgIGlmIChuYW1lID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBuYW1lICsgJygnICsgKGNvbC5wcmVmaXggPyBgJHtjb2wucHJlZml4LnRvVXBwZXJDYXNlKCl9IGAgOiBcIlwiKSArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA9PT0gZmFsc2UgfHwgYXNjID09ICctMScgPyAnIERFU0MnIDogJycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuTXlTUUxDb25uZWN0b3IuZHJpdmVyTGliID0gbXlzcWw7XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19
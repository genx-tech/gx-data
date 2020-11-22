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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCJudWxsT3JJcyIsIiRleGlzdHMiLCIkZXEiLCJ1cGRhdGVkQ291bnQiLCJjb250ZXh0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwiZGVsZXRlZENvdW50IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIlNldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFPbkluc2VydCIsImRhdGFXaXRob3V0VUsiLCJvbWl0IiwiaW5zZXJ0RGF0YSIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZGVsZXRlT3B0aW9ucyIsImZpbmRfIiwiY29uZGl0aW9uIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsImNvbmNhdCIsIiRza2lwT3JtIiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsImxhc3REb3RJbmRleCIsImxhc3RJbmRleE9mIiwic3Vic3RyIiwiZnVsbFBhdGgiLCJhbGlhc1ByZWZpeCIsInByZWZpeCIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGlCQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXdDTCxPQUFPLENBQUMsb0JBQUQsQ0FBckQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxrQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQThCbkNPLEVBQUFBLFFBQVEsQ0FBQ0MsS0FBRCxFQUFRO0FBQ1osVUFBTUMsQ0FBQyxHQUFHLE9BQU9ELEtBQWpCO0FBRUEsUUFBSUMsQ0FBQyxLQUFLLFNBQVYsRUFBcUIsT0FBT0QsS0FBSyxHQUFHLENBQUgsR0FBTyxDQUFuQjs7QUFFckIsUUFBSUMsQ0FBQyxLQUFLLFFBQVYsRUFBb0I7QUFDaEIsVUFBSUQsS0FBSyxJQUFJLElBQVQsSUFBaUJBLEtBQUssQ0FBQ0UsZUFBM0IsRUFBNEM7QUFDeEMsZUFBT0YsS0FBSyxDQUFDRyxLQUFOLENBQVk7QUFBRUMs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ZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGliJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJyk7XG5jb25zdCBDb25uZWN0b3IgPSByZXF1aXJlKCcuLi8uLi9Db25uZWN0b3InKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcbiAgICBxdWVyeUNvdW50ID0gKGFsaWFzLCBmaWVsZE5hbWUpID0+ICh7XG4gICAgICAgIHR5cGU6ICdmdW5jdGlvbicsXG4gICAgICAgIG5hbWU6ICdDT1VOVCcsXG4gICAgICAgIGFyZ3M6IFsgZmllbGROYW1lIHx8ICcqJyBdLFxuICAgICAgICBhbGlhczogYWxpYXMgfHwgJ2NvdW50J1xuICAgIH0pOyBcblxuICAgIC8vaW4gbXlzcWwsIG51bGwgdmFsdWUgY29tcGFyaXNvbiB3aWxsIG5ldmVyIHJldHVybiB0cnVlLCBldmVuIG51bGwgIT0gMVxuICAgIG51bGxPcklzID0gKGZpZWxkTmFtZSwgdmFsdWUpID0+IFt7IFtmaWVsZE5hbWVdOiB7ICRleGlzdHM6IGZhbHNlIH0gfSwgeyBbZmllbGROYW1lXTogeyAkZXE6IHZhbHVlIH0gfV07XG5cbiAgICB1cGRhdGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuICAgIGRlbGV0ZWRDb3VudCA9IChjb250ZXh0KSA9PiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3M7XG5cbiAgICB0eXBlQ2FzdCh2YWx1ZSkge1xuICAgICAgICBjb25zdCB0ID0gdHlwZW9mIHZhbHVlO1xuXG4gICAgICAgIGlmICh0ID09PSBcImJvb2xlYW5cIikgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSAhPSBudWxsICYmIHZhbHVlLmlzTHV4b25EYXRlVGltZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIEZsYXQgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB0byBpbXByb3ZlIHF1ZXJ5IHBlcmZvcm1hbmNlLiBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLmxvZ1N0YXRlbWVudF0gLSBGbGFnIHRvIGxvZyBleGVjdXRlZCBTUUwgc3RhdGVtZW50LlxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLnJlbGF0aW9uYWwgPSB0cnVlO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IFNldCgpO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgaWYgKHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5hY2l0dmVDb25uZWN0aW9ucykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPT09IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ2xvc2UgY29ubmVjdGlvbiBwb29sIHRvICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wb29sLmVuZCgpO1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMucG9vbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5tYWtlTmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgaWYgKGNzS2V5ICE9PSB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuZF8oKTtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmICghdGhpcy5wb29sKSB7ICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENyZWF0ZSBjb25uZWN0aW9uIHBvb2wgdG8gJHtjc0tleX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLnBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLnBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmFkZChjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ29ubmVjdCB0byAke2NzS2V5fWApO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRGlzY29ubmVjdCBmcm9tICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBjb25zdCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgY29uc3QgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IFsgcmV0IF0gPSBhd2FpdCBjb25uLnF1ZXJ5KCdTRUxFQ1QgQEBhdXRvY29tbWl0OycpOyAgICAgICAgXG4gICAgICAgIGNvbm4uJCRhdXRvY29tbWl0ID0gcmV0WzBdWydAQGF1dG9jb21taXQnXTsgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MDsnKTtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU1RBUlQgVFJBTlNBQ1RJT047Jyk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnQ09NTUlUOycpOyAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYENvbW1pdHMgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnUk9MTEJBQ0s7Jyk7XG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYFJvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuICAgICBcbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmluZm8gfHwgKGVyci5pbmZvID0ge30pO1xuICAgICAgICAgICAgZXJyLmluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuaW5mby5wYXJhbXMgPSBwYXJhbXM7XG5cbiAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gU0VUID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IG9yIHVwZGF0ZSB0aGUgb2xkIG9uZSBpZiBkdXBsaWNhdGUga2V5IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBzZXJ0T25lXyhtb2RlbCwgZGF0YSwgdW5pcXVlS2V5cywgb3B0aW9ucywgZGF0YU9uSW5zZXJ0KSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRhdGFXaXRob3V0VUsgPSBfLm9taXQoZGF0YSwgdW5pcXVlS2V5cyk7XG4gICAgICAgIGxldCBpbnNlcnREYXRhID0geyAuLi5kYXRhLCAuLi5kYXRhT25JbnNlcnQgfTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGFXaXRob3V0VUspKSB7XG4gICAgICAgICAgICAvL2lmIGR1cGxpYXRlLCBkb250IG5lZWQgdG8gdXBkYXRlXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKG1vZGVsLCBpbnNlcnREYXRhLCB7IC4uLm9wdGlvbnMsIGluc2VydElnbm9yZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUIElOVE8gPz8gU0VUID8gT04gRFVQTElDQVRFIEtFWSBVUERBVEUgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGluc2VydERhdGEpO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhV2l0aG91dFVLKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGFzeW5jIGluc2VydE1hbnlfKG1vZGVsLCBmaWVsZHMsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImRhdGFcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3Jkcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJmaWVsZHNcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgZmllbGQgbmFtZXMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgIGRhdGEuZm9yRWFjaChyb3cgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyb3cpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFbGVtZW50IG9mIFwiZGF0YVwiIGFycmF5IHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmQgdmFsdWVzLicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/ICgke2ZpZWxkcy5tYXAoZiA9PiB0aGlzLmVzY2FwZUlkKGYpKS5qb2luKCcsICcpfSkgVkFMVUVTID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBpbnNlcnRPbmVfID0gdGhpcy5jcmVhdGVfO1xuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5T3B0aW9ucyAgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICBcbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRGF0YSByZWNvcmQgaXMgZW1wdHkuJywgeyBtb2RlbCwgcXVlcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykgfHwgaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBkZWxldGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBxdWVyeSwgZGVsZXRlT3B0aW9ucywgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKGRlbGV0ZU9wdGlvbnMgJiYgZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBBIEZST00gPz8gQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBGUk9NID8/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgICBcbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCBjb25kaXRpb24sIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLyoubWFwKG4gPT4gJzonICsgbikgY2hhbmdlZCB0byBiZSBwYWRkaW5nIGJ5IG9ybSBhbmQgY2FuIGJlIGN1c3RvbWl6ZWQgd2l0aCBvdGhlciBrZXkgZ2V0dGVyICovO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25kaXRpb24uJHNraXBPcm0pIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBDb2x1bW4gcmVmZXJlbmNlIFwiJHtmaWVsZE5hbWV9XCIgbm90IGZvdW5kIGluIHBvcHVsYXRlZCBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG1haW5FbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzOiBhbGlhc0tleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhc01hcFttYWluRW50aXR5XSArICcuJyArIChmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7ICAgXG5cbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDw9JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaGFzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJyB8fCB2LmluZGV4T2YoJywnKSA+PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2l0aG91dCBcIixcIiB3aGVuIHVzaW5nIFwiJGhhc1wiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBgRklORF9JTl9TRVQoPywgJHt0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX0pID4gMGA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICBwYXJhbXMucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFsdWUgPSB0aGlzLnR5cGVDYXN0KHZhbHVlKTtcblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgbGFzdERvdEluZGV4ID0gY29sLmFsaWFzLmxhc3RJbmRleE9mKCcuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gbGFzdERvdEluZGV4ID4gMCA/IGNvbC5hbGlhcy5zdWJzdHIobGFzdERvdEluZGV4KzEpIDogY29sLmFsaWFzO1xuXG4gICAgICAgICAgICAgICAgaWYgKGxhc3REb3RJbmRleCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYXNjYWRlIGFsaWFzIGlzIG5vdCBhbGxvd2VkIHdoZW4gdGhlIHF1ZXJ5IGhhcyBubyBhc3NvY2lhdGVkIGVudGl0eSBwb3B1bGF0ZWQuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBoYXNKb2luaW5nICsgJy4nICsgY29sLmFsaWFzLnN1YnN0cigwLCBsYXN0RG90SW5kZXgpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbGlhc1ByZWZpeCA9IGFsaWFzTWFwW2Z1bGxQYXRoXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhbGlhc1ByZWZpeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgSW52YWxpZCBjYXNjYWRlIGFsaWFzLiBcIiR7ZnVsbFBhdGh9XCIgbm90IGZvdW5kIGluIGFzc29jaWF0aW9ucy5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IGFsaWFzUHJlZml4ICsgJyQnICsgYWxpYXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmFtZSA9IGNvbC5uYW1lLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5hbWUgKyAnKCcgKyAoY29sLnByZWZpeCA/IGAke2NvbC5wcmVmaXgudG9VcHBlckNhc2UoKX0gYCA6IFwiXCIpICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCJudWxsT3JJcyIsIiRleGlzdHMiLCIkZXEiLCJ1cGRhdGVkQ291bnQiLCJjb250ZXh0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwiZGVsZXRlZENvdW50IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIlNldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFPbkluc2VydCIsImRhdGFXaXRob3V0VUsiLCJvbWl0IiwiaW5zZXJ0RGF0YSIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZGVsZXRlT3B0aW9ucyIsImZpbmRfIiwiY29uZGl0aW9uIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsImNvbmNhdCIsIiRza2lwT3JtIiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsImxhc3REb3RJbmRleCIsImxhc3RJbmRleE9mIiwic3Vic3RyIiwiZnVsbFBhdGgiLCJhbGlhc1ByZWZpeCIsInByZWZpeCIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGlCQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXdDTCxPQUFPLENBQUMsb0JBQUQsQ0FBckQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxrQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQThCbkNPLEVBQUFBLFFBQVEsQ0FBQ0MsS0FBRCxFQUFRO0FBQ1osVUFBTUMsQ0FBQyxHQUFHLE9BQU9ELEtBQWpCO0FBRUEsUUFBSUMsQ0FBQyxLQUFLLFNBQVYsRUFBcUIsT0FBT0QsS0FBSyxHQUFHLENBQUgsR0FBTyxDQUFuQjs7QUFFckIsUUFBSUMsQ0FBQyxLQUFLLFFBQVYsRUFBb0I7QUFDaEIsVUFBSUQsS0FBSyxJQUFJLElBQVQsSUFBaUJBLEtBQUssQ0FBQ0UsZUFBM0IsRUFBNEM7QUFDeEMsZUFBT0YsS0FBSyxDQUFDRyxLQUFOLENBQVk7QUFBRUMsVUFBQUEsYUFBYSxFQUFFO0FBQWpCLFNBQVosQ0FBUDtBQUNIO0FBQ0o7O0FBRUQsV0FBT0osS0FBUDtBQUNIOztBQVFESyxFQUFBQSxXQUFXLENBQUNDLGdCQUFELEVBQW1CQyxPQUFuQixFQUE0QjtBQUNuQyxVQUFNLE9BQU4sRUFBZUQsZ0JBQWYsRUFBaUNDLE9BQWpDO0FBRG1DLFNBckN2Q0MsTUFxQ3VDLEdBckM5QmpCLEtBQUssQ0FBQ2lCLE1BcUN3QjtBQUFBLFNBcEN2Q0MsUUFvQ3VDLEdBcEM1QmxCLEtBQUssQ0FBQ2tCLFFBb0NzQjtBQUFBLFNBbkN2Q0MsTUFtQ3VDLEdBbkM5Qm5CLEtBQUssQ0FBQ21CLE1BbUN3QjtBQUFBLFNBbEN2Q0MsR0FrQ3VDLEdBbENqQ3BCLEtBQUssQ0FBQ29CLEdBa0MyQjs7QUFBQSxTQWpDdkNDLFVBaUN1QyxHQWpDMUIsQ0FBQ0MsS0FBRCxFQUFRQyxTQUFSLE1BQXVCO0FBQ2hDQyxNQUFBQSxJQUFJLEVBQUUsVUFEMEI7QUFFaENDLE1BQUFBLElBQUksRUFBRSxPQUYwQjtBQUdoQ0MsTUFBQUEsSUFBSSxFQUFFLENBQUVILFNBQVMsSUFBSSxHQUFmLENBSDBCO0FBSWhDRCxNQUFBQSxLQUFLLEVBQUVBLEtBQUssSUFBSTtBQUpnQixLQUF2QixDQWlDMEI7O0FBQUEsU0F6QnZDSyxRQXlCdUMsR0F6QjVCLENBQUNKLFNBQUQsRUFBWWQsS0FBWixLQUFzQixDQUFDO0FBQUUsT0FBQ2MsU0FBRCxHQUFhO0FBQUVLLFFBQUFBLE9BQU8sRUFBRTtBQUFYO0FBQWYsS0FBRCxFQUFzQztBQUFFLE9BQUNMLFNBQUQsR0FBYTtBQUFFTSxRQUFBQSxHQUFHLEVBQUVwQjtBQUFQO0FBQWYsS0FBdEMsQ0F5Qk07O0FBQUEsU0F2QnZDcUIsWUF1QnVDLEdBdkJ2QkMsT0FBRCxJQUFhQSxPQUFPLENBQUNDLE1BQVIsQ0FBZUMsWUF1Qko7O0FBQUEsU0F0QnZDQyxZQXNCdUMsR0F0QnZCSCxPQUFELElBQWFBLE9BQU8sQ0FBQ0MsTUFBUixDQUFlQyxZQXNCSjs7QUFBQSxTQWlSdkNFLFVBalJ1QyxHQWlSMUIsS0FBS0MsT0FqUnFCO0FBQUEsU0ErVHZDQyxVQS9UdUMsR0ErVDFCLEtBQUtDLE9BL1RxQjtBQUduQyxTQUFLQyxVQUFMLEdBQWtCLElBQWxCO0FBQ0EsU0FBS0MsaUJBQUwsR0FBeUIsSUFBSUMsR0FBSixFQUF6QjtBQUNIOztBQUtELFFBQU1DLElBQU4sR0FBYTtBQUNULFFBQUksS0FBS0YsaUJBQUwsQ0FBdUJHLElBQXZCLEdBQThCLENBQWxDLEVBQXFDO0FBQ2pDLFdBQUssSUFBSUMsSUFBVCxJQUFpQixLQUFLSixpQkFBdEIsRUFBeUM7QUFDckMsY0FBTSxLQUFLSyxXQUFMLENBQWlCRCxJQUFqQixDQUFOO0FBQ0g7O0FBQUE7O0FBSGdDLFlBSXpCLEtBQUtKLGlCQUFMLENBQXVCRyxJQUF2QixLQUFnQyxDQUpQO0FBQUE7QUFBQTtBQUtwQzs7QUFFRCxRQUFJLEtBQUtHLElBQVQsRUFBZTtBQUNYLFdBQUtDLEdBQUwsQ0FBUyxPQUFULEVBQW1CLDRCQUEyQixLQUFLQyx1QkFBd0IsRUFBM0U7QUFDQSxZQUFNLEtBQUtGLElBQUwsQ0FBVUcsR0FBVixFQUFOO0FBQ0EsYUFBTyxLQUFLSCxJQUFaO0FBQ0g7QUFDSjs7QUFTRCxRQUFNSSxRQUFOLENBQWVsQyxPQUFmLEVBQXdCO0FBQ3BCLFFBQUltQyxLQUFLLEdBQUcsS0FBS3BDLGdCQUFqQjs7QUFDQSxRQUFJLENBQUMsS0FBS2lDLHVCQUFWLEVBQW1DO0FBQy9CLFdBQUtBLHVCQUFMLEdBQStCRyxLQUEvQjtBQUNIOztBQUVELFFBQUluQyxPQUFKLEVBQWE7QUFDVCxVQUFJb0MsU0FBUyxHQUFHLEVBQWhCOztBQUVBLFVBQUlwQyxPQUFPLENBQUNxQyxjQUFaLEVBQTRCO0FBRXhCRCxRQUFBQSxTQUFTLENBQUNFLFFBQVYsR0FBcUIsRUFBckI7QUFDSDs7QUFFREYsTUFBQUEsU0FBUyxDQUFDcEMsT0FBVixHQUFvQnJCLENBQUMsQ0FBQzRELElBQUYsQ0FBT3ZDLE9BQVAsRUFBZ0IsQ0FBQyxvQkFBRCxDQUFoQixDQUFwQjtBQUVBbUMsTUFBQUEsS0FBSyxHQUFHLEtBQUtLLHVCQUFMLENBQTZCSixTQUE3QixDQUFSO0FBQ0g7O0FBRUQsUUFBSUQsS0FBSyxLQUFLLEtBQUtILHVCQUFuQixFQUE0QztBQUN4QyxZQUFNLEtBQUtOLElBQUwsRUFBTjtBQUNBLFdBQUtNLHVCQUFMLEdBQStCRyxLQUEvQjtBQUNIOztBQUVELFFBQUksQ0FBQyxLQUFLTCxJQUFWLEVBQWdCO0FBQ1osV0FBS0MsR0FBTCxDQUFTLE9BQVQsRUFBbUIsNkJBQTRCSSxLQUFNLEVBQXJEO0FBQ0EsV0FBS0wsSUFBTCxHQUFZOUMsS0FBSyxDQUFDeUQsVUFBTixDQUFpQk4sS0FBakIsQ0FBWjtBQUNIOztBQUVELFFBQUlQLElBQUksR0FBRyxNQUFNLEtBQUtFLElBQUwsQ0FBVVksYUFBVixFQUFqQjtBQUNBLFNBQUtsQixpQkFBTCxDQUF1Qm1CLEdBQXZCLENBQTJCZixJQUEzQjtBQUVBLFNBQUtHLEdBQUwsQ0FBUyxPQUFULEVBQW1CLGNBQWFJLEtBQU0sRUFBdEM7QUFFQSxXQUFPUCxJQUFQO0FBQ0g7O0FBTUQsUUFBTUMsV0FBTixDQUFrQkQsSUFBbEIsRUFBd0I7QUFDcEIsU0FBS0csR0FBTCxDQUFTLE9BQVQsRUFBbUIsbUJBQWtCLEtBQUtDLHVCQUF3QixFQUFsRTtBQUNBLFNBQUtSLGlCQUFMLENBQXVCb0IsTUFBdkIsQ0FBOEJoQixJQUE5QjtBQUNBLFdBQU9BLElBQUksQ0FBQ2lCLE9BQUwsRUFBUDtBQUNIOztBQU9ELFFBQU1DLGlCQUFOLENBQXdCOUMsT0FBeEIsRUFBaUM7QUFDN0IsVUFBTTRCLElBQUksR0FBRyxNQUFNLEtBQUtNLFFBQUwsRUFBbkI7O0FBRUEsUUFBSWxDLE9BQU8sSUFBSUEsT0FBTyxDQUFDK0MsY0FBdkIsRUFBdUM7QUFFbkMsWUFBTUEsY0FBYyxHQUFHcEUsQ0FBQyxDQUFDcUUsSUFBRixDQUFPekQsY0FBYyxDQUFDMEQsZUFBdEIsRUFBdUMsQ0FBQ3hELEtBQUQsRUFBUXlELEdBQVIsS0FBZ0JsRCxPQUFPLENBQUMrQyxjQUFSLEtBQTJCRyxHQUEzQixJQUFrQ2xELE9BQU8sQ0FBQytDLGNBQVIsS0FBMkJ0RCxLQUFwSCxDQUF2Qjs7QUFDQSxVQUFJLENBQUNzRCxjQUFMLEVBQXFCO0FBQ2pCLGNBQU0sSUFBSTdELGdCQUFKLENBQXNCLDZCQUE0QjZELGNBQWUsS0FBakUsQ0FBTjtBQUNIOztBQUVELFlBQU1uQixJQUFJLENBQUN1QixLQUFMLENBQVcsNkNBQTZDSixjQUF4RCxDQUFOO0FBQ0g7O0FBRUQsVUFBTSxDQUFFSyxHQUFGLElBQVUsTUFBTXhCLElBQUksQ0FBQ3VCLEtBQUwsQ0FBVyxzQkFBWCxDQUF0QjtBQUNBdkIsSUFBQUEsSUFBSSxDQUFDeUIsWUFBTCxHQUFvQkQsR0FBRyxDQUFDLENBQUQsQ0FBSCxDQUFPLGNBQVAsQ0FBcEI7QUFFQSxVQUFNeEIsSUFBSSxDQUFDdUIsS0FBTCxDQUFXLDJCQUFYLENBQU47QUFDQSxVQUFNdkIsSUFBSSxDQUFDdUIsS0FBTCxDQUFXLG9CQUFYLENBQU47QUFFQSxTQUFLcEIsR0FBTCxDQUFTLFNBQVQsRUFBb0IsMkJBQXBCO0FBQ0EsV0FBT0gsSUFBUDtBQUNIOztBQU1ELFFBQU0wQixPQUFOLENBQWMxQixJQUFkLEVBQW9CO0FBQ2hCLFVBQU1BLElBQUksQ0FBQ3VCLEtBQUwsQ0FBVyxTQUFYLENBQU47QUFDQSxTQUFLcEIsR0FBTCxDQUFTLFNBQVQsRUFBcUIsOENBQTZDSCxJQUFJLENBQUN5QixZQUFhLEVBQXBGOztBQUNBLFFBQUl6QixJQUFJLENBQUN5QixZQUFULEVBQXVCO0FBQ25CLFlBQU16QixJQUFJLENBQUN1QixLQUFMLENBQVcsMkJBQVgsQ0FBTjtBQUNBLGFBQU92QixJQUFJLENBQUN5QixZQUFaO0FBQ0g7O0FBRUQsV0FBTyxLQUFLeEIsV0FBTCxDQUFpQkQsSUFBakIsQ0FBUDtBQUNIOztBQU1ELFFBQU0yQixTQUFOLENBQWdCM0IsSUFBaEIsRUFBc0I7QUFDbEIsVUFBTUEsSUFBSSxDQUFDdUIsS0FBTCxDQUFXLFdBQVgsQ0FBTjtBQUNBLFNBQUtwQixHQUFMLENBQVMsU0FBVCxFQUFxQixnREFBK0NILElBQUksQ0FBQ3lCLFlBQWEsRUFBdEY7O0FBQ0EsUUFBSXpCLElBQUksQ0FBQ3lCLFlBQVQsRUFBdUI7QUFDbkIsWUFBTXpCLElBQUksQ0FBQ3VCLEtBQUwsQ0FBVywyQkFBWCxDQUFOO0FBQ0EsYUFBT3ZCLElBQUksQ0FBQ3lCLFlBQVo7QUFDSDs7QUFFRCxXQUFPLEtBQUt4QixXQUFMLENBQWlCRCxJQUFqQixDQUFQO0FBQ0g7O0FBWUQsUUFBTTRCLFFBQU4sQ0FBZUMsR0FBZixFQUFvQkMsTUFBcEIsRUFBNEIxRCxPQUE1QixFQUFxQztBQUNqQyxRQUFJNEIsSUFBSjs7QUFFQSxRQUFJO0FBQ0FBLE1BQUFBLElBQUksR0FBRyxNQUFNLEtBQUsrQixlQUFMLENBQXFCM0QsT0FBckIsQ0FBYjs7QUFFQSxVQUFJLEtBQUtBLE9BQUwsQ0FBYTRELG9CQUFiLElBQXNDNUQsT0FBTyxJQUFJQSxPQUFPLENBQUM0RCxvQkFBN0QsRUFBb0Y7QUFDaEYsWUFBSSxLQUFLNUQsT0FBTCxDQUFhNkQsWUFBakIsRUFBK0I7QUFDM0IsZUFBSzlCLEdBQUwsQ0FBUyxTQUFULEVBQW9CSCxJQUFJLENBQUN6QixNQUFMLENBQVlzRCxHQUFaLEVBQWlCQyxNQUFqQixDQUFwQjtBQUNIOztBQUVELFlBQUkxRCxPQUFPLElBQUlBLE9BQU8sQ0FBQzhELFdBQXZCLEVBQW9DO0FBQ2hDLGlCQUFPLE1BQU1sQyxJQUFJLENBQUNtQyxPQUFMLENBQWE7QUFBRU4sWUFBQUEsR0FBRjtBQUFPSyxZQUFBQSxXQUFXLEVBQUU7QUFBcEIsV0FBYixFQUF5Q0osTUFBekMsQ0FBYjtBQUNIOztBQUVELFlBQUksQ0FBRU0sS0FBRixJQUFZLE1BQU1wQyxJQUFJLENBQUNtQyxPQUFMLENBQWFOLEdBQWIsRUFBa0JDLE1BQWxCLENBQXRCO0FBRUEsZUFBT00sS0FBUDtBQUNIOztBQUVELFVBQUksS0FBS2hFLE9BQUwsQ0FBYTZELFlBQWpCLEVBQStCO0FBQzNCLGFBQUs5QixHQUFMLENBQVMsU0FBVCxFQUFvQkgsSUFBSSxDQUFDekIsTUFBTCxDQUFZc0QsR0FBWixFQUFpQkMsTUFBakIsQ0FBcEI7QUFDSDs7QUFFRCxVQUFJMUQsT0FBTyxJQUFJQSxPQUFPLENBQUM4RCxXQUF2QixFQUFvQztBQUNoQyxlQUFPLE1BQU1sQyxJQUFJLENBQUN1QixLQUFMLENBQVc7QUFBRU0sVUFBQUEsR0FBRjtBQUFPSyxVQUFBQSxXQUFXLEVBQUU7QUFBcEIsU0FBWCxFQUF1Q0osTUFBdkMsQ0FBYjtBQUNIOztBQUVELFVBQUksQ0FBRU8sS0FBRixJQUFZLE1BQU1yQyxJQUFJLENBQUN1QixLQUFMLENBQVdNLEdBQVgsRUFBZ0JDLE1BQWhCLENBQXRCO0FBRUEsYUFBT08sS0FBUDtBQUNILEtBNUJELENBNEJFLE9BQU9DLEdBQVAsRUFBWTtBQUNWQSxNQUFBQSxHQUFHLENBQUNDLElBQUosS0FBYUQsR0FBRyxDQUFDQyxJQUFKLEdBQVcsRUFBeEI7QUFDQUQsTUFBQUEsR0FBRyxDQUFDQyxJQUFKLENBQVNWLEdBQVQsR0FBZTlFLENBQUMsQ0FBQ3lGLFFBQUYsQ0FBV1gsR0FBWCxFQUFnQjtBQUFFWSxRQUFBQSxNQUFNLEVBQUU7QUFBVixPQUFoQixDQUFmO0FBQ0FILE1BQUFBLEdBQUcsQ0FBQ0MsSUFBSixDQUFTVCxNQUFULEdBQWtCQSxNQUFsQjtBQUlBLFlBQU1RLEdBQU47QUFDSCxLQXBDRCxTQW9DVTtBQUNOdEMsTUFBQUEsSUFBSSxLQUFJLE1BQU0sS0FBSzBDLG1CQUFMLENBQXlCMUMsSUFBekIsRUFBK0I1QixPQUEvQixDQUFWLENBQUo7QUFDSDtBQUNKOztBQUVELFFBQU11RSxLQUFOLEdBQWM7QUFDVixRQUFJLENBQUVDLElBQUYsSUFBVyxNQUFNLEtBQUtoQixRQUFMLENBQWMsb0JBQWQsQ0FBckI7QUFDQSxXQUFPZ0IsSUFBSSxJQUFJQSxJQUFJLENBQUN4RCxNQUFMLEtBQWdCLENBQS9CO0FBQ0g7O0FBUUQsUUFBTUksT0FBTixDQUFjcUQsS0FBZCxFQUFxQkMsSUFBckIsRUFBMkIxRSxPQUEzQixFQUFvQztBQUNoQyxRQUFJLENBQUMwRSxJQUFELElBQVMvRixDQUFDLENBQUNnRyxPQUFGLENBQVVELElBQVYsQ0FBYixFQUE4QjtBQUMxQixZQUFNLElBQUl4RixnQkFBSixDQUFzQix3QkFBdUJ1RixLQUFNLFNBQW5ELENBQU47QUFDSDs7QUFFRCxVQUFNO0FBQUVHLE1BQUFBLFlBQUY7QUFBZ0IsU0FBR0M7QUFBbkIsUUFBbUM3RSxPQUFPLElBQUksRUFBcEQ7QUFFQSxRQUFJeUQsR0FBRyxHQUFJLFVBQVNtQixZQUFZLEdBQUcsU0FBSCxHQUFhLEVBQUcsZUFBaEQ7QUFDQSxRQUFJbEIsTUFBTSxHQUFHLENBQUVlLEtBQUYsQ0FBYjtBQUNBZixJQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVlKLElBQVo7QUFFQSxXQUFPLEtBQUtsQixRQUFMLENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCbUIsV0FBM0IsQ0FBUDtBQUNIOztBQVFELFFBQU1FLFVBQU4sQ0FBaUJOLEtBQWpCLEVBQXdCQyxJQUF4QixFQUE4Qk0sVUFBOUIsRUFBMENoRixPQUExQyxFQUFtRGlGLFlBQW5ELEVBQWlFO0FBQzdELFFBQUksQ0FBQ1AsSUFBRCxJQUFTL0YsQ0FBQyxDQUFDZ0csT0FBRixDQUFVRCxJQUFWLENBQWIsRUFBOEI7QUFDMUIsWUFBTSxJQUFJeEYsZ0JBQUosQ0FBc0Isd0JBQXVCdUYsS0FBTSxTQUFuRCxDQUFOO0FBQ0g7O0FBRUQsUUFBSVMsYUFBYSxHQUFHdkcsQ0FBQyxDQUFDd0csSUFBRixDQUFPVCxJQUFQLEVBQWFNLFVBQWIsQ0FBcEI7O0FBQ0EsUUFBSUksVUFBVSxHQUFHLEVBQUUsR0FBR1YsSUFBTDtBQUFXLFNBQUdPO0FBQWQsS0FBakI7O0FBRUEsUUFBSXRHLENBQUMsQ0FBQ2dHLE9BQUYsQ0FBVU8sYUFBVixDQUFKLEVBQThCO0FBRTFCLGFBQU8sS0FBSzlELE9BQUwsQ0FBYXFELEtBQWIsRUFBb0JXLFVBQXBCLEVBQWdDLEVBQUUsR0FBR3BGLE9BQUw7QUFBYzRFLFFBQUFBLFlBQVksRUFBRTtBQUE1QixPQUFoQyxDQUFQO0FBQ0g7O0FBRUQsUUFBSW5CLEdBQUcsR0FBSSxnREFBWDtBQUNBLFFBQUlDLE1BQU0sR0FBRyxDQUFFZSxLQUFGLENBQWI7QUFDQWYsSUFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZTSxVQUFaO0FBQ0ExQixJQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVlJLGFBQVo7QUFFQSxXQUFPLEtBQUsxQixRQUFMLENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCMUQsT0FBM0IsQ0FBUDtBQUNIOztBQUVELFFBQU1xRixXQUFOLENBQWtCWixLQUFsQixFQUF5QmEsTUFBekIsRUFBaUNaLElBQWpDLEVBQXVDMUUsT0FBdkMsRUFBZ0Q7QUFDNUMsUUFBSSxDQUFDMEUsSUFBRCxJQUFTL0YsQ0FBQyxDQUFDZ0csT0FBRixDQUFVRCxJQUFWLENBQWIsRUFBOEI7QUFDMUIsWUFBTSxJQUFJeEYsZ0JBQUosQ0FBc0Isd0JBQXVCdUYsS0FBTSxTQUFuRCxDQUFOO0FBQ0g7O0FBRUQsUUFBSSxDQUFDYyxLQUFLLENBQUNDLE9BQU4sQ0FBY2QsSUFBZCxDQUFMLEVBQTBCO0FBQ3RCLFlBQU0sSUFBSXhGLGdCQUFKLENBQXFCLHNEQUFyQixDQUFOO0FBQ0g7O0FBRUQsUUFBSSxDQUFDcUcsS0FBSyxDQUFDQyxPQUFOLENBQWNGLE1BQWQsQ0FBTCxFQUE0QjtBQUN4QixZQUFNLElBQUlwRyxnQkFBSixDQUFxQiw0REFBckIsQ0FBTjtBQUNIOztBQUdHd0YsSUFBQUEsSUFBSSxDQUFDZSxPQUFMLENBQWFDLEdBQUcsSUFBSTtBQUNoQixVQUFJLENBQUNILEtBQUssQ0FBQ0MsT0FBTixDQUFjRSxHQUFkLENBQUwsRUFBeUI7QUFDckIsY0FBTSxJQUFJeEcsZ0JBQUosQ0FBcUIsNkVBQXJCLENBQU47QUFDSDtBQUNKLEtBSkQ7QUFPSixVQUFNO0FBQUUwRixNQUFBQSxZQUFGO0FBQWdCLFNBQUdDO0FBQW5CLFFBQW1DN0UsT0FBTyxJQUFJLEVBQXBEO0FBRUEsUUFBSXlELEdBQUcsR0FBSSxVQUFTbUIsWUFBWSxHQUFHLFNBQUgsR0FBYSxFQUFHLFlBQVdVLE1BQU0sQ0FBQ0ssR0FBUCxDQUFXQyxDQUFDLElBQUksS0FBSzFGLFFBQUwsQ0FBYzBGLENBQWQsQ0FBaEIsRUFBa0NDLElBQWxDLENBQXVDLElBQXZDLENBQTZDLFlBQXhHO0FBQ0EsUUFBSW5DLE1BQU0sR0FBRyxDQUFFZSxLQUFGLENBQWI7QUFDQWYsSUFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZSixJQUFaO0FBRUEsV0FBTyxLQUFLbEIsUUFBTCxDQUFjQyxHQUFkLEVBQW1CQyxNQUFuQixFQUEyQm1CLFdBQTNCLENBQVA7QUFDSDs7QUFZRCxRQUFNdkQsT0FBTixDQUFjbUQsS0FBZCxFQUFxQkMsSUFBckIsRUFBMkJ2QixLQUEzQixFQUFrQzJDLFlBQWxDLEVBQWdEQyxXQUFoRCxFQUE2RDtBQUN6RCxRQUFJcEgsQ0FBQyxDQUFDZ0csT0FBRixDQUFVRCxJQUFWLENBQUosRUFBcUI7QUFDakIsWUFBTSxJQUFJdkYsZUFBSixDQUFvQix1QkFBcEIsRUFBNkM7QUFBRXNGLFFBQUFBLEtBQUY7QUFBU3RCLFFBQUFBO0FBQVQsT0FBN0MsQ0FBTjtBQUNIOztBQUVELFFBQUlPLE1BQU0sR0FBRyxFQUFiO0FBQUEsUUFBaUJzQyxRQUFRLEdBQUc7QUFBRSxPQUFDdkIsS0FBRCxHQUFTO0FBQVgsS0FBNUI7QUFBQSxRQUE4Q3dCLFFBQTlDO0FBQUEsUUFBd0RDLFVBQVUsR0FBRyxLQUFyRTtBQUFBLFFBQTRFQyxhQUFhLEdBQUcsRUFBNUY7O0FBRUEsUUFBSUwsWUFBWSxJQUFJQSxZQUFZLENBQUNNLGNBQWpDLEVBQWlEO0FBQzdDSCxNQUFBQSxRQUFRLEdBQUcsS0FBS0ksaUJBQUwsQ0FBdUJQLFlBQVksQ0FBQ00sY0FBcEMsRUFBb0QzQixLQUFwRCxFQUEyRCxHQUEzRCxFQUFnRXVCLFFBQWhFLEVBQTBFLENBQTFFLEVBQTZFRyxhQUE3RSxDQUFYO0FBQ0FELE1BQUFBLFVBQVUsR0FBR3pCLEtBQWI7QUFDSDs7QUFFRCxRQUFJaEIsR0FBRyxHQUFHLFlBQVl6RSxLQUFLLENBQUNrQixRQUFOLENBQWV1RSxLQUFmLENBQXRCOztBQUVBLFFBQUl5QixVQUFKLEVBQWdCO0FBQ1pDLE1BQUFBLGFBQWEsQ0FBQ1YsT0FBZCxDQUFzQmEsQ0FBQyxJQUFJNUMsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0IsQ0FBWixDQUEzQjtBQUNBN0MsTUFBQUEsR0FBRyxJQUFJLFFBQVF3QyxRQUFRLENBQUNKLElBQVQsQ0FBYyxHQUFkLENBQWY7QUFDSDs7QUFFRCxRQUFLQyxZQUFZLElBQUlBLFlBQVksQ0FBQ1Msb0JBQTlCLElBQXVETCxVQUEzRCxFQUF1RTtBQUNuRXpDLE1BQUFBLEdBQUcsSUFBSSxVQUFVLEtBQUsrQyxvQkFBTCxDQUEwQjlCLElBQTFCLEVBQWdDaEIsTUFBaEMsRUFBd0N3QyxVQUF4QyxFQUFvREYsUUFBcEQsRUFBOERILElBQTlELENBQW1FLEdBQW5FLENBQWpCO0FBQ0gsS0FGRCxNQUVPO0FBQ0huQyxNQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVlKLElBQVo7QUFDQWpCLE1BQUFBLEdBQUcsSUFBSSxRQUFQO0FBQ0g7O0FBRUQsUUFBSU4sS0FBSixFQUFXO0FBQ1AsVUFBSXNELFdBQVcsR0FBRyxLQUFLQyxjQUFMLENBQW9CdkQsS0FBcEIsRUFBMkJPLE1BQTNCLEVBQW1DLElBQW5DLEVBQXlDd0MsVUFBekMsRUFBcURGLFFBQXJELENBQWxCOztBQUNBLFVBQUlTLFdBQUosRUFBaUI7QUFDYmhELFFBQUFBLEdBQUcsSUFBSSxZQUFZZ0QsV0FBbkI7QUFDSDtBQUNKOztBQUVELFdBQU8sS0FBS2pELFFBQUwsQ0FBY0MsR0FBZCxFQUFtQkMsTUFBbkIsRUFBMkJxQyxXQUEzQixDQUFQO0FBQ0g7O0FBVUQsUUFBTVksUUFBTixDQUFlbEMsS0FBZixFQUFzQkMsSUFBdEIsRUFBNEIxRSxPQUE1QixFQUFxQztBQUNqQyxRQUFJMEQsTUFBTSxHQUFHLENBQUVlLEtBQUYsRUFBU0MsSUFBVCxDQUFiO0FBRUEsUUFBSWpCLEdBQUcsR0FBRyxrQkFBVjtBQUVBLFdBQU8sS0FBS0QsUUFBTCxDQUFjQyxHQUFkLEVBQW1CQyxNQUFuQixFQUEyQjFELE9BQTNCLENBQVA7QUFDSDs7QUFTRCxRQUFNNEcsT0FBTixDQUFjbkMsS0FBZCxFQUFxQnRCLEtBQXJCLEVBQTRCMEQsYUFBNUIsRUFBMkM3RyxPQUEzQyxFQUFvRDtBQUNoRCxRQUFJMEQsTUFBTSxHQUFHLENBQUVlLEtBQUYsQ0FBYjtBQUFBLFFBQXdCdUIsUUFBUSxHQUFHO0FBQUUsT0FBQ3ZCLEtBQUQsR0FBUztBQUFYLEtBQW5DO0FBQUEsUUFBcUR3QixRQUFyRDtBQUFBLFFBQStEQyxVQUFVLEdBQUcsS0FBNUU7QUFBQSxRQUFtRkMsYUFBYSxHQUFHLEVBQW5HOztBQUVBLFFBQUlVLGFBQWEsSUFBSUEsYUFBYSxDQUFDVCxjQUFuQyxFQUFtRDtBQUMvQ0gsTUFBQUEsUUFBUSxHQUFHLEtBQUtJLGlCQUFMLENBQXVCUSxhQUFhLENBQUNULGNBQXJDLEVBQXFEM0IsS0FBckQsRUFBNEQsR0FBNUQsRUFBaUV1QixRQUFqRSxFQUEyRSxDQUEzRSxFQUE4RUcsYUFBOUUsQ0FBWDtBQUNBRCxNQUFBQSxVQUFVLEdBQUd6QixLQUFiO0FBQ0g7O0FBRUQsUUFBSWhCLEdBQUo7O0FBRUEsUUFBSXlDLFVBQUosRUFBZ0I7QUFDWkMsTUFBQUEsYUFBYSxDQUFDVixPQUFkLENBQXNCYSxDQUFDLElBQUk1QyxNQUFNLENBQUNvQixJQUFQLENBQVl3QixDQUFaLENBQTNCO0FBQ0E3QyxNQUFBQSxHQUFHLEdBQUcsd0JBQXdCd0MsUUFBUSxDQUFDSixJQUFULENBQWMsR0FBZCxDQUE5QjtBQUNILEtBSEQsTUFHTztBQUNIcEMsTUFBQUEsR0FBRyxHQUFHLGdCQUFOO0FBQ0g7O0FBRUQsUUFBSWdELFdBQVcsR0FBRyxLQUFLQyxjQUFMLENBQW9CdkQsS0FBcEIsRUFBMkJPLE1BQTNCLEVBQW1DLElBQW5DLEVBQXlDd0MsVUFBekMsRUFBcURGLFFBQXJELENBQWxCOztBQUNBLFFBQUlTLFdBQUosRUFBaUI7QUFDYmhELE1BQUFBLEdBQUcsSUFBSSxZQUFZZ0QsV0FBbkI7QUFDSDs7QUFFRCxXQUFPLEtBQUtqRCxRQUFMLENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCMUQsT0FBM0IsQ0FBUDtBQUNIOztBQVFELFFBQU04RyxLQUFOLENBQVlyQyxLQUFaLEVBQW1Cc0MsU0FBbkIsRUFBOEJoQixXQUE5QixFQUEyQztBQUN2QyxRQUFJaUIsT0FBTyxHQUFHLEtBQUtDLFVBQUwsQ0FBZ0J4QyxLQUFoQixFQUF1QnNDLFNBQXZCLENBQWQ7QUFFQSxRQUFJL0YsTUFBSixFQUFZa0csVUFBWjs7QUFFQSxRQUFJRixPQUFPLENBQUNHLFFBQVosRUFBc0I7QUFDbEIsVUFBSSxDQUFFQyxXQUFGLElBQWtCLE1BQU0sS0FBSzVELFFBQUwsQ0FBY3dELE9BQU8sQ0FBQ0csUUFBdEIsRUFBZ0NILE9BQU8sQ0FBQ3RELE1BQXhDLEVBQWdEcUMsV0FBaEQsQ0FBNUI7QUFDQW1CLE1BQUFBLFVBQVUsR0FBR0UsV0FBVyxDQUFDLE9BQUQsQ0FBeEI7QUFDSDs7QUFFRCxRQUFJSixPQUFPLENBQUNkLFVBQVosRUFBd0I7QUFDcEJILE1BQUFBLFdBQVcsR0FBRyxFQUFFLEdBQUdBLFdBQUw7QUFBa0JqQyxRQUFBQSxXQUFXLEVBQUU7QUFBL0IsT0FBZDtBQUNBOUMsTUFBQUEsTUFBTSxHQUFHLE1BQU0sS0FBS3dDLFFBQUwsQ0FBY3dELE9BQU8sQ0FBQ3ZELEdBQXRCLEVBQTJCdUQsT0FBTyxDQUFDdEQsTUFBbkMsRUFBMkNxQyxXQUEzQyxDQUFmOztBQUVBLFVBQUlzQixlQUFlLEdBQUcxSSxDQUFDLENBQUMySSxNQUFGLENBQVNOLE9BQU8sQ0FBQ2hCLFFBQWpCLEVBQTJCLENBQUNoRixNQUFELEVBQVNWLEtBQVQsRUFBZ0JpSCxRQUFoQixLQUE2QjtBQUMxRXZHLFFBQUFBLE1BQU0sQ0FBQ1YsS0FBRCxDQUFOLEdBQWdCaUgsUUFBUSxDQUFDQyxLQUFULENBQWUsR0FBZixFQUFvQkMsS0FBcEIsQ0FBMEIsQ0FBMUIsQ0FBaEI7QUFDQSxlQUFPekcsTUFBUDtBQUNILE9BSHFCLEVBR25CLEVBSG1CLENBQXRCOztBQUtBLFVBQUlnRyxPQUFPLENBQUNHLFFBQVosRUFBc0I7QUFDbEIsZUFBT25HLE1BQU0sQ0FBQzBHLE1BQVAsQ0FBY0wsZUFBZCxFQUErQkgsVUFBL0IsQ0FBUDtBQUNIOztBQUVELGFBQU9sRyxNQUFNLENBQUMwRyxNQUFQLENBQWNMLGVBQWQsQ0FBUDtBQUNILEtBZEQsTUFjTyxJQUFJTixTQUFTLENBQUNZLFFBQWQsRUFBd0I7QUFDM0I1QixNQUFBQSxXQUFXLEdBQUcsRUFBRSxHQUFHQSxXQUFMO0FBQWtCakMsUUFBQUEsV0FBVyxFQUFFO0FBQS9CLE9BQWQ7QUFDSDs7QUFFRDlDLElBQUFBLE1BQU0sR0FBRyxNQUFNLEtBQUt3QyxRQUFMLENBQWN3RCxPQUFPLENBQUN2RCxHQUF0QixFQUEyQnVELE9BQU8sQ0FBQ3RELE1BQW5DLEVBQTJDcUMsV0FBM0MsQ0FBZjs7QUFFQSxRQUFJaUIsT0FBTyxDQUFDRyxRQUFaLEVBQXNCO0FBQ2xCLGFBQU8sQ0FBRW5HLE1BQUYsRUFBVWtHLFVBQVYsQ0FBUDtBQUNIOztBQUVELFdBQU9sRyxNQUFQO0FBQ0g7O0FBT0RpRyxFQUFBQSxVQUFVLENBQUN4QyxLQUFELEVBQVE7QUFBRTJCLElBQUFBLGNBQUY7QUFBa0J3QixJQUFBQSxXQUFsQjtBQUErQkMsSUFBQUEsTUFBL0I7QUFBdUNDLElBQUFBLFFBQXZDO0FBQWlEQyxJQUFBQSxRQUFqRDtBQUEyREMsSUFBQUEsT0FBM0Q7QUFBb0VDLElBQUFBLE1BQXBFO0FBQTRFQyxJQUFBQTtBQUE1RSxHQUFSLEVBQW1HO0FBQ3pHLFFBQUl4RSxNQUFNLEdBQUcsRUFBYjtBQUFBLFFBQWlCc0MsUUFBUSxHQUFHO0FBQUUsT0FBQ3ZCLEtBQUQsR0FBUztBQUFYLEtBQTVCO0FBQUEsUUFBOEN3QixRQUE5QztBQUFBLFFBQXdEQyxVQUFVLEdBQUcsS0FBckU7QUFBQSxRQUE0RUMsYUFBYSxHQUFHLEVBQTVGOztBQUlBLFFBQUlDLGNBQUosRUFBb0I7QUFDaEJILE1BQUFBLFFBQVEsR0FBRyxLQUFLSSxpQkFBTCxDQUF1QkQsY0FBdkIsRUFBdUMzQixLQUF2QyxFQUE4QyxHQUE5QyxFQUFtRHVCLFFBQW5ELEVBQTZELENBQTdELEVBQWdFRyxhQUFoRSxDQUFYO0FBQ0FELE1BQUFBLFVBQVUsR0FBR3pCLEtBQWI7QUFDSDs7QUFFRCxRQUFJMEQsYUFBYSxHQUFHUCxXQUFXLEdBQUcsS0FBS1EsYUFBTCxDQUFtQlIsV0FBbkIsRUFBZ0NsRSxNQUFoQyxFQUF3Q3dDLFVBQXhDLEVBQW9ERixRQUFwRCxDQUFILEdBQW1FLEdBQWxHO0FBRUEsUUFBSXZDLEdBQUcsR0FBRyxXQUFXekUsS0FBSyxDQUFDa0IsUUFBTixDQUFldUUsS0FBZixDQUFyQjs7QUFLQSxRQUFJeUIsVUFBSixFQUFnQjtBQUNaQyxNQUFBQSxhQUFhLENBQUNWLE9BQWQsQ0FBc0JhLENBQUMsSUFBSTVDLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWXdCLENBQVosQ0FBM0I7QUFDQTdDLE1BQUFBLEdBQUcsSUFBSSxRQUFRd0MsUUFBUSxDQUFDSixJQUFULENBQWMsR0FBZCxDQUFmO0FBQ0g7O0FBRUQsUUFBSWdDLE1BQUosRUFBWTtBQUNSLFVBQUlwQixXQUFXLEdBQUcsS0FBS0MsY0FBTCxDQUFvQm1CLE1BQXBCLEVBQTRCbkUsTUFBNUIsRUFBb0MsSUFBcEMsRUFBMEN3QyxVQUExQyxFQUFzREYsUUFBdEQsQ0FBbEI7O0FBQ0EsVUFBSVMsV0FBSixFQUFpQjtBQUNiaEQsUUFBQUEsR0FBRyxJQUFJLFlBQVlnRCxXQUFuQjtBQUNIO0FBQ0o7O0FBRUQsUUFBSXFCLFFBQUosRUFBYztBQUNWckUsTUFBQUEsR0FBRyxJQUFJLE1BQU0sS0FBSzRFLGFBQUwsQ0FBbUJQLFFBQW5CLEVBQTZCcEUsTUFBN0IsRUFBcUN3QyxVQUFyQyxFQUFpREYsUUFBakQsQ0FBYjtBQUNIOztBQUVELFFBQUkrQixRQUFKLEVBQWM7QUFDVnRFLE1BQUFBLEdBQUcsSUFBSSxNQUFNLEtBQUs2RSxhQUFMLENBQW1CUCxRQUFuQixFQUE2QjdCLFVBQTdCLEVBQXlDRixRQUF6QyxDQUFiO0FBQ0g7O0FBRUQsUUFBSWhGLE1BQU0sR0FBRztBQUFFMEMsTUFBQUEsTUFBRjtBQUFVd0MsTUFBQUEsVUFBVjtBQUFzQkYsTUFBQUE7QUFBdEIsS0FBYjs7QUFFQSxRQUFJa0MsV0FBSixFQUFpQjtBQUNiLFVBQUlLLFlBQUo7O0FBRUEsVUFBSSxPQUFPTCxXQUFQLEtBQXVCLFFBQTNCLEVBQXFDO0FBQ2pDSyxRQUFBQSxZQUFZLEdBQUcsY0FBYyxLQUFLQyxrQkFBTCxDQUF3Qk4sV0FBeEIsRUFBcUNoQyxVQUFyQyxFQUFpREYsUUFBakQsQ0FBZCxHQUEyRSxHQUExRjtBQUNILE9BRkQsTUFFTztBQUNIdUMsUUFBQUEsWUFBWSxHQUFHLEdBQWY7QUFDSDs7QUFFRHZILE1BQUFBLE1BQU0sQ0FBQ21HLFFBQVAsR0FBbUIsZ0JBQWVvQixZQUFhLFlBQTdCLEdBQTJDOUUsR0FBN0Q7QUFDSDs7QUFFREEsSUFBQUEsR0FBRyxHQUFHLFlBQVkwRSxhQUFaLEdBQTRCMUUsR0FBbEM7O0FBRUEsUUFBSTlFLENBQUMsQ0FBQzhKLFNBQUYsQ0FBWVIsTUFBWixLQUF1QkEsTUFBTSxHQUFHLENBQXBDLEVBQXVDO0FBRW5DLFVBQUl0SixDQUFDLENBQUM4SixTQUFGLENBQVlULE9BQVosS0FBd0JBLE9BQU8sR0FBRyxDQUF0QyxFQUF5QztBQUNyQ3ZFLFFBQUFBLEdBQUcsSUFBSSxhQUFQO0FBQ0FDLFFBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWWtELE9BQVo7QUFDQXRFLFFBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWW1ELE1BQVo7QUFDSCxPQUpELE1BSU87QUFDSHhFLFFBQUFBLEdBQUcsSUFBSSxVQUFQO0FBQ0FDLFFBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWW1ELE1BQVo7QUFDSDtBQUNKLEtBVkQsTUFVTyxJQUFJdEosQ0FBQyxDQUFDOEosU0FBRixDQUFZVCxPQUFaLEtBQXdCQSxPQUFPLEdBQUcsQ0FBdEMsRUFBeUM7QUFDNUN2RSxNQUFBQSxHQUFHLElBQUksZ0JBQVA7QUFDQUMsTUFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZa0QsT0FBWjtBQUNIOztBQUVEaEgsSUFBQUEsTUFBTSxDQUFDeUMsR0FBUCxHQUFhQSxHQUFiO0FBRUEsV0FBT3pDLE1BQVA7QUFDSDs7QUFFRDBILEVBQUFBLGFBQWEsQ0FBQzFILE1BQUQsRUFBUztBQUNsQixXQUFPQSxNQUFNLElBQUksT0FBT0EsTUFBTSxDQUFDMkgsUUFBZCxLQUEyQixRQUFyQyxHQUNIM0gsTUFBTSxDQUFDMkgsUUFESixHQUVIQyxTQUZKO0FBR0g7O0FBRURDLEVBQUFBLG9CQUFvQixDQUFDN0gsTUFBRCxFQUFTO0FBQ3pCLFdBQU9BLE1BQU0sSUFBSSxPQUFPQSxNQUFNLENBQUNDLFlBQWQsS0FBK0IsUUFBekMsR0FDSEQsTUFBTSxDQUFDQyxZQURKLEdBRUgySCxTQUZKO0FBR0g7O0FBRURFLEVBQUFBLGNBQWMsQ0FBQ0MsS0FBRCxFQUFRQyxNQUFSLEVBQWdCO0FBQzFCLFFBQUkxSSxLQUFLLEdBQUdoQixJQUFJLENBQUN5SixLQUFELENBQWhCOztBQUVBLFFBQUksS0FBSy9JLE9BQUwsQ0FBYWlKLFlBQWpCLEVBQStCO0FBQzNCLGFBQU90SyxDQUFDLENBQUN1SyxTQUFGLENBQVlGLE1BQVosRUFBb0JHLFdBQXBCLEtBQW9DLEdBQXBDLEdBQTBDN0ksS0FBakQ7QUFDSDs7QUFFRCxXQUFPQSxLQUFQO0FBQ0g7O0FBbUJEK0YsRUFBQUEsaUJBQWlCLENBQUMrQyxZQUFELEVBQWVDLGNBQWYsRUFBK0JDLFdBQS9CLEVBQTRDdEQsUUFBNUMsRUFBc0R1RCxPQUF0RCxFQUErRDdGLE1BQS9ELEVBQXVFO0FBQ3BGLFFBQUl1QyxRQUFRLEdBQUcsRUFBZjs7QUFFQXRILElBQUFBLENBQUMsQ0FBQzZLLElBQUYsQ0FBT0osWUFBUCxFQUFxQixDQUFDSyxTQUFELEVBQVlULE1BQVosS0FBdUI7QUFDeEMsVUFBSTFJLEtBQUssR0FBR21KLFNBQVMsQ0FBQ25KLEtBQVYsSUFBbUIsS0FBS3dJLGNBQUwsQ0FBb0JTLE9BQU8sRUFBM0IsRUFBK0JQLE1BQS9CLENBQS9COztBQUNBLFVBQUk7QUFBRVUsUUFBQUEsUUFBRjtBQUFZQyxRQUFBQTtBQUFaLFVBQW1CRixTQUF2QjtBQUVBQyxNQUFBQSxRQUFRLEtBQUtBLFFBQVEsR0FBRyxXQUFoQixDQUFSOztBQUVBLFVBQUlELFNBQVMsQ0FBQ2hHLEdBQWQsRUFBbUI7QUFDZixZQUFJZ0csU0FBUyxDQUFDRyxNQUFkLEVBQXNCO0FBQ2xCNUQsVUFBQUEsUUFBUSxDQUFDcUQsY0FBYyxHQUFHLEdBQWpCLEdBQXVCL0ksS0FBeEIsQ0FBUixHQUF5Q0EsS0FBekM7QUFDSDs7QUFFRG1KLFFBQUFBLFNBQVMsQ0FBQy9GLE1BQVYsQ0FBaUIrQixPQUFqQixDQUF5QmEsQ0FBQyxJQUFJNUMsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0IsQ0FBWixDQUE5QjtBQUNBTCxRQUFBQSxRQUFRLENBQUNuQixJQUFULENBQWUsR0FBRTRFLFFBQVMsS0FBSUQsU0FBUyxDQUFDaEcsR0FBSSxLQUFJbkQsS0FBTSxPQUFNLEtBQUtvRyxjQUFMLENBQW9CaUQsRUFBcEIsRUFBd0JqRyxNQUF4QixFQUFnQyxJQUFoQyxFQUFzQzJGLGNBQXRDLEVBQXNEckQsUUFBdEQsQ0FBZ0UsRUFBNUg7QUFFQTtBQUNIOztBQUVELFVBQUk7QUFBRTZELFFBQUFBLE1BQUY7QUFBVUMsUUFBQUE7QUFBVixVQUF3QkwsU0FBNUI7QUFDQSxVQUFJTSxRQUFRLEdBQUdWLGNBQWMsR0FBRyxHQUFqQixHQUF1QkwsTUFBdEM7QUFDQWhELE1BQUFBLFFBQVEsQ0FBQytELFFBQUQsQ0FBUixHQUFxQnpKLEtBQXJCOztBQUVBLFVBQUl3SixTQUFKLEVBQWU7QUFDWCxZQUFJRSxXQUFXLEdBQUcsS0FBSzNELGlCQUFMLENBQXVCeUQsU0FBdkIsRUFBa0NDLFFBQWxDLEVBQTRDekosS0FBNUMsRUFBbUQwRixRQUFuRCxFQUE2RHVELE9BQTdELEVBQXNFN0YsTUFBdEUsQ0FBbEI7O0FBQ0E2RixRQUFBQSxPQUFPLElBQUlTLFdBQVcsQ0FBQzNGLE1BQXZCO0FBRUE0QixRQUFBQSxRQUFRLENBQUNuQixJQUFULENBQWUsR0FBRTRFLFFBQVMsSUFBRzFLLEtBQUssQ0FBQ2tCLFFBQU4sQ0FBZTJKLE1BQWYsQ0FBdUIsSUFBR3ZKLEtBQU0sT0FBTSxLQUFLb0csY0FBTCxDQUFvQmlELEVBQXBCLEVBQXdCakcsTUFBeEIsRUFBZ0MsSUFBaEMsRUFBc0MyRixjQUF0QyxFQUFzRHJELFFBQXRELENBQWdFLEVBQW5JO0FBQ0FDLFFBQUFBLFFBQVEsR0FBR0EsUUFBUSxDQUFDeUIsTUFBVCxDQUFnQnNDLFdBQWhCLENBQVg7QUFDSCxPQU5ELE1BTU87QUFDSC9ELFFBQUFBLFFBQVEsQ0FBQ25CLElBQVQsQ0FBZSxHQUFFNEUsUUFBUyxJQUFHMUssS0FBSyxDQUFDa0IsUUFBTixDQUFlMkosTUFBZixDQUF1QixJQUFHdkosS0FBTSxPQUFNLEtBQUtvRyxjQUFMLENBQW9CaUQsRUFBcEIsRUFBd0JqRyxNQUF4QixFQUFnQyxJQUFoQyxFQUFzQzJGLGNBQXRDLEVBQXNEckQsUUFBdEQsQ0FBZ0UsRUFBbkk7QUFDSDtBQUNKLEtBOUJEOztBQWdDQSxXQUFPQyxRQUFQO0FBQ0g7O0FBa0JEUyxFQUFBQSxjQUFjLENBQUNLLFNBQUQsRUFBWXJELE1BQVosRUFBb0J1RyxZQUFwQixFQUFrQy9ELFVBQWxDLEVBQThDRixRQUE5QyxFQUF3RDtBQUNsRSxRQUFJVCxLQUFLLENBQUNDLE9BQU4sQ0FBY3VCLFNBQWQsQ0FBSixFQUE4QjtBQUMxQixVQUFJLENBQUNrRCxZQUFMLEVBQW1CO0FBQ2ZBLFFBQUFBLFlBQVksR0FBRyxJQUFmO0FBQ0g7O0FBQ0QsYUFBT2xELFNBQVMsQ0FBQ3BCLEdBQVYsQ0FBY3VFLENBQUMsSUFBSSxNQUFNLEtBQUt4RCxjQUFMLENBQW9Cd0QsQ0FBcEIsRUFBdUJ4RyxNQUF2QixFQUErQixJQUEvQixFQUFxQ3dDLFVBQXJDLEVBQWlERixRQUFqRCxDQUFOLEdBQW1FLEdBQXRGLEVBQTJGSCxJQUEzRixDQUFpRyxJQUFHb0UsWUFBYSxHQUFqSCxDQUFQO0FBQ0g7O0FBRUQsUUFBSXRMLENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0JwRCxTQUFoQixDQUFKLEVBQWdDO0FBQzVCLFVBQUksQ0FBQ2tELFlBQUwsRUFBbUI7QUFDZkEsUUFBQUEsWUFBWSxHQUFHLEtBQWY7QUFDSDs7QUFFRCxhQUFPdEwsQ0FBQyxDQUFDZ0gsR0FBRixDQUFNb0IsU0FBTixFQUFpQixDQUFDdEgsS0FBRCxFQUFReUQsR0FBUixLQUFnQjtBQUNwQyxZQUFJQSxHQUFHLEtBQUssTUFBUixJQUFrQkEsR0FBRyxLQUFLLE1BQTFCLElBQW9DQSxHQUFHLENBQUNrSCxVQUFKLENBQWUsT0FBZixDQUF4QyxFQUFpRTtBQUFBLGdCQUNyRDdFLEtBQUssQ0FBQ0MsT0FBTixDQUFjL0YsS0FBZCxLQUF3QmQsQ0FBQyxDQUFDd0wsYUFBRixDQUFnQjFLLEtBQWhCLENBRDZCO0FBQUEsNEJBQ0wsMkRBREs7QUFBQTs7QUFHN0QsaUJBQU8sTUFBTSxLQUFLaUgsY0FBTCxDQUFvQmpILEtBQXBCLEVBQTJCaUUsTUFBM0IsRUFBbUMsS0FBbkMsRUFBMEN3QyxVQUExQyxFQUFzREYsUUFBdEQsQ0FBTixHQUF3RSxHQUEvRTtBQUNIOztBQUVELFlBQUk5QyxHQUFHLEtBQUssTUFBUixJQUFrQkEsR0FBRyxLQUFLLEtBQTFCLElBQW1DQSxHQUFHLENBQUNrSCxVQUFKLENBQWUsTUFBZixDQUF2QyxFQUErRDtBQUFBLGdCQUNuRDdFLEtBQUssQ0FBQ0MsT0FBTixDQUFjL0YsS0FBZCxLQUF3QmQsQ0FBQyxDQUFDd0wsYUFBRixDQUFnQjFLLEtBQWhCLENBRDJCO0FBQUEsNEJBQ0gsMERBREc7QUFBQTs7QUFHM0QsaUJBQU8sTUFBTSxLQUFLaUgsY0FBTCxDQUFvQmpILEtBQXBCLEVBQTJCaUUsTUFBM0IsRUFBbUMsSUFBbkMsRUFBeUN3QyxVQUF6QyxFQUFxREYsUUFBckQsQ0FBTixHQUF1RSxHQUE5RTtBQUNIOztBQUVELFlBQUk5QyxHQUFHLEtBQUssTUFBWixFQUFvQjtBQUNoQixjQUFJcUMsS0FBSyxDQUFDQyxPQUFOLENBQWMvRixLQUFkLENBQUosRUFBMEI7QUFBQSxrQkFDZEEsS0FBSyxDQUFDNEUsTUFBTixHQUFlLENBREQ7QUFBQSw4QkFDSSw0Q0FESjtBQUFBOztBQUd0QixtQkFBTyxVQUFVLEtBQUtxQyxjQUFMLENBQW9CakgsS0FBcEIsRUFBMkJpRSxNQUEzQixFQUFtQyxJQUFuQyxFQUF5Q3dDLFVBQXpDLEVBQXFERixRQUFyRCxDQUFWLEdBQTJFLEdBQWxGO0FBQ0g7O0FBRUQsY0FBSXJILENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0IxSyxLQUFoQixDQUFKLEVBQTRCO0FBQ3hCLGdCQUFJNEssWUFBWSxHQUFHQyxNQUFNLENBQUNDLElBQVAsQ0FBWTlLLEtBQVosRUFBbUI0RSxNQUF0Qzs7QUFEd0Isa0JBRWhCZ0csWUFBWSxHQUFHLENBRkM7QUFBQSw4QkFFRSw0Q0FGRjtBQUFBOztBQUl4QixtQkFBTyxVQUFVLEtBQUszRCxjQUFMLENBQW9CakgsS0FBcEIsRUFBMkJpRSxNQUEzQixFQUFtQyxJQUFuQyxFQUF5Q3dDLFVBQXpDLEVBQXFERixRQUFyRCxDQUFWLEdBQTJFLEdBQWxGO0FBQ0g7O0FBWmUsZ0JBY1IsT0FBT3ZHLEtBQVAsS0FBaUIsUUFkVDtBQUFBLDRCQWNtQix3QkFkbkI7QUFBQTs7QUFnQmhCLGlCQUFPLFVBQVVzSCxTQUFWLEdBQXNCLEdBQTdCO0FBQ0g7O0FBRUQsWUFBSSxDQUFDN0QsR0FBRyxLQUFLLE9BQVIsSUFBbUJBLEdBQUcsQ0FBQ2tILFVBQUosQ0FBZSxRQUFmLENBQXBCLEtBQWlEM0ssS0FBSyxDQUFDK0ssT0FBdkQsSUFBa0UvSyxLQUFLLENBQUMrSyxPQUFOLEtBQWtCLGtCQUF4RixFQUE0RztBQUN4RyxjQUFJQyxJQUFJLEdBQUcsS0FBS0MsVUFBTCxDQUFnQmpMLEtBQUssQ0FBQ2dMLElBQXRCLEVBQTRCL0csTUFBNUIsRUFBb0N3QyxVQUFwQyxFQUFnREYsUUFBaEQsQ0FBWDs7QUFDQSxjQUFJMkUsS0FBSyxHQUFHLEtBQUtELFVBQUwsQ0FBZ0JqTCxLQUFLLENBQUNrTCxLQUF0QixFQUE2QmpILE1BQTdCLEVBQXFDd0MsVUFBckMsRUFBaURGLFFBQWpELENBQVo7O0FBQ0EsaUJBQU95RSxJQUFJLEdBQUksSUFBR2hMLEtBQUssQ0FBQ21MLEVBQUcsR0FBcEIsR0FBeUJELEtBQWhDO0FBQ0g7O0FBRUQsZUFBTyxLQUFLRSxjQUFMLENBQW9CM0gsR0FBcEIsRUFBeUJ6RCxLQUF6QixFQUFnQ2lFLE1BQWhDLEVBQXdDd0MsVUFBeEMsRUFBb0RGLFFBQXBELENBQVA7QUFDSCxPQXZDTSxFQXVDSkgsSUF2Q0ksQ0F1Q0UsSUFBR29FLFlBQWEsR0F2Q2xCLENBQVA7QUF3Q0g7O0FBRUQsUUFBSSxPQUFPbEQsU0FBUCxLQUFxQixRQUF6QixFQUFtQztBQUMvQixZQUFNLElBQUkrRCxLQUFKLENBQVUscUNBQXFDQyxJQUFJLENBQUNDLFNBQUwsQ0FBZWpFLFNBQWYsQ0FBL0MsQ0FBTjtBQUNIOztBQUVELFdBQU9BLFNBQVA7QUFDSDs7QUFFRGtFLEVBQUFBLDBCQUEwQixDQUFDMUssU0FBRCxFQUFZMkssVUFBWixFQUF3QmxGLFFBQXhCLEVBQWtDO0FBQ3hELFFBQUltRixLQUFLLEdBQUc1SyxTQUFTLENBQUNpSCxLQUFWLENBQWdCLEdBQWhCLENBQVo7O0FBQ0EsUUFBSTJELEtBQUssQ0FBQzlHLE1BQU4sR0FBZSxDQUFuQixFQUFzQjtBQUNsQixVQUFJK0csZUFBZSxHQUFHRCxLQUFLLENBQUNFLEdBQU4sRUFBdEI7QUFDQSxVQUFJdEIsUUFBUSxHQUFHbUIsVUFBVSxHQUFHLEdBQWIsR0FBbUJDLEtBQUssQ0FBQ3RGLElBQU4sQ0FBVyxHQUFYLENBQWxDO0FBQ0EsVUFBSXZGLEtBQUssR0FBRzBGLFFBQVEsQ0FBQytELFFBQUQsQ0FBcEI7O0FBQ0EsVUFBSSxDQUFDekosS0FBTCxFQUFZO0FBQ1IsY0FBTSxJQUFJbkIsZUFBSixDQUFxQixxQkFBb0JvQixTQUFVLHdDQUFuRCxFQUE0RjtBQUM5RnNKLFVBQUFBLE1BQU0sRUFBRXFCLFVBRHNGO0FBRTlGNUssVUFBQUEsS0FBSyxFQUFFeUosUUFGdUY7QUFHOUYvRCxVQUFBQTtBQUg4RixTQUE1RixDQUFOO0FBS0g7O0FBRUQsYUFBTzFGLEtBQUssR0FBRyxHQUFSLElBQWU4SyxlQUFlLEtBQUssR0FBcEIsR0FBMEIsR0FBMUIsR0FBZ0NwTSxLQUFLLENBQUNrQixRQUFOLENBQWVrTCxlQUFmLENBQS9DLENBQVA7QUFDSDs7QUFFRCxXQUFPcEYsUUFBUSxDQUFDa0YsVUFBRCxDQUFSLEdBQXVCLEdBQXZCLElBQThCM0ssU0FBUyxLQUFLLEdBQWQsR0FBb0IsR0FBcEIsR0FBMEJ2QixLQUFLLENBQUNrQixRQUFOLENBQWVLLFNBQWYsQ0FBeEQsQ0FBUDtBQUNIOztBQUVEaUksRUFBQUEsa0JBQWtCLENBQUNqSSxTQUFELEVBQVkySyxVQUFaLEVBQXdCbEYsUUFBeEIsRUFBa0M7QUFFaEQsUUFBSWtGLFVBQUosRUFBZ0I7QUFDWixhQUFPLEtBQUtELDBCQUFMLENBQWdDMUssU0FBaEMsRUFBMkMySyxVQUEzQyxFQUF1RGxGLFFBQXZELENBQVA7QUFDSDs7QUFFRCxXQUFRekYsU0FBUyxLQUFLLEdBQWYsR0FBc0JBLFNBQXRCLEdBQWtDdkIsS0FBSyxDQUFDa0IsUUFBTixDQUFlSyxTQUFmLENBQXpDO0FBQ0g7O0FBRURpRyxFQUFBQSxvQkFBb0IsQ0FBQzlCLElBQUQsRUFBT2hCLE1BQVAsRUFBZXdDLFVBQWYsRUFBMkJGLFFBQTNCLEVBQXFDO0FBQ3JELFdBQU9ySCxDQUFDLENBQUNnSCxHQUFGLENBQU1qQixJQUFOLEVBQVksQ0FBQzRHLENBQUQsRUFBSS9LLFNBQUosS0FBa0I7QUFBQSxZQUN6QkEsU0FBUyxDQUFDZ0wsT0FBVixDQUFrQixHQUFsQixNQUEyQixDQUFDLENBREg7QUFBQSx3QkFDTSw2REFETjtBQUFBOztBQUdqQyxhQUFPLEtBQUsvQyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELEdBQTNELEdBQWlFLEtBQUswRSxVQUFMLENBQWdCWSxDQUFoQixFQUFtQjVILE1BQW5CLEVBQTJCd0MsVUFBM0IsRUFBdUNGLFFBQXZDLENBQXhFO0FBQ0gsS0FKTSxDQUFQO0FBS0g7O0FBRUR3RixFQUFBQSxVQUFVLENBQUNDLEtBQUQsRUFBUS9ILE1BQVIsRUFBZ0J3QyxVQUFoQixFQUE0QkYsUUFBNUIsRUFBc0M7QUFDNUMsV0FBT3lGLEtBQUssQ0FBQzlGLEdBQU4sQ0FBVWxHLEtBQUssSUFBSSxLQUFLaUwsVUFBTCxDQUFnQmpMLEtBQWhCLEVBQXVCaUUsTUFBdkIsRUFBK0J3QyxVQUEvQixFQUEyQ0YsUUFBM0MsQ0FBbkIsRUFBeUVILElBQXpFLENBQThFLEdBQTlFLENBQVA7QUFDSDs7QUFFRDZFLEVBQUFBLFVBQVUsQ0FBQ2pMLEtBQUQsRUFBUWlFLE1BQVIsRUFBZ0J3QyxVQUFoQixFQUE0QkYsUUFBNUIsRUFBc0M7QUFDNUMsUUFBSXJILENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0IxSyxLQUFoQixDQUFKLEVBQTRCO0FBQ3hCLFVBQUlBLEtBQUssQ0FBQytLLE9BQVYsRUFBbUI7QUFDZixnQkFBUS9LLEtBQUssQ0FBQytLLE9BQWQ7QUFDSSxlQUFLLGlCQUFMO0FBQ0ksbUJBQU8sS0FBS2hDLGtCQUFMLENBQXdCL0ksS0FBSyxDQUFDZ0IsSUFBOUIsRUFBb0N5RixVQUFwQyxFQUFnREYsUUFBaEQsQ0FBUDs7QUFFSixlQUFLLFVBQUw7QUFDSSxtQkFBT3ZHLEtBQUssQ0FBQ2dCLElBQU4sR0FBYSxHQUFiLElBQW9CaEIsS0FBSyxDQUFDaUIsSUFBTixHQUFhLEtBQUs4SyxVQUFMLENBQWdCL0wsS0FBSyxDQUFDaUIsSUFBdEIsRUFBNEJnRCxNQUE1QixFQUFvQ3dDLFVBQXBDLEVBQWdERixRQUFoRCxDQUFiLEdBQXlFLEVBQTdGLElBQW1HLEdBQTFHOztBQUVKLGVBQUssa0JBQUw7QUFDSSxnQkFBSXlFLElBQUksR0FBRyxLQUFLQyxVQUFMLENBQWdCakwsS0FBSyxDQUFDZ0wsSUFBdEIsRUFBNEIvRyxNQUE1QixFQUFvQ3dDLFVBQXBDLEVBQWdERixRQUFoRCxDQUFYOztBQUNBLGdCQUFJMkUsS0FBSyxHQUFHLEtBQUtELFVBQUwsQ0FBZ0JqTCxLQUFLLENBQUNrTCxLQUF0QixFQUE2QmpILE1BQTdCLEVBQXFDd0MsVUFBckMsRUFBaURGLFFBQWpELENBQVo7O0FBQ0EsbUJBQU95RSxJQUFJLEdBQUksSUFBR2hMLEtBQUssQ0FBQ21MLEVBQUcsR0FBcEIsR0FBeUJELEtBQWhDOztBQUVKO0FBQ0ksa0JBQU0sSUFBSUcsS0FBSixDQUFXLHFCQUFvQnJMLEtBQUssQ0FBQytLLE9BQVEsRUFBN0MsQ0FBTjtBQWJSO0FBZUg7O0FBRUQvSyxNQUFBQSxLQUFLLEdBQUdzTCxJQUFJLENBQUNDLFNBQUwsQ0FBZXZMLEtBQWYsQ0FBUjtBQUNIOztBQUVEaUUsSUFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZckYsS0FBWjtBQUNBLFdBQU8sR0FBUDtBQUNIOztBQWFEb0wsRUFBQUEsY0FBYyxDQUFDdEssU0FBRCxFQUFZZCxLQUFaLEVBQW1CaUUsTUFBbkIsRUFBMkJ3QyxVQUEzQixFQUF1Q0YsUUFBdkMsRUFBaUQwRixNQUFqRCxFQUF5RDtBQUNuRSxRQUFJL00sQ0FBQyxDQUFDZ04sS0FBRixDQUFRbE0sS0FBUixDQUFKLEVBQW9CO0FBQ2hCLGFBQU8sS0FBSytJLGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsVUFBbEU7QUFDSDs7QUFFRCxRQUFJVCxLQUFLLENBQUNDLE9BQU4sQ0FBYy9GLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixhQUFPLEtBQUtvTCxjQUFMLENBQW9CdEssU0FBcEIsRUFBK0I7QUFBRXFMLFFBQUFBLEdBQUcsRUFBRW5NO0FBQVAsT0FBL0IsRUFBK0NpRSxNQUEvQyxFQUF1RHdDLFVBQXZELEVBQW1FRixRQUFuRSxFQUE2RTBGLE1BQTdFLENBQVA7QUFDSDs7QUFFRCxRQUFJL00sQ0FBQyxDQUFDd0wsYUFBRixDQUFnQjFLLEtBQWhCLENBQUosRUFBNEI7QUFDeEIsVUFBSUEsS0FBSyxDQUFDK0ssT0FBVixFQUFtQjtBQUNmLGVBQU8sS0FBS2hDLGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsS0FBM0QsR0FBbUUsS0FBSzBFLFVBQUwsQ0FBZ0JqTCxLQUFoQixFQUF1QmlFLE1BQXZCLEVBQStCd0MsVUFBL0IsRUFBMkNGLFFBQTNDLENBQTFFO0FBQ0g7O0FBRUQsVUFBSTZGLFdBQVcsR0FBR2xOLENBQUMsQ0FBQ3FFLElBQUYsQ0FBT3NILE1BQU0sQ0FBQ0MsSUFBUCxDQUFZOUssS0FBWixDQUFQLEVBQTJCcU0sQ0FBQyxJQUFJQSxDQUFDLElBQUlBLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBUyxHQUE5QyxDQUFsQjs7QUFFQSxVQUFJRCxXQUFKLEVBQWlCO0FBQ2IsZUFBT2xOLENBQUMsQ0FBQ2dILEdBQUYsQ0FBTWxHLEtBQU4sRUFBYSxDQUFDNkwsQ0FBRCxFQUFJUSxDQUFKLEtBQVU7QUFDMUIsY0FBSUEsQ0FBQyxJQUFJQSxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBbEIsRUFBdUI7QUFFbkIsb0JBQVFBLENBQVI7QUFDSSxtQkFBSyxRQUFMO0FBQ0EsbUJBQUssU0FBTDtBQUNJLHVCQUFPLEtBQUt0RCxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLEtBQTREc0YsQ0FBQyxHQUFHLGNBQUgsR0FBb0IsU0FBakYsQ0FBUDs7QUFFSixtQkFBSyxLQUFMO0FBQ0EsbUJBQUssUUFBTDtBQUVJLHVCQUFPLEtBQUtULGNBQUwsQ0FBb0J0SyxTQUFwQixFQUErQitLLENBQS9CLEVBQWtDNUgsTUFBbEMsRUFBMEN3QyxVQUExQyxFQUFzREYsUUFBdEQsRUFBZ0UwRixNQUFoRSxDQUFQOztBQUVKLG1CQUFLLEtBQUw7QUFDQSxtQkFBSyxNQUFMO0FBQ0EsbUJBQUssV0FBTDtBQUVJLG9CQUFJL00sQ0FBQyxDQUFDZ04sS0FBRixDQUFRTCxDQUFSLENBQUosRUFBZ0I7QUFDWix5QkFBTyxLQUFLOUMsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxjQUFsRTtBQUNIOztBQUVEc0YsZ0JBQUFBLENBQUMsR0FBRyxLQUFLOUwsUUFBTCxDQUFjOEwsQ0FBZCxDQUFKOztBQUVBLG9CQUFJSSxNQUFKLEVBQVk7QUFDUix5QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxNQUEzRCxHQUFvRXNGLENBQTNFO0FBQ0g7O0FBRUQ1SCxnQkFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0csQ0FBWjtBQUNBLHVCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELE9BQWxFOztBQUVKLG1CQUFLLElBQUw7QUFDQSxtQkFBSyxLQUFMO0FBQ0EsbUJBQUssY0FBTDtBQUNJc0YsZ0JBQUFBLENBQUMsR0FBRyxLQUFLOUwsUUFBTCxDQUFjOEwsQ0FBZCxDQUFKOztBQUVBLG9CQUFJSSxNQUFKLEVBQVk7QUFDUix5QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxLQUEzRCxHQUFtRXNGLENBQTFFO0FBQ0g7O0FBRUQ1SCxnQkFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0csQ0FBWjtBQUNBLHVCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELE1BQWxFOztBQUVKLG1CQUFLLEtBQUw7QUFDQSxtQkFBSyxNQUFMO0FBQ0EsbUJBQUsscUJBQUw7QUFDSXNGLGdCQUFBQSxDQUFDLEdBQUcsS0FBSzlMLFFBQUwsQ0FBYzhMLENBQWQsQ0FBSjs7QUFFQSxvQkFBSUksTUFBSixFQUFZO0FBQ1IseUJBQU8sS0FBS2xELGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsTUFBM0QsR0FBb0VzRixDQUEzRTtBQUNIOztBQUVENUgsZ0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWXdHLENBQVo7QUFDQSx1QkFBTyxLQUFLOUMsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxPQUFsRTs7QUFFSixtQkFBSyxJQUFMO0FBQ0EsbUJBQUssS0FBTDtBQUNBLG1CQUFLLFdBQUw7QUFDSXNGLGdCQUFBQSxDQUFDLEdBQUcsS0FBSzlMLFFBQUwsQ0FBYzhMLENBQWQsQ0FBSjs7QUFFQSxvQkFBSUksTUFBSixFQUFZO0FBQ1IseUJBQU8sS0FBS2xELGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsS0FBM0QsR0FBbUVzRixDQUExRTtBQUNIOztBQUVENUgsZ0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWXdHLENBQVo7QUFDQSx1QkFBTyxLQUFLOUMsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxNQUFsRTs7QUFFSixtQkFBSyxLQUFMO0FBQ0EsbUJBQUssTUFBTDtBQUNBLG1CQUFLLGtCQUFMO0FBQ0lzRixnQkFBQUEsQ0FBQyxHQUFHLEtBQUs5TCxRQUFMLENBQWM4TCxDQUFkLENBQUo7O0FBRUEsb0JBQUlJLE1BQUosRUFBWTtBQUNSLHlCQUFPLEtBQUtsRCxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELE1BQTNELEdBQW9Fc0YsQ0FBM0U7QUFDSDs7QUFFRDVILGdCQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVl3RyxDQUFaO0FBQ0EsdUJBQU8sS0FBSzlDLGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsT0FBbEU7O0FBRUosbUJBQUssS0FBTDtBQUNJLG9CQUFJckgsQ0FBQyxDQUFDd0wsYUFBRixDQUFnQm1CLENBQWhCLEtBQXNCQSxDQUFDLENBQUNkLE9BQUYsS0FBYyxTQUF4QyxFQUFtRDtBQUUvQyx3QkFBTXhELE9BQU8sR0FBRyxLQUFLQyxVQUFMLENBQWdCcUUsQ0FBQyxDQUFDN0csS0FBbEIsRUFBeUI2RyxDQUFDLENBQUNuSSxLQUEzQixDQUFoQjtBQUNBNkQsa0JBQUFBLE9BQU8sQ0FBQ3RELE1BQVIsSUFBa0JzRCxPQUFPLENBQUN0RCxNQUFSLENBQWUrQixPQUFmLENBQXVCYSxDQUFDLElBQUk1QyxNQUFNLENBQUNvQixJQUFQLENBQVl3QixDQUFaLENBQTVCLENBQWxCO0FBRUEseUJBQU8sS0FBS2tDLGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBNEQsUUFBT2dCLE9BQU8sQ0FBQ3ZELEdBQUksR0FBdEY7QUFDSCxpQkFORCxNQU1PO0FBRUgsc0JBQUksQ0FBQzhCLEtBQUssQ0FBQ0MsT0FBTixDQUFjOEYsQ0FBZCxDQUFMLEVBQXVCO0FBQ25CLDBCQUFNLElBQUlSLEtBQUosQ0FBVSx5REFBVixDQUFOO0FBQ0g7O0FBRUQsc0JBQUlZLE1BQUosRUFBWTtBQUNSLDJCQUFPLEtBQUtsRCxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTRELFFBQU9zRixDQUFFLEdBQTVFO0FBQ0g7O0FBRUQ1SCxrQkFBQUEsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0csQ0FBWjtBQUNBLHlCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELFNBQWxFO0FBQ0g7O0FBRUwsbUJBQUssTUFBTDtBQUNBLG1CQUFLLFFBQUw7QUFDSSxvQkFBSXJILENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0JtQixDQUFoQixLQUFzQkEsQ0FBQyxDQUFDZCxPQUFGLEtBQWMsU0FBeEMsRUFBbUQ7QUFFL0Msd0JBQU14RCxPQUFPLEdBQUcsS0FBS0MsVUFBTCxDQUFnQnFFLENBQUMsQ0FBQzdHLEtBQWxCLEVBQXlCNkcsQ0FBQyxDQUFDbkksS0FBM0IsQ0FBaEI7QUFDQTZELGtCQUFBQSxPQUFPLENBQUN0RCxNQUFSLElBQWtCc0QsT0FBTyxDQUFDdEQsTUFBUixDQUFlK0IsT0FBZixDQUF1QmEsQ0FBQyxJQUFJNUMsTUFBTSxDQUFDb0IsSUFBUCxDQUFZd0IsQ0FBWixDQUE1QixDQUFsQjtBQUVBLHlCQUFPLEtBQUtrQyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTRELFlBQVdnQixPQUFPLENBQUN2RCxHQUFJLEdBQTFGO0FBQ0gsaUJBTkQsTUFNTztBQUVILHNCQUFJLENBQUM4QixLQUFLLENBQUNDLE9BQU4sQ0FBYzhGLENBQWQsQ0FBTCxFQUF1QjtBQUNuQiwwQkFBTSxJQUFJUixLQUFKLENBQVUseURBQVYsQ0FBTjtBQUNIOztBQUVELHNCQUFJWSxNQUFKLEVBQVk7QUFDUiwyQkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUE0RCxZQUFXc0YsQ0FBRSxHQUFoRjtBQUNIOztBQUdENUgsa0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBWXdHLENBQVo7QUFDQSx5QkFBTyxLQUFLOUMsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxhQUFsRTtBQUNIOztBQUVMLG1CQUFLLFlBQUw7QUFDQSxtQkFBSyxhQUFMO0FBRUksb0JBQUksT0FBT3NGLENBQVAsS0FBYSxRQUFqQixFQUEyQjtBQUN2Qix3QkFBTSxJQUFJUixLQUFKLENBQVUsZ0VBQVYsQ0FBTjtBQUNIOztBQUpMLHFCQU1ZLENBQUNZLE1BTmI7QUFBQTtBQUFBOztBQVFJaEksZ0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBYSxHQUFFd0csQ0FBRSxHQUFqQjtBQUNBLHVCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELFNBQWxFOztBQUVKLG1CQUFLLFVBQUw7QUFDQSxtQkFBSyxXQUFMO0FBRUksb0JBQUksT0FBT3NGLENBQVAsS0FBYSxRQUFqQixFQUEyQjtBQUN2Qix3QkFBTSxJQUFJUixLQUFKLENBQVUsOERBQVYsQ0FBTjtBQUNIOztBQUpMLHFCQU1ZLENBQUNZLE1BTmI7QUFBQTtBQUFBOztBQVFJaEksZ0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBYSxJQUFHd0csQ0FBRSxFQUFsQjtBQUNBLHVCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELFNBQWxFOztBQUVKLG1CQUFLLE9BQUw7QUFDQSxtQkFBSyxRQUFMO0FBRUksb0JBQUksT0FBT3NGLENBQVAsS0FBYSxRQUFqQixFQUEyQjtBQUN2Qix3QkFBTSxJQUFJUixLQUFKLENBQVUsMkRBQVYsQ0FBTjtBQUNIOztBQUpMLHFCQU1ZLENBQUNZLE1BTmI7QUFBQTtBQUFBOztBQVFJaEksZ0JBQUFBLE1BQU0sQ0FBQ29CLElBQVAsQ0FBYSxJQUFHd0csQ0FBRSxHQUFsQjtBQUNBLHVCQUFPLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLElBQTJELFNBQWxFOztBQUVKLG1CQUFLLE1BQUw7QUFDSSxvQkFBSSxPQUFPc0YsQ0FBUCxLQUFhLFFBQWIsSUFBeUJBLENBQUMsQ0FBQ0MsT0FBRixDQUFVLEdBQVYsS0FBa0IsQ0FBL0MsRUFBa0Q7QUFDOUMsd0JBQU0sSUFBSVQsS0FBSixDQUFVLHNFQUFWLENBQU47QUFDSDs7QUFITCxxQkFLWSxDQUFDWSxNQUxiO0FBQUE7QUFBQTs7QUFPSWhJLGdCQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVl3RyxDQUFaO0FBQ0EsdUJBQVEsa0JBQWlCLEtBQUs5QyxrQkFBTCxDQUF3QmpJLFNBQXhCLEVBQW1DMkYsVUFBbkMsRUFBK0NGLFFBQS9DLENBQXlELE9BQWxGOztBQUVKO0FBQ0ksc0JBQU0sSUFBSThFLEtBQUosQ0FBVyxvQ0FBbUNnQixDQUFFLElBQWhELENBQU47QUF0S1I7QUF3S0gsV0ExS0QsTUEwS087QUFDSCxrQkFBTSxJQUFJaEIsS0FBSixDQUFVLG9EQUFWLENBQU47QUFDSDtBQUNKLFNBOUtNLEVBOEtKakYsSUE5S0ksQ0E4S0MsT0E5S0QsQ0FBUDtBQStLSDs7QUF2THVCLFdBeUxoQixDQUFDNkYsTUF6TGU7QUFBQTtBQUFBOztBQTJMeEJoSSxNQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVlpRyxJQUFJLENBQUNDLFNBQUwsQ0FBZXZMLEtBQWYsQ0FBWjtBQUNBLGFBQU8sS0FBSytJLGtCQUFMLENBQXdCakksU0FBeEIsRUFBbUMyRixVQUFuQyxFQUErQ0YsUUFBL0MsSUFBMkQsTUFBbEU7QUFDSDs7QUFFRHZHLElBQUFBLEtBQUssR0FBRyxLQUFLRCxRQUFMLENBQWNDLEtBQWQsQ0FBUjs7QUFFQSxRQUFJaU0sTUFBSixFQUFZO0FBQ1IsYUFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxLQUEzRCxHQUFtRXZHLEtBQTFFO0FBQ0g7O0FBRURpRSxJQUFBQSxNQUFNLENBQUNvQixJQUFQLENBQVlyRixLQUFaO0FBQ0EsV0FBTyxLQUFLK0ksa0JBQUwsQ0FBd0JqSSxTQUF4QixFQUFtQzJGLFVBQW5DLEVBQStDRixRQUEvQyxJQUEyRCxNQUFsRTtBQUNIOztBQUVEb0MsRUFBQUEsYUFBYSxDQUFDMkQsT0FBRCxFQUFVckksTUFBVixFQUFrQndDLFVBQWxCLEVBQThCRixRQUE5QixFQUF3QztBQUNqRCxXQUFPckgsQ0FBQyxDQUFDZ0gsR0FBRixDQUFNaEgsQ0FBQyxDQUFDcU4sU0FBRixDQUFZRCxPQUFaLENBQU4sRUFBNEJFLEdBQUcsSUFBSSxLQUFLQyxZQUFMLENBQWtCRCxHQUFsQixFQUF1QnZJLE1BQXZCLEVBQStCd0MsVUFBL0IsRUFBMkNGLFFBQTNDLENBQW5DLEVBQXlGSCxJQUF6RixDQUE4RixJQUE5RixDQUFQO0FBQ0g7O0FBRURxRyxFQUFBQSxZQUFZLENBQUNELEdBQUQsRUFBTXZJLE1BQU4sRUFBY3dDLFVBQWQsRUFBMEJGLFFBQTFCLEVBQW9DO0FBQzVDLFFBQUksT0FBT2lHLEdBQVAsS0FBZSxRQUFuQixFQUE2QjtBQUV6QixhQUFPN00sUUFBUSxDQUFDNk0sR0FBRCxDQUFSLEdBQWdCQSxHQUFoQixHQUFzQixLQUFLekQsa0JBQUwsQ0FBd0J5RCxHQUF4QixFQUE2Qi9GLFVBQTdCLEVBQXlDRixRQUF6QyxDQUE3QjtBQUNIOztBQUVELFFBQUksT0FBT2lHLEdBQVAsS0FBZSxRQUFuQixFQUE2QjtBQUN6QixhQUFPQSxHQUFQO0FBQ0g7O0FBRUQsUUFBSXROLENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0I4QixHQUFoQixDQUFKLEVBQTBCO0FBQ3RCLFVBQUlBLEdBQUcsQ0FBQzNMLEtBQVIsRUFBZTtBQUFBLGNBQ0gsT0FBTzJMLEdBQUcsQ0FBQzNMLEtBQVgsS0FBcUIsUUFEbEI7QUFBQTtBQUFBOztBQUdYLGNBQU02TCxZQUFZLEdBQUdGLEdBQUcsQ0FBQzNMLEtBQUosQ0FBVThMLFdBQVYsQ0FBc0IsR0FBdEIsQ0FBckI7QUFDQSxZQUFJOUwsS0FBSyxHQUFHNkwsWUFBWSxHQUFHLENBQWYsR0FBbUJGLEdBQUcsQ0FBQzNMLEtBQUosQ0FBVStMLE1BQVYsQ0FBaUJGLFlBQVksR0FBQyxDQUE5QixDQUFuQixHQUFzREYsR0FBRyxDQUFDM0wsS0FBdEU7O0FBRUEsWUFBSTZMLFlBQVksR0FBRyxDQUFuQixFQUFzQjtBQUNsQixjQUFJLENBQUNqRyxVQUFMLEVBQWlCO0FBQ2Isa0JBQU0sSUFBSS9HLGVBQUosQ0FBb0IsaUZBQXBCLEVBQXVHO0FBQ3pHbUIsY0FBQUEsS0FBSyxFQUFFMkwsR0FBRyxDQUFDM0w7QUFEOEYsYUFBdkcsQ0FBTjtBQUdIOztBQUVELGdCQUFNZ00sUUFBUSxHQUFHcEcsVUFBVSxHQUFHLEdBQWIsR0FBbUIrRixHQUFHLENBQUMzTCxLQUFKLENBQVUrTCxNQUFWLENBQWlCLENBQWpCLEVBQW9CRixZQUFwQixDQUFwQztBQUNBLGdCQUFNSSxXQUFXLEdBQUd2RyxRQUFRLENBQUNzRyxRQUFELENBQTVCOztBQUNBLGNBQUksQ0FBQ0MsV0FBTCxFQUFrQjtBQUNkLGtCQUFNLElBQUlwTixlQUFKLENBQXFCLDJCQUEwQm1OLFFBQVMsOEJBQXhELEVBQXVGO0FBQ3pGaE0sY0FBQUEsS0FBSyxFQUFFMkwsR0FBRyxDQUFDM0w7QUFEOEUsYUFBdkYsQ0FBTjtBQUdIOztBQUVEQSxVQUFBQSxLQUFLLEdBQUdpTSxXQUFXLEdBQUcsR0FBZCxHQUFvQmpNLEtBQTVCO0FBQ0g7O0FBRUQsZUFBTyxLQUFLNEwsWUFBTCxDQUFrQnZOLENBQUMsQ0FBQ3dHLElBQUYsQ0FBTzhHLEdBQVAsRUFBWSxDQUFDLE9BQUQsQ0FBWixDQUFsQixFQUEwQ3ZJLE1BQTFDLEVBQWtEd0MsVUFBbEQsRUFBOERGLFFBQTlELElBQTBFLE1BQTFFLEdBQW1GaEgsS0FBSyxDQUFDa0IsUUFBTixDQUFlSSxLQUFmLENBQTFGO0FBQ0g7O0FBRUQsVUFBSTJMLEdBQUcsQ0FBQ3pMLElBQUosS0FBYSxVQUFqQixFQUE2QjtBQUN6QixZQUFJQyxJQUFJLEdBQUd3TCxHQUFHLENBQUN4TCxJQUFKLENBQVMwSSxXQUFULEVBQVg7O0FBQ0EsWUFBSTFJLElBQUksS0FBSyxPQUFULElBQW9Cd0wsR0FBRyxDQUFDdkwsSUFBSixDQUFTMkQsTUFBVCxLQUFvQixDQUF4QyxJQUE2QzRILEdBQUcsQ0FBQ3ZMLElBQUosQ0FBUyxDQUFULE1BQWdCLEdBQWpFLEVBQXNFO0FBQ2xFLGlCQUFPLFVBQVA7QUFDSDs7QUFFRCxlQUFPRCxJQUFJLEdBQUcsR0FBUCxJQUFjd0wsR0FBRyxDQUFDTyxNQUFKLEdBQWMsR0FBRVAsR0FBRyxDQUFDTyxNQUFKLENBQVdyRCxXQUFYLEVBQXlCLEdBQXpDLEdBQThDLEVBQTVELEtBQW1FOEMsR0FBRyxDQUFDdkwsSUFBSixHQUFXLEtBQUswSCxhQUFMLENBQW1CNkQsR0FBRyxDQUFDdkwsSUFBdkIsRUFBNkJnRCxNQUE3QixFQUFxQ3dDLFVBQXJDLEVBQWlERixRQUFqRCxDQUFYLEdBQXdFLEVBQTNJLElBQWlKLEdBQXhKO0FBQ0g7O0FBRUQsVUFBSWlHLEdBQUcsQ0FBQ3pMLElBQUosS0FBYSxZQUFqQixFQUErQjtBQUMzQixlQUFPLEtBQUtrRyxjQUFMLENBQW9CdUYsR0FBRyxDQUFDUSxJQUF4QixFQUE4Qi9JLE1BQTlCLEVBQXNDLElBQXRDLEVBQTRDd0MsVUFBNUMsRUFBd0RGLFFBQXhELENBQVA7QUFDSDtBQUNKOztBQUVELFVBQU0sSUFBSTlHLGdCQUFKLENBQXNCLHlCQUF3QjZMLElBQUksQ0FBQ0MsU0FBTCxDQUFlaUIsR0FBZixDQUFvQixFQUFsRSxDQUFOO0FBQ0g7O0FBRUQ1RCxFQUFBQSxhQUFhLENBQUNxRSxPQUFELEVBQVVoSixNQUFWLEVBQWtCd0MsVUFBbEIsRUFBOEJGLFFBQTlCLEVBQXdDO0FBQ2pELFFBQUksT0FBTzBHLE9BQVAsS0FBbUIsUUFBdkIsRUFBaUMsT0FBTyxjQUFjLEtBQUtsRSxrQkFBTCxDQUF3QmtFLE9BQXhCLEVBQWlDeEcsVUFBakMsRUFBNkNGLFFBQTdDLENBQXJCO0FBRWpDLFFBQUlULEtBQUssQ0FBQ0MsT0FBTixDQUFja0gsT0FBZCxDQUFKLEVBQTRCLE9BQU8sY0FBY0EsT0FBTyxDQUFDL0csR0FBUixDQUFZZ0gsRUFBRSxJQUFJLEtBQUtuRSxrQkFBTCxDQUF3Qm1FLEVBQXhCLEVBQTRCekcsVUFBNUIsRUFBd0NGLFFBQXhDLENBQWxCLEVBQXFFSCxJQUFyRSxDQUEwRSxJQUExRSxDQUFyQjs7QUFFNUIsUUFBSWxILENBQUMsQ0FBQ3dMLGFBQUYsQ0FBZ0J1QyxPQUFoQixDQUFKLEVBQThCO0FBQzFCLFVBQUk7QUFBRVgsUUFBQUEsT0FBRjtBQUFXYSxRQUFBQTtBQUFYLFVBQXNCRixPQUExQjs7QUFFQSxVQUFJLENBQUNYLE9BQUQsSUFBWSxDQUFDeEcsS0FBSyxDQUFDQyxPQUFOLENBQWN1RyxPQUFkLENBQWpCLEVBQXlDO0FBQ3JDLGNBQU0sSUFBSTdNLGdCQUFKLENBQXNCLDRCQUEyQjZMLElBQUksQ0FBQ0MsU0FBTCxDQUFlMEIsT0FBZixDQUF3QixFQUF6RSxDQUFOO0FBQ0g7O0FBRUQsVUFBSUcsYUFBYSxHQUFHLEtBQUt4RSxhQUFMLENBQW1CMEQsT0FBbkIsQ0FBcEI7O0FBQ0EsVUFBSWUsV0FBVyxHQUFHRixNQUFNLElBQUksS0FBS2xHLGNBQUwsQ0FBb0JrRyxNQUFwQixFQUE0QmxKLE1BQTVCLEVBQW9DLElBQXBDLEVBQTBDd0MsVUFBMUMsRUFBc0RGLFFBQXRELENBQTVCOztBQUNBLFVBQUk4RyxXQUFKLEVBQWlCO0FBQ2JELFFBQUFBLGFBQWEsSUFBSSxhQUFhQyxXQUE5QjtBQUNIOztBQUVELGFBQU9ELGFBQVA7QUFDSDs7QUFFRCxVQUFNLElBQUkzTixnQkFBSixDQUFzQiw0QkFBMkI2TCxJQUFJLENBQUNDLFNBQUwsQ0FBZTBCLE9BQWYsQ0FBd0IsRUFBekUsQ0FBTjtBQUNIOztBQUVEcEUsRUFBQUEsYUFBYSxDQUFDeUUsT0FBRCxFQUFVN0csVUFBVixFQUFzQkYsUUFBdEIsRUFBZ0M7QUFDekMsUUFBSSxPQUFPK0csT0FBUCxLQUFtQixRQUF2QixFQUFpQyxPQUFPLGNBQWMsS0FBS3ZFLGtCQUFMLENBQXdCdUUsT0FBeEIsRUFBaUM3RyxVQUFqQyxFQUE2Q0YsUUFBN0MsQ0FBckI7QUFFakMsUUFBSVQsS0FBSyxDQUFDQyxPQUFOLENBQWN1SCxPQUFkLENBQUosRUFBNEIsT0FBTyxjQUFjQSxPQUFPLENBQUNwSCxHQUFSLENBQVlnSCxFQUFFLElBQUksS0FBS25FLGtCQUFMLENBQXdCbUUsRUFBeEIsRUFBNEJ6RyxVQUE1QixFQUF3Q0YsUUFBeEMsQ0FBbEIsRUFBcUVILElBQXJFLENBQTBFLElBQTFFLENBQXJCOztBQUU1QixRQUFJbEgsQ0FBQyxDQUFDd0wsYUFBRixDQUFnQjRDLE9BQWhCLENBQUosRUFBOEI7QUFDMUIsYUFBTyxjQUFjcE8sQ0FBQyxDQUFDZ0gsR0FBRixDQUFNb0gsT0FBTixFQUFlLENBQUNDLEdBQUQsRUFBTWYsR0FBTixLQUFjLEtBQUt6RCxrQkFBTCxDQUF3QnlELEdBQXhCLEVBQTZCL0YsVUFBN0IsRUFBeUNGLFFBQXpDLEtBQXNEZ0gsR0FBRyxLQUFLLEtBQVIsSUFBaUJBLEdBQUcsSUFBSSxJQUF4QixHQUErQixPQUEvQixHQUF5QyxFQUEvRixDQUE3QixFQUFpSW5ILElBQWpJLENBQXNJLElBQXRJLENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJM0csZ0JBQUosQ0FBc0IsNEJBQTJCNkwsSUFBSSxDQUFDQyxTQUFMLENBQWUrQixPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxRQUFNcEosZUFBTixDQUFzQjNELE9BQXRCLEVBQStCO0FBQzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDaU4sVUFBcEIsR0FBa0NqTixPQUFPLENBQUNpTixVQUExQyxHQUF1RCxLQUFLL0ssUUFBTCxDQUFjbEMsT0FBZCxDQUE5RDtBQUNIOztBQUVELFFBQU1zRSxtQkFBTixDQUEwQjFDLElBQTFCLEVBQWdDNUIsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDaU4sVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLcEwsV0FBTCxDQUFpQkQsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBN2pDa0M7O0FBQWpDckMsYyxDQU1LMEQsZSxHQUFrQnFILE1BQU0sQ0FBQzRDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQTBqQzdCL04sY0FBYyxDQUFDZ08sU0FBZixHQUEyQnZPLEtBQTNCO0FBRUF3TyxNQUFNLENBQUNDLE9BQVAsR0FBaUJsTyxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xpYicpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCB7IGlzUXVvdGVkLCBpc1ByaW1pdGl2ZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG4gICAgcXVlcnlDb3VudCA9IChhbGlhcywgZmllbGROYW1lKSA9PiAoe1xuICAgICAgICB0eXBlOiAnZnVuY3Rpb24nLFxuICAgICAgICBuYW1lOiAnQ09VTlQnLFxuICAgICAgICBhcmdzOiBbIGZpZWxkTmFtZSB8fCAnKicgXSxcbiAgICAgICAgYWxpYXM6IGFsaWFzIHx8ICdjb3VudCdcbiAgICB9KTsgXG5cbiAgICAvL2luIG15c3FsLCBudWxsIHZhbHVlIGNvbXBhcmlzb24gd2lsbCBuZXZlciByZXR1cm4gdHJ1ZSwgZXZlbiBudWxsICE9IDFcbiAgICBudWxsT3JJcyA9IChmaWVsZE5hbWUsIHZhbHVlKSA9PiBbeyBbZmllbGROYW1lXTogeyAkZXhpc3RzOiBmYWxzZSB9IH0sIHsgW2ZpZWxkTmFtZV06IHsgJGVxOiB2YWx1ZSB9IH1dO1xuXG4gICAgdXBkYXRlZENvdW50ID0gKGNvbnRleHQpID0+IGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cztcbiAgICBkZWxldGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuXG4gICAgdHlwZUNhc3QodmFsdWUpIHtcbiAgICAgICAgY29uc3QgdCA9IHR5cGVvZiB2YWx1ZTtcblxuICAgICAgICBpZiAodCA9PT0gXCJib29sZWFuXCIpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh0ID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUgIT0gbnVsbCAmJiB2YWx1ZS5pc0x1eG9uRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBTZXQoKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGlmICh0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID09PSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMucG9vbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENsb3NlIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5wb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5wb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5hZGQoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENvbm5lY3QgdG8gJHtjc0tleX1gKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYERpc2Nvbm5lY3QgZnJvbSAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGNvbnN0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBbIHJldCBdID0gYXdhaXQgY29ubi5xdWVyeSgnU0VMRUNUIEBAYXV0b2NvbW1pdDsnKTsgICAgICAgIFxuICAgICAgICBjb25uLiQkYXV0b2NvbW1pdCA9IHJldFswXVsnQEBhdXRvY29tbWl0J107ICAgICAgICBcblxuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTA7Jyk7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NUQVJUIFRSQU5TQUNUSU9OOycpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ0NPTU1JVDsnKTsgICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBDb21taXRzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1JPTExCQUNLOycpO1xuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LiAgICAgXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIGVyci5pbmZvIHx8IChlcnIuaW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnNxbCA9IF8udHJ1bmNhdGUoc3FsLCB7IGxlbmd0aDogMjAwIH0pO1xuICAgICAgICAgICAgZXJyLmluZm8ucGFyYW1zID0gcGFyYW1zO1xuXG4gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSBvciB1cGRhdGUgdGhlIG9sZCBvbmUgaWYgZHVwbGljYXRlIGtleSBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwc2VydE9uZV8obW9kZWwsIGRhdGEsIHVuaXF1ZUtleXMsIG9wdGlvbnMsIGRhdGFPbkluc2VydCkge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkYXRhV2l0aG91dFVLID0gXy5vbWl0KGRhdGEsIHVuaXF1ZUtleXMpO1xuICAgICAgICBsZXQgaW5zZXJ0RGF0YSA9IHsgLi4uZGF0YSwgLi4uZGF0YU9uSW5zZXJ0IH07XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhV2l0aG91dFVLKSkge1xuICAgICAgICAgICAgLy9pZiBkdXBsaWF0ZSwgZG9udCBuZWVkIHRvIHVwZGF0ZVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhtb2RlbCwgaW5zZXJ0RGF0YSwgeyAuLi5vcHRpb25zLCBpbnNlcnRJZ25vcmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCBJTlRPID8/IFNFVCA/IE9OIERVUExJQ0FURSBLRVkgVVBEQVRFID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChpbnNlcnREYXRhKTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YVdpdGhvdXRVSyk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBhc3luYyBpbnNlcnRNYW55Xyhtb2RlbCwgZmllbGRzLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJkYXRhXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZHMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZmllbGRzXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWVzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICBkYXRhLmZvckVhY2gocm93ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignRWxlbWVudCBvZiBcImRhdGFcIiBhcnJheSB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3JkIHZhbHVlcy4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMpIHx8IGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCAnICsgdGhpcy5fc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKS5qb2luKCcsJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCA/JztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHVwZGF0ZU9uZV8gPSB0aGlzLnVwZGF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gZGVsZXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgcXVlcnksIGRlbGV0ZU9wdGlvbnMsIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChkZWxldGVPcHRpb25zICYmIGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgQSBGUk9NID8/IEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgRlJPTSA/Pyc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICAgXG4gICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS8qLm1hcChuID0+ICc6JyArIG4pIGNoYW5nZWQgdG8gYmUgcGFkZGluZyBieSBvcm0gYW5kIGNhbiBiZSBjdXN0b21pemVkIHdpdGggb3RoZXIga2V5IGdldHRlciAqLztcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uZGl0aW9uLiRza2lwT3JtKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7ICAgICAgICAgICAgIFxuICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHsgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY3MsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcgfHwga2V5LnN0YXJ0c1dpdGgoJyRhbmRfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmICgoa2V5ID09PSAnJGV4cHInIHx8IGtleS5zdGFydHNXaXRoKCckZXhwcl8nKSkgJiYgdmFsdWUub29yVHlwZSAmJiB2YWx1ZS5vb3JUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IG1haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFthbGlhc0tleV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgQ29sdW1uIHJlZmVyZW5jZSBcIiR7ZmllbGROYW1lfVwiIG5vdCBmb3VuZCBpbiBwb3B1bGF0ZWQgYXNzb2NpYXRpb25zLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBtYWluRW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhczogYWxpYXNLZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIChhY3R1YWxGaWVsZE5hbWUgPT09ICcqJyA/ICcqJyA6IG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gJyonIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIChmaWVsZE5hbWUgPT09ICcqJykgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIF9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwKGRhdGEsICh2LCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGROYW1lLmluZGV4T2YoJy4nKSA9PT0gLTEsICdDb2x1bW4gb2YgZGlyZWN0IGlucHV0IGRhdGEgY2Fubm90IGJlIGEgZG90LXNlcGFyYXRlZCBuYW1lLic7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICc9JyArIHRoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX3BhY2tBcnJheShhcnJheSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gYXJyYXkubWFwKHZhbHVlID0+IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywnKTtcbiAgICB9XG5cbiAgICBfcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHN3aXRjaCAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdDb2x1bW5SZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdGdW5jdGlvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubmFtZSArICcoJyArICh2YWx1ZS5hcmdzID8gdGhpcy5fcGFja0FycmF5KHZhbHVlLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcblxuICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9vciB0eXBlOiAke3ZhbHVlLm9vclR5cGV9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YWx1ZSA9IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuICc/JztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHsgJGluOiB2YWx1ZSB9LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGhhc09wZXJhdG9yID0gXy5maW5kKE9iamVjdC5rZXlzKHZhbHVlKSwgayA9PiBrICYmIGtbMF0gPT09ICckJyk7XG5cbiAgICAgICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiBfLm1hcCh2YWx1ZSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGsgJiYga1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvcGVyYXRvclxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKHYgPyAnIElTIE5PVCBOVUxMJyA6ICdJUyBOVUxMJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHYpICYmIHYub29yVHlwZSA9PT0gJ0RhdGFTZXQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkodi5tb2RlbCwgdi5xdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxJbmZvLnBhcmFtcyAmJiBzcWxJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHYpICYmIHYub29yVHlwZSA9PT0gJ0RhdGFTZXQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkodi5tb2RlbCwgdi5xdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxJbmZvLnBhcmFtcyAmJiBzcWxJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHtzcWxJbmZvLnNxbH0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHsgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kc1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGVuZFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlcyc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGhhcyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycgfHwgdi5pbmRleE9mKCcsJykgPj0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdpdGhvdXQgXCIsXCIgd2hlbiB1c2luZyBcIiRoYXNcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYEZJTkRfSU5fU0VUKD8sICR7dGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9KSA+IDBgO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgcGFyYW1zLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlID0gdGhpcy50eXBlQ2FzdCh2YWx1ZSk7XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIGNvbnN0IGxhc3REb3RJbmRleCA9IGNvbC5hbGlhcy5sYXN0SW5kZXhPZignLicpO1xuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGxhc3REb3RJbmRleCA+IDAgPyBjb2wuYWxpYXMuc3Vic3RyKGxhc3REb3RJbmRleCsxKSA6IGNvbC5hbGlhcztcblxuICAgICAgICAgICAgICAgIGlmIChsYXN0RG90SW5kZXggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaGFzSm9pbmluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2FzY2FkZSBhbGlhcyBpcyBub3QgYWxsb3dlZCB3aGVuIHRoZSBxdWVyeSBoYXMgbm8gYXNzb2NpYXRlZCBlbnRpdHkgcG9wdWxhdGVkLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhczogY29sLmFsaWFzXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gaGFzSm9pbmluZyArICcuJyArIGNvbC5hbGlhcy5zdWJzdHIoMCwgbGFzdERvdEluZGV4KTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYWxpYXNQcmVmaXggPSBhbGlhc01hcFtmdWxsUGF0aF07XG4gICAgICAgICAgICAgICAgICAgIGlmICghYWxpYXNQcmVmaXgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEludmFsaWQgY2FzY2FkZSBhbGlhcy4gXCIke2Z1bGxQYXRofVwiIG5vdCBmb3VuZCBpbiBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBhbGlhc1ByZWZpeCArICckJyArIGFsaWFzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5hbWUgPSBjb2wubmFtZS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgICAgIGlmIChuYW1lID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBuYW1lICsgJygnICsgKGNvbC5wcmVmaXggPyBgJHtjb2wucHJlZml4LnRvVXBwZXJDYXNlKCl9IGAgOiBcIlwiKSArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA9PT0gZmFsc2UgfHwgYXNjID09ICctMScgPyAnIERFU0MnIDogJycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuTXlTUUxDb25uZWN0b3IuZHJpdmVyTGliID0gbXlzcWw7XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19
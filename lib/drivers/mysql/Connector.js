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

    this.insertOne_ = this.create_;
    this.updateOne_ = this.update_;
    this.relational = true;
    this.acitveConnections = new WeakSet();
  }

  async end_() {
    if (this.acitveConnections.size > 0) {
      for (let conn of this.acitveConnections) {
        await this.disconnect_(conn);
      }

      ;
    }

    if (this.pool) {
      this.log('debug', `End connection pool to ${this.currentConnectionString}`);
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

    sql += ' WHERE ' + whereClause;
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
        result[alias] = nodePath.split('.').slice(1).map(n => ':' + n);
        return result;
      }, {});

      if (sqlInfo.countSql) {
        return result.concat(reverseAliasMap, totalCount);
      }

      return result.concat(reverseAliasMap);
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

                if (isPrimitive(v)) {
                  if (inject) {
                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ' + v;
                  }

                  params.push(v);
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';
                }

                return 'NOT (' + this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, true) + ')';

              case '$>':
              case '$gt':
              case '$greaterThan':
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ?';

              case '$>=':
              case '$gte':
              case '$greaterThanOrEqual':
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ?';

              case '$<':
              case '$lt':
              case '$lessThan':
                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ' + v;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ?';

              case '$<=':
              case '$lte':
              case '$lessThanOrEqual':
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwicXVlcnlDb3VudCIsImFsaWFzIiwiZmllbGROYW1lIiwidHlwZSIsIm5hbWUiLCJhcmdzIiwibnVsbE9ySXMiLCJ2YWx1ZSIsIiRleGlzdHMiLCIkZXEiLCJpbnNlcnRPbmVfIiwiY3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVfIiwicmVsYXRpb25hbCIsImFjaXR2ZUNvbm5lY3Rpb25zIiwiV2Vha1NldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFPbkluc2VydCIsImRhdGFXaXRob3V0VUsiLCJvbWl0IiwiaW5zZXJ0RGF0YSIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZGVsZXRlT3B0aW9ucyIsImZpbmRfIiwiY29uZGl0aW9uIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm4iLCJjb25jYXQiLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImpvaW5PcGVyYXRvciIsImMiLCJpc1BsYWluT2JqZWN0Iiwic3RhcnRzV2l0aCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsImtleXMiLCJvb3JUeXBlIiwibGVmdCIsIl9wYWNrVmFsdWUiLCJyaWdodCIsIm9wIiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsImNvbnNvbGUiLCJtc2ciLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsImxhc3REb3RJbmRleCIsImxhc3RJbmRleE9mIiwic3Vic3RyIiwiZnVsbFBhdGgiLCJhbGlhc1ByZWZpeCIsInByZWZpeCIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGlCQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXdDTCxPQUFPLENBQUMsb0JBQUQsQ0FBckQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxrQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQStCbkNPLEVBQUFBLFdBQVcsQ0FBQ0MsZ0JBQUQsRUFBbUJDLE9BQW5CLEVBQTRCO0FBQ25DLFVBQU0sT0FBTixFQUFlRCxnQkFBZixFQUFpQ0MsT0FBakM7QUFEbUMsU0FsQnZDQyxNQWtCdUMsR0FsQjlCWCxLQUFLLENBQUNXLE1Ba0J3QjtBQUFBLFNBakJ2Q0MsUUFpQnVDLEdBakI1QlosS0FBSyxDQUFDWSxRQWlCc0I7QUFBQSxTQWhCdkNDLE1BZ0J1QyxHQWhCOUJiLEtBQUssQ0FBQ2EsTUFnQndCO0FBQUEsU0FmdkNDLEdBZXVDLEdBZmpDZCxLQUFLLENBQUNjLEdBZTJCOztBQUFBLFNBZHZDQyxVQWN1QyxHQWQxQixDQUFDQyxLQUFELEVBQVFDLFNBQVIsTUFBdUI7QUFDaENDLE1BQUFBLElBQUksRUFB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dCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9saWInKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuICAgIHF1ZXJ5Q291bnQgPSAoYWxpYXMsIGZpZWxkTmFtZSkgPT4gKHtcbiAgICAgICAgdHlwZTogJ2Z1bmN0aW9uJyxcbiAgICAgICAgbmFtZTogJ0NPVU5UJyxcbiAgICAgICAgYXJnczogWyBmaWVsZE5hbWUgfHwgJyonIF0sXG4gICAgICAgIGFsaWFzOiBhbGlhcyB8fCAnY291bnQnXG4gICAgfSk7IFxuICAgIG51bGxPcklzID0gKGZpZWxkTmFtZSwgdmFsdWUpID0+IFt7IFtmaWVsZE5hbWVdOiB7ICRleGlzdHM6IGZhbHNlIH0gfSwgeyBbZmllbGROYW1lXTogeyAkZXE6IHZhbHVlIH0gfV07XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBXZWFrU2V0KCk7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBpZiAodGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID4gMCkge1xuICAgICAgICAgICAgZm9yIChsZXQgY29ubiBvZiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRW5kIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMucG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMucG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuYWRkKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDb25uZWN0IHRvICR7Y3NLZXl9YCk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBEaXNjb25uZWN0IGZyb20gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGNvbnN0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBjb25zdCBpc29sYXRpb25MZXZlbCA9IF8uZmluZChNeVNRTENvbm5lY3Rvci5Jc29sYXRpb25MZXZlbHMsICh2YWx1ZSwga2V5KSA9PiBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSBrZXkgfHwgb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0gdmFsdWUpO1xuICAgICAgICAgICAgaWYgKCFpc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGlzb2xhdGlvbiBsZXZlbDogXCIke2lzb2xhdGlvbkxldmVsfVwiIVwiYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIFRSQU5TQUNUSU9OIElTT0xBVElPTiBMRVZFTCAnICsgaXNvbGF0aW9uTGV2ZWwpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgWyByZXQgXSA9IGF3YWl0IGNvbm4ucXVlcnkoJ1NFTEVDVCBAQGF1dG9jb21taXQ7Jyk7ICAgICAgICBcbiAgICAgICAgY29ubi4kJGF1dG9jb21taXQgPSByZXRbMF1bJ0BAYXV0b2NvbW1pdCddOyAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0wOycpO1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTVEFSVCBUUkFOU0FDVElPTjsnKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdDT01NSVQ7Jyk7ICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBgQ29tbWl0cyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdST0xMQkFDSzsnKTtcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBgUm9sbGJhY2tzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICBlcnIuaW5mbyB8fCAoZXJyLmluZm8gPSB7fSk7XG4gICAgICAgICAgICBlcnIuaW5mby5zcWwgPSBfLnRydW5jYXRlKHNxbCwgeyBsZW5ndGg6IDIwMCB9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnBhcmFtcyA9IHBhcmFtcztcblxuICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyBTRVQgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgb3IgdXBkYXRlIHRoZSBvbGQgb25lIGlmIGR1cGxpY2F0ZSBrZXkgZm91bmQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cHNlcnRPbmVfKG1vZGVsLCBkYXRhLCB1bmlxdWVLZXlzLCBvcHRpb25zLCBkYXRhT25JbnNlcnQpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGF0YVdpdGhvdXRVSyA9IF8ub21pdChkYXRhLCB1bmlxdWVLZXlzKTtcbiAgICAgICAgbGV0IGluc2VydERhdGEgPSB7IC4uLmRhdGEsIC4uLmRhdGFPbkluc2VydCB9O1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YVdpdGhvdXRVSykpIHtcbiAgICAgICAgICAgIC8vaWYgZHVwbGlhdGUsIGRvbnQgbmVlZCB0byB1cGRhdGVcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNyZWF0ZV8obW9kZWwsIGluc2VydERhdGEsIHsgLi4ub3B0aW9ucywgaW5zZXJ0SWdub3JlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgSU5UTyA/PyBTRVQgPyBPTiBEVVBMSUNBVEUgS0VZIFVQREFURSA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goaW5zZXJ0RGF0YSk7XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGFXaXRob3V0VUspO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgYXN5bmMgaW5zZXJ0TWFueV8obW9kZWwsIGZpZWxkcywgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZGF0YVwiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmRzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImZpZWxkc1wiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRldjoge1xuICAgICAgICAgICAgZGF0YS5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvdykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VsZW1lbnQgb2YgXCJkYXRhXCIgYXJyYXkgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZCB2YWx1ZXMuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gKCR7ZmllbGRzLm1hcChmID0+IHRoaXMuZXNjYXBlSWQoZikpLmpvaW4oJywgJyl9KSBWQUxVRVMgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGluc2VydE9uZV8gPSB0aGlzLmNyZWF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnlPcHRpb25zICBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwZGF0ZV8obW9kZWwsIGRhdGEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgIFxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdEYXRhIHJlY29yZCBpcyBlbXB0eS4nLCB7IG1vZGVsLCBxdWVyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zKSB8fCBoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgJyArIHRoaXMuX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkuam9pbignLCcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgPyc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB1cGRhdGVPbmVfID0gdGhpcy51cGRhdGVfO1xuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IGRlbGV0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIHF1ZXJ5LCBkZWxldGVPcHRpb25zLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF0sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAoZGVsZXRlT3B0aW9ucyAmJiBkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEEgRlJPTSA/PyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEZST00gPz8nO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgICAgICBcblxuICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS5tYXAobiA9PiAnOicgKyBuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgcmV0dXJuIFsgcmVzdWx0LCB0b3RhbENvdW50IF07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIHNxbCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiAgICAgIFxuICAgICAqL1xuICAgIGJ1aWxkUXVlcnkobW9kZWwsIHsgJHJlbGF0aW9uc2hpcHMsICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9KSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107ICAgICAgICBcblxuICAgICAgICAvLyBidWlsZCBhbGlhcyBtYXAgZmlyc3RcbiAgICAgICAgLy8gY2FjaGUgcGFyYW1zXG4gICAgICAgIGlmICgkcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJyonO1xuXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICAvLyBtb3ZlIGNhY2hlZCBqb2luaW5nIHBhcmFtcyBpbnRvIHBhcmFtc1xuICAgICAgICAvLyBzaG91bGQgYWNjb3JkaW5nIHRvIHRoZSBwbGFjZSBvZiBjbGF1c2UgaW4gYSBzcWwgICAgICAgIFxuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRvcmRlckJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRPcmRlckJ5KCRvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVzdWx0ID0geyBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwIH07ICAgICAgICBcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdC5jb3VudFNxbCA9IGBTRUxFQ1QgQ09VTlQoJHtjb3VudFN1YmplY3R9KSBBUyBjb3VudGAgKyBzcWw7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgPSAnU0VMRUNUICcgKyBzZWxlY3RDb2xvbW5zICsgc3FsOyAgICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCAxMDAwJztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnNxbCA9IHNxbDtcblxuICAgICAgICAvL2NvbnNvbGUuZGlyKHJlc3VsdCwgeyBkZXB0aDogMTAsIGNvbG9yczogdHJ1ZSB9KTsgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICAvL2NvbnNvbGUubG9nKCdhc3NvY2lhdGlvbnM6JywgT2JqZWN0LmtleXMoYXNzb2NpYXRpb25zKSk7XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7ICAgICAgICAgICAgIFxuICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHsgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY3MsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcgfHwga2V5LnN0YXJ0c1dpdGgoJyRhbmRfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmICgoa2V5ID09PSAnJGV4cHInIHx8IGtleS5zdGFydHNXaXRoKCckZXhwcl8nKSkgJiYgdmFsdWUub29yVHlwZSAmJiB2YWx1ZS5vb3JUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IG1haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFthbGlhc0tleV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKG1haW5FbnRpdHksIGFsaWFzS2V5LCBhbGlhc01hcCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9LiBQbGVhc2UgY2hlY2sgJGFzc29jaWF0aW9uIHZhbHVlLmA7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQobXNnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhc01hcFttYWluRW50aXR5XSArICcuJyArIChmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7ICAgXG5cbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGFwcGx5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFyZ3MgPSB2YWx1ZS5hcmdzID8gWyBmaWVsZE5hbWUgXS5jb25jYXQodmFsdWUuYXJncykgOiBbIGZpZWxkTmFtZSBdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpID0gJ1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRoYXMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnIHx8IHYuaW5kZXhPZignLCcpID49IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aXRob3V0IFwiLFwiIHdoZW4gdXNpbmcgXCIkaGFzXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGBGSU5EX0lOX1NFVCg/LCAke3RoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApfSkgPiAwYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgbGFzdERvdEluZGV4ID0gY29sLmFsaWFzLmxhc3RJbmRleE9mKCcuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gbGFzdERvdEluZGV4ID4gMCA/IGNvbC5hbGlhcy5zdWJzdHIobGFzdERvdEluZGV4KzEpIDogY29sLmFsaWFzO1xuXG4gICAgICAgICAgICAgICAgaWYgKGxhc3REb3RJbmRleCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYXNjYWRlIGFsaWFzIGlzIG5vdCBhbGxvd2VkIHdoZW4gdGhlIHF1ZXJ5IGhhcyBubyBhc3NvY2lhdGVkIGVudGl0eSBwb3B1bGF0ZWQuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBoYXNKb2luaW5nICsgJy4nICsgY29sLmFsaWFzLnN1YnN0cigwLCBsYXN0RG90SW5kZXgpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbGlhc1ByZWZpeCA9IGFsaWFzTWFwW2Z1bGxQYXRoXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhbGlhc1ByZWZpeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgSW52YWxpZCBjYXNjYWRlIGFsaWFzLiBcIiR7ZnVsbFBhdGh9XCIgbm90IGZvdW5kIGluIGFzc29jaWF0aW9ucy5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IGFsaWFzUHJlZml4ICsgJyQnICsgYWxpYXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmFtZSA9IGNvbC5uYW1lLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5hbWUgKyAnKCcgKyAoY29sLnByZWZpeCA/IGAke2NvbC5wcmVmaXgudG9VcHBlckNhc2UoKX0gYCA6IFwiXCIpICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
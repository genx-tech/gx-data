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

  async upsertOne_(model, data, uniqueKeys, options) {
    if (!data || _.isEmpty(data)) {
      throw new ApplicationError(`Creating with empty "${model}" data.`);
    }

    let dataWithUK = _.omit(data, uniqueKeys);

    if (_.isEmpty(dataWithUK)) {
      return this.create_(model, data, { ...options,
        insertIgnore: true
      });
    }

    let sql = `INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ?`;
    let params = [model];
    params.push(data);
    params.push(dataWithUK);
    return this.execute_(sql, params, restOptions);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwicXVlcnlDb3VudCIsImFsaWFzIiwiZmllbGROYW1lIiwidHlwZSIsIm5hbWUiLCJhcmdzIiwibnVsbE9ySXMiLCJ2YWx1ZSIsIiRleGlzdHMiLCIkZXEiLCJpbnNlcnRPbmVfIiwiY3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVfIiwicmVsYXRpb25hbCIsImFjaXR2ZUNvbm5lY3Rpb25zIiwiV2Vha1NldCIsImVuZF8iLCJzaXplIiwiY29ubiIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImxvZyIsImN1cnJlbnRDb25uZWN0aW9uU3RyaW5nIiwiZW5kIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwibWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsImFkZCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFXaXRoVUsiLCJvbWl0IiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwiZmluZF8iLCJjb25kaXRpb24iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwibiIsImNvbmNhdCIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCIkdG90YWxDb3VudCIsInNlbGVjdENvbG9tbnMiLCJfYnVpbGRDb2x1bW5zIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc0ludGVnZXIiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsIl9nZW5lcmF0ZUFsaWFzIiwiaW5kZXgiLCJhbmNob3IiLCJ2ZXJib3NlQWxpYXMiLCJzbmFrZUNhc2UiLCJ0b1VwcGVyQ2FzZSIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImFzc29jSW5mbyIsImpvaW5UeXBlIiwib24iLCJvdXRwdXQiLCJlbnRpdHkiLCJzdWJBc3NvY3MiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwiam9pbk9wZXJhdG9yIiwiYyIsImlzUGxhaW5PYmplY3QiLCJzdGFydHNXaXRoIiwibnVtT2ZFbGVtZW50IiwiT2JqZWN0Iiwia2V5cyIsIm9vclR5cGUiLCJsZWZ0IiwiX3BhY2tWYWx1ZSIsInJpZ2h0Iiwib3AiLCJfd3JhcENvbmRpdGlvbiIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwiY29uc29sZSIsIm1zZyIsInYiLCJpbmRleE9mIiwiX3BhY2tBcnJheSIsImFycmF5IiwiaW5qZWN0IiwiaXNOaWwiLCIkaW4iLCJoYXNPcGVyYXRvciIsImsiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwibGFzdERvdEluZGV4IiwibGFzdEluZGV4T2YiLCJzdWJzdHIiLCJmdWxsUGF0aCIsImFsaWFzUHJlZml4IiwicHJlZml4IiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXph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LFFBQXpDLEtBQXNEbUgsR0FBRyxLQUFLLEtBQVIsSUFBaUJBLEdBQUcsSUFBSSxJQUF4QixHQUErQixPQUEvQixHQUF5QyxFQUEvRixDQUE3QixFQUFpSXRILElBQWpJLENBQXNJLElBQXRJLENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJaEcsZ0JBQUosQ0FBc0IsNEJBQTJCbUwsSUFBSSxDQUFDQyxTQUFMLENBQWVpQyxPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxRQUFNdEosZUFBTixDQUFzQnZELE9BQXRCLEVBQStCO0FBQzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDK00sVUFBcEIsR0FBa0MvTSxPQUFPLENBQUMrTSxVQUExQyxHQUF1RCxLQUFLakwsUUFBTCxDQUFjOUIsT0FBZCxDQUE5RDtBQUNIOztBQUVELFFBQU1rRSxtQkFBTixDQUEwQjFDLElBQTFCLEVBQWdDeEIsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDK00sVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLdEwsV0FBTCxDQUFpQkQsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBNWtDa0M7O0FBQWpDM0IsYyxDQU1LZ0QsZSxHQUFrQnFILE1BQU0sQ0FBQzhDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQXlrQzdCdk4sY0FBYyxDQUFDd04sU0FBZixHQUEyQi9OLEtBQTNCO0FBRUFnTyxNQUFNLENBQUNDLE9BQVAsR0FBaUIxTixjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xpYicpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCB7IGlzUXVvdGVkLCBpc1ByaW1pdGl2ZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG4gICAgcXVlcnlDb3VudCA9IChhbGlhcywgZmllbGROYW1lKSA9PiAoe1xuICAgICAgICB0eXBlOiAnZnVuY3Rpb24nLFxuICAgICAgICBuYW1lOiAnQ09VTlQnLFxuICAgICAgICBhcmdzOiBbIGZpZWxkTmFtZSB8fCAnKicgXSxcbiAgICAgICAgYWxpYXM6IGFsaWFzIHx8ICdjb3VudCdcbiAgICB9KTsgXG4gICAgbnVsbE9ySXMgPSAoZmllbGROYW1lLCB2YWx1ZSkgPT4gW3sgW2ZpZWxkTmFtZV06IHsgJGV4aXN0czogZmFsc2UgfSB9LCB7IFtmaWVsZE5hbWVdOiB7ICRlcTogdmFsdWUgfSB9XTtcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIEZsYXQgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB0byBpbXByb3ZlIHF1ZXJ5IHBlcmZvcm1hbmNlLiBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLmxvZ1N0YXRlbWVudF0gLSBGbGFnIHRvIGxvZyBleGVjdXRlZCBTUUwgc3RhdGVtZW50LlxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLnJlbGF0aW9uYWwgPSB0cnVlO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IFdlYWtTZXQoKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGlmICh0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGlzLnBvb2wpIHtcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBFbmQgY29ubmVjdGlvbiBwb29sIHRvICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wb29sLmVuZCgpO1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMucG9vbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5tYWtlTmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgaWYgKGNzS2V5ICE9PSB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuZF8oKTtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmICghdGhpcy5wb29sKSB7ICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENyZWF0ZSBjb25uZWN0aW9uIHBvb2wgdG8gJHtjc0tleX1gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5wb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5wb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5hZGQoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENvbm5lY3QgdG8gJHtjc0tleX1gKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYERpc2Nvbm5lY3QgZnJvbSAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGNvbnN0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBbIHJldCBdID0gYXdhaXQgY29ubi5xdWVyeSgnU0VMRUNUIEBAYXV0b2NvbW1pdDsnKTsgICAgICAgIFxuICAgICAgICBjb25uLiQkYXV0b2NvbW1pdCA9IHJldFswXVsnQEBhdXRvY29tbWl0J107ICAgICAgICBcblxuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTA7Jyk7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NUQVJUIFRSQU5TQUNUSU9OOycpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ0NPTU1JVDsnKTsgICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBDb21taXRzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1JPTExCQUNLOycpO1xuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGBSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LiAgICAgXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIGVyci5pbmZvIHx8IChlcnIuaW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnNxbCA9IF8udHJ1bmNhdGUoc3FsLCB7IGxlbmd0aDogMjAwIH0pO1xuICAgICAgICAgICAgZXJyLmluZm8ucGFyYW1zID0gcGFyYW1zO1xuXG4gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSBvciB1cGRhdGUgdGhlIG9sZCBvbmUgaWYgZHVwbGljYXRlIGtleSBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwc2VydE9uZV8obW9kZWwsIGRhdGEsIHVuaXF1ZUtleXMsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGF0YVdpdGhVSyA9IF8ub21pdChkYXRhLCB1bmlxdWVLZXlzKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGFXaXRoVUspKSB7XG4gICAgICAgICAgICAvL2lmIGR1cGxpYXRlLCBkb250IG5lZWQgdG8gdXBkYXRlXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKG1vZGVsLCBkYXRhLCB7IC4uLm9wdGlvbnMsIGluc2VydElnbm9yZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUIElOVE8gPz8gU0VUID8gT04gRFVQTElDQVRFIEtFWSBVUERBVEUgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhV2l0aFVLKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBhc3luYyBpbnNlcnRNYW55Xyhtb2RlbCwgZmllbGRzLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJkYXRhXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZHMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZmllbGRzXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWVzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICBkYXRhLmZvckVhY2gocm93ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignRWxlbWVudCBvZiBcImRhdGFcIiBhcnJheSB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3JkIHZhbHVlcy4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMpIHx8IGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCAnICsgdGhpcy5fc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKS5qb2luKCcsJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCA/JztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHVwZGF0ZU9uZV8gPSB0aGlzLnVwZGF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gZGVsZXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgcXVlcnksIGRlbGV0ZU9wdGlvbnMsIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChkZWxldGVPcHRpb25zICYmIGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgQSBGUk9NID8/IEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9ICdERUxFVEUgRlJPTSA/Pyc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICAgICAgIFxuXG4gICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCBjb25kaXRpb24sIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pOyBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUFsaWFzKGluZGV4LCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChpbmRleCk7XG5cbiAgICAgICAgaWYgKHRoaXMub3B0aW9ucy52ZXJib3NlQWxpYXMpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnNuYWtlQ2FzZShhbmNob3IpLnRvVXBwZXJDYXNlKCkgKyAnXycgKyBhbGlhcztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGFzc29jaWF0aW9ucyBpbnRvIGpvaW5pbmcgY2xhdXNlcy5cbiAgICAgKiAge1xuICAgICAqICAgICAgZW50aXR5OiA8cmVtb3RlIGVudGl0eT5cbiAgICAgKiAgICAgIGpvaW5UeXBlOiAnTEVGVCBKT0lOfElOTkVSIEpPSU58RlVMTCBPVVRFUiBKT0lOJ1xuICAgICAqICAgICAgYW5jaG9yOiAnbG9jYWwgcHJvcGVydHkgdG8gcGxhY2UgdGhlIHJlbW90ZSBlbnRpdHknXG4gICAgICogICAgICBsb2NhbEZpZWxkOiA8bG9jYWwgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHJlbW90ZUZpZWxkOiA8cmVtb3RlIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICBzdWJBc3NvY2lhdGlvbnM6IHsgLi4uIH1cbiAgICAgKiAgfVxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NpYXRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXNLZXkgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhcyBcbiAgICAgKiBAcGFyYW0geyp9IGFsaWFzTWFwIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQXNzb2NpYXRpb25zKGFzc29jaWF0aW9ucywgcGFyZW50QWxpYXNLZXksIHBhcmVudEFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKSB7XG4gICAgICAgIGxldCBqb2luaW5ncyA9IFtdO1xuXG4gICAgICAgIC8vY29uc29sZS5sb2coJ2Fzc29jaWF0aW9uczonLCBPYmplY3Qua2V5cyhhc3NvY2lhdGlvbnMpKTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2cobWFpbkVudGl0eSwgYWxpYXNLZXksIGFsaWFzTWFwKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX0uIFBsZWFzZSBjaGVjayAkYXNzb2NpYXRpb24gdmFsdWUuYDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBfLm1hcChkYXRhLCAodiwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xLCAnQ29sdW1uIG9mIGRpcmVjdCBpbnB1dCBkYXRhIGNhbm5vdCBiZSBhIGRvdC1zZXBhcmF0ZWQgbmFtZS4nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnPScgKyB0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9wYWNrQXJyYXkoYXJyYXksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIGFycmF5Lm1hcCh2YWx1ZSA9PiB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsJyk7XG4gICAgfVxuXG4gICAgX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQ29sdW1uUmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyh2YWx1ZS5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnRnVuY3Rpb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyAodmFsdWUuYXJncyA/IHRoaXMuX3BhY2tBcnJheSh2YWx1ZS5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG5cbiAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvb3IgdHlwZTogJHt2YWx1ZS5vb3JUeXBlfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFsdWUgPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiAnPyc7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB7ICRpbjogdmFsdWUgfSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICh2ID8gJyBJUyBOT1QgTlVMTCcgOiAnSVMgTlVMTCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNQcmltaXRpdmUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJD49XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdFwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdGVcIiBvciBcIiQ8PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHtzcWxJbmZvLnNxbH0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5pbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckYXBwbHknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYXJncyA9IHZhbHVlLmFyZ3MgPyBbIGZpZWxkTmFtZSBdLmNvbmNhdCh2YWx1ZS5hcmdzKSA6IFsgZmllbGROYW1lIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJykgPSAnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGhhcyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycgfHwgdi5pbmRleE9mKCcsJykgPj0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdpdGhvdXQgXCIsXCIgd2hlbiB1c2luZyBcIiRoYXNcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYEZJTkRfSU5fU0VUKD8sICR7dGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9KSA+IDBgO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgcGFyYW1zLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaXNRdW90ZWQoY29sKSA/IGNvbCA6IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gY29sO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb2wpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcykge1xuICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBsYXN0RG90SW5kZXggPSBjb2wuYWxpYXMubGFzdEluZGV4T2YoJy4nKTtcbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBsYXN0RG90SW5kZXggPiAwID8gY29sLmFsaWFzLnN1YnN0cihsYXN0RG90SW5kZXgrMSkgOiBjb2wuYWxpYXM7XG5cbiAgICAgICAgICAgICAgICBpZiAobGFzdERvdEluZGV4ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhc2NhZGUgYWxpYXMgaXMgbm90IGFsbG93ZWQgd2hlbiB0aGUgcXVlcnkgaGFzIG5vIGFzc29jaWF0ZWQgZW50aXR5IHBvcHVsYXRlZC4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBmdWxsUGF0aCA9IGhhc0pvaW5pbmcgKyAnLicgKyBjb2wuYWxpYXMuc3Vic3RyKDAsIGxhc3REb3RJbmRleCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGFsaWFzUHJlZml4ID0gYWxpYXNNYXBbZnVsbFBhdGhdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWFsaWFzUHJlZml4KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBJbnZhbGlkIGNhc2NhZGUgYWxpYXMuIFwiJHtmdWxsUGF0aH1cIiBub3QgZm91bmQgaW4gYXNzb2NpYXRpb25zLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhczogY29sLmFsaWFzXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gYWxpYXNQcmVmaXggKyAnJCcgKyBhbGlhcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChhbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGxldCBuYW1lID0gY29sLm5hbWUudG9VcHBlckNhc2UoKTtcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ0NPVU5UJyAmJiBjb2wuYXJncy5sZW5ndGggPT09IDEgJiYgY29sLmFyZ3NbMF0gPT09ICcqJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ0NPVU5UKCopJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gbmFtZSArICcoJyArIChjb2wucHJlZml4ID8gYCR7Y29sLnByZWZpeC50b1VwcGVyQ2FzZSgpfSBgIDogXCJcIikgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdleHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbC5leHByLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPT09IGZhbHNlIHx8IGFzYyA9PSAnLTEnID8gJyBERVNDJyA6ICcnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbk15U1FMQ29ubmVjdG9yLmRyaXZlckxpYiA9IG15c3FsO1xuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==
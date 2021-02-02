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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCIkY2FsbCIsIiRhcyIsIm51bGxPcklzIiwiJGV4aXN0cyIsIiRlcSIsInVwZGF0ZWRDb3VudCIsImNvbnRleHQiLCJyZXN1bHQiLCJhZmZlY3RlZFJvd3MiLCJkZWxldGVkQ291bnQiLCJpbnNlcnRPbmVfIiwiY3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVfIiwicmVsYXRpb25hbCIsImFjaXR2ZUNvbm5lY3Rpb25zIiwiU2V0IiwiZW5kXyIsInNpemUiLCJjb25uIiwiZGlzY29ubmVjdF8iLCJwb29sIiwibG9nIiwiY3VycmVudENvbm5lY3Rpb25TdHJpbmciLCJlbmQiLCJjb25uZWN0XyIsImNzS2V5IiwiY29ublByb3BzIiwiY3JlYXRlRGF0YWJhc2UiLCJkYXRhYmFzZSIsInBpY2siLCJtYWtlTmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwiYWRkIiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwia2V5IiwicXVlcnkiLCJyZXQiLCIkJGF1dG9jb21taXQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiZXhlY3V0ZV8iLCJzcWwiLCJwYXJhbXMiLCJfZ2V0Q29ubmVjdGlvbl8iLCJ1c2VQcmVwYXJlZFN0YXRlbWVudCIsImxvZ1N0YXRlbWVudCIsInJvd3NBc0FycmF5IiwiZXhlY3V0ZSIsInJvd3MxIiwicm93czIiLCJlcnIiLCJpbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsInVwc2VydE9uZV8iLCJ1bmlxdWVLZXlzIiwiZGF0YU9uSW5zZXJ0IiwiZGF0YVdpdGhvdXRVSyIsIm9taXQiLCJpbnNlcnREYXRhIiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwiZmluZF8iLCJjb25kaXRpb24iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwiY29uY2F0IiwiJHNraXBPcm0iLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImpvaW5PcGVyYXRvciIsImMiLCJpc1BsYWluT2JqZWN0Iiwic3RhcnRzV2l0aCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsImtleXMiLCJvb3JUeXBlIiwibGVmdCIsIl9wYWNrVmFsdWUiLCJyaWdodCIsIm9wIiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsInYiLCJpbmRleE9mIiwiX3BhY2tBcnJheSIsImFycmF5IiwiaW5qZWN0IiwiaXNOaWwiLCIkaW4iLCJoYXNPcGVyYXRvciIsImsiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwibGFzdERvdEluZGV4IiwibGFzdEluZGV4T2YiLCJzdWJzdHIiLCJmdWxsUGF0aCIsImFsaWFzUHJlZml4IiwicHJlZml4IiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwiZHJpdmVyTGliIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsaUJBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBd0NMLE9BQU8sQ0FBQyxvQkFBRCxDQUFyRDs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLFFBQUY7QUFBWUMsRUFBQUE7QUFBWixJQUE0QlAsT0FBTyxDQUFDLGtCQUFELENBQXpDOztBQUNBLE1BQU1RLElBQUksR0FBR1IsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQU9BLE1BQU1TLGNBQU4sU0FBNkJOLFNBQTdCLENBQXVDO0FBaUNuQ08sRUFBQUEsUUFBUSxDQUFDQyxLQUFELEVBQVE7QUFDWixVQUFNQyxDQUFDLEdBQUcsT0FBT0QsS0FBakI7QUFFQSxRQUFJQyxDQUFDLEtBQUssU0FBVixFQUFxQixPQUFPRCxLQUFLLEdBQUcsQ0FBSCxHQUFPLENBQW5COztBQUVyQixRQUFJQyxDQUFDLEtBQUssUUFBVixFQUFvQjtBQUNoQixVQUFJRCxLQUFLLElBQUksSUFBVCxJQUFpQkEsS0FBSyxDQUFDRSxlQUEzQixFQUE0QztBQUN4QyxlQUFPRixLQUFLLENBQUNHLEtB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QyxPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXdFLG1CQUFOLENBQTBCMUMsSUFBMUIsRUFBZ0M5QixPQUFoQyxFQUF5QztBQUNyQyxRQUFJLENBQUNBLE9BQUQsSUFBWSxDQUFDQSxPQUFPLENBQUNtTixVQUF6QixFQUFxQztBQUNqQyxhQUFPLEtBQUtwTCxXQUFMLENBQWlCRCxJQUFqQixDQUFQO0FBQ0g7QUFDSjs7QUFwa0NrQzs7QUFBakN2QyxjLENBTUs0RCxlLEdBQWtCcUgsTUFBTSxDQUFDNEMsTUFBUCxDQUFjO0FBQ25DQyxFQUFBQSxjQUFjLEVBQUUsaUJBRG1CO0FBRW5DQyxFQUFBQSxhQUFhLEVBQUUsZ0JBRm9CO0FBR25DQyxFQUFBQSxlQUFlLEVBQUUsa0JBSGtCO0FBSW5DQyxFQUFBQSxZQUFZLEVBQUU7QUFKcUIsQ0FBZCxDO0FBaWtDN0JqTyxjQUFjLENBQUNrTyxTQUFmLEdBQTJCek8sS0FBM0I7QUFFQTBPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBPLGNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBzZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGliJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJyk7XG5jb25zdCBDb25uZWN0b3IgPSByZXF1aXJlKCcuLi8uLi9Db25uZWN0b3InKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcbiAgICBxdWVyeUNvdW50ID0gKGFsaWFzLCBmaWVsZE5hbWUpID0+ICh7XG4gICAgICAgIHR5cGU6ICdmdW5jdGlvbicsXG4gICAgICAgIG5hbWU6ICdDT1VOVCcsXG4gICAgICAgIGFyZ3M6IFsgZmllbGROYW1lIHx8ICcqJyBdLFxuICAgICAgICBhbGlhczogYWxpYXMgfHwgJ2NvdW50J1xuICAgIH0pOyBcblxuICAgICRjYWxsID0gKG5hbWUsIGFsaWFzLCBhcmdzKSA9PiAoeyB0eXBlOiAnZnVuY3Rpb24nLCBuYW1lLCBhbGlhcywgYXJncyB9KTtcbiAgICAkYXMgPSAobmFtZSwgYWxpYXMpID0+ICh7IHR5cGU6ICdjb2x1bW4nLCBuYW1lLCBhbGlhcyB9KTtcblxuICAgIC8vaW4gbXlzcWwsIG51bGwgdmFsdWUgY29tcGFyaXNvbiB3aWxsIG5ldmVyIHJldHVybiB0cnVlLCBldmVuIG51bGwgIT0gMVxuICAgIG51bGxPcklzID0gKGZpZWxkTmFtZSwgdmFsdWUpID0+IFt7IFtmaWVsZE5hbWVdOiB7ICRleGlzdHM6IGZhbHNlIH0gfSwgeyBbZmllbGROYW1lXTogeyAkZXE6IHZhbHVlIH0gfV07XG5cbiAgICB1cGRhdGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuICAgIGRlbGV0ZWRDb3VudCA9IChjb250ZXh0KSA9PiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3M7XG5cbiAgICB0eXBlQ2FzdCh2YWx1ZSkge1xuICAgICAgICBjb25zdCB0ID0gdHlwZW9mIHZhbHVlO1xuXG4gICAgICAgIGlmICh0ID09PSBcImJvb2xlYW5cIikgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSAhPSBudWxsICYmIHZhbHVlLmlzTHV4b25EYXRlVGltZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIEZsYXQgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB0byBpbXByb3ZlIHF1ZXJ5IHBlcmZvcm1hbmNlLiBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLmxvZ1N0YXRlbWVudF0gLSBGbGFnIHRvIGxvZyBleGVjdXRlZCBTUUwgc3RhdGVtZW50LlxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLnJlbGF0aW9uYWwgPSB0cnVlO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IFNldCgpO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgaWYgKHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5hY2l0dmVDb25uZWN0aW9ucykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPT09IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ2xvc2UgY29ubmVjdGlvbiBwb29sIHRvICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wb29sLmVuZCgpO1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMucG9vbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5tYWtlTmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgaWYgKGNzS2V5ICE9PSB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuZF8oKTtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmICghdGhpcy5wb29sKSB7ICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENyZWF0ZSBjb25uZWN0aW9uIHBvb2wgdG8gJHtjc0tleX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLnBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLnBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmFkZChjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ29ubmVjdCB0byAke2NzS2V5fWApO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRGlzY29ubmVjdCBmcm9tICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBjb25zdCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgY29uc3QgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IFsgcmV0IF0gPSBhd2FpdCBjb25uLnF1ZXJ5KCdTRUxFQ1QgQEBhdXRvY29tbWl0OycpOyAgICAgICAgXG4gICAgICAgIGNvbm4uJCRhdXRvY29tbWl0ID0gcmV0WzBdWydAQGF1dG9jb21taXQnXTsgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MDsnKTtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU1RBUlQgVFJBTlNBQ1RJT047Jyk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnQ09NTUlUOycpOyAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYENvbW1pdHMgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnUk9MTEJBQ0s7Jyk7XG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYFJvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuICAgICBcbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmluZm8gfHwgKGVyci5pbmZvID0ge30pO1xuICAgICAgICAgICAgZXJyLmluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuaW5mby5wYXJhbXMgPSBwYXJhbXM7XG5cbiAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gU0VUID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IG9yIHVwZGF0ZSB0aGUgb2xkIG9uZSBpZiBkdXBsaWNhdGUga2V5IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBzZXJ0T25lXyhtb2RlbCwgZGF0YSwgdW5pcXVlS2V5cywgb3B0aW9ucywgZGF0YU9uSW5zZXJ0KSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRhdGFXaXRob3V0VUsgPSBfLm9taXQoZGF0YSwgdW5pcXVlS2V5cyk7XG4gICAgICAgIGxldCBpbnNlcnREYXRhID0geyAuLi5kYXRhLCAuLi5kYXRhT25JbnNlcnQgfTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGFXaXRob3V0VUspKSB7XG4gICAgICAgICAgICAvL2lmIGR1cGxpYXRlLCBkb250IG5lZWQgdG8gdXBkYXRlXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKG1vZGVsLCBpbnNlcnREYXRhLCB7IC4uLm9wdGlvbnMsIGluc2VydElnbm9yZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUIElOVE8gPz8gU0VUID8gT04gRFVQTElDQVRFIEtFWSBVUERBVEUgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGluc2VydERhdGEpO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhV2l0aG91dFVLKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGFzeW5jIGluc2VydE1hbnlfKG1vZGVsLCBmaWVsZHMsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImRhdGFcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3Jkcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJmaWVsZHNcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgZmllbGQgbmFtZXMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgIGRhdGEuZm9yRWFjaChyb3cgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyb3cpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFbGVtZW50IG9mIFwiZGF0YVwiIGFycmF5IHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmQgdmFsdWVzLicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/ICgke2ZpZWxkcy5tYXAoZiA9PiB0aGlzLmVzY2FwZUlkKGYpKS5qb2luKCcsICcpfSkgVkFMVUVTID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBpbnNlcnRPbmVfID0gdGhpcy5jcmVhdGVfO1xuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5T3B0aW9ucyAgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICBcbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRGF0YSByZWNvcmQgaXMgZW1wdHkuJywgeyBtb2RlbCwgcXVlcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykgfHwgaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBkZWxldGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBxdWVyeSwgZGVsZXRlT3B0aW9ucywgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKGRlbGV0ZU9wdGlvbnMgJiYgZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBBIEZST00gPz8gQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBGUk9NID8/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgICBcbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCBjb25kaXRpb24sIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLyoubWFwKG4gPT4gJzonICsgbikgY2hhbmdlZCB0byBiZSBwYWRkaW5nIGJ5IG9ybSBhbmQgY2FuIGJlIGN1c3RvbWl6ZWQgd2l0aCBvdGhlciBrZXkgZ2V0dGVyICovO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25kaXRpb24uJHNraXBPcm0pIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBDb2x1bW4gcmVmZXJlbmNlIFwiJHtmaWVsZE5hbWV9XCIgbm90IGZvdW5kIGluIHBvcHVsYXRlZCBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG1haW5FbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzOiBhbGlhc0tleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgKGFjdHVhbEZpZWxkTmFtZSA9PT0gJyonID8gJyonIDogbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyAoZmllbGROYW1lID09PSAnKicgPyAnKicgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgeyAgIFxuXG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gKGZpZWxkTmFtZSA9PT0gJyonKSA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDw9JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaGFzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJyB8fCB2LmluZGV4T2YoJywnKSA+PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2l0aG91dCBcIixcIiB3aGVuIHVzaW5nIFwiJGhhc1wiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBgRklORF9JTl9TRVQoPywgJHt0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX0pID4gMGA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICBwYXJhbXMucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFsdWUgPSB0aGlzLnR5cGVDYXN0KHZhbHVlKTtcblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgbGFzdERvdEluZGV4ID0gY29sLmFsaWFzLmxhc3RJbmRleE9mKCcuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gbGFzdERvdEluZGV4ID4gMCA/IGNvbC5hbGlhcy5zdWJzdHIobGFzdERvdEluZGV4KzEpIDogY29sLmFsaWFzO1xuXG4gICAgICAgICAgICAgICAgaWYgKGxhc3REb3RJbmRleCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYXNjYWRlIGFsaWFzIGlzIG5vdCBhbGxvd2VkIHdoZW4gdGhlIHF1ZXJ5IGhhcyBubyBhc3NvY2lhdGVkIGVudGl0eSBwb3B1bGF0ZWQuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBoYXNKb2luaW5nICsgJy4nICsgY29sLmFsaWFzLnN1YnN0cigwLCBsYXN0RG90SW5kZXgpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbGlhc1ByZWZpeCA9IGFsaWFzTWFwW2Z1bGxQYXRoXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhbGlhc1ByZWZpeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgSW52YWxpZCBjYXNjYWRlIGFsaWFzLiBcIiR7ZnVsbFBhdGh9XCIgbm90IGZvdW5kIGluIGFzc29jaWF0aW9ucy5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IGFsaWFzUHJlZml4ICsgJyQnICsgYWxpYXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmFtZSA9IGNvbC5uYW1lLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5hbWUgKyAnKCcgKyAoY29sLnByZWZpeCA/IGAke2NvbC5wcmVmaXgudG9VcHBlckNhc2UoKX0gYCA6IFwiXCIpICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2NvbHVtbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPT09IGZhbHNlIHx8IGFzYyA9PSAnLTEnID8gJyBERVNDJyA6ICcnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbk15U1FMQ29ubmVjdG9yLmRyaXZlckxpYiA9IG15c3FsO1xuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==
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
    if (typeof groupBy === 'string') return 'GROUP BY ' + this._buildColumn(groupBy, params, hasJoining, aliasMap);
    if (Array.isArray(groupBy)) return 'GROUP BY ' + this._buildColumns(groupBy, params, hasJoining, aliasMap);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCIkY2FsbCIsIiRhcyIsIm51bGxPcklzIiwiJGV4aXN0cyIsIiRlcSIsInVwZGF0ZWRDb3VudCIsImNvbnRleHQiLCJyZXN1bHQiLCJhZmZlY3RlZFJvd3MiLCJkZWxldGVkQ291bnQiLCJpbnNlcnRPbmVfIiwiY3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVfIiwicmVsYXRpb25hbCIsImFjaXR2ZUNvbm5lY3Rpb25zIiwiU2V0IiwiZW5kXyIsInNpemUiLCJjb25uIiwiZGlzY29ubmVjdF8iLCJwb29sIiwibG9nIiwiY3VycmVudENvbm5lY3Rpb25TdHJpbmciLCJlbmQiLCJjb25uZWN0XyIsImNzS2V5IiwiY29ublByb3BzIiwiY3JlYXRlRGF0YWJhc2UiLCJkYXRhYmFzZSIsInBpY2siLCJtYWtlTmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwiYWRkIiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwia2V5IiwicXVlcnkiLCJyZXQiLCIkJGF1dG9jb21taXQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiZXhlY3V0ZV8iLCJzcWwiLCJwYXJhbXMiLCJfZ2V0Q29ubmVjdGlvbl8iLCJ1c2VQcmVwYXJlZFN0YXRlbWVudCIsImxvZ1N0YXRlbWVudCIsInJvd3NBc0FycmF5IiwiZXhlY3V0ZSIsInJvd3MxIiwicm93czIiLCJlcnIiLCJpbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsInVwc2VydE9uZV8iLCJ1bmlxdWVLZXlzIiwiZGF0YU9uSW5zZXJ0IiwiZGF0YVdpdGhvdXRVSyIsIm9taXQiLCJpbnNlcnREYXRhIiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwiZmluZF8iLCJjb25kaXRpb24iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwiY29uY2F0IiwiJHNraXBPcm0iLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImpvaW5PcGVyYXRvciIsImMiLCJpc1BsYWluT2JqZWN0Iiwic3RhcnRzV2l0aCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsImtleXMiLCJvb3JUeXBlIiwibGVmdCIsIl9wYWNrVmFsdWUiLCJyaWdodCIsIm9wIiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsInYiLCJpbmRleE9mIiwiX3BhY2tBcnJheSIsImFycmF5IiwiaW5qZWN0IiwiaXNOaWwiLCIkaW4iLCJoYXNPcGVyYXRvciIsImsiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwibGFzdERvdEluZGV4IiwibGFzdEluZGV4T2YiLCJzdWJzdHIiLCJmdWxsUGF0aCIsImFsaWFzUHJlZml4IiwicHJlZml4IiwiZXhwciIsImdyb3VwQnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwiZHJpdmVyTGliIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsaUJBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBd0NMLE9BQU8sQ0FBQyxvQkFBRCxDQUFyRDs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLFFBQUY7QUFBWUMsRUFBQUE7QUFBWixJQUE0QlAsT0FBTyxDQUFDLGtCQUFELENBQXpDOztBQUNBLE1BQU1RLElBQUksR0FBR1IsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQU9BLE1BQU1TLGNBQU4sU0FBNkJOLFNBQTdCLENBQXVDO0FBaUNuQ08sRUFBQUEsUUFBUSxDQUFDQyxLQUFELEVBQVE7QUFDWixVQUFNQyxDQUFDLEdBQUcsT0FBT0QsS0FBakI7QUFFQSxRQUFJQyxDQUFDLEtBQUssU0FBVixFQUFxQixPQUFPRCxLQUFLLEdBQUcsQ0FBSCxHQUFPLENBQW5COztBQUVyQixRQUFJQyxDQUFDLEtBQUssUUFBVixFQUFvQjtBQUNoQixVQUFJRCxLQUFLLElBQUksSUFBVCxJQUFpQkEsS0FBSyxDQUFDRSxlQUEzQixFQUE0QztBQUN4QyxlQUFPRixLQUFLLENBQUNHLEtB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QzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDbU4sVUFBcEIsR0FBa0NuTixPQUFPLENBQUNtTixVQUExQyxHQUF1RCxLQUFLL0ssUUFBTCxDQUFjcEMsT0FBZCxDQUE5RDtBQUNIOztBQUV3QixRQUFuQndFLG1CQUFtQixDQUFDMUMsSUFBRCxFQUFPOUIsT0FBUCxFQUFnQjtBQUNyQyxRQUFJLENBQUNBLE9BQUQsSUFBWSxDQUFDQSxPQUFPLENBQUNtTixVQUF6QixFQUFxQztBQUNqQyxhQUFPLEtBQUtwTCxXQUFMLENBQWlCRCxJQUFqQixDQUFQO0FBQ0g7QUFDSjs7QUEvakNrQzs7QUFBakN2QyxjLENBTUs0RCxlLEdBQWtCcUgsTUFBTSxDQUFDNEMsTUFBUCxDQUFjO0FBQ25DQyxFQUFBQSxjQUFjLEVBQUUsaUJBRG1CO0FBRW5DQyxFQUFBQSxhQUFhLEVBQUUsZ0JBRm9CO0FBR25DQyxFQUFBQSxlQUFlLEVBQUUsa0JBSGtCO0FBSW5DQyxFQUFBQSxZQUFZLEVBQUU7QUFKcUIsQ0FBZCxDO0FBNGpDN0JqTyxjQUFjLENBQUNrTyxTQUFmLEdBQTJCek8sS0FBM0I7QUFFQTBPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBPLGNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBzZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGliJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJyk7XG5jb25zdCBDb25uZWN0b3IgPSByZXF1aXJlKCcuLi8uLi9Db25uZWN0b3InKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcbiAgICBxdWVyeUNvdW50ID0gKGFsaWFzLCBmaWVsZE5hbWUpID0+ICh7XG4gICAgICAgIHR5cGU6ICdmdW5jdGlvbicsXG4gICAgICAgIG5hbWU6ICdDT1VOVCcsXG4gICAgICAgIGFyZ3M6IFsgZmllbGROYW1lIHx8ICcqJyBdLFxuICAgICAgICBhbGlhczogYWxpYXMgfHwgJ2NvdW50J1xuICAgIH0pOyBcblxuICAgICRjYWxsID0gKG5hbWUsIGFsaWFzLCBhcmdzKSA9PiAoeyB0eXBlOiAnZnVuY3Rpb24nLCBuYW1lLCBhbGlhcywgYXJncyB9KTtcbiAgICAkYXMgPSAobmFtZSwgYWxpYXMpID0+ICh7IHR5cGU6ICdjb2x1bW4nLCBuYW1lLCBhbGlhcyB9KTtcblxuICAgIC8vaW4gbXlzcWwsIG51bGwgdmFsdWUgY29tcGFyaXNvbiB3aWxsIG5ldmVyIHJldHVybiB0cnVlLCBldmVuIG51bGwgIT0gMVxuICAgIG51bGxPcklzID0gKGZpZWxkTmFtZSwgdmFsdWUpID0+IFt7IFtmaWVsZE5hbWVdOiB7ICRleGlzdHM6IGZhbHNlIH0gfSwgeyBbZmllbGROYW1lXTogeyAkZXE6IHZhbHVlIH0gfV07XG5cbiAgICB1cGRhdGVkQ291bnQgPSAoY29udGV4dCkgPT4gY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzO1xuICAgIGRlbGV0ZWRDb3VudCA9IChjb250ZXh0KSA9PiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3M7XG5cbiAgICB0eXBlQ2FzdCh2YWx1ZSkge1xuICAgICAgICBjb25zdCB0ID0gdHlwZW9mIHZhbHVlO1xuXG4gICAgICAgIGlmICh0ID09PSBcImJvb2xlYW5cIikgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSAhPSBudWxsICYmIHZhbHVlLmlzTHV4b25EYXRlVGltZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIEZsYXQgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB0byBpbXByb3ZlIHF1ZXJ5IHBlcmZvcm1hbmNlLiBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLmxvZ1N0YXRlbWVudF0gLSBGbGFnIHRvIGxvZyBleGVjdXRlZCBTUUwgc3RhdGVtZW50LlxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLnJlbGF0aW9uYWwgPSB0cnVlO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IFNldCgpO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgaWYgKHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5hY2l0dmVDb25uZWN0aW9ucykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPT09IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ2xvc2UgY29ubmVjdGlvbiBwb29sIHRvICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wb29sLmVuZCgpO1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMucG9vbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5tYWtlTmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgaWYgKGNzS2V5ICE9PSB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuZF8oKTtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmICghdGhpcy5wb29sKSB7ICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENyZWF0ZSBjb25uZWN0aW9uIHBvb2wgdG8gJHtjc0tleX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLnBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLnBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmFkZChjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ29ubmVjdCB0byAke2NzS2V5fWApO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRGlzY29ubmVjdCBmcm9tICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBjb25zdCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgY29uc3QgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IFsgcmV0IF0gPSBhd2FpdCBjb25uLnF1ZXJ5KCdTRUxFQ1QgQEBhdXRvY29tbWl0OycpOyAgICAgICAgXG4gICAgICAgIGNvbm4uJCRhdXRvY29tbWl0ID0gcmV0WzBdWydAQGF1dG9jb21taXQnXTsgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MDsnKTtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU1RBUlQgVFJBTlNBQ1RJT047Jyk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnQ09NTUlUOycpOyAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYENvbW1pdHMgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnUk9MTEJBQ0s7Jyk7XG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYFJvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuICAgICBcbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmluZm8gfHwgKGVyci5pbmZvID0ge30pO1xuICAgICAgICAgICAgZXJyLmluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuaW5mby5wYXJhbXMgPSBwYXJhbXM7XG5cbiAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gU0VUID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IG9yIHVwZGF0ZSB0aGUgb2xkIG9uZSBpZiBkdXBsaWNhdGUga2V5IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBzZXJ0T25lXyhtb2RlbCwgZGF0YSwgdW5pcXVlS2V5cywgb3B0aW9ucywgZGF0YU9uSW5zZXJ0KSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRhdGFXaXRob3V0VUsgPSBfLm9taXQoZGF0YSwgdW5pcXVlS2V5cyk7XG4gICAgICAgIGxldCBpbnNlcnREYXRhID0geyAuLi5kYXRhLCAuLi5kYXRhT25JbnNlcnQgfTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGFXaXRob3V0VUspKSB7XG4gICAgICAgICAgICAvL2lmIGR1cGxpYXRlLCBkb250IG5lZWQgdG8gdXBkYXRlXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKG1vZGVsLCBpbnNlcnREYXRhLCB7IC4uLm9wdGlvbnMsIGluc2VydElnbm9yZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUIElOVE8gPz8gU0VUID8gT04gRFVQTElDQVRFIEtFWSBVUERBVEUgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGluc2VydERhdGEpO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhV2l0aG91dFVLKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGFzeW5jIGluc2VydE1hbnlfKG1vZGVsLCBmaWVsZHMsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImRhdGFcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3Jkcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJmaWVsZHNcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgZmllbGQgbmFtZXMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgIGRhdGEuZm9yRWFjaChyb3cgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyb3cpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFbGVtZW50IG9mIFwiZGF0YVwiIGFycmF5IHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmQgdmFsdWVzLicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/ICgke2ZpZWxkcy5tYXAoZiA9PiB0aGlzLmVzY2FwZUlkKGYpKS5qb2luKCcsICcpfSkgVkFMVUVTID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBpbnNlcnRPbmVfID0gdGhpcy5jcmVhdGVfO1xuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5T3B0aW9ucyAgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICBcbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRGF0YSByZWNvcmQgaXMgZW1wdHkuJywgeyBtb2RlbCwgcXVlcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykgfHwgaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBkZWxldGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBxdWVyeSwgZGVsZXRlT3B0aW9ucywgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKGRlbGV0ZU9wdGlvbnMgJiYgZGVsZXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBBIEZST00gPz8gQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gJ0RFTEVURSBGUk9NID8/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgICBcbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCBjb25kaXRpb24sIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLyoubWFwKG4gPT4gJzonICsgbikgY2hhbmdlZCB0byBiZSBwYWRkaW5nIGJ5IG9ybSBhbmQgY2FuIGJlIGN1c3RvbWl6ZWQgd2l0aCBvdGhlciBrZXkgZ2V0dGVyICovO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25kaXRpb24uJHNraXBPcm0pIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkgeyAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7ICAgICAgICAgICAgIFxuICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHsgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY3MsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcgfHwga2V5LnN0YXJ0c1dpdGgoJyRhbmRfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmICgoa2V5ID09PSAnJGV4cHInIHx8IGtleS5zdGFydHNXaXRoKCckZXhwcl8nKSkgJiYgdmFsdWUub29yVHlwZSAmJiB2YWx1ZS5vb3JUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IG1haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFthbGlhc0tleV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgQ29sdW1uIHJlZmVyZW5jZSBcIiR7ZmllbGROYW1lfVwiIG5vdCBmb3VuZCBpbiBwb3B1bGF0ZWQgYXNzb2NpYXRpb25zLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBtYWluRW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhczogYWxpYXNLZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIChhY3R1YWxGaWVsZE5hbWUgPT09ICcqJyA/ICcqJyA6IG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gJyonIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIChmaWVsZE5hbWUgPT09ICcqJykgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIF9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwKGRhdGEsICh2LCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGROYW1lLmluZGV4T2YoJy4nKSA9PT0gLTEsICdDb2x1bW4gb2YgZGlyZWN0IGlucHV0IGRhdGEgY2Fubm90IGJlIGEgZG90LXNlcGFyYXRlZCBuYW1lLic7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICc9JyArIHRoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX3BhY2tBcnJheShhcnJheSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gYXJyYXkubWFwKHZhbHVlID0+IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywnKTtcbiAgICB9XG5cbiAgICBfcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHN3aXRjaCAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdDb2x1bW5SZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdGdW5jdGlvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubmFtZSArICcoJyArICh2YWx1ZS5hcmdzID8gdGhpcy5fcGFja0FycmF5KHZhbHVlLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcblxuICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9vciB0eXBlOiAke3ZhbHVlLm9vclR5cGV9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YWx1ZSA9IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuICc/JztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHsgJGluOiB2YWx1ZSB9LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGhhc09wZXJhdG9yID0gXy5maW5kKE9iamVjdC5rZXlzKHZhbHVlKSwgayA9PiBrICYmIGtbMF0gPT09ICckJyk7XG5cbiAgICAgICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiBfLm1hcCh2YWx1ZSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGsgJiYga1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvcGVyYXRvclxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKHYgPyAnIElTIE5PVCBOVUxMJyA6ICdJUyBOVUxMJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIDw+ICR7dGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApfWA7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzogICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgID4gJHt0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9YDtcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzogICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSB0aGlzLnR5cGVDYXN0KHYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgPj0gJHt0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9YDtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIDwgJHt0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9YDtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCA8PSAke3RoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX1gO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodikgJiYgdi5vb3JUeXBlID09PSAnRGF0YVNldCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeSh2Lm1vZGVsLCB2LnF1ZXJ5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEluZm8ucGFyYW1zICYmIHNxbEluZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3NxbEluZm8uc3FsfSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgeyAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaGFzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJyB8fCB2LmluZGV4T2YoJywnKSA+PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2l0aG91dCBcIixcIiB3aGVuIHVzaW5nIFwiJGhhc1wiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBgRklORF9JTl9TRVQoPywgJHt0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX0pID4gMGA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICBwYXJhbXMucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFsdWUgPSB0aGlzLnR5cGVDYXN0KHZhbHVlKTtcblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgbGFzdERvdEluZGV4ID0gY29sLmFsaWFzLmxhc3RJbmRleE9mKCcuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gbGFzdERvdEluZGV4ID4gMCA/IGNvbC5hbGlhcy5zdWJzdHIobGFzdERvdEluZGV4KzEpIDogY29sLmFsaWFzO1xuXG4gICAgICAgICAgICAgICAgaWYgKGxhc3REb3RJbmRleCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYXNjYWRlIGFsaWFzIGlzIG5vdCBhbGxvd2VkIHdoZW4gdGhlIHF1ZXJ5IGhhcyBubyBhc3NvY2lhdGVkIGVudGl0eSBwb3B1bGF0ZWQuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWFzOiBjb2wuYWxpYXNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBoYXNKb2luaW5nICsgJy4nICsgY29sLmFsaWFzLnN1YnN0cigwLCBsYXN0RG90SW5kZXgpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbGlhc1ByZWZpeCA9IGFsaWFzTWFwW2Z1bGxQYXRoXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhbGlhc1ByZWZpeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgSW52YWxpZCBjYXNjYWRlIGFsaWFzLiBcIiR7ZnVsbFBhdGh9XCIgbm90IGZvdW5kIGluIGFzc29jaWF0aW9ucy5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IGFsaWFzUHJlZml4ICsgJyQnICsgYWxpYXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmFtZSA9IGNvbC5uYW1lLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5hbWUgKyAnKCcgKyAoY29sLnByZWZpeCA/IGAke2NvbC5wcmVmaXgudG9VcHBlckNhc2UoKX0gYCA6IFwiXCIpICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2NvbHVtbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9idWlsZENvbHVtbihncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fYnVpbGRDb2x1bW5zKGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
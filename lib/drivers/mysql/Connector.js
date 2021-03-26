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
      console.log($query);

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

        console.log('_wrapCondition', value);
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
        console.log('oorType', value);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwidHlwZUNhc3QiLCJ2YWx1ZSIsInQiLCJpc0x1eG9uRGF0ZVRpbWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJjb25zdHJ1Y3RvciIsImNvbm5lY3Rpb25TdHJpbmciLCJvcHRpb25zIiwiZXNjYXBlIiwiZXNjYXBlSWQiLCJmb3JtYXQiLCJyYXciLCJxdWVyeUNvdW50IiwiYWxpYXMiLCJmaWVsZE5hbWUiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCIkY2FsbCIsIiRhcyIsIm51bGxPcklzIiwiJGV4aXN0cyIsIiRlcSIsInVwZGF0ZWRDb3VudCIsImNvbnRleHQiLCJyZXN1bHQiLCJhZmZlY3RlZFJvd3MiLCJkZWxldGVkQ291bnQiLCJpbnNlcnRPbmVfIiwiY3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVfIiwicmVsYXRpb25hbCIsImFjaXR2ZUNvbm5lY3Rpb25zIiwiU2V0IiwiZW5kXyIsInNpemUiLCJjb25uIiwiZGlzY29ubmVjdF8iLCJwb29sIiwibG9nIiwiY3VycmVudENvbm5lY3Rpb25TdHJpbmciLCJlbmQiLCJjb25uZWN0XyIsImNzS2V5IiwiY29ublByb3BzIiwiY3JlYXRlRGF0YWJhc2UiLCJkYXRhYmFzZSIsInBpY2siLCJtYWtlTmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwiYWRkIiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwia2V5IiwicXVlcnkiLCJyZXQiLCIkJGF1dG9jb21taXQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiZXhlY3V0ZV8iLCJzcWwiLCJwYXJhbXMiLCJfZ2V0Q29ubmVjdGlvbl8iLCJ1c2VQcmVwYXJlZFN0YXRlbWVudCIsImxvZ1N0YXRlbWVudCIsInJvd3NBc0FycmF5IiwiZXhlY3V0ZSIsInJvd3MxIiwicm93czIiLCJlcnIiLCJpbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsInVwc2VydE9uZV8iLCJ1bmlxdWVLZXlzIiwiZGF0YU9uSW5zZXJ0IiwiZGF0YVdpdGhvdXRVSyIsIm9taXQiLCJpbnNlcnREYXRhIiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwiZmluZF8iLCJjb25kaXRpb24iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwiY29uY2F0IiwiJHNraXBPcm0iLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsImNvbnNvbGUiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsImxhc3REb3RJbmRleCIsImxhc3RJbmRleE9mIiwic3Vic3RyIiwiZnVsbFBhdGgiLCJhbGlhc1ByZWZpeCIsInByZWZpeCIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGlCQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXdDTCxPQUFPLENBQUMsb0JBQUQsQ0FBckQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxrQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQWlDbkNPLEVBQUFBLFFBQVEsQ0FBQ0MsS0FBRCxFQUFRO0FBQ1osVUFBTUMsQ0FBQyxHQUFHLE9BQU9ELEtBQWpCO0FBRUEsUUFBSUMsQ0FBQyxLQUFLLFNBQVYsRUFBcUIsT0FBT0QsS0FBSyxHQUFHLENBQUgsR0FBTyxDQUFuQjs7QUFFckIsUUFBSUMsQ0FBQyxLQUFLLFFBQVYsRUFBb0I7QUFDaEIsVUFBSUQsS0FBSyxJQUFJLElBQVQsSUFBaUJBLEtBQUssQ0FBQ0UsZUFBM0IsRUFBNEM7QUFDeEMsZUFBT0YsS0FB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QyxLQUFzRGlILEdBQUcsS0FBSyxLQUFSLElBQWlCQSxHQUFHLElBQUksSUFBeEIsR0FBK0IsT0FBL0IsR0FBeUMsRUFBL0YsQ0FBN0IsRUFBaUlwSCxJQUFqSSxDQUFzSSxJQUF0SSxDQUFyQjtBQUNIOztBQUVELFVBQU0sSUFBSTdHLGdCQUFKLENBQXNCLDRCQUEyQmdNLElBQUksQ0FBQ0MsU0FBTCxDQUFlK0IsT0FBZixDQUF3QixFQUF6RSxDQUFOO0FBQ0g7O0FBRUQsUUFBTXJKLGVBQU4sQ0FBc0I3RCxPQUF0QixFQUErQjtBQUMzQixXQUFRQSxPQUFPLElBQUlBLE9BQU8sQ0FBQ29OLFVBQXBCLEdBQWtDcE4sT0FBTyxDQUFDb04sVUFBMUMsR0FBdUQsS0FBS2hMLFFBQUwsQ0FBY3BDLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNd0UsbUJBQU4sQ0FBMEIxQyxJQUExQixFQUFnQzlCLE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQ29OLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS3JMLFdBQUwsQ0FBaUJELElBQWpCLENBQVA7QUFDSDtBQUNKOztBQW5rQ2tDOztBQUFqQ3ZDLGMsQ0FNSzRELGUsR0FBa0JzSCxNQUFNLENBQUM0QyxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUFna0M3QmxPLGNBQWMsQ0FBQ21PLFNBQWYsR0FBMkIxTyxLQUEzQjtBQUVBMk8sTUFBTSxDQUFDQyxPQUFQLEdBQWlCck8sY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9saWInKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuICAgIHF1ZXJ5Q291bnQgPSAoYWxpYXMsIGZpZWxkTmFtZSkgPT4gKHtcbiAgICAgICAgdHlwZTogJ2Z1bmN0aW9uJyxcbiAgICAgICAgbmFtZTogJ0NPVU5UJyxcbiAgICAgICAgYXJnczogWyBmaWVsZE5hbWUgfHwgJyonIF0sXG4gICAgICAgIGFsaWFzOiBhbGlhcyB8fCAnY291bnQnXG4gICAgfSk7IFxuXG4gICAgJGNhbGwgPSAobmFtZSwgYWxpYXMsIGFyZ3MpID0+ICh7IHR5cGU6ICdmdW5jdGlvbicsIG5hbWUsIGFsaWFzLCBhcmdzIH0pO1xuICAgICRhcyA9IChuYW1lLCBhbGlhcykgPT4gKHsgdHlwZTogJ2NvbHVtbicsIG5hbWUsIGFsaWFzIH0pO1xuXG4gICAgLy9pbiBteXNxbCwgbnVsbCB2YWx1ZSBjb21wYXJpc29uIHdpbGwgbmV2ZXIgcmV0dXJuIHRydWUsIGV2ZW4gbnVsbCAhPSAxXG4gICAgbnVsbE9ySXMgPSAoZmllbGROYW1lLCB2YWx1ZSkgPT4gW3sgW2ZpZWxkTmFtZV06IHsgJGV4aXN0czogZmFsc2UgfSB9LCB7IFtmaWVsZE5hbWVdOiB7ICRlcTogdmFsdWUgfSB9XTtcblxuICAgIHVwZGF0ZWRDb3VudCA9IChjb250ZXh0KSA9PiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3M7XG4gICAgZGVsZXRlZENvdW50ID0gKGNvbnRleHQpID0+IGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cztcblxuICAgIHR5cGVDYXN0KHZhbHVlKSB7XG4gICAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdmFsdWU7XG5cbiAgICAgICAgaWYgKHQgPT09IFwiYm9vbGVhblwiKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgaWYgKHZhbHVlICE9IG51bGwgJiYgdmFsdWUuaXNMdXhvbkRhdGVUaW1lKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gRmxhdCB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHRvIGltcHJvdmUgcXVlcnkgcGVyZm9ybWFuY2UuIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMubG9nU3RhdGVtZW50XSAtIEZsYWcgdG8gbG9nIGV4ZWN1dGVkIFNRTCBzdGF0ZW1lbnQuXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMucmVsYXRpb25hbCA9IHRydWU7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMgPSBuZXcgU2V0KCk7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBpZiAodGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID4gMCkge1xuICAgICAgICAgICAgZm9yIChsZXQgY29ubiBvZiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA9PT0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGlzLnBvb2wpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDbG9zZSBjb25uZWN0aW9uIHBvb2wgdG8gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBvb2wuZW5kKCk7XG4gICAgICAgICAgICBkZWxldGUgdGhpcy5wb29sO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgZGF0YWJhc2UgY29ubmVjdGlvbiBiYXNlZCBvbiB0aGUgZGVmYXVsdCBjb25uZWN0aW9uIHN0cmluZyBvZiB0aGUgY29ubmVjdG9yIGFuZCBnaXZlbiBvcHRpb25zLiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEV4dHJhIG9wdGlvbnMgZm9yIHRoZSBjb25uZWN0aW9uLCBvcHRpb25hbC5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLm11bHRpcGxlU3RhdGVtZW50cz1mYWxzZV0gLSBBbGxvdyBydW5uaW5nIG11bHRpcGxlIHN0YXRlbWVudHMgYXQgYSB0aW1lLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuY3JlYXRlRGF0YWJhc2U9ZmFsc2VdIC0gRmxhZyB0byB1c2VkIHdoZW4gY3JlYXRpbmcgYSBkYXRhYmFzZS5cbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZS48TXlTUUxDb25uZWN0aW9uPn1cbiAgICAgKi9cbiAgICBhc3luYyBjb25uZWN0XyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjc0tleSA9IHRoaXMuY29ubmVjdGlvblN0cmluZztcbiAgICAgICAgaWYgKCF0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbm5Qcm9wcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAob3B0aW9ucy5jcmVhdGVEYXRhYmFzZSkge1xuICAgICAgICAgICAgICAgIC8vcmVtb3ZlIHRoZSBkYXRhYmFzZSBmcm9tIGNvbm5lY3Rpb25cbiAgICAgICAgICAgICAgICBjb25uUHJvcHMuZGF0YWJhc2UgPSAnJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ublByb3BzLm9wdGlvbnMgPSBfLnBpY2sob3B0aW9ucywgWydtdWx0aXBsZVN0YXRlbWVudHMnXSk7ICAgICBcblxuICAgICAgICAgICAgY3NLZXkgPSB0aGlzLm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICBpZiAoY3NLZXkgIT09IHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5kXygpO1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKCF0aGlzLnBvb2wpIHsgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ3JlYXRlIGNvbm5lY3Rpb24gcG9vbCB0byAke2NzS2V5fWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMucG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMucG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuYWRkKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDb25uZWN0IHRvICR7Y3NLZXl9YCk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBEaXNjb25uZWN0IGZyb20gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGNvbnN0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBjb25zdCBpc29sYXRpb25MZXZlbCA9IF8uZmluZChNeVNRTENvbm5lY3Rvci5Jc29sYXRpb25MZXZlbHMsICh2YWx1ZSwga2V5KSA9PiBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSBrZXkgfHwgb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0gdmFsdWUpO1xuICAgICAgICAgICAgaWYgKCFpc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGlzb2xhdGlvbiBsZXZlbDogXCIke2lzb2xhdGlvbkxldmVsfVwiIVwiYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIFRSQU5TQUNUSU9OIElTT0xBVElPTiBMRVZFTCAnICsgaXNvbGF0aW9uTGV2ZWwpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgWyByZXQgXSA9IGF3YWl0IGNvbm4ucXVlcnkoJ1NFTEVDVCBAQGF1dG9jb21taXQ7Jyk7ICAgICAgICBcbiAgICAgICAgY29ubi4kJGF1dG9jb21taXQgPSByZXRbMF1bJ0BAYXV0b2NvbW1pdCddOyAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0wOycpO1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTVEFSVCBUUkFOU0FDVElPTjsnKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdDT01NSVQ7Jyk7ICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBgQ29tbWl0cyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdST0xMQkFDSzsnKTtcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBgUm9sbGJhY2tzIGEgdHJhbnNhY3Rpb24uIFByZXZpb3VzIGF1dG9jb21taXQ9JHtjb25uLiQkYXV0b2NvbW1pdH1gKTtcbiAgICAgICAgaWYgKGNvbm4uJCRhdXRvY29tbWl0KSB7XG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBhdXRvY29tbWl0PTE7Jyk7XG4gICAgICAgICAgICBkZWxldGUgY29ubi4kJGF1dG9jb21taXQ7XG4gICAgICAgIH0gICAgICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICBlcnIuaW5mbyB8fCAoZXJyLmluZm8gPSB7fSk7XG4gICAgICAgICAgICBlcnIuaW5mby5zcWwgPSBfLnRydW5jYXRlKHNxbCwgeyBsZW5ndGg6IDIwMCB9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnBhcmFtcyA9IHBhcmFtcztcblxuICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyBTRVQgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgb3IgdXBkYXRlIHRoZSBvbGQgb25lIGlmIGR1cGxpY2F0ZSBrZXkgZm91bmQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cHNlcnRPbmVfKG1vZGVsLCBkYXRhLCB1bmlxdWVLZXlzLCBvcHRpb25zLCBkYXRhT25JbnNlcnQpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGF0YVdpdGhvdXRVSyA9IF8ub21pdChkYXRhLCB1bmlxdWVLZXlzKTtcbiAgICAgICAgbGV0IGluc2VydERhdGEgPSB7IC4uLmRhdGEsIC4uLmRhdGFPbkluc2VydCB9O1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YVdpdGhvdXRVSykpIHtcbiAgICAgICAgICAgIC8vaWYgZHVwbGlhdGUsIGRvbnQgbmVlZCB0byB1cGRhdGVcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNyZWF0ZV8obW9kZWwsIGluc2VydERhdGEsIHsgLi4ub3B0aW9ucywgaW5zZXJ0SWdub3JlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgSU5UTyA/PyBTRVQgPyBPTiBEVVBMSUNBVEUgS0VZIFVQREFURSA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goaW5zZXJ0RGF0YSk7XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGFXaXRob3V0VUspO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgYXN5bmMgaW5zZXJ0TWFueV8obW9kZWwsIGZpZWxkcywgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZGF0YVwiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmRzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImZpZWxkc1wiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRldjoge1xuICAgICAgICAgICAgZGF0YS5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvdykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VsZW1lbnQgb2YgXCJkYXRhXCIgYXJyYXkgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZCB2YWx1ZXMuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gKCR7ZmllbGRzLm1hcChmID0+IHRoaXMuZXNjYXBlSWQoZikpLmpvaW4oJywgJyl9KSBWQUxVRVMgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGluc2VydE9uZV8gPSB0aGlzLmNyZWF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnlPcHRpb25zICBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwZGF0ZV8obW9kZWwsIGRhdGEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgIFxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdEYXRhIHJlY29yZCBpcyBlbXB0eS4nLCB7IG1vZGVsLCBxdWVyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zKSB8fCBoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgJyArIHRoaXMuX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkuam9pbignLCcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgPyc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB1cGRhdGVPbmVfID0gdGhpcy51cGRhdGVfO1xuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IGRlbGV0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIHF1ZXJ5LCBkZWxldGVPcHRpb25zLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF0sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAoZGVsZXRlT3B0aW9ucyAmJiBkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEEgRlJPTSA/PyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEZST00gPz8nO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgIFxuICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkobW9kZWwsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5jb3VudFNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2Uoc3FsSW5mby5hbGlhc01hcCwgKHJlc3VsdCwgYWxpYXMsIG5vZGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2FsaWFzXSA9IG5vZGVQYXRoLnNwbGl0KCcuJykuc2xpY2UoMSkvKi5tYXAobiA9PiAnOicgKyBuKSBjaGFuZ2VkIHRvIGJlIHBhZGRpbmcgYnkgb3JtIGFuZCBjYW4gYmUgY3VzdG9taXplZCB3aXRoIG90aGVyIGtleSBnZXR0ZXIgKi87XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXAsIHRvdGFsQ291bnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXApO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbmRpdGlvbi4kc2tpcE9ybSkge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgcmV0dXJuIFsgcmVzdWx0LCB0b3RhbENvdW50IF07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIHNxbCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiAgICAgIFxuICAgICAqL1xuICAgIGJ1aWxkUXVlcnkobW9kZWwsIHsgJHJlbGF0aW9uc2hpcHMsICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9KSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107ICAgICAgICBcblxuICAgICAgICAvLyBidWlsZCBhbGlhcyBtYXAgZmlyc3RcbiAgICAgICAgLy8gY2FjaGUgcGFyYW1zXG4gICAgICAgIGlmICgkcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJyonO1xuXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICAvLyBtb3ZlIGNhY2hlZCBqb2luaW5nIHBhcmFtcyBpbnRvIHBhcmFtc1xuICAgICAgICAvLyBzaG91bGQgYWNjb3JkaW5nIHRvIHRoZSBwbGFjZSBvZiBjbGF1c2UgaW4gYSBzcWwgICAgICAgIFxuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zb2xlLmxvZygkcXVlcnkpO1xuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnX3dyYXBDb25kaXRpb24nLCB2YWx1ZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBDb2x1bW4gcmVmZXJlbmNlIFwiJHtmaWVsZE5hbWV9XCIgbm90IGZvdW5kIGluIHBvcHVsYXRlZCBhc3NvY2lhdGlvbnMuYCwge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG1haW5FbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzOiBhbGlhc0tleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgKGFjdHVhbEZpZWxkTmFtZSA9PT0gJyonID8gJyonIDogbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyAoZmllbGROYW1lID09PSAnKicgPyAnKicgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgeyAgIFxuXG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gKGZpZWxkTmFtZSA9PT0gJyonKSA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ29vclR5cGUnLCB2YWx1ZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgPD4gJHt0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCl9YDtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgPiAke3RoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX1gO1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IHRoaXMudHlwZUNhc3Qodik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCA+PSAke3RoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX1gO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgPCAke3RoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKX1gO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gdGhpcy50eXBlQ2FzdCh2KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIDw9ICR7dGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApfWA7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHtzcWxJbmZvLnNxbH0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5pbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2KSAmJiB2Lm9vclR5cGUgPT09ICdEYXRhU2V0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KHYubW9kZWwsIHYucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsSW5mby5wYXJhbXMgJiYgc3FsSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7c3FsSW5mby5zcWx9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRoYXMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnIHx8IHYuaW5kZXhPZignLCcpID49IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aXRob3V0IFwiLFwiIHdoZW4gdXNpbmcgXCIkaGFzXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGBGSU5EX0lOX1NFVCg/LCAke3RoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApfSkgPiAwYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICB2YWx1ZSA9IHRoaXMudHlwZUNhc3QodmFsdWUpO1xuXG4gICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaXNRdW90ZWQoY29sKSA/IGNvbCA6IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gY29sO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb2wpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcykge1xuICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBsYXN0RG90SW5kZXggPSBjb2wuYWxpYXMubGFzdEluZGV4T2YoJy4nKTtcbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBsYXN0RG90SW5kZXggPiAwID8gY29sLmFsaWFzLnN1YnN0cihsYXN0RG90SW5kZXgrMSkgOiBjb2wuYWxpYXM7XG5cbiAgICAgICAgICAgICAgICBpZiAobGFzdERvdEluZGV4ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhc2NhZGUgYWxpYXMgaXMgbm90IGFsbG93ZWQgd2hlbiB0aGUgcXVlcnkgaGFzIG5vIGFzc29jaWF0ZWQgZW50aXR5IHBvcHVsYXRlZC4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpYXM6IGNvbC5hbGlhc1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBmdWxsUGF0aCA9IGhhc0pvaW5pbmcgKyAnLicgKyBjb2wuYWxpYXMuc3Vic3RyKDAsIGxhc3REb3RJbmRleCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGFsaWFzUHJlZml4ID0gYWxpYXNNYXBbZnVsbFBhdGhdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWFsaWFzUHJlZml4KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBJbnZhbGlkIGNhc2NhZGUgYWxpYXMuIFwiJHtmdWxsUGF0aH1cIiBub3QgZm91bmQgaW4gYXNzb2NpYXRpb25zLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhczogY29sLmFsaWFzXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gYWxpYXNQcmVmaXggKyAnJCcgKyBhbGlhcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChhbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGxldCBuYW1lID0gY29sLm5hbWUudG9VcHBlckNhc2UoKTtcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ0NPVU5UJyAmJiBjb2wuYXJncy5sZW5ndGggPT09IDEgJiYgY29sLmFyZ3NbMF0gPT09ICcqJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ0NPVU5UKCopJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gbmFtZSArICcoJyArIChjb2wucHJlZml4ID8gYCR7Y29sLnByZWZpeC50b1VwcGVyQ2FzZSgpfSBgIDogXCJcIikgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdleHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbC5leHByLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnY29sdW1uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA9PT0gZmFsc2UgfHwgYXNjID09ICctMScgPyAnIERFU0MnIDogJycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuTXlTUUxDb25uZWN0b3IuZHJpdmVyTGliID0gbXlzcWw7XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19
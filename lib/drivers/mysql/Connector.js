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
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${v})`;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';

              case '$nin':
              case '$notIn':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${v})`;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';

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

        return this._buildColumn(_.omit(col, ['alias']), params, hasJoining, aliasMap) + ' AS ' + mysql.escapeId(col.alias);
      }

      if (col.type === 'function') {
        if (col.name.toUpperCase() === 'COUNT' && col.args.length === 1 && col.args[0] === '*') {
          return 'COUNT(*)';
        }

        return col.name + '(' + (col.args ? this._buildColumns(col.args, params, hasJoining, aliasMap) : '') + ')';
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIldlYWtTZXQiLCJlbmRfIiwic2l6ZSIsImNvbm4iLCJkaXNjb25uZWN0XyIsInBvb2wiLCJsb2ciLCJjdXJyZW50Q29ubmVjdGlvblN0cmluZyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsIm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nIiwiY3JlYXRlUG9vbCIsImdldENvbm5lY3Rpb24iLCJhZGQiLCJkZWxldGUiLCJyZWxlYXNlIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJpc29sYXRpb25MZXZlbCIsImZpbmQiLCJJc29sYXRpb25MZXZlbHMiLCJ2YWx1ZSIsImtleSIsInF1ZXJ5IiwicmV0IiwiJCRhdXRvY29tbWl0IiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFXaXRoVUsiLCJvbWl0IiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwiZmluZF8iLCJjb25kaXRpb24iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJuIiwiY29uY2F0IiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJjb25zb2xlIiwibXNnIiwidiIsImluZGV4T2YiLCJfcGFja0FycmF5IiwiYXJyYXkiLCJuYW1lIiwiYXJncyIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsInR5cGUiLCJleHByIiwiZ3JvdXBCeSIsImJ5IiwiaGF2aW5nIiwiZ3JvdXBCeUNsYXVzZSIsImhhdmluZ0NsdXNlIiwib3JkZXJCeSIsImFzYyIsImNvbm5lY3Rpb24iLCJmcmVlemUiLCJSZXBlYXRhYmxlUmVhZCIsIlJlYWRDb21taXR0ZWQiLCJSZWFkVW5jb21taXR0ZWQiLCJSZXJpYWxpemFibGUiLCJkcml2ZXJMaWIiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FB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LE9BQU8sQ0FBQ3FNLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS3RMLFdBQUwsQ0FBaUJELElBQWpCLENBQVA7QUFDSDtBQUNKOztBQTVoQ2tDOztBQUFqQ2pCLGMsQ0FNS3NDLGUsR0FBa0J1SCxNQUFNLENBQUM0QyxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUF5aEM3QjdNLGNBQWMsQ0FBQzhNLFNBQWYsR0FBMkJyTixLQUEzQjtBQUVBc04sTUFBTSxDQUFDQyxPQUFQLEdBQWlCaE4sY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9saWInKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gRmxhdCB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHRvIGltcHJvdmUgcXVlcnkgcGVyZm9ybWFuY2UuIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMubG9nU3RhdGVtZW50XSAtIEZsYWcgdG8gbG9nIGV4ZWN1dGVkIFNRTCBzdGF0ZW1lbnQuXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMucmVsYXRpb25hbCA9IHRydWU7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMgPSBuZXcgV2Vha1NldCgpO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgaWYgKHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5hY2l0dmVDb25uZWN0aW9ucykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMucG9vbCkge1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYEVuZCBjb25uZWN0aW9uIHBvb2wgdG8gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBvb2wuZW5kKCk7XG4gICAgICAgICAgICBkZWxldGUgdGhpcy5wb29sO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgZGF0YWJhc2UgY29ubmVjdGlvbiBiYXNlZCBvbiB0aGUgZGVmYXVsdCBjb25uZWN0aW9uIHN0cmluZyBvZiB0aGUgY29ubmVjdG9yIGFuZCBnaXZlbiBvcHRpb25zLiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEV4dHJhIG9wdGlvbnMgZm9yIHRoZSBjb25uZWN0aW9uLCBvcHRpb25hbC5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLm11bHRpcGxlU3RhdGVtZW50cz1mYWxzZV0gLSBBbGxvdyBydW5uaW5nIG11bHRpcGxlIHN0YXRlbWVudHMgYXQgYSB0aW1lLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuY3JlYXRlRGF0YWJhc2U9ZmFsc2VdIC0gRmxhZyB0byB1c2VkIHdoZW4gY3JlYXRpbmcgYSBkYXRhYmFzZS5cbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZS48TXlTUUxDb25uZWN0aW9uPn1cbiAgICAgKi9cbiAgICBhc3luYyBjb25uZWN0XyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjc0tleSA9IHRoaXMuY29ubmVjdGlvblN0cmluZztcbiAgICAgICAgaWYgKCF0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbm5Qcm9wcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAob3B0aW9ucy5jcmVhdGVEYXRhYmFzZSkge1xuICAgICAgICAgICAgICAgIC8vcmVtb3ZlIHRoZSBkYXRhYmFzZSBmcm9tIGNvbm5lY3Rpb25cbiAgICAgICAgICAgICAgICBjb25uUHJvcHMuZGF0YWJhc2UgPSAnJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ublByb3BzLm9wdGlvbnMgPSBfLnBpY2sob3B0aW9ucywgWydtdWx0aXBsZVN0YXRlbWVudHMnXSk7ICAgICBcblxuICAgICAgICAgICAgY3NLZXkgPSB0aGlzLm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICBpZiAoY3NLZXkgIT09IHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5kXygpO1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKCF0aGlzLnBvb2wpIHsgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ3JlYXRlIGNvbm5lY3Rpb24gcG9vbCB0byAke2NzS2V5fWApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLnBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLnBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmFkZChjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ29ubmVjdCB0byAke2NzS2V5fWApO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRGlzY29ubmVjdCBmcm9tICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBjb25zdCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgY29uc3QgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IFsgcmV0IF0gPSBhd2FpdCBjb25uLnF1ZXJ5KCdTRUxFQ1QgQEBhdXRvY29tbWl0OycpOyAgICAgICAgXG4gICAgICAgIGNvbm4uJCRhdXRvY29tbWl0ID0gcmV0WzBdWydAQGF1dG9jb21taXQnXTsgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MDsnKTtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU1RBUlQgVFJBTlNBQ1RJT047Jyk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnQ09NTUlUOycpOyAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYENvbW1pdHMgYSB0cmFuc2FjdGlvbi4gUHJldmlvdXMgYXV0b2NvbW1pdD0ke2Nvbm4uJCRhdXRvY29tbWl0fWApO1xuICAgICAgICBpZiAoY29ubi4kJGF1dG9jb21taXQpIHtcbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIGF1dG9jb21taXQ9MTsnKTtcbiAgICAgICAgICAgIGRlbGV0ZSBjb25uLiQkYXV0b2NvbW1pdDtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnUk9MTEJBQ0s7Jyk7XG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgYFJvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLiBQcmV2aW91cyBhdXRvY29tbWl0PSR7Y29ubi4kJGF1dG9jb21taXR9YCk7XG4gICAgICAgIGlmIChjb25uLiQkYXV0b2NvbW1pdCkge1xuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gYXV0b2NvbW1pdD0xOycpO1xuICAgICAgICAgICAgZGVsZXRlIGNvbm4uJCRhdXRvY29tbWl0O1xuICAgICAgICB9ICAgICAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuICAgICBcbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmluZm8gfHwgKGVyci5pbmZvID0ge30pO1xuICAgICAgICAgICAgZXJyLmluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuaW5mby5wYXJhbXMgPSBwYXJhbXM7XG5cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyBTRVQgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgb3IgdXBkYXRlIHRoZSBvbGQgb25lIGlmIGR1cGxpY2F0ZSBrZXkgZm91bmQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cHNlcnRPbmVfKG1vZGVsLCBkYXRhLCB1bmlxdWVLZXlzLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRhdGFXaXRoVUsgPSBfLm9taXQoZGF0YSwgdW5pcXVlS2V5cyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhV2l0aFVLKSkge1xuICAgICAgICAgICAgLy9pZiBkdXBsaWF0ZSwgZG9udCBuZWVkIHRvIHVwZGF0ZVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhtb2RlbCwgZGF0YSwgeyAuLi5vcHRpb25zLCBpbnNlcnRJZ25vcmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCBJTlRPID8/IFNFVCA/IE9OIERVUExJQ0FURSBLRVkgVVBEQVRFID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YVdpdGhVSyk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgYXN5bmMgaW5zZXJ0TWFueV8obW9kZWwsIGZpZWxkcywgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZGF0YVwiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmRzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImZpZWxkc1wiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRldjoge1xuICAgICAgICAgICAgZGF0YS5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvdykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VsZW1lbnQgb2YgXCJkYXRhXCIgYXJyYXkgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZCB2YWx1ZXMuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gKCR7ZmllbGRzLm1hcChmID0+IHRoaXMuZXNjYXBlSWQoZikpLmpvaW4oJywgJyl9KSBWQUxVRVMgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGluc2VydE9uZV8gPSB0aGlzLmNyZWF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnlPcHRpb25zICBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwZGF0ZV8obW9kZWwsIGRhdGEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgIFxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdEYXRhIHJlY29yZCBpcyBlbXB0eS4nLCB7IG1vZGVsLCBxdWVyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zKSB8fCBoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgJyArIHRoaXMuX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkuam9pbignLCcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgPyc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB1cGRhdGVPbmVfID0gdGhpcy51cGRhdGVfO1xuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IGRlbGV0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIHF1ZXJ5LCBkZWxldGVPcHRpb25zLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF0sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAoZGVsZXRlT3B0aW9ucyAmJiBkZWxldGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKGRlbGV0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEEgRlJPTSA/PyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSAnREVMRVRFIEZST00gPz8nO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgICAgICBcblxuICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS5tYXAobiA9PiAnOicgKyBuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgcmV0dXJuIFsgcmVzdWx0LCB0b3RhbENvdW50IF07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIHNxbCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiAgICAgIFxuICAgICAqL1xuICAgIGJ1aWxkUXVlcnkobW9kZWwsIHsgJHJlbGF0aW9uc2hpcHMsICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9KSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107ICAgICAgICBcblxuICAgICAgICAvLyBidWlsZCBhbGlhcyBtYXAgZmlyc3RcbiAgICAgICAgLy8gY2FjaGUgcGFyYW1zXG4gICAgICAgIGlmICgkcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJyonO1xuXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICAvLyBtb3ZlIGNhY2hlZCBqb2luaW5nIHBhcmFtcyBpbnRvIHBhcmFtc1xuICAgICAgICAvLyBzaG91bGQgYWNjb3JkaW5nIHRvIHRoZSBwbGFjZSBvZiBjbGF1c2UgaW4gYSBzcWwgICAgICAgIFxuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRvcmRlckJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRPcmRlckJ5KCRvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVzdWx0ID0geyBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwIH07ICAgICAgICBcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdC5jb3VudFNxbCA9IGBTRUxFQ1QgQ09VTlQoJHtjb3VudFN1YmplY3R9KSBBUyBjb3VudGAgKyBzcWw7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgPSAnU0VMRUNUICcgKyBzZWxlY3RDb2xvbW5zICsgc3FsOyAgICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCAxMDAwJztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnNxbCA9IHNxbDtcblxuICAgICAgICAvL2NvbnNvbGUuZGlyKHJlc3VsdCwgeyBkZXB0aDogMTAsIGNvbG9yczogdHJ1ZSB9KTsgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICAvL2NvbnNvbGUubG9nKCdhc3NvY2lhdGlvbnM6JywgT2JqZWN0LmtleXMoYXNzb2NpYXRpb25zKSk7XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7ICAgICAgICAgICAgIFxuICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHsgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY3MsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcgfHwga2V5LnN0YXJ0c1dpdGgoJyRhbmRfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmICgoa2V5ID09PSAnJGV4cHInIHx8IGtleS5zdGFydHNXaXRoKCckZXhwcl8nKSkgJiYgdmFsdWUub29yVHlwZSAmJiB2YWx1ZS5vb3JUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IG1haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFthbGlhc0tleV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKG1haW5FbnRpdHksIGFsaWFzS2V5LCBhbGlhc01hcCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9LiBQbGVhc2UgY2hlY2sgJGFzc29jaWF0aW9uIHZhbHVlLmA7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQobXNnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhc01hcFttYWluRW50aXR5XSArICcuJyArIChmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7ICAgXG5cbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGFwcGx5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFyZ3MgPSB2YWx1ZS5hcmdzID8gWyBmaWVsZE5hbWUgXS5jb25jYXQodmFsdWUuYXJncykgOiBbIGZpZWxkTmFtZSBdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpID0gJ1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRoYXMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnIHx8IHYuaW5kZXhPZignLCcpID49IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aXRob3V0IFwiLFwiIHdoZW4gdXNpbmcgXCIkaGFzXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGBGSU5EX0lOX1NFVCg/LCAke3RoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApfSkgPiAwYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbC5uYW1lLnRvVXBwZXJDYXNlKCkgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
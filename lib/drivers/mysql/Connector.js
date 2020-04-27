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
    let conn = await this.connect_();

    if (options && options.isolationLevel) {
      let isolationLevel = _.find(MySQLConnector.IsolationLevels, (value, key) => options.isolationLevel === key || options.isolationLevel === value);

      if (!isolationLevel) {
        throw new ApplicationError(`Invalid isolation level: "${isolationLevel}"!"`);
      }

      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolationLevel);
    }

    await conn.beginTransaction();
    this.log('verbose', 'Begins a new transaction.');
    return conn;
  }

  async commit_(conn) {
    await conn.commit();
    this.log('verbose', 'Commits a transaction.');
    return this.disconnect_(conn);
  }

  async rollback_(conn) {
    await conn.rollback();
    this.log('verbose', 'Rollbacks a transaction.');
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

    if (queryOptions && queryOptions.$requireSplitColumns) {
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

  async delete_(model, condition, options) {
    let params = [model];

    let whereClause = this._joinCondition(condition, params);

    let sql = 'DELETE FROM ?? WHERE ' + whereClause;
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

      return mysql.escapeId(fieldName) + '=' + this._packValue(v, params, hasJoining, aliasMap);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIldlYWtTZXQiLCJlbmRfIiwic2l6ZSIsImNvbm4iLCJkaXNjb25uZWN0XyIsInBvb2wiLCJsb2ciLCJjdXJyZW50Q29ubmVjdGlvblN0cmluZyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsIm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nIiwiY3JlYXRlUG9vbCIsImdldENvbm5lY3Rpb24iLCJhZGQiLCJkZWxldGUiLCJyZWxlYXNlIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJpc29sYXRpb25MZXZlbCIsImZpbmQiLCJJc29sYXRpb25MZXZlbHMiLCJ2YWx1ZSIsImtleSIsInF1ZXJ5IiwiYmVnaW5UcmFuc2FjdGlvbiIsImNvbW1pdF8iLCJjb21taXQiLCJyb2xsYmFja18iLCJyb2xsYmFjayIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiaW5mbyIsInRydW5jYXRlIiwibGVuZ3RoIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsIm1vZGVsIiwiZGF0YSIsImlzRW1wdHkiLCJpbnNlcnRJZ25vcmUiLCJyZXN0T3B0aW9ucyIsInB1c2giLCJ1cHNlcnRPbmVfIiwidW5pcXVlS2V5cyIsImRhdGFXaXRoVUsiLCJvbWl0IiwiaW5zZXJ0TWFueV8iLCJmaWVsZHMiLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwicm93IiwibWFwIiwiZiIsImpvaW4iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJwIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc3BsaXRDb2x1bW5zQXNJbnB1dCIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJjb25kaXRpb24iLCJmaW5kXyIsInNxbEluZm8iLCJidWlsZFF1ZXJ5IiwidG90YWxDb3VudCIsImNvdW50U3FsIiwiY291bnRSZXN1bHQiLCJyZXZlcnNlQWxpYXNNYXAiLCJyZWR1Y2UiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm4iLCJjb25jYXQiLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImpvaW5PcGVyYXRvciIsImMiLCJpc1BsYWluT2JqZWN0Iiwic3RhcnRzV2l0aCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsImtleXMiLCJvb3JUeXBlIiwibGVmdCIsIl9wYWNrVmFsdWUiLCJyaWdodCIsIm9wIiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsImZpZWxkTmFtZSIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsImNvbnNvbGUiLCJtc2ciLCJ2IiwiaW5kZXhPZiIsIl9wYWNrQXJyYXkiLCJhcnJheSIsIm5hbWUiLCJhcmdzIiwiaW5qZWN0IiwiaXNOaWwiLCIkaW4iLCJoYXNPcGVyYXRvciIsImsiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwidHlwZSIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsImRyaXZlckxpYiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7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QjtBQUNIOztBQUVELFVBQU0sSUFBSXhGLGdCQUFKLENBQXNCLDRCQUEyQjJLLElBQUksQ0FBQ0MsU0FBTCxDQUFlK0IsT0FBZixDQUF3QixFQUF6RSxDQUFOO0FBQ0g7O0FBRUQsUUFBTXBKLGVBQU4sQ0FBc0IvQyxPQUF0QixFQUErQjtBQUMzQixXQUFRQSxPQUFPLElBQUlBLE9BQU8sQ0FBQ3FNLFVBQXBCLEdBQWtDck0sT0FBTyxDQUFDcU0sVUFBMUMsR0FBdUQsS0FBS2pMLFFBQUwsQ0FBY3BCLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNMEQsbUJBQU4sQ0FBMEI1QyxJQUExQixFQUFnQ2QsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDcU0sVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLdEwsV0FBTCxDQUFpQkQsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBdC9Ca0M7O0FBQWpDakIsYyxDQU1Lc0MsZSxHQUFrQnVILE1BQU0sQ0FBQzRDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQW0vQjdCN00sY0FBYyxDQUFDOE0sU0FBZixHQUEyQnJOLEtBQTNCO0FBRUFzTixNQUFNLENBQUNDLE9BQVAsR0FBaUJoTixjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xpYicpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCB7IGlzUXVvdGVkLCBpc1ByaW1pdGl2ZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBXZWFrU2V0KCk7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBpZiAodGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID4gMCkge1xuICAgICAgICAgICAgZm9yIChsZXQgY29ubiBvZiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRW5kIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMucG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMucG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuYWRkKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDb25uZWN0IHRvICR7Y3NLZXl9YCk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBEaXNjb25uZWN0IGZyb20gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLmNvbW1pdCgpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQ29tbWl0cyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnJvbGxiYWNrKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICBlcnIuaW5mbyB8fCAoZXJyLmluZm8gPSB7fSk7XG4gICAgICAgICAgICBlcnIuaW5mby5zcWwgPSBfLnRydW5jYXRlKHNxbCwgeyBsZW5ndGg6IDIwMCB9KTtcbiAgICAgICAgICAgIGVyci5pbmZvLnBhcmFtcyA9IHBhcmFtcztcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSBvciB1cGRhdGUgdGhlIG9sZCBvbmUgaWYgZHVwbGljYXRlIGtleSBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwc2VydE9uZV8obW9kZWwsIGRhdGEsIHVuaXF1ZUtleXMsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGF0YVdpdGhVSyA9IF8ub21pdChkYXRhLCB1bmlxdWVLZXlzKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGFXaXRoVUspKSB7XG4gICAgICAgICAgICAvL2lmIGR1cGxpYXRlLCBkb250IG5lZWQgdG8gdXBkYXRlXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKG1vZGVsLCBkYXRhLCB7IC4uLm9wdGlvbnMsIGluc2VydElnbm9yZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUIElOVE8gPz8gU0VUID8gT04gRFVQTElDQVRFIEtFWSBVUERBVEUgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhV2l0aFVLKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBhc3luYyBpbnNlcnRNYW55Xyhtb2RlbCwgZmllbGRzLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJkYXRhXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZHMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZmllbGRzXCIgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWVzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICBkYXRhLmZvckVhY2gocm93ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignRWxlbWVudCBvZiBcImRhdGFcIiBhcnJheSB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3JkIHZhbHVlcy4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSA/IFwiSUdOT1JFIFwiOlwiXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkobW9kZWwsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5jb3VudFNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2Uoc3FsSW5mby5hbGlhc01hcCwgKHJlc3VsdCwgYWxpYXMsIG5vZGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2FsaWFzXSA9IG5vZGVQYXRoLnNwbGl0KCcuJykuc2xpY2UoMSkubWFwKG4gPT4gJzonICsgbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXAsIHRvdGFsQ291bnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXApO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihyZXN1bHQsIHsgZGVwdGg6IDEwLCBjb2xvcnM6IHRydWUgfSk7IFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgLy9jb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyAgICAgICAgICAgICBcbiAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NzLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleS5zdGFydHNXaXRoKCckYW5kXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InIHx8IGtleS5zdGFydHNXaXRoKCckb3JfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoKGtleSA9PT0gJyRleHByJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGV4cHJfJykpICYmIHZhbHVlLm9vclR5cGUgJiYgdmFsdWUub29yVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBtYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpO1xuICAgICAgICAgICAgbGV0IGFsaWFzID0gYWxpYXNNYXBbYWxpYXNLZXldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhtYWluRW50aXR5LCBhbGlhc0tleSwgYWxpYXNNYXApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IG1zZyA9IGBVbmtub3duIGNvbHVtbiByZWZlcmVuY2U6ICR7ZmllbGROYW1lfS4gUGxlYXNlIGNoZWNrICRhc3NvY2lhdGlvbiB2YWx1ZS5gOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KG1zZyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyAoZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgeyAgIFxuXG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIF9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwKGRhdGEsICh2LCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGROYW1lLmluZGV4T2YoJy4nKSA9PT0gLTEsICdDb2x1bW4gb2YgZGlyZWN0IGlucHV0IGRhdGEgY2Fubm90IGJlIGEgZG90LXNlcGFyYXRlZCBuYW1lLic7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGFwcGx5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFyZ3MgPSB2YWx1ZS5hcmdzID8gWyBmaWVsZE5hbWUgXS5jb25jYXQodmFsdWUuYXJncykgOiBbIGZpZWxkTmFtZSBdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpID0gJ1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICBwYXJhbXMucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGlmIChjb2wubmFtZS50b1VwcGVyQ2FzZSgpID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBjb2wubmFtZSArICcoJyArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA9PT0gZmFsc2UgfHwgYXNjID09ICctMScgPyAnIERFU0MnIDogJycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuTXlTUUxDb25uZWN0b3IuZHJpdmVyTGliID0gbXlzcWw7XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19
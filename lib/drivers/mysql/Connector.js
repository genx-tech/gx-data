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
      err.extraInfo || (err.extraInfo = {});
      err.extraInfo.sql = _.truncate(sql, {
        length: 200
      });
      err.extraInfo.params = params;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIldlYWtTZXQiLCJlbmRfIiwic2l6ZSIsImNvbm4iLCJkaXNjb25uZWN0XyIsInBvb2wiLCJsb2ciLCJjdXJyZW50Q29ubmVjdGlvblN0cmluZyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsIm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nIiwiY3JlYXRlUG9vbCIsImdldENvbm5lY3Rpb24iLCJhZGQiLCJkZWxldGUiLCJyZWxlYXNlIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJpc29sYXRpb25MZXZlbCIsImZpbmQiLCJJc29sYXRpb25MZXZlbHMiLCJ2YWx1ZSIsImtleSIsInF1ZXJ5IiwiYmVnaW5UcmFuc2FjdGlvbiIsImNvbW1pdF8iLCJjb21taXQiLCJyb2xsYmFja18iLCJyb2xsYmFjayIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiZXh0cmFJbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwicmVzdWx0IiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsInVwc2VydE9uZV8iLCJ1bmlxdWVLZXlzIiwiZGF0YVdpdGhVSyIsIm9taXQiLCJpbnNlcnRNYW55XyIsImZpZWxkcyIsIkFycmF5IiwiaXNBcnJheSIsImZvckVhY2giLCJyb3ciLCJtYXAiLCJmIiwiam9pbiIsInF1ZXJ5T3B0aW9ucyIsImNvbm5PcHRpb25zIiwiYWxpYXNNYXAiLCJqb2luaW5ncyIsImhhc0pvaW5pbmciLCJqb2luaW5nUGFyYW1zIiwiJHJlbGF0aW9uc2hpcHMiLCJfam9pbkFzc29jaWF0aW9ucyIsInAiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zcGxpdENvbHVtbnNBc0lucHV0Iiwid2hlcmVDbGF1c2UiLCJfam9pbkNvbmRpdGlvbiIsInJlcGxhY2VfIiwiZGVsZXRlXyIsImNvbmRpdGlvbiIsImZpbmRfIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsImFsaWFzIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwibiIsImNvbmNhdCIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCIkdG90YWxDb3VudCIsInNlbGVjdENvbG9tbnMiLCJfYnVpbGRDb2x1bW5zIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc0ludGVnZXIiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsIl9nZW5lcmF0ZUFsaWFzIiwiaW5kZXgiLCJhbmNob3IiLCJ2ZXJib3NlQWxpYXMiLCJzbmFrZUNhc2UiLCJ0b1VwcGVyQ2FzZSIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImFzc29jSW5mbyIsImpvaW5UeXBlIiwib24iLCJvdXRwdXQiLCJlbnRpdHkiLCJzdWJBc3NvY3MiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwiam9pbk9wZXJhdG9yIiwiYyIsImlzUGxhaW5PYmplY3QiLCJzdGFydHNXaXRoIiwibnVtT2ZFbGVtZW50IiwiT2JqZWN0Iiwia2V5cyIsIm9vclR5cGUiLCJsZWZ0IiwiX3BhY2tWYWx1ZSIsInJpZ2h0Iiwib3AiLCJfd3JhcENvbmRpdGlvbiIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwiY29uc29sZSIsIm1zZyIsInYiLCJpbmRleE9mIiwiX3BhY2tBcnJheSIsImFycmF5IiwibmFtZSIsImFyZ3MiLCJpbmplY3QiLCJpc05pbCIsIiRpbiIsImhhc09wZXJhdG9yIiwiayIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJ0eXBlIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwiZHJpdmVyTGliIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxF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QUF0SSxDQUFyQjtBQUNIOztBQUVELFVBQU0sSUFBSXhGLGdCQUFKLENBQXNCLDRCQUEyQjJLLElBQUksQ0FBQ0MsU0FBTCxDQUFlK0IsT0FBZixDQUF3QixFQUF6RSxDQUFOO0FBQ0g7O0FBRUQsUUFBTXBKLGVBQU4sQ0FBc0IvQyxPQUF0QixFQUErQjtBQUMzQixXQUFRQSxPQUFPLElBQUlBLE9BQU8sQ0FBQ3FNLFVBQXBCLEdBQWtDck0sT0FBTyxDQUFDcU0sVUFBMUMsR0FBdUQsS0FBS2pMLFFBQUwsQ0FBY3BCLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNMEQsbUJBQU4sQ0FBMEI1QyxJQUExQixFQUFnQ2QsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDcU0sVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLdEwsV0FBTCxDQUFpQkQsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBdC9Ca0M7O0FBQWpDakIsYyxDQU1Lc0MsZSxHQUFrQnVILE1BQU0sQ0FBQzRDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQW0vQjdCN00sY0FBYyxDQUFDOE0sU0FBZixHQUEyQnJOLEtBQTNCO0FBRUFzTixNQUFNLENBQUNDLE9BQVAsR0FBaUJoTixjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xpYicpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCB7IGlzUXVvdGVkLCBpc1ByaW1pdGl2ZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBGbGF0IHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgdG8gaW1wcm92ZSBxdWVyeSBwZXJmb3JtYW5jZS4gXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5sb2dTdGF0ZW1lbnRdIC0gRmxhZyB0byBsb2cgZXhlY3V0ZWQgU1FMIHN0YXRlbWVudC5cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5yZWxhdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBXZWFrU2V0KCk7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBpZiAodGhpcy5hY2l0dmVDb25uZWN0aW9ucy5zaXplID4gMCkge1xuICAgICAgICAgICAgZm9yIChsZXQgY29ubiBvZiB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5wb29sKSB7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRW5kIGNvbm5lY3Rpb24gcG9vbCB0byAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucG9vbC5lbmQoKTtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLnBvb2w7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuICAgICAgICBpZiAoIXRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMubWFrZU5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIGlmIChjc0tleSAhPT0gdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbmRfKCk7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAoIXRoaXMucG9vbCkgeyAgICBcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDcmVhdGUgY29ubmVjdGlvbiBwb29sIHRvICR7Y3NLZXl9YCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMucG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMucG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuYWRkKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBDb25uZWN0IHRvICR7Y3NLZXl9YCk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBEaXNjb25uZWN0IGZyb20gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLmNvbW1pdCgpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQ29tbWl0cyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnJvbGxiYWNrKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICBlcnIuZXh0cmFJbmZvIHx8IChlcnIuZXh0cmFJbmZvID0ge30pO1xuICAgICAgICAgICAgZXJyLmV4dHJhSW5mby5zcWwgPSBfLnRydW5jYXRlKHNxbCwgeyBsZW5ndGg6IDIwMCB9KTtcbiAgICAgICAgICAgIGVyci5leHRyYUluZm8ucGFyYW1zID0gcGFyYW1zO1xuXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gU0VUID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IG9yIHVwZGF0ZSB0aGUgb2xkIG9uZSBpZiBkdXBsaWNhdGUga2V5IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBzZXJ0T25lXyhtb2RlbCwgZGF0YSwgdW5pcXVlS2V5cywgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkYXRhV2l0aFVLID0gXy5vbWl0KGRhdGEsIHVuaXF1ZUtleXMpO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YVdpdGhVSykpIHtcbiAgICAgICAgICAgIC8vaWYgZHVwbGlhdGUsIGRvbnQgbmVlZCB0byB1cGRhdGVcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNyZWF0ZV8obW9kZWwsIGRhdGEsIHsgLi4ub3B0aW9ucywgaW5zZXJ0SWdub3JlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgSU5UTyA/PyBTRVQgPyBPTiBEVVBMSUNBVEUgS0VZIFVQREFURSA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGFXaXRoVUspO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGFzeW5jIGluc2VydE1hbnlfKG1vZGVsLCBmaWVsZHMsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImRhdGFcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgcmVjb3Jkcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignXCJmaWVsZHNcIiB0byBidWxrIGluc2VydCBzaG91bGQgYmUgYW4gYXJyYXkgb2YgZmllbGQgbmFtZXMuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgIGRhdGEuZm9yRWFjaChyb3cgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyb3cpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFbGVtZW50IG9mIFwiZGF0YVwiIGFycmF5IHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmQgdmFsdWVzLicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/ICgke2ZpZWxkcy5tYXAoZiA9PiB0aGlzLmVzY2FwZUlkKGYpKS5qb2luKCcsICcpfSkgVkFMVUVTID9gO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgcmVzdE9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICBpbnNlcnRPbmVfID0gdGhpcy5jcmVhdGVfO1xuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5T3B0aW9ucyAgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICBcbiAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRGF0YSByZWNvcmQgaXMgZW1wdHkuJywgeyBtb2RlbCwgcXVlcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgJyArIHRoaXMuX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkuam9pbignLCcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBTRVQgPyc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB1cGRhdGVPbmVfID0gdGhpcy51cGRhdGVfO1xuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIGNvbmRpdGlvbiwgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMpOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdERUxFVEUgRlJPTSA/PyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS5tYXAobiA9PiAnOicgKyBuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgcmV0dXJuIFsgcmVzdWx0LCB0b3RhbENvdW50IF07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIHNxbCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiAgICAgIFxuICAgICAqL1xuICAgIGJ1aWxkUXVlcnkobW9kZWwsIHsgJHJlbGF0aW9uc2hpcHMsICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9KSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107ICAgICAgICBcblxuICAgICAgICAvLyBidWlsZCBhbGlhcyBtYXAgZmlyc3RcbiAgICAgICAgLy8gY2FjaGUgcGFyYW1zXG4gICAgICAgIGlmICgkcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJyonO1xuXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICAvLyBtb3ZlIGNhY2hlZCBqb2luaW5nIHBhcmFtcyBpbnRvIHBhcmFtc1xuICAgICAgICAvLyBzaG91bGQgYWNjb3JkaW5nIHRvIHRoZSBwbGFjZSBvZiBjbGF1c2UgaW4gYSBzcWwgICAgICAgIFxuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRvcmRlckJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRPcmRlckJ5KCRvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVzdWx0ID0geyBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwIH07ICAgICAgICBcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdC5jb3VudFNxbCA9IGBTRUxFQ1QgQ09VTlQoJHtjb3VudFN1YmplY3R9KSBBUyBjb3VudGAgKyBzcWw7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgPSAnU0VMRUNUICcgKyBzZWxlY3RDb2xvbW5zICsgc3FsOyAgICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCAxMDAwJztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnNxbCA9IHNxbDtcblxuICAgICAgICAvL2NvbnNvbGUuZGlyKHJlc3VsdCwgeyBkZXB0aDogMTAsIGNvbG9yczogdHJ1ZSB9KTsgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICAvL2NvbnNvbGUubG9nKCdhc3NvY2lhdGlvbnM6JywgT2JqZWN0LmtleXMoYXNzb2NpYXRpb25zKSk7XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7ICAgICAgICAgICAgIFxuICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHsgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY3MsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcgfHwga2V5LnN0YXJ0c1dpdGgoJyRhbmRfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmICgoa2V5ID09PSAnJGV4cHInIHx8IGtleS5zdGFydHNXaXRoKCckZXhwcl8nKSkgJiYgdmFsdWUub29yVHlwZSAmJiB2YWx1ZS5vb3JUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IG1haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFthbGlhc0tleV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKG1haW5FbnRpdHksIGFsaWFzS2V5LCBhbGlhc01hcCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9LiBQbGVhc2UgY2hlY2sgJGFzc29jaWF0aW9uIHZhbHVlLmA7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQobXNnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhc01hcFttYWluRW50aXR5XSArICcuJyArIChmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7ICAgXG5cbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX3NwbGl0Q29sdW1uc0FzSW5wdXQoZGF0YSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gXy5tYXAoZGF0YSwgKHYsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSwgJ0NvbHVtbiBvZiBkaXJlY3QgaW5wdXQgZGF0YSBjYW5ub3QgYmUgYSBkb3Qtc2VwYXJhdGVkIG5hbWUuJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkgKyAnPScgKyB0aGlzLl9wYWNrVmFsdWUodiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9wYWNrQXJyYXkoYXJyYXksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIGFycmF5Lm1hcCh2YWx1ZSA9PiB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsJyk7XG4gICAgfVxuXG4gICAgX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQ29sdW1uUmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyh2YWx1ZS5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnRnVuY3Rpb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyAodmFsdWUuYXJncyA/IHRoaXMuX3BhY2tBcnJheSh2YWx1ZS5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgYCAke3ZhbHVlLm9wfSBgICsgcmlnaHQ7XG5cbiAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvb3IgdHlwZTogJHt2YWx1ZS5vb3JUeXBlfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFsdWUgPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiAnPyc7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB7ICRpbjogdmFsdWUgfSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICh2ID8gJyBJUyBOT1QgTlVMTCcgOiAnSVMgTlVMTCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNQcmltaXRpdmUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJD49XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdFwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdGVcIiBvciBcIiQ8PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckYXBwbHknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYXJncyA9IHZhbHVlLmFyZ3MgPyBbIGZpZWxkTmFtZSBdLmNvbmNhdCh2YWx1ZS5hcmdzKSA6IFsgZmllbGROYW1lIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJykgPSAnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbC5uYW1lLnRvVXBwZXJDYXNlKCkgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID09PSBmYWxzZSB8fCBhc2MgPT0gJy0xJyA/ICcgREVTQycgOiAnJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5NeVNRTENvbm5lY3Rvci5kcml2ZXJMaWIgPSBteXNxbDtcblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=
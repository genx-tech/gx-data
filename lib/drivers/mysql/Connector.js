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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIldlYWtTZXQiLCJlbmRfIiwic2l6ZSIsImNvbm4iLCJkaXNjb25uZWN0XyIsInBvb2wiLCJsb2ciLCJjdXJyZW50Q29ubmVjdGlvblN0cmluZyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsIm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nIiwiY3JlYXRlUG9vbCIsImdldENvbm5lY3Rpb24iLCJhZGQiLCJkZWxldGUiLCJyZWxlYXNlIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJpc29sYXRpb25MZXZlbCIsImZpbmQiLCJJc29sYXRpb25MZXZlbHMiLCJ2YWx1ZSIsImtleSIsInF1ZXJ5IiwiYmVnaW5UcmFuc2FjdGlvbiIsImNvbW1pdF8iLCJjb21taXQiLCJyb2xsYmFja18iLCJyb2xsYmFjayIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiZXh0cmFJbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwicmVzdWx0IiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiY29uZGl0aW9uIiwiZmluZF8iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJuIiwiY29uY2F0IiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJjb25zb2xlIiwibXNnIiwidiIsImluZGV4T2YiLCJfcGFja0FycmF5IiwiYXJyYXkiLCJuYW1lIiwiYXJncyIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsIm9taXQiLCJ0eXBlIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwiZHJpdmVyTGliIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7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IGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9saWInKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gRmxhdCB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHRvIGltcHJvdmUgcXVlcnkgcGVyZm9ybWFuY2UuIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMubG9nU3RhdGVtZW50XSAtIEZsYWcgdG8gbG9nIGV4ZWN1dGVkIFNRTCBzdGF0ZW1lbnQuXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMucmVsYXRpb25hbCA9IHRydWU7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMgPSBuZXcgV2Vha1NldCgpO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgaWYgKHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5hY2l0dmVDb25uZWN0aW9ucykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMucG9vbCkge1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYEVuZCBjb25uZWN0aW9uIHBvb2wgdG8gJHt0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nfWApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBvb2wuZW5kKCk7XG4gICAgICAgICAgICBkZWxldGUgdGhpcy5wb29sO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgZGF0YWJhc2UgY29ubmVjdGlvbiBiYXNlZCBvbiB0aGUgZGVmYXVsdCBjb25uZWN0aW9uIHN0cmluZyBvZiB0aGUgY29ubmVjdG9yIGFuZCBnaXZlbiBvcHRpb25zLiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEV4dHJhIG9wdGlvbnMgZm9yIHRoZSBjb25uZWN0aW9uLCBvcHRpb25hbC5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLm11bHRpcGxlU3RhdGVtZW50cz1mYWxzZV0gLSBBbGxvdyBydW5uaW5nIG11bHRpcGxlIHN0YXRlbWVudHMgYXQgYSB0aW1lLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuY3JlYXRlRGF0YWJhc2U9ZmFsc2VdIC0gRmxhZyB0byB1c2VkIHdoZW4gY3JlYXRpbmcgYSBkYXRhYmFzZS5cbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZS48TXlTUUxDb25uZWN0aW9uPn1cbiAgICAgKi9cbiAgICBhc3luYyBjb25uZWN0XyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjc0tleSA9IHRoaXMuY29ubmVjdGlvblN0cmluZztcbiAgICAgICAgaWYgKCF0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nID0gY3NLZXk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbm5Qcm9wcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAob3B0aW9ucy5jcmVhdGVEYXRhYmFzZSkge1xuICAgICAgICAgICAgICAgIC8vcmVtb3ZlIHRoZSBkYXRhYmFzZSBmcm9tIGNvbm5lY3Rpb25cbiAgICAgICAgICAgICAgICBjb25uUHJvcHMuZGF0YWJhc2UgPSAnJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ublByb3BzLm9wdGlvbnMgPSBfLnBpY2sob3B0aW9ucywgWydtdWx0aXBsZVN0YXRlbWVudHMnXSk7ICAgICBcblxuICAgICAgICAgICAgY3NLZXkgPSB0aGlzLm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICBpZiAoY3NLZXkgIT09IHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5kXygpO1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKCF0aGlzLnBvb2wpIHsgICAgXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ3JlYXRlIGNvbm5lY3Rpb24gcG9vbCB0byAke2NzS2V5fWApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLnBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLnBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLmFkZChjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgQ29ubmVjdCB0byAke2NzS2V5fWApO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBgRGlzY29ubmVjdCBmcm9tICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGxldCBpc29sYXRpb25MZXZlbCA9IF8uZmluZChNeVNRTENvbm5lY3Rvci5Jc29sYXRpb25MZXZlbHMsICh2YWx1ZSwga2V5KSA9PiBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSBrZXkgfHwgb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0gdmFsdWUpO1xuICAgICAgICAgICAgaWYgKCFpc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGlzb2xhdGlvbiBsZXZlbDogXCIke2lzb2xhdGlvbkxldmVsfVwiIVwiYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIFRSQU5TQUNUSU9OIElTT0xBVElPTiBMRVZFTCAnICsgaXNvbGF0aW9uTGV2ZWwpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgY29ubi5iZWdpblRyYW5zYWN0aW9uKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ0NvbW1pdHMgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5yb2xsYmFjaygpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnUm9sbGJhY2tzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuICAgICBcbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmV4dHJhSW5mbyB8fCAoZXJyLmV4dHJhSW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5leHRyYUluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuZXh0cmFJbmZvLnBhcmFtcyA9IHBhcmFtcztcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgeyBpbnNlcnRJZ25vcmUsIC4uLnJlc3RPcHRpb25zIH0gPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICAgIGxldCBzcWwgPSBgSU5TRVJUICR7aW5zZXJ0SWdub3JlID8gXCJJR05PUkUgXCI6XCJcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgYXN5bmMgaW5zZXJ0TWFueV8obW9kZWwsIGZpZWxkcywgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZGF0YVwiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmRzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImZpZWxkc1wiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRldjoge1xuICAgICAgICAgICAgZGF0YS5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvdykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VsZW1lbnQgb2YgXCJkYXRhXCIgYXJyYXkgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZCB2YWx1ZXMuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgPyBcIklHTk9SRSBcIjpcIlwifUlOVE8gPz8gKCR7ZmllbGRzLm1hcChmID0+IHRoaXMuZXNjYXBlSWQoZikpLmpvaW4oJywgJyl9KSBWQUxVRVMgP2A7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCByZXN0T3B0aW9ucyk7IFxuICAgIH1cblxuICAgIGluc2VydE9uZV8gPSB0aGlzLmNyZWF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5IFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnlPcHRpb25zICBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwZGF0ZV8obW9kZWwsIGRhdGEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgIFxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdEYXRhIHJlY29yZCBpcyBlbXB0eS4nLCB7IG1vZGVsLCBxdWVyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCAnICsgdGhpcy5fc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKS5qb2luKCcsJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgICAgIHNxbCArPSAnIFNFVCA/JztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHVwZGF0ZU9uZV8gPSB0aGlzLnVwZGF0ZV87XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0RFTEVURSBGUk9NID8/IFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCBjb25kaXRpb24sIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGNvbm5PcHRpb25zID0geyAuLi5jb25uT3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pOyBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUFsaWFzKGluZGV4LCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChpbmRleCk7XG5cbiAgICAgICAgaWYgKHRoaXMub3B0aW9ucy52ZXJib3NlQWxpYXMpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnNuYWtlQ2FzZShhbmNob3IpLnRvVXBwZXJDYXNlKCkgKyAnXycgKyBhbGlhcztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhbGlhcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGFzc29jaWF0aW9ucyBpbnRvIGpvaW5pbmcgY2xhdXNlcy5cbiAgICAgKiAge1xuICAgICAqICAgICAgZW50aXR5OiA8cmVtb3RlIGVudGl0eT5cbiAgICAgKiAgICAgIGpvaW5UeXBlOiAnTEVGVCBKT0lOfElOTkVSIEpPSU58RlVMTCBPVVRFUiBKT0lOJ1xuICAgICAqICAgICAgYW5jaG9yOiAnbG9jYWwgcHJvcGVydHkgdG8gcGxhY2UgdGhlIHJlbW90ZSBlbnRpdHknXG4gICAgICogICAgICBsb2NhbEZpZWxkOiA8bG9jYWwgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHJlbW90ZUZpZWxkOiA8cmVtb3RlIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICBzdWJBc3NvY2lhdGlvbnM6IHsgLi4uIH1cbiAgICAgKiAgfVxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NpYXRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXNLZXkgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhcyBcbiAgICAgKiBAcGFyYW0geyp9IGFsaWFzTWFwIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQXNzb2NpYXRpb25zKGFzc29jaWF0aW9ucywgcGFyZW50QWxpYXNLZXksIHBhcmVudEFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKSB7XG4gICAgICAgIGxldCBqb2luaW5ncyA9IFtdO1xuXG4gICAgICAgIC8vY29uc29sZS5sb2coJ2Fzc29jaWF0aW9uczonLCBPYmplY3Qua2V5cyhhc3NvY2lhdGlvbnMpKTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoYXNzb2NJbmZvLCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvY0luZm8uYWxpYXMgfHwgdGhpcy5fZ2VuZXJhdGVBbGlhcyhzdGFydElkKyssIGFuY2hvcik7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIG9uIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGpvaW5UeXBlIHx8IChqb2luVHlwZSA9ICdMRUZUIEpPSU4nKTtcblxuICAgICAgICAgICAgaWYgKGFzc29jSW5mby5zcWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NJbmZvLm91dHB1dCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzTWFwW3BhcmVudEFsaWFzS2V5ICsgJy4nICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgeyBlbnRpdHksIHN1YkFzc29jcyB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgICAgICAgICAgICAgXG4gICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcblxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcywgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+ICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24oYywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKScpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGFuZF8nKSkgeyAvLyBmb3IgYXZvaWRpbmcgZHVwbGlhdGUsICRvcl8xLCAkb3JfMiBpcyB2YWxpZFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJyB8fCBrZXkuc3RhcnRzV2l0aCgnJG9yXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKChrZXkgPT09ICckZXhwcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRleHByXycpKSAmJiB2YWx1ZS5vb3JUeXBlICYmIHZhbHVlLm9vclR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLnJpZ2h0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbmRpdGlvbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgY29uZGl0aW9uIVxcbiBWYWx1ZTogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW2FsaWFzS2V5XTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2cobWFpbkVudGl0eSwgYWxpYXNLZXksIGFsaWFzTWFwKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX0uIFBsZWFzZSBjaGVjayAkYXNzb2NpYXRpb24gdmFsdWUuYDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBfLm1hcChkYXRhLCAodiwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xLCAnQ29sdW1uIG9mIGRpcmVjdCBpbnB1dCBkYXRhIGNhbm5vdCBiZSBhIGRvdC1zZXBhcmF0ZWQgbmFtZS4nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSArICc9JyArIHRoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX3BhY2tBcnJheShhcnJheSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gYXJyYXkubWFwKHZhbHVlID0+IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywnKTtcbiAgICB9XG5cbiAgICBfcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHN3aXRjaCAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdDb2x1bW5SZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdGdW5jdGlvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubmFtZSArICcoJyArICh2YWx1ZS5hcmdzID8gdGhpcy5fcGFja0FycmF5KHZhbHVlLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcblxuICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9vciB0eXBlOiAke3ZhbHVlLm9vclR5cGV9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YWx1ZSA9IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuICc/JztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHsgJGluOiB2YWx1ZSB9LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGhhc09wZXJhdG9yID0gXy5maW5kKE9iamVjdC5rZXlzKHZhbHVlKSwgayA9PiBrICYmIGtbMF0gPT09ICckJyk7XG5cbiAgICAgICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiBfLm1hcCh2YWx1ZSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGsgJiYga1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvcGVyYXRvclxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGV4aXN0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKHYgPyAnIElTIE5PVCBOVUxMJyA6ICdJUyBOVUxMJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKSArICcpJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ID8nO1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0XCIgb3IgXCIkPFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDw9JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogLy8gZm9yIGRhdGV0aW1lIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElOICg/KSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5pbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRXaXRoJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kc1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGVuZFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlcyc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRhcHBseSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhcmdzID0gdmFsdWUuYXJncyA/IFsgZmllbGROYW1lIF0uY29uY2F0KHZhbHVlLmFyZ3MpIDogWyBmaWVsZE5hbWUgXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubmFtZSArICcoJyArIHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSA9ICdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgcGFyYW1zLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaXNRdW90ZWQoY29sKSA/IGNvbCA6IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gY29sO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb2wpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcykge1xuICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChjb2wuYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29sLm5hbWUudG9VcHBlckNhc2UoKSA9PT0gJ0NPVU5UJyAmJiBjb2wuYXJncy5sZW5ndGggPT09IDEgJiYgY29sLmFyZ3NbMF0gPT09ICcqJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ0NPVU5UKCopJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gY29sLm5hbWUgKyAnKCcgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdleHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbC5leHByLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPT09IGZhbHNlIHx8IGFzYyA9PSAnLTEnID8gJyBERVNDJyA6ICcnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbk15U1FMQ29ubmVjdG9yLmRyaXZlckxpYiA9IG15c3FsO1xuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==
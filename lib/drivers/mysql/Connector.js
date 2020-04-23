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
    let sql = `INSERT ${insertIgnore && "IGNORE "}INTO ?? SET ?`;
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
    let sql = `INSERT ${insertIgnore && "IGNORE "}INTO ?? (${fields.map(f => this.escapeId(f)).join(', ')}) VALUES ?`;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJfIiwiZWFjaEFzeW5jXyIsInNldFZhbHVlQnlQYXRoIiwicmVxdWlyZSIsInRyeVJlcXVpcmUiLCJteXNxbCIsIkNvbm5lY3RvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsInJlbGF0aW9uYWwiLCJhY2l0dmVDb25uZWN0aW9ucyIsIldlYWtTZXQiLCJlbmRfIiwic2l6ZSIsImNvbm4iLCJkaXNjb25uZWN0XyIsInBvb2wiLCJsb2ciLCJjdXJyZW50Q29ubmVjdGlvblN0cmluZyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsIm1ha2VOZXdDb25uZWN0aW9uU3RyaW5nIiwiY3JlYXRlUG9vbCIsImdldENvbm5lY3Rpb24iLCJhZGQiLCJkZWxldGUiLCJyZWxlYXNlIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJpc29sYXRpb25MZXZlbCIsImZpbmQiLCJJc29sYXRpb25MZXZlbHMiLCJ2YWx1ZSIsImtleSIsInF1ZXJ5IiwiYmVnaW5UcmFuc2FjdGlvbiIsImNvbW1pdF8iLCJjb21taXQiLCJyb2xsYmFja18iLCJyb2xsYmFjayIsImV4ZWN1dGVfIiwic3FsIiwicGFyYW1zIiwiX2dldENvbm5lY3Rpb25fIiwidXNlUHJlcGFyZWRTdGF0ZW1lbnQiLCJsb2dTdGF0ZW1lbnQiLCJyb3dzQXNBcnJheSIsImV4ZWN1dGUiLCJyb3dzMSIsInJvd3MyIiwiZXJyIiwiZXh0cmFJbmZvIiwidHJ1bmNhdGUiLCJsZW5ndGgiLCJfcmVsZWFzZUNvbm5lY3Rpb25fIiwicGluZ18iLCJwaW5nIiwicmVzdWx0IiwibW9kZWwiLCJkYXRhIiwiaXNFbXB0eSIsImluc2VydElnbm9yZSIsInJlc3RPcHRpb25zIiwicHVzaCIsImluc2VydE1hbnlfIiwiZmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsInJvdyIsIm1hcCIsImYiLCJqb2luIiwicXVlcnlPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwicCIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiY29uZGl0aW9uIiwiZmluZF8iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJuIiwiY29uY2F0IiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJrZXlzIiwib29yVHlwZSIsImxlZnQiLCJfcGFja1ZhbHVlIiwicmlnaHQiLCJvcCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJjb25zb2xlIiwibXNnIiwidiIsImluZGV4T2YiLCJfcGFja0FycmF5IiwiYXJyYXkiLCJuYW1lIiwiYXJncyIsImluamVjdCIsImlzTmlsIiwiJGluIiwiaGFzT3BlcmF0b3IiLCJrIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsIm9taXQiLCJ0eXBlIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwiZHJpdmVyTGliIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7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ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGliJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJyk7XG5jb25zdCBDb25uZWN0b3IgPSByZXF1aXJlKCcuLi8uLi9Db25uZWN0b3InKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIEZsYXQgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB0byBpbXByb3ZlIHF1ZXJ5IHBlcmZvcm1hbmNlLiBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLmxvZ1N0YXRlbWVudF0gLSBGbGFnIHRvIGxvZyBleGVjdXRlZCBTUUwgc3RhdGVtZW50LlxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLnJlbGF0aW9uYWwgPSB0cnVlO1xuICAgICAgICB0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IFdlYWtTZXQoKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGlmICh0aGlzLmFjaXR2ZUNvbm5lY3Rpb25zLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGlzLnBvb2wpIHtcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIGBFbmQgY29ubmVjdGlvbiBwb29sIHRvICR7dGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZ31gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wb29sLmVuZCgpO1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMucG9vbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZykge1xuICAgICAgICAgICAgdGhpcy5jdXJyZW50Q29ubmVjdGlvblN0cmluZyA9IGNzS2V5O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5tYWtlTmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgaWYgKGNzS2V5ICE9PSB0aGlzLmN1cnJlbnRDb25uZWN0aW9uU3RyaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuZF8oKTtcbiAgICAgICAgICAgIHRoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmcgPSBjc0tleTtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmICghdGhpcy5wb29sKSB7ICAgIFxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENyZWF0ZSBjb25uZWN0aW9uIHBvb2wgdG8gJHtjc0tleX1gKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5wb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5wb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5hY2l0dmVDb25uZWN0aW9ucy5hZGQoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYENvbm5lY3QgdG8gJHtjc0tleX1gKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgYERpc2Nvbm5lY3QgZnJvbSAke3RoaXMuY3VycmVudENvbm5lY3Rpb25TdHJpbmd9YCk7XG4gICAgICAgIHRoaXMuYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBsZXQgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGNvbm4uYmVnaW5UcmFuc2FjdGlvbigpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4uY29tbWl0KCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgJ1JvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LiAgICAgXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1N0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIGVyci5leHRyYUluZm8gfHwgKGVyci5leHRyYUluZm8gPSB7fSk7XG4gICAgICAgICAgICBlcnIuZXh0cmFJbmZvLnNxbCA9IF8udHJ1bmNhdGUoc3FsLCB7IGxlbmd0aDogMjAwIH0pO1xuICAgICAgICAgICAgZXJyLmV4dHJhSW5mby5wYXJhbXMgPSBwYXJhbXM7XG5cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgaW5zZXJ0SWdub3JlLCAuLi5yZXN0T3B0aW9ucyB9ID0gb3B0aW9ucyB8fCB7fTtcblxuICAgICAgICBsZXQgc3FsID0gYElOU0VSVCAke2luc2VydElnbm9yZSAmJiBcIklHTk9SRSBcIn1JTlRPID8/IFNFVCA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgYXN5bmMgaW5zZXJ0TWFueV8obW9kZWwsIGZpZWxkcywgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1wiZGF0YVwiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiByZWNvcmRzLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdcImZpZWxkc1wiIHRvIGJ1bGsgaW5zZXJ0IHNob3VsZCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRldjoge1xuICAgICAgICAgICAgZGF0YS5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvdykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VsZW1lbnQgb2YgXCJkYXRhXCIgYXJyYXkgdG8gYnVsayBpbnNlcnQgc2hvdWxkIGJlIGFuIGFycmF5IG9mIHJlY29yZCB2YWx1ZXMuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGluc2VydElnbm9yZSwgLi4ucmVzdE9wdGlvbnMgfSA9IG9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbGV0IHNxbCA9IGBJTlNFUlQgJHtpbnNlcnRJZ25vcmUgJiYgXCJJR05PUkUgXCJ9SU5UTyA/PyAoJHtmaWVsZHMubWFwKGYgPT4gdGhpcy5lc2NhcGVJZChmKSkuam9pbignLCAnKX0pIFZBTFVFUyA/YDtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIHJlc3RPcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0RhdGEgcmVjb3JkIGlzIGVtcHR5LicsIHsgbW9kZWwsIHF1ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkobW9kZWwsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5jb3VudFNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2Uoc3FsSW5mby5hbGlhc01hcCwgKHJlc3VsdCwgYWxpYXMsIG5vZGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2FsaWFzXSA9IG5vZGVQYXRoLnNwbGl0KCcuJykuc2xpY2UoMSkubWFwKG4gPT4gJzonICsgbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXAsIHRvdGFsQ291bnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXApO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihyZXN1bHQsIHsgZGVwdGg6IDEwLCBjb2xvcnM6IHRydWUgfSk7IFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgLy9jb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyAgICAgICAgICAgICBcbiAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NzLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleS5zdGFydHNXaXRoKCckYW5kXycpKSB7IC8vIGZvciBhdm9pZGluZyBkdXBsaWF0ZSwgJG9yXzEsICRvcl8yIGlzIHZhbGlkXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InIHx8IGtleS5zdGFydHNXaXRoKCckb3JfJykpIHsgLy8gZm9yIGF2b2lkaW5nIGR1cGxpYXRlLCAkb3JfMSwgJG9yXzIgaXMgdmFsaWRcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoKGtleSA9PT0gJyRleHByJyB8fCBrZXkuc3RhcnRzV2l0aCgnJGV4cHJfJykpICYmIHZhbHVlLm9vclR5cGUgJiYgdmFsdWUub29yVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLmxlZnQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBtYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpO1xuICAgICAgICAgICAgbGV0IGFsaWFzID0gYWxpYXNNYXBbYWxpYXNLZXldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhtYWluRW50aXR5LCBhbGlhc0tleSwgYWxpYXNNYXApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IG1zZyA9IGBVbmtub3duIGNvbHVtbiByZWZlcmVuY2U6ICR7ZmllbGROYW1lfS4gUGxlYXNlIGNoZWNrICRhc3NvY2lhdGlvbiB2YWx1ZS5gOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KG1zZyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyAoZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgeyAgIFxuXG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIF9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwKGRhdGEsICh2LCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGROYW1lLmluZGV4T2YoJy4nKSA9PT0gLTEsICdDb2x1bW4gb2YgZGlyZWN0IGlucHV0IGRhdGEgY2Fubm90IGJlIGEgZG90LXNlcGFyYXRlZCBuYW1lLic7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpICsgJz0nICsgdGhpcy5fcGFja1ZhbHVlKHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfcGFja0FycmF5KGFycmF5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBhcnJheS5tYXAodmFsdWUgPT4gdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCcpO1xuICAgIH1cblxuICAgIF9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgc3dpdGNoICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0NvbHVtblJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgKHZhbHVlLmFyZ3MgPyB0aGlzLl9wYWNrQXJyYXkodmFsdWUuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG5cbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5sZWZ0LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByaWdodCA9IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZS5yaWdodCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArIGAgJHt2YWx1ZS5vcH0gYCArIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb29yIHR5cGU6ICR7dmFsdWUub29yVHlwZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gJz8nO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgeyAkaW46IHZhbHVlIH0sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB0aGlzLl9wYWNrVmFsdWUodmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXhpc3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAodiA/ICcgSVMgTk9UIE5VTEwnIDogJ0lTIE5VTEwnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSovXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qIC8vIGZvciBkYXRldGltZSB0eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvKiAvLyBmb3IgZGF0ZXRpbWUgdHlwZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGFwcGx5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFyZ3MgPSB2YWx1ZS5hcmdzID8gWyBmaWVsZE5hbWUgXS5jb25jYXQodmFsdWUuYXJncykgOiBbIGZpZWxkTmFtZSBdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5uYW1lICsgJygnICsgdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpID0gJ1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICBwYXJhbXMucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcGFyYW1zLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGlmIChjb2wubmFtZS50b1VwcGVyQ2FzZSgpID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBjb2wubmFtZSArICcoJyArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA9PT0gZmFsc2UgfHwgYXNjID09ICctMScgPyAnIERFU0MnIDogJycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuTXlTUUxDb25uZWN0b3IuZHJpdmVyTGliID0gbXlzcWw7XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19
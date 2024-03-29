"use strict";

require("source-map-support/register");
const {
  _
} = require('@genx/july');
const SupportedDrivers = ['mysql', 'mongodb', 'rabbitmq'];
const JsPrimitiveTypes = new Set(['number', 'boolean', 'string', 'symbol', 'undefined']);
function mergeCondition(condition1, condition2, operator = '$and') {
  if (_.isEmpty(condition1)) {
    return condition2;
  }
  if (_.isEmpty(condition2)) {
    return condition1;
  }
  return {
    [operator]: [condition1, condition2]
  };
}
exports.isNothing = v => _.isNil(v) || _.isNaN(v);
exports.isPrimitive = v => JsPrimitiveTypes.has(typeof v);
exports.isQuoted = s => (s.startsWith("'") || s.startsWith('"')) && s[0] === s[s.length - 1];
exports.isQuotedWith = (s, q) => s.startsWith(q) && s[0] === s[s.length - 1];
exports.makeDataSourceName = (driver, schema) => driver + '.' + schema;
exports.extractDriverAndConnectorName = id => id.split('.');
exports.mergeCondition = mergeCondition;
exports.SupportedDrivers = Object.freeze(SupportedDrivers);
const $col = name => ({
  oorType: 'ColumnReference',
  name
});
const $expr = (left, op, right) => ({
  oorType: 'BinaryExpression',
  left,
  op,
  right
});
const $raw = statement => ({
  oorType: 'Raw',
  statement
});
const $query = query => ({
  oorType: 'Query',
  query
});
const $f = (name, ...args) => ({
  oorType: 'Function',
  name,
  args
});
const $inc = (field, increment) => $expr($col(field), '+', increment);
const $dec = (field, decrement) => $expr($col(field), '-', decrement);
const $dataSet = (model, query) => ({
  oorType: 'DataSet',
  model,
  query
});
const $sql = sql => ({
  oorType: 'SQL',
  sql
});
exports.$col = $col;
exports.$raw = $raw;
exports.$query = $query;
exports.$expr = $expr;
exports.$f = $f;
exports.$func = $f;
exports.$inc = $inc;
exports.$dec = $dec;
exports.$increase = $inc;
exports.$decrease = $dec;
exports.$dataSet = $dataSet;
exports.$select = $dataSet;
exports.$sql = $sql;
exports.hasValueIn = (arrayOfColl, key) => _.find(arrayOfColl, coll => coll[key] != null);
exports.getValueFrom = (arrayOfColl, key) => {
  const l = arrayOfColl.length;
  for (let i = 0; i < l; i++) {
    const coll = arrayOfColl[i];
    const value = coll && coll[key];
    if (value != null) return value;
  }
  return undefined;
};
const mapFilterReducerArray = (predicate, mapper) => (result, value) => {
  if (predicate(value)) {
    result.push(mapper(value));
  }
  return result;
};
const mapFilterReducerObject = (predicate, mapper) => (result, value, key) => {
  if (predicate(value)) {
    result[key] = mapper(value);
  }
  return result;
};
exports.mapFilter = (collection, predicate, mapper) => Array.isArray(collection) ? _.reduce(collection, mapFilterReducerArray(predicate, mapper), []) : _.reduce(collection, mapFilterReducerObject(predicate, mapper), {});
//# sourceMappingURL=lang.js.map
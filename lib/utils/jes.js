"use strict";

require("source-map-support/register");

const {
  _,
  hasKeyByPath
} = require('rk-utils');

const {
  ValidationError
} = require('./Errors');

const OPERATOR_NOT_ALONE = 'Query operator can only be used alone in a stage.';
const NOT_A_UNARY_QUERY = 'Only unary query operator is allowed to be used directly in a matching.';
const INVALID_EXPR_SYNTAX = 'Invalid expression syntax.';

const INVALID_QUERY_OPERATOR = token => `Invalid JES query operator "${token}".`;

const INVALID_TEST_OPERATOR = token => `Invalid JES test operator "${token}".`;

const INVALID_QUERY_HANDLER = op => `JES query operator "${op}" handler not found.`;

const INVALID_TEST_HANLDER = op => `JES test operator "${op}" handler not found.`;

const INVALID_COLLECTION_OP = op => `Invalid collection operator "${op}".`;

const PRX_OP_NOT_FOR_EVAL = prefix => `Operator prefix "${prefix}" cannot be used in evaluation.`;

const OPERAND_NOT_TUPLE = op => `The operand of a collection operator ${op ? '" + op + " ' : ''}must be a two-tuple.`;

const OPERAND_NOT_TUPLE_2_OR_3 = op => `The operand of a "${op}" operator must be either a 2-tuple or a 3-tuple.`;

const OPERAND_NOT_ARRAY = op => `The operand of a "${op}" operator must be an array.`;

const OPERAND_NOT_BOOL = op => `The operand of a "${op}" operator must be a boolean value.`;

const OPERAND_NOT_STRING = op => `The operand of a "${op}" operator must be a string.`;

const VALUE_NOT_COLLECTION = op => `The value using a "${op}" operator must be either an object or an array.`;

const REQUIRE_RIGHT_OPERAND = op => `Binary query operator "${op}" requires the right operand.`;

const OP_EQUAL = ['$eq', '$eql', '$equal'];
const OP_NOT_EQUAL = ['$ne', '$neq', '$notEqual'];
const OP_NOT = ['$not'];
const OP_GREATER_THAN = ['$gt', '$>', '$greaterThan'];
const OP_GREATER_THAN_OR_EQUAL = ['$gte', '$<=', '$greaterThanOrEqual'];
const OP_LESS_THAN = ['$lt', '$<', '$lessThan'];
const OP_LESS_THAN_OR_EQUAL = ['$lte', '$<=', '$lessThanOrEqual'];
const OP_IN = ['$in'];
const OP_NOT_IN = ['$nin', '$notIn'];
const OP_EXISTS = ['$exist', '$exists', '$notNull'];
const OP_MATCH = ['$has', '$match', '$all'];
const OP_MATCH_ANY = ['$any', '$or', '$either'];
const OP_TYPE = ['$is', '$typeOf'];
const OP_HAS_KEYS = ['$hasKeys', '$withKeys'];
const OP_START_WITH = ['$startWith', '$startsWith'];
const OP_END_WITH = ['$endWith', '$endsWith'];
const OP_SIZE = ['$size', '$length', '$count'];
const OP_SUM = ['$sum', '$total'];
const OP_KEYS = ['$keys'];
const OP_VALUES = ['$values'];
const OP_GET_TYPE = ['$type'];
const OP_ADD = ['$add', '$plus', '$inc'];
const OP_SUB = ['$sub', '$subtract', '$minus', '$dec'];
const OP_MUL = ['$mul', '$multiply', '$times'];
const OP_DIV = ['$div', '$divide'];
const OP_SET = ['$set', '$='];
const OP_ADD_ITEM = ['$addItem'];
const OP_PICK = ['$pick'];
const OP_GET_BY_INDEX = ['$at', '$getByIndex', '$nth'];
const OP_GET_BY_KEY = ['$of', '$getByKey'];
const OP_OMIT = ['$omit'];
const OP_GROUP = ['$group', '$groupBy'];
const OP_SORT = ['$sort', '$orderBy', '$sortBy'];
const OP_REVERSE = ['$reverse'];
const OP_EVAL = ['$eval', '$apply'];
const OP_MERGE = ['$merge'];
const OP_IF = ['$if'];
const PFX_FOR_EACH = '|>';
const PFX_WITH_ANY = '|*';
const MapOfOps = new Map();

const addOpToMap = (tokens, tag) => tokens.forEach(token => MapOfOps.set(token, tag));

addOpToMap(OP_EQUAL, 'OP_EQUAL');
addOpToMap(OP_NOT_EQUAL, 'OP_NOT_EQUAL');
addOpToMap(OP_NOT, 'OP_NOT');
addOpToMap(OP_GREATER_THAN, 'OP_GREATER_THAN');
addOpToMap(OP_GREATER_THAN_OR_EQUAL, 'OP_GREATER_THAN_OR_EQUAL');
addOpToMap(OP_LESS_THAN, 'OP_LESS_THAN');
addOpToMap(OP_LESS_THAN_OR_EQUAL, 'OP_LESS_THAN_OR_EQUAL');
addOpToMap(OP_IN, 'OP_IN');
addOpToMap(OP_NOT_IN, 'OP_NOT_IN');
addOpToMap(OP_EXISTS, 'OP_EXISTS');
addOpToMap(OP_MATCH, 'OP_MATCH');
addOpToMap(OP_MATCH_ANY, 'OP_MATCH_ANY');
addOpToMap(OP_TYPE, 'OP_TYPE');
addOpToMap(OP_HAS_KEYS, 'OP_HAS_KEYS');
addOpToMap(OP_START_WITH, 'OP_START_WITH');
addOpToMap(OP_END_WITH, 'OP_END_WITH');
const MapOfMans = new Map();

const addManToMap = (tokens, tag) => tokens.forEach(token => MapOfMans.set(token, tag));

addManToMap(OP_SIZE, ['OP_SIZE', true]);
addManToMap(OP_SUM, ['OP_SUM', true]);
addManToMap(OP_KEYS, ['OP_KEYS', true]);
addManToMap(OP_VALUES, ['OP_VALUES', true]);
addManToMap(OP_GET_TYPE, ['OP_GET_TYPE', true]);
addManToMap(OP_REVERSE, ['OP_REVERSE', true]);
addManToMap(OP_ADD, ['OP_ADD', false]);
addManToMap(OP_SUB, ['OP_SUB', false]);
addManToMap(OP_MUL, ['OP_MUL', false]);
addManToMap(OP_DIV, ['OP_DIV', false]);
addManToMap(OP_SET, ['OP_SET', false]);
addManToMap(OP_ADD_ITEM, ['OP_ADD_ITEM', false]);
addManToMap(OP_PICK, ['OP_PICK', false]);
addManToMap(OP_GET_BY_INDEX, ['OP_GET_BY_INDEX', false]);
addManToMap(OP_GET_BY_KEY, ['OP_GET_BY_KEY', false]);
addManToMap(OP_OMIT, ['OP_OMIT', false]);
addManToMap(OP_GROUP, ['OP_GROUP', false]);
addManToMap(OP_SORT, ['OP_SORT', false]);
addManToMap(OP_EVAL, ['OP_EVAL', false]);
addManToMap(OP_MERGE, ['OP_MERGE', false]);
addManToMap(OP_IF, ['OP_IF', false]);
const defaultJesHandlers = {
  OP_EQUAL: (left, right) => _.isEqual(left, right),
  OP_NOT_EQUAL: (left, right) => !_.isEqual(left, right),
  OP_NOT: (left, ...args) => !test(left, 'OP_MATCH', ...args),
  OP_GREATER_THAN: (left, right) => left > right,
  OP_GREATER_THAN_OR_EQUAL: (left, right) => left >= right,
  OP_LESS_THAN: (left, right) => left < right,
  OP_LESS_THAN_OR_EQUAL: (left, right) => left <= right,
  OP_IN: (left, right) => {
    if (right == null) return false;

    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_IN'));
    }

    return right.find(element => defaultJesHandlers.OP_EQUAL(left, element));
  },
  OP_NOT_IN: (left, right) => {
    if (right == null) return true;

    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_NOT_IN'));
    }

    return _.every(right, element => defaultJesHandlers.OP_NOT_EQUAL(left, element));
  },
  OP_EXISTS: (left, right) => {
    if (typeof right !== 'boolean') {
      throw new Error(OPERAND_NOT_BOOL('OP_EXISTS'));
    }

    return right ? left != null : left == null;
  },
  OP_TYPE: (left, right) => {
    if (typeof right !== 'string') {
      throw new Error(OPERAND_NOT_STRING('OP_TYPE'));
    }

    right = right.toLowerCase();

    if (right === 'array') {
      return Array.isArray(left);
    }

    if (right === 'integer') {
      return _.isInteger(left);
    }

    if (right === 'text') {
      return typeof left === 'string';
    }

    return typeof left === right;
  },
  OP_MATCH: (left, right, jes, prefix) => {
    if (Array.isArray(right)) {
      return _.every(right, rule => {
        const r = match(left, rule, jes, prefix);
        return r[0];
      });
    }

    const r = match(left, right, jes, prefix);
    return r[0];
  },
  OP_MATCH_ANY: (left, right, jes, prefix) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_MATCH_ANY'));
    }

    let found = _.find(right, rule => {
      const r = match(left, rule, jes, prefix);
      return r[0];
    });

    return found ? true : false;
  },
  OP_HAS_KEYS: (left, right) => {
    if (typeof left !== "object") return false;
    return _.every(right, key => hasKeyByPath(left, key));
  },
  OP_START_WITH: (left, right) => {
    if (typeof left !== "string") return false;

    if (typeof right !== 'string') {
      throw new Error(OPERAND_NOT_STRING('OP_START_WITH'));
    }

    return left.startsWith(right);
  },
  OP_END_WITH: (left, right) => {
    if (typeof left !== "string") return false;

    if (typeof right !== 'string') {
      throw new Error(OPERAND_NOT_STRING('OP_END_WITH'));
    }

    return left.endsWith(right);
  }
};
const defaultManipulations = {
  OP_SIZE: left => _.size(left),
  OP_SUM: left => _.reduce(left, (sum, item) => {
    sum += item;
    return sum;
  }, 0),
  OP_KEYS: left => _.keys(left),
  OP_VALUES: left => _.values(left),
  OP_GET_TYPE: left => Array.isArray(left) ? 'array' : _.isInteger(left) ? 'integer' : typeof left,
  OP_REVERSE: left => _.reverse(left),
  OP_ADD: (left, right) => left + right,
  OP_SUB: (left, right) => left - right,
  OP_MUL: (left, right) => left * right,
  OP_DIV: (left, right) => left / right,
  OP_SET: (left, right, jes, prefix, context) => evaluateExpr(undefined, right, jes, prefix, context, true),
  OP_ADD_ITEM: (left, right, jes, prefix, context) => {
    if (typeof left !== "object") {
      throw new ValidationError(VALUE_NOT_COLLECTION('OP_ADD_ITEM'));
    }

    if (Array.isArray(left)) {
      return left.concat(right);
    }

    if (!Array.isArray(right) || right.length !== 2) {
      throw new Error(OPERAND_NOT_TUPLE('OP_ADD_ITEM'));
    }

    return { ...left,
      [right[0]]: evaluateExpr(undefined, right[1], jes, prefix, context, true)
    };
  },
  OP_PICK: (left, right, jes, prefix) => {
    if (left == null) return null;

    if (typeof right !== "object") {
      right = _.castArray(right);
    }

    if (Array.isArray(right)) {
      return _.pick(left, right);
    }

    return _.pickBy(left, (x, key) => match(key, right, jes, prefix)[0]);
  },
  OP_GET_BY_INDEX: (left, right) => _.nth(left, right),
  OP_GET_BY_KEY: (left, right) => _.get(left, right),
  OP_OMIT: (left, right) => left == null ? null : _.omit(left, right),
  OP_GROUP: (left, right) => _.groupBy(left, right),
  OP_SORT: (left, right) => _.sortBy(left, right),
  OP_EVAL: evaluateExpr,
  OP_MERGE: (left, right, jes, prefix, context) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_MERGE'));
    }

    return right.reduce((result, expr) => Object.assign(result, evaluateExpr(left, expr, jes, prefix, { ...context
    })), {});
  },
  OP_IF: (left, right, jes, prefix, context) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_IF'));
    }

    if (right.length < 2 || right.length > 3) {
      throw new Error(OPERAND_NOT_TUPLE_2_OR_3('OP_IF'));
    }

    const condition = evaluateExpr(undefined, right[0], jes, prefix, context, true);

    if (test(left, 'OP_MATCH', condition, jes, prefix)) {
      return evaluateExpr(left, right[1], jes, prefix, context);
    } else if (right.length > 2) {
      const ret = evaluateExpr(left, right[2], jes, prefix, context);
      return ret;
    }

    return left;
  }
};

const formatName = (name, prefix) => {
  const fullName = name == null ? prefix : formatPrefix(name, prefix);
  return fullName == null ? "The value" : fullName.indexOf('(') !== -1 ? `The query "_.${fullName}"` : `"${fullName}"`;
};

const formatKey = (key, hasPrefix) => _.isInteger(key) ? `[${key}]` : hasPrefix ? '.' + key : key;

const formatPrefix = (key, prefix) => prefix != null ? `${prefix}${formatKey(key, true)}` : formatKey(key, false);

const formatQuery = opMeta => `${defaultQueryExplanations[opMeta[0]]}(${opMeta[1] ? '' : '?'})`;

const formatMap = name => `each(->${name})`;

const formatAny = name => `any(->${name})`;

const defaultJesExplanations = {
  OP_EQUAL: (name, left, right, prefix) => `${formatName(name, prefix)} should be ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_NOT_EQUAL: (name, left, right, prefix) => `${formatName(name, prefix)} should not be ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_NOT: (name, left, right, prefix) => `${formatName(name, prefix)} should not match ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_GREATER_THAN: (name, left, right, prefix) => `${formatName(name, prefix)} should be greater than ${right}, but ${JSON.stringify(left)} given.`,
  OP_GREATER_THAN_OR_EQUAL: (name, left, right, prefix) => `${formatName(name, prefix)} should be greater than or equal to ${right}, but ${JSON.stringify(left)} given.`,
  OP_LESS_THAN: (name, left, right, prefix) => `${formatName(name, prefix)} should be less than ${right}, but ${JSON.stringify(left)} given.`,
  OP_LESS_THAN_OR_EQUAL: (name, left, right, prefix) => `${formatName(name, prefix)} should be less than or equal to ${right}, but ${JSON.stringify(left)} given.`,
  OP_IN: (name, left, right, prefix) => `${formatName(name, prefix)} should be one of ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_NOT_IN: (name, left, right, prefix) => `${formatName(name, prefix)} should not be any one of ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_EXISTS: (name, left, right, prefix) => `${formatName(name, prefix)} should${right ? ' not ' : ' '}be NULL.`,
  OP_TYPE: (name, left, right, prefix) => `The type of ${formatName(name, prefix)} should be "${right}", but ${JSON.stringify(left)} given.`,
  OP_MATCH: (name, left, right, prefix) => `${formatName(name, prefix)} should match ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_MATCH_ANY: (name, left, right, prefix) => `${formatName(name, prefix)} should match any of ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,
  OP_HAS_KEYS: (name, left, right, prefix) => `${formatName(name, prefix)} should have all of these keys [${right.join(', ')}].`,
  OP_START_WITH: (name, left, right, prefix) => `${formatName(name, prefix)} should start with "${right}".`,
  OP_END_WITH: (name, left, right, prefix) => `${formatName(name, prefix)} should end with "${right}".`
};
const defaultQueryExplanations = {
  OP_SIZE: 'size',
  OP_SUM: 'sum',
  OP_KEYS: 'keys',
  OP_VALUES: 'values',
  OP_GET_TYPE: 'get type',
  OP_REVERSE: 'reverse',
  OP_ADD: 'add',
  OP_SUB: 'subtract',
  OP_MUL: 'multiply',
  OP_DIV: 'divide',
  OP_SET: 'assign',
  OP_ADD_ITEM: 'addItem',
  OP_PICK: 'pick',
  OP_GET_BY_INDEX: 'get element at index',
  OP_GET_BY_KEY: 'get element of key',
  OP_OMIT: 'omit',
  OP_GROUP: 'groupBy',
  OP_SORT: 'sortBy',
  OP_EVAL: 'evaluate',
  OP_MERGE: 'merge',
  OP_IF: 'evaluate if'
};

function getUnmatchedExplanation(jes, op, name, leftValue, rightValue, prefix) {
  const getter = jes.operatorExplanations[op] || jes.operatorExplanations.OP_MATCH;
  return getter(name, leftValue, rightValue, prefix);
}

function test(value, op, opValue, jes, prefix) {
  const handler = jes.operatorHandlers[op];

  if (!handler) {
    throw new Error(INVALID_TEST_HANLDER(op));
  }

  return handler(value, opValue, jes, prefix);
}

function evaluate(value, op, opValue, jes, prefix, context) {
  const handler = jes.queryHanlders[op];

  if (!handler) {
    throw new Error(INVALID_QUERY_HANDLER(op));
  }

  return handler(value, opValue, jes, prefix, context);
}

function evaluateUnary(value, op, jes, prefix) {
  const handler = jes.queryHanlders[op];

  if (!handler) {
    throw new Error(INVALID_QUERY_HANDLER(op));
  }

  return handler(value, jes, prefix);
}

function evaluateByOpMeta(currentValue, rightValue, opMeta, jes, prefix, context) {
  if (opMeta[1]) {
    return rightValue ? evaluateUnary(currentValue, opMeta[0], jes, prefix) : currentValue;
  }

  return evaluate(currentValue, opMeta[0], rightValue, jes, prefix, context);
}

const defaultCustomizer = {
  mapOfOperators: MapOfOps,
  mapOfManipulators: MapOfMans,
  operatorHandlers: defaultJesHandlers,
  operatorExplanations: defaultJesExplanations,
  queryHanlders: defaultManipulations
};

function matchCollection(actual, collectionOp, opMeta, operands, jes, prefix) {
  let matchResult, nextPrefix;

  switch (collectionOp) {
    case PFX_FOR_EACH:
      const mapResult = _.isPlainObject(actual) ? _.mapValues(actual, (item, key) => evaluateByOpMeta(item, operands[0], opMeta, jes, formatPrefix(key, prefix))) : _.map(actual, (item, i) => evaluateByOpMeta(item, operands[0], opMeta, jes, formatPrefix(i, prefix)));
      nextPrefix = formatPrefix(formatMap(formatQuery(opMeta)), prefix);
      matchResult = match(mapResult, operands[1], jes, nextPrefix);
      break;

    case PFX_WITH_ANY:
      nextPrefix = formatPrefix(formatAny(formatQuery(opMeta)), prefix);
      matchResult = _.find(actual, (item, key) => match(evaluateByOpMeta(item, operands[0], opMeta, jes, formatPrefix(key, prefix)), operands[1], jes, nextPrefix));
      break;

    default:
      throw new Error(INVALID_COLLECTION_OP(collectionOp));
  }

  if (!matchResult[0]) {
    return matchResult;
  }

  return undefined;
}

function validateCollection(actual, collectionOp, op, expectedFieldValue, jes, prefix) {
  switch (collectionOp) {
    case PFX_FOR_EACH:
      const unmatchedKey = _.findIndex(actual, item => !test(item, op, expectedFieldValue, jes, prefix));

      if (unmatchedKey) {
        return [false, getUnmatchedExplanation(jes, op, unmatchedKey, actual[unmatchedKey], expectedFieldValue, prefix)];
      }

      break;

    case PFX_WITH_ANY:
      const matched = _.find(actual, (item, key) => test(item, op, expectedFieldValue, jes, prefix));

      if (!matched) {
        return [false, getUnmatchedExplanation(jes, op, null, actual, expectedFieldValue, prefix)];
      }

      break;

    default:
      throw new Error(INVALID_COLLECTION_OP(collectionOp));
  }

  return undefined;
}

function evaluateCollection(currentValue, collectionOp, opMeta, expectedFieldValue, jes, prefix, context) {
  switch (collectionOp) {
    case PFX_FOR_EACH:
      return _.map(currentValue, (item, i) => evaluateByOpMeta(item, expectedFieldValue, opMeta, jes, formatPrefix(i, prefix), { ...context,
        $$PARENT: currentValue,
        $$CURRENT: item
      }));

    case PFX_WITH_ANY:
      throw new Error(PRX_OP_NOT_FOR_EVAL(collectionOp));

    default:
      throw new Error(INVALID_COLLECTION_OP(collectionOp));
  }
}

function match(actual, expected, jes, prefix) {
  jes != null || (jes = defaultCustomizer);
  let passObjectCheck = false;

  if (!_.isPlainObject(expected)) {
    if (!test(actual, 'OP_EQUAL', expected, jes, prefix)) {
      return [false, jes.operatorExplanations.OP_EQUAL(null, actual, expected, prefix)];
    }

    return [true];
  }

  for (let fieldName in expected) {
    let expectedFieldValue = expected[fieldName];
    const l = fieldName.length;

    if (l > 1) {
      if (l > 4 && fieldName[0] === '|' && fieldName[2] === '$') {
        if (fieldName[3] === '$') {
          if (!Array.isArray(expectedFieldValue) && expectedFieldValue.length !== 2) {
            throw new Error(OPERAND_NOT_TUPLE());
          }

          const collectionOp = fieldName.substr(0, 2);
          fieldName = fieldName.substr(3);
          const opMeta = jes.mapOfManipulators.get(fieldName);

          if (!opMeta) {
            throw new Error(INVALID_QUERY_OPERATOR(fieldName));
          }

          const matchResult = matchCollection(actual, collectionOp, opMeta, expectedFieldValue, jes, prefix);
          if (matchResult) return matchResult;
          continue;
        } else {
          const collectionOp = fieldName.substr(0, 2);
          fieldName = fieldName.substr(2);
          const op = jes.mapOfOperators.get(fieldName);

          if (!op) {
            throw new Error(INVALID_TEST_OPERATOR(fieldName));
          }

          const matchResult = validateCollection(actual, collectionOp, op, expectedFieldValue, jes, prefix);
          if (matchResult) return matchResult;
          continue;
        }
      }

      if (fieldName[0] === '$') {
        if (l > 2 && fieldName[1] === '$') {
          fieldName = fieldName.substr(1);
          const opMeta = jes.mapOfManipulators.get(fieldName);

          if (!opMeta) {
            throw new Error(INVALID_QUERY_OPERATOR(fieldName));
          }

          if (!opMeta[1]) {
            throw new Error(NOT_A_UNARY_QUERY);
          }

          const queryResult = evaluateUnary(actual, opMeta[0], jes, prefix);
          const matchResult = match(queryResult, expectedFieldValue, jes, formatPrefix(formatQuery(opMeta), prefix));

          if (!matchResult[0]) {
            return matchResult;
          }

          continue;
        }

        const op = jes.mapOfOperators.get(fieldName);

        if (!op) {
          throw new Error(INVALID_TEST_OPERATOR(fieldName));
        }

        if (!test(actual, op, expectedFieldValue, jes, prefix)) {
          return [false, getUnmatchedExplanation(jes, op, null, actual, expectedFieldValue, prefix)];
        }

        continue;
      }
    }

    if (!passObjectCheck) {
      if (actual == null) return [false, jes.operatorExplanations.OP_EXISTS(null, null, true, prefix)];
      const actualType = typeof actual;
      if (actualType !== 'object') return [false, jes.operatorExplanations.OP_TYPE(null, actualType, 'object', prefix)];
    }

    passObjectCheck = true;

    let actualFieldValue = _.get(actual, fieldName);

    if (expectedFieldValue != null && typeof expectedFieldValue === 'object') {
      const [ok, reason] = match(actualFieldValue, expectedFieldValue, jes, formatPrefix(fieldName, prefix));

      if (!ok) {
        return [false, reason];
      }
    } else {
      if (!test(actualFieldValue, 'OP_EQUAL', expectedFieldValue, jes, prefix)) {
        return [false, jes.operatorExplanations.OP_EQUAL(fieldName, actualFieldValue, expectedFieldValue, prefix)];
      }
    }
  }

  return [true];
}

function evaluateExpr(currentValue, expr, jes, prefix, context, setOp) {
  jes != null || (jes = defaultCustomizer);

  if (Array.isArray(expr)) {
    if (setOp) {
      return expr.map(item => evaluateExpr(undefined, item, jes, prefix, { ...context
      }, true));
    }

    return expr.reduce((result, exprItem) => evaluateExpr(result, exprItem, jes, prefix, { ...context
    }), currentValue);
  }

  const typeExpr = typeof expr;

  if (typeExpr === "boolean") {
    if (setOp) return expr;
    return expr ? currentValue : undefined;
  }

  if (typeExpr === "number" || typeExpr === "bigint") {
    if (setOp) return expr;
    throw new Error(INVALID_EXPR_SYNTAX);
  }

  if (typeExpr === 'string') {
    if (expr.startsWith('$$')) {
      const pos = expr.indexOf('.');

      if (pos === -1) {
        return context[expr];
      }

      return _.get(context[expr.substr(0, pos)], expr.substr(pos + 1));
    }

    if (setOp) {
      return expr;
    }

    const opMeta = jes.mapOfManipulators.get(expr);

    if (!opMeta) {
      throw new Error(INVALID_QUERY_OPERATOR(expr));
    }

    if (!opMeta[1]) {
      throw new Error(REQUIRE_RIGHT_OPERAND(expr));
    }

    return evaluateUnary(currentValue, opMeta[0], jes, prefix);
  }

  if (typeExpr !== "object") {
    throw new Error(INVALID_EXPR_SYNTAX);
  }

  if (setOp) {
    return _.mapValues(expr, item => evaluateExpr(undefined, item, jes, prefix, context, true));
  }

  if (context == null) {
    context = {
      $$ROOT: currentValue,
      $$PARENT: null,
      $$CURRENT: currentValue
    };
  }

  let result,
      hasOperator = false;

  for (let fieldName in expr) {
    let expectedFieldValue = expr[fieldName];
    const l = fieldName.length;

    if (l > 1) {
      if (fieldName[0] === '$') {
        if (result) {
          throw new Error(OPERATOR_NOT_ALONE);
        }

        const opMeta = jes.mapOfManipulators.get(fieldName);

        if (!opMeta) {
          throw new Error(INVALID_QUERY_OPERATOR(fieldName));
        }

        result = evaluateByOpMeta(currentValue, expectedFieldValue, opMeta, jes, prefix, context);
        hasOperator = true;
        continue;
      }

      if (l > 3 && fieldName[0] === '|' && fieldName[2] === '$') {
        if (result) {
          throw new Error(OPERATOR_NOT_ALONE);
        }

        const collectionOp = fieldName.substr(0, 2);
        fieldName = fieldName.substr(2);
        const opMeta = jes.mapOfManipulators.get(fieldName);

        if (!opMeta) {
          throw new Error(INVALID_QUERY_OPERATOR(fieldName));
        }

        result = evaluateCollection(currentValue, collectionOp, opMeta, expectedFieldValue, jes, prefix, context);
        hasOperator = true;
        continue;
      }
    }

    if (hasOperator) {
      throw new Error(OPERATOR_NOT_ALONE);
    }

    let compleyKey = fieldName.indexOf('.') !== -1;
    let actualFieldValue = currentValue != null ? compleyKey ? _.get(currentValue, fieldName) : currentValue[fieldName] : undefined;
    const childFieldValue = evaluateExpr(actualFieldValue, expectedFieldValue, jes, formatPrefix(fieldName, prefix), context);

    if (typeof childFieldValue !== 'undefined') {
      result == null && (result = {});

      if (compleyKey) {
        _.set(result, fieldName, childFieldValue);
      } else {
        result[fieldName] = childFieldValue;
      }
    }
  }

  return result;
}

class JES {
  constructor(value, customizer) {
    this.value = value;
    this.customizer = customizer;
  }

  match(expected) {
    const result = match(this.value, expected, this.customizer);
    if (result[0]) return this;
    throw new ValidationError(result[1], {
      actual: this.value,
      expected
    });
  }

  evaluate(expr) {
    return evaluateExpr(this.value, expr, this.customizer);
  }

  update(expr) {
    const value = evaluateExpr(this.value, expr, this.customizer);
    this.value = value;
    return this;
  }

}

JES.match = match;
JES.evaluate = evaluateExpr;
JES.defaultCustomizer = defaultCustomizer;
module.exports = JES;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJOT1RfQV9VTkFSWV9RVUVSWSIsIklOVkFMSURfRVhQUl9TWU5UQVgiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiSU5WQUxJRF9DT0xMRUNUSU9OX09QIiwiUFJYX09QX05PVF9GT1JfRVZBTCIsInByZWZpeCIsIk9QRVJBTkRfTk9UX1RVUExFIiwiT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zIiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiVkFMVUVfTk9UX0NPTExFQ1RJT04iLCJSRVFVSVJFX1JJR0hUX09QRVJBTkQiLCJPUF9FUVVBTCIsIk9QX05PVF9FUVVBTCIsIk9QX05PVCIsIk9QX0dSRUFURVJfVEhBTiIsIk9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCIsIk9QX0xFU1NfVEhBTiIsIk9QX0xFU1NfVEhBTl9PUl9FUVVBTCIsIk9QX0lOIiwiT1BfTk9UX0lOIiwiT1BfRVhJU1RTIiwiT1BfTUFUQ0giLCJPUF9NQVRDSF9BTlkiLCJPUF9UWVBFIiwiT1BfSEFTX0tFWVMiLCJPUF9TVEFSVF9XSVRIIiwiT1BfRU5EX1dJVEgiLCJPUF9TSVpFIiwiT1BfU1VNIiwiT1BfS0VZUyIsIk9QX1ZBTFVFUyIsIk9QX0dFVF9UWVBFIiwiT1BfQUREIiwiT1BfU1VCIiwiT1BfTVVMIiwiT1BfRElWIiwiT1BfU0VUIiwiT1BfQUREX0lURU0iLCJPUF9QSUNLIiwiT1BfR0VUX0JZX0lOREVYIiwiT1BfR0VUX0JZX0tFWSIsIk9QX09NSVQiLCJPUF9HUk9VUCIsIk9QX1NPUlQiLCJPUF9SRVZFUlNFIiwiT1BfRVZBTCIsIk9QX01FUkdFIiwiT1BfSUYiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNvbnRleHQiLCJldmFsdWF0ZUV4cHIiLCJ1bmRlZmluZWQiLCJjb25jYXQiLCJsZW5ndGgiLCJjYXN0QXJyYXkiLCJwaWNrIiwicGlja0J5IiwieCIsIm50aCIsImdldCIsIm9taXQiLCJncm91cEJ5Iiwic29ydEJ5IiwicmVzdWx0IiwiZXhwciIsIk9iamVjdCIsImFzc2lnbiIsImNvbmRpdGlvbiIsInJldCIsImZvcm1hdE5hbWUiLCJuYW1lIiwiZnVsbE5hbWUiLCJmb3JtYXRQcmVmaXgiLCJpbmRleE9mIiwiZm9ybWF0S2V5IiwiaGFzUHJlZml4IiwiZm9ybWF0UXVlcnkiLCJvcE1ldGEiLCJkZWZhdWx0UXVlcnlFeHBsYW5hdGlvbnMiLCJmb3JtYXRNYXAiLCJmb3JtYXRBbnkiLCJkZWZhdWx0SmVzRXhwbGFuYXRpb25zIiwiSlNPTiIsInN0cmluZ2lmeSIsImpvaW4iLCJnZXRVbm1hdGNoZWRFeHBsYW5hdGlvbiIsImxlZnRWYWx1ZSIsInJpZ2h0VmFsdWUiLCJnZXR0ZXIiLCJvcGVyYXRvckV4cGxhbmF0aW9ucyIsInZhbHVlIiwib3BWYWx1ZSIsImhhbmRsZXIiLCJvcGVyYXRvckhhbmRsZXJzIiwiZXZhbHVhdGUiLCJxdWVyeUhhbmxkZXJzIiwiZXZhbHVhdGVVbmFyeSIsImV2YWx1YXRlQnlPcE1ldGEiLCJjdXJyZW50VmFsdWUiLCJkZWZhdWx0Q3VzdG9taXplciIsIm1hcE9mT3BlcmF0b3JzIiwibWFwT2ZNYW5pcHVsYXRvcnMiLCJtYXRjaENvbGxlY3Rpb24iLCJhY3R1YWwiLCJjb2xsZWN0aW9uT3AiLCJvcGVyYW5kcyIsIm1hdGNoUmVzdWx0IiwibmV4dFByZWZpeCIsIm1hcFJlc3VsdCIsImlzUGxhaW5PYmplY3QiLCJtYXBWYWx1ZXMiLCJtYXAiLCJpIiwidmFsaWRhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWRGaWVsZFZhbHVlIiwidW5tYXRjaGVkS2V5IiwiZmluZEluZGV4IiwibWF0Y2hlZCIsImV2YWx1YXRlQ29sbGVjdGlvbiIsIiQkUEFSRU5UIiwiJCRDVVJSRU5UIiwiZXhwZWN0ZWQiLCJwYXNzT2JqZWN0Q2hlY2siLCJmaWVsZE5hbWUiLCJsIiwic3Vic3RyIiwicXVlcnlSZXN1bHQiLCJhY3R1YWxUeXBlIiwiYWN0dWFsRmllbGRWYWx1ZSIsIm9rIiwicmVhc29uIiwic2V0T3AiLCJleHBySXRlbSIsInR5cGVFeHByIiwicG9zIiwiJCRST09UIiwiaGFzT3BlcmF0b3IiLCJjb21wbGV5S2V5IiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFrQixHQUFHLG1EQUEzQjtBQUNBLE1BQU1DLGlCQUFp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LEtBQUt3QyxLQUFOLEVBQWExQixJQUFiLEVBQW1CLEtBQUs2RSxVQUF4QixDQUFuQjtBQUNIOztBQUVEQyxFQUFBQSxNQUFNLENBQUM5RSxJQUFELEVBQU87QUFDVCxVQUFNMEIsS0FBSyxHQUFHeEMsWUFBWSxDQUFDLEtBQUt3QyxLQUFOLEVBQWExQixJQUFiLEVBQW1CLEtBQUs2RSxVQUF4QixDQUExQjtBQUNBLFNBQUtuRCxLQUFMLEdBQWFBLEtBQWI7QUFDQSxXQUFPLElBQVA7QUFDSDs7QUE3Qks7O0FBZ0NWaUQsR0FBRyxDQUFDdkcsS0FBSixHQUFZQSxLQUFaO0FBQ0F1RyxHQUFHLENBQUM3QyxRQUFKLEdBQWU1QyxZQUFmO0FBQ0F5RixHQUFHLENBQUN4QyxpQkFBSixHQUF3QkEsaUJBQXhCO0FBRUE0QyxNQUFNLENBQUNDLE9BQVAsR0FBaUJMLEdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLy8gSlNPTiBFeHByZXNzaW9uIFN5bnRheCAoSkVTKVxuY29uc3QgeyBfLCBoYXNLZXlCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IFZhbGlkYXRpb25FcnJvciB9ID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcblxuLy9FeGNlcHRpb24gbWVzc2FnZXNcbmNvbnN0IE9QRVJBVE9SX05PVF9BTE9ORSA9ICdRdWVyeSBvcGVyYXRvciBjYW4gb25seSBiZSB1c2VkIGFsb25lIGluIGEgc3RhZ2UuJztcbmNvbnN0IE5PVF9BX1VOQVJZX1FVRVJZID0gJ09ubHkgdW5hcnkgcXVlcnkgb3BlcmF0b3IgaXMgYWxsb3dlZCB0byBiZSB1c2VkIGRpcmVjdGx5IGluIGEgbWF0Y2hpbmcuJztcbmNvbnN0IElOVkFMSURfRVhQUl9TWU5UQVggPSAnSW52YWxpZCBleHByZXNzaW9uIHN5bnRheC4nO1xuXG5jb25zdCBJTlZBTElEX1FVRVJZX09QRVJBVE9SID0gdG9rZW4gPT4gYEludmFsaWQgSkVTIHF1ZXJ5IG9wZXJhdG9yIFwiJHt0b2tlbn1cIi5gO1xuY29uc3QgSU5WQUxJRF9URVNUX09QRVJBVE9SID0gdG9rZW4gPT4gYEludmFsaWQgSkVTIHRlc3Qgb3BlcmF0b3IgXCIke3Rva2VufVwiLmA7XG5jb25zdCBJTlZBTElEX1FVRVJZX0hBTkRMRVIgPSBvcCA9PiBgSkVTIHF1ZXJ5IG9wZXJhdG9yIFwiJHtvcH1cIiBoYW5kbGVyIG5vdCBmb3VuZC5gO1xuY29uc3QgSU5WQUxJRF9URVNUX0hBTkxERVIgPSBvcCA9PiBgSkVTIHRlc3Qgb3BlcmF0b3IgXCIke29wfVwiIGhhbmRsZXIgbm90IGZvdW5kLmA7XG5cbmNvbnN0IElOVkFMSURfQ09MTEVDVElPTl9PUCA9IG9wID0+IGBJbnZhbGlkIGNvbGxlY3Rpb24gb3BlcmF0b3IgXCIke29wfVwiLmA7XG5jb25zdCBQUlhfT1BfTk9UX0ZPUl9FVkFMID0gcHJlZml4ID0+IGBPcGVyYXRvciBwcmVmaXggXCIke3ByZWZpeH1cIiBjYW5ub3QgYmUgdXNlZCBpbiBldmFsdWF0aW9uLmA7XG5cbmNvbnN0IE9QRVJBTkRfTk9UX1RVUExFID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgY29sbGVjdGlvbiBvcGVyYXRvciAke29wID8gJ1wiICsgb3AgKyBcIiAnIDogJyd9bXVzdCBiZSBhIHR3by10dXBsZS5gO1xuY29uc3QgT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgZWl0aGVyIGEgMi10dXBsZSBvciBhIDMtdHVwbGUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX0FSUkFZID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgYW4gYXJyYXkuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX0JPT0wgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1NUUklORyA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGEgc3RyaW5nLmA7XG5cbmNvbnN0IFZBTFVFX05PVF9DT0xMRUNUSU9OID0gb3AgPT4gYFRoZSB2YWx1ZSB1c2luZyBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGVpdGhlciBhbiBvYmplY3Qgb3IgYW4gYXJyYXkuYDtcblxuY29uc3QgUkVRVUlSRV9SSUdIVF9PUEVSQU5EID0gb3AgPT4gYEJpbmFyeSBxdWVyeSBvcGVyYXRvciBcIiR7b3B9XCIgcmVxdWlyZXMgdGhlIHJpZ2h0IG9wZXJhbmQuYFxuXG4vL0NvbmRpdGlvbiBvcGVyYXRvclxuY29uc3QgT1BfRVFVQUwgPSBbICckZXEnLCAnJGVxbCcsICckZXF1YWwnIF07XG5jb25zdCBPUF9OT1RfRVFVQUwgPSBbICckbmUnLCAnJG5lcScsICckbm90RXF1YWwnIF07XG5jb25zdCBPUF9OT1QgPSBbICckbm90JyBdO1xuY29uc3QgT1BfR1JFQVRFUl9USEFOID0gWyAnJGd0JywgJyQ+JywgJyRncmVhdGVyVGhhbicgXTtcbmNvbnN0IE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCA9IFsgJyRndGUnLCAnJDw9JywgJyRncmVhdGVyVGhhbk9yRXF1YWwnIF07XG5jb25zdCBPUF9MRVNTX1RIQU4gPSBbICckbHQnLCAnJDwnLCAnJGxlc3NUaGFuJyBdO1xuY29uc3QgT1BfTEVTU19USEFOX09SX0VRVUFMID0gWyAnJGx0ZScsICckPD0nLCAnJGxlc3NUaGFuT3JFcXVhbCcgXTtcblxuY29uc3QgT1BfSU4gPSBbICckaW4nIF07XG5jb25zdCBPUF9OT1RfSU4gPSBbICckbmluJywgJyRub3RJbicgXTtcbmNvbnN0IE9QX0VYSVNUUyA9IFsgJyRleGlzdCcsICckZXhpc3RzJywgJyRub3ROdWxsJyBdO1xuY29uc3QgT1BfTUFUQ0ggPSBbICckaGFzJywgJyRtYXRjaCcsICckYWxsJyBdO1xuY29uc3QgT1BfTUFUQ0hfQU5ZID0gWyAnJGFueScsICckb3InLCAnJGVpdGhlcicgXTtcbmNvbnN0IE9QX1RZUEUgPSBbICckaXMnLCAnJHR5cGVPZicgXTtcbmNvbnN0IE9QX0hBU19LRVlTID0gWyAnJGhhc0tleXMnLCAnJHdpdGhLZXlzJyBdO1xuY29uc3QgT1BfU1RBUlRfV0lUSCA9IFsgJyRzdGFydFdpdGgnLCAnJHN0YXJ0c1dpdGgnIF07XG5jb25zdCBPUF9FTkRfV0lUSCA9IFsgJyRlbmRXaXRoJywgJyRlbmRzV2l0aCcgXTtcblxuLy9RdWVyeSAmIGFnZ3JlZ2F0ZSBvcGVyYXRvclxuY29uc3QgT1BfU0laRSA9IFsgJyRzaXplJywgJyRsZW5ndGgnLCAnJGNvdW50JyBdO1xuY29uc3QgT1BfU1VNID0gWyAnJHN1bScsICckdG90YWwnIF07XG5jb25zdCBPUF9LRVlTID0gWyAnJGtleXMnIF07XG5jb25zdCBPUF9WQUxVRVMgPSBbICckdmFsdWVzJyBdO1xuY29uc3QgT1BfR0VUX1RZUEUgPSBbICckdHlwZScgXTtcblxuLy9NYW5pcHVsYXRlIG9wZXJhdGlvblxuY29uc3QgT1BfQUREID0gWyAnJGFkZCcsICckcGx1cycsICAgICAnJGluYycgXTtcbmNvbnN0IE9QX1NVQiA9IFsgJyRzdWInLCAnJHN1YnRyYWN0JywgJyRtaW51cycsICckZGVjJyBdO1xuY29uc3QgT1BfTVVMID0gWyAnJG11bCcsICckbXVsdGlwbHknLCAgJyR0aW1lcycgXTtcbmNvbnN0IE9QX0RJViA9IFsgJyRkaXYnLCAnJGRpdmlkZScgXTtcbmNvbnN0IE9QX1NFVCA9IFsgJyRzZXQnLCAnJD0nIF07XG5jb25zdCBPUF9BRERfSVRFTSA9IFsgJyRhZGRJdGVtJyBdO1xuXG5jb25zdCBPUF9QSUNLID0gWyAnJHBpY2snIF07XG5jb25zdCBPUF9HRVRfQllfSU5ERVggPSBbICckYXQnLCAnJGdldEJ5SW5kZXgnLCAnJG50aCcgXTtcbmNvbnN0IE9QX0dFVF9CWV9LRVkgPSBbICckb2YnLCAnJGdldEJ5S2V5JyBdO1xuY29uc3QgT1BfT01JVCA9IFsgJyRvbWl0JyBdO1xuY29uc3QgT1BfR1JPVVAgPSBbICckZ3JvdXAnLCAnJGdyb3VwQnknIF07XG5jb25zdCBPUF9TT1JUID0gWyAnJHNvcnQnLCAnJG9yZGVyQnknLCAnJHNvcnRCeScgXTtcbmNvbnN0IE9QX1JFVkVSU0UgPSBbICckcmV2ZXJzZScgXTtcbmNvbnN0IE9QX0VWQUwgPSBbICckZXZhbCcsICckYXBwbHknIF07XG5jb25zdCBPUF9NRVJHRSA9IFsgJyRtZXJnZScgXTtcblxuLy9Db25kaXRpb24gb3BlcmF0aW9uXG5jb25zdCBPUF9JRiA9IFsgJyRpZicgXTtcblxuY29uc3QgUEZYX0ZPUl9FQUNIID0gJ3w+JzsgLy8gZm9yIGVhY2hcbmNvbnN0IFBGWF9XSVRIX0FOWSA9ICd8Kic7IC8vIHdpdGggYW55XG5cbmNvbnN0IE1hcE9mT3BzID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkT3BUb01hcCA9ICh0b2tlbnMsIHRhZykgPT4gdG9rZW5zLmZvckVhY2godG9rZW4gPT4gTWFwT2ZPcHMuc2V0KHRva2VuLCB0YWcpKTtcbmFkZE9wVG9NYXAoT1BfRVFVQUwsICdPUF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1RfRVFVQUwsICdPUF9OT1RfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTk9ULCAnT1BfTk9UJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTiwgJ09QX0dSRUFURVJfVEhBTicpO1xuYWRkT3BUb01hcChPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwsICdPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOLCAnT1BfTEVTU19USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0xFU1NfVEhBTl9PUl9FUVVBTCwgJ09QX0xFU1NfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9JTiwgJ09QX0lOJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9JTiwgJ09QX05PVF9JTicpO1xuYWRkT3BUb01hcChPUF9FWElTVFMsICdPUF9FWElTVFMnKTtcbmFkZE9wVG9NYXAoT1BfTUFUQ0gsICdPUF9NQVRDSCcpO1xuYWRkT3BUb01hcChPUF9NQVRDSF9BTlksICdPUF9NQVRDSF9BTlknKTtcbmFkZE9wVG9NYXAoT1BfVFlQRSwgJ09QX1RZUEUnKTtcbmFkZE9wVG9NYXAoT1BfSEFTX0tFWVMsICdPUF9IQVNfS0VZUycpO1xuYWRkT3BUb01hcChPUF9TVEFSVF9XSVRILCAnT1BfU1RBUlRfV0lUSCcpO1xuYWRkT3BUb01hcChPUF9FTkRfV0lUSCwgJ09QX0VORF9XSVRIJyk7XG5cbmNvbnN0IE1hcE9mTWFucyA9IG5ldyBNYXAoKTtcbmNvbnN0IGFkZE1hblRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk1hbnMuc2V0KHRva2VuLCB0YWcpKTtcbi8vIFsgPG9wIG5hbWU+LCA8dW5hcnk+IF1cbmFkZE1hblRvTWFwKE9QX1NJWkUsIFsnT1BfU0laRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VNLCBbJ09QX1NVTScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfS0VZUywgWydPUF9LRVlTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9WQUxVRVMsIFsnT1BfVkFMVUVTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9HRVRfVFlQRSwgWydPUF9HRVRfVFlQRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfUkVWRVJTRSwgWydPUF9SRVZFUlNFJywgdHJ1ZV0pO1xuXG5hZGRNYW5Ub01hcChPUF9BREQsIFsnT1BfQUREJywgZmFsc2UgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VCLCBbJ09QX1NVQicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfTVVMLCBbJ09QX01VTCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfRElWLCBbJ09QX0RJVicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfU0VULCBbJ09QX1NFVCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfQUREX0lURU0sIFsnT1BfQUREX0lURU0nLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX1BJQ0ssIFsnT1BfUElDSycsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HRVRfQllfSU5ERVgsIFsnT1BfR0VUX0JZX0lOREVYJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9LRVksIFsnT1BfR0VUX0JZX0tFWScsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9PTUlULCBbJ09QX09NSVQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR1JPVVAsIFsnT1BfR1JPVVAnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfU09SVCwgWydPUF9TT1JUJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0VWQUwsIFsnT1BfRVZBTCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9NRVJHRSwgWydPUF9NRVJHRScsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9JRiwgWydPUF9JRicsIGZhbHNlXSk7XG5cbmNvbnN0IGRlZmF1bHRKZXNIYW5kbGVycyA9IHtcbiAgICBPUF9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBfLmlzRXF1YWwobGVmdCwgcmlnaHQpLFxuICAgIE9QX05PVF9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiAhXy5pc0VxdWFsKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9OT1Q6IChsZWZ0LCAuLi5hcmdzKSA9PiAhdGVzdChsZWZ0LCAnT1BfTUFUQ0gnLCAuLi5hcmdzKSxcbiAgICBPUF9HUkVBVEVSX1RIQU46IChsZWZ0LCByaWdodCkgPT4gbGVmdCA+IHJpZ2h0LFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID49IHJpZ2h0LFxuICAgIE9QX0xFU1NfVEhBTjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IDwgcmlnaHQsXG4gICAgT1BfTEVTU19USEFOX09SX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPD0gcmlnaHQsXG4gICAgT1BfSU46IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAocmlnaHQgPT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX0lOJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJpZ2h0LmZpbmQoZWxlbWVudCA9PiBkZWZhdWx0SmVzSGFuZGxlcnMuT1BfRVFVQUwobGVmdCwgZWxlbWVudCkpO1xuICAgIH0sXG4gICAgT1BfTk9UX0lOOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHJpZ2h0ID09IG51bGwpIHJldHVybiB0cnVlO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX05PVF9JTicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBlbGVtZW50ID0+IGRlZmF1bHRKZXNIYW5kbGVycy5PUF9OT1RfRVFVQUwobGVmdCwgZWxlbWVudCkpO1xuICAgIH0sXG4gICAgT1BfRVhJU1RTOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQk9PTCgnT1BfRVhJU1RTJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJpZ2h0ID8gbGVmdCAhPSBudWxsIDogbGVmdCA9PSBudWxsO1xuICAgIH0sXG4gICAgT1BfVFlQRTogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9UWVBFJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmlnaHQgPSByaWdodC50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ2FycmF5Jykge1xuICAgICAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkobGVmdCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAnaW50ZWdlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmlzSW50ZWdlcihsZWZ0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICByZXR1cm4gdHlwZW9mIGxlZnQgPT09ICdzdHJpbmcnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHR5cGVvZiBsZWZ0ID09PSByaWdodDtcbiAgICB9LFxuICAgIE9QX01BVENIOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIHJ1bGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCBydWxlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpO1xuICAgICAgICByZXR1cm4gclswXTtcbiAgICB9LFxuICAgIE9QX01BVENIX0FOWTogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX01BVENIX0FOWScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyaWdodCwgcnVsZSA9PiB7XG4gICAgICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcnVsZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgICAgIH0pOyAgIFxuICAgIFxuICAgICAgICByZXR1cm4gZm91bmQgPyB0cnVlIDogZmFsc2U7XG4gICAgfSxcbiAgICBPUF9IQVNfS0VZUzogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBrZXkgPT4gaGFzS2V5QnlQYXRoKGxlZnQsIGtleSkpO1xuICAgIH0sXG4gICAgT1BfU1RBUlRfV0lUSDogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfU1RBUlRfV0lUSCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0LnN0YXJ0c1dpdGgocmlnaHQpO1xuICAgIH0sXG4gICAgT1BfRU5EX1dJVEg6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX0VORF9XSVRIJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnQuZW5kc1dpdGgocmlnaHQpO1xuICAgIH0gICAgICAgXG59O1xuXG5jb25zdCBkZWZhdWx0TWFuaXB1bGF0aW9ucyA9IHtcbiAgICAvL3VuYXJ5XG4gICAgT1BfU0laRTogKGxlZnQpID0+IF8uc2l6ZShsZWZ0KSxcbiAgICBPUF9TVU06IChsZWZ0KSA9PiBfLnJlZHVjZShsZWZ0LCAoc3VtLCBpdGVtKSA9PiB7XG4gICAgICAgICAgICBzdW0gKz0gaXRlbTtcbiAgICAgICAgICAgIHJldHVybiBzdW07XG4gICAgICAgIH0sIDApLFxuXG4gICAgT1BfS0VZUzogKGxlZnQpID0+IF8ua2V5cyhsZWZ0KSxcbiAgICBPUF9WQUxVRVM6IChsZWZ0KSA9PiBfLnZhbHVlcyhsZWZ0KSwgICBcbiAgICBPUF9HRVRfVFlQRTogKGxlZnQpID0+IEFycmF5LmlzQXJyYXkobGVmdCkgPyAnYXJyYXknIDogKF8uaXNJbnRlZ2VyKGxlZnQpID8gJ2ludGVnZXInIDogdHlwZW9mIGxlZnQpLCAgXG4gICAgT1BfUkVWRVJTRTogKGxlZnQpID0+IF8ucmV2ZXJzZShsZWZ0KSxcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgKyByaWdodCxcbiAgICBPUF9TVUI6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAtIHJpZ2h0LFxuICAgIE9QX01VTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ICogcmlnaHQsXG4gICAgT1BfRElWOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgLyByaWdodCwgXG4gICAgT1BfU0VUOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHRydWUpLCBcbiAgICBPUF9BRERfSVRFTTogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoVkFMVUVfTk9UX0NPTExFQ1RJT04oJ09QX0FERF9JVEVNJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0LmNvbmNhdChyaWdodCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpIHx8IHJpZ2h0Lmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1RVUExFKCdPUF9BRERfSVRFTScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IC4uLmxlZnQsIFtyaWdodFswXV06IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIHJpZ2h0WzFdLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSkgfTtcbiAgICB9LCBcbiAgICBPUF9QSUNLOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmIChsZWZ0ID09IG51bGwpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJpZ2h0ID0gXy5jYXN0QXJyYXkocmlnaHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5waWNrKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gXy5waWNrQnkobGVmdCwgKHgsIGtleSkgPT4gbWF0Y2goa2V5LCByaWdodCwgamVzLCBwcmVmaXgpWzBdKTtcbiAgICB9LFxuICAgIE9QX0dFVF9CWV9JTkRFWDogKGxlZnQsIHJpZ2h0KSA9PiBfLm50aChsZWZ0LCByaWdodCksXG4gICAgT1BfR0VUX0JZX0tFWTogKGxlZnQsIHJpZ2h0KSA9PiBfLmdldChsZWZ0LCByaWdodCksXG4gICAgT1BfT01JVDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID09IG51bGwgPyBudWxsIDogXy5vbWl0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HUk9VUDogKGxlZnQsIHJpZ2h0KSA9PiBfLmdyb3VwQnkobGVmdCwgcmlnaHQpLFxuICAgIE9QX1NPUlQ6IChsZWZ0LCByaWdodCkgPT4gXy5zb3J0QnkobGVmdCwgcmlnaHQpLCAgXG4gICAgT1BfRVZBTDogZXZhbHVhdGVFeHByLFxuICAgIE9QX01FUkdFOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUVSR0UnKSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiByaWdodC5yZWR1Y2UoKHJlc3VsdCwgZXhwcikgPT4gT2JqZWN0LmFzc2lnbihyZXN1bHQsIGV2YWx1YXRlRXhwcihsZWZ0LCBleHByLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0pKSwge30pO1xuICAgIH0sXG4gICAgT1BfSUY6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9JRicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyaWdodC5sZW5ndGggPCAyIHx8IHJpZ2h0Lmxlbmd0aCA+IDMpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRV8yX09SXzMoJ09QX0lGJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY29uZGl0aW9uID0gZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgcmlnaHRbMF0sIGplcywgcHJlZml4LCBjb250ZXh0LCB0cnVlKTtcblxuICAgICAgICBpZiAodGVzdChsZWZ0LCAnT1BfTUFUQ0gnLCBjb25kaXRpb24sIGplcywgcHJlZml4KSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGV2YWx1YXRlRXhwcihsZWZ0LCByaWdodFsxXSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xuICAgICAgICB9IGVsc2UgaWYgKHJpZ2h0Lmxlbmd0aCA+IDIpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IHJldCA9IGV2YWx1YXRlRXhwcihsZWZ0LCByaWdodFsyXSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0O1xuICAgIH1cbn1cblxuY29uc3QgZm9ybWF0TmFtZSA9IChuYW1lLCBwcmVmaXgpID0+IHtcbiAgICBjb25zdCBmdWxsTmFtZSA9IG5hbWUgPT0gbnVsbCA/IHByZWZpeCA6IGZvcm1hdFByZWZpeChuYW1lLCBwcmVmaXgpO1xuICAgIHJldHVybiBmdWxsTmFtZSA9PSBudWxsID8gXCJUaGUgdmFsdWVcIiA6IChmdWxsTmFtZS5pbmRleE9mKCcoJykgIT09IC0xID8gYFRoZSBxdWVyeSBcIl8uJHtmdWxsTmFtZX1cImAgOiBgXCIke2Z1bGxOYW1lfVwiYCk7XG59O1xuY29uc3QgZm9ybWF0S2V5ID0gKGtleSwgaGFzUHJlZml4KSA9PiBfLmlzSW50ZWdlcihrZXkpID8gYFske2tleX1dYCA6IChoYXNQcmVmaXggPyAnLicgKyBrZXkgOiBrZXkpO1xuY29uc3QgZm9ybWF0UHJlZml4ID0gKGtleSwgcHJlZml4KSA9PiBwcmVmaXggIT0gbnVsbCA/IGAke3ByZWZpeH0ke2Zvcm1hdEtleShrZXksIHRydWUpfWAgOiBmb3JtYXRLZXkoa2V5LCBmYWxzZSk7XG5jb25zdCBmb3JtYXRRdWVyeSA9IChvcE1ldGEpID0+IGAke2RlZmF1bHRRdWVyeUV4cGxhbmF0aW9uc1tvcE1ldGFbMF1dfSgke29wTWV0YVsxXSA/ICcnIDogJz8nfSlgOyAgXG5jb25zdCBmb3JtYXRNYXAgPSAobmFtZSkgPT4gYGVhY2goLT4ke25hbWV9KWA7XG5jb25zdCBmb3JtYXRBbnkgPSAobmFtZSkgPT4gYGFueSgtPiR7bmFtZX0pYDtcblxuY29uc3QgZGVmYXVsdEplc0V4cGxhbmF0aW9ucyA9IHtcbiAgICBPUF9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IG1hdGNoICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX0dSRUFURVJfVEhBTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgZ3JlYXRlciB0aGFuIG9yIGVxdWFsIHRvICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9MRVNTX1RIQU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBsZXNzIHRoYW4gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0xFU1NfVEhBTl9PUl9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGxlc3MgdGhhbiBvciBlcXVhbCB0byAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfSU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1RfSU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgYmUgYW55IG9uZSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0VYSVNUUzogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkJHtyaWdodCA/ICcgbm90ICc6ICcgJ31iZSBOVUxMLmAsICAgIFxuICAgIE9QX1RZUEU6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgVGhlIHR5cGUgb2YgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBcIiR7cmlnaHR9XCIsIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICAgICAgXG4gICAgT1BfTUFUQ0g6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBtYXRjaCAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9NQVRDSF9BTlk6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBtYXRjaCBhbnkgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfSEFTX0tFWVM6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBoYXZlIGFsbCBvZiB0aGVzZSBrZXlzIFske3JpZ2h0LmpvaW4oJywgJyl9XS5gLCAgICAgICAgXG4gICAgT1BfU1RBUlRfV0lUSDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIHN0YXJ0IHdpdGggXCIke3JpZ2h0fVwiLmAsICAgICAgICBcbiAgICBPUF9FTkRfV0lUSDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGVuZCB3aXRoIFwiJHtyaWdodH1cIi5gLCAgICAgICAgXG59O1xuXG5jb25zdCBkZWZhdWx0UXVlcnlFeHBsYW5hdGlvbnMgPSB7XG4gICAgLy91bmFyeVxuICAgIE9QX1NJWkU6ICdzaXplJyxcbiAgICBPUF9TVU06ICdzdW0nLFxuICAgIE9QX0tFWVM6ICdrZXlzJyxcbiAgICBPUF9WQUxVRVM6ICd2YWx1ZXMnLCAgICBcbiAgICBPUF9HRVRfVFlQRTogJ2dldCB0eXBlJyxcbiAgICBPUF9SRVZFUlNFOiAncmV2ZXJzZScsIFxuXG4gICAgLy9iaW5hcnlcbiAgICBPUF9BREQ6ICdhZGQnLFxuICAgIE9QX1NVQjogJ3N1YnRyYWN0JyxcbiAgICBPUF9NVUw6ICdtdWx0aXBseScsXG4gICAgT1BfRElWOiAnZGl2aWRlJywgXG4gICAgT1BfU0VUOiAnYXNzaWduJyxcbiAgICBPUF9BRERfSVRFTTogJ2FkZEl0ZW0nLFxuICAgIE9QX1BJQ0s6ICdwaWNrJyxcbiAgICBPUF9HRVRfQllfSU5ERVg6ICdnZXQgZWxlbWVudCBhdCBpbmRleCcsXG4gICAgT1BfR0VUX0JZX0tFWTogJ2dldCBlbGVtZW50IG9mIGtleScsXG4gICAgT1BfT01JVDogJ29taXQnLFxuICAgIE9QX0dST1VQOiAnZ3JvdXBCeScsXG4gICAgT1BfU09SVDogJ3NvcnRCeScsXG4gICAgT1BfRVZBTDogJ2V2YWx1YXRlJyxcbiAgICBPUF9NRVJHRTogJ21lcmdlJyxcbiAgICBPUF9JRjogJ2V2YWx1YXRlIGlmJ1xufTtcblxuZnVuY3Rpb24gZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbmFtZSwgbGVmdFZhbHVlLCByaWdodFZhbHVlLCBwcmVmaXgpIHtcbiAgICBjb25zdCBnZXR0ZXIgPSBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnNbb3BdIHx8IGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9NQVRDSDtcbiAgICByZXR1cm4gZ2V0dGVyKG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KTsgICAgXG59XG5cbmZ1bmN0aW9uIHRlc3QodmFsdWUsIG9wLCBvcFZhbHVlLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLm9wZXJhdG9ySGFuZGxlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfSEFOTERFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlKHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5xdWVyeUhhbmxkZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9IQU5ETEVSKG9wKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGhhbmRsZXIodmFsdWUsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXZhbHVhdGVVbmFyeSh2YWx1ZSwgb3AsIGplcywgcHJlZml4KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCByaWdodFZhbHVlLCBvcE1ldGEsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgaWYgKG9wTWV0YVsxXSkge1xuICAgICAgICByZXR1cm4gcmlnaHRWYWx1ZSA/IGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KSA6IGN1cnJlbnRWYWx1ZTtcbiAgICB9IFxuICAgIFxuICAgIHJldHVybiBldmFsdWF0ZShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgcmlnaHRWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xufVxuXG5jb25zdCBkZWZhdWx0Q3VzdG9taXplciA9IHtcbiAgICBtYXBPZk9wZXJhdG9yczogTWFwT2ZPcHMsXG4gICAgbWFwT2ZNYW5pcHVsYXRvcnM6IE1hcE9mTWFucyxcbiAgICBvcGVyYXRvckhhbmRsZXJzOiBkZWZhdWx0SmVzSGFuZGxlcnMsXG4gICAgb3BlcmF0b3JFeHBsYW5hdGlvbnM6IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMsXG4gICAgcXVlcnlIYW5sZGVyczogZGVmYXVsdE1hbmlwdWxhdGlvbnNcbn07XG5cbmZ1bmN0aW9uIG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBvcGVyYW5kcywgamVzLCBwcmVmaXgpIHtcbiAgICBsZXQgbWF0Y2hSZXN1bHQsIG5leHRQcmVmaXg7XG5cbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IG1hcFJlc3VsdCA9IF8uaXNQbGFpbk9iamVjdChhY3R1YWwpID8gXy5tYXBWYWx1ZXMoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSkpIDogXy5tYXAoYWN0dWFsLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChpLCBwcmVmaXgpKSk7XG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdE1hcChmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gbWF0Y2gobWFwUmVzdWx0LCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgICBcbiAgICAgICAgICAgIG5leHRQcmVmaXggPSBmb3JtYXRQcmVmaXgoZm9ybWF0QW55KGZvcm1hdFF1ZXJ5KG9wTWV0YSkpLCBwcmVmaXgpO1xuICAgICAgICAgICAgbWF0Y2hSZXN1bHQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBtYXRjaChldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSksIG9wZXJhbmRzWzFdLCBqZXMsIG5leHRQcmVmaXgpKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpIHtcbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IHVubWF0Y2hlZEtleSA9IF8uZmluZEluZGV4KGFjdHVhbCwgKGl0ZW0pID0+ICF0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgICAgIGlmICh1bm1hdGNoZWRLZXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgdW5tYXRjaGVkS2V5LCBhY3R1YWxbdW5tYXRjaGVkS2V5XSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZWQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiB0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgXG4gICAgICAgICAgICBpZiAoIW1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY3VycmVudFZhbHVlLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSwgeyAuLi5jb250ZXh0LCAkJFBBUkVOVDogY3VycmVudFZhbHVlLCAkJENVUlJFTlQ6IGl0ZW0gfSkpO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgIFxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFBSWF9PUF9OT1RfRk9SX0VWQUwoY29sbGVjdGlvbk9wKSk7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0NPTExFQ1RJT05fT1AoY29sbGVjdGlvbk9wKSk7XG4gICAgfVxufVxuXG4vKipcbiAqIFxuICogQHBhcmFtIHsqfSBhY3R1YWwgXG4gKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IHByZWZpeCAgXG4gKiBcbiAqIHsga2V5OiB7ICRtYXRjaCB9IH1cbiAqL1xuZnVuY3Rpb24gbWF0Y2goYWN0dWFsLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGxldCBwYXNzT2JqZWN0Q2hlY2sgPSBmYWxzZTtcblxuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGV4cGVjdGVkKSkge1xuICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCAnT1BfRVFVQUwnLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChudWxsLCBhY3R1YWwsIGV4cGVjdGVkLCBwcmVmaXgpICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gW3RydWVdO1xuICAgIH1cblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHBlY3RlZCkge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwZWN0ZWRbZmllbGROYW1lXTsgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgIFxuICAgICAgICAgICAgaWYgKGwgPiA0ICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVszXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEZpZWxkVmFsdWUpICYmIGV4cGVjdGVkRmllbGRWYWx1ZS5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRSgpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigzKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAobCA+IDIgJiYgZmllbGROYW1lWzFdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigxKTtcblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5PVF9BX1VOQVJZX1FVRVJZKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gZXZhbHVhdGVVbmFyeShhY3R1YWwsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2gocXVlcnlSZXN1bHQsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZm9ybWF0UXVlcnkob3BNZXRhKSwgcHJlZml4KSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaFJlc3VsdFswXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yXG4gICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWwsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBnZXRVbm1hdGNoZWRFeHBsYW5hdGlvbihqZXMsIG9wLCBudWxsLCBhY3R1YWwsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoIXBhc3NPYmplY3RDaGVjaykge1xuICAgICAgICAgICAgaWYgKGFjdHVhbCA9PSBudWxsKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVhJU1RTKG51bGwsIG51bGwsIHRydWUsIHByZWZpeClcbiAgICAgICAgICAgIF07IFxuXG4gICAgICAgICAgICBjb25zdCBhY3R1YWxUeXBlID0gdHlwZW9mIGFjdHVhbDtcbiAgICBcbiAgICAgICAgICAgIGlmIChhY3R1YWxUeXBlICE9PSAnb2JqZWN0JykgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfVFlQRShudWxsLCBhY3R1YWxUeXBlLCAnb2JqZWN0JywgcHJlZml4KVxuICAgICAgICAgICAgXTsgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHBhc3NPYmplY3RDaGVjayA9IHRydWU7XG5cbiAgICAgICAgbGV0IGFjdHVhbEZpZWxkVmFsdWUgPSBfLmdldChhY3R1YWwsIGZpZWxkTmFtZSk7ICAgICBcbiAgICAgICAgXG4gICAgICAgIGlmIChleHBlY3RlZEZpZWxkVmFsdWUgIT0gbnVsbCAmJiB0eXBlb2YgZXhwZWN0ZWRGaWVsZFZhbHVlID09PSAnb2JqZWN0JykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgWyBvaywgcmVhc29uIF0gPSBtYXRjaChhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZpZWxkTmFtZSwgcHJlZml4KSk7XG4gICAgICAgICAgICBpZiAoIW9rKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFsgZmFsc2UsIHJlYXNvbiBdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbEZpZWxkVmFsdWUsICdPUF9FUVVBTCcsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChmaWVsZE5hbWUsIGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIFt0cnVlXTtcbn1cblxuLyoqXG4gKiBJZiAkIG9wZXJhdG9yIHVzZWQsIG9ubHkgb25lIGEgdGltZSBpcyBhbGxvd2VkXG4gKiBlLmcuXG4gKiB7XG4gKiAgICAkZ3JvdXBCeTogJ2tleSdcbiAqIH1cbiAqIFxuICogXG4gKiBAcGFyYW0geyp9IGN1cnJlbnRWYWx1ZSBcbiAqIEBwYXJhbSB7Kn0gZXhwciBcbiAqIEBwYXJhbSB7Kn0gcHJlZml4IFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IGNvbnRleHRcbiAqL1xuZnVuY3Rpb24gZXZhbHVhdGVFeHByKGN1cnJlbnRWYWx1ZSwgZXhwciwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHNldE9wKSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShleHByKSkge1xuICAgICAgICBpZiAoc2V0T3ApIHtcbiAgICAgICAgICAgIHJldHVybiBleHByLm1hcChpdGVtID0+IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIGl0ZW0sIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQgfSwgdHJ1ZSkpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZXhwci5yZWR1Y2UoKHJlc3VsdCwgZXhwckl0ZW0pID0+IGV2YWx1YXRlRXhwcihyZXN1bHQsIGV4cHJJdGVtLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0pLCBjdXJyZW50VmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGVFeHByID0gdHlwZW9mIGV4cHI7XG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIGlmIChzZXRPcCkgcmV0dXJuIGV4cHI7XG4gICAgICAgIHJldHVybiBleHByID8gY3VycmVudFZhbHVlIDogdW5kZWZpbmVkO1xuICAgIH0gICAgXG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwibnVtYmVyXCIgfHwgdHlwZUV4cHIgPT09IFwiYmlnaW50XCIpIHtcbiAgICAgICAgaWYgKHNldE9wKSByZXR1cm4gZXhwcjtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9FWFBSX1NZTlRBWCk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVFeHByID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoZXhwci5zdGFydHNXaXRoKCckJCcpKSB7XG4gICAgICAgICAgICAvL2dldCBmcm9tIGNvbnRleHRcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IGV4cHIuaW5kZXhPZignLicpO1xuICAgICAgICAgICAgaWYgKHBvcyA9PT0gLTEpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbnRleHRbZXhwcl07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLmdldChjb250ZXh0W2V4cHIuc3Vic3RyKDAsIHBvcyldLCBleHByLnN1YnN0cihwb3MrMSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNldE9wKSB7XG4gICAgICAgICAgICByZXR1cm4gZXhwcjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZXhwcik7XG4gICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFJFUVVJUkVfUklHSFRfT1BFUkFORChleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZXZhbHVhdGVVbmFyeShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpO1xuICAgIH0gXG5cbiAgICBpZiAodHlwZUV4cHIgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfRVhQUl9TWU5UQVgpO1xuICAgIH1cblxuICAgIGlmIChzZXRPcCkge1xuICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXMoZXhwciwgaXRlbSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCBpdGVtLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSkpO1xuICAgIH1cblxuICAgIGlmIChjb250ZXh0ID09IG51bGwpIHsgXG4gICAgICAgIGNvbnRleHQgPSB7ICQkUk9PVDogY3VycmVudFZhbHVlLCAkJFBBUkVOVDogbnVsbCwgJCRDVVJSRU5UOiBjdXJyZW50VmFsdWUgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBsZXQgcmVzdWx0LCBoYXNPcGVyYXRvciA9IGZhbHNlOyAgICBcblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHByKSB7XG4gICAgICAgIGxldCBleHBlY3RlZEZpZWxkVmFsdWUgPSBleHByW2ZpZWxkTmFtZV07ICBcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGwgPSBmaWVsZE5hbWUubGVuZ3RoO1xuXG4gICAgICAgIGlmIChsID4gMSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVCeU9wTWV0YShjdXJyZW50VmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobCA+IDMgJiYgZmllbGROYW1lWzBdID09PSAnfCcgJiYgZmllbGROYW1lWzJdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb21wbGV5S2V5ID0gZmllbGROYW1lLmluZGV4T2YoJy4nKSAhPT0gLTE7XG5cbiAgICAgICAgLy9waWNrIGEgZmllbGQgYW5kIHRoZW4gYXBwbHkgbWFuaXB1bGF0aW9uXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gY3VycmVudFZhbHVlICE9IG51bGwgPyAoY29tcGxleUtleSA/IF8uZ2V0KGN1cnJlbnRWYWx1ZSwgZmllbGROYW1lKSA6IGN1cnJlbnRWYWx1ZVtmaWVsZE5hbWVdKSA6IHVuZGVmaW5lZDsgICAgICAgICBcblxuICAgICAgICBjb25zdCBjaGlsZEZpZWxkVmFsdWUgPSBldmFsdWF0ZUV4cHIoYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCksIGNvbnRleHQpO1xuXG4gICAgICAgIGlmICh0eXBlb2YgY2hpbGRGaWVsZFZhbHVlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgcmVzdWx0ID09IG51bGwgJiYgKHJlc3VsdCA9IHt9KTtcbiAgICAgICAgICAgIGlmIChjb21wbGV5S2V5KSB7XG4gICAgICAgICAgICAgICAgXy5zZXQocmVzdWx0LCBmaWVsZE5hbWUsIGNoaWxkRmllbGRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJlc3VsdFtmaWVsZE5hbWVdID0gY2hpbGRGaWVsZFZhbHVlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5jbGFzcyBKRVMge1xuICAgIGNvbnN0cnVjdG9yKHZhbHVlLCBjdXN0b21pemVyKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgdGhpcy5jdXN0b21pemVyID0gY3VzdG9taXplcjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICAgICAqIEBwYXJhbSAgey4uLmFueX0gYXJncyBcbiAgICAgKi9cbiAgICBtYXRjaChleHBlY3RlZCkgeyAgICAgICAgXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IG1hdGNoKHRoaXMudmFsdWUsIGV4cGVjdGVkLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgICAgICBpZiAocmVzdWx0WzBdKSByZXR1cm4gdGhpcztcblxuICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKHJlc3VsdFsxXSwge1xuICAgICAgICAgICAgYWN0dWFsOiB0aGlzLnZhbHVlLFxuICAgICAgICAgICAgZXhwZWN0ZWRcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZXZhbHVhdGUoZXhwcikge1xuICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgfVxuXG4gICAgdXBkYXRlKGV4cHIpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBldmFsdWF0ZUV4cHIodGhpcy52YWx1ZSwgZXhwciwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG59XG5cbkpFUy5tYXRjaCA9IG1hdGNoO1xuSkVTLmV2YWx1YXRlID0gZXZhbHVhdGVFeHByO1xuSkVTLmRlZmF1bHRDdXN0b21pemVyID0gZGVmYXVsdEN1c3RvbWl6ZXI7XG5cbm1vZHVsZS5leHBvcnRzID0gSkVTOyJdfQ==
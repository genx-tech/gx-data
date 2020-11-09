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
    console.log(left, condition);

    if (test(left, 'OP_MATCH', condition, jes, prefix)) {
      console.log('true');
      return evaluateExpr(left, right[1], jes, prefix, context);
    } else if (right.length > 2) {
      const ret = evaluateExpr(left, right[2], jes, prefix, context);
      console.log('false', ret);
      return ret;
    }

    console.log('false');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJOT1RfQV9VTkFSWV9RVUVSWSIsIklOVkFMSURfRVhQUl9TWU5UQVgiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiSU5WQUxJRF9DT0xMRUNUSU9OX09QIiwiUFJYX09QX05PVF9GT1JfRVZBTCIsInByZWZpeCIsIk9QRVJBTkRfTk9UX1RVUExFIiwiT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zIiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiVkFMVUVfTk9UX0NPTExFQ1RJT04iLCJSRVFVSVJFX1JJR0hUX09QRVJBTkQiLCJPUF9FUVVBTCIsIk9QX05PVF9FUVVBTCIsIk9QX05PVCIsIk9QX0dSRUFURVJfVEhBTiIsIk9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCIsIk9QX0xFU1NfVEhBTiIsIk9QX0xFU1NfVEhBTl9PUl9FUVVBTCIsIk9QX0lOIiwiT1BfTk9UX0lOIiwiT1BfRVhJU1RTIiwiT1BfTUFUQ0giLCJPUF9NQVRDSF9BTlkiLCJPUF9UWVBFIiwiT1BfSEFTX0tFWVMiLCJPUF9TVEFSVF9XSVRIIiwiT1BfRU5EX1dJVEgiLCJPUF9TSVpFIiwiT1BfU1VNIiwiT1BfS0VZUyIsIk9QX1ZBTFVFUyIsIk9QX0dFVF9UWVBFIiwiT1BfQUREIiwiT1BfU1VCIiwiT1BfTVVMIiwiT1BfRElWIiwiT1BfU0VUIiwiT1BfQUREX0lURU0iLCJPUF9QSUNLIiwiT1BfR0VUX0JZX0lOREVYIiwiT1BfR0VUX0JZX0tFWSIsIk9QX09NSVQiLCJPUF9HUk9VUCIsIk9QX1NPUlQiLCJPUF9SRVZFUlNFIiwiT1BfRVZBTCIsIk9QX01FUkdFIiwiT1BfSUYiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNvbnRleHQiLCJldmFsdWF0ZUV4cHIiLCJ1bmRlZmluZWQiLCJjb25jYXQiLCJsZW5ndGgiLCJjYXN0QXJyYXkiLCJwaWNrIiwicGlja0J5IiwieCIsIm50aCIsImdldCIsIm9taXQiLCJncm91cEJ5Iiwic29ydEJ5IiwicmVzdWx0IiwiZXhwciIsIk9iamVjdCIsImFzc2lnbiIsImNvbmRpdGlvbiIsImNvbnNvbGUiLCJsb2ciLCJyZXQiLCJmb3JtYXROYW1lIiwibmFtZSIsImZ1bGxOYW1lIiwiZm9ybWF0UHJlZml4IiwiaW5kZXhPZiIsImZvcm1hdEtleSIsImhhc1ByZWZpeCIsImZvcm1hdFF1ZXJ5Iiwib3BNZXRhIiwiZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zIiwiZm9ybWF0TWFwIiwiZm9ybWF0QW55IiwiZGVmYXVsdEplc0V4cGxhbmF0aW9ucyIsIkpTT04iLCJzdHJpbmdpZnkiLCJqb2luIiwiZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24iLCJsZWZ0VmFsdWUiLCJyaWdodFZhbHVlIiwiZ2V0dGVyIiwib3BlcmF0b3JFeHBsYW5hdGlvbnMiLCJ2YWx1ZSIsIm9wVmFsdWUiLCJoYW5kbGVyIiwib3BlcmF0b3JIYW5kbGVycyIsImV2YWx1YXRlIiwicXVlcnlIYW5sZGVycyIsImV2YWx1YXRlVW5hcnkiLCJldmFsdWF0ZUJ5T3BNZXRhIiwiY3VycmVudFZhbHVlIiwiZGVmYXVsdEN1c3RvbWl6ZXIiLCJtYXBPZk9wZXJhdG9ycyIsIm1hcE9mTWFuaXB1bGF0b3JzIiwibWF0Y2hDb2xsZWN0aW9uIiwiYWN0dWFsIiwiY29sbGVjdGlvbk9wIiwib3BlcmFuZHMiLCJtYXRjaFJlc3VsdCIsIm5leHRQcmVmaXgiLCJtYXBSZXN1bHQiLCJpc1BsYWluT2JqZWN0IiwibWFwVmFsdWVzIiwibWFwIiwiaSIsInZhbGlkYXRlQ29sbGVjdGlvbiIsImV4cGVjdGVkRmllbGRWYWx1ZSIsInVubWF0Y2hlZEtleSIsImZpbmRJbmRleCIsIm1hdGNoZWQiLCJldmFsdWF0ZUNvbGxlY3Rpb24iLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImV4cGVjdGVkIiwicGFzc09iamVjdENoZWNrIiwiZmllbGROYW1lIiwibCIsInN1YnN0ciIsInF1ZXJ5UmVzdWx0IiwiYWN0dWFsVHlwZSIsImFjdHVhbEZpZWxkVmFsdWUiLCJvayIsInJlYXNvbiIsInNldE9wIiwiZXhwckl0ZW0iLCJ0eXBlRXhwciIsInBvcyIsIiQkUk9PVCIsImhhc09wZXJhdG9yIiwiY29tcGxleUtleSIsImNoaWxkRmllbGRWYWx1ZSIsIkpFUyIsImNvbnN0cnVjdG9yIiwiY3VzdG9taXplciIsInVwZGF0ZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFDQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFBTCxJQUFzQkMsT0FBTyxDQUFDLFVBQUQsQ0FBbkM7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQXNCRCxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFHQSxNQUFNRSxrQkFBa0IsR0FBRyxtREFBM0I7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RUFBZSxPQUFPLElBQVA7QUFFZixVQUFNLElBQUloSCxlQUFKLENBQW9CZ0gsTUFBTSxDQUFDLENBQUQsQ0FBMUIsRUFBK0I7QUFDakMwQyxNQUFBQSxNQUFNLEVBQUUsS0FBS2IsS0FEb0I7QUFFakMrQixNQUFBQTtBQUZpQyxLQUEvQixDQUFOO0FBSUg7O0FBRUQzQixFQUFBQSxRQUFRLENBQUNoQyxJQUFELEVBQU87QUFDWCxXQUFPZCxZQUFZLENBQUMsS0FBSzBDLEtBQU4sRUFBYTVCLElBQWIsRUFBbUIsS0FBSytFLFVBQXhCLENBQW5CO0FBQ0g7O0FBRURDLEVBQUFBLE1BQU0sQ0FBQ2hGLElBQUQsRUFBTztBQUNULFVBQU00QixLQUFLLEdBQUcxQyxZQUFZLENBQUMsS0FBSzBDLEtBQU4sRUFBYTVCLElBQWIsRUFBbUIsS0FBSytFLFVBQXhCLENBQTFCO0FBQ0EsU0FBS25ELEtBQUwsR0FBYUEsS0FBYjtBQUNBLFdBQU8sSUFBUDtBQUNIOztBQTdCSzs7QUFnQ1ZpRCxHQUFHLENBQUN6RyxLQUFKLEdBQVlBLEtBQVo7QUFDQXlHLEdBQUcsQ0FBQzdDLFFBQUosR0FBZTlDLFlBQWY7QUFDQTJGLEdBQUcsQ0FBQ3hDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQTRDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9FWFBSX1NZTlRBWCA9ICdJbnZhbGlkIGV4cHJlc3Npb24gc3ludGF4Lic7XG5cbmNvbnN0IElOVkFMSURfUVVFUllfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke3Rva2VufVwiLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgdGVzdCBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfUVVFUllfSEFORExFUiA9IG9wID0+IGBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIGhhbmRsZXIgbm90IGZvdW5kLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfSEFOTERFUiA9IG9wID0+IGBKRVMgdGVzdCBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcblxuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfVFVQTEUgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBjb2xsZWN0aW9uIG9wZXJhdG9yICR7b3AgPyAnXCIgKyBvcCArIFwiICcgOiAnJ31tdXN0IGJlIGEgdHdvLXR1cGxlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9UVVBMRV8yX09SXzMgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBlaXRoZXIgYSAyLXR1cGxlIG9yIGEgMy10dXBsZS5gO1xuY29uc3QgT1BFUkFORF9OT1RfQVJSQVkgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBhbiBhcnJheS5gO1xuY29uc3QgT1BFUkFORF9OT1RfQk9PTCA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS5gO1xuY29uc3QgT1BFUkFORF9OT1RfU1RSSU5HID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgYSBzdHJpbmcuYDtcblxuY29uc3QgVkFMVUVfTk9UX0NPTExFQ1RJT04gPSBvcCA9PiBgVGhlIHZhbHVlIHVzaW5nIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgZWl0aGVyIGFuIG9iamVjdCBvciBhbiBhcnJheS5gO1xuXG5jb25zdCBSRVFVSVJFX1JJR0hUX09QRVJBTkQgPSBvcCA9PiBgQmluYXJ5IHF1ZXJ5IG9wZXJhdG9yIFwiJHtvcH1cIiByZXF1aXJlcyB0aGUgcmlnaHQgb3BlcmFuZC5gXG5cbi8vQ29uZGl0aW9uIG9wZXJhdG9yXG5jb25zdCBPUF9FUVVBTCA9IFsgJyRlcScsICckZXFsJywgJyRlcXVhbCcgXTtcbmNvbnN0IE9QX05PVF9FUVVBTCA9IFsgJyRuZScsICckbmVxJywgJyRub3RFcXVhbCcgXTtcbmNvbnN0IE9QX05PVCA9IFsgJyRub3QnIF07XG5jb25zdCBPUF9HUkVBVEVSX1RIQU4gPSBbICckZ3QnLCAnJD4nLCAnJGdyZWF0ZXJUaGFuJyBdO1xuY29uc3QgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMID0gWyAnJGd0ZScsICckPD0nLCAnJGdyZWF0ZXJUaGFuT3JFcXVhbCcgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTiA9IFsgJyRsdCcsICckPCcsICckbGVzc1RoYW4nIF07XG5jb25zdCBPUF9MRVNTX1RIQU5fT1JfRVFVQUwgPSBbICckbHRlJywgJyQ8PScsICckbGVzc1RoYW5PckVxdWFsJyBdO1xuXG5jb25zdCBPUF9JTiA9IFsgJyRpbicgXTtcbmNvbnN0IE9QX05PVF9JTiA9IFsgJyRuaW4nLCAnJG5vdEluJyBdO1xuY29uc3QgT1BfRVhJU1RTID0gWyAnJGV4aXN0JywgJyRleGlzdHMnLCAnJG5vdE51bGwnIF07XG5jb25zdCBPUF9NQVRDSCA9IFsgJyRoYXMnLCAnJG1hdGNoJywgJyRhbGwnIF07XG5jb25zdCBPUF9NQVRDSF9BTlkgPSBbICckYW55JywgJyRvcicsICckZWl0aGVyJyBdO1xuY29uc3QgT1BfVFlQRSA9IFsgJyRpcycsICckdHlwZU9mJyBdO1xuY29uc3QgT1BfSEFTX0tFWVMgPSBbICckaGFzS2V5cycsICckd2l0aEtleXMnIF07XG5jb25zdCBPUF9TVEFSVF9XSVRIID0gWyAnJHN0YXJ0V2l0aCcsICckc3RhcnRzV2l0aCcgXTtcbmNvbnN0IE9QX0VORF9XSVRIID0gWyAnJGVuZFdpdGgnLCAnJGVuZHNXaXRoJyBdO1xuXG4vL1F1ZXJ5ICYgYWdncmVnYXRlIG9wZXJhdG9yXG5jb25zdCBPUF9TSVpFID0gWyAnJHNpemUnLCAnJGxlbmd0aCcsICckY291bnQnIF07XG5jb25zdCBPUF9TVU0gPSBbICckc3VtJywgJyR0b3RhbCcgXTtcbmNvbnN0IE9QX0tFWVMgPSBbICcka2V5cycgXTtcbmNvbnN0IE9QX1ZBTFVFUyA9IFsgJyR2YWx1ZXMnIF07XG5jb25zdCBPUF9HRVRfVFlQRSA9IFsgJyR0eXBlJyBdO1xuXG4vL01hbmlwdWxhdGUgb3BlcmF0aW9uXG5jb25zdCBPUF9BREQgPSBbICckYWRkJywgJyRwbHVzJywgICAgICckaW5jJyBdO1xuY29uc3QgT1BfU1VCID0gWyAnJHN1YicsICckc3VidHJhY3QnLCAnJG1pbnVzJywgJyRkZWMnIF07XG5jb25zdCBPUF9NVUwgPSBbICckbXVsJywgJyRtdWx0aXBseScsICAnJHRpbWVzJyBdO1xuY29uc3QgT1BfRElWID0gWyAnJGRpdicsICckZGl2aWRlJyBdO1xuY29uc3QgT1BfU0VUID0gWyAnJHNldCcsICckPScgXTtcbmNvbnN0IE9QX0FERF9JVEVNID0gWyAnJGFkZEl0ZW0nIF07XG5cbmNvbnN0IE9QX1BJQ0sgPSBbICckcGljaycgXTtcbmNvbnN0IE9QX0dFVF9CWV9JTkRFWCA9IFsgJyRhdCcsICckZ2V0QnlJbmRleCcsICckbnRoJyBdO1xuY29uc3QgT1BfR0VUX0JZX0tFWSA9IFsgJyRvZicsICckZ2V0QnlLZXknIF07XG5jb25zdCBPUF9PTUlUID0gWyAnJG9taXQnIF07XG5jb25zdCBPUF9HUk9VUCA9IFsgJyRncm91cCcsICckZ3JvdXBCeScgXTtcbmNvbnN0IE9QX1NPUlQgPSBbICckc29ydCcsICckb3JkZXJCeScsICckc29ydEJ5JyBdO1xuY29uc3QgT1BfUkVWRVJTRSA9IFsgJyRyZXZlcnNlJyBdO1xuY29uc3QgT1BfRVZBTCA9IFsgJyRldmFsJywgJyRhcHBseScgXTtcbmNvbnN0IE9QX01FUkdFID0gWyAnJG1lcmdlJyBdO1xuXG4vL0NvbmRpdGlvbiBvcGVyYXRpb25cbmNvbnN0IE9QX0lGID0gWyAnJGlmJyBdO1xuXG5jb25zdCBQRlhfRk9SX0VBQ0ggPSAnfD4nOyAvLyBmb3IgZWFjaFxuY29uc3QgUEZYX1dJVEhfQU5ZID0gJ3wqJzsgLy8gd2l0aCBhbnlcblxuY29uc3QgTWFwT2ZPcHMgPSBuZXcgTWFwKCk7XG5jb25zdCBhZGRPcFRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk9wcy5zZXQodG9rZW4sIHRhZykpO1xuYWRkT3BUb01hcChPUF9FUVVBTCwgJ09QX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9FUVVBTCwgJ09QX05PVF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1QsICdPUF9OT1QnKTtcbmFkZE9wVG9NYXAoT1BfR1JFQVRFUl9USEFOLCAnT1BfR1JFQVRFUl9USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCwgJ09QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9MRVNTX1RIQU4sICdPUF9MRVNTX1RIQU4nKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOX09SX0VRVUFMLCAnT1BfTEVTU19USEFOX09SX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX0lOLCAnT1BfSU4nKTtcbmFkZE9wVG9NYXAoT1BfTk9UX0lOLCAnT1BfTk9UX0lOJyk7XG5hZGRPcFRvTWFwKE9QX0VYSVNUUywgJ09QX0VYSVNUUycpO1xuYWRkT3BUb01hcChPUF9NQVRDSCwgJ09QX01BVENIJyk7XG5hZGRPcFRvTWFwKE9QX01BVENIX0FOWSwgJ09QX01BVENIX0FOWScpO1xuYWRkT3BUb01hcChPUF9UWVBFLCAnT1BfVFlQRScpO1xuYWRkT3BUb01hcChPUF9IQVNfS0VZUywgJ09QX0hBU19LRVlTJyk7XG5hZGRPcFRvTWFwKE9QX1NUQVJUX1dJVEgsICdPUF9TVEFSVF9XSVRIJyk7XG5hZGRPcFRvTWFwKE9QX0VORF9XSVRILCAnT1BfRU5EX1dJVEgnKTtcblxuY29uc3QgTWFwT2ZNYW5zID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkTWFuVG9NYXAgPSAodG9rZW5zLCB0YWcpID0+IHRva2Vucy5mb3JFYWNoKHRva2VuID0+IE1hcE9mTWFucy5zZXQodG9rZW4sIHRhZykpO1xuLy8gWyA8b3AgbmFtZT4sIDx1bmFyeT4gXVxuYWRkTWFuVG9NYXAoT1BfU0laRSwgWydPUF9TSVpFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVU0sIFsnT1BfU1VNJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9LRVlTLCBbJ09QX0tFWVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1ZBTFVFUywgWydPUF9WQUxVRVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX0dFVF9UWVBFLCBbJ09QX0dFVF9UWVBFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9SRVZFUlNFLCBbJ09QX1JFVkVSU0UnLCB0cnVlXSk7XG5cbmFkZE1hblRvTWFwKE9QX0FERCwgWydPUF9BREQnLCBmYWxzZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVUIsIFsnT1BfU1VCJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9NVUwsIFsnT1BfTVVMJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9ESVYsIFsnT1BfRElWJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9TRVQsIFsnT1BfU0VUJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9BRERfSVRFTSwgWydPUF9BRERfSVRFTScsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfUElDSywgWydPUF9QSUNLJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9JTkRFWCwgWydPUF9HRVRfQllfSU5ERVgnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR0VUX0JZX0tFWSwgWydPUF9HRVRfQllfS0VZJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX09NSVQsIFsnT1BfT01JVCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HUk9VUCwgWydPUF9HUk9VUCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9TT1JULCBbJ09QX1NPUlQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfRVZBTCwgWydPUF9FVkFMJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX01FUkdFLCBbJ09QX01FUkdFJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0lGLCBbJ09QX0lGJywgZmFsc2VdKTtcblxuY29uc3QgZGVmYXVsdEplc0hhbmRsZXJzID0ge1xuICAgIE9QX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IF8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfTk9UX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+ICFfLmlzRXF1YWwobGVmdCwgcmlnaHQpLFxuICAgIE9QX05PVDogKGxlZnQsIC4uLmFyZ3MpID0+ICF0ZXN0KGxlZnQsICdPUF9NQVRDSCcsIC4uLmFyZ3MpLFxuICAgIE9QX0dSRUFURVJfVEhBTjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID4gcmlnaHQsXG4gICAgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPj0gcmlnaHQsXG4gICAgT1BfTEVTU19USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPCByaWdodCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8PSByaWdodCxcbiAgICBPUF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQuZmluZChlbGVtZW50ID0+IGRlZmF1bHRKZXNIYW5kbGVycy5PUF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9OT1RfSU46IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAocmlnaHQgPT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTk9UX0lOJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX05PVF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9FWElTVFM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9CT09MKCdPUF9FWElTVFMnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQgPyBsZWZ0ICE9IG51bGwgOiBsZWZ0ID09IG51bGw7XG4gICAgfSxcbiAgICBPUF9UWVBFOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX1RZUEUnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByaWdodCA9IHJpZ2h0LnRvTG93ZXJDYXNlKCk7XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAnYXJyYXknKSB7XG4gICAgICAgICAgICByZXR1cm4gQXJyYXkuaXNBcnJheShsZWZ0KTtcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdpbnRlZ2VyJykge1xuICAgICAgICAgICAgcmV0dXJuIF8uaXNJbnRlZ2VyKGxlZnQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gJ3N0cmluZyc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHlwZW9mIGxlZnQgPT09IHJpZ2h0O1xuICAgIH0sXG4gICAgT1BfTUFUQ0g6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgcnVsZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCk7XG4gICAgICAgIHJldHVybiByWzBdO1xuICAgIH0sXG4gICAgT1BfTUFUQ0hfQU5ZOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUFUQ0hfQU5ZJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCBydWxlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgfSk7ICAgXG4gICAgXG4gICAgICAgIHJldHVybiBmb3VuZCA/IHRydWUgOiBmYWxzZTtcbiAgICB9LFxuICAgIE9QX0hBU19LRVlTOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGtleSA9PiBoYXNLZXlCeVBhdGgobGVmdCwga2V5KSk7XG4gICAgfSxcbiAgICBPUF9TVEFSVF9XSVRIOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9TVEFSVF9XSVRIJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnQuc3RhcnRzV2l0aChyaWdodCk7XG4gICAgfSxcbiAgICBPUF9FTkRfV0lUSDogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfRU5EX1dJVEgnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdC5lbmRzV2l0aChyaWdodCk7XG4gICAgfSAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRNYW5pcHVsYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAobGVmdCkgPT4gXy5zaXplKGxlZnQpLFxuICAgIE9QX1NVTTogKGxlZnQpID0+IF8ucmVkdWNlKGxlZnQsIChzdW0sIGl0ZW0pID0+IHtcbiAgICAgICAgICAgIHN1bSArPSBpdGVtO1xuICAgICAgICAgICAgcmV0dXJuIHN1bTtcbiAgICAgICAgfSwgMCksXG5cbiAgICBPUF9LRVlTOiAobGVmdCkgPT4gXy5rZXlzKGxlZnQpLFxuICAgIE9QX1ZBTFVFUzogKGxlZnQpID0+IF8udmFsdWVzKGxlZnQpLCAgIFxuICAgIE9QX0dFVF9UWVBFOiAobGVmdCkgPT4gQXJyYXkuaXNBcnJheShsZWZ0KSA/ICdhcnJheScgOiAoXy5pc0ludGVnZXIobGVmdCkgPyAnaW50ZWdlcicgOiB0eXBlb2YgbGVmdCksICBcbiAgICBPUF9SRVZFUlNFOiAobGVmdCkgPT4gXy5yZXZlcnNlKGxlZnQpLFxuXG4gICAgLy9iaW5hcnlcbiAgICBPUF9BREQ6IChsZWZ0LCByaWdodCkgPT4gbGVmdCArIHJpZ2h0LFxuICAgIE9QX1NVQjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC0gcmlnaHQsXG4gICAgT1BfTVVMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgKiByaWdodCxcbiAgICBPUF9ESVY6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAvIHJpZ2h0LCBcbiAgICBPUF9TRVQ6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSksIFxuICAgIE9QX0FERF9JVEVNOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihWQUxVRV9OT1RfQ09MTEVDVElPTignT1BfQUREX0lURU0nKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnQuY29uY2F0KHJpZ2h0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkgfHwgcmlnaHQubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEUoJ09QX0FERF9JVEVNJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgLi4ubGVmdCwgW3JpZ2h0WzBdXTogZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgcmlnaHRbMV0sIGplcywgcHJlZml4LCBjb250ZXh0LCB0cnVlKSB9O1xuICAgIH0sIFxuICAgIE9QX1BJQ0s6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKGxlZnQgPT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmlnaHQgPSBfLmNhc3RBcnJheShyaWdodCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnBpY2sobGVmdCwgcmlnaHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiBfLnBpY2tCeShsZWZ0LCAoeCwga2V5KSA9PiBtYXRjaChrZXksIHJpZ2h0LCBqZXMsIHByZWZpeClbMF0pO1xuICAgIH0sXG4gICAgT1BfR0VUX0JZX0lOREVYOiAobGVmdCwgcmlnaHQpID0+IF8ubnRoKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HRVRfQllfS0VZOiAobGVmdCwgcmlnaHQpID0+IF8uZ2V0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9PTUlUOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPT0gbnVsbCA/IG51bGwgOiBfLm9taXQobGVmdCwgcmlnaHQpLFxuICAgIE9QX0dST1VQOiAobGVmdCwgcmlnaHQpID0+IF8uZ3JvdXBCeShsZWZ0LCByaWdodCksXG4gICAgT1BfU09SVDogKGxlZnQsIHJpZ2h0KSA9PiBfLnNvcnRCeShsZWZ0LCByaWdodCksICBcbiAgICBPUF9FVkFMOiBldmFsdWF0ZUV4cHIsXG4gICAgT1BfTUVSR0U6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9NRVJHRScpKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJpZ2h0LnJlZHVjZSgocmVzdWx0LCBleHByKSA9PiBPYmplY3QuYXNzaWduKHJlc3VsdCwgZXZhbHVhdGVFeHByKGxlZnQsIGV4cHIsIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQgfSkpLCB7fSk7XG4gICAgfSxcbiAgICBPUF9JRjogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX0lGJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJpZ2h0Lmxlbmd0aCA8IDIgfHwgcmlnaHQubGVuZ3RoID4gMykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1RVUExFXzJfT1JfMygnT1BfSUYnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjb25kaXRpb24gPSBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCByaWdodFswXSwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHRydWUpO1xuXG4gICAgICAgIGNvbnNvbGUubG9nKGxlZnQsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgaWYgKHRlc3QobGVmdCwgJ09QX01BVENIJywgY29uZGl0aW9uLCBqZXMsIHByZWZpeCkpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCd0cnVlJyk7XG4gICAgICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKGxlZnQsIHJpZ2h0WzFdLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSBpZiAocmlnaHQubGVuZ3RoID4gMikgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgcmV0ID0gZXZhbHVhdGVFeHByKGxlZnQsIHJpZ2h0WzJdLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnZmFsc2UnLCByZXQpO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnNvbGUubG9nKCdmYWxzZScpO1xuICAgICAgICByZXR1cm4gbGVmdDtcbiAgICB9XG59XG5cbmNvbnN0IGZvcm1hdE5hbWUgPSAobmFtZSwgcHJlZml4KSA9PiB7XG4gICAgY29uc3QgZnVsbE5hbWUgPSBuYW1lID09IG51bGwgPyBwcmVmaXggOiBmb3JtYXRQcmVmaXgobmFtZSwgcHJlZml4KTtcbiAgICByZXR1cm4gZnVsbE5hbWUgPT0gbnVsbCA/IFwiVGhlIHZhbHVlXCIgOiAoZnVsbE5hbWUuaW5kZXhPZignKCcpICE9PSAtMSA/IGBUaGUgcXVlcnkgXCJfLiR7ZnVsbE5hbWV9XCJgIDogYFwiJHtmdWxsTmFtZX1cImApO1xufTtcbmNvbnN0IGZvcm1hdEtleSA9IChrZXksIGhhc1ByZWZpeCkgPT4gXy5pc0ludGVnZXIoa2V5KSA/IGBbJHtrZXl9XWAgOiAoaGFzUHJlZml4ID8gJy4nICsga2V5IDoga2V5KTtcbmNvbnN0IGZvcm1hdFByZWZpeCA9IChrZXksIHByZWZpeCkgPT4gcHJlZml4ICE9IG51bGwgPyBgJHtwcmVmaXh9JHtmb3JtYXRLZXkoa2V5LCB0cnVlKX1gIDogZm9ybWF0S2V5KGtleSwgZmFsc2UpO1xuY29uc3QgZm9ybWF0UXVlcnkgPSAob3BNZXRhKSA9PiBgJHtkZWZhdWx0UXVlcnlFeHBsYW5hdGlvbnNbb3BNZXRhWzBdXX0oJHtvcE1ldGFbMV0gPyAnJyA6ICc/J30pYDsgIFxuY29uc3QgZm9ybWF0TWFwID0gKG5hbWUpID0+IGBlYWNoKC0+JHtuYW1lfSlgO1xuY29uc3QgZm9ybWF0QW55ID0gKG5hbWUpID0+IGBhbnkoLT4ke25hbWV9KWA7XG5cbmNvbnN0IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMgPSB7XG4gICAgT1BfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBtYXRjaCAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9HUkVBVEVSX1RIQU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiBvciBlcXVhbCB0byAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlIGFueSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9FWElTVFM6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCR7cmlnaHQgPyAnIG5vdCAnOiAnICd9YmUgTlVMTC5gLCAgICBcbiAgICBPUF9UWVBFOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYFRoZSB0eXBlIG9mICR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgXCIke3JpZ2h0fVwiLCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgICAgIFxuICAgIE9QX01BVENIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfTUFUQ0hfQU5ZOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggYW55IG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX0hBU19LRVlTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgaGF2ZSBhbGwgb2YgdGhlc2Uga2V5cyBbJHtyaWdodC5qb2luKCcsICcpfV0uYCwgICAgICAgIFxuICAgIE9QX1NUQVJUX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBzdGFydCB3aXRoIFwiJHtyaWdodH1cIi5gLCAgICAgICAgXG4gICAgT1BfRU5EX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBlbmQgd2l0aCBcIiR7cmlnaHR9XCIuYCwgICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAnc2l6ZScsXG4gICAgT1BfU1VNOiAnc3VtJyxcbiAgICBPUF9LRVlTOiAna2V5cycsXG4gICAgT1BfVkFMVUVTOiAndmFsdWVzJywgICAgXG4gICAgT1BfR0VUX1RZUEU6ICdnZXQgdHlwZScsXG4gICAgT1BfUkVWRVJTRTogJ3JldmVyc2UnLCBcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAnYWRkJyxcbiAgICBPUF9TVUI6ICdzdWJ0cmFjdCcsXG4gICAgT1BfTVVMOiAnbXVsdGlwbHknLFxuICAgIE9QX0RJVjogJ2RpdmlkZScsIFxuICAgIE9QX1NFVDogJ2Fzc2lnbicsXG4gICAgT1BfQUREX0lURU06ICdhZGRJdGVtJyxcbiAgICBPUF9QSUNLOiAncGljaycsXG4gICAgT1BfR0VUX0JZX0lOREVYOiAnZ2V0IGVsZW1lbnQgYXQgaW5kZXgnLFxuICAgIE9QX0dFVF9CWV9LRVk6ICdnZXQgZWxlbWVudCBvZiBrZXknLFxuICAgIE9QX09NSVQ6ICdvbWl0JyxcbiAgICBPUF9HUk9VUDogJ2dyb3VwQnknLFxuICAgIE9QX1NPUlQ6ICdzb3J0QnknLFxuICAgIE9QX0VWQUw6ICdldmFsdWF0ZScsXG4gICAgT1BfTUVSR0U6ICdtZXJnZScsXG4gICAgT1BfSUY6ICdldmFsdWF0ZSBpZidcbn07XG5cbmZ1bmN0aW9uIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KSB7XG4gICAgY29uc3QgZ2V0dGVyID0gamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zW29wXSB8fCBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfTUFUQ0g7XG4gICAgcmV0dXJuIGdldHRlcihuYW1lLCBsZWZ0VmFsdWUsIHJpZ2h0VmFsdWUsIHByZWZpeCk7ICAgIFxufVxuXG5mdW5jdGlvbiB0ZXN0KHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5vcGVyYXRvckhhbmRsZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX0hBTkxERVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZSh2YWx1ZSwgb3AsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlVW5hcnkodmFsdWUsIG9wLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLnF1ZXJ5SGFubGRlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX0hBTkRMRVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgcmlnaHRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIGlmIChvcE1ldGFbMV0pIHtcbiAgICAgICAgcmV0dXJuIHJpZ2h0VmFsdWUgPyBldmFsdWF0ZVVuYXJ5KGN1cnJlbnRWYWx1ZSwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCkgOiBjdXJyZW50VmFsdWU7XG4gICAgfSBcbiAgICBcbiAgICByZXR1cm4gZXZhbHVhdGUoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIHJpZ2h0VmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuY29uc3QgZGVmYXVsdEN1c3RvbWl6ZXIgPSB7XG4gICAgbWFwT2ZPcGVyYXRvcnM6IE1hcE9mT3BzLFxuICAgIG1hcE9mTWFuaXB1bGF0b3JzOiBNYXBPZk1hbnMsXG4gICAgb3BlcmF0b3JIYW5kbGVyczogZGVmYXVsdEplc0hhbmRsZXJzLFxuICAgIG9wZXJhdG9yRXhwbGFuYXRpb25zOiBkZWZhdWx0SmVzRXhwbGFuYXRpb25zLFxuICAgIHF1ZXJ5SGFubGRlcnM6IGRlZmF1bHRNYW5pcHVsYXRpb25zXG59O1xuXG5mdW5jdGlvbiBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgb3BlcmFuZHMsIGplcywgcHJlZml4KSB7XG4gICAgbGV0IG1hdGNoUmVzdWx0LCBuZXh0UHJlZml4O1xuXG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCBtYXBSZXN1bHQgPSBfLmlzUGxhaW5PYmplY3QoYWN0dWFsKSA/IF8ubWFwVmFsdWVzKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpKSA6IF8ubWFwKGFjdHVhbCwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgb3BlcmFuZHNbMF0sIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSkpO1xuICAgICAgICAgICAgbmV4dFByZWZpeCA9IGZvcm1hdFByZWZpeChmb3JtYXRNYXAoZm9ybWF0UXVlcnkob3BNZXRhKSksIHByZWZpeCk7XG4gICAgICAgICAgICBtYXRjaFJlc3VsdCA9IG1hdGNoKG1hcFJlc3VsdCwgb3BlcmFuZHNbMV0sIGplcywgbmV4dFByZWZpeCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICAgXG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdEFueShmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gbWF0Y2goZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpLCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCB1bm1hdGNoZWRLZXkgPSBfLmZpbmRJbmRleChhY3R1YWwsIChpdGVtKSA9PiAhdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgICAgICBpZiAodW5tYXRjaGVkS2V5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIHVubWF0Y2hlZEtleSwgYWN0dWFsW3VubWF0Y2hlZEtleV0sIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgXG4gICAgICAgICAgICBjb25zdCBtYXRjaGVkID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgIFxuICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIHN3aXRjaCAoY29sbGVjdGlvbk9wKSB7XG4gICAgICAgIGNhc2UgUEZYX0ZPUl9FQUNIOlxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGN1cnJlbnRWYWx1ZSwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGksIHByZWZpeCksIHsgLi4uY29udGV4dCwgJCRQQVJFTlQ6IGN1cnJlbnRWYWx1ZSwgJCRDVVJSRU5UOiBpdGVtIH0pKTtcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICBcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihQUlhfT1BfTk9UX0ZPUl9FVkFMKGNvbGxlY3Rpb25PcCkpO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBcbiAqIEBwYXJhbSB7Kn0gYWN0dWFsIFxuICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAqIEBwYXJhbSB7Kn0gamVzIFxuICogQHBhcmFtIHsqfSBwcmVmaXggIFxuICogXG4gKiB7IGtleTogeyAkbWF0Y2ggfSB9XG4gKi9cbmZ1bmN0aW9uIG1hdGNoKGFjdHVhbCwgZXhwZWN0ZWQsIGplcywgcHJlZml4KSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBsZXQgcGFzc09iamVjdENoZWNrID0gZmFsc2U7XG5cbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChleHBlY3RlZCkpIHtcbiAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbCwgJ09QX0VRVUFMJywgZXhwZWN0ZWQsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVFVQUwobnVsbCwgYWN0dWFsLCBleHBlY3RlZCwgcHJlZml4KSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIF07XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIFt0cnVlXTtcbiAgICB9XG5cbiAgICBmb3IgKGxldCBmaWVsZE5hbWUgaW4gZXhwZWN0ZWQpIHtcbiAgICAgICAgbGV0IGV4cGVjdGVkRmllbGRWYWx1ZSA9IGV4cGVjdGVkW2ZpZWxkTmFtZV07IFxuICAgICAgICBcbiAgICAgICAgY29uc3QgbCA9IGZpZWxkTmFtZS5sZW5ndGg7XG5cbiAgICAgICAgaWYgKGwgPiAxKSB7ICAgICBcbiAgICAgICAgICAgIGlmIChsID4gNCAmJiBmaWVsZE5hbWVbMF0gPT09ICd8JyAmJiBmaWVsZE5hbWVbMl0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbM10gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZXhwZWN0ZWRGaWVsZFZhbHVlKSAmJiBleHBlY3RlZEZpZWxkVmFsdWUubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEUoKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMyk7IFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXRjaFJlc3VsdCkgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL3ZhbGlkYXRvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wID0gamVzLm1hcE9mT3BlcmF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGwgPiAyICYmIGZpZWxkTmFtZVsxXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMSk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy9wcm9jZXNzb3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGFbMV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihOT1RfQV9VTkFSWV9RVUVSWSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBxdWVyeVJlc3VsdCA9IGV2YWx1YXRlVW5hcnkoYWN0dWFsLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoKHF1ZXJ5UmVzdWx0LCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZvcm1hdFF1ZXJ5KG9wTWV0YSksIHByZWZpeCkpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3ZhbGlkYXRvclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wID0gamVzLm1hcE9mT3BlcmF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfVEVTVF9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKCFwYXNzT2JqZWN0Q2hlY2spIHtcbiAgICAgICAgICAgIGlmIChhY3R1YWwgPT0gbnVsbCkgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSwgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX0VYSVNUUyhudWxsLCBudWxsLCB0cnVlLCBwcmVmaXgpXG4gICAgICAgICAgICBdOyBcblxuICAgICAgICAgICAgY29uc3QgYWN0dWFsVHlwZSA9IHR5cGVvZiBhY3R1YWw7XG4gICAgXG4gICAgICAgICAgICBpZiAoYWN0dWFsVHlwZSAhPT0gJ29iamVjdCcpIHJldHVybiBbXG4gICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX1RZUEUobnVsbCwgYWN0dWFsVHlwZSwgJ29iamVjdCcsIHByZWZpeClcbiAgICAgICAgICAgIF07ICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBwYXNzT2JqZWN0Q2hlY2sgPSB0cnVlO1xuXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gXy5nZXQoYWN0dWFsLCBmaWVsZE5hbWUpOyAgICAgXG4gICAgICAgIFxuICAgICAgICBpZiAoZXhwZWN0ZWRGaWVsZFZhbHVlICE9IG51bGwgJiYgdHlwZW9mIGV4cGVjdGVkRmllbGRWYWx1ZSA9PT0gJ29iamVjdCcpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IFsgb2ssIHJlYXNvbiBdID0gbWF0Y2goYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCkpO1xuICAgICAgICAgICAgaWYgKCFvaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBbIGZhbHNlLCByZWFzb24gXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWxGaWVsZFZhbHVlLCAnT1BfRVFVQUwnLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVFVQUwoZmllbGROYW1lLCBhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBbdHJ1ZV07XG59XG5cbi8qKlxuICogSWYgJCBvcGVyYXRvciB1c2VkLCBvbmx5IG9uZSBhIHRpbWUgaXMgYWxsb3dlZFxuICogZS5nLlxuICoge1xuICogICAgJGdyb3VwQnk6ICdrZXknXG4gKiB9XG4gKiBcbiAqIFxuICogQHBhcmFtIHsqfSBjdXJyZW50VmFsdWUgXG4gKiBAcGFyYW0geyp9IGV4cHIgXG4gKiBAcGFyYW0geyp9IHByZWZpeCBcbiAqIEBwYXJhbSB7Kn0gamVzIFxuICogQHBhcmFtIHsqfSBjb250ZXh0XG4gKi9cbmZ1bmN0aW9uIGV2YWx1YXRlRXhwcihjdXJyZW50VmFsdWUsIGV4cHIsIGplcywgcHJlZml4LCBjb250ZXh0LCBzZXRPcCkge1xuICAgIGplcyAhPSBudWxsIHx8IChqZXMgPSBkZWZhdWx0Q3VzdG9taXplcik7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZXhwcikpIHtcbiAgICAgICAgaWYgKHNldE9wKSB7XG4gICAgICAgICAgICByZXR1cm4gZXhwci5tYXAoaXRlbSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCBpdGVtLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0sIHRydWUpKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGV4cHIucmVkdWNlKChyZXN1bHQsIGV4cHJJdGVtKSA9PiBldmFsdWF0ZUV4cHIocmVzdWx0LCBleHBySXRlbSwgamVzLCBwcmVmaXgsIHsgLi4uY29udGV4dCB9KSwgY3VycmVudFZhbHVlKTtcbiAgICB9XG5cbiAgICBjb25zdCB0eXBlRXhwciA9IHR5cGVvZiBleHByO1xuXG4gICAgaWYgKHR5cGVFeHByID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICBpZiAoc2V0T3ApIHJldHVybiBleHByO1xuICAgICAgICByZXR1cm4gZXhwciA/IGN1cnJlbnRWYWx1ZSA6IHVuZGVmaW5lZDtcbiAgICB9ICAgIFxuXG4gICAgaWYgKHR5cGVFeHByID09PSBcIm51bWJlclwiIHx8IHR5cGVFeHByID09PSBcImJpZ2ludFwiKSB7XG4gICAgICAgIGlmIChzZXRPcCkgcmV0dXJuIGV4cHI7XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfRVhQUl9TWU5UQVgpO1xuICAgIH1cblxuICAgIGlmICh0eXBlRXhwciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKGV4cHIuc3RhcnRzV2l0aCgnJCQnKSkge1xuICAgICAgICAgICAgLy9nZXQgZnJvbSBjb250ZXh0XG4gICAgICAgICAgICBjb25zdCBwb3MgPSBleHByLmluZGV4T2YoJy4nKTtcbiAgICAgICAgICAgIGlmIChwb3MgPT09IC0xKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBjb250ZXh0W2V4cHJdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5nZXQoY29udGV4dFtleHByLnN1YnN0cigwLCBwb3MpXSwgZXhwci5zdWJzdHIocG9zKzEpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzZXRPcCkge1xuICAgICAgICAgICAgcmV0dXJuIGV4cHI7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGV4cHIpO1xuICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFvcE1ldGFbMV0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihSRVFVSVJFX1JJR0hUX09QRVJBTkQoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KTtcbiAgICB9IFxuXG4gICAgaWYgKHR5cGVFeHByICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0VYUFJfU1lOVEFYKTtcbiAgICB9XG5cbiAgICBpZiAoc2V0T3ApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKGV4cHIsIGl0ZW0gPT4gZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgaXRlbSwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHRydWUpKTtcbiAgICB9XG5cbiAgICBpZiAoY29udGV4dCA9PSBudWxsKSB7IFxuICAgICAgICBjb250ZXh0ID0geyAkJFJPT1Q6IGN1cnJlbnRWYWx1ZSwgJCRQQVJFTlQ6IG51bGwsICQkQ1VSUkVOVDogY3VycmVudFZhbHVlIH07ICAgICAgICBcbiAgICB9IFxuXG4gICAgbGV0IHJlc3VsdCwgaGFzT3BlcmF0b3IgPSBmYWxzZTsgICAgXG5cbiAgICBmb3IgKGxldCBmaWVsZE5hbWUgaW4gZXhwcikge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwcltmaWVsZE5hbWVdOyAgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xuICAgICAgICAgICAgICAgIGhhc09wZXJhdG9yID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGwgPiAzICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDIpOyBcblxuICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXN1bHQgPSBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29tcGxleUtleSA9IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgIT09IC0xO1xuXG4gICAgICAgIC8vcGljayBhIGZpZWxkIGFuZCB0aGVuIGFwcGx5IG1hbmlwdWxhdGlvblxuICAgICAgICBsZXQgYWN0dWFsRmllbGRWYWx1ZSA9IGN1cnJlbnRWYWx1ZSAhPSBudWxsID8gKGNvbXBsZXlLZXkgPyBfLmdldChjdXJyZW50VmFsdWUsIGZpZWxkTmFtZSkgOiBjdXJyZW50VmFsdWVbZmllbGROYW1lXSkgOiB1bmRlZmluZWQ7ICAgICAgICAgXG5cbiAgICAgICAgY29uc3QgY2hpbGRGaWVsZFZhbHVlID0gZXZhbHVhdGVFeHByKGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZmllbGROYW1lLCBwcmVmaXgpLCBjb250ZXh0KTtcblxuICAgICAgICBpZiAodHlwZW9mIGNoaWxkRmllbGRWYWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9PSBudWxsICYmIChyZXN1bHQgPSB7fSk7XG4gICAgICAgICAgICBpZiAoY29tcGxleUtleSkge1xuICAgICAgICAgICAgICAgIF8uc2V0KHJlc3VsdCwgZmllbGROYW1lLCBjaGlsZEZpZWxkVmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXN1bHRbZmllbGROYW1lXSA9IGNoaWxkRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuY2xhc3MgSkVTIHtcbiAgICBjb25zdHJ1Y3Rvcih2YWx1ZSwgY3VzdG9taXplcikge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgIHRoaXMuY3VzdG9taXplciA9IGN1c3RvbWl6ZXI7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAgICAgKiBAcGFyYW0gIHsuLi5hbnl9IGFyZ3MgXG4gICAgICovXG4gICAgbWF0Y2goZXhwZWN0ZWQpIHsgICAgICAgIFxuICAgICAgICBjb25zdCByZXN1bHQgPSBtYXRjaCh0aGlzLnZhbHVlLCBleHBlY3RlZCwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgaWYgKHJlc3VsdFswXSkgcmV0dXJuIHRoaXM7XG5cbiAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihyZXN1bHRbMV0sIHtcbiAgICAgICAgICAgIGFjdHVhbDogdGhpcy52YWx1ZSxcbiAgICAgICAgICAgIGV4cGVjdGVkXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGV2YWx1YXRlKGV4cHIpIHtcbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlRXhwcih0aGlzLnZhbHVlLCBleHByLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgIH1cblxuICAgIHVwZGF0ZShleHByKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxufVxuXG5KRVMubWF0Y2ggPSBtYXRjaDtcbkpFUy5ldmFsdWF0ZSA9IGV2YWx1YXRlRXhwcjtcbkpFUy5kZWZhdWx0Q3VzdG9taXplciA9IGRlZmF1bHRDdXN0b21pemVyO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEpFUzsiXX0=
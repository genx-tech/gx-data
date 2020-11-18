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
const OP_ADD_ITEM = ['$addItem', '$override'];
const OP_PICK = ['$pick'];
const OP_GET_BY_INDEX = ['$at', '$getByIndex', '$nth'];
const OP_GET_BY_KEY = ['$of', '$getByKey'];
const OP_OMIT = ['$omit'];
const OP_GROUP = ['$group', '$groupBy'];
const OP_SORT = ['$sort', '$orderBy', '$sortBy'];
const OP_REVERSE = ['$reverse'];
const OP_EVAL = ['$eval', '$apply'];
const OP_MERGE = ['$merge'];
const OP_FILTER = ['$filter', '$select'];
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
addManToMap(OP_FILTER, ['OP_FILTER', false]);
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
      [right[0]]: evaluateExpr(left, right[1], jes, prefix, { ...context,
        $$PARENT: context.$$CURRENT,
        $$CURRENT: left
      })
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

    return _.pickBy(left, (x, key) => match(key, right, jes, formatPrefix(key, prefix))[0]);
  },
  OP_GET_BY_INDEX: (left, right) => _.nth(left, right),
  OP_GET_BY_KEY: (left, right) => _.get(left, right),
  OP_OMIT: (left, right, jes, prefix) => {
    if (left == null) return null;

    if (typeof right !== "object") {
      right = _.castArray(right);
    }

    if (Array.isArray(right)) {
      return _.omit(left, right);
    }

    return _.omitBy(left, (x, key) => match(key, right, jes, formatPrefix(key, prefix))[0]);
  },
  OP_GROUP: (left, right) => _.groupBy(left, right),
  OP_SORT: (left, right) => _.sortBy(left, right),
  OP_EVAL: evaluateExpr,
  OP_MERGE: (left, right, jes, prefix, context) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_MERGE'));
    }

    return right.reduce((result, expr, key) => Object.assign(result, evaluateExpr(left, expr, jes, formatPrefix(key, prefix), { ...context
    })), {});
  },
  OP_FILTER: (left, right, jes, prefix, context) => {
    if (left == null) return null;

    if (typeof left !== "object") {
      throw new ValidationError(VALUE_NOT_COLLECTION('OP_FILTER'));
    }

    return _.filter(left, (value, key) => test(value, 'OP_MATCH', right, jes, formatPrefix(key, prefix)));
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
  OP_FILTER: 'filter',
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJOT1RfQV9VTkFSWV9RVUVSWSIsIklOVkFMSURfRVhQUl9TWU5UQVgiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiSU5WQUxJRF9DT0xMRUNUSU9OX09QIiwiUFJYX09QX05PVF9GT1JfRVZBTCIsInByZWZpeCIsIk9QRVJBTkRfTk9UX1RVUExFIiwiT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zIiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiVkFMVUVfTk9UX0NPTExFQ1RJT04iLCJSRVFVSVJFX1JJR0hUX09QRVJBTkQiLCJPUF9FUVVBTCIsIk9QX05PVF9FUVVBTCIsIk9QX05PVCIsIk9QX0dSRUFURVJfVEhBTiIsIk9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCIsIk9QX0xFU1NfVEhBTiIsIk9QX0xFU1NfVEhBTl9PUl9FUVVBTCIsIk9QX0lOIiwiT1BfTk9UX0lOIiwiT1BfRVhJU1RTIiwiT1BfTUFUQ0giLCJPUF9NQVRDSF9BTlkiLCJPUF9UWVBFIiwiT1BfSEFTX0tFWVMiLCJPUF9TVEFSVF9XSVRIIiwiT1BfRU5EX1dJVEgiLCJPUF9TSVpFIiwiT1BfU1VNIiwiT1BfS0VZUyIsIk9QX1ZBTFVFUyIsIk9QX0dFVF9UWVBFIiwiT1BfQUREIiwiT1BfU1VCIiwiT1BfTVVMIiwiT1BfRElWIiwiT1BfU0VUIiwiT1BfQUREX0lURU0iLCJPUF9QSUNLIiwiT1BfR0VUX0JZX0lOREVYIiwiT1BfR0VUX0JZX0tFWSIsIk9QX09NSVQiLCJPUF9HUk9VUCIsIk9QX1NPUlQiLCJPUF9SRVZFUlNFIiwiT1BfRVZBTCIsIk9QX01FUkdFIiwiT1BfRklMVEVSIiwiT1BfSUYiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNvbnRleHQiLCJldmFsdWF0ZUV4cHIiLCJ1bmRlZmluZWQiLCJjb25jYXQiLCJsZW5ndGgiLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImNhc3RBcnJheSIsInBpY2siLCJwaWNrQnkiLCJ4IiwiZm9ybWF0UHJlZml4IiwibnRoIiwiZ2V0Iiwib21pdCIsIm9taXRCeSIsImdyb3VwQnkiLCJzb3J0QnkiLCJyZXN1bHQiLCJleHByIiwiT2JqZWN0IiwiYXNzaWduIiwiZmlsdGVyIiwidmFsdWUiLCJjb25kaXRpb24iLCJyZXQiLCJmb3JtYXROYW1lIiwibmFtZSIsImZ1bGxOYW1lIiwiaW5kZXhPZiIsImZvcm1hdEtleSIsImhhc1ByZWZpeCIsImZvcm1hdFF1ZXJ5Iiwib3BNZXRhIiwiZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zIiwiZm9ybWF0TWFwIiwiZm9ybWF0QW55IiwiZGVmYXVsdEplc0V4cGxhbmF0aW9ucyIsIkpTT04iLCJzdHJpbmdpZnkiLCJqb2luIiwiZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24iLCJsZWZ0VmFsdWUiLCJyaWdodFZhbHVlIiwiZ2V0dGVyIiwib3BlcmF0b3JFeHBsYW5hdGlvbnMiLCJvcFZhbHVlIiwiaGFuZGxlciIsIm9wZXJhdG9ySGFuZGxlcnMiLCJldmFsdWF0ZSIsInF1ZXJ5SGFubGRlcnMiLCJldmFsdWF0ZVVuYXJ5IiwiZXZhbHVhdGVCeU9wTWV0YSIsImN1cnJlbnRWYWx1ZSIsImRlZmF1bHRDdXN0b21pemVyIiwibWFwT2ZPcGVyYXRvcnMiLCJtYXBPZk1hbmlwdWxhdG9ycyIsIm1hdGNoQ29sbGVjdGlvbiIsImFjdHVhbCIsImNvbGxlY3Rpb25PcCIsIm9wZXJhbmRzIiwibWF0Y2hSZXN1bHQiLCJuZXh0UHJlZml4IiwibWFwUmVzdWx0IiwiaXNQbGFpbk9iamVjdCIsIm1hcFZhbHVlcyIsIm1hcCIsImkiLCJ2YWxpZGF0ZUNvbGxlY3Rpb24iLCJleHBlY3RlZEZpZWxkVmFsdWUiLCJ1bm1hdGNoZWRLZXkiLCJmaW5kSW5kZXgiLCJtYXRjaGVkIiwiZXZhbHVhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWQiLCJwYXNzT2JqZWN0Q2hlY2siLCJmaWVsZE5hbWUiLCJsIiwic3Vic3RyIiwicXVlcnlSZXN1bHQiLCJhY3R1YWxUeXBlIiwiYWN0dWFsRmllbGRWYWx1ZSIsIm9rIiwicmVhc29uIiwic2V0T3AiLCJleHBySXRlbSIsInR5cGVFeHByIiwicG9zIiwiJCRST09UIiwiaGFzT3BlcmF0b3IiLCJjb21wbGV5S2V5IiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFr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LEtBQU4sRUFBYW1ELFFBQWIsRUFBdUIsS0FBS29CLFVBQTVCLENBQXBCO0FBQ0EsUUFBSTVFLE1BQU0sQ0FBQyxDQUFELENBQVYsRUFBZSxPQUFPLElBQVA7QUFFZixVQUFNLElBQUlySCxlQUFKLENBQW9CcUgsTUFBTSxDQUFDLENBQUQsQ0FBMUIsRUFBK0I7QUFDakN3QyxNQUFBQSxNQUFNLEVBQUUsS0FBS25DLEtBRG9CO0FBRWpDbUQsTUFBQUE7QUFGaUMsS0FBL0IsQ0FBTjtBQUlIOztBQUVEekIsRUFBQUEsUUFBUSxDQUFDOUIsSUFBRCxFQUFPO0FBQ1gsV0FBT2xCLFlBQVksQ0FBQyxLQUFLc0IsS0FBTixFQUFhSixJQUFiLEVBQW1CLEtBQUsyRSxVQUF4QixDQUFuQjtBQUNIOztBQUVEQyxFQUFBQSxNQUFNLENBQUM1RSxJQUFELEVBQU87QUFDVCxVQUFNSSxLQUFLLEdBQUd0QixZQUFZLENBQUMsS0FBS3NCLEtBQU4sRUFBYUosSUFBYixFQUFtQixLQUFLMkUsVUFBeEIsQ0FBMUI7QUFDQSxTQUFLdkUsS0FBTCxHQUFhQSxLQUFiO0FBQ0EsV0FBTyxJQUFQO0FBQ0g7O0FBN0JLOztBQWdDVnFFLEdBQUcsQ0FBQ3pHLEtBQUosR0FBWUEsS0FBWjtBQUNBeUcsR0FBRyxDQUFDM0MsUUFBSixHQUFlaEQsWUFBZjtBQUNBMkYsR0FBRyxDQUFDdEMsaUJBQUosR0FBd0JBLGlCQUF4QjtBQUVBMEMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCTCxHQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEpTT04gRXhwcmVzc2lvbiBTeW50YXggKEpFUylcbmNvbnN0IHsgXywgaGFzS2V5QnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IgfSA9IHJlcXVpcmUoJy4vRXJyb3JzJyk7XG5cbi8vRXhjZXB0aW9uIG1lc3NhZ2VzXG5jb25zdCBPUEVSQVRPUl9OT1RfQUxPTkUgPSAnUXVlcnkgb3BlcmF0b3IgY2FuIG9ubHkgYmUgdXNlZCBhbG9uZSBpbiBhIHN0YWdlLic7XG5jb25zdCBOT1RfQV9VTkFSWV9RVUVSWSA9ICdPbmx5IHVuYXJ5IHF1ZXJ5IG9wZXJhdG9yIGlzIGFsbG93ZWQgdG8gYmUgdXNlZCBkaXJlY3RseSBpbiBhIG1hdGNoaW5nLic7XG5jb25zdCBJTlZBTElEX0VYUFJfU1lOVEFYID0gJ0ludmFsaWQgZXhwcmVzc2lvbiBzeW50YXguJztcblxuY29uc3QgSU5WQUxJRF9RVUVSWV9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHt0b2tlbn1cIi5gO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9IQU5ETEVSID0gb3AgPT4gYEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9IQU5MREVSID0gb3AgPT4gYEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHtvcH1cIiBoYW5kbGVyIG5vdCBmb3VuZC5gO1xuXG5jb25zdCBJTlZBTElEX0NPTExFQ1RJT05fT1AgPSBvcCA9PiBgSW52YWxpZCBjb2xsZWN0aW9uIG9wZXJhdG9yIFwiJHtvcH1cIi5gO1xuY29uc3QgUFJYX09QX05PVF9GT1JfRVZBTCA9IHByZWZpeCA9PiBgT3BlcmF0b3IgcHJlZml4IFwiJHtwcmVmaXh9XCIgY2Fubm90IGJlIHVzZWQgaW4gZXZhbHVhdGlvbi5gO1xuXG5jb25zdCBPUEVSQU5EX05PVF9UVVBMRSA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIGNvbGxlY3Rpb24gb3BlcmF0b3IgJHtvcCA/ICdcIiArIG9wICsgXCIgJyA6ICcnfW11c3QgYmUgYSB0d28tdHVwbGUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1RVUExFXzJfT1JfMyA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGVpdGhlciBhIDItdHVwbGUgb3IgYSAzLXR1cGxlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9BUlJBWSA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGFuIGFycmF5LmA7XG5jb25zdCBPUEVSQU5EX05PVF9CT09MID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgYSBib29sZWFuIHZhbHVlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9TVFJJTkcgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBhIHN0cmluZy5gO1xuXG5jb25zdCBWQUxVRV9OT1RfQ09MTEVDVElPTiA9IG9wID0+IGBUaGUgdmFsdWUgdXNpbmcgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBlaXRoZXIgYW4gb2JqZWN0IG9yIGFuIGFycmF5LmA7XG5cbmNvbnN0IFJFUVVJUkVfUklHSFRfT1BFUkFORCA9IG9wID0+IGBCaW5hcnkgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIHJlcXVpcmVzIHRoZSByaWdodCBvcGVyYW5kLmBcblxuLy9Db25kaXRpb24gb3BlcmF0b3JcbmNvbnN0IE9QX0VRVUFMID0gWyAnJGVxJywgJyRlcWwnLCAnJGVxdWFsJyBdO1xuY29uc3QgT1BfTk9UX0VRVUFMID0gWyAnJG5lJywgJyRuZXEnLCAnJG5vdEVxdWFsJyBdO1xuY29uc3QgT1BfTk9UID0gWyAnJG5vdCcgXTtcbmNvbnN0IE9QX0dSRUFURVJfVEhBTiA9IFsgJyRndCcsICckPicsICckZ3JlYXRlclRoYW4nIF07XG5jb25zdCBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwgPSBbICckZ3RlJywgJyQ8PScsICckZ3JlYXRlclRoYW5PckVxdWFsJyBdO1xuY29uc3QgT1BfTEVTU19USEFOID0gWyAnJGx0JywgJyQ8JywgJyRsZXNzVGhhbicgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTl9PUl9FUVVBTCA9IFsgJyRsdGUnLCAnJDw9JywgJyRsZXNzVGhhbk9yRXF1YWwnIF07XG5cbmNvbnN0IE9QX0lOID0gWyAnJGluJyBdO1xuY29uc3QgT1BfTk9UX0lOID0gWyAnJG5pbicsICckbm90SW4nIF07XG5jb25zdCBPUF9FWElTVFMgPSBbICckZXhpc3QnLCAnJGV4aXN0cycsICckbm90TnVsbCcgXTtcbmNvbnN0IE9QX01BVENIID0gWyAnJGhhcycsICckbWF0Y2gnLCAnJGFsbCcgXTtcbmNvbnN0IE9QX01BVENIX0FOWSA9IFsgJyRhbnknLCAnJG9yJywgJyRlaXRoZXInIF07XG5jb25zdCBPUF9UWVBFID0gWyAnJGlzJywgJyR0eXBlT2YnIF07XG5jb25zdCBPUF9IQVNfS0VZUyA9IFsgJyRoYXNLZXlzJywgJyR3aXRoS2V5cycgXTtcbmNvbnN0IE9QX1NUQVJUX1dJVEggPSBbICckc3RhcnRXaXRoJywgJyRzdGFydHNXaXRoJyBdO1xuY29uc3QgT1BfRU5EX1dJVEggPSBbICckZW5kV2l0aCcsICckZW5kc1dpdGgnIF07XG5cbi8vUXVlcnkgJiBhZ2dyZWdhdGUgb3BlcmF0b3JcbmNvbnN0IE9QX1NJWkUgPSBbICckc2l6ZScsICckbGVuZ3RoJywgJyRjb3VudCcgXTtcbmNvbnN0IE9QX1NVTSA9IFsgJyRzdW0nLCAnJHRvdGFsJyBdO1xuY29uc3QgT1BfS0VZUyA9IFsgJyRrZXlzJyBdO1xuY29uc3QgT1BfVkFMVUVTID0gWyAnJHZhbHVlcycgXTtcbmNvbnN0IE9QX0dFVF9UWVBFID0gWyAnJHR5cGUnIF07XG5cbi8vTWFuaXB1bGF0ZSBvcGVyYXRpb25cbmNvbnN0IE9QX0FERCA9IFsgJyRhZGQnLCAnJHBsdXMnLCAgICAgJyRpbmMnIF07XG5jb25zdCBPUF9TVUIgPSBbICckc3ViJywgJyRzdWJ0cmFjdCcsICckbWludXMnLCAnJGRlYycgXTtcbmNvbnN0IE9QX01VTCA9IFsgJyRtdWwnLCAnJG11bHRpcGx5JywgICckdGltZXMnIF07XG5jb25zdCBPUF9ESVYgPSBbICckZGl2JywgJyRkaXZpZGUnIF07XG5jb25zdCBPUF9TRVQgPSBbICckc2V0JywgJyQ9JyBdO1xuY29uc3QgT1BfQUREX0lURU0gPSBbICckYWRkSXRlbScsICckb3ZlcnJpZGUnIF07XG5cbmNvbnN0IE9QX1BJQ0sgPSBbICckcGljaycgXTtcbmNvbnN0IE9QX0dFVF9CWV9JTkRFWCA9IFsgJyRhdCcsICckZ2V0QnlJbmRleCcsICckbnRoJyBdO1xuY29uc3QgT1BfR0VUX0JZX0tFWSA9IFsgJyRvZicsICckZ2V0QnlLZXknIF07XG5jb25zdCBPUF9PTUlUID0gWyAnJG9taXQnIF07XG5jb25zdCBPUF9HUk9VUCA9IFsgJyRncm91cCcsICckZ3JvdXBCeScgXTtcbmNvbnN0IE9QX1NPUlQgPSBbICckc29ydCcsICckb3JkZXJCeScsICckc29ydEJ5JyBdO1xuY29uc3QgT1BfUkVWRVJTRSA9IFsgJyRyZXZlcnNlJyBdO1xuY29uc3QgT1BfRVZBTCA9IFsgJyRldmFsJywgJyRhcHBseScgXTtcbmNvbnN0IE9QX01FUkdFID0gWyAnJG1lcmdlJyBdO1xuY29uc3QgT1BfRklMVEVSID0gWyAnJGZpbHRlcicsICckc2VsZWN0JyBdO1xuXG4vL0NvbmRpdGlvbiBvcGVyYXRpb25cbmNvbnN0IE9QX0lGID0gWyAnJGlmJyBdO1xuXG5jb25zdCBQRlhfRk9SX0VBQ0ggPSAnfD4nOyAvLyBmb3IgZWFjaFxuY29uc3QgUEZYX1dJVEhfQU5ZID0gJ3wqJzsgLy8gd2l0aCBhbnlcblxuY29uc3QgTWFwT2ZPcHMgPSBuZXcgTWFwKCk7XG5jb25zdCBhZGRPcFRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk9wcy5zZXQodG9rZW4sIHRhZykpO1xuYWRkT3BUb01hcChPUF9FUVVBTCwgJ09QX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9FUVVBTCwgJ09QX05PVF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1QsICdPUF9OT1QnKTtcbmFkZE9wVG9NYXAoT1BfR1JFQVRFUl9USEFOLCAnT1BfR1JFQVRFUl9USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCwgJ09QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9MRVNTX1RIQU4sICdPUF9MRVNTX1RIQU4nKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOX09SX0VRVUFMLCAnT1BfTEVTU19USEFOX09SX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX0lOLCAnT1BfSU4nKTtcbmFkZE9wVG9NYXAoT1BfTk9UX0lOLCAnT1BfTk9UX0lOJyk7XG5hZGRPcFRvTWFwKE9QX0VYSVNUUywgJ09QX0VYSVNUUycpO1xuYWRkT3BUb01hcChPUF9NQVRDSCwgJ09QX01BVENIJyk7XG5hZGRPcFRvTWFwKE9QX01BVENIX0FOWSwgJ09QX01BVENIX0FOWScpO1xuYWRkT3BUb01hcChPUF9UWVBFLCAnT1BfVFlQRScpO1xuYWRkT3BUb01hcChPUF9IQVNfS0VZUywgJ09QX0hBU19LRVlTJyk7XG5hZGRPcFRvTWFwKE9QX1NUQVJUX1dJVEgsICdPUF9TVEFSVF9XSVRIJyk7XG5hZGRPcFRvTWFwKE9QX0VORF9XSVRILCAnT1BfRU5EX1dJVEgnKTtcblxuY29uc3QgTWFwT2ZNYW5zID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkTWFuVG9NYXAgPSAodG9rZW5zLCB0YWcpID0+IHRva2Vucy5mb3JFYWNoKHRva2VuID0+IE1hcE9mTWFucy5zZXQodG9rZW4sIHRhZykpO1xuLy8gWyA8b3AgbmFtZT4sIDx1bmFyeT4gXVxuYWRkTWFuVG9NYXAoT1BfU0laRSwgWydPUF9TSVpFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVU0sIFsnT1BfU1VNJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9LRVlTLCBbJ09QX0tFWVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1ZBTFVFUywgWydPUF9WQUxVRVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX0dFVF9UWVBFLCBbJ09QX0dFVF9UWVBFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9SRVZFUlNFLCBbJ09QX1JFVkVSU0UnLCB0cnVlXSk7XG5cbmFkZE1hblRvTWFwKE9QX0FERCwgWydPUF9BREQnLCBmYWxzZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVUIsIFsnT1BfU1VCJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9NVUwsIFsnT1BfTVVMJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9ESVYsIFsnT1BfRElWJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9TRVQsIFsnT1BfU0VUJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9BRERfSVRFTSwgWydPUF9BRERfSVRFTScsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfUElDSywgWydPUF9QSUNLJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9JTkRFWCwgWydPUF9HRVRfQllfSU5ERVgnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR0VUX0JZX0tFWSwgWydPUF9HRVRfQllfS0VZJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX09NSVQsIFsnT1BfT01JVCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HUk9VUCwgWydPUF9HUk9VUCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9TT1JULCBbJ09QX1NPUlQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfRVZBTCwgWydPUF9FVkFMJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX01FUkdFLCBbJ09QX01FUkdFJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0ZJTFRFUiwgWydPUF9GSUxURVInLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfSUYsIFsnT1BfSUYnLCBmYWxzZV0pO1xuXG5jb25zdCBkZWZhdWx0SmVzSGFuZGxlcnMgPSB7XG4gICAgT1BfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gXy5pc0VxdWFsKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9OT1RfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gIV8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfTk9UOiAobGVmdCwgLi4uYXJncykgPT4gIXRlc3QobGVmdCwgJ09QX01BVENIJywgLi4uYXJncyksXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPiByaWdodCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA+PSByaWdodCxcbiAgICBPUF9MRVNTX1RIQU46IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8IHJpZ2h0LFxuICAgIE9QX0xFU1NfVEhBTl9PUl9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IDw9IHJpZ2h0LFxuICAgIE9QX0lOOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHJpZ2h0ID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9JTicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodC5maW5kKGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX05PVF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9OT1RfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgZWxlbWVudCA9PiBkZWZhdWx0SmVzSGFuZGxlcnMuT1BfTk9UX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX0VYSVNUUzogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0JPT0woJ09QX0VYSVNUUycpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodCA/IGxlZnQgIT0gbnVsbCA6IGxlZnQgPT0gbnVsbDtcbiAgICB9LFxuICAgIE9QX1RZUEU6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfVFlQRScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJpZ2h0ID0gcmlnaHQudG9Mb3dlckNhc2UoKTtcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdhcnJheScpIHtcbiAgICAgICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KGxlZnQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ2ludGVnZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5pc0ludGVnZXIobGVmdCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBsZWZ0ID09PSAnc3RyaW5nJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gcmlnaHQ7XG4gICAgfSxcbiAgICBPUF9NQVRDSDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcnVsZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KTtcbiAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgfSxcbiAgICBPUF9NQVRDSF9BTlk6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9NQVRDSF9BTlknKSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmlnaHQsIHJ1bGUgPT4ge1xuICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICB9KTsgICBcbiAgICBcbiAgICAgICAgcmV0dXJuIGZvdW5kID8gdHJ1ZSA6IGZhbHNlO1xuICAgIH0sXG4gICAgT1BfSEFTX0tFWVM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwib2JqZWN0XCIpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwga2V5ID0+IGhhc0tleUJ5UGF0aChsZWZ0LCBrZXkpKTtcbiAgICB9LFxuICAgIE9QX1NUQVJUX1dJVEg6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX1NUQVJUX1dJVEgnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdC5zdGFydHNXaXRoKHJpZ2h0KTtcbiAgICB9LFxuICAgIE9QX0VORF9XSVRIOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9FTkRfV0lUSCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0LmVuZHNXaXRoKHJpZ2h0KTtcbiAgICB9ICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdE1hbmlwdWxhdGlvbnMgPSB7XG4gICAgLy91bmFyeVxuICAgIE9QX1NJWkU6IChsZWZ0KSA9PiBfLnNpemUobGVmdCksXG4gICAgT1BfU1VNOiAobGVmdCkgPT4gXy5yZWR1Y2UobGVmdCwgKHN1bSwgaXRlbSkgPT4ge1xuICAgICAgICAgICAgc3VtICs9IGl0ZW07XG4gICAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICB9LCAwKSxcblxuICAgIE9QX0tFWVM6IChsZWZ0KSA9PiBfLmtleXMobGVmdCksXG4gICAgT1BfVkFMVUVTOiAobGVmdCkgPT4gXy52YWx1ZXMobGVmdCksICAgXG4gICAgT1BfR0VUX1RZUEU6IChsZWZ0KSA9PiBBcnJheS5pc0FycmF5KGxlZnQpID8gJ2FycmF5JyA6IChfLmlzSW50ZWdlcihsZWZ0KSA/ICdpbnRlZ2VyJyA6IHR5cGVvZiBsZWZ0KSwgIFxuICAgIE9QX1JFVkVSU0U6IChsZWZ0KSA9PiBfLnJldmVyc2UobGVmdCksXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ICsgcmlnaHQsXG4gICAgT1BfU1VCOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgLSByaWdodCxcbiAgICBPUF9NVUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAqIHJpZ2h0LFxuICAgIE9QX0RJVjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC8gcmlnaHQsIFxuICAgIE9QX1NFVDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4gZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0LCB0cnVlKSwgXG4gICAgT1BfQUREX0lURU06IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFZBTFVFX05PVF9DT0xMRUNUSU9OKCdPUF9BRERfSVRFTScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdC5jb25jYXQocmlnaHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSB8fCByaWdodC5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRSgnT1BfQUREX0lURU0nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyAuLi5sZWZ0LCBbcmlnaHRbMF1dOiBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMV0sIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQsICQkUEFSRU5UOiBjb250ZXh0LiQkQ1VSUkVOVCwgJCRDVVJSRU5UOiBsZWZ0IH0pIH07XG4gICAgfSwgXG4gICAgT1BfUElDSzogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAobGVmdCA9PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByaWdodCA9IF8uY2FzdEFycmF5KHJpZ2h0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgcmV0dXJuIF8ucGljayhsZWZ0LCByaWdodCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIF8ucGlja0J5KGxlZnQsICh4LCBrZXkpID0+IG1hdGNoKGtleSwgcmlnaHQsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSlbMF0pO1xuICAgIH0sXG4gICAgT1BfR0VUX0JZX0lOREVYOiAobGVmdCwgcmlnaHQpID0+IF8ubnRoKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HRVRfQllfS0VZOiAobGVmdCwgcmlnaHQpID0+IF8uZ2V0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9PTUlUOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmIChsZWZ0ID09IG51bGwpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJpZ2h0ID0gXy5jYXN0QXJyYXkocmlnaHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5vbWl0KGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gXy5vbWl0QnkobGVmdCwgKHgsIGtleSkgPT4gbWF0Y2goa2V5LCByaWdodCwgamVzLCBmb3JtYXRQcmVmaXgoa2V5LCBwcmVmaXgpKVswXSk7XG4gICAgfSxcbiAgICBPUF9HUk9VUDogKGxlZnQsIHJpZ2h0KSA9PiBfLmdyb3VwQnkobGVmdCwgcmlnaHQpLFxuICAgIE9QX1NPUlQ6IChsZWZ0LCByaWdodCkgPT4gXy5zb3J0QnkobGVmdCwgcmlnaHQpLCAgXG4gICAgT1BfRVZBTDogZXZhbHVhdGVFeHByLFxuICAgIE9QX01FUkdFOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUVSR0UnKSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiByaWdodC5yZWR1Y2UoKHJlc3VsdCwgZXhwciwga2V5KSA9PiBPYmplY3QuYXNzaWduKHJlc3VsdCwgZXZhbHVhdGVFeHByKGxlZnQsIGV4cHIsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSwgeyAuLi5jb250ZXh0IH0pKSwge30pO1xuICAgIH0sXG4gICAgT1BfRklMVEVSOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmIChsZWZ0ID09IG51bGwpIHJldHVybiBudWxsO1xuICAgICAgICBcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFZBTFVFX05PVF9DT0xMRUNUSU9OKCdPUF9GSUxURVInKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gXy5maWx0ZXIobGVmdCwgKHZhbHVlLCBrZXkpID0+IHRlc3QodmFsdWUsICdPUF9NQVRDSCcsIHJpZ2h0LCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpKTtcbiAgICB9LFxuICAgIE9QX0lGOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfSUYnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQubGVuZ3RoIDwgMiB8fCByaWdodC5sZW5ndGggPiAzKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zKCdPUF9JRicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNvbmRpdGlvbiA9IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIHJpZ2h0WzBdLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKHRlc3QobGVmdCwgJ09QX01BVENIJywgY29uZGl0aW9uLCBqZXMsIHByZWZpeCkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMV0sIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIGlmIChyaWdodC5sZW5ndGggPiAyKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCByZXQgPSBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMl0sIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdDtcbiAgICB9XG59XG5cbmNvbnN0IGZvcm1hdE5hbWUgPSAobmFtZSwgcHJlZml4KSA9PiB7XG4gICAgY29uc3QgZnVsbE5hbWUgPSBuYW1lID09IG51bGwgPyBwcmVmaXggOiBmb3JtYXRQcmVmaXgobmFtZSwgcHJlZml4KTtcbiAgICByZXR1cm4gZnVsbE5hbWUgPT0gbnVsbCA/IFwiVGhlIHZhbHVlXCIgOiAoZnVsbE5hbWUuaW5kZXhPZignKCcpICE9PSAtMSA/IGBUaGUgcXVlcnkgXCJfLiR7ZnVsbE5hbWV9XCJgIDogYFwiJHtmdWxsTmFtZX1cImApO1xufTtcbmNvbnN0IGZvcm1hdEtleSA9IChrZXksIGhhc1ByZWZpeCkgPT4gXy5pc0ludGVnZXIoa2V5KSA/IGBbJHtrZXl9XWAgOiAoaGFzUHJlZml4ID8gJy4nICsga2V5IDoga2V5KTtcbmNvbnN0IGZvcm1hdFByZWZpeCA9IChrZXksIHByZWZpeCkgPT4gcHJlZml4ICE9IG51bGwgPyBgJHtwcmVmaXh9JHtmb3JtYXRLZXkoa2V5LCB0cnVlKX1gIDogZm9ybWF0S2V5KGtleSwgZmFsc2UpO1xuY29uc3QgZm9ybWF0UXVlcnkgPSAob3BNZXRhKSA9PiBgJHtkZWZhdWx0UXVlcnlFeHBsYW5hdGlvbnNbb3BNZXRhWzBdXX0oJHtvcE1ldGFbMV0gPyAnJyA6ICc/J30pYDsgIFxuY29uc3QgZm9ybWF0TWFwID0gKG5hbWUpID0+IGBlYWNoKC0+JHtuYW1lfSlgO1xuY29uc3QgZm9ybWF0QW55ID0gKG5hbWUpID0+IGBhbnkoLT4ke25hbWV9KWA7XG5cbmNvbnN0IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMgPSB7XG4gICAgT1BfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBtYXRjaCAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9HUkVBVEVSX1RIQU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiBvciBlcXVhbCB0byAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlIGFueSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9FWElTVFM6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCR7cmlnaHQgPyAnIG5vdCAnOiAnICd9YmUgTlVMTC5gLCAgICBcbiAgICBPUF9UWVBFOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYFRoZSB0eXBlIG9mICR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgXCIke3JpZ2h0fVwiLCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgICAgIFxuICAgIE9QX01BVENIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfTUFUQ0hfQU5ZOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggYW55IG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX0hBU19LRVlTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgaGF2ZSBhbGwgb2YgdGhlc2Uga2V5cyBbJHtyaWdodC5qb2luKCcsICcpfV0uYCwgICAgICAgIFxuICAgIE9QX1NUQVJUX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBzdGFydCB3aXRoIFwiJHtyaWdodH1cIi5gLCAgICAgICAgXG4gICAgT1BfRU5EX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBlbmQgd2l0aCBcIiR7cmlnaHR9XCIuYCwgICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAnc2l6ZScsXG4gICAgT1BfU1VNOiAnc3VtJyxcbiAgICBPUF9LRVlTOiAna2V5cycsXG4gICAgT1BfVkFMVUVTOiAndmFsdWVzJywgICAgXG4gICAgT1BfR0VUX1RZUEU6ICdnZXQgdHlwZScsXG4gICAgT1BfUkVWRVJTRTogJ3JldmVyc2UnLCBcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAnYWRkJyxcbiAgICBPUF9TVUI6ICdzdWJ0cmFjdCcsXG4gICAgT1BfTVVMOiAnbXVsdGlwbHknLFxuICAgIE9QX0RJVjogJ2RpdmlkZScsIFxuICAgIE9QX1NFVDogJ2Fzc2lnbicsXG4gICAgT1BfQUREX0lURU06ICdhZGRJdGVtJyxcbiAgICBPUF9QSUNLOiAncGljaycsXG4gICAgT1BfR0VUX0JZX0lOREVYOiAnZ2V0IGVsZW1lbnQgYXQgaW5kZXgnLFxuICAgIE9QX0dFVF9CWV9LRVk6ICdnZXQgZWxlbWVudCBvZiBrZXknLFxuICAgIE9QX09NSVQ6ICdvbWl0JyxcbiAgICBPUF9HUk9VUDogJ2dyb3VwQnknLFxuICAgIE9QX1NPUlQ6ICdzb3J0QnknLFxuICAgIE9QX0VWQUw6ICdldmFsdWF0ZScsXG4gICAgT1BfTUVSR0U6ICdtZXJnZScsXG4gICAgT1BfRklMVEVSOiAnZmlsdGVyJyxcbiAgICBPUF9JRjogJ2V2YWx1YXRlIGlmJ1xufTtcblxuZnVuY3Rpb24gZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbmFtZSwgbGVmdFZhbHVlLCByaWdodFZhbHVlLCBwcmVmaXgpIHtcbiAgICBjb25zdCBnZXR0ZXIgPSBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnNbb3BdIHx8IGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9NQVRDSDtcbiAgICByZXR1cm4gZ2V0dGVyKG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KTsgICAgXG59XG5cbmZ1bmN0aW9uIHRlc3QodmFsdWUsIG9wLCBvcFZhbHVlLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLm9wZXJhdG9ySGFuZGxlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfSEFOTERFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlKHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5xdWVyeUhhbmxkZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9IQU5ETEVSKG9wKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGhhbmRsZXIodmFsdWUsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXZhbHVhdGVVbmFyeSh2YWx1ZSwgb3AsIGplcywgcHJlZml4KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCByaWdodFZhbHVlLCBvcE1ldGEsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgaWYgKG9wTWV0YVsxXSkge1xuICAgICAgICByZXR1cm4gcmlnaHRWYWx1ZSA/IGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KSA6IGN1cnJlbnRWYWx1ZTtcbiAgICB9IFxuICAgIFxuICAgIHJldHVybiBldmFsdWF0ZShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgcmlnaHRWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xufVxuXG5jb25zdCBkZWZhdWx0Q3VzdG9taXplciA9IHtcbiAgICBtYXBPZk9wZXJhdG9yczogTWFwT2ZPcHMsXG4gICAgbWFwT2ZNYW5pcHVsYXRvcnM6IE1hcE9mTWFucyxcbiAgICBvcGVyYXRvckhhbmRsZXJzOiBkZWZhdWx0SmVzSGFuZGxlcnMsXG4gICAgb3BlcmF0b3JFeHBsYW5hdGlvbnM6IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMsXG4gICAgcXVlcnlIYW5sZGVyczogZGVmYXVsdE1hbmlwdWxhdGlvbnNcbn07XG5cbmZ1bmN0aW9uIG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBvcGVyYW5kcywgamVzLCBwcmVmaXgpIHtcbiAgICBsZXQgbWF0Y2hSZXN1bHQsIG5leHRQcmVmaXg7XG5cbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IG1hcFJlc3VsdCA9IF8uaXNQbGFpbk9iamVjdChhY3R1YWwpID8gXy5tYXBWYWx1ZXMoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSkpIDogXy5tYXAoYWN0dWFsLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChpLCBwcmVmaXgpKSk7XG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdE1hcChmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gbWF0Y2gobWFwUmVzdWx0LCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgICBcbiAgICAgICAgICAgIG5leHRQcmVmaXggPSBmb3JtYXRQcmVmaXgoZm9ybWF0QW55KGZvcm1hdFF1ZXJ5KG9wTWV0YSkpLCBwcmVmaXgpO1xuICAgICAgICAgICAgbWF0Y2hSZXN1bHQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBtYXRjaChldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSksIG9wZXJhbmRzWzFdLCBqZXMsIG5leHRQcmVmaXgpKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpIHtcbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IHVubWF0Y2hlZEtleSA9IF8uZmluZEluZGV4KGFjdHVhbCwgKGl0ZW0pID0+ICF0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgICAgIGlmICh1bm1hdGNoZWRLZXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgdW5tYXRjaGVkS2V5LCBhY3R1YWxbdW5tYXRjaGVkS2V5XSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZWQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiB0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgXG4gICAgICAgICAgICBpZiAoIW1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY3VycmVudFZhbHVlLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSwgeyAuLi5jb250ZXh0LCAkJFBBUkVOVDogY3VycmVudFZhbHVlLCAkJENVUlJFTlQ6IGl0ZW0gfSkpO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgIFxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFBSWF9PUF9OT1RfRk9SX0VWQUwoY29sbGVjdGlvbk9wKSk7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0NPTExFQ1RJT05fT1AoY29sbGVjdGlvbk9wKSk7XG4gICAgfVxufVxuXG4vKipcbiAqIFxuICogQHBhcmFtIHsqfSBhY3R1YWwgXG4gKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IHByZWZpeCAgXG4gKiBcbiAqIHsga2V5OiB7ICRtYXRjaCB9IH1cbiAqL1xuZnVuY3Rpb24gbWF0Y2goYWN0dWFsLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGxldCBwYXNzT2JqZWN0Q2hlY2sgPSBmYWxzZTtcblxuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGV4cGVjdGVkKSkge1xuICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCAnT1BfRVFVQUwnLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChudWxsLCBhY3R1YWwsIGV4cGVjdGVkLCBwcmVmaXgpICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gW3RydWVdO1xuICAgIH1cblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHBlY3RlZCkge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwZWN0ZWRbZmllbGROYW1lXTsgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgIFxuICAgICAgICAgICAgaWYgKGwgPiA0ICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVszXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEZpZWxkVmFsdWUpICYmIGV4cGVjdGVkRmllbGRWYWx1ZS5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRSgpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigzKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAobCA+IDIgJiYgZmllbGROYW1lWzFdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigxKTtcblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5PVF9BX1VOQVJZX1FVRVJZKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gZXZhbHVhdGVVbmFyeShhY3R1YWwsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2gocXVlcnlSZXN1bHQsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZm9ybWF0UXVlcnkob3BNZXRhKSwgcHJlZml4KSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaFJlc3VsdFswXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yXG4gICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWwsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBnZXRVbm1hdGNoZWRFeHBsYW5hdGlvbihqZXMsIG9wLCBudWxsLCBhY3R1YWwsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoIXBhc3NPYmplY3RDaGVjaykge1xuICAgICAgICAgICAgaWYgKGFjdHVhbCA9PSBudWxsKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVhJU1RTKG51bGwsIG51bGwsIHRydWUsIHByZWZpeClcbiAgICAgICAgICAgIF07IFxuXG4gICAgICAgICAgICBjb25zdCBhY3R1YWxUeXBlID0gdHlwZW9mIGFjdHVhbDtcbiAgICBcbiAgICAgICAgICAgIGlmIChhY3R1YWxUeXBlICE9PSAnb2JqZWN0JykgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfVFlQRShudWxsLCBhY3R1YWxUeXBlLCAnb2JqZWN0JywgcHJlZml4KVxuICAgICAgICAgICAgXTsgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHBhc3NPYmplY3RDaGVjayA9IHRydWU7XG5cbiAgICAgICAgbGV0IGFjdHVhbEZpZWxkVmFsdWUgPSBfLmdldChhY3R1YWwsIGZpZWxkTmFtZSk7ICAgICBcbiAgICAgICAgXG4gICAgICAgIGlmIChleHBlY3RlZEZpZWxkVmFsdWUgIT0gbnVsbCAmJiB0eXBlb2YgZXhwZWN0ZWRGaWVsZFZhbHVlID09PSAnb2JqZWN0JykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgWyBvaywgcmVhc29uIF0gPSBtYXRjaChhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZpZWxkTmFtZSwgcHJlZml4KSk7XG4gICAgICAgICAgICBpZiAoIW9rKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFsgZmFsc2UsIHJlYXNvbiBdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbEZpZWxkVmFsdWUsICdPUF9FUVVBTCcsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChmaWVsZE5hbWUsIGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIFt0cnVlXTtcbn1cblxuLyoqXG4gKiBJZiAkIG9wZXJhdG9yIHVzZWQsIG9ubHkgb25lIGEgdGltZSBpcyBhbGxvd2VkXG4gKiBlLmcuXG4gKiB7XG4gKiAgICAkZ3JvdXBCeTogJ2tleSdcbiAqIH1cbiAqIFxuICogXG4gKiBAcGFyYW0geyp9IGN1cnJlbnRWYWx1ZSBcbiAqIEBwYXJhbSB7Kn0gZXhwciBcbiAqIEBwYXJhbSB7Kn0gcHJlZml4IFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IGNvbnRleHRcbiAqL1xuZnVuY3Rpb24gZXZhbHVhdGVFeHByKGN1cnJlbnRWYWx1ZSwgZXhwciwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHNldE9wKSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShleHByKSkge1xuICAgICAgICBpZiAoc2V0T3ApIHtcbiAgICAgICAgICAgIHJldHVybiBleHByLm1hcChpdGVtID0+IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIGl0ZW0sIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQgfSwgdHJ1ZSkpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZXhwci5yZWR1Y2UoKHJlc3VsdCwgZXhwckl0ZW0pID0+IGV2YWx1YXRlRXhwcihyZXN1bHQsIGV4cHJJdGVtLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0pLCBjdXJyZW50VmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGVFeHByID0gdHlwZW9mIGV4cHI7XG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIGlmIChzZXRPcCkgcmV0dXJuIGV4cHI7XG4gICAgICAgIHJldHVybiBleHByID8gY3VycmVudFZhbHVlIDogdW5kZWZpbmVkO1xuICAgIH0gICAgXG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwibnVtYmVyXCIgfHwgdHlwZUV4cHIgPT09IFwiYmlnaW50XCIpIHtcbiAgICAgICAgaWYgKHNldE9wKSByZXR1cm4gZXhwcjtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9FWFBSX1NZTlRBWCk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVFeHByID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoZXhwci5zdGFydHNXaXRoKCckJCcpKSB7XG4gICAgICAgICAgICAvL2dldCBmcm9tIGNvbnRleHRcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IGV4cHIuaW5kZXhPZignLicpO1xuICAgICAgICAgICAgaWYgKHBvcyA9PT0gLTEpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbnRleHRbZXhwcl07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLmdldChjb250ZXh0W2V4cHIuc3Vic3RyKDAsIHBvcyldLCBleHByLnN1YnN0cihwb3MrMSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNldE9wKSB7XG4gICAgICAgICAgICByZXR1cm4gZXhwcjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZXhwcik7XG4gICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFJFUVVJUkVfUklHSFRfT1BFUkFORChleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZXZhbHVhdGVVbmFyeShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpO1xuICAgIH0gXG5cbiAgICBpZiAodHlwZUV4cHIgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfRVhQUl9TWU5UQVgpO1xuICAgIH1cblxuICAgIGlmIChzZXRPcCkge1xuICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXMoZXhwciwgaXRlbSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCBpdGVtLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSkpO1xuICAgIH1cblxuICAgIGlmIChjb250ZXh0ID09IG51bGwpIHsgXG4gICAgICAgIGNvbnRleHQgPSB7ICQkUk9PVDogY3VycmVudFZhbHVlLCAkJFBBUkVOVDogbnVsbCwgJCRDVVJSRU5UOiBjdXJyZW50VmFsdWUgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBsZXQgcmVzdWx0LCBoYXNPcGVyYXRvciA9IGZhbHNlOyAgICBcblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHByKSB7XG4gICAgICAgIGxldCBleHBlY3RlZEZpZWxkVmFsdWUgPSBleHByW2ZpZWxkTmFtZV07ICBcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGwgPSBmaWVsZE5hbWUubGVuZ3RoO1xuXG4gICAgICAgIGlmIChsID4gMSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVCeU9wTWV0YShjdXJyZW50VmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobCA+IDMgJiYgZmllbGROYW1lWzBdID09PSAnfCcgJiYgZmllbGROYW1lWzJdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb21wbGV5S2V5ID0gZmllbGROYW1lLmluZGV4T2YoJy4nKSAhPT0gLTE7XG5cbiAgICAgICAgLy9waWNrIGEgZmllbGQgYW5kIHRoZW4gYXBwbHkgbWFuaXB1bGF0aW9uXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gY3VycmVudFZhbHVlICE9IG51bGwgPyAoY29tcGxleUtleSA/IF8uZ2V0KGN1cnJlbnRWYWx1ZSwgZmllbGROYW1lKSA6IGN1cnJlbnRWYWx1ZVtmaWVsZE5hbWVdKSA6IHVuZGVmaW5lZDsgICAgICAgICBcblxuICAgICAgICBjb25zdCBjaGlsZEZpZWxkVmFsdWUgPSBldmFsdWF0ZUV4cHIoYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCksIGNvbnRleHQpO1xuXG4gICAgICAgIGlmICh0eXBlb2YgY2hpbGRGaWVsZFZhbHVlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgcmVzdWx0ID09IG51bGwgJiYgKHJlc3VsdCA9IHt9KTtcbiAgICAgICAgICAgIGlmIChjb21wbGV5S2V5KSB7XG4gICAgICAgICAgICAgICAgXy5zZXQocmVzdWx0LCBmaWVsZE5hbWUsIGNoaWxkRmllbGRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJlc3VsdFtmaWVsZE5hbWVdID0gY2hpbGRGaWVsZFZhbHVlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5jbGFzcyBKRVMge1xuICAgIGNvbnN0cnVjdG9yKHZhbHVlLCBjdXN0b21pemVyKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgdGhpcy5jdXN0b21pemVyID0gY3VzdG9taXplcjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICAgICAqIEBwYXJhbSAgey4uLmFueX0gYXJncyBcbiAgICAgKi9cbiAgICBtYXRjaChleHBlY3RlZCkgeyAgICAgICAgXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IG1hdGNoKHRoaXMudmFsdWUsIGV4cGVjdGVkLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgICAgICBpZiAocmVzdWx0WzBdKSByZXR1cm4gdGhpcztcblxuICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKHJlc3VsdFsxXSwge1xuICAgICAgICAgICAgYWN0dWFsOiB0aGlzLnZhbHVlLFxuICAgICAgICAgICAgZXhwZWN0ZWRcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZXZhbHVhdGUoZXhwcikge1xuICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgfVxuXG4gICAgdXBkYXRlKGV4cHIpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBldmFsdWF0ZUV4cHIodGhpcy52YWx1ZSwgZXhwciwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG59XG5cbkpFUy5tYXRjaCA9IG1hdGNoO1xuSkVTLmV2YWx1YXRlID0gZXZhbHVhdGVFeHByO1xuSkVTLmRlZmF1bHRDdXN0b21pemVyID0gZGVmYXVsdEN1c3RvbWl6ZXI7XG5cbm1vZHVsZS5leHBvcnRzID0gSkVTOyJdfQ==
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

const OPERAND_NOT_TUPLE = op => `The operand of a collection operator ${op ? '"' + op + '" ' : ''}must be a two-tuple.`;

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJOT1RfQV9VTkFSWV9RVUVSWSIsIklOVkFMSURfRVhQUl9TWU5UQVgiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiSU5WQUxJRF9DT0xMRUNUSU9OX09QIiwiUFJYX09QX05PVF9GT1JfRVZBTCIsInByZWZpeCIsIk9QRVJBTkRfTk9UX1RVUExFIiwiT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zIiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiVkFMVUVfTk9UX0NPTExFQ1RJT04iLCJSRVFVSVJFX1JJR0hUX09QRVJBTkQiLCJPUF9FUVVBTCIsIk9QX05PVF9FUVVBTCIsIk9QX05PVCIsIk9QX0dSRUFURVJfVEhBTiIsIk9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCIsIk9QX0xFU1NfVEhBTiIsIk9QX0xFU1NfVEhBTl9PUl9FUVVBTCIsIk9QX0lOIiwiT1BfTk9UX0lOIiwiT1BfRVhJU1RTIiwiT1BfTUFUQ0giLCJPUF9NQVRDSF9BTlkiLCJPUF9UWVBFIiwiT1BfSEFTX0tFWVMiLCJPUF9TVEFSVF9XSVRIIiwiT1BfRU5EX1dJVEgiLCJPUF9TSVpFIiwiT1BfU1VNIiwiT1BfS0VZUyIsIk9QX1ZBTFVFUyIsIk9QX0dFVF9UWVBFIiwiT1BfQUREIiwiT1BfU1VCIiwiT1BfTVVMIiwiT1BfRElWIiwiT1BfU0VUIiwiT1BfQUREX0lURU0iLCJPUF9QSUNLIiwiT1BfR0VUX0JZX0lOREVYIiwiT1BfR0VUX0JZX0tFWSIsIk9QX09NSVQiLCJPUF9HUk9VUCIsIk9QX1NPUlQiLCJPUF9SRVZFUlNFIiwiT1BfRVZBTCIsIk9QX01FUkdFIiwiT1BfRklMVEVSIiwiT1BfSUYiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNvbnRleHQiLCJldmFsdWF0ZUV4cHIiLCJ1bmRlZmluZWQiLCJjb25jYXQiLCJsZW5ndGgiLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImNhc3RBcnJheSIsInBpY2siLCJwaWNrQnkiLCJ4IiwiZm9ybWF0UHJlZml4IiwibnRoIiwiZ2V0Iiwib21pdCIsIm9taXRCeSIsImdyb3VwQnkiLCJzb3J0QnkiLCJyZXN1bHQiLCJleHByIiwiT2JqZWN0IiwiYXNzaWduIiwiZmlsdGVyIiwidmFsdWUiLCJjb25kaXRpb24iLCJyZXQiLCJmb3JtYXROYW1lIiwibmFtZSIsImZ1bGxOYW1lIiwiaW5kZXhPZiIsImZvcm1hdEtleSIsImhhc1ByZWZpeCIsImZvcm1hdFF1ZXJ5Iiwib3BNZXRhIiwiZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zIiwiZm9ybWF0TWFwIiwiZm9ybWF0QW55IiwiZGVmYXVsdEplc0V4cGxhbmF0aW9ucyIsIkpTT04iLCJzdHJpbmdpZnkiLCJqb2luIiwiZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24iLCJsZWZ0VmFsdWUiLCJyaWdodFZhbHVlIiwiZ2V0dGVyIiwib3BlcmF0b3JFeHBsYW5hdGlvbnMiLCJvcFZhbHVlIiwiaGFuZGxlciIsIm9wZXJhdG9ySGFuZGxlcnMiLCJldmFsdWF0ZSIsInF1ZXJ5SGFubGRlcnMiLCJldmFsdWF0ZVVuYXJ5IiwiZXZhbHVhdGVCeU9wTWV0YSIsImN1cnJlbnRWYWx1ZSIsImRlZmF1bHRDdXN0b21pemVyIiwibWFwT2ZPcGVyYXRvcnMiLCJtYXBPZk1hbmlwdWxhdG9ycyIsIm1hdGNoQ29sbGVjdGlvbiIsImFjdHVhbCIsImNvbGxlY3Rpb25PcCIsIm9wZXJhbmRzIiwibWF0Y2hSZXN1bHQiLCJuZXh0UHJlZml4IiwibWFwUmVzdWx0IiwiaXNQbGFpbk9iamVjdCIsIm1hcFZhbHVlcyIsIm1hcCIsImkiLCJ2YWxpZGF0ZUNvbGxlY3Rpb24iLCJleHBlY3RlZEZpZWxkVmFsdWUiLCJ1bm1hdGNoZWRLZXkiLCJmaW5kSW5kZXgiLCJtYXRjaGVkIiwiZXZhbHVhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWQiLCJwYXNzT2JqZWN0Q2hlY2siLCJmaWVsZE5hbWUiLCJsIiwic3Vic3RyIiwicXVlcnlSZXN1bHQiLCJhY3R1YWxUeXBlIiwiYWN0dWFsRmllbGRWYWx1ZSIsIm9rIiwicmVhc29uIiwic2V0T3AiLCJleHBySXRlbSIsInR5cGVFeHByIiwicG9zIiwiJCRST09UIiwiaGFzT3BlcmF0b3IiLCJjb21wbGV5S2V5IiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFr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S0FBSyxDQUFDLEtBQUtvQyxLQUFOLEVBQWFtRCxRQUFiLEVBQXVCLEtBQUtvQixVQUE1QixDQUFwQjtBQUNBLFFBQUk1RSxNQUFNLENBQUMsQ0FBRCxDQUFWLEVBQWUsT0FBTyxJQUFQO0FBRWYsVUFBTSxJQUFJckgsZUFBSixDQUFvQnFILE1BQU0sQ0FBQyxDQUFELENBQTFCLEVBQStCO0FBQ2pDd0MsTUFBQUEsTUFBTSxFQUFFLEtBQUtuQyxLQURvQjtBQUVqQ21ELE1BQUFBO0FBRmlDLEtBQS9CLENBQU47QUFJSDs7QUFFRHpCLEVBQUFBLFFBQVEsQ0FBQzlCLElBQUQsRUFBTztBQUNYLFdBQU9sQixZQUFZLENBQUMsS0FBS3NCLEtBQU4sRUFBYUosSUFBYixFQUFtQixLQUFLMkUsVUFBeEIsQ0FBbkI7QUFDSDs7QUFFREMsRUFBQUEsTUFBTSxDQUFDNUUsSUFBRCxFQUFPO0FBQ1QsVUFBTUksS0FBSyxHQUFHdEIsWUFBWSxDQUFDLEtBQUtzQixLQUFOLEVBQWFKLElBQWIsRUFBbUIsS0FBSzJFLFVBQXhCLENBQTFCO0FBQ0EsU0FBS3ZFLEtBQUwsR0FBYUEsS0FBYjtBQUNBLFdBQU8sSUFBUDtBQUNIOztBQTdCSzs7QUFnQ1ZxRSxHQUFHLENBQUN6RyxLQUFKLEdBQVlBLEtBQVo7QUFDQXlHLEdBQUcsQ0FBQzNDLFFBQUosR0FBZWhELFlBQWY7QUFDQTJGLEdBQUcsQ0FBQ3RDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQTBDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9FWFBSX1NZTlRBWCA9ICdJbnZhbGlkIGV4cHJlc3Npb24gc3ludGF4Lic7XG5cbmNvbnN0IElOVkFMSURfUVVFUllfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke3Rva2VufVwiLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgdGVzdCBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfUVVFUllfSEFORExFUiA9IG9wID0+IGBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIGhhbmRsZXIgbm90IGZvdW5kLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfSEFOTERFUiA9IG9wID0+IGBKRVMgdGVzdCBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcblxuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfVFVQTEUgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBjb2xsZWN0aW9uIG9wZXJhdG9yICR7b3AgPyAnXCInICsgb3AgKyAnXCIgJyA6ICcnfW11c3QgYmUgYSB0d28tdHVwbGUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1RVUExFXzJfT1JfMyA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGVpdGhlciBhIDItdHVwbGUgb3IgYSAzLXR1cGxlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9BUlJBWSA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGFuIGFycmF5LmA7XG5jb25zdCBPUEVSQU5EX05PVF9CT09MID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgYSBib29sZWFuIHZhbHVlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9TVFJJTkcgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBhIHN0cmluZy5gO1xuXG5jb25zdCBWQUxVRV9OT1RfQ09MTEVDVElPTiA9IG9wID0+IGBUaGUgdmFsdWUgdXNpbmcgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBlaXRoZXIgYW4gb2JqZWN0IG9yIGFuIGFycmF5LmA7XG5cbmNvbnN0IFJFUVVJUkVfUklHSFRfT1BFUkFORCA9IG9wID0+IGBCaW5hcnkgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIHJlcXVpcmVzIHRoZSByaWdodCBvcGVyYW5kLmBcblxuLy9Db25kaXRpb24gb3BlcmF0b3JcbmNvbnN0IE9QX0VRVUFMID0gWyAnJGVxJywgJyRlcWwnLCAnJGVxdWFsJyBdO1xuY29uc3QgT1BfTk9UX0VRVUFMID0gWyAnJG5lJywgJyRuZXEnLCAnJG5vdEVxdWFsJyBdO1xuY29uc3QgT1BfTk9UID0gWyAnJG5vdCcgXTtcbmNvbnN0IE9QX0dSRUFURVJfVEhBTiA9IFsgJyRndCcsICckPicsICckZ3JlYXRlclRoYW4nIF07XG5jb25zdCBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwgPSBbICckZ3RlJywgJyQ8PScsICckZ3JlYXRlclRoYW5PckVxdWFsJyBdO1xuY29uc3QgT1BfTEVTU19USEFOID0gWyAnJGx0JywgJyQ8JywgJyRsZXNzVGhhbicgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTl9PUl9FUVVBTCA9IFsgJyRsdGUnLCAnJDw9JywgJyRsZXNzVGhhbk9yRXF1YWwnIF07XG5cbmNvbnN0IE9QX0lOID0gWyAnJGluJyBdO1xuY29uc3QgT1BfTk9UX0lOID0gWyAnJG5pbicsICckbm90SW4nIF07XG5jb25zdCBPUF9FWElTVFMgPSBbICckZXhpc3QnLCAnJGV4aXN0cycsICckbm90TnVsbCcgXTtcbmNvbnN0IE9QX01BVENIID0gWyAnJGhhcycsICckbWF0Y2gnLCAnJGFsbCcgXTtcbmNvbnN0IE9QX01BVENIX0FOWSA9IFsgJyRhbnknLCAnJG9yJywgJyRlaXRoZXInIF07XG5jb25zdCBPUF9UWVBFID0gWyAnJGlzJywgJyR0eXBlT2YnIF07XG5jb25zdCBPUF9IQVNfS0VZUyA9IFsgJyRoYXNLZXlzJywgJyR3aXRoS2V5cycgXTtcbmNvbnN0IE9QX1NUQVJUX1dJVEggPSBbICckc3RhcnRXaXRoJywgJyRzdGFydHNXaXRoJyBdO1xuY29uc3QgT1BfRU5EX1dJVEggPSBbICckZW5kV2l0aCcsICckZW5kc1dpdGgnIF07XG5cbi8vUXVlcnkgJiBhZ2dyZWdhdGUgb3BlcmF0b3JcbmNvbnN0IE9QX1NJWkUgPSBbICckc2l6ZScsICckbGVuZ3RoJywgJyRjb3VudCcgXTtcbmNvbnN0IE9QX1NVTSA9IFsgJyRzdW0nLCAnJHRvdGFsJyBdO1xuY29uc3QgT1BfS0VZUyA9IFsgJyRrZXlzJyBdO1xuY29uc3QgT1BfVkFMVUVTID0gWyAnJHZhbHVlcycgXTtcbmNvbnN0IE9QX0dFVF9UWVBFID0gWyAnJHR5cGUnIF07XG5cbi8vTWFuaXB1bGF0ZSBvcGVyYXRpb25cbmNvbnN0IE9QX0FERCA9IFsgJyRhZGQnLCAnJHBsdXMnLCAgICAgJyRpbmMnIF07XG5jb25zdCBPUF9TVUIgPSBbICckc3ViJywgJyRzdWJ0cmFjdCcsICckbWludXMnLCAnJGRlYycgXTtcbmNvbnN0IE9QX01VTCA9IFsgJyRtdWwnLCAnJG11bHRpcGx5JywgICckdGltZXMnIF07XG5jb25zdCBPUF9ESVYgPSBbICckZGl2JywgJyRkaXZpZGUnIF07XG5jb25zdCBPUF9TRVQgPSBbICckc2V0JywgJyQ9JyBdO1xuY29uc3QgT1BfQUREX0lURU0gPSBbICckYWRkSXRlbScsICckb3ZlcnJpZGUnIF07XG5cbmNvbnN0IE9QX1BJQ0sgPSBbICckcGljaycgXTtcbmNvbnN0IE9QX0dFVF9CWV9JTkRFWCA9IFsgJyRhdCcsICckZ2V0QnlJbmRleCcsICckbnRoJyBdO1xuY29uc3QgT1BfR0VUX0JZX0tFWSA9IFsgJyRvZicsICckZ2V0QnlLZXknIF07XG5jb25zdCBPUF9PTUlUID0gWyAnJG9taXQnIF07XG5jb25zdCBPUF9HUk9VUCA9IFsgJyRncm91cCcsICckZ3JvdXBCeScgXTtcbmNvbnN0IE9QX1NPUlQgPSBbICckc29ydCcsICckb3JkZXJCeScsICckc29ydEJ5JyBdO1xuY29uc3QgT1BfUkVWRVJTRSA9IFsgJyRyZXZlcnNlJyBdO1xuY29uc3QgT1BfRVZBTCA9IFsgJyRldmFsJywgJyRhcHBseScgXTtcbmNvbnN0IE9QX01FUkdFID0gWyAnJG1lcmdlJyBdO1xuY29uc3QgT1BfRklMVEVSID0gWyAnJGZpbHRlcicsICckc2VsZWN0JyBdO1xuXG4vL0NvbmRpdGlvbiBvcGVyYXRpb25cbmNvbnN0IE9QX0lGID0gWyAnJGlmJyBdO1xuXG5jb25zdCBQRlhfRk9SX0VBQ0ggPSAnfD4nOyAvLyBmb3IgZWFjaFxuY29uc3QgUEZYX1dJVEhfQU5ZID0gJ3wqJzsgLy8gd2l0aCBhbnlcblxuY29uc3QgTWFwT2ZPcHMgPSBuZXcgTWFwKCk7XG5jb25zdCBhZGRPcFRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk9wcy5zZXQodG9rZW4sIHRhZykpO1xuYWRkT3BUb01hcChPUF9FUVVBTCwgJ09QX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9FUVVBTCwgJ09QX05PVF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1QsICdPUF9OT1QnKTtcbmFkZE9wVG9NYXAoT1BfR1JFQVRFUl9USEFOLCAnT1BfR1JFQVRFUl9USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCwgJ09QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9MRVNTX1RIQU4sICdPUF9MRVNTX1RIQU4nKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOX09SX0VRVUFMLCAnT1BfTEVTU19USEFOX09SX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX0lOLCAnT1BfSU4nKTtcbmFkZE9wVG9NYXAoT1BfTk9UX0lOLCAnT1BfTk9UX0lOJyk7XG5hZGRPcFRvTWFwKE9QX0VYSVNUUywgJ09QX0VYSVNUUycpO1xuYWRkT3BUb01hcChPUF9NQVRDSCwgJ09QX01BVENIJyk7XG5hZGRPcFRvTWFwKE9QX01BVENIX0FOWSwgJ09QX01BVENIX0FOWScpO1xuYWRkT3BUb01hcChPUF9UWVBFLCAnT1BfVFlQRScpO1xuYWRkT3BUb01hcChPUF9IQVNfS0VZUywgJ09QX0hBU19LRVlTJyk7XG5hZGRPcFRvTWFwKE9QX1NUQVJUX1dJVEgsICdPUF9TVEFSVF9XSVRIJyk7XG5hZGRPcFRvTWFwKE9QX0VORF9XSVRILCAnT1BfRU5EX1dJVEgnKTtcblxuY29uc3QgTWFwT2ZNYW5zID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkTWFuVG9NYXAgPSAodG9rZW5zLCB0YWcpID0+IHRva2Vucy5mb3JFYWNoKHRva2VuID0+IE1hcE9mTWFucy5zZXQodG9rZW4sIHRhZykpO1xuLy8gWyA8b3AgbmFtZT4sIDx1bmFyeT4gXVxuYWRkTWFuVG9NYXAoT1BfU0laRSwgWydPUF9TSVpFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVU0sIFsnT1BfU1VNJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9LRVlTLCBbJ09QX0tFWVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1ZBTFVFUywgWydPUF9WQUxVRVMnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX0dFVF9UWVBFLCBbJ09QX0dFVF9UWVBFJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9SRVZFUlNFLCBbJ09QX1JFVkVSU0UnLCB0cnVlXSk7XG5cbmFkZE1hblRvTWFwKE9QX0FERCwgWydPUF9BREQnLCBmYWxzZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9TVUIsIFsnT1BfU1VCJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9NVUwsIFsnT1BfTVVMJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9ESVYsIFsnT1BfRElWJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9TRVQsIFsnT1BfU0VUJywgZmFsc2UgXSk7XG5hZGRNYW5Ub01hcChPUF9BRERfSVRFTSwgWydPUF9BRERfSVRFTScsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfUElDSywgWydPUF9QSUNLJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9JTkRFWCwgWydPUF9HRVRfQllfSU5ERVgnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR0VUX0JZX0tFWSwgWydPUF9HRVRfQllfS0VZJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX09NSVQsIFsnT1BfT01JVCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HUk9VUCwgWydPUF9HUk9VUCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9TT1JULCBbJ09QX1NPUlQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfRVZBTCwgWydPUF9FVkFMJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX01FUkdFLCBbJ09QX01FUkdFJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0ZJTFRFUiwgWydPUF9GSUxURVInLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfSUYsIFsnT1BfSUYnLCBmYWxzZV0pO1xuXG5jb25zdCBkZWZhdWx0SmVzSGFuZGxlcnMgPSB7XG4gICAgT1BfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gXy5pc0VxdWFsKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9OT1RfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gIV8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfTk9UOiAobGVmdCwgLi4uYXJncykgPT4gIXRlc3QobGVmdCwgJ09QX01BVENIJywgLi4uYXJncyksXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPiByaWdodCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA+PSByaWdodCxcbiAgICBPUF9MRVNTX1RIQU46IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8IHJpZ2h0LFxuICAgIE9QX0xFU1NfVEhBTl9PUl9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IDw9IHJpZ2h0LFxuICAgIE9QX0lOOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHJpZ2h0ID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9JTicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodC5maW5kKGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX05PVF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9OT1RfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgZWxlbWVudCA9PiBkZWZhdWx0SmVzSGFuZGxlcnMuT1BfTk9UX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX0VYSVNUUzogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0JPT0woJ09QX0VYSVNUUycpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodCA/IGxlZnQgIT0gbnVsbCA6IGxlZnQgPT0gbnVsbDtcbiAgICB9LFxuICAgIE9QX1RZUEU6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfVFlQRScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJpZ2h0ID0gcmlnaHQudG9Mb3dlckNhc2UoKTtcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdhcnJheScpIHtcbiAgICAgICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KGxlZnQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ2ludGVnZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5pc0ludGVnZXIobGVmdCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBsZWZ0ID09PSAnc3RyaW5nJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gcmlnaHQ7XG4gICAgfSxcbiAgICBPUF9NQVRDSDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcnVsZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KTtcbiAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgfSxcbiAgICBPUF9NQVRDSF9BTlk6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9NQVRDSF9BTlknKSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmlnaHQsIHJ1bGUgPT4ge1xuICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICB9KTsgICBcbiAgICBcbiAgICAgICAgcmV0dXJuIGZvdW5kID8gdHJ1ZSA6IGZhbHNlO1xuICAgIH0sXG4gICAgT1BfSEFTX0tFWVM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwib2JqZWN0XCIpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwga2V5ID0+IGhhc0tleUJ5UGF0aChsZWZ0LCBrZXkpKTtcbiAgICB9LFxuICAgIE9QX1NUQVJUX1dJVEg6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX1NUQVJUX1dJVEgnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdC5zdGFydHNXaXRoKHJpZ2h0KTtcbiAgICB9LFxuICAgIE9QX0VORF9XSVRIOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9FTkRfV0lUSCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0LmVuZHNXaXRoKHJpZ2h0KTtcbiAgICB9ICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdE1hbmlwdWxhdGlvbnMgPSB7XG4gICAgLy91bmFyeVxuICAgIE9QX1NJWkU6IChsZWZ0KSA9PiBfLnNpemUobGVmdCksXG4gICAgT1BfU1VNOiAobGVmdCkgPT4gXy5yZWR1Y2UobGVmdCwgKHN1bSwgaXRlbSkgPT4ge1xuICAgICAgICAgICAgc3VtICs9IGl0ZW07XG4gICAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICB9LCAwKSxcblxuICAgIE9QX0tFWVM6IChsZWZ0KSA9PiBfLmtleXMobGVmdCksXG4gICAgT1BfVkFMVUVTOiAobGVmdCkgPT4gXy52YWx1ZXMobGVmdCksICAgXG4gICAgT1BfR0VUX1RZUEU6IChsZWZ0KSA9PiBBcnJheS5pc0FycmF5KGxlZnQpID8gJ2FycmF5JyA6IChfLmlzSW50ZWdlcihsZWZ0KSA/ICdpbnRlZ2VyJyA6IHR5cGVvZiBsZWZ0KSwgIFxuICAgIE9QX1JFVkVSU0U6IChsZWZ0KSA9PiBfLnJldmVyc2UobGVmdCksXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ICsgcmlnaHQsXG4gICAgT1BfU1VCOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgLSByaWdodCxcbiAgICBPUF9NVUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAqIHJpZ2h0LFxuICAgIE9QX0RJVjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC8gcmlnaHQsIFxuICAgIE9QX1NFVDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4gZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0LCB0cnVlKSwgXG4gICAgT1BfQUREX0lURU06IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFZBTFVFX05PVF9DT0xMRUNUSU9OKCdPUF9BRERfSVRFTScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdC5jb25jYXQocmlnaHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSB8fCByaWdodC5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRSgnT1BfQUREX0lURU0nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyAuLi5sZWZ0LCBbcmlnaHRbMF1dOiBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMV0sIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQsICQkUEFSRU5UOiBjb250ZXh0LiQkQ1VSUkVOVCwgJCRDVVJSRU5UOiBsZWZ0IH0pIH07XG4gICAgfSwgXG4gICAgT1BfUElDSzogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAobGVmdCA9PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByaWdodCA9IF8uY2FzdEFycmF5KHJpZ2h0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgcmV0dXJuIF8ucGljayhsZWZ0LCByaWdodCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIF8ucGlja0J5KGxlZnQsICh4LCBrZXkpID0+IG1hdGNoKGtleSwgcmlnaHQsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSlbMF0pO1xuICAgIH0sXG4gICAgT1BfR0VUX0JZX0lOREVYOiAobGVmdCwgcmlnaHQpID0+IF8ubnRoKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HRVRfQllfS0VZOiAobGVmdCwgcmlnaHQpID0+IF8uZ2V0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9PTUlUOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmIChsZWZ0ID09IG51bGwpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJpZ2h0ID0gXy5jYXN0QXJyYXkocmlnaHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5vbWl0KGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gXy5vbWl0QnkobGVmdCwgKHgsIGtleSkgPT4gbWF0Y2goa2V5LCByaWdodCwgamVzLCBmb3JtYXRQcmVmaXgoa2V5LCBwcmVmaXgpKVswXSk7XG4gICAgfSxcbiAgICBPUF9HUk9VUDogKGxlZnQsIHJpZ2h0KSA9PiBfLmdyb3VwQnkobGVmdCwgcmlnaHQpLFxuICAgIE9QX1NPUlQ6IChsZWZ0LCByaWdodCkgPT4gXy5zb3J0QnkobGVmdCwgcmlnaHQpLCAgXG4gICAgT1BfRVZBTDogZXZhbHVhdGVFeHByLFxuICAgIE9QX01FUkdFOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUVSR0UnKSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiByaWdodC5yZWR1Y2UoKHJlc3VsdCwgZXhwciwga2V5KSA9PiBPYmplY3QuYXNzaWduKHJlc3VsdCwgZXZhbHVhdGVFeHByKGxlZnQsIGV4cHIsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSwgeyAuLi5jb250ZXh0IH0pKSwge30pO1xuICAgIH0sXG4gICAgT1BfRklMVEVSOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmIChsZWZ0ID09IG51bGwpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihWQUxVRV9OT1RfQ09MTEVDVElPTignT1BfRklMVEVSJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIF8uZmlsdGVyKGxlZnQsICh2YWx1ZSwga2V5KSA9PiB0ZXN0KHZhbHVlLCAnT1BfTUFUQ0gnLCByaWdodCwgamVzLCBmb3JtYXRQcmVmaXgoa2V5LCBwcmVmaXgpKSk7XG4gICAgfSxcbiAgICBPUF9JRjogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX0lGJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJpZ2h0Lmxlbmd0aCA8IDIgfHwgcmlnaHQubGVuZ3RoID4gMykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1RVUExFXzJfT1JfMygnT1BfSUYnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjb25kaXRpb24gPSBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCByaWdodFswXSwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHRydWUpO1xuXG4gICAgICAgIGlmICh0ZXN0KGxlZnQsICdPUF9NQVRDSCcsIGNvbmRpdGlvbiwgamVzLCBwcmVmaXgpKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKGxlZnQsIHJpZ2h0WzFdLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSBpZiAocmlnaHQubGVuZ3RoID4gMikgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgcmV0ID0gZXZhbHVhdGVFeHByKGxlZnQsIHJpZ2h0WzJdLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnQ7XG4gICAgfVxufVxuXG5jb25zdCBmb3JtYXROYW1lID0gKG5hbWUsIHByZWZpeCkgPT4ge1xuICAgIGNvbnN0IGZ1bGxOYW1lID0gbmFtZSA9PSBudWxsID8gcHJlZml4IDogZm9ybWF0UHJlZml4KG5hbWUsIHByZWZpeCk7XG4gICAgcmV0dXJuIGZ1bGxOYW1lID09IG51bGwgPyBcIlRoZSB2YWx1ZVwiIDogKGZ1bGxOYW1lLmluZGV4T2YoJygnKSAhPT0gLTEgPyBgVGhlIHF1ZXJ5IFwiXy4ke2Z1bGxOYW1lfVwiYCA6IGBcIiR7ZnVsbE5hbWV9XCJgKTtcbn07XG5jb25zdCBmb3JtYXRLZXkgPSAoa2V5LCBoYXNQcmVmaXgpID0+IF8uaXNJbnRlZ2VyKGtleSkgPyBgWyR7a2V5fV1gIDogKGhhc1ByZWZpeCA/ICcuJyArIGtleSA6IGtleSk7XG5jb25zdCBmb3JtYXRQcmVmaXggPSAoa2V5LCBwcmVmaXgpID0+IHByZWZpeCAhPSBudWxsID8gYCR7cHJlZml4fSR7Zm9ybWF0S2V5KGtleSwgdHJ1ZSl9YCA6IGZvcm1hdEtleShrZXksIGZhbHNlKTtcbmNvbnN0IGZvcm1hdFF1ZXJ5ID0gKG9wTWV0YSkgPT4gYCR7ZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zW29wTWV0YVswXV19KCR7b3BNZXRhWzFdID8gJycgOiAnPyd9KWA7ICBcbmNvbnN0IGZvcm1hdE1hcCA9IChuYW1lKSA9PiBgZWFjaCgtPiR7bmFtZX0pYDtcbmNvbnN0IGZvcm1hdEFueSA9IChuYW1lKSA9PiBgYW55KC0+JHtuYW1lfSlgO1xuXG5jb25zdCBkZWZhdWx0SmVzRXhwbGFuYXRpb25zID0ge1xuICAgIE9QX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1RfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1Q6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgZ3JlYXRlciB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0xFU1NfVEhBTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGxlc3MgdGhhbiAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOX09SX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuIG9yIGVxdWFsIHRvICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIG9uZSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSBhbnkgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfRVhJU1RTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQke3JpZ2h0ID8gJyBub3QgJzogJyAnfWJlIE5VTEwuYCwgICAgXG4gICAgT1BfVFlQRTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGBUaGUgdHlwZSBvZiAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIFwiJHtyaWdodH1cIiwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgICAgICBcbiAgICBPUF9NQVRDSDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX01BVENIX0FOWTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoIGFueSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9IQVNfS0VZUzogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGhhdmUgYWxsIG9mIHRoZXNlIGtleXMgWyR7cmlnaHQuam9pbignLCAnKX1dLmAsICAgICAgICBcbiAgICBPUF9TVEFSVF9XSVRIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgc3RhcnQgd2l0aCBcIiR7cmlnaHR9XCIuYCwgICAgICAgIFxuICAgIE9QX0VORF9XSVRIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgZW5kIHdpdGggXCIke3JpZ2h0fVwiLmAsICAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRRdWVyeUV4cGxhbmF0aW9ucyA9IHtcbiAgICAvL3VuYXJ5XG4gICAgT1BfU0laRTogJ3NpemUnLFxuICAgIE9QX1NVTTogJ3N1bScsXG4gICAgT1BfS0VZUzogJ2tleXMnLFxuICAgIE9QX1ZBTFVFUzogJ3ZhbHVlcycsICAgIFxuICAgIE9QX0dFVF9UWVBFOiAnZ2V0IHR5cGUnLFxuICAgIE9QX1JFVkVSU0U6ICdyZXZlcnNlJywgXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogJ2FkZCcsXG4gICAgT1BfU1VCOiAnc3VidHJhY3QnLFxuICAgIE9QX01VTDogJ211bHRpcGx5JyxcbiAgICBPUF9ESVY6ICdkaXZpZGUnLCBcbiAgICBPUF9TRVQ6ICdhc3NpZ24nLFxuICAgIE9QX0FERF9JVEVNOiAnYWRkSXRlbScsXG4gICAgT1BfUElDSzogJ3BpY2snLFxuICAgIE9QX0dFVF9CWV9JTkRFWDogJ2dldCBlbGVtZW50IGF0IGluZGV4JyxcbiAgICBPUF9HRVRfQllfS0VZOiAnZ2V0IGVsZW1lbnQgb2Yga2V5JyxcbiAgICBPUF9PTUlUOiAnb21pdCcsXG4gICAgT1BfR1JPVVA6ICdncm91cEJ5JyxcbiAgICBPUF9TT1JUOiAnc29ydEJ5JyxcbiAgICBPUF9FVkFMOiAnZXZhbHVhdGUnLFxuICAgIE9QX01FUkdFOiAnbWVyZ2UnLFxuICAgIE9QX0ZJTFRFUjogJ2ZpbHRlcicsXG4gICAgT1BfSUY6ICdldmFsdWF0ZSBpZidcbn07XG5cbmZ1bmN0aW9uIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KSB7XG4gICAgY29uc3QgZ2V0dGVyID0gamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zW29wXSB8fCBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfTUFUQ0g7XG4gICAgcmV0dXJuIGdldHRlcihuYW1lLCBsZWZ0VmFsdWUsIHJpZ2h0VmFsdWUsIHByZWZpeCk7ICAgIFxufVxuXG5mdW5jdGlvbiB0ZXN0KHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5vcGVyYXRvckhhbmRsZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX0hBTkxERVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZSh2YWx1ZSwgb3AsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlVW5hcnkodmFsdWUsIG9wLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLnF1ZXJ5SGFubGRlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX0hBTkRMRVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgcmlnaHRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIGlmIChvcE1ldGFbMV0pIHtcbiAgICAgICAgcmV0dXJuIHJpZ2h0VmFsdWUgPyBldmFsdWF0ZVVuYXJ5KGN1cnJlbnRWYWx1ZSwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCkgOiBjdXJyZW50VmFsdWU7XG4gICAgfSBcbiAgICBcbiAgICByZXR1cm4gZXZhbHVhdGUoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIHJpZ2h0VmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuY29uc3QgZGVmYXVsdEN1c3RvbWl6ZXIgPSB7XG4gICAgbWFwT2ZPcGVyYXRvcnM6IE1hcE9mT3BzLFxuICAgIG1hcE9mTWFuaXB1bGF0b3JzOiBNYXBPZk1hbnMsXG4gICAgb3BlcmF0b3JIYW5kbGVyczogZGVmYXVsdEplc0hhbmRsZXJzLFxuICAgIG9wZXJhdG9yRXhwbGFuYXRpb25zOiBkZWZhdWx0SmVzRXhwbGFuYXRpb25zLFxuICAgIHF1ZXJ5SGFubGRlcnM6IGRlZmF1bHRNYW5pcHVsYXRpb25zXG59O1xuXG5mdW5jdGlvbiBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgb3BlcmFuZHMsIGplcywgcHJlZml4KSB7XG4gICAgbGV0IG1hdGNoUmVzdWx0LCBuZXh0UHJlZml4O1xuXG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCBtYXBSZXN1bHQgPSBfLmlzUGxhaW5PYmplY3QoYWN0dWFsKSA/IF8ubWFwVmFsdWVzKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpKSA6IF8ubWFwKGFjdHVhbCwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgb3BlcmFuZHNbMF0sIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSkpO1xuICAgICAgICAgICAgbmV4dFByZWZpeCA9IGZvcm1hdFByZWZpeChmb3JtYXRNYXAoZm9ybWF0UXVlcnkob3BNZXRhKSksIHByZWZpeCk7XG4gICAgICAgICAgICBtYXRjaFJlc3VsdCA9IG1hdGNoKG1hcFJlc3VsdCwgb3BlcmFuZHNbMV0sIGplcywgbmV4dFByZWZpeCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICAgXG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdEFueShmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gbWF0Y2goZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpLCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCB1bm1hdGNoZWRLZXkgPSBfLmZpbmRJbmRleChhY3R1YWwsIChpdGVtKSA9PiAhdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgICAgICBpZiAodW5tYXRjaGVkS2V5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIHVubWF0Y2hlZEtleSwgYWN0dWFsW3VubWF0Y2hlZEtleV0sIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgXG4gICAgICAgICAgICBjb25zdCBtYXRjaGVkID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgIFxuICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIHN3aXRjaCAoY29sbGVjdGlvbk9wKSB7XG4gICAgICAgIGNhc2UgUEZYX0ZPUl9FQUNIOlxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGN1cnJlbnRWYWx1ZSwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGksIHByZWZpeCksIHsgLi4uY29udGV4dCwgJCRQQVJFTlQ6IGN1cnJlbnRWYWx1ZSwgJCRDVVJSRU5UOiBpdGVtIH0pKTtcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICBcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihQUlhfT1BfTk9UX0ZPUl9FVkFMKGNvbGxlY3Rpb25PcCkpO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBcbiAqIEBwYXJhbSB7Kn0gYWN0dWFsIFxuICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAqIEBwYXJhbSB7Kn0gamVzIFxuICogQHBhcmFtIHsqfSBwcmVmaXggIFxuICogXG4gKiB7IGtleTogeyAkbWF0Y2ggfSB9XG4gKi9cbmZ1bmN0aW9uIG1hdGNoKGFjdHVhbCwgZXhwZWN0ZWQsIGplcywgcHJlZml4KSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBsZXQgcGFzc09iamVjdENoZWNrID0gZmFsc2U7XG5cbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChleHBlY3RlZCkpIHtcbiAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbCwgJ09QX0VRVUFMJywgZXhwZWN0ZWQsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVFVQUwobnVsbCwgYWN0dWFsLCBleHBlY3RlZCwgcHJlZml4KSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIF07XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIFt0cnVlXTtcbiAgICB9XG5cbiAgICBmb3IgKGxldCBmaWVsZE5hbWUgaW4gZXhwZWN0ZWQpIHtcbiAgICAgICAgbGV0IGV4cGVjdGVkRmllbGRWYWx1ZSA9IGV4cGVjdGVkW2ZpZWxkTmFtZV07IFxuICAgICAgICBcbiAgICAgICAgY29uc3QgbCA9IGZpZWxkTmFtZS5sZW5ndGg7XG5cbiAgICAgICAgaWYgKGwgPiAxKSB7ICAgICBcbiAgICAgICAgICAgIGlmIChsID4gNCAmJiBmaWVsZE5hbWVbMF0gPT09ICd8JyAmJiBmaWVsZE5hbWVbMl0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbM10gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZXhwZWN0ZWRGaWVsZFZhbHVlKSAmJiBleHBlY3RlZEZpZWxkVmFsdWUubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEUoKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMyk7IFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXRjaFJlc3VsdCkgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL3ZhbGlkYXRvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wID0gamVzLm1hcE9mT3BlcmF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGwgPiAyICYmIGZpZWxkTmFtZVsxXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMSk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy9wcm9jZXNzb3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE1ldGFbMV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihOT1RfQV9VTkFSWV9RVUVSWSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBxdWVyeVJlc3VsdCA9IGV2YWx1YXRlVW5hcnkoYWN0dWFsLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoKHF1ZXJ5UmVzdWx0LCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZvcm1hdFF1ZXJ5KG9wTWV0YSksIHByZWZpeCkpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3ZhbGlkYXRvclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wID0gamVzLm1hcE9mT3BlcmF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfVEVTVF9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKCFwYXNzT2JqZWN0Q2hlY2spIHtcbiAgICAgICAgICAgIGlmIChhY3R1YWwgPT0gbnVsbCkgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSwgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX0VYSVNUUyhudWxsLCBudWxsLCB0cnVlLCBwcmVmaXgpXG4gICAgICAgICAgICBdOyBcblxuICAgICAgICAgICAgY29uc3QgYWN0dWFsVHlwZSA9IHR5cGVvZiBhY3R1YWw7XG4gICAgXG4gICAgICAgICAgICBpZiAoYWN0dWFsVHlwZSAhPT0gJ29iamVjdCcpIHJldHVybiBbXG4gICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX1RZUEUobnVsbCwgYWN0dWFsVHlwZSwgJ29iamVjdCcsIHByZWZpeClcbiAgICAgICAgICAgIF07ICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBwYXNzT2JqZWN0Q2hlY2sgPSB0cnVlO1xuXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gXy5nZXQoYWN0dWFsLCBmaWVsZE5hbWUpOyAgICAgXG4gICAgICAgIFxuICAgICAgICBpZiAoZXhwZWN0ZWRGaWVsZFZhbHVlICE9IG51bGwgJiYgdHlwZW9mIGV4cGVjdGVkRmllbGRWYWx1ZSA9PT0gJ29iamVjdCcpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IFsgb2ssIHJlYXNvbiBdID0gbWF0Y2goYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCkpO1xuICAgICAgICAgICAgaWYgKCFvaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBbIGZhbHNlLCByZWFzb24gXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWxGaWVsZFZhbHVlLCAnT1BfRVFVQUwnLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVFVQUwoZmllbGROYW1lLCBhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBbdHJ1ZV07XG59XG5cbi8qKlxuICogSWYgJCBvcGVyYXRvciB1c2VkLCBvbmx5IG9uZSBhIHRpbWUgaXMgYWxsb3dlZFxuICogZS5nLlxuICoge1xuICogICAgJGdyb3VwQnk6ICdrZXknXG4gKiB9XG4gKiBcbiAqIFxuICogQHBhcmFtIHsqfSBjdXJyZW50VmFsdWUgXG4gKiBAcGFyYW0geyp9IGV4cHIgXG4gKiBAcGFyYW0geyp9IHByZWZpeCBcbiAqIEBwYXJhbSB7Kn0gamVzIFxuICogQHBhcmFtIHsqfSBjb250ZXh0XG4gKi9cbmZ1bmN0aW9uIGV2YWx1YXRlRXhwcihjdXJyZW50VmFsdWUsIGV4cHIsIGplcywgcHJlZml4LCBjb250ZXh0LCBzZXRPcCkge1xuICAgIGplcyAhPSBudWxsIHx8IChqZXMgPSBkZWZhdWx0Q3VzdG9taXplcik7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZXhwcikpIHtcbiAgICAgICAgaWYgKHNldE9wKSB7XG4gICAgICAgICAgICByZXR1cm4gZXhwci5tYXAoaXRlbSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCBpdGVtLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0sIHRydWUpKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGV4cHIucmVkdWNlKChyZXN1bHQsIGV4cHJJdGVtKSA9PiBldmFsdWF0ZUV4cHIocmVzdWx0LCBleHBySXRlbSwgamVzLCBwcmVmaXgsIHsgLi4uY29udGV4dCB9KSwgY3VycmVudFZhbHVlKTtcbiAgICB9XG5cbiAgICBjb25zdCB0eXBlRXhwciA9IHR5cGVvZiBleHByO1xuXG4gICAgaWYgKHR5cGVFeHByID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICBpZiAoc2V0T3ApIHJldHVybiBleHByO1xuICAgICAgICByZXR1cm4gZXhwciA/IGN1cnJlbnRWYWx1ZSA6IHVuZGVmaW5lZDtcbiAgICB9ICAgIFxuXG4gICAgaWYgKHR5cGVFeHByID09PSBcIm51bWJlclwiIHx8IHR5cGVFeHByID09PSBcImJpZ2ludFwiKSB7XG4gICAgICAgIGlmIChzZXRPcCkgcmV0dXJuIGV4cHI7XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfRVhQUl9TWU5UQVgpO1xuICAgIH1cblxuICAgIGlmICh0eXBlRXhwciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKGV4cHIuc3RhcnRzV2l0aCgnJCQnKSkge1xuICAgICAgICAgICAgLy9nZXQgZnJvbSBjb250ZXh0XG4gICAgICAgICAgICBjb25zdCBwb3MgPSBleHByLmluZGV4T2YoJy4nKTtcbiAgICAgICAgICAgIGlmIChwb3MgPT09IC0xKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBjb250ZXh0W2V4cHJdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5nZXQoY29udGV4dFtleHByLnN1YnN0cigwLCBwb3MpXSwgZXhwci5zdWJzdHIocG9zKzEpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzZXRPcCkge1xuICAgICAgICAgICAgcmV0dXJuIGV4cHI7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGV4cHIpO1xuICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFvcE1ldGFbMV0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihSRVFVSVJFX1JJR0hUX09QRVJBTkQoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KTtcbiAgICB9IFxuXG4gICAgaWYgKHR5cGVFeHByICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0VYUFJfU1lOVEFYKTtcbiAgICB9XG5cbiAgICBpZiAoc2V0T3ApIHtcbiAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKGV4cHIsIGl0ZW0gPT4gZXZhbHVhdGVFeHByKHVuZGVmaW5lZCwgaXRlbSwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHRydWUpKTtcbiAgICB9XG5cbiAgICBpZiAoY29udGV4dCA9PSBudWxsKSB7IFxuICAgICAgICBjb250ZXh0ID0geyAkJFJPT1Q6IGN1cnJlbnRWYWx1ZSwgJCRQQVJFTlQ6IG51bGwsICQkQ1VSUkVOVDogY3VycmVudFZhbHVlIH07ICAgICAgICBcbiAgICB9IFxuXG4gICAgbGV0IHJlc3VsdCwgaGFzT3BlcmF0b3IgPSBmYWxzZTsgICAgXG5cbiAgICBmb3IgKGxldCBmaWVsZE5hbWUgaW4gZXhwcikge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwcltmaWVsZE5hbWVdOyAgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xuICAgICAgICAgICAgICAgIGhhc09wZXJhdG9yID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGwgPiAzICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDIpOyBcblxuICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXN1bHQgPSBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29tcGxleUtleSA9IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgIT09IC0xO1xuXG4gICAgICAgIC8vcGljayBhIGZpZWxkIGFuZCB0aGVuIGFwcGx5IG1hbmlwdWxhdGlvblxuICAgICAgICBsZXQgYWN0dWFsRmllbGRWYWx1ZSA9IGN1cnJlbnRWYWx1ZSAhPSBudWxsID8gKGNvbXBsZXlLZXkgPyBfLmdldChjdXJyZW50VmFsdWUsIGZpZWxkTmFtZSkgOiBjdXJyZW50VmFsdWVbZmllbGROYW1lXSkgOiB1bmRlZmluZWQ7ICAgICAgICAgXG5cbiAgICAgICAgY29uc3QgY2hpbGRGaWVsZFZhbHVlID0gZXZhbHVhdGVFeHByKGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZmllbGROYW1lLCBwcmVmaXgpLCBjb250ZXh0KTtcblxuICAgICAgICBpZiAodHlwZW9mIGNoaWxkRmllbGRWYWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9PSBudWxsICYmIChyZXN1bHQgPSB7fSk7XG4gICAgICAgICAgICBpZiAoY29tcGxleUtleSkge1xuICAgICAgICAgICAgICAgIF8uc2V0KHJlc3VsdCwgZmllbGROYW1lLCBjaGlsZEZpZWxkVmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXN1bHRbZmllbGROYW1lXSA9IGNoaWxkRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuY2xhc3MgSkVTIHtcbiAgICBjb25zdHJ1Y3Rvcih2YWx1ZSwgY3VzdG9taXplcikge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgIHRoaXMuY3VzdG9taXplciA9IGN1c3RvbWl6ZXI7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAgICAgKiBAcGFyYW0gIHsuLi5hbnl9IGFyZ3MgXG4gICAgICovXG4gICAgbWF0Y2goZXhwZWN0ZWQpIHsgICAgICAgIFxuICAgICAgICBjb25zdCByZXN1bHQgPSBtYXRjaCh0aGlzLnZhbHVlLCBleHBlY3RlZCwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgaWYgKHJlc3VsdFswXSkgcmV0dXJuIHRoaXM7XG5cbiAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihyZXN1bHRbMV0sIHtcbiAgICAgICAgICAgIGFjdHVhbDogdGhpcy52YWx1ZSxcbiAgICAgICAgICAgIGV4cGVjdGVkXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGV2YWx1YXRlKGV4cHIpIHtcbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlRXhwcih0aGlzLnZhbHVlLCBleHByLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgIH1cblxuICAgIHVwZGF0ZShleHByKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxufVxuXG5KRVMubWF0Y2ggPSBtYXRjaDtcbkpFUy5ldmFsdWF0ZSA9IGV2YWx1YXRlRXhwcjtcbkpFUy5kZWZhdWx0Q3VzdG9taXplciA9IGRlZmF1bHRDdXN0b21pemVyO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEpFUzsiXX0=
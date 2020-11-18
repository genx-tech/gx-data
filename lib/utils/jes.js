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
    if (typeof left !== "object") {
      throw new ValidationError(VALUE_NOT_COLLECTION('OP_FILTER'));
    }

    return _.filter(left, (value, key) => test(value, 'OP_MATCH', condition, jes, formatPrefix(key, prefix)));
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJOT1RfQV9VTkFSWV9RVUVSWSIsIklOVkFMSURfRVhQUl9TWU5UQVgiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiSU5WQUxJRF9DT0xMRUNUSU9OX09QIiwiUFJYX09QX05PVF9GT1JfRVZBTCIsInByZWZpeCIsIk9QRVJBTkRfTk9UX1RVUExFIiwiT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zIiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiVkFMVUVfTk9UX0NPTExFQ1RJT04iLCJSRVFVSVJFX1JJR0hUX09QRVJBTkQiLCJPUF9FUVVBTCIsIk9QX05PVF9FUVVBTCIsIk9QX05PVCIsIk9QX0dSRUFURVJfVEhBTiIsIk9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCIsIk9QX0xFU1NfVEhBTiIsIk9QX0xFU1NfVEhBTl9PUl9FUVVBTCIsIk9QX0lOIiwiT1BfTk9UX0lOIiwiT1BfRVhJU1RTIiwiT1BfTUFUQ0giLCJPUF9NQVRDSF9BTlkiLCJPUF9UWVBFIiwiT1BfSEFTX0tFWVMiLCJPUF9TVEFSVF9XSVRIIiwiT1BfRU5EX1dJVEgiLCJPUF9TSVpFIiwiT1BfU1VNIiwiT1BfS0VZUyIsIk9QX1ZBTFVFUyIsIk9QX0dFVF9UWVBFIiwiT1BfQUREIiwiT1BfU1VCIiwiT1BfTVVMIiwiT1BfRElWIiwiT1BfU0VUIiwiT1BfQUREX0lURU0iLCJPUF9QSUNLIiwiT1BfR0VUX0JZX0lOREVYIiwiT1BfR0VUX0JZX0tFWSIsIk9QX09NSVQiLCJPUF9HUk9VUCIsIk9QX1NPUlQiLCJPUF9SRVZFUlNFIiwiT1BfRVZBTCIsIk9QX01FUkdFIiwiT1BfRklMVEVSIiwiT1BfSUYiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNvbnRleHQiLCJldmFsdWF0ZUV4cHIiLCJ1bmRlZmluZWQiLCJjb25jYXQiLCJsZW5ndGgiLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImNhc3RBcnJheSIsInBpY2siLCJwaWNrQnkiLCJ4IiwiZm9ybWF0UHJlZml4IiwibnRoIiwiZ2V0Iiwib21pdCIsIm9taXRCeSIsImdyb3VwQnkiLCJzb3J0QnkiLCJyZXN1bHQiLCJleHByIiwiT2JqZWN0IiwiYXNzaWduIiwiZmlsdGVyIiwidmFsdWUiLCJjb25kaXRpb24iLCJyZXQiLCJmb3JtYXROYW1lIiwibmFtZSIsImZ1bGxOYW1lIiwiaW5kZXhPZiIsImZvcm1hdEtleSIsImhhc1ByZWZpeCIsImZvcm1hdFF1ZXJ5Iiwib3BNZXRhIiwiZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zIiwiZm9ybWF0TWFwIiwiZm9ybWF0QW55IiwiZGVmYXVsdEplc0V4cGxhbmF0aW9ucyIsIkpTT04iLCJzdHJpbmdpZnkiLCJqb2luIiwiZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24iLCJsZWZ0VmFsdWUiLCJyaWdodFZhbHVlIiwiZ2V0dGVyIiwib3BlcmF0b3JFeHBsYW5hdGlvbnMiLCJvcFZhbHVlIiwiaGFuZGxlciIsIm9wZXJhdG9ySGFuZGxlcnMiLCJldmFsdWF0ZSIsInF1ZXJ5SGFubGRlcnMiLCJldmFsdWF0ZVVuYXJ5IiwiZXZhbHVhdGVCeU9wTWV0YSIsImN1cnJlbnRWYWx1ZSIsImRlZmF1bHRDdXN0b21pemVyIiwibWFwT2ZPcGVyYXRvcnMiLCJtYXBPZk1hbmlwdWxhdG9ycyIsIm1hdGNoQ29sbGVjdGlvbiIsImFjdHVhbCIsImNvbGxlY3Rpb25PcCIsIm9wZXJhbmRzIiwibWF0Y2hSZXN1bHQiLCJuZXh0UHJlZml4IiwibWFwUmVzdWx0IiwiaXNQbGFpbk9iamVjdCIsIm1hcFZhbHVlcyIsIm1hcCIsImkiLCJ2YWxpZGF0ZUNvbGxlY3Rpb24iLCJleHBlY3RlZEZpZWxkVmFsdWUiLCJ1bm1hdGNoZWRLZXkiLCJmaW5kSW5kZXgiLCJtYXRjaGVkIiwiZXZhbHVhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWQiLCJwYXNzT2JqZWN0Q2hlY2siLCJmaWVsZE5hbWUiLCJsIiwic3Vic3RyIiwicXVlcnlSZXN1bHQiLCJhY3R1YWxUeXBlIiwiYWN0dWFsRmllbGRWYWx1ZSIsIm9rIiwicmVhc29uIiwic2V0T3AiLCJleHBySXRlbSIsInR5cGVFeHByIiwicG9zIiwiJCRST09UIiwiaGFzT3BlcmF0b3IiLCJjb21wbGV5S2V5IiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFr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QUNBLFFBQUk1RSxNQUFNLENBQUMsQ0FBRCxDQUFWLEVBQWUsT0FBTyxJQUFQO0FBRWYsVUFBTSxJQUFJckgsZUFBSixDQUFvQnFILE1BQU0sQ0FBQyxDQUFELENBQTFCLEVBQStCO0FBQ2pDd0MsTUFBQUEsTUFBTSxFQUFFLEtBQUtuQyxLQURvQjtBQUVqQ21ELE1BQUFBO0FBRmlDLEtBQS9CLENBQU47QUFJSDs7QUFFRHpCLEVBQUFBLFFBQVEsQ0FBQzlCLElBQUQsRUFBTztBQUNYLFdBQU9sQixZQUFZLENBQUMsS0FBS3NCLEtBQU4sRUFBYUosSUFBYixFQUFtQixLQUFLMkUsVUFBeEIsQ0FBbkI7QUFDSDs7QUFFREMsRUFBQUEsTUFBTSxDQUFDNUUsSUFBRCxFQUFPO0FBQ1QsVUFBTUksS0FBSyxHQUFHdEIsWUFBWSxDQUFDLEtBQUtzQixLQUFOLEVBQWFKLElBQWIsRUFBbUIsS0FBSzJFLFVBQXhCLENBQTFCO0FBQ0EsU0FBS3ZFLEtBQUwsR0FBYUEsS0FBYjtBQUNBLFdBQU8sSUFBUDtBQUNIOztBQTdCSzs7QUFnQ1ZxRSxHQUFHLENBQUN6RyxLQUFKLEdBQVlBLEtBQVo7QUFDQXlHLEdBQUcsQ0FBQzNDLFFBQUosR0FBZWhELFlBQWY7QUFDQTJGLEdBQUcsQ0FBQ3RDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQTBDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9FWFBSX1NZTlRBWCA9ICdJbnZhbGlkIGV4cHJlc3Npb24gc3ludGF4Lic7XG5cbmNvbnN0IElOVkFMSURfUVVFUllfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke3Rva2VufVwiLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfT1BFUkFUT1IgPSB0b2tlbiA9PiBgSW52YWxpZCBKRVMgdGVzdCBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfUVVFUllfSEFORExFUiA9IG9wID0+IGBKRVMgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIGhhbmRsZXIgbm90IGZvdW5kLmA7XG5jb25zdCBJTlZBTElEX1RFU1RfSEFOTERFUiA9IG9wID0+IGBKRVMgdGVzdCBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcblxuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfVFVQTEUgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBjb2xsZWN0aW9uIG9wZXJhdG9yICR7b3AgPyAnXCIgKyBvcCArIFwiICcgOiAnJ31tdXN0IGJlIGEgdHdvLXR1cGxlLmA7XG5jb25zdCBPUEVSQU5EX05PVF9UVVBMRV8yX09SXzMgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBlaXRoZXIgYSAyLXR1cGxlIG9yIGEgMy10dXBsZS5gO1xuY29uc3QgT1BFUkFORF9OT1RfQVJSQVkgPSBvcCA9PiBgVGhlIG9wZXJhbmQgb2YgYSBcIiR7b3B9XCIgb3BlcmF0b3IgbXVzdCBiZSBhbiBhcnJheS5gO1xuY29uc3QgT1BFUkFORF9OT1RfQk9PTCA9IG9wID0+IGBUaGUgb3BlcmFuZCBvZiBhIFwiJHtvcH1cIiBvcGVyYXRvciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS5gO1xuY29uc3QgT1BFUkFORF9OT1RfU1RSSU5HID0gb3AgPT4gYFRoZSBvcGVyYW5kIG9mIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgYSBzdHJpbmcuYDtcblxuY29uc3QgVkFMVUVfTk9UX0NPTExFQ1RJT04gPSBvcCA9PiBgVGhlIHZhbHVlIHVzaW5nIGEgXCIke29wfVwiIG9wZXJhdG9yIG11c3QgYmUgZWl0aGVyIGFuIG9iamVjdCBvciBhbiBhcnJheS5gO1xuXG5jb25zdCBSRVFVSVJFX1JJR0hUX09QRVJBTkQgPSBvcCA9PiBgQmluYXJ5IHF1ZXJ5IG9wZXJhdG9yIFwiJHtvcH1cIiByZXF1aXJlcyB0aGUgcmlnaHQgb3BlcmFuZC5gXG5cbi8vQ29uZGl0aW9uIG9wZXJhdG9yXG5jb25zdCBPUF9FUVVBTCA9IFsgJyRlcScsICckZXFsJywgJyRlcXVhbCcgXTtcbmNvbnN0IE9QX05PVF9FUVVBTCA9IFsgJyRuZScsICckbmVxJywgJyRub3RFcXVhbCcgXTtcbmNvbnN0IE9QX05PVCA9IFsgJyRub3QnIF07XG5jb25zdCBPUF9HUkVBVEVSX1RIQU4gPSBbICckZ3QnLCAnJD4nLCAnJGdyZWF0ZXJUaGFuJyBdO1xuY29uc3QgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMID0gWyAnJGd0ZScsICckPD0nLCAnJGdyZWF0ZXJUaGFuT3JFcXVhbCcgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTiA9IFsgJyRsdCcsICckPCcsICckbGVzc1RoYW4nIF07XG5jb25zdCBPUF9MRVNTX1RIQU5fT1JfRVFVQUwgPSBbICckbHRlJywgJyQ8PScsICckbGVzc1RoYW5PckVxdWFsJyBdO1xuXG5jb25zdCBPUF9JTiA9IFsgJyRpbicgXTtcbmNvbnN0IE9QX05PVF9JTiA9IFsgJyRuaW4nLCAnJG5vdEluJyBdO1xuY29uc3QgT1BfRVhJU1RTID0gWyAnJGV4aXN0JywgJyRleGlzdHMnLCAnJG5vdE51bGwnIF07XG5jb25zdCBPUF9NQVRDSCA9IFsgJyRoYXMnLCAnJG1hdGNoJywgJyRhbGwnIF07XG5jb25zdCBPUF9NQVRDSF9BTlkgPSBbICckYW55JywgJyRvcicsICckZWl0aGVyJyBdO1xuY29uc3QgT1BfVFlQRSA9IFsgJyRpcycsICckdHlwZU9mJyBdO1xuY29uc3QgT1BfSEFTX0tFWVMgPSBbICckaGFzS2V5cycsICckd2l0aEtleXMnIF07XG5jb25zdCBPUF9TVEFSVF9XSVRIID0gWyAnJHN0YXJ0V2l0aCcsICckc3RhcnRzV2l0aCcgXTtcbmNvbnN0IE9QX0VORF9XSVRIID0gWyAnJGVuZFdpdGgnLCAnJGVuZHNXaXRoJyBdO1xuXG4vL1F1ZXJ5ICYgYWdncmVnYXRlIG9wZXJhdG9yXG5jb25zdCBPUF9TSVpFID0gWyAnJHNpemUnLCAnJGxlbmd0aCcsICckY291bnQnIF07XG5jb25zdCBPUF9TVU0gPSBbICckc3VtJywgJyR0b3RhbCcgXTtcbmNvbnN0IE9QX0tFWVMgPSBbICcka2V5cycgXTtcbmNvbnN0IE9QX1ZBTFVFUyA9IFsgJyR2YWx1ZXMnIF07XG5jb25zdCBPUF9HRVRfVFlQRSA9IFsgJyR0eXBlJyBdO1xuXG4vL01hbmlwdWxhdGUgb3BlcmF0aW9uXG5jb25zdCBPUF9BREQgPSBbICckYWRkJywgJyRwbHVzJywgICAgICckaW5jJyBdO1xuY29uc3QgT1BfU1VCID0gWyAnJHN1YicsICckc3VidHJhY3QnLCAnJG1pbnVzJywgJyRkZWMnIF07XG5jb25zdCBPUF9NVUwgPSBbICckbXVsJywgJyRtdWx0aXBseScsICAnJHRpbWVzJyBdO1xuY29uc3QgT1BfRElWID0gWyAnJGRpdicsICckZGl2aWRlJyBdO1xuY29uc3QgT1BfU0VUID0gWyAnJHNldCcsICckPScgXTtcbmNvbnN0IE9QX0FERF9JVEVNID0gWyAnJGFkZEl0ZW0nLCAnJG92ZXJyaWRlJyBdO1xuXG5jb25zdCBPUF9QSUNLID0gWyAnJHBpY2snIF07XG5jb25zdCBPUF9HRVRfQllfSU5ERVggPSBbICckYXQnLCAnJGdldEJ5SW5kZXgnLCAnJG50aCcgXTtcbmNvbnN0IE9QX0dFVF9CWV9LRVkgPSBbICckb2YnLCAnJGdldEJ5S2V5JyBdO1xuY29uc3QgT1BfT01JVCA9IFsgJyRvbWl0JyBdO1xuY29uc3QgT1BfR1JPVVAgPSBbICckZ3JvdXAnLCAnJGdyb3VwQnknIF07XG5jb25zdCBPUF9TT1JUID0gWyAnJHNvcnQnLCAnJG9yZGVyQnknLCAnJHNvcnRCeScgXTtcbmNvbnN0IE9QX1JFVkVSU0UgPSBbICckcmV2ZXJzZScgXTtcbmNvbnN0IE9QX0VWQUwgPSBbICckZXZhbCcsICckYXBwbHknIF07XG5jb25zdCBPUF9NRVJHRSA9IFsgJyRtZXJnZScgXTtcbmNvbnN0IE9QX0ZJTFRFUiA9IFsgJyRmaWx0ZXInLCAnJHNlbGVjdCcgXTtcblxuLy9Db25kaXRpb24gb3BlcmF0aW9uXG5jb25zdCBPUF9JRiA9IFsgJyRpZicgXTtcblxuY29uc3QgUEZYX0ZPUl9FQUNIID0gJ3w+JzsgLy8gZm9yIGVhY2hcbmNvbnN0IFBGWF9XSVRIX0FOWSA9ICd8Kic7IC8vIHdpdGggYW55XG5cbmNvbnN0IE1hcE9mT3BzID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkT3BUb01hcCA9ICh0b2tlbnMsIHRhZykgPT4gdG9rZW5zLmZvckVhY2godG9rZW4gPT4gTWFwT2ZPcHMuc2V0KHRva2VuLCB0YWcpKTtcbmFkZE9wVG9NYXAoT1BfRVFVQUwsICdPUF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1RfRVFVQUwsICdPUF9OT1RfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTk9ULCAnT1BfTk9UJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTiwgJ09QX0dSRUFURVJfVEhBTicpO1xuYWRkT3BUb01hcChPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwsICdPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOLCAnT1BfTEVTU19USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0xFU1NfVEhBTl9PUl9FUVVBTCwgJ09QX0xFU1NfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9JTiwgJ09QX0lOJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9JTiwgJ09QX05PVF9JTicpO1xuYWRkT3BUb01hcChPUF9FWElTVFMsICdPUF9FWElTVFMnKTtcbmFkZE9wVG9NYXAoT1BfTUFUQ0gsICdPUF9NQVRDSCcpO1xuYWRkT3BUb01hcChPUF9NQVRDSF9BTlksICdPUF9NQVRDSF9BTlknKTtcbmFkZE9wVG9NYXAoT1BfVFlQRSwgJ09QX1RZUEUnKTtcbmFkZE9wVG9NYXAoT1BfSEFTX0tFWVMsICdPUF9IQVNfS0VZUycpO1xuYWRkT3BUb01hcChPUF9TVEFSVF9XSVRILCAnT1BfU1RBUlRfV0lUSCcpO1xuYWRkT3BUb01hcChPUF9FTkRfV0lUSCwgJ09QX0VORF9XSVRIJyk7XG5cbmNvbnN0IE1hcE9mTWFucyA9IG5ldyBNYXAoKTtcbmNvbnN0IGFkZE1hblRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk1hbnMuc2V0KHRva2VuLCB0YWcpKTtcbi8vIFsgPG9wIG5hbWU+LCA8dW5hcnk+IF1cbmFkZE1hblRvTWFwKE9QX1NJWkUsIFsnT1BfU0laRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VNLCBbJ09QX1NVTScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfS0VZUywgWydPUF9LRVlTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9WQUxVRVMsIFsnT1BfVkFMVUVTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9HRVRfVFlQRSwgWydPUF9HRVRfVFlQRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfUkVWRVJTRSwgWydPUF9SRVZFUlNFJywgdHJ1ZV0pO1xuXG5hZGRNYW5Ub01hcChPUF9BREQsIFsnT1BfQUREJywgZmFsc2UgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VCLCBbJ09QX1NVQicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfTVVMLCBbJ09QX01VTCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfRElWLCBbJ09QX0RJVicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfU0VULCBbJ09QX1NFVCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfQUREX0lURU0sIFsnT1BfQUREX0lURU0nLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX1BJQ0ssIFsnT1BfUElDSycsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HRVRfQllfSU5ERVgsIFsnT1BfR0VUX0JZX0lOREVYJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9LRVksIFsnT1BfR0VUX0JZX0tFWScsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9PTUlULCBbJ09QX09NSVQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR1JPVVAsIFsnT1BfR1JPVVAnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfU09SVCwgWydPUF9TT1JUJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0VWQUwsIFsnT1BfRVZBTCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9NRVJHRSwgWydPUF9NRVJHRScsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9GSUxURVIsIFsnT1BfRklMVEVSJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0lGLCBbJ09QX0lGJywgZmFsc2VdKTtcblxuY29uc3QgZGVmYXVsdEplc0hhbmRsZXJzID0ge1xuICAgIE9QX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IF8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfTk9UX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+ICFfLmlzRXF1YWwobGVmdCwgcmlnaHQpLFxuICAgIE9QX05PVDogKGxlZnQsIC4uLmFyZ3MpID0+ICF0ZXN0KGxlZnQsICdPUF9NQVRDSCcsIC4uLmFyZ3MpLFxuICAgIE9QX0dSRUFURVJfVEhBTjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID4gcmlnaHQsXG4gICAgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPj0gcmlnaHQsXG4gICAgT1BfTEVTU19USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPCByaWdodCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8PSByaWdodCxcbiAgICBPUF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQuZmluZChlbGVtZW50ID0+IGRlZmF1bHRKZXNIYW5kbGVycy5PUF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9OT1RfSU46IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAocmlnaHQgPT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTk9UX0lOJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX05PVF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9FWElTVFM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9CT09MKCdPUF9FWElTVFMnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQgPyBsZWZ0ICE9IG51bGwgOiBsZWZ0ID09IG51bGw7XG4gICAgfSxcbiAgICBPUF9UWVBFOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX1RZUEUnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByaWdodCA9IHJpZ2h0LnRvTG93ZXJDYXNlKCk7XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAnYXJyYXknKSB7XG4gICAgICAgICAgICByZXR1cm4gQXJyYXkuaXNBcnJheShsZWZ0KTtcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdpbnRlZ2VyJykge1xuICAgICAgICAgICAgcmV0dXJuIF8uaXNJbnRlZ2VyKGxlZnQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gJ3N0cmluZyc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHlwZW9mIGxlZnQgPT09IHJpZ2h0O1xuICAgIH0sXG4gICAgT1BfTUFUQ0g6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgcnVsZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCk7XG4gICAgICAgIHJldHVybiByWzBdO1xuICAgIH0sXG4gICAgT1BfTUFUQ0hfQU5ZOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUFUQ0hfQU5ZJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCBydWxlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgfSk7ICAgXG4gICAgXG4gICAgICAgIHJldHVybiBmb3VuZCA/IHRydWUgOiBmYWxzZTtcbiAgICB9LFxuICAgIE9QX0hBU19LRVlTOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGtleSA9PiBoYXNLZXlCeVBhdGgobGVmdCwga2V5KSk7XG4gICAgfSxcbiAgICBPUF9TVEFSVF9XSVRIOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9TVEFSVF9XSVRIJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnQuc3RhcnRzV2l0aChyaWdodCk7XG4gICAgfSxcbiAgICBPUF9FTkRfV0lUSDogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfRU5EX1dJVEgnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdC5lbmRzV2l0aChyaWdodCk7XG4gICAgfSAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRNYW5pcHVsYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAobGVmdCkgPT4gXy5zaXplKGxlZnQpLFxuICAgIE9QX1NVTTogKGxlZnQpID0+IF8ucmVkdWNlKGxlZnQsIChzdW0sIGl0ZW0pID0+IHtcbiAgICAgICAgICAgIHN1bSArPSBpdGVtO1xuICAgICAgICAgICAgcmV0dXJuIHN1bTtcbiAgICAgICAgfSwgMCksXG5cbiAgICBPUF9LRVlTOiAobGVmdCkgPT4gXy5rZXlzKGxlZnQpLFxuICAgIE9QX1ZBTFVFUzogKGxlZnQpID0+IF8udmFsdWVzKGxlZnQpLCAgIFxuICAgIE9QX0dFVF9UWVBFOiAobGVmdCkgPT4gQXJyYXkuaXNBcnJheShsZWZ0KSA/ICdhcnJheScgOiAoXy5pc0ludGVnZXIobGVmdCkgPyAnaW50ZWdlcicgOiB0eXBlb2YgbGVmdCksICBcbiAgICBPUF9SRVZFUlNFOiAobGVmdCkgPT4gXy5yZXZlcnNlKGxlZnQpLFxuXG4gICAgLy9iaW5hcnlcbiAgICBPUF9BREQ6IChsZWZ0LCByaWdodCkgPT4gbGVmdCArIHJpZ2h0LFxuICAgIE9QX1NVQjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC0gcmlnaHQsXG4gICAgT1BfTVVMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgKiByaWdodCxcbiAgICBPUF9ESVY6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAvIHJpZ2h0LCBcbiAgICBPUF9TRVQ6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgsIGNvbnRleHQpID0+IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSksIFxuICAgIE9QX0FERF9JVEVNOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihWQUxVRV9OT1RfQ09MTEVDVElPTignT1BfQUREX0lURU0nKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnQuY29uY2F0KHJpZ2h0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkgfHwgcmlnaHQubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEUoJ09QX0FERF9JVEVNJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgLi4ubGVmdCwgW3JpZ2h0WzBdXTogZXZhbHVhdGVFeHByKGxlZnQsIHJpZ2h0WzFdLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0LCAkJFBBUkVOVDogY29udGV4dC4kJENVUlJFTlQsICQkQ1VSUkVOVDogbGVmdCB9KSB9O1xuICAgIH0sIFxuICAgIE9QX1BJQ0s6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKGxlZnQgPT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmlnaHQgPSBfLmNhc3RBcnJheShyaWdodCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnBpY2sobGVmdCwgcmlnaHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiBfLnBpY2tCeShsZWZ0LCAoeCwga2V5KSA9PiBtYXRjaChrZXksIHJpZ2h0LCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpWzBdKTtcbiAgICB9LFxuICAgIE9QX0dFVF9CWV9JTkRFWDogKGxlZnQsIHJpZ2h0KSA9PiBfLm50aChsZWZ0LCByaWdodCksXG4gICAgT1BfR0VUX0JZX0tFWTogKGxlZnQsIHJpZ2h0KSA9PiBfLmdldChsZWZ0LCByaWdodCksXG4gICAgT1BfT01JVDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAobGVmdCA9PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByaWdodCA9IF8uY2FzdEFycmF5KHJpZ2h0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgcmV0dXJuIF8ub21pdChsZWZ0LCByaWdodCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIF8ub21pdEJ5KGxlZnQsICh4LCBrZXkpID0+IG1hdGNoKGtleSwgcmlnaHQsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSlbMF0pO1xuICAgIH0sXG4gICAgT1BfR1JPVVA6IChsZWZ0LCByaWdodCkgPT4gXy5ncm91cEJ5KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9TT1JUOiAobGVmdCwgcmlnaHQpID0+IF8uc29ydEJ5KGxlZnQsIHJpZ2h0KSwgIFxuICAgIE9QX0VWQUw6IGV2YWx1YXRlRXhwcixcbiAgICBPUF9NRVJHRTogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX01FUkdFJykpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmlnaHQucmVkdWNlKChyZXN1bHQsIGV4cHIsIGtleSkgPT4gT2JqZWN0LmFzc2lnbihyZXN1bHQsIGV2YWx1YXRlRXhwcihsZWZ0LCBleHByLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCksIHsgLi4uY29udGV4dCB9KSksIHt9KTtcbiAgICB9LFxuICAgIE9QX0ZJTFRFUjogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCwgY29udGV4dCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoVkFMVUVfTk9UX0NPTExFQ1RJT04oJ09QX0ZJTFRFUicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBfLmZpbHRlcihsZWZ0LCAodmFsdWUsIGtleSkgPT4gdGVzdCh2YWx1ZSwgJ09QX01BVENIJywgY29uZGl0aW9uLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpKTtcbiAgICB9LFxuICAgIE9QX0lGOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4LCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfSUYnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQubGVuZ3RoIDwgMiB8fCByaWdodC5sZW5ndGggPiAzKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfVFVQTEVfMl9PUl8zKCdPUF9JRicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNvbmRpdGlvbiA9IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIHJpZ2h0WzBdLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKHRlc3QobGVmdCwgJ09QX01BVENIJywgY29uZGl0aW9uLCBqZXMsIHByZWZpeCkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMV0sIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIGlmIChyaWdodC5sZW5ndGggPiAyKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCByZXQgPSBldmFsdWF0ZUV4cHIobGVmdCwgcmlnaHRbMl0sIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdDtcbiAgICB9XG59XG5cbmNvbnN0IGZvcm1hdE5hbWUgPSAobmFtZSwgcHJlZml4KSA9PiB7XG4gICAgY29uc3QgZnVsbE5hbWUgPSBuYW1lID09IG51bGwgPyBwcmVmaXggOiBmb3JtYXRQcmVmaXgobmFtZSwgcHJlZml4KTtcbiAgICByZXR1cm4gZnVsbE5hbWUgPT0gbnVsbCA/IFwiVGhlIHZhbHVlXCIgOiAoZnVsbE5hbWUuaW5kZXhPZignKCcpICE9PSAtMSA/IGBUaGUgcXVlcnkgXCJfLiR7ZnVsbE5hbWV9XCJgIDogYFwiJHtmdWxsTmFtZX1cImApO1xufTtcbmNvbnN0IGZvcm1hdEtleSA9IChrZXksIGhhc1ByZWZpeCkgPT4gXy5pc0ludGVnZXIoa2V5KSA/IGBbJHtrZXl9XWAgOiAoaGFzUHJlZml4ID8gJy4nICsga2V5IDoga2V5KTtcbmNvbnN0IGZvcm1hdFByZWZpeCA9IChrZXksIHByZWZpeCkgPT4gcHJlZml4ICE9IG51bGwgPyBgJHtwcmVmaXh9JHtmb3JtYXRLZXkoa2V5LCB0cnVlKX1gIDogZm9ybWF0S2V5KGtleSwgZmFsc2UpO1xuY29uc3QgZm9ybWF0UXVlcnkgPSAob3BNZXRhKSA9PiBgJHtkZWZhdWx0UXVlcnlFeHBsYW5hdGlvbnNbb3BNZXRhWzBdXX0oJHtvcE1ldGFbMV0gPyAnJyA6ICc/J30pYDsgIFxuY29uc3QgZm9ybWF0TWFwID0gKG5hbWUpID0+IGBlYWNoKC0+JHtuYW1lfSlgO1xuY29uc3QgZm9ybWF0QW55ID0gKG5hbWUpID0+IGBhbnkoLT4ke25hbWV9KWA7XG5cbmNvbnN0IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMgPSB7XG4gICAgT1BfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBtYXRjaCAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9HUkVBVEVSX1RIQU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiBvciBlcXVhbCB0byAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlIGFueSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9FWElTVFM6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCR7cmlnaHQgPyAnIG5vdCAnOiAnICd9YmUgTlVMTC5gLCAgICBcbiAgICBPUF9UWVBFOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYFRoZSB0eXBlIG9mICR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgXCIke3JpZ2h0fVwiLCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgICAgIFxuICAgIE9QX01BVENIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfTUFUQ0hfQU5ZOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggYW55IG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX0hBU19LRVlTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgaGF2ZSBhbGwgb2YgdGhlc2Uga2V5cyBbJHtyaWdodC5qb2luKCcsICcpfV0uYCwgICAgICAgIFxuICAgIE9QX1NUQVJUX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBzdGFydCB3aXRoIFwiJHtyaWdodH1cIi5gLCAgICAgICAgXG4gICAgT1BfRU5EX1dJVEg6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBlbmQgd2l0aCBcIiR7cmlnaHR9XCIuYCwgICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAnc2l6ZScsXG4gICAgT1BfU1VNOiAnc3VtJyxcbiAgICBPUF9LRVlTOiAna2V5cycsXG4gICAgT1BfVkFMVUVTOiAndmFsdWVzJywgICAgXG4gICAgT1BfR0VUX1RZUEU6ICdnZXQgdHlwZScsXG4gICAgT1BfUkVWRVJTRTogJ3JldmVyc2UnLCBcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAnYWRkJyxcbiAgICBPUF9TVUI6ICdzdWJ0cmFjdCcsXG4gICAgT1BfTVVMOiAnbXVsdGlwbHknLFxuICAgIE9QX0RJVjogJ2RpdmlkZScsIFxuICAgIE9QX1NFVDogJ2Fzc2lnbicsXG4gICAgT1BfQUREX0lURU06ICdhZGRJdGVtJyxcbiAgICBPUF9QSUNLOiAncGljaycsXG4gICAgT1BfR0VUX0JZX0lOREVYOiAnZ2V0IGVsZW1lbnQgYXQgaW5kZXgnLFxuICAgIE9QX0dFVF9CWV9LRVk6ICdnZXQgZWxlbWVudCBvZiBrZXknLFxuICAgIE9QX09NSVQ6ICdvbWl0JyxcbiAgICBPUF9HUk9VUDogJ2dyb3VwQnknLFxuICAgIE9QX1NPUlQ6ICdzb3J0QnknLFxuICAgIE9QX0VWQUw6ICdldmFsdWF0ZScsXG4gICAgT1BfTUVSR0U6ICdtZXJnZScsXG4gICAgT1BfRklMVEVSOiAnZmlsdGVyJyxcbiAgICBPUF9JRjogJ2V2YWx1YXRlIGlmJ1xufTtcblxuZnVuY3Rpb24gZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbmFtZSwgbGVmdFZhbHVlLCByaWdodFZhbHVlLCBwcmVmaXgpIHtcbiAgICBjb25zdCBnZXR0ZXIgPSBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnNbb3BdIHx8IGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9NQVRDSDtcbiAgICByZXR1cm4gZ2V0dGVyKG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KTsgICAgXG59XG5cbmZ1bmN0aW9uIHRlc3QodmFsdWUsIG9wLCBvcFZhbHVlLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLm9wZXJhdG9ySGFuZGxlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfSEFOTERFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlKHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5xdWVyeUhhbmxkZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9IQU5ETEVSKG9wKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGhhbmRsZXIodmFsdWUsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXZhbHVhdGVVbmFyeSh2YWx1ZSwgb3AsIGplcywgcHJlZml4KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCByaWdodFZhbHVlLCBvcE1ldGEsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgaWYgKG9wTWV0YVsxXSkge1xuICAgICAgICByZXR1cm4gcmlnaHRWYWx1ZSA/IGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KSA6IGN1cnJlbnRWYWx1ZTtcbiAgICB9IFxuICAgIFxuICAgIHJldHVybiBldmFsdWF0ZShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgcmlnaHRWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xufVxuXG5jb25zdCBkZWZhdWx0Q3VzdG9taXplciA9IHtcbiAgICBtYXBPZk9wZXJhdG9yczogTWFwT2ZPcHMsXG4gICAgbWFwT2ZNYW5pcHVsYXRvcnM6IE1hcE9mTWFucyxcbiAgICBvcGVyYXRvckhhbmRsZXJzOiBkZWZhdWx0SmVzSGFuZGxlcnMsXG4gICAgb3BlcmF0b3JFeHBsYW5hdGlvbnM6IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMsXG4gICAgcXVlcnlIYW5sZGVyczogZGVmYXVsdE1hbmlwdWxhdGlvbnNcbn07XG5cbmZ1bmN0aW9uIG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBvcGVyYW5kcywgamVzLCBwcmVmaXgpIHtcbiAgICBsZXQgbWF0Y2hSZXN1bHQsIG5leHRQcmVmaXg7XG5cbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IG1hcFJlc3VsdCA9IF8uaXNQbGFpbk9iamVjdChhY3R1YWwpID8gXy5tYXBWYWx1ZXMoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSkpIDogXy5tYXAoYWN0dWFsLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChpLCBwcmVmaXgpKSk7XG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdE1hcChmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gbWF0Y2gobWFwUmVzdWx0LCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgICBcbiAgICAgICAgICAgIG5leHRQcmVmaXggPSBmb3JtYXRQcmVmaXgoZm9ybWF0QW55KGZvcm1hdFF1ZXJ5KG9wTWV0YSkpLCBwcmVmaXgpO1xuICAgICAgICAgICAgbWF0Y2hSZXN1bHQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBtYXRjaChldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSksIG9wZXJhbmRzWzFdLCBqZXMsIG5leHRQcmVmaXgpKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpIHtcbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IHVubWF0Y2hlZEtleSA9IF8uZmluZEluZGV4KGFjdHVhbCwgKGl0ZW0pID0+ICF0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgICAgIGlmICh1bm1hdGNoZWRLZXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgdW5tYXRjaGVkS2V5LCBhY3R1YWxbdW5tYXRjaGVkS2V5XSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZWQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiB0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgXG4gICAgICAgICAgICBpZiAoIW1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY3VycmVudFZhbHVlLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSwgeyAuLi5jb250ZXh0LCAkJFBBUkVOVDogY3VycmVudFZhbHVlLCAkJENVUlJFTlQ6IGl0ZW0gfSkpO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgIFxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFBSWF9PUF9OT1RfRk9SX0VWQUwoY29sbGVjdGlvbk9wKSk7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0NPTExFQ1RJT05fT1AoY29sbGVjdGlvbk9wKSk7XG4gICAgfVxufVxuXG4vKipcbiAqIFxuICogQHBhcmFtIHsqfSBhY3R1YWwgXG4gKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IHByZWZpeCAgXG4gKiBcbiAqIHsga2V5OiB7ICRtYXRjaCB9IH1cbiAqL1xuZnVuY3Rpb24gbWF0Y2goYWN0dWFsLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGxldCBwYXNzT2JqZWN0Q2hlY2sgPSBmYWxzZTtcblxuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGV4cGVjdGVkKSkge1xuICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCAnT1BfRVFVQUwnLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChudWxsLCBhY3R1YWwsIGV4cGVjdGVkLCBwcmVmaXgpICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gW3RydWVdO1xuICAgIH1cblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHBlY3RlZCkge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwZWN0ZWRbZmllbGROYW1lXTsgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgIFxuICAgICAgICAgICAgaWYgKGwgPiA0ICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVszXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEZpZWxkVmFsdWUpICYmIGV4cGVjdGVkRmllbGRWYWx1ZS5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9UVVBMRSgpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigzKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAobCA+IDIgJiYgZmllbGROYW1lWzFdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigxKTtcblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5PVF9BX1VOQVJZX1FVRVJZKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gZXZhbHVhdGVVbmFyeShhY3R1YWwsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2gocXVlcnlSZXN1bHQsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZm9ybWF0UXVlcnkob3BNZXRhKSwgcHJlZml4KSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaFJlc3VsdFswXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yXG4gICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWwsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBnZXRVbm1hdGNoZWRFeHBsYW5hdGlvbihqZXMsIG9wLCBudWxsLCBhY3R1YWwsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoIXBhc3NPYmplY3RDaGVjaykge1xuICAgICAgICAgICAgaWYgKGFjdHVhbCA9PSBudWxsKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVhJU1RTKG51bGwsIG51bGwsIHRydWUsIHByZWZpeClcbiAgICAgICAgICAgIF07IFxuXG4gICAgICAgICAgICBjb25zdCBhY3R1YWxUeXBlID0gdHlwZW9mIGFjdHVhbDtcbiAgICBcbiAgICAgICAgICAgIGlmIChhY3R1YWxUeXBlICE9PSAnb2JqZWN0JykgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfVFlQRShudWxsLCBhY3R1YWxUeXBlLCAnb2JqZWN0JywgcHJlZml4KVxuICAgICAgICAgICAgXTsgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHBhc3NPYmplY3RDaGVjayA9IHRydWU7XG5cbiAgICAgICAgbGV0IGFjdHVhbEZpZWxkVmFsdWUgPSBfLmdldChhY3R1YWwsIGZpZWxkTmFtZSk7ICAgICBcbiAgICAgICAgXG4gICAgICAgIGlmIChleHBlY3RlZEZpZWxkVmFsdWUgIT0gbnVsbCAmJiB0eXBlb2YgZXhwZWN0ZWRGaWVsZFZhbHVlID09PSAnb2JqZWN0JykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgWyBvaywgcmVhc29uIF0gPSBtYXRjaChhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZpZWxkTmFtZSwgcHJlZml4KSk7XG4gICAgICAgICAgICBpZiAoIW9rKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFsgZmFsc2UsIHJlYXNvbiBdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbEZpZWxkVmFsdWUsICdPUF9FUVVBTCcsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChmaWVsZE5hbWUsIGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIFt0cnVlXTtcbn1cblxuLyoqXG4gKiBJZiAkIG9wZXJhdG9yIHVzZWQsIG9ubHkgb25lIGEgdGltZSBpcyBhbGxvd2VkXG4gKiBlLmcuXG4gKiB7XG4gKiAgICAkZ3JvdXBCeTogJ2tleSdcbiAqIH1cbiAqIFxuICogXG4gKiBAcGFyYW0geyp9IGN1cnJlbnRWYWx1ZSBcbiAqIEBwYXJhbSB7Kn0gZXhwciBcbiAqIEBwYXJhbSB7Kn0gcHJlZml4IFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IGNvbnRleHRcbiAqL1xuZnVuY3Rpb24gZXZhbHVhdGVFeHByKGN1cnJlbnRWYWx1ZSwgZXhwciwgamVzLCBwcmVmaXgsIGNvbnRleHQsIHNldE9wKSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShleHByKSkge1xuICAgICAgICBpZiAoc2V0T3ApIHtcbiAgICAgICAgICAgIHJldHVybiBleHByLm1hcChpdGVtID0+IGV2YWx1YXRlRXhwcih1bmRlZmluZWQsIGl0ZW0sIGplcywgcHJlZml4LCB7IC4uLmNvbnRleHQgfSwgdHJ1ZSkpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZXhwci5yZWR1Y2UoKHJlc3VsdCwgZXhwckl0ZW0pID0+IGV2YWx1YXRlRXhwcihyZXN1bHQsIGV4cHJJdGVtLCBqZXMsIHByZWZpeCwgeyAuLi5jb250ZXh0IH0pLCBjdXJyZW50VmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGVFeHByID0gdHlwZW9mIGV4cHI7XG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIGlmIChzZXRPcCkgcmV0dXJuIGV4cHI7XG4gICAgICAgIHJldHVybiBleHByID8gY3VycmVudFZhbHVlIDogdW5kZWZpbmVkO1xuICAgIH0gICAgXG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwibnVtYmVyXCIgfHwgdHlwZUV4cHIgPT09IFwiYmlnaW50XCIpIHtcbiAgICAgICAgaWYgKHNldE9wKSByZXR1cm4gZXhwcjtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9FWFBSX1NZTlRBWCk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVFeHByID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoZXhwci5zdGFydHNXaXRoKCckJCcpKSB7XG4gICAgICAgICAgICAvL2dldCBmcm9tIGNvbnRleHRcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IGV4cHIuaW5kZXhPZignLicpO1xuICAgICAgICAgICAgaWYgKHBvcyA9PT0gLTEpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbnRleHRbZXhwcl07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLmdldChjb250ZXh0W2V4cHIuc3Vic3RyKDAsIHBvcyldLCBleHByLnN1YnN0cihwb3MrMSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNldE9wKSB7XG4gICAgICAgICAgICByZXR1cm4gZXhwcjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZXhwcik7XG4gICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFJFUVVJUkVfUklHSFRfT1BFUkFORChleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZXZhbHVhdGVVbmFyeShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpO1xuICAgIH0gXG5cbiAgICBpZiAodHlwZUV4cHIgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfRVhQUl9TWU5UQVgpO1xuICAgIH1cblxuICAgIGlmIChzZXRPcCkge1xuICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXMoZXhwciwgaXRlbSA9PiBldmFsdWF0ZUV4cHIodW5kZWZpbmVkLCBpdGVtLCBqZXMsIHByZWZpeCwgY29udGV4dCwgdHJ1ZSkpO1xuICAgIH1cblxuICAgIGlmIChjb250ZXh0ID09IG51bGwpIHsgXG4gICAgICAgIGNvbnRleHQgPSB7ICQkUk9PVDogY3VycmVudFZhbHVlLCAkJFBBUkVOVDogbnVsbCwgJCRDVVJSRU5UOiBjdXJyZW50VmFsdWUgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBsZXQgcmVzdWx0LCBoYXNPcGVyYXRvciA9IGZhbHNlOyAgICBcblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHByKSB7XG4gICAgICAgIGxldCBleHBlY3RlZEZpZWxkVmFsdWUgPSBleHByW2ZpZWxkTmFtZV07ICBcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGwgPSBmaWVsZE5hbWUubGVuZ3RoO1xuXG4gICAgICAgIGlmIChsID4gMSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVCeU9wTWV0YShjdXJyZW50VmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobCA+IDMgJiYgZmllbGROYW1lWzBdID09PSAnfCcgJiYgZmllbGROYW1lWzJdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb21wbGV5S2V5ID0gZmllbGROYW1lLmluZGV4T2YoJy4nKSAhPT0gLTE7XG5cbiAgICAgICAgLy9waWNrIGEgZmllbGQgYW5kIHRoZW4gYXBwbHkgbWFuaXB1bGF0aW9uXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gY3VycmVudFZhbHVlICE9IG51bGwgPyAoY29tcGxleUtleSA/IF8uZ2V0KGN1cnJlbnRWYWx1ZSwgZmllbGROYW1lKSA6IGN1cnJlbnRWYWx1ZVtmaWVsZE5hbWVdKSA6IHVuZGVmaW5lZDsgICAgICAgICBcblxuICAgICAgICBjb25zdCBjaGlsZEZpZWxkVmFsdWUgPSBldmFsdWF0ZUV4cHIoYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCksIGNvbnRleHQpO1xuXG4gICAgICAgIGlmICh0eXBlb2YgY2hpbGRGaWVsZFZhbHVlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgcmVzdWx0ID09IG51bGwgJiYgKHJlc3VsdCA9IHt9KTtcbiAgICAgICAgICAgIGlmIChjb21wbGV5S2V5KSB7XG4gICAgICAgICAgICAgICAgXy5zZXQocmVzdWx0LCBmaWVsZE5hbWUsIGNoaWxkRmllbGRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJlc3VsdFtmaWVsZE5hbWVdID0gY2hpbGRGaWVsZFZhbHVlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5jbGFzcyBKRVMge1xuICAgIGNvbnN0cnVjdG9yKHZhbHVlLCBjdXN0b21pemVyKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgdGhpcy5jdXN0b21pemVyID0gY3VzdG9taXplcjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICAgICAqIEBwYXJhbSAgey4uLmFueX0gYXJncyBcbiAgICAgKi9cbiAgICBtYXRjaChleHBlY3RlZCkgeyAgICAgICAgXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IG1hdGNoKHRoaXMudmFsdWUsIGV4cGVjdGVkLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgICAgICBpZiAocmVzdWx0WzBdKSByZXR1cm4gdGhpcztcblxuICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKHJlc3VsdFsxXSwge1xuICAgICAgICAgICAgYWN0dWFsOiB0aGlzLnZhbHVlLFxuICAgICAgICAgICAgZXhwZWN0ZWRcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZXZhbHVhdGUoZXhwcikge1xuICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgfVxuXG4gICAgdXBkYXRlKGV4cHIpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBldmFsdWF0ZUV4cHIodGhpcy52YWx1ZSwgZXhwciwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG59XG5cbkpFUy5tYXRjaCA9IG1hdGNoO1xuSkVTLmV2YWx1YXRlID0gZXZhbHVhdGVFeHByO1xuSkVTLmRlZmF1bHRDdXN0b21pemVyID0gZGVmYXVsdEN1c3RvbWl6ZXI7XG5cbm1vZHVsZS5leHBvcnRzID0gSkVTOyJdfQ==
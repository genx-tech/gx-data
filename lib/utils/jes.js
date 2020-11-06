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

const INVALID_QUERY_OPERATOR = token => `Invalid JES query operator "${token}".`;

const INVALID_TEST_OPERATOR = token => `Invalid JES test operator "${token}".`;

const INVALID_QUERY_HANDLER = op => `JES query operator "${op}" handler not found.`;

const INVALID_TEST_HANLDER = op => `JES test operator "${op}" handler not found.`;

const NOT_A_TWO_TUPLE = 'The value of collection operator should be a two-tuple.';
const NOT_A_UNARY_QUERY = 'Only unary query operator is allowed to be used directly in a matching.';

const INVALID_COLLECTION_OP = op => `Invalid collection operator "${op}".`;

const PRX_OP_NOT_FOR_EVAL = prefix => `Operator prefix "${prefix}" cannot be used in evaluation.`;

const OPERAND_NOT_ARRAY = op => `The right operand of JES operator "${op}" should be an array.`;

const OPERAND_NOT_BOOL = op => `The right operand of JES operator "${op}" should be a boolean value.`;

const OPERAND_NOT_STRING = op => `The right operand of JES operator "${op}" should be a string.`;

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
const OP_EXISTS = ['$exist', '$exists'];
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
const OP_PICK = ['$pick'];
const OP_GET_BY_INDEX = ['$at', '$getByIndex', '$nth'];
const OP_GET_BY_KEY = ['$of', '$getByKey'];
const OP_OMIT = ['$omit'];
const OP_GROUP = ['$group', '$groupBy'];
const OP_SORT = ['$sort', '$orderBy', '$sortBy'];
const OP_REVERSE = ['$reverse'];
const OP_EVAL = ['$eval', '$apply'];
const OP_MERGE = ['$merge'];
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
addManToMap(OP_PICK, ['OP_PICK', false]);
addManToMap(OP_GET_BY_INDEX, ['OP_GET_BY_INDEX', false]);
addManToMap(OP_GET_BY_KEY, ['OP_GET_BY_KEY', false]);
addManToMap(OP_OMIT, ['OP_OMIT', false]);
addManToMap(OP_GROUP, ['OP_GROUP', false]);
addManToMap(OP_SORT, ['OP_SORT', false]);
addManToMap(OP_EVAL, ['OP_EVAL', false]);
addManToMap(OP_MERGE, ['OP_MERGE', false]);
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
  OP_SET: (left, right) => right,
  OP_PICK: (left, right, jes, prefix) => {
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
  OP_OMIT: (left, right) => _.omit(left, right),
  OP_GROUP: (left, right) => _.groupBy(left, right),
  OP_SORT: (left, right) => _.sortBy(left, right),
  OP_EVAL: evaluateExpr,
  OP_MERGE: (left, right, ...args) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_MERGE'));
    }

    return right.reduce((result, expr) => Object.assign(result, evaluateExpr(left, expr, ...args)), {});
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
  OP_PICK: 'pick',
  OP_GET_BY_INDEX: 'get element at index',
  OP_GET_BY_KEY: 'get element of key',
  OP_OMIT: 'omit',
  OP_GROUP: 'groupBy',
  OP_SORT: 'sortBy',
  OP_EVAL: 'evaluate',
  OP_MERGE: 'merge'
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
      return _.map(currentValue, (item, i) => evaluateByOpMeta(item, expectedFieldValue, opMeta, jes, formatPrefix(i, prefix), context));

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
            throw new Error(NOT_A_TWO_TUPLE);
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

function evaluateExpr(currentValue, expr, jes, prefix, context) {
  jes != null || (jes = defaultCustomizer);

  if (Array.isArray(expr)) {
    return expr.reduce((result, exprItem) => evaluateExpr(result, exprItem, jes, prefix, context), currentValue);
  }

  const typeExpr = typeof expr;

  if (typeExpr === "boolean") {
    return expr ? currentValue : undefined;
  }

  if (typeExpr === 'string') {
    if (expr.startsWith('$$')) {
      const pos = expr.indexOf('.');

      if (pos === -1) {
        return context[expr];
      }

      return _.get(context[expr.substr(0, pos)], expr.substr(pos + 1));
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

  if (context == null) {
    context = {
      $$ROOT: currentValue,
      $$PARENT: null,
      $$CURRENT: currentValue
    };
  } else {
    context = { ...context,
      $$PARENT: context.$$CURRENT,
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

        result = evaluateCollection(currentValue, collectionOp, opMeta, expectedFieldValue, jes, prefix);
        hasOperator = true;
        continue;
      }
    }

    if (hasOperator) {
      throw new Error(OPERATOR_NOT_ALONE);
    }

    let actualFieldValue = currentValue != null ? _.get(currentValue, fieldName) : undefined;
    const childFieldValue = evaluateExpr(actualFieldValue, expectedFieldValue, jes, formatPrefix(fieldName, prefix), context);

    if (typeof childFieldValue !== 'undefined') {
      result = { ...result,
        [fieldName]: childFieldValue
      };
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiTk9UX0FfVFdPX1RVUExFIiwiTk9UX0FfVU5BUllfUVVFUlkiLCJJTlZBTElEX0NPTExFQ1RJT05fT1AiLCJQUlhfT1BfTk9UX0ZPUl9FVkFMIiwicHJlZml4IiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiUkVRVUlSRV9SSUdIVF9PUEVSQU5EIiwiT1BfRVFVQUwiLCJPUF9OT1RfRVFVQUwiLCJPUF9OT1QiLCJPUF9HUkVBVEVSX1RIQU4iLCJPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwiLCJPUF9MRVNTX1RIQU4iLCJPUF9MRVNTX1RIQU5fT1JfRVFVQUwiLCJPUF9JTiIsIk9QX05PVF9JTiIsIk9QX0VYSVNUUyIsIk9QX01BVENIIiwiT1BfTUFUQ0hfQU5ZIiwiT1BfVFlQRSIsIk9QX0hBU19LRVlTIiwiT1BfU1RBUlRfV0lUSCIsIk9QX0VORF9XSVRIIiwiT1BfU0laRSIsIk9QX1NVTSIsIk9QX0tFWVMiLCJPUF9WQUxVRVMiLCJPUF9HRVRfVFlQRSIsIk9QX0FERCIsIk9QX1NVQiIsIk9QX01VTCIsIk9QX0RJViIsIk9QX1NFVCIsIk9QX1BJQ0siLCJPUF9HRVRfQllfSU5ERVgiLCJPUF9HRVRfQllfS0VZIiwiT1BfT01JVCIsIk9QX0dST1VQIiwiT1BfU09SVCIsIk9QX1JFVkVSU0UiLCJPUF9FVkFMIiwiT1BfTUVSR0UiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiYXJncyIsInRlc3QiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImZpbmQiLCJlbGVtZW50IiwiZXZlcnkiLCJ0b0xvd2VyQ2FzZSIsImlzSW50ZWdlciIsImplcyIsInJ1bGUiLCJyIiwibWF0Y2giLCJmb3VuZCIsImtleSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImRlZmF1bHRNYW5pcHVsYXRpb25zIiwic2l6ZSIsInJlZHVjZSIsInN1bSIsIml0ZW0iLCJrZXlzIiwidmFsdWVzIiwicmV2ZXJzZSIsImNhc3RBcnJheSIsInBpY2siLCJwaWNrQnkiLCJ4IiwibnRoIiwiZ2V0Iiwib21pdCIsImdyb3VwQnkiLCJzb3J0QnkiLCJldmFsdWF0ZUV4cHIiLCJyZXN1bHQiLCJleHByIiwiT2JqZWN0IiwiYXNzaWduIiwiZm9ybWF0TmFtZSIsIm5hbWUiLCJmdWxsTmFtZSIsImZvcm1hdFByZWZpeCIsImluZGV4T2YiLCJmb3JtYXRLZXkiLCJoYXNQcmVmaXgiLCJmb3JtYXRRdWVyeSIsIm9wTWV0YSIsImRlZmF1bHRRdWVyeUV4cGxhbmF0aW9ucyIsImZvcm1hdE1hcCIsImZvcm1hdEFueSIsImRlZmF1bHRKZXNFeHBsYW5hdGlvbnMiLCJKU09OIiwic3RyaW5naWZ5Iiwiam9pbiIsImdldFVubWF0Y2hlZEV4cGxhbmF0aW9uIiwibGVmdFZhbHVlIiwicmlnaHRWYWx1ZSIsImdldHRlciIsIm9wZXJhdG9yRXhwbGFuYXRpb25zIiwidmFsdWUiLCJvcFZhbHVlIiwiaGFuZGxlciIsIm9wZXJhdG9ySGFuZGxlcnMiLCJldmFsdWF0ZSIsImNvbnRleHQiLCJxdWVyeUhhbmxkZXJzIiwiZXZhbHVhdGVVbmFyeSIsImV2YWx1YXRlQnlPcE1ldGEiLCJjdXJyZW50VmFsdWUiLCJkZWZhdWx0Q3VzdG9taXplciIsIm1hcE9mT3BlcmF0b3JzIiwibWFwT2ZNYW5pcHVsYXRvcnMiLCJtYXRjaENvbGxlY3Rpb24iLCJhY3R1YWwiLCJjb2xsZWN0aW9uT3AiLCJvcGVyYW5kcyIsIm1hdGNoUmVzdWx0IiwibmV4dFByZWZpeCIsIm1hcFJlc3VsdCIsImlzUGxhaW5PYmplY3QiLCJtYXBWYWx1ZXMiLCJtYXAiLCJpIiwidW5kZWZpbmVkIiwidmFsaWRhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWRGaWVsZFZhbHVlIiwidW5tYXRjaGVkS2V5IiwiZmluZEluZGV4IiwibWF0Y2hlZCIsImV2YWx1YXRlQ29sbGVjdGlvbiIsImV4cGVjdGVkIiwicGFzc09iamVjdENoZWNrIiwiZmllbGROYW1lIiwibCIsImxlbmd0aCIsInN1YnN0ciIsInF1ZXJ5UmVzdWx0IiwiYWN0dWFsVHlwZSIsImFjdHVhbEZpZWxkVmFsdWUiLCJvayIsInJlYXNvbiIsImV4cHJJdGVtIiwidHlwZUV4cHIiLCJwb3MiLCIkJFJPT1QiLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImhhc09wZXJhdG9yIiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFrQixHQUFHLG1EQUEzQjs7QUFDQSxNQUFNQyxzQkFBc0IsR0FBR0MsS0FBSyxJQUFLLCtCQUE4QkEsS0FBTSxJQUE3RTs7QUFDQSxNQUFNQyxxQkFBcUIsR0FBR0QsS0FBSyxJQUFLLDhCQUE2QkEsS0FBTSxJQUEzRTs7QUFDQSxNQUFNRSxxQkFBcUIsR0FBR0MsRUFBRSxJQUFLLHVCQUFzQkEsRUFBRyxzQkFB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QUFLLENBQUMsS0FBS2dELEtBQU4sRUFBYStCLFFBQWIsRUFBdUIsS0FBS3FCLFVBQTVCLENBQXBCO0FBQ0EsUUFBSTdFLE1BQU0sQ0FBQyxDQUFELENBQVYsRUFBZSxPQUFPLElBQVA7QUFFZixVQUFNLElBQUl2RyxlQUFKLENBQW9CdUcsTUFBTSxDQUFDLENBQUQsQ0FBMUIsRUFBK0I7QUFDakN1QyxNQUFBQSxNQUFNLEVBQUUsS0FBS2QsS0FEb0I7QUFFakMrQixNQUFBQTtBQUZpQyxLQUEvQixDQUFOO0FBSUg7O0FBRUQzQixFQUFBQSxRQUFRLENBQUM1QixJQUFELEVBQU87QUFDWCxXQUFPRixZQUFZLENBQUMsS0FBSzBCLEtBQU4sRUFBYXhCLElBQWIsRUFBbUIsS0FBSzRFLFVBQXhCLENBQW5CO0FBQ0g7O0FBRURDLEVBQUFBLE1BQU0sQ0FBQzdFLElBQUQsRUFBTztBQUNULFVBQU13QixLQUFLLEdBQUcxQixZQUFZLENBQUMsS0FBSzBCLEtBQU4sRUFBYXhCLElBQWIsRUFBbUIsS0FBSzRFLFVBQXhCLENBQTFCO0FBQ0EsU0FBS3BELEtBQUwsR0FBYUEsS0FBYjtBQUNBLFdBQU8sSUFBUDtBQUNIOztBQTdCSzs7QUFnQ1ZrRCxHQUFHLENBQUNsRyxLQUFKLEdBQVlBLEtBQVo7QUFDQWtHLEdBQUcsQ0FBQzlDLFFBQUosR0FBZTlCLFlBQWY7QUFDQTRFLEdBQUcsQ0FBQ3hDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQTRDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHt0b2tlbn1cIi5gO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9IQU5ETEVSID0gb3AgPT4gYEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9IQU5MREVSID0gb3AgPT4gYEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHtvcH1cIiBoYW5kbGVyIG5vdCBmb3VuZC5gO1xuY29uc3QgTk9UX0FfVFdPX1RVUExFID0gJ1RoZSB2YWx1ZSBvZiBjb2xsZWN0aW9uIG9wZXJhdG9yIHNob3VsZCBiZSBhIHR3by10dXBsZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfQVJSQVkgPSBvcCA9PiBgVGhlIHJpZ2h0IG9wZXJhbmQgb2YgSkVTIG9wZXJhdG9yIFwiJHtvcH1cIiBzaG91bGQgYmUgYW4gYXJyYXkuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX0JPT0w9IG9wID0+IGBUaGUgcmlnaHQgb3BlcmFuZCBvZiBKRVMgb3BlcmF0b3IgXCIke29wfVwiIHNob3VsZCBiZSBhIGJvb2xlYW4gdmFsdWUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1NUUklORz0gb3AgPT4gYFRoZSByaWdodCBvcGVyYW5kIG9mIEpFUyBvcGVyYXRvciBcIiR7b3B9XCIgc2hvdWxkIGJlIGEgc3RyaW5nLmA7XG5cbmNvbnN0IFJFUVVJUkVfUklHSFRfT1BFUkFORCA9IG9wID0+IGBCaW5hcnkgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIHJlcXVpcmVzIHRoZSByaWdodCBvcGVyYW5kLmBcblxuLy9Db25kaXRpb24gb3BlcmF0b3JcbmNvbnN0IE9QX0VRVUFMID0gWyAnJGVxJywgJyRlcWwnLCAnJGVxdWFsJyBdO1xuY29uc3QgT1BfTk9UX0VRVUFMID0gWyAnJG5lJywgJyRuZXEnLCAnJG5vdEVxdWFsJyBdO1xuY29uc3QgT1BfTk9UID0gWyAnJG5vdCcgXTtcbmNvbnN0IE9QX0dSRUFURVJfVEhBTiA9IFsgJyRndCcsICckPicsICckZ3JlYXRlclRoYW4nIF07XG5jb25zdCBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwgPSBbICckZ3RlJywgJyQ8PScsICckZ3JlYXRlclRoYW5PckVxdWFsJyBdO1xuY29uc3QgT1BfTEVTU19USEFOID0gWyAnJGx0JywgJyQ8JywgJyRsZXNzVGhhbicgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTl9PUl9FUVVBTCA9IFsgJyRsdGUnLCAnJDw9JywgJyRsZXNzVGhhbk9yRXF1YWwnIF07XG5cbmNvbnN0IE9QX0lOID0gWyAnJGluJyBdO1xuY29uc3QgT1BfTk9UX0lOID0gWyAnJG5pbicsICckbm90SW4nIF07XG5jb25zdCBPUF9FWElTVFMgPSBbICckZXhpc3QnLCAnJGV4aXN0cycgXTtcbmNvbnN0IE9QX01BVENIID0gWyAnJGhhcycsICckbWF0Y2gnLCAnJGFsbCcgXTtcbmNvbnN0IE9QX01BVENIX0FOWSA9IFsgJyRhbnknLCAnJG9yJywgJyRlaXRoZXInIF07XG5jb25zdCBPUF9UWVBFID0gWyAnJGlzJywgJyR0eXBlT2YnIF07XG5jb25zdCBPUF9IQVNfS0VZUyA9IFsgJyRoYXNLZXlzJywgJyR3aXRoS2V5cycgXTtcbmNvbnN0IE9QX1NUQVJUX1dJVEggPSBbICckc3RhcnRXaXRoJywgJyRzdGFydHNXaXRoJyBdO1xuY29uc3QgT1BfRU5EX1dJVEggPSBbICckZW5kV2l0aCcsICckZW5kc1dpdGgnIF07XG5cbi8vUXVlcnkgJiBhZ2dyZWdhdGUgb3BlcmF0b3JcbmNvbnN0IE9QX1NJWkUgPSBbICckc2l6ZScsICckbGVuZ3RoJywgJyRjb3VudCcgXTtcbmNvbnN0IE9QX1NVTSA9IFsgJyRzdW0nLCAnJHRvdGFsJyBdO1xuY29uc3QgT1BfS0VZUyA9IFsgJyRrZXlzJyBdO1xuY29uc3QgT1BfVkFMVUVTID0gWyAnJHZhbHVlcycgXTtcbmNvbnN0IE9QX0dFVF9UWVBFID0gWyAnJHR5cGUnIF07XG5cbi8vTWFuaXB1bGF0ZSBvcGVyYXRpb25cbmNvbnN0IE9QX0FERCA9IFsgJyRhZGQnLCAnJHBsdXMnLCAgICAgJyRpbmMnIF07XG5jb25zdCBPUF9TVUIgPSBbICckc3ViJywgJyRzdWJ0cmFjdCcsICckbWludXMnLCAnJGRlYycgXTtcbmNvbnN0IE9QX01VTCA9IFsgJyRtdWwnLCAnJG11bHRpcGx5JywgICckdGltZXMnIF07XG5jb25zdCBPUF9ESVYgPSBbICckZGl2JywgJyRkaXZpZGUnIF07XG5jb25zdCBPUF9TRVQgPSBbICckc2V0JywgJyQ9JyBdO1xuXG5jb25zdCBPUF9QSUNLID0gWyAnJHBpY2snIF07XG5jb25zdCBPUF9HRVRfQllfSU5ERVggPSBbICckYXQnLCAnJGdldEJ5SW5kZXgnLCAnJG50aCcgXTtcbmNvbnN0IE9QX0dFVF9CWV9LRVkgPSBbICckb2YnLCAnJGdldEJ5S2V5JyBdO1xuY29uc3QgT1BfT01JVCA9IFsgJyRvbWl0JyBdO1xuY29uc3QgT1BfR1JPVVAgPSBbICckZ3JvdXAnLCAnJGdyb3VwQnknIF07XG5jb25zdCBPUF9TT1JUID0gWyAnJHNvcnQnLCAnJG9yZGVyQnknLCAnJHNvcnRCeScgXTtcbmNvbnN0IE9QX1JFVkVSU0UgPSBbICckcmV2ZXJzZScgXTtcbmNvbnN0IE9QX0VWQUwgPSBbICckZXZhbCcsICckYXBwbHknIF07XG5jb25zdCBPUF9NRVJHRSA9IFsgJyRtZXJnZScgXTtcblxuY29uc3QgUEZYX0ZPUl9FQUNIID0gJ3w+JzsgLy8gZm9yIGVhY2hcbmNvbnN0IFBGWF9XSVRIX0FOWSA9ICd8Kic7IC8vIHdpdGggYW55XG5cbmNvbnN0IE1hcE9mT3BzID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkT3BUb01hcCA9ICh0b2tlbnMsIHRhZykgPT4gdG9rZW5zLmZvckVhY2godG9rZW4gPT4gTWFwT2ZPcHMuc2V0KHRva2VuLCB0YWcpKTtcbmFkZE9wVG9NYXAoT1BfRVFVQUwsICdPUF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1RfRVFVQUwsICdPUF9OT1RfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTk9ULCAnT1BfTk9UJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTiwgJ09QX0dSRUFURVJfVEhBTicpO1xuYWRkT3BUb01hcChPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwsICdPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOLCAnT1BfTEVTU19USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0xFU1NfVEhBTl9PUl9FUVVBTCwgJ09QX0xFU1NfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9JTiwgJ09QX0lOJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9JTiwgJ09QX05PVF9JTicpO1xuYWRkT3BUb01hcChPUF9FWElTVFMsICdPUF9FWElTVFMnKTtcbmFkZE9wVG9NYXAoT1BfTUFUQ0gsICdPUF9NQVRDSCcpO1xuYWRkT3BUb01hcChPUF9NQVRDSF9BTlksICdPUF9NQVRDSF9BTlknKTtcbmFkZE9wVG9NYXAoT1BfVFlQRSwgJ09QX1RZUEUnKTtcbmFkZE9wVG9NYXAoT1BfSEFTX0tFWVMsICdPUF9IQVNfS0VZUycpO1xuYWRkT3BUb01hcChPUF9TVEFSVF9XSVRILCAnT1BfU1RBUlRfV0lUSCcpO1xuYWRkT3BUb01hcChPUF9FTkRfV0lUSCwgJ09QX0VORF9XSVRIJyk7XG5cbmNvbnN0IE1hcE9mTWFucyA9IG5ldyBNYXAoKTtcbmNvbnN0IGFkZE1hblRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk1hbnMuc2V0KHRva2VuLCB0YWcpKTtcbi8vIFsgPG9wIG5hbWU+LCA8dW5hcnk+IF1cbmFkZE1hblRvTWFwKE9QX1NJWkUsIFsnT1BfU0laRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VNLCBbJ09QX1NVTScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfS0VZUywgWydPUF9LRVlTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9WQUxVRVMsIFsnT1BfVkFMVUVTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9HRVRfVFlQRSwgWydPUF9HRVRfVFlQRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfUkVWRVJTRSwgWydPUF9SRVZFUlNFJywgdHJ1ZV0pO1xuXG5hZGRNYW5Ub01hcChPUF9BREQsIFsnT1BfQUREJywgZmFsc2UgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VCLCBbJ09QX1NVQicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfTVVMLCBbJ09QX01VTCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfRElWLCBbJ09QX0RJVicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfU0VULCBbJ09QX1NFVCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfUElDSywgWydPUF9QSUNLJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9JTkRFWCwgWydPUF9HRVRfQllfSU5ERVgnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR0VUX0JZX0tFWSwgWydPUF9HRVRfQllfS0VZJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX09NSVQsIFsnT1BfT01JVCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HUk9VUCwgWydPUF9HUk9VUCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9TT1JULCBbJ09QX1NPUlQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfRVZBTCwgWydPUF9FVkFMJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX01FUkdFLCBbJ09QX01FUkdFJywgZmFsc2VdKTtcblxuY29uc3QgZGVmYXVsdEplc0hhbmRsZXJzID0ge1xuICAgIE9QX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IF8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfTk9UX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+ICFfLmlzRXF1YWwobGVmdCwgcmlnaHQpLFxuICAgIE9QX05PVDogKGxlZnQsIC4uLmFyZ3MpID0+ICF0ZXN0KGxlZnQsICdPUF9NQVRDSCcsIC4uLmFyZ3MpLFxuICAgIE9QX0dSRUFURVJfVEhBTjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID4gcmlnaHQsXG4gICAgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPj0gcmlnaHQsXG4gICAgT1BfTEVTU19USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPCByaWdodCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8PSByaWdodCxcbiAgICBPUF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQuZmluZChlbGVtZW50ID0+IGRlZmF1bHRKZXNIYW5kbGVycy5PUF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9OT1RfSU46IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAocmlnaHQgPT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTk9UX0lOJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX05PVF9FUVVBTChsZWZ0LCBlbGVtZW50KSk7XG4gICAgfSxcbiAgICBPUF9FWElTVFM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9CT09MKCdPUF9FWElTVFMnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmlnaHQgPyBsZWZ0ICE9IG51bGwgOiBsZWZ0ID09IG51bGw7XG4gICAgfSxcbiAgICBPUF9UWVBFOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9TVFJJTkcoJ09QX1RZUEUnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByaWdodCA9IHJpZ2h0LnRvTG93ZXJDYXNlKCk7XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAnYXJyYXknKSB7XG4gICAgICAgICAgICByZXR1cm4gQXJyYXkuaXNBcnJheShsZWZ0KTtcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdpbnRlZ2VyJykge1xuICAgICAgICAgICAgcmV0dXJuIF8uaXNJbnRlZ2VyKGxlZnQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gJ3N0cmluZyc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHlwZW9mIGxlZnQgPT09IHJpZ2h0O1xuICAgIH0sXG4gICAgT1BfTUFUQ0g6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgcnVsZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCk7XG4gICAgICAgIHJldHVybiByWzBdO1xuICAgIH0sXG4gICAgT1BfTUFUQ0hfQU5ZOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUFUQ0hfQU5ZJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCBydWxlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICByZXR1cm4gclswXTtcbiAgICAgICAgfSk7ICAgXG4gICAgXG4gICAgICAgIHJldHVybiBmb3VuZCA/IHRydWUgOiBmYWxzZTtcbiAgICB9LFxuICAgIE9QX0hBU19LRVlTOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIGtleSA9PiBoYXNLZXlCeVBhdGgobGVmdCwga2V5KSk7XG4gICAgfSxcbiAgICBPUF9TVEFSVF9XSVRIOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBsZWZ0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9TVEFSVF9XSVRIJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnQuc3RhcnRzV2l0aChyaWdodCk7XG4gICAgfSxcbiAgICBPUF9FTkRfV0lUSDogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfRU5EX1dJVEgnKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdC5lbmRzV2l0aChyaWdodCk7XG4gICAgfSAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRNYW5pcHVsYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAobGVmdCkgPT4gXy5zaXplKGxlZnQpLFxuICAgIE9QX1NVTTogKGxlZnQpID0+IF8ucmVkdWNlKGxlZnQsIChzdW0sIGl0ZW0pID0+IHtcbiAgICAgICAgICAgIHN1bSArPSBpdGVtO1xuICAgICAgICAgICAgcmV0dXJuIHN1bTtcbiAgICAgICAgfSwgMCksXG5cbiAgICBPUF9LRVlTOiAobGVmdCkgPT4gXy5rZXlzKGxlZnQpLFxuICAgIE9QX1ZBTFVFUzogKGxlZnQpID0+IF8udmFsdWVzKGxlZnQpLCAgIFxuICAgIE9QX0dFVF9UWVBFOiAobGVmdCkgPT4gQXJyYXkuaXNBcnJheShsZWZ0KSA/ICdhcnJheScgOiAoXy5pc0ludGVnZXIobGVmdCkgPyAnaW50ZWdlcicgOiB0eXBlb2YgbGVmdCksICBcbiAgICBPUF9SRVZFUlNFOiAobGVmdCkgPT4gXy5yZXZlcnNlKGxlZnQpLFxuXG4gICAgLy9iaW5hcnlcbiAgICBPUF9BREQ6IChsZWZ0LCByaWdodCkgPT4gbGVmdCArIHJpZ2h0LFxuICAgIE9QX1NVQjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC0gcmlnaHQsXG4gICAgT1BfTVVMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgKiByaWdodCxcbiAgICBPUF9ESVY6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAvIHJpZ2h0LCBcbiAgICBPUF9TRVQ6IChsZWZ0LCByaWdodCkgPT4gcmlnaHQsIFxuICAgIE9QX1BJQ0s6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmlnaHQgPSBfLmNhc3RBcnJheShyaWdodCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLnBpY2sobGVmdCwgcmlnaHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiBfLnBpY2tCeShsZWZ0LCAoeCwga2V5KSA9PiBtYXRjaChrZXksIHJpZ2h0LCBqZXMsIHByZWZpeClbMF0pO1xuICAgIH0sXG4gICAgT1BfR0VUX0JZX0lOREVYOiAobGVmdCwgcmlnaHQpID0+IF8ubnRoKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HRVRfQllfS0VZOiAobGVmdCwgcmlnaHQpID0+IF8uZ2V0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9PTUlUOiAobGVmdCwgcmlnaHQpID0+IF8ub21pdChsZWZ0LCByaWdodCksXG4gICAgT1BfR1JPVVA6IChsZWZ0LCByaWdodCkgPT4gXy5ncm91cEJ5KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9TT1JUOiAobGVmdCwgcmlnaHQpID0+IF8uc29ydEJ5KGxlZnQsIHJpZ2h0KSwgIFxuICAgIE9QX0VWQUw6IGV2YWx1YXRlRXhwcixcbiAgICBPUF9NRVJHRTogKGxlZnQsIHJpZ2h0LCAuLi5hcmdzKSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQU5EX05PVF9BUlJBWSgnT1BfTUVSR0UnKSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiByaWdodC5yZWR1Y2UoKHJlc3VsdCwgZXhwcikgPT4gT2JqZWN0LmFzc2lnbihyZXN1bHQsIGV2YWx1YXRlRXhwcihsZWZ0LCBleHByLCAuLi5hcmdzKSksIHt9KTtcbiAgICB9IFxufVxuXG5jb25zdCBmb3JtYXROYW1lID0gKG5hbWUsIHByZWZpeCkgPT4ge1xuICAgIGNvbnN0IGZ1bGxOYW1lID0gbmFtZSA9PSBudWxsID8gcHJlZml4IDogZm9ybWF0UHJlZml4KG5hbWUsIHByZWZpeCk7XG4gICAgcmV0dXJuIGZ1bGxOYW1lID09IG51bGwgPyBcIlRoZSB2YWx1ZVwiIDogKGZ1bGxOYW1lLmluZGV4T2YoJygnKSAhPT0gLTEgPyBgVGhlIHF1ZXJ5IFwiXy4ke2Z1bGxOYW1lfVwiYCA6IGBcIiR7ZnVsbE5hbWV9XCJgKTtcbn07XG5jb25zdCBmb3JtYXRLZXkgPSAoa2V5LCBoYXNQcmVmaXgpID0+IF8uaXNJbnRlZ2VyKGtleSkgPyBgWyR7a2V5fV1gIDogKGhhc1ByZWZpeCA/ICcuJyArIGtleSA6IGtleSk7XG5jb25zdCBmb3JtYXRQcmVmaXggPSAoa2V5LCBwcmVmaXgpID0+IHByZWZpeCAhPSBudWxsID8gYCR7cHJlZml4fSR7Zm9ybWF0S2V5KGtleSwgdHJ1ZSl9YCA6IGZvcm1hdEtleShrZXksIGZhbHNlKTtcbmNvbnN0IGZvcm1hdFF1ZXJ5ID0gKG9wTWV0YSkgPT4gYCR7ZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zW29wTWV0YVswXV19KCR7b3BNZXRhWzFdID8gJycgOiAnPyd9KWA7ICBcbmNvbnN0IGZvcm1hdE1hcCA9IChuYW1lKSA9PiBgZWFjaCgtPiR7bmFtZX0pYDtcbmNvbnN0IGZvcm1hdEFueSA9IChuYW1lKSA9PiBgYW55KC0+JHtuYW1lfSlgO1xuXG5jb25zdCBkZWZhdWx0SmVzRXhwbGFuYXRpb25zID0ge1xuICAgIE9QX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1RfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1Q6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgZ3JlYXRlciB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0xFU1NfVEhBTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGxlc3MgdGhhbiAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOX09SX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuIG9yIGVxdWFsIHRvICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIG9uZSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSBhbnkgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfRVhJU1RTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQke3JpZ2h0ID8gJyBub3QgJzogJyAnfWJlIE5VTEwuYCwgICAgXG4gICAgT1BfVFlQRTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGBUaGUgdHlwZSBvZiAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIFwiJHtyaWdodH1cIiwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgICAgICBcbiAgICBPUF9NQVRDSDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX01BVENIX0FOWTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoIGFueSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9IQVNfS0VZUzogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGhhdmUgYWxsIG9mIHRoZXNlIGtleXMgWyR7cmlnaHQuam9pbignLCAnKX1dLmAsICAgICAgICBcbiAgICBPUF9TVEFSVF9XSVRIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgc3RhcnQgd2l0aCBcIiR7cmlnaHR9XCIuYCwgICAgICAgIFxuICAgIE9QX0VORF9XSVRIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgZW5kIHdpdGggXCIke3JpZ2h0fVwiLmAsICAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRRdWVyeUV4cGxhbmF0aW9ucyA9IHtcbiAgICAvL3VuYXJ5XG4gICAgT1BfU0laRTogJ3NpemUnLFxuICAgIE9QX1NVTTogJ3N1bScsXG4gICAgT1BfS0VZUzogJ2tleXMnLFxuICAgIE9QX1ZBTFVFUzogJ3ZhbHVlcycsICAgIFxuICAgIE9QX0dFVF9UWVBFOiAnZ2V0IHR5cGUnLFxuICAgIE9QX1JFVkVSU0U6ICdyZXZlcnNlJywgXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogJ2FkZCcsXG4gICAgT1BfU1VCOiAnc3VidHJhY3QnLFxuICAgIE9QX01VTDogJ211bHRpcGx5JyxcbiAgICBPUF9ESVY6ICdkaXZpZGUnLCBcbiAgICBPUF9TRVQ6ICdhc3NpZ24nLFxuICAgIE9QX1BJQ0s6ICdwaWNrJyxcbiAgICBPUF9HRVRfQllfSU5ERVg6ICdnZXQgZWxlbWVudCBhdCBpbmRleCcsXG4gICAgT1BfR0VUX0JZX0tFWTogJ2dldCBlbGVtZW50IG9mIGtleScsXG4gICAgT1BfT01JVDogJ29taXQnLFxuICAgIE9QX0dST1VQOiAnZ3JvdXBCeScsXG4gICAgT1BfU09SVDogJ3NvcnRCeScsXG4gICAgT1BfRVZBTDogJ2V2YWx1YXRlJyxcbiAgICBPUF9NRVJHRTogJ21lcmdlJ1xufTtcblxuZnVuY3Rpb24gZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbmFtZSwgbGVmdFZhbHVlLCByaWdodFZhbHVlLCBwcmVmaXgpIHtcbiAgICBjb25zdCBnZXR0ZXIgPSBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnNbb3BdIHx8IGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9NQVRDSDtcbiAgICByZXR1cm4gZ2V0dGVyKG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KTsgICAgXG59XG5cbmZ1bmN0aW9uIHRlc3QodmFsdWUsIG9wLCBvcFZhbHVlLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLm9wZXJhdG9ySGFuZGxlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfSEFOTERFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlKHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5xdWVyeUhhbmxkZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9IQU5ETEVSKG9wKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGhhbmRsZXIodmFsdWUsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXZhbHVhdGVVbmFyeSh2YWx1ZSwgb3AsIGplcywgcHJlZml4KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQnlPcE1ldGEoY3VycmVudFZhbHVlLCByaWdodFZhbHVlLCBvcE1ldGEsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgaWYgKG9wTWV0YVsxXSkge1xuICAgICAgICByZXR1cm4gcmlnaHRWYWx1ZSA/IGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KSA6IGN1cnJlbnRWYWx1ZTtcbiAgICB9IFxuICAgIFxuICAgIHJldHVybiBldmFsdWF0ZShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgcmlnaHRWYWx1ZSwgamVzLCBwcmVmaXgsIGNvbnRleHQpO1xufVxuXG5jb25zdCBkZWZhdWx0Q3VzdG9taXplciA9IHtcbiAgICBtYXBPZk9wZXJhdG9yczogTWFwT2ZPcHMsXG4gICAgbWFwT2ZNYW5pcHVsYXRvcnM6IE1hcE9mTWFucyxcbiAgICBvcGVyYXRvckhhbmRsZXJzOiBkZWZhdWx0SmVzSGFuZGxlcnMsXG4gICAgb3BlcmF0b3JFeHBsYW5hdGlvbnM6IGRlZmF1bHRKZXNFeHBsYW5hdGlvbnMsXG4gICAgcXVlcnlIYW5sZGVyczogZGVmYXVsdE1hbmlwdWxhdGlvbnNcbn07XG5cbmZ1bmN0aW9uIG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBvcGVyYW5kcywgamVzLCBwcmVmaXgpIHtcbiAgICBsZXQgbWF0Y2hSZXN1bHQsIG5leHRQcmVmaXg7XG5cbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IG1hcFJlc3VsdCA9IF8uaXNQbGFpbk9iamVjdChhY3R1YWwpID8gXy5tYXBWYWx1ZXMoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSkpIDogXy5tYXAoYWN0dWFsLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChpLCBwcmVmaXgpKSk7XG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdE1hcChmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gbWF0Y2gobWFwUmVzdWx0LCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgICBcbiAgICAgICAgICAgIG5leHRQcmVmaXggPSBmb3JtYXRQcmVmaXgoZm9ybWF0QW55KGZvcm1hdFF1ZXJ5KG9wTWV0YSkpLCBwcmVmaXgpO1xuICAgICAgICAgICAgbWF0Y2hSZXN1bHQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiBtYXRjaChldmFsdWF0ZUJ5T3BNZXRhKGl0ZW0sIG9wZXJhbmRzWzBdLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGtleSwgcHJlZml4KSksIG9wZXJhbmRzWzFdLCBqZXMsIG5leHRQcmVmaXgpKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIGlmICghbWF0Y2hSZXN1bHRbMF0pIHtcbiAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpIHtcbiAgICBzd2l0Y2ggKGNvbGxlY3Rpb25PcCkge1xuICAgICAgICBjYXNlIFBGWF9GT1JfRUFDSDpcbiAgICAgICAgICAgIGNvbnN0IHVubWF0Y2hlZEtleSA9IF8uZmluZEluZGV4KGFjdHVhbCwgKGl0ZW0pID0+ICF0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgICAgIGlmICh1bm1hdGNoZWRLZXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgdW5tYXRjaGVkS2V5LCBhY3R1YWxbdW5tYXRjaGVkS2V5XSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZWQgPSBfLmZpbmQoYWN0dWFsLCAoaXRlbSwga2V5KSA9PiB0ZXN0KGl0ZW0sIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSlcbiAgICAgICAgXG4gICAgICAgICAgICBpZiAoIW1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24oamVzLCBvcCwgbnVsbCwgYWN0dWFsLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY3VycmVudFZhbHVlLCAoaXRlbSwgaSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBleHBlY3RlZEZpZWxkVmFsdWUsIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSwgY29udGV4dCkpO1xuXG4gICAgICAgIGNhc2UgUEZYX1dJVEhfQU5ZOiAgICAgICAgIFxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFBSWF9PUF9OT1RfRk9SX0VWQUwoY29sbGVjdGlvbk9wKSk7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX0NPTExFQ1RJT05fT1AoY29sbGVjdGlvbk9wKSk7XG4gICAgfVxufVxuXG4vKipcbiAqIFxuICogQHBhcmFtIHsqfSBhY3R1YWwgXG4gKiBAcGFyYW0geyp9IGV4cGVjdGVkIFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IHByZWZpeCAgXG4gKiBcbiAqIHsga2V5OiB7ICRtYXRjaCB9IH1cbiAqL1xuZnVuY3Rpb24gbWF0Y2goYWN0dWFsLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGxldCBwYXNzT2JqZWN0Q2hlY2sgPSBmYWxzZTtcblxuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGV4cGVjdGVkKSkge1xuICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCAnT1BfRVFVQUwnLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChudWxsLCBhY3R1YWwsIGV4cGVjdGVkLCBwcmVmaXgpICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gW3RydWVdO1xuICAgIH1cblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHBlY3RlZCkge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwZWN0ZWRbZmllbGROYW1lXTsgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgIFxuICAgICAgICAgICAgaWYgKGwgPiA0ICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVszXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEZpZWxkVmFsdWUpICYmIGV4cGVjdGVkRmllbGRWYWx1ZS5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihOT1RfQV9UV09fVFVQTEUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9wcm9jZXNzb3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDMpOyBcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2hDb2xsZWN0aW9uKGFjdHVhbCwgY29sbGVjdGlvbk9wLCBvcE1ldGEsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy92YWxpZGF0b3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDIpOyBcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGplcy5tYXBPZk9wZXJhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfVEVTVF9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gdmFsaWRhdGVDb2xsZWN0aW9uKGFjdHVhbCwgY29sbGVjdGlvbk9wLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXRjaFJlc3VsdCkgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChsID4gMiAmJiBmaWVsZE5hbWVbMV0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDEpO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhWzFdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTk9UX0FfVU5BUllfUVVFUlkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnlSZXN1bHQgPSBldmFsdWF0ZVVuYXJ5KGFjdHVhbCwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBtYXRjaChxdWVyeVJlc3VsdCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmb3JtYXRRdWVyeShvcE1ldGEpLCBwcmVmaXgpKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy92YWxpZGF0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGplcy5tYXBPZk9wZXJhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IFxuXG4gICAgICAgIGlmICghcGFzc09iamVjdENoZWNrKSB7XG4gICAgICAgICAgICBpZiAoYWN0dWFsID09IG51bGwpIHJldHVybiBbXG4gICAgICAgICAgICAgICAgZmFsc2UsICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FWElTVFMobnVsbCwgbnVsbCwgdHJ1ZSwgcHJlZml4KVxuICAgICAgICAgICAgXTsgXG5cbiAgICAgICAgICAgIGNvbnN0IGFjdHVhbFR5cGUgPSB0eXBlb2YgYWN0dWFsO1xuICAgIFxuICAgICAgICAgICAgaWYgKGFjdHVhbFR5cGUgIT09ICdvYmplY3QnKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9UWVBFKG51bGwsIGFjdHVhbFR5cGUsICdvYmplY3QnLCBwcmVmaXgpXG4gICAgICAgICAgICBdOyAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcGFzc09iamVjdENoZWNrID0gdHJ1ZTtcblxuICAgICAgICBsZXQgYWN0dWFsRmllbGRWYWx1ZSA9IF8uZ2V0KGFjdHVhbCwgZmllbGROYW1lKTsgICAgIFxuICAgICAgICBcbiAgICAgICAgaWYgKGV4cGVjdGVkRmllbGRWYWx1ZSAhPSBudWxsICYmIHR5cGVvZiBleHBlY3RlZEZpZWxkVmFsdWUgPT09ICdvYmplY3QnKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBbIG9rLCByZWFzb24gXSA9IG1hdGNoKGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZmllbGROYW1lLCBwcmVmaXgpKTtcbiAgICAgICAgICAgIGlmICghb2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gWyBmYWxzZSwgcmVhc29uIF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIXRlc3QoYWN0dWFsRmllbGRWYWx1ZSwgJ09QX0VRVUFMJywgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX0VRVUFMKGZpZWxkTmFtZSwgYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gW3RydWVdO1xufVxuXG4vKipcbiAqIElmICQgb3BlcmF0b3IgdXNlZCwgb25seSBvbmUgYSB0aW1lIGlzIGFsbG93ZWRcbiAqIGUuZy5cbiAqIHtcbiAqICAgICRncm91cEJ5OiAna2V5J1xuICogfVxuICogXG4gKiBcbiAqIEBwYXJhbSB7Kn0gY3VycmVudFZhbHVlIFxuICogQHBhcmFtIHsqfSBleHByIFxuICogQHBhcmFtIHsqfSBwcmVmaXggXG4gKiBAcGFyYW0geyp9IGplcyBcbiAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICovXG5mdW5jdGlvbiBldmFsdWF0ZUV4cHIoY3VycmVudFZhbHVlLCBleHByLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIGplcyAhPSBudWxsIHx8IChqZXMgPSBkZWZhdWx0Q3VzdG9taXplcik7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZXhwcikpIHtcbiAgICAgICAgcmV0dXJuIGV4cHIucmVkdWNlKChyZXN1bHQsIGV4cHJJdGVtKSA9PiBldmFsdWF0ZUV4cHIocmVzdWx0LCBleHBySXRlbSwgamVzLCBwcmVmaXgsIGNvbnRleHQpLCBjdXJyZW50VmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGVFeHByID0gdHlwZW9mIGV4cHI7XG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIHJldHVybiBleHByID8gY3VycmVudFZhbHVlIDogdW5kZWZpbmVkO1xuICAgIH0gICAgXG5cbiAgICBpZiAodHlwZUV4cHIgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmIChleHByLnN0YXJ0c1dpdGgoJyQkJykpIHtcbiAgICAgICAgICAgIC8vZ2V0IGZyb20gY29udGV4dFxuICAgICAgICAgICAgY29uc3QgcG9zID0gZXhwci5pbmRleE9mKCcuJyk7XG4gICAgICAgICAgICBpZiAocG9zID09PSAtMSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjb250ZXh0W2V4cHJdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5nZXQoY29udGV4dFtleHByLnN1YnN0cigwLCBwb3MpXSwgZXhwci5zdWJzdHIocG9zKzEpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZXhwcik7XG4gICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFJFUVVJUkVfUklHSFRfT1BFUkFORChleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZXZhbHVhdGVVbmFyeShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpO1xuICAgIH0gXG5cbiAgICBpZiAoY29udGV4dCA9PSBudWxsKSB7IFxuICAgICAgICBjb250ZXh0ID0geyAkJFJPT1Q6IGN1cnJlbnRWYWx1ZSwgJCRQQVJFTlQ6IG51bGwsICQkQ1VSUkVOVDogY3VycmVudFZhbHVlIH07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY29udGV4dCA9IHsgLi4uY29udGV4dCwgJCRQQVJFTlQ6IGNvbnRleHQuJCRDVVJSRU5ULCAkJENVUlJFTlQ6IGN1cnJlbnRWYWx1ZSB9O1xuICAgIH1cblxuICAgIGxldCByZXN1bHQsIGhhc09wZXJhdG9yID0gZmFsc2U7ICAgIFxuXG4gICAgZm9yIChsZXQgZmllbGROYW1lIGluIGV4cHIpIHtcbiAgICAgICAgbGV0IGV4cGVjdGVkRmllbGRWYWx1ZSA9IGV4cHJbZmllbGROYW1lXTsgIFxuICAgICAgICBcbiAgICAgICAgY29uc3QgbCA9IGZpZWxkTmFtZS5sZW5ndGg7XG5cbiAgICAgICAgaWYgKGwgPiAxKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXN1bHQgPSBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChsID4gMyAmJiBmaWVsZE5hbWVbMF0gPT09ICd8JyAmJiBmaWVsZE5hbWVbMl0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVDb2xsZWN0aW9uKGN1cnJlbnRWYWx1ZSwgY29sbGVjdGlvbk9wLCBvcE1ldGEsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgIGhhc09wZXJhdG9yID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9waWNrIGEgZmllbGQgYW5kIHRoZW4gYXBwbHkgbWFuaXB1bGF0aW9uXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gY3VycmVudFZhbHVlICE9IG51bGwgPyBfLmdldChjdXJyZW50VmFsdWUsIGZpZWxkTmFtZSkgOiB1bmRlZmluZWQ7ICAgICBcblxuICAgICAgICBjb25zdCBjaGlsZEZpZWxkVmFsdWUgPSBldmFsdWF0ZUV4cHIoYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIGZvcm1hdFByZWZpeChmaWVsZE5hbWUsIHByZWZpeCksIGNvbnRleHQpO1xuICAgICAgICBpZiAodHlwZW9mIGNoaWxkRmllbGRWYWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9IHtcbiAgICAgICAgICAgICAgICAuLi5yZXN1bHQsXG4gICAgICAgICAgICAgICAgW2ZpZWxkTmFtZV06IGNoaWxkRmllbGRWYWx1ZVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuY2xhc3MgSkVTIHtcbiAgICBjb25zdHJ1Y3Rvcih2YWx1ZSwgY3VzdG9taXplcikge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgIHRoaXMuY3VzdG9taXplciA9IGN1c3RvbWl6ZXI7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAgICAgKiBAcGFyYW0gIHsuLi5hbnl9IGFyZ3MgXG4gICAgICovXG4gICAgbWF0Y2goZXhwZWN0ZWQpIHsgICAgICAgIFxuICAgICAgICBjb25zdCByZXN1bHQgPSBtYXRjaCh0aGlzLnZhbHVlLCBleHBlY3RlZCwgdGhpcy5jdXN0b21pemVyKTtcbiAgICAgICAgaWYgKHJlc3VsdFswXSkgcmV0dXJuIHRoaXM7XG5cbiAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihyZXN1bHRbMV0sIHtcbiAgICAgICAgICAgIGFjdHVhbDogdGhpcy52YWx1ZSxcbiAgICAgICAgICAgIGV4cGVjdGVkXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGV2YWx1YXRlKGV4cHIpIHtcbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlRXhwcih0aGlzLnZhbHVlLCBleHByLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgIH1cblxuICAgIHVwZGF0ZShleHByKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHRoaXMuY3VzdG9taXplcik7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxufVxuXG5KRVMubWF0Y2ggPSBtYXRjaDtcbkpFUy5ldmFsdWF0ZSA9IGV2YWx1YXRlRXhwcjtcbkpFUy5kZWZhdWx0Q3VzdG9taXplciA9IGRlZmF1bHRDdXN0b21pemVyO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEpFUzsiXX0=
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
const PFX_FOR_EACH = '|>';
const PFX_WITH_ANY = '|*';
const MapOfOps = new Map();

const addOpToMap = (tokens, tag) => tokens.forEach(token => MapOfOps.set(token, tag));

addOpToMap(OP_EQUAL, 'OP_EQUAL');
addOpToMap(OP_NOT_EQUAL, 'OP_NOT_EQUAL');
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
const defaultJesHandlers = {
  OP_EQUAL: (left, right) => _.isEqual(left, right),
  OP_NOT_EQUAL: (left, right) => !_.isEqual(left, right),
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
  OP_PICK: (left, right) => _.pick(left, right),
  OP_GET_BY_INDEX: (left, right) => _.nth(left, right),
  OP_GET_BY_KEY: (left, right) => _.get(left, right),
  OP_OMIT: (left, right) => _.omit(left, right),
  OP_GROUP: (left, right) => _.groupBy(left, right),
  OP_SORT: (left, right) => _.sortBy(left, right),
  OP_EVAL: evaluateExpr
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
  OP_HAS_KEYS: (name, left, right, prefix) => `${formatName(name, prefix)} should have all of these keys [${right.join(', ')}].`
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
  OP_EVAL: 'evaluate'
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiTk9UX0FfVFdPX1RVUExFIiwiTk9UX0FfVU5BUllfUVVFUlkiLCJJTlZBTElEX0NPTExFQ1RJT05fT1AiLCJQUlhfT1BfTk9UX0ZPUl9FVkFMIiwicHJlZml4IiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiUkVRVUlSRV9SSUdIVF9PUEVSQU5EIiwiT1BfRVFVQUwiLCJPUF9OT1RfRVFVQUwiLCJPUF9HUkVBVEVSX1RIQU4iLCJPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwiLCJPUF9MRVNTX1RIQU4iLCJPUF9MRVNTX1RIQU5fT1JfRVFVQUwiLCJPUF9JTiIsIk9QX05PVF9JTiIsIk9QX0VYSVNUUyIsIk9QX01BVENIIiwiT1BfTUFUQ0hfQU5ZIiwiT1BfVFlQRSIsIk9QX0hBU19LRVlTIiwiT1BfU0laRSIsIk9QX1NVTSIsIk9QX0tFWVMiLCJPUF9WQUxVRVMiLCJPUF9HRVRfVFlQRSIsIk9QX0FERCIsIk9QX1NVQiIsIk9QX01VTCIsIk9QX0RJViIsIk9QX1NFVCIsIk9QX1BJQ0siLCJPUF9HRVRfQllfSU5ERVgiLCJPUF9HRVRfQllfS0VZIiwiT1BfT01JVCIsIk9QX0dST1VQIiwiT1BfU09SVCIsIk9QX1JFVkVSU0UiLCJPUF9FVkFMIiwiUEZYX0ZPUl9FQUNIIiwiUEZYX1dJVEhfQU5ZIiwiTWFwT2ZPcHMiLCJNYXAiLCJhZGRPcFRvTWFwIiwidG9rZW5zIiwidGFnIiwiZm9yRWFjaCIsInNldCIsIk1hcE9mTWFucyIsImFkZE1hblRvTWFwIiwiZGVmYXVsdEplc0hhbmRsZXJzIiwibGVmdCIsInJpZ2h0IiwiaXNFcXVhbCIsIkFycmF5IiwiaXNBcnJheSIsIkVycm9yIiwiZmluZCIsImVsZW1lbnQiLCJldmVyeSIsInRvTG93ZXJDYXNlIiwiaXNJbnRlZ2VyIiwiamVzIiwicnVsZSIsInIiLCJtYXRjaCIsImZvdW5kIiwia2V5IiwiZGVmYXVsdE1hbmlwdWxhdGlvbnMiLCJzaXplIiwicmVkdWNlIiwic3VtIiwiaXRlbSIsImtleXMiLCJ2YWx1ZXMiLCJyZXZlcnNlIiwicGljayIsIm50aCIsImdldCIsIm9taXQiLCJncm91cEJ5Iiwic29ydEJ5IiwiZXZhbHVhdGVFeHByIiwiZm9ybWF0TmFtZSIsIm5hbWUiLCJmdWxsTmFtZSIsImZvcm1hdFByZWZpeCIsImluZGV4T2YiLCJmb3JtYXRLZXkiLCJoYXNQcmVmaXgiLCJmb3JtYXRRdWVyeSIsIm9wTWV0YSIsImRlZmF1bHRRdWVyeUV4cGxhbmF0aW9ucyIsImZvcm1hdE1hcCIsImZvcm1hdEFueSIsImRlZmF1bHRKZXNFeHBsYW5hdGlvbnMiLCJKU09OIiwic3RyaW5naWZ5Iiwiam9pbiIsImdldFVubWF0Y2hlZEV4cGxhbmF0aW9uIiwibGVmdFZhbHVlIiwicmlnaHRWYWx1ZSIsImdldHRlciIsIm9wZXJhdG9yRXhwbGFuYXRpb25zIiwidGVzdCIsInZhbHVlIiwib3BWYWx1ZSIsImhhbmRsZXIiLCJvcGVyYXRvckhhbmRsZXJzIiwiZXZhbHVhdGUiLCJjb250ZXh0IiwicXVlcnlIYW5sZGVycyIsImV2YWx1YXRlVW5hcnkiLCJldmFsdWF0ZUJ5T3BNZXRhIiwiY3VycmVudFZhbHVlIiwiZGVmYXVsdEN1c3RvbWl6ZXIiLCJtYXBPZk9wZXJhdG9ycyIsIm1hcE9mTWFuaXB1bGF0b3JzIiwibWF0Y2hDb2xsZWN0aW9uIiwiYWN0dWFsIiwiY29sbGVjdGlvbk9wIiwib3BlcmFuZHMiLCJtYXRjaFJlc3VsdCIsIm5leHRQcmVmaXgiLCJtYXBSZXN1bHQiLCJpc1BsYWluT2JqZWN0IiwibWFwVmFsdWVzIiwibWFwIiwiaSIsInVuZGVmaW5lZCIsInZhbGlkYXRlQ29sbGVjdGlvbiIsImV4cGVjdGVkRmllbGRWYWx1ZSIsInVubWF0Y2hlZEtleSIsImZpbmRJbmRleCIsIm1hdGNoZWQiLCJldmFsdWF0ZUNvbGxlY3Rpb24iLCJleHBlY3RlZCIsInBhc3NPYmplY3RDaGVjayIsImZpZWxkTmFtZSIsImwiLCJsZW5ndGgiLCJzdWJzdHIiLCJxdWVyeVJlc3VsdCIsImFjdHVhbFR5cGUiLCJhY3R1YWxGaWVsZFZhbHVlIiwib2siLCJyZWFzb24iLCJleHByIiwicmVzdWx0IiwiZXhwckl0ZW0iLCJ0eXBlRXhwciIsInN0YXJ0c1dpdGgiLCJwb3MiLCIkJFJPT1QiLCIkJFBBUkVOVCIsIiQkQ1VSUkVOVCIsImhhc09wZXJhdG9yIiwiY2hpbGRGaWVsZFZhbHVlIiwiSkVTIiwiY29uc3RydWN0b3IiLCJjdXN0b21pemVyIiwidXBkYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQXNCQyxPQUFPLENBQUMsVUFBRCxDQUFuQzs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBc0JELE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUdBLE1BQU1FLGtCQUFrQixHQUFHLG1EQUEzQjs7QUFDQSxNQUFNQyxzQkFBc0IsR0FBR0MsS0FBSyxJQUFLLCtCQUE4QkEsS0FBTSxJQUE3RTs7QUFDQSxNQUFNQyxxQkFBcUIsR0FBR0QsS0FBSyxJQUFLLDhCQUE2QkEsS0FBTSxJQUEzRTs7QUFDQSxNQUFNRSxxQkFBcUIsR0FBR0MsRUFBRSxJQUFLLHVCQUFzQkEsRUFBRyxzQkFBOUQ7O0FBQ0EsTUFBTUMsb0JBQW9CLEdBQUdELEVBQUUsSUFBSyxzQkFBcUJBLEVBQUcsc0JBQTVEOztBQUNBLE1BQU1FLGVBQWUsR0FBRyx5REFBeEI7QUFDQSxNQUFNQyxpQkFBaUIsR0FBRyx5RUFBMUI7O0FBQ0EsTUFBTUMscUJBQXFCLEdBQUdKLEVBQUUsSUFBSyxnQ0FBK0JBLEVBQUcsSUFBdkU7O0FBQ0EsTUFBTUssbUJBQW1CLEdBQUdDLE1BQU0sSUFBSyxvQkFBbUJBLE1BQU8saUNBQWpFOztBQUVBLE1BQU1DLGlCQUFpQixHQUFHUCxFQUFFLElBQUssc0NBQXFDQSxFQUFHLHVCQUF6RTs7QUFDQSxNQUFNUSxnQkFBZ0IsR0FBRVIsRUFBRSxJQUFLLHNDQUFxQ0EsRUFBRyw4QkFBdkU7O0FBQ0EsTUFBTVMsa0JBQWtCLEdBQUVULEVBQUUsSUFBSyxzQ0FBcUNBLEVBQUcsdUJBQXpFOztBQUVBLE1BQU1VLHFCQUFxQixHQUFHVixFQUFFLElBQUssMEJBQXlCQSxFQUFHLCtCQUFqRTs7QUFHQSxNQUFNVyxRQUFRLEdBQUcsQ0FBRSxLQUFGLEVBQVMsTUFBVCxFQUFpQixRQUFqQixDQUFqQjtBQUNBLE1BQU1DLFlBQVksR0FBRyxDQUFFLEtBQUYsRUFBUyxNQUFULEVBQWlCLFdBQWpCLENBQXJCO0FBRUEsTUFBTUMsZUFBZSxHQUFHLENBQUUsS0FBRixFQUFTLElBQVQsRUFBZSxjQUFmLENBQXhCO0FBQ0EsTUFBTUMsd0JBQXdCLEdBQUcsQ0FBRSxNQUFGLEVBQVUsS0FBVixFQUFpQixxQkFBakIsQ0FBakM7QUFFQSxNQUFNQyxZQUFZLEdBQUcsQ0FBRSxLQUFGLEVBQVMsSUFBVCxFQUFlLFdBQWYsQ0FBckI7QUFDQSxNQUFNQyxxQkFBcUIsR0FBRyxDQUFFLE1BQUYsRUFBVSxLQUFWLEVBQWlCLGtCQUFqQixDQUE5QjtBQUVBLE1BQU1DLEtBQUssR0FBRyxDQUFFLEtBQUYsQ0FBZDtBQUNBLE1BQU1DLFNBQVMsR0FBRyxDQUFFLE1BQUYsRUFBVSxRQUFWLENBQWxCO0FBRUEsTUFBTUMsU0FBUyxHQUFHLENBQUUsUUFBRixFQUFZLFNBQVosQ0FBbEI7QUFFQSxNQUFNQyxRQUFRLEdBQUcsQ0FBRSxNQUFGLEVBQVUsUUFBVixFQUFvQixNQUFwQixDQUFqQjtBQUVBLE1BQU1DLFlBQVksR0FBRyxDQUFFLE1BQUYsRUFBVSxLQUFWLEVBQWlCLFNBQWpCLENBQXJCO0FBRUEsTUFBTUMsT0FBTyxHQUFHLENBQUUsS0FBRixFQUFTLFNBQVQsQ0FBaEI7QUFFQSxNQUFNQyxXQUFXLEdBQUcsQ0FBRSxVQUFGLEVBQWMsV0FBZCxDQUFwQjtBQUdBLE1BQU1DLE9BQU8sR0FBRyxDQUFFLE9BQUYsRUFBVyxTQUFYLEVBQXNCLFFBQXRCLENBQWhCO0FBQ0EsTUFBTUMsTUFBTSxHQUFHLENBQUUsTUFBRixFQUFVLFFBQVYsQ0FBZjtBQUNBLE1BQU1DLE9BQU8sR0FBRyxDQUFFLE9BQUYsQ0FBaEI7QUFDQSxNQUFNQyxTQUFTLEdBQUcsQ0FBRSxTQUFGLENBQWxCO0FBQ0EsTUFBTUMsV0FBVyxHQUFHLENBQUUsT0FBRixDQUFwQjtBQUdBLE1BQU1DLE1BQU0sR0FBRyxDQUFFLE1BQUYsRUFBVSxPQUFWLEVBQXVCLE1BQXZCLENBQWY7QUFDQSxNQUFNQyxNQUFNLEdBQUcsQ0FBRSxNQUFGLEVBQVUsV0FBVixFQUF1QixRQUF2QixFQUFpQyxNQUFqQyxDQUFmO0FBQ0EsTUFBTUMsTUFBTSxHQUFHLENBQUUsTUFBRixFQUFVLFdBQVYsRUFBd0IsUUFBeEIsQ0FBZjtBQUNBLE1BQU1DLE1BQU0sR0FBRyxDQUFFLE1BQUYsRUFBVSxTQUFWLENBQWY7QUFDQSxNQUFNQyxNQUFNLEdBQUcsQ0FBRSxNQUFGLEVBQVUsSUFBVixDQUFmO0FBRUEsTUFBTUMsT0FBTyxHQUFHLENBQUUsT0FBRixDQUFoQjtBQUNBLE1BQU1DLGVBQWUsR0FBRyxDQUFFLEtBQUYsRUFBUyxhQUFULEVBQXdCLE1BQXhCLENBQXhCO0FBQ0EsTUFBTUMsYUFBYSxHQUFHLENBQUUsS0FBRixFQUFTLFdBQVQsQ0FBdEI7QUFDQSxNQUFNQyxPQUFPLEdBQUcsQ0FBRSxPQUFGLENBQWhCO0FBQ0EsTUFBTUMsUUFBUSxHQUFHLENBQUUsUUFBRixFQUFZLFVBQVosQ0FBakI7QUFDQSxNQUFNQyxPQUFPLEdBQUcsQ0FBRSxPQUFGLEVBQVcsVUFBWCxFQUF1QixTQUF2QixDQUFoQjtBQUNBLE1BQU1DLFVBQVUsR0FBRyxDQUFFLFVBQUYsQ0FBbkI7QUFDQSxNQUFNQyxPQUFPLEdBQUcsQ0FBRSxPQUFGLEVBQVcsUUFBWCxDQUFoQjtBQUVBLE1BQU1DLFlBQVksR0FBRyxJQUFyQjtBQUNBLE1BQU1DLFlBQVksR0FBRyxJQUFyQjtBQUVBLE1BQU1DLFFBQVEsR0FBRyxJQUFJQyxHQUFKLEVBQWpCOztBQUNBLE1BQU1DLFVBQVUsR0FBRyxDQUFDQyxNQUFELEVBQVNDLEdBQVQsS0FBaUJELE1BQU0sQ0FBQ0UsT0FBUCxDQUFlcEQsS0FBSyxJQUFJK0MsUUFBUSxDQUFDTSxHQUFULENBQWFyRCxLQUFiLEVBQW9CbUQsR0FBcEIsQ0FBeEIsQ0FBcEM7O0FBQ0FGLFVBQVUsQ0FBQ25DLFFBQUQsRUFBVyxVQUFYLENBQVY7QUFDQW1DLFVBQVUsQ0FBQ2xDLFlBQUQsRUFBZSxjQUFmLENBQVY7QUFDQWtDLFVBQVUsQ0FBQ2pDLGVBQUQsRUFBa0IsaUJBQWxCLENBQVY7QUFDQWlDLFVBQVUsQ0FBQ2hDLHdCQUFELEVBQTJCLDBCQUEzQixDQUFWO0FBQ0FnQyxVQUFVLENBQUMvQixZQUFELEVBQWUsY0FBZixDQUFWO0FBQ0ErQixVQUFVLENBQUM5QixxQkFBRCxFQUF3Qix1QkFBeEIsQ0FBVjtBQUNBOEIsVUFBVSxDQUFDN0IsS0FBRCxFQUFRLE9BQVIsQ0FBVjtBQUNBNkIsVUFBVSxDQUFDNUIsU0FBRCxFQUFZLFdBQVosQ0FBVjtBQUNBNEIsVUFBVSxDQUFDM0IsU0FBRCxFQUFZLFdBQVosQ0FBVjtBQUNBMkIsVUFBVSxDQUFDMUIsUUFBRCxFQUFXLFVBQVgsQ0FBVjtBQUNBMEIsVUFBVSxDQUFDekIsWUFBRCxFQUFlLGNBQWYsQ0FBVjtBQUNBeUIsVUFBVSxDQUFDeEIsT0FBRCxFQUFVLFNBQVYsQ0FBVjtBQUNBd0IsVUFBVSxDQUFDdkIsV0FBRCxFQUFjLGFBQWQsQ0FBVjtBQUVBLE1BQU00QixTQUFTLEdBQUcsSUFBSU4sR0FBSixFQUFsQjs7QUFDQSxNQUFNTyxXQUFXLEdBQUcsQ0FBQ0wsTUFBRCxFQUFTQyxHQUFULEtBQWlCRCxNQUFNLENBQUNFLE9BQVAsQ0FBZXBELEtBQUssSUFBSXNELFNBQVMsQ0FBQ0QsR0FBVixDQUFjckQsS0FBZCxFQUFxQm1ELEdBQXJCLENBQXhCLENBQXJDOztBQUVBSSxXQUFXLENBQUM1QixPQUFELEVBQVUsQ0FBQyxTQUFELEVBQVksSUFBWixDQUFWLENBQVg7QUFDQTRCLFdBQVcsQ0FBQzNCLE1BQUQsRUFBUyxDQUFDLFFBQUQsRUFBVyxJQUFYLENBQVQsQ0FBWDtBQUNBMkIsV0FBVyxDQUFDMUIsT0FBRCxFQUFVLENBQUMsU0FBRCxFQUFZLElBQVosQ0FBVixDQUFYO0FBQ0EwQixXQUFXLENBQUN6QixTQUFELEVBQVksQ0FBQyxXQUFELEVBQWMsSUFBZCxDQUFaLENBQVg7QUFDQXlCLFdBQVcsQ0FBQ3hCLFdBQUQsRUFBYyxDQUFDLGFBQUQsRUFBZ0IsSUFBaEIsQ0FBZCxDQUFYO0FBQ0F3QixXQUFXLENBQUNaLFVBQUQsRUFBYSxDQUFDLFlBQUQsRUFBZSxJQUFmLENBQWIsQ0FBWDtBQUVBWSxXQUFXLENBQUN2QixNQUFELEVBQVMsQ0FBQyxRQUFELEVBQVcsS0FBWCxDQUFULENBQVg7QUFDQXVCLFdBQVcsQ0FBQ3RCLE1BQUQsRUFBUyxDQUFDLFFBQUQsRUFBVyxLQUFYLENBQVQsQ0FBWDtBQUNBc0IsV0FBVyxDQUFDckIsTUFBRCxFQUFTLENBQUMsUUFBRCxFQUFXLEtBQVgsQ0FBVCxDQUFYO0FBQ0FxQixXQUFXLENBQUNwQixNQUFELEVBQVMsQ0FBQyxRQUFELEVBQVcsS0FBWCxDQUFULENBQVg7QUFDQW9CLFdBQVcsQ0FBQ25CLE1BQUQsRUFBUyxDQUFDLFFBQUQsRUFBVyxLQUFYLENBQVQsQ0FBWDtBQUNBbUIsV0FBVyxDQUFDbEIsT0FBRCxFQUFVLENBQUMsU0FBRCxFQUFZLEtBQVosQ0FBVixDQUFYO0FBQ0FrQixXQUFXLENBQUNqQixlQUFELEVBQWtCLENBQUMsaUJBQUQsRUFBb0IsS0FBcEIsQ0FBbEIsQ0FBWDtBQUNBaUIsV0FBVyxDQUFDaEIsYUFBRCxFQUFnQixDQUFDLGVBQUQsRUFBa0IsS0FBbEIsQ0FBaEIsQ0FBWDtBQUNBZ0IsV0FBVyxDQUFDZixPQUFELEVBQVUsQ0FBQyxTQUFELEVBQVksS0FBWixDQUFWLENBQVg7QUFDQWUsV0FBVyxDQUFDZCxRQUFELEVBQVcsQ0FBQyxVQUFELEVBQWEsS0FBYixDQUFYLENBQVg7QUFDQWMsV0FBVyxDQUFDYixPQUFELEVBQVUsQ0FBQyxTQUFELEVBQVksS0FBWixDQUFWLENBQVg7QUFDQWEsV0FBVyxDQUFDWCxPQUFELEVBQVUsQ0FBQyxTQUFELEVBQVksS0FBWixDQUFWLENBQVg7QUFFQSxNQUFNWSxrQkFBa0IsR0FBRztBQUN2QjFDLEVBQUFBLFFBQVEsRUFBRSxDQUFDMkMsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDaUUsT0FBRixDQUFVRixJQUFWLEVBQWdCQyxLQUFoQixDQURKO0FBRXZCM0MsRUFBQUEsWUFBWSxFQUFFLENBQUMwQyxJQUFELEVBQU9DLEtBQVAsS0FBaUIsQ0FBQ2hFLENBQUMsQ0FBQ2lFLE9BQUYsQ0FBVUYsSUFBVixFQUFnQkMsS0FBaEIsQ0FGVDtBQUd2QjFDLEVBQUFBLGVBQWUsRUFBRSxDQUFDeUMsSUFBRCxFQUFPQyxLQUFQLEtBQWlCRCxJQUFJLEdBQUdDLEtBSGxCO0FBSXZCekMsRUFBQUEsd0JBQXdCLEVBQUUsQ0FBQ3dDLElBQUQsRUFBT0MsS0FBUCxLQUFpQkQsSUFBSSxJQUFJQyxLQUo1QjtBQUt2QnhDLEVBQUFBLFlBQVksRUFBRSxDQUFDdUMsSUFBRCxFQUFPQyxLQUFQLEtBQWlCRCxJQUFJLEdBQUdDLEtBTGY7QUFNdkJ2QyxFQUFBQSxxQkFBcUIsRUFBRSxDQUFDc0MsSUFBRCxFQUFPQyxLQUFQLEtBQWlCRCxJQUFJLElBQUlDLEtBTnpCO0FBT3ZCdEMsRUFBQUEsS0FBSyxFQUFFLENBQUNxQyxJQUFELEVBQU9DLEtBQVAsS0FBaUI7QUFDcEIsUUFBSUEsS0FBSyxJQUFJLElBQWIsRUFBbUIsT0FBTyxLQUFQOztBQUNuQixRQUFJLENBQUNFLEtBQUssQ0FBQ0MsT0FBTixDQUFjSCxLQUFkLENBQUwsRUFBMkI7QUFDdkIsWUFBTSxJQUFJSSxLQUFKLENBQVVwRCxpQkFBaUIsQ0FBQyxPQUFELENBQTNCLENBQU47QUFDSDs7QUFFRCxXQUFPZ0QsS0FBSyxDQUFDSyxJQUFOLENBQVdDLE9BQU8sSUFBSVIsa0JBQWtCLENBQUMxQyxRQUFuQixDQUE0QjJDLElBQTVCLEVBQWtDTyxPQUFsQyxDQUF0QixDQUFQO0FBQ0gsR0Fkc0I7QUFldkIzQyxFQUFBQSxTQUFTLEVBQUUsQ0FBQ29DLElBQUQsRUFBT0MsS0FBUCxLQUFpQjtBQUN4QixRQUFJQSxLQUFLLElBQUksSUFBYixFQUFtQixPQUFPLElBQVA7O0FBQ25CLFFBQUksQ0FBQ0UsS0FBSyxDQUFDQyxPQUFOLENBQWNILEtBQWQsQ0FBTCxFQUEyQjtBQUN2QixZQUFNLElBQUlJLEtBQUosQ0FBVXBELGlCQUFpQixDQUFDLFdBQUQsQ0FBM0IsQ0FBTjtBQUNIOztBQUVELFdBQU9oQixDQUFDLENBQUN1RSxLQUFGLENBQVFQLEtBQVIsRUFBZU0sT0FBTyxJQUFJUixrQkFBa0IsQ0FBQ3pDLFlBQW5CLENBQWdDMEMsSUFBaEMsRUFBc0NPLE9BQXRDLENBQTFCLENBQVA7QUFDSCxHQXRCc0I7QUF1QnZCMUMsRUFBQUEsU0FBUyxFQUFFLENBQUNtQyxJQUFELEVBQU9DLEtBQVAsS0FBaUI7QUFDeEIsUUFBSSxPQUFPQSxLQUFQLEtBQWlCLFNBQXJCLEVBQWdDO0FBQzVCLFlBQU0sSUFBSUksS0FBSixDQUFVbkQsZ0JBQWdCLENBQUMsV0FBRCxDQUExQixDQUFOO0FBQ0g7O0FBRUQsV0FBTytDLEtBQUssR0FBR0QsSUFBSSxJQUFJLElBQVgsR0FBa0JBLElBQUksSUFBSSxJQUF0QztBQUNILEdBN0JzQjtBQThCdkJoQyxFQUFBQSxPQUFPLEVBQUUsQ0FBQ2dDLElBQUQsRUFBT0MsS0FBUCxLQUFpQjtBQUN0QixRQUFJLE9BQU9BLEtBQVAsS0FBaUIsUUFBckIsRUFBK0I7QUFDM0IsWUFBTSxJQUFJSSxLQUFKLENBQVVsRCxrQkFBa0IsQ0FBQyxTQUFELENBQTVCLENBQU47QUFDSDs7QUFFRDhDLElBQUFBLEtBQUssR0FBR0EsS0FBSyxDQUFDUSxXQUFOLEVBQVI7O0FBRUEsUUFBSVIsS0FBSyxLQUFLLE9BQWQsRUFBdUI7QUFDbkIsYUFBT0UsS0FBSyxDQUFDQyxPQUFOLENBQWNKLElBQWQsQ0FBUDtBQUNIOztBQUVELFFBQUlDLEtBQUssS0FBSyxTQUFkLEVBQXlCO0FBQ3JCLGFBQU9oRSxDQUFDLENBQUN5RSxTQUFGLENBQVlWLElBQVosQ0FBUDtBQUNIOztBQUVELFFBQUlDLEtBQUssS0FBSyxNQUFkLEVBQXNCO0FBQ2xCLGFBQU8sT0FBT0QsSUFBUCxLQUFnQixRQUF2QjtBQUNIOztBQUVELFdBQU8sT0FBT0EsSUFBUCxLQUFnQkMsS0FBdkI7QUFDSCxHQWxEc0I7QUFtRHZCbkMsRUFBQUEsUUFBUSxFQUFFLENBQUNrQyxJQUFELEVBQU9DLEtBQVAsRUFBY1UsR0FBZCxFQUFtQjNELE1BQW5CLEtBQThCO0FBQ3BDLFFBQUltRCxLQUFLLENBQUNDLE9BQU4sQ0FBY0gsS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLGFBQU9oRSxDQUFDLENBQUN1RSxLQUFGLENBQVFQLEtBQVIsRUFBZVcsSUFBSSxJQUFJO0FBQzFCLGNBQU1DLENBQUMsR0FBR0MsS0FBSyxDQUFDZCxJQUFELEVBQU9ZLElBQVAsRUFBYUQsR0FBYixFQUFrQjNELE1BQWxCLENBQWY7QUFDQSxlQUFPNkQsQ0FBQyxDQUFDLENBQUQsQ0FBUjtBQUNILE9BSE0sQ0FBUDtBQUlIOztBQUVELFVBQU1BLENBQUMsR0FBR0MsS0FBSyxDQUFDZCxJQUFELEVBQU9DLEtBQVAsRUFBY1UsR0FBZCxFQUFtQjNELE1BQW5CLENBQWY7QUFDQSxXQUFPNkQsQ0FBQyxDQUFDLENBQUQsQ0FBUjtBQUNILEdBN0RzQjtBQThEdkI5QyxFQUFBQSxZQUFZLEVBQUUsQ0FBQ2lDLElBQUQsRUFBT0MsS0FBUCxFQUFjVSxHQUFkLEVBQW1CM0QsTUFBbkIsS0FBOEI7QUFDeEMsUUFBSSxDQUFDbUQsS0FBSyxDQUFDQyxPQUFOLENBQWNILEtBQWQsQ0FBTCxFQUEyQjtBQUN2QixZQUFNLElBQUlJLEtBQUosQ0FBVXBELGlCQUFpQixDQUFDLGNBQUQsQ0FBM0IsQ0FBTjtBQUNIOztBQUVELFFBQUk4RCxLQUFLLEdBQUc5RSxDQUFDLENBQUNxRSxJQUFGLENBQU9MLEtBQVAsRUFBY1csSUFBSSxJQUFJO0FBQzlCLFlBQU1DLENBQUMsR0FBR0MsS0FBSyxDQUFDZCxJQUFELEVBQU9ZLElBQVAsRUFBYUQsR0FBYixFQUFrQjNELE1BQWxCLENBQWY7QUFDQSxhQUFPNkQsQ0FBQyxDQUFDLENBQUQsQ0FBUjtBQUNILEtBSFcsQ0FBWjs7QUFLQSxXQUFPRSxLQUFLLEdBQUcsSUFBSCxHQUFVLEtBQXRCO0FBQ0gsR0F6RXNCO0FBMEV2QjlDLEVBQUFBLFdBQVcsRUFBRSxDQUFDK0IsSUFBRCxFQUFPQyxLQUFQLEtBQWlCO0FBQzFCLFFBQUksT0FBT0QsSUFBUCxLQUFnQixRQUFwQixFQUE4QixPQUFPLEtBQVA7QUFFOUIsV0FBTy9ELENBQUMsQ0FBQ3VFLEtBQUYsQ0FBUVAsS0FBUixFQUFlZSxHQUFHLElBQUk5RSxZQUFZLENBQUM4RCxJQUFELEVBQU9nQixHQUFQLENBQWxDLENBQVA7QUFDSDtBQTlFc0IsQ0FBM0I7QUFpRkEsTUFBTUMsb0JBQW9CLEdBQUc7QUFFekIvQyxFQUFBQSxPQUFPLEVBQUc4QixJQUFELElBQVUvRCxDQUFDLENBQUNpRixJQUFGLENBQU9sQixJQUFQLENBRk07QUFHekI3QixFQUFBQSxNQUFNLEVBQUc2QixJQUFELElBQVUvRCxDQUFDLENBQUNrRixNQUFGLENBQVNuQixJQUFULEVBQWUsQ0FBQ29CLEdBQUQsRUFBTUMsSUFBTixLQUFlO0FBQ3hDRCxJQUFBQSxHQUFHLElBQUlDLElBQVA7QUFDQSxXQUFPRCxHQUFQO0FBQ0gsR0FIYSxFQUdYLENBSFcsQ0FITztBQVF6QmhELEVBQUFBLE9BQU8sRUFBRzRCLElBQUQsSUFBVS9ELENBQUMsQ0FBQ3FGLElBQUYsQ0FBT3RCLElBQVAsQ0FSTTtBQVN6QjNCLEVBQUFBLFNBQVMsRUFBRzJCLElBQUQsSUFBVS9ELENBQUMsQ0FBQ3NGLE1BQUYsQ0FBU3ZCLElBQVQsQ0FUSTtBQVV6QjFCLEVBQUFBLFdBQVcsRUFBRzBCLElBQUQsSUFBVUcsS0FBSyxDQUFDQyxPQUFOLENBQWNKLElBQWQsSUFBc0IsT0FBdEIsR0FBaUMvRCxDQUFDLENBQUN5RSxTQUFGLENBQVlWLElBQVosSUFBb0IsU0FBcEIsR0FBZ0MsT0FBT0EsSUFWdEU7QUFXekJkLEVBQUFBLFVBQVUsRUFBR2MsSUFBRCxJQUFVL0QsQ0FBQyxDQUFDdUYsT0FBRixDQUFVeEIsSUFBVixDQVhHO0FBY3pCekIsRUFBQUEsTUFBTSxFQUFFLENBQUN5QixJQUFELEVBQU9DLEtBQVAsS0FBaUJELElBQUksR0FBR0MsS0FkUDtBQWV6QnpCLEVBQUFBLE1BQU0sRUFBRSxDQUFDd0IsSUFBRCxFQUFPQyxLQUFQLEtBQWlCRCxJQUFJLEdBQUdDLEtBZlA7QUFnQnpCeEIsRUFBQUEsTUFBTSxFQUFFLENBQUN1QixJQUFELEVBQU9DLEtBQVAsS0FBaUJELElBQUksR0FBR0MsS0FoQlA7QUFpQnpCdkIsRUFBQUEsTUFBTSxFQUFFLENBQUNzQixJQUFELEVBQU9DLEtBQVAsS0FBaUJELElBQUksR0FBR0MsS0FqQlA7QUFrQnpCdEIsRUFBQUEsTUFBTSxFQUFFLENBQUNxQixJQUFELEVBQU9DLEtBQVAsS0FBaUJBLEtBbEJBO0FBbUJ6QnJCLEVBQUFBLE9BQU8sRUFBRSxDQUFDb0IsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDd0YsSUFBRixDQUFPekIsSUFBUCxFQUFhQyxLQUFiLENBbkJEO0FBb0J6QnBCLEVBQUFBLGVBQWUsRUFBRSxDQUFDbUIsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDeUYsR0FBRixDQUFNMUIsSUFBTixFQUFZQyxLQUFaLENBcEJUO0FBcUJ6Qm5CLEVBQUFBLGFBQWEsRUFBRSxDQUFDa0IsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDMEYsR0FBRixDQUFNM0IsSUFBTixFQUFZQyxLQUFaLENBckJQO0FBc0J6QmxCLEVBQUFBLE9BQU8sRUFBRSxDQUFDaUIsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDMkYsSUFBRixDQUFPNUIsSUFBUCxFQUFhQyxLQUFiLENBdEJEO0FBdUJ6QmpCLEVBQUFBLFFBQVEsRUFBRSxDQUFDZ0IsSUFBRCxFQUFPQyxLQUFQLEtBQWlCaEUsQ0FBQyxDQUFDNEYsT0FBRixDQUFVN0IsSUFBVixFQUFnQkMsS0FBaEIsQ0F2QkY7QUF3QnpCaEIsRUFBQUEsT0FBTyxFQUFFLENBQUNlLElBQUQsRUFBT0MsS0FBUCxLQUFpQmhFLENBQUMsQ0FBQzZGLE1BQUYsQ0FBUzlCLElBQVQsRUFBZUMsS0FBZixDQXhCRDtBQXlCekJkLEVBQUFBLE9BQU8sRUFBRTRDO0FBekJnQixDQUE3Qjs7QUE0QkEsTUFBTUMsVUFBVSxHQUFHLENBQUNDLElBQUQsRUFBT2pGLE1BQVAsS0FBa0I7QUFDakMsUUFBTWtGLFFBQVEsR0FBR0QsSUFBSSxJQUFJLElBQVIsR0FBZWpGLE1BQWYsR0FBd0JtRixZQUFZLENBQUNGLElBQUQsRUFBT2pGLE1BQVAsQ0FBckQ7QUFDQSxTQUFPa0YsUUFBUSxJQUFJLElBQVosR0FBbUIsV0FBbkIsR0FBa0NBLFFBQVEsQ0FBQ0UsT0FBVCxDQUFpQixHQUFqQixNQUEwQixDQUFDLENBQTNCLEdBQWdDLGdCQUFlRixRQUFTLEdBQXhELEdBQThELElBQUdBLFFBQVMsR0FBbkg7QUFDSCxDQUhEOztBQUlBLE1BQU1HLFNBQVMsR0FBRyxDQUFDckIsR0FBRCxFQUFNc0IsU0FBTixLQUFvQnJHLENBQUMsQ0FBQ3lFLFNBQUYsQ0FBWU0sR0FBWixJQUFvQixJQUFHQSxHQUFJLEdBQTNCLEdBQWlDc0IsU0FBUyxHQUFHLE1BQU10QixHQUFULEdBQWVBLEdBQS9GOztBQUNBLE1BQU1tQixZQUFZLEdBQUcsQ0FBQ25CLEdBQUQsRUFBTWhFLE1BQU4sS0FBaUJBLE1BQU0sSUFBSSxJQUFWLEdBQWtCLEdBQUVBLE1BQU8sR0FBRXFGLFNBQVMsQ0FBQ3JCLEdBQUQsRUFBTSxJQUFOLENBQVksRUFBbEQsR0FBc0RxQixTQUFTLENBQUNyQixHQUFELEVBQU0sS0FBTixDQUFyRzs7QUFDQSxNQUFNdUIsV0FBVyxHQUFJQyxNQUFELElBQWEsR0FBRUMsd0JBQXdCLENBQUNELE1BQU0sQ0FBQyxDQUFELENBQVAsQ0FBWSxJQUFHQSxNQUFNLENBQUMsQ0FBRCxDQUFOLEdBQVksRUFBWixHQUFpQixHQUFJLEdBQS9GOztBQUNBLE1BQU1FLFNBQVMsR0FBSVQsSUFBRCxJQUFXLFVBQVNBLElBQUssR0FBM0M7O0FBQ0EsTUFBTVUsU0FBUyxHQUFJVixJQUFELElBQVcsU0FBUUEsSUFBSyxHQUExQzs7QUFFQSxNQUFNVyxzQkFBc0IsR0FBRztBQUMzQnZGLEVBQUFBLFFBQVEsRUFBRSxDQUFDNEUsSUFBRCxFQUFPakMsSUFBUCxFQUFhQyxLQUFiLEVBQW9CakQsTUFBcEIsS0FBZ0MsR0FBRWdGLFVBQVUsQ0FBQ0MsSUFBRCxFQUFPakYsTUFBUCxDQUFlLGNBQWE2RixJQUFJLENBQUNDLFNBQUwsQ0FBZTdDLEtBQWYsQ0FBc0IsU0FBUTRDLElBQUksQ0FBQ0MsU0FBTCxDQUFlOUMsSUFBZixDQUFxQixTQUQxRztBQUUzQjFDLEVBQUFBLFlBQVksRUFBRSxDQUFDMkUsSUFBRCxFQUFPakMsSUFBUCxFQUFhQyxLQUFiLEVBQW9CakQsTUFBcEIsS0FBZ0MsR0FBRWdGLFVBQVUsQ0FBQ0MsSUFBRCxFQUFPakYsTUFBUCxDQUFlLGtCQUFpQjZGLElBQUksQ0FBQ0MsU0FBTCxDQUFlN0MsS0FBZixDQUFzQixTQUFRNEMsSUFBSSxDQUFDQyxTQUFMLENBQWU5QyxJQUFmLENBQXFCLFNBRmxIO0FBRzNCekMsRUFBQUEsZUFBZSxFQUFFLENBQUMwRSxJQUFELEVBQU9qQyxJQUFQLEVBQWFDLEtBQWIsRUFBb0JqRCxNQUFwQixLQUFnQyxHQUFFZ0YsVUFBVSxDQUFDQyxJQUFELEVBQU9qRixNQUFQLENBQWUsMkJBQTBCaUQsS0FBTSxTQUFRNEMsSUFBSSxDQUFDQyxTQUFMLENBQWU5QyxJQUFmLENBQXFCLFNBSDlHO0FBSTNCeEMsRUFBQUEsd0JBQXdCLEVBQUUsQ0FBQ3lFLElBQUQsRUFBT2pDLElBQVAsRUFBYUMsS0FBYixFQUFvQmpELE1BQXBCLEtBQWdDLEdBQUVnRixVQUFVLENBQUNDLElBQUQsRUFBT2pGLE1BQVAsQ0FBZSx1Q0FBc0NpRCxLQUFNLFNBQVE0QyxJQUFJLENBQUNDLFNBQUwsQ0FBZTlDLElBQWYsQ0FBcUIsU0FKbkk7QUFLM0J2QyxFQUFBQSxZQUFZLEVBQUUsQ0FBQ3dFLElBQUQsRUFBT2pDLElBQVAsRUFBYUMsS0FBYixFQUFvQmpELE1BQXBCLEtBQWdDLEdBQUVnRixVQUFVLENBQUNDLElBQUQsRUFBT2pGLE1BQVAsQ0FBZSx3QkFBdUJpRCxLQUFNLFNBQVE0QyxJQUFJLENBQUNDLFNBQUwsQ0FBZTlDLElBQWYsQ0FBcUIsU0FMeEc7QUFNM0J0QyxFQUFBQSxxQkFBcUIsRUFBRSxDQUFDdUUsSUFBRCxFQUFPakMsSUFBUCxFQUFhQyxLQUFiLEVBQW9CakQsTUFBcEIsS0FBZ0MsR0FBRWdGLFVBQVUsQ0FBQ0MsSUFBRCxFQUFPakYsTUFBUCxDQUFlLG9DQUFtQ2lELEtBQU0sU0FBUTRDLElBQUksQ0FBQ0MsU0FBTCxDQUFlOUMsSUFBZixDQUFxQixTQU43SDtBQU8zQnJDLEVBQUFBLEtBQUssRUFBRSxDQUFDc0UsSUFBRCxFQUFPakMsSUFBUCxFQUFhQyxLQUFiLEVBQW9CakQsTUFBcEIsS0FBZ0MsR0FBRWdGLFVBQVUsQ0FBQ0MsSUFBRCxFQUFPakYsTUFBUCxDQUFlLHFCQUFvQjZGLElBQUksQ0FBQ0MsU0FBTCxDQUFlN0MsS0FBZixDQUFzQixTQUFRNEMsSUFBSSxDQUFDQyxTQUFMLENBQWU5QyxJQUFmLENBQXFCLFNBUDlHO0FBUTNCcEMsRUFBQUEsU0FBUyxFQUFFLENBQUNxRSxJQUFELEVBQU9qQyxJQUFQLEVBQWFDLEtBQWIsRUFBb0JqRCxNQUFwQixLQUFnQyxHQUFFZ0YsVUFBVSxDQUFDQyxJQUFELEVBQU9qRixNQUFQLENBQWUsNkJBQTRCNkYsSUFBSSxDQUFDQyxTQUFMLENBQWU3QyxLQUFmLENBQXNCLFNBQVE0QyxJQUFJLENBQUNDLFNBQUwsQ0FBZTlDLElBQWYsQ0FBcUIsU0FSMUg7QUFTM0JuQyxFQUFBQSxTQUFTLEVBQUUsQ0FBQ29FLElBQUQsRUFBT2pDLElBQVAsRUFBYUMsS0FBYixFQUFvQmpELE1BQXBCLEtBQWdDLEdBQUVnRixVQUFVLENBQUNDLElBQUQsRUFBT2pGLE1BQVAsQ0FBZSxVQUFTaUQsS0FBSyxHQUFHLE9BQUgsR0FBWSxHQUFJLFVBVHpFO0FBVTNCakMsRUFBQUEsT0FBTyxFQUFFLENBQUNpRSxJQUFELEVBQU9qQyxJQUFQLEVBQWFDLEtBQWIsRUFBb0JqRCxNQUFwQixLQUFnQyxlQUFjZ0YsVUFBVSxDQUFDQyxJQUFELEVBQU9qRixNQUFQLENBQWUsZUFBY2lELEtBQU0sVUFBUzRDLElBQUksQ0FBQ0MsU0FBTCxDQUFlOUMsSUFBZixDQUFxQixTQVZ2RztBQVczQmxDLEVBQUFBLFFBQVEsRUFBRSxDQUFDbUUsSUFBRCxFQUFPakMsSUFBUCxFQUFhQyxLQUFiLEVBQW9CakQsTUFBcEIsS0FBZ0MsR0FBRWdGLFVBQVUsQ0FBQ0MsSUFBRCxFQUFPakYsTUFBUCxDQUFlLGlCQUFnQjZGLElBQUksQ0FBQ0MsU0FBTCxDQUFlN0MsS0FBZixDQUFzQixTQUFRNEMsSUFBSSxDQUFDQyxTQUFMLENBQWU5QyxJQUFmLENBQXFCLFNBWDdHO0FBWTNCakMsRUFBQUEsWUFBWSxFQUFFLENBQUNrRSxJQUFELEVBQU9qQyxJQUFQLEVBQWFDLEtBQWIsRUFBb0JqRCxNQUFwQixLQUFnQyxHQUFFZ0YsVUFBVSxDQUFDQyxJQUFELEVBQU9qRixNQUFQLENBQWUsd0JBQXVCNkYsSUFBSSxDQUFDQyxTQUFMLENBQWU3QyxLQUFmLENBQXNCLFNBQVE0QyxJQUFJLENBQUNDLFNBQUwsQ0FBZTlDLElBQWYsQ0FBcUIsU0FaeEg7QUFhM0IvQixFQUFBQSxXQUFXLEVBQUUsQ0FBQ2dFLElBQUQsRUFBT2pDLElBQVAsRUFBYUMsS0FBYixFQUFvQmpELE1BQXBCLEtBQWdDLEdBQUVnRixVQUFVLENBQUNDLElBQUQsRUFBT2pGLE1BQVAsQ0FBZSxtQ0FBa0NpRCxLQUFLLENBQUM4QyxJQUFOLENBQVcsSUFBWCxDQUFpQjtBQWJoRyxDQUEvQjtBQWdCQSxNQUFNTix3QkFBd0IsR0FBRztBQUU3QnZFLEVBQUFBLE9BQU8sRUFBRSxNQUZvQjtBQUc3QkMsRUFBQUEsTUFBTSxFQUFFLEtBSHFCO0FBSTdCQyxFQUFBQSxPQUFPLEVBQUUsTUFKb0I7QUFLN0JDLEVBQUFBLFNBQVMsRUFBRSxRQUxrQjtBQU03QkMsRUFBQUEsV0FBVyxFQUFFLFVBTmdCO0FBTzdCWSxFQUFBQSxVQUFVLEVBQUUsU0FQaUI7QUFVN0JYLEVBQUFBLE1BQU0sRUFBRSxLQVZxQjtBQVc3QkMsRUFBQUEsTUFBTSxFQUFFLFVBWHFCO0FBWTdCQyxFQUFBQSxNQUFNLEVBQUUsVUFacUI7QUFhN0JDLEVBQUFBLE1BQU0sRUFBRSxRQWJxQjtBQWM3QkMsRUFBQUEsTUFBTSxFQUFFLFFBZHFCO0FBZTdCQyxFQUFBQSxPQUFPLEVBQUUsTUFmb0I7QUFnQjdCQyxFQUFBQSxlQUFlLEVBQUUsc0JBaEJZO0FBaUI3QkMsRUFBQUEsYUFBYSxFQUFFLG9CQWpCYztBQWtCN0JDLEVBQUFBLE9BQU8sRUFBRSxNQWxCb0I7QUFtQjdCQyxFQUFBQSxRQUFRLEVBQUUsU0FuQm1CO0FBb0I3QkMsRUFBQUEsT0FBTyxFQUFFLFFBcEJvQjtBQXFCN0JFLEVBQUFBLE9BQU8sRUFBRTtBQXJCb0IsQ0FBakM7O0FBd0JBLFNBQVM2RCx1QkFBVCxDQUFpQ3JDLEdBQWpDLEVBQXNDakUsRUFBdEMsRUFBMEN1RixJQUExQyxFQUFnRGdCLFNBQWhELEVBQTJEQyxVQUEzRCxFQUF1RWxHLE1BQXZFLEVBQStFO0FBQzNFLFFBQU1tRyxNQUFNLEdBQUd4QyxHQUFHLENBQUN5QyxvQkFBSixDQUF5QjFHLEVBQXpCLEtBQWdDaUUsR0FBRyxDQUFDeUMsb0JBQUosQ0FBeUJ0RixRQUF4RTtBQUNBLFNBQU9xRixNQUFNLENBQUNsQixJQUFELEVBQU9nQixTQUFQLEVBQWtCQyxVQUFsQixFQUE4QmxHLE1BQTlCLENBQWI7QUFDSDs7QUFFRCxTQUFTcUcsSUFBVCxDQUFjQyxLQUFkLEVBQXFCNUcsRUFBckIsRUFBeUI2RyxPQUF6QixFQUFrQzVDLEdBQWxDLEVBQXVDM0QsTUFBdkMsRUFBK0M7QUFDM0MsUUFBTXdHLE9BQU8sR0FBRzdDLEdBQUcsQ0FBQzhDLGdCQUFKLENBQXFCL0csRUFBckIsQ0FBaEI7O0FBRUEsTUFBSSxDQUFDOEcsT0FBTCxFQUFjO0FBQ1YsVUFBTSxJQUFJbkQsS0FBSixDQUFVMUQsb0JBQW9CLENBQUNELEVBQUQsQ0FBOUIsQ0FBTjtBQUNIOztBQUVELFNBQU84RyxPQUFPLENBQUNGLEtBQUQsRUFBUUMsT0FBUixFQUFpQjVDLEdBQWpCLEVBQXNCM0QsTUFBdEIsQ0FBZDtBQUNIOztBQUVELFNBQVMwRyxRQUFULENBQWtCSixLQUFsQixFQUF5QjVHLEVBQXpCLEVBQTZCNkcsT0FBN0IsRUFBc0M1QyxHQUF0QyxFQUEyQzNELE1BQTNDLEVBQW1EMkcsT0FBbkQsRUFBNEQ7QUFDeEQsUUFBTUgsT0FBTyxHQUFHN0MsR0FBRyxDQUFDaUQsYUFBSixDQUFrQmxILEVBQWxCLENBQWhCOztBQUVBLE1BQUksQ0FBQzhHLE9BQUwsRUFBYztBQUNWLFVBQU0sSUFBSW5ELEtBQUosQ0FBVTVELHFCQUFxQixDQUFDQyxFQUFELENBQS9CLENBQU47QUFDSDs7QUFFRCxTQUFPOEcsT0FBTyxDQUFDRixLQUFELEVBQVFDLE9BQVIsRUFBaUI1QyxHQUFqQixFQUFzQjNELE1BQXRCLEVBQThCMkcsT0FBOUIsQ0FBZDtBQUNIOztBQUVELFNBQVNFLGFBQVQsQ0FBdUJQLEtBQXZCLEVBQThCNUcsRUFBOUIsRUFBa0NpRSxHQUFsQyxFQUF1QzNELE1BQXZDLEVBQStDO0FBQzNDLFFBQU13RyxPQUFPLEdBQUc3QyxHQUFHLENBQUNpRCxhQUFKLENBQWtCbEgsRUFBbEIsQ0FBaEI7O0FBRUEsTUFBSSxDQUFDOEcsT0FBTCxFQUFjO0FBQ1YsVUFBTSxJQUFJbkQsS0FBSixDQUFVNUQscUJBQXFCLENBQUNDLEVBQUQsQ0FBL0IsQ0FBTjtBQUNIOztBQUVELFNBQU84RyxPQUFPLENBQUNGLEtBQUQsRUFBUTNDLEdBQVIsRUFBYTNELE1BQWIsQ0FBZDtBQUNIOztBQUVELFNBQVM4RyxnQkFBVCxDQUEwQkMsWUFBMUIsRUFBd0NiLFVBQXhDLEVBQW9EVixNQUFwRCxFQUE0RDdCLEdBQTVELEVBQWlFM0QsTUFBakUsRUFBeUUyRyxPQUF6RSxFQUFrRjtBQUM5RSxNQUFJbkIsTUFBTSxDQUFDLENBQUQsQ0FBVixFQUFlO0FBQ1gsV0FBT1UsVUFBVSxHQUFHVyxhQUFhLENBQUNFLFlBQUQsRUFBZXZCLE1BQU0sQ0FBQyxDQUFELENBQXJCLEVBQTBCN0IsR0FBMUIsRUFBK0IzRCxNQUEvQixDQUFoQixHQUF5RCtHLFlBQTFFO0FBQ0g7O0FBRUQsU0FBT0wsUUFBUSxDQUFDSyxZQUFELEVBQWV2QixNQUFNLENBQUMsQ0FBRCxDQUFyQixFQUEwQlUsVUFBMUIsRUFBc0N2QyxHQUF0QyxFQUEyQzNELE1BQTNDLEVBQW1EMkcsT0FBbkQsQ0FBZjtBQUNIOztBQUVELE1BQU1LLGlCQUFpQixHQUFHO0FBQ3RCQyxFQUFBQSxjQUFjLEVBQUUzRSxRQURNO0FBRXRCNEUsRUFBQUEsaUJBQWlCLEVBQUVyRSxTQUZHO0FBR3RCNEQsRUFBQUEsZ0JBQWdCLEVBQUUxRCxrQkFISTtBQUl0QnFELEVBQUFBLG9CQUFvQixFQUFFUixzQkFKQTtBQUt0QmdCLEVBQUFBLGFBQWEsRUFBRTNDO0FBTE8sQ0FBMUI7O0FBUUEsU0FBU2tELGVBQVQsQ0FBeUJDLE1BQXpCLEVBQWlDQyxZQUFqQyxFQUErQzdCLE1BQS9DLEVBQXVEOEIsUUFBdkQsRUFBaUUzRCxHQUFqRSxFQUFzRTNELE1BQXRFLEVBQThFO0FBQzFFLE1BQUl1SCxXQUFKLEVBQWlCQyxVQUFqQjs7QUFFQSxVQUFRSCxZQUFSO0FBQ0ksU0FBS2pGLFlBQUw7QUFDSSxZQUFNcUYsU0FBUyxHQUFHeEksQ0FBQyxDQUFDeUksYUFBRixDQUFnQk4sTUFBaEIsSUFBMEJuSSxDQUFDLENBQUMwSSxTQUFGLENBQVlQLE1BQVosRUFBb0IsQ0FBQy9DLElBQUQsRUFBT0wsR0FBUCxLQUFlOEMsZ0JBQWdCLENBQUN6QyxJQUFELEVBQU9pRCxRQUFRLENBQUMsQ0FBRCxDQUFmLEVBQW9COUIsTUFBcEIsRUFBNEI3QixHQUE1QixFQUFpQ3dCLFlBQVksQ0FBQ25CLEdBQUQsRUFBTWhFLE1BQU4sQ0FBN0MsQ0FBbkQsQ0FBMUIsR0FBNElmLENBQUMsQ0FBQzJJLEdBQUYsQ0FBTVIsTUFBTixFQUFjLENBQUMvQyxJQUFELEVBQU93RCxDQUFQLEtBQWFmLGdCQUFnQixDQUFDekMsSUFBRCxFQUFPaUQsUUFBUSxDQUFDLENBQUQsQ0FBZixFQUFvQjlCLE1BQXBCLEVBQTRCN0IsR0FBNUIsRUFBaUN3QixZQUFZLENBQUMwQyxDQUFELEVBQUk3SCxNQUFKLENBQTdDLENBQTNDLENBQTlKO0FBQ0F3SCxNQUFBQSxVQUFVLEdBQUdyQyxZQUFZLENBQUNPLFNBQVMsQ0FBQ0gsV0FBVyxDQUFDQyxNQUFELENBQVosQ0FBVixFQUFpQ3hGLE1BQWpDLENBQXpCO0FBQ0F1SCxNQUFBQSxXQUFXLEdBQUd6RCxLQUFLLENBQUMyRCxTQUFELEVBQVlILFFBQVEsQ0FBQyxDQUFELENBQXBCLEVBQXlCM0QsR0FBekIsRUFBOEI2RCxVQUE5QixDQUFuQjtBQUNBOztBQUVKLFNBQUtuRixZQUFMO0FBQ0ltRixNQUFBQSxVQUFVLEdBQUdyQyxZQUFZLENBQUNRLFNBQVMsQ0FBQ0osV0FBVyxDQUFDQyxNQUFELENBQVosQ0FBVixFQUFpQ3hGLE1BQWpDLENBQXpCO0FBQ0F1SCxNQUFBQSxXQUFXLEdBQUd0SSxDQUFDLENBQUNxRSxJQUFGLENBQU84RCxNQUFQLEVBQWUsQ0FBQy9DLElBQUQsRUFBT0wsR0FBUCxLQUFlRixLQUFLLENBQUNnRCxnQkFBZ0IsQ0FBQ3pDLElBQUQsRUFBT2lELFFBQVEsQ0FBQyxDQUFELENBQWYsRUFBb0I5QixNQUFwQixFQUE0QjdCLEdBQTVCLEVBQWlDd0IsWUFBWSxDQUFDbkIsR0FBRCxFQUFNaEUsTUFBTixDQUE3QyxDQUFqQixFQUE4RXNILFFBQVEsQ0FBQyxDQUFELENBQXRGLEVBQTJGM0QsR0FBM0YsRUFBZ0c2RCxVQUFoRyxDQUFuQyxDQUFkO0FBQ0E7O0FBRUo7QUFDSSxZQUFNLElBQUluRSxLQUFKLENBQVV2RCxxQkFBcUIsQ0FBQ3VILFlBQUQsQ0FBL0IsQ0FBTjtBQWJSOztBQWdCQSxNQUFJLENBQUNFLFdBQVcsQ0FBQyxDQUFELENBQWhCLEVBQXFCO0FBQ2pCLFdBQU9BLFdBQVA7QUFDSDs7QUFFRCxTQUFPTyxTQUFQO0FBQ0g7O0FBRUQsU0FBU0Msa0JBQVQsQ0FBNEJYLE1BQTVCLEVBQW9DQyxZQUFwQyxFQUFrRDNILEVBQWxELEVBQXNEc0ksa0JBQXRELEVBQTBFckUsR0FBMUUsRUFBK0UzRCxNQUEvRSxFQUF1RjtBQUNuRixVQUFRcUgsWUFBUjtBQUNJLFNBQUtqRixZQUFMO0FBQ0ksWUFBTTZGLFlBQVksR0FBR2hKLENBQUMsQ0FBQ2lKLFNBQUYsQ0FBWWQsTUFBWixFQUFxQi9DLElBQUQsSUFBVSxDQUFDZ0MsSUFBSSxDQUFDaEMsSUFBRCxFQUFPM0UsRUFBUCxFQUFXc0ksa0JBQVgsRUFBK0JyRSxHQUEvQixFQUFvQzNELE1BQXBDLENBQW5DLENBQXJCOztBQUNBLFVBQUlpSSxZQUFKLEVBQWtCO0FBQ2QsZUFBTyxDQUNILEtBREcsRUFFSGpDLHVCQUF1QixDQUFDckMsR0FBRCxFQUFNakUsRUFBTixFQUFVdUksWUFBVixFQUF3QmIsTUFBTSxDQUFDYSxZQUFELENBQTlCLEVBQThDRCxrQkFBOUMsRUFBa0VoSSxNQUFsRSxDQUZwQixDQUFQO0FBSUg7O0FBQ0Q7O0FBRUosU0FBS3FDLFlBQUw7QUFDSSxZQUFNOEYsT0FBTyxHQUFHbEosQ0FBQyxDQUFDcUUsSUFBRixDQUFPOEQsTUFBUCxFQUFlLENBQUMvQyxJQUFELEVBQU9MLEdBQVAsS0FBZXFDLElBQUksQ0FBQ2hDLElBQUQsRUFBTzNFLEVBQVAsRUFBV3NJLGtCQUFYLEVBQStCckUsR0FBL0IsRUFBb0MzRCxNQUFwQyxDQUFsQyxDQUFoQjs7QUFFQSxVQUFJLENBQUNtSSxPQUFMLEVBQWM7QUFDVixlQUFPLENBQ0gsS0FERyxFQUVIbkMsdUJBQXVCLENBQUNyQyxHQUFELEVBQU1qRSxFQUFOLEVBQVUsSUFBVixFQUFnQjBILE1BQWhCLEVBQXdCWSxrQkFBeEIsRUFBNENoSSxNQUE1QyxDQUZwQixDQUFQO0FBSUg7O0FBQ0Q7O0FBRUo7QUFDSSxZQUFNLElBQUlxRCxLQUFKLENBQVV2RCxxQkFBcUIsQ0FBQ3VILFlBQUQsQ0FBL0IsQ0FBTjtBQXZCUjs7QUEwQkEsU0FBT1MsU0FBUDtBQUNIOztBQUVELFNBQVNNLGtCQUFULENBQTRCckIsWUFBNUIsRUFBMENNLFlBQTFDLEVBQXdEN0IsTUFBeEQsRUFBZ0V3QyxrQkFBaEUsRUFBb0ZyRSxHQUFwRixFQUF5RjNELE1BQXpGLEVBQWlHMkcsT0FBakcsRUFBMEc7QUFDdEcsVUFBUVUsWUFBUjtBQUNJLFNBQUtqRixZQUFMO0FBQ0ksYUFBT25ELENBQUMsQ0FBQzJJLEdBQUYsQ0FBTWIsWUFBTixFQUFvQixDQUFDMUMsSUFBRCxFQUFPd0QsQ0FBUCxLQUFhZixnQkFBZ0IsQ0FBQ3pDLElBQUQsRUFBTzJELGtCQUFQLEVBQTJCeEMsTUFBM0IsRUFBbUM3QixHQUFuQyxFQUF3Q3dCLFlBQVksQ0FBQzBDLENBQUQsRUFBSTdILE1BQUosQ0FBcEQsRUFBaUUyRyxPQUFqRSxDQUFqRCxDQUFQOztBQUVKLFNBQUt0RSxZQUFMO0FBQ0ksWUFBTSxJQUFJZ0IsS0FBSixDQUFVdEQsbUJBQW1CLENBQUNzSCxZQUFELENBQTdCLENBQU47O0FBRUo7QUFDSSxZQUFNLElBQUloRSxLQUFKLENBQVV2RCxxQkFBcUIsQ0FBQ3VILFlBQUQsQ0FBL0IsQ0FBTjtBQVJSO0FBVUg7O0FBV0QsU0FBU3ZELEtBQVQsQ0FBZXNELE1BQWYsRUFBdUJpQixRQUF2QixFQUFpQzFFLEdBQWpDLEVBQXNDM0QsTUFBdEMsRUFBOEM7QUFDMUMyRCxFQUFBQSxHQUFHLElBQUksSUFBUCxLQUFnQkEsR0FBRyxHQUFHcUQsaUJBQXRCO0FBQ0EsTUFBSXNCLGVBQWUsR0FBRyxLQUF0Qjs7QUFFQSxNQUFJLENBQUNySixDQUFDLENBQUN5SSxhQUFGLENBQWdCVyxRQUFoQixDQUFMLEVBQWdDO0FBQzVCLFFBQUksQ0FBQ2hDLElBQUksQ0FBQ2UsTUFBRCxFQUFTLFVBQVQsRUFBcUJpQixRQUFyQixFQUErQjFFLEdBQS9CLEVBQW9DM0QsTUFBcEMsQ0FBVCxFQUFzRDtBQUNsRCxhQUFPLENBQ0gsS0FERyxFQUVIMkQsR0FBRyxDQUFDeUMsb0JBQUosQ0FBeUIvRixRQUF6QixDQUFrQyxJQUFsQyxFQUF3QytHLE1BQXhDLEVBQWdEaUIsUUFBaEQsRUFBMERySSxNQUExRCxDQUZHLENBQVA7QUFJSDs7QUFFRCxXQUFPLENBQUMsSUFBRCxDQUFQO0FBQ0g7O0FBRUQsT0FBSyxJQUFJdUksU0FBVCxJQUFzQkYsUUFBdEIsRUFBZ0M7QUFDNUIsUUFBSUwsa0JBQWtCLEdBQUdLLFFBQVEsQ0FBQ0UsU0FBRCxDQUFqQztBQUVBLFVBQU1DLENBQUMsR0FBR0QsU0FBUyxDQUFDRSxNQUFwQjs7QUFFQSxRQUFJRCxDQUFDLEdBQUcsQ0FBUixFQUFXO0FBQ1AsVUFBSUEsQ0FBQyxHQUFHLENBQUosSUFBU0QsU0FBUyxDQUFDLENBQUQsQ0FBVCxLQUFpQixHQUExQixJQUFpQ0EsU0FBUyxDQUFDLENBQUQsQ0FBVCxLQUFpQixHQUF0RCxFQUEyRDtBQUN2RCxZQUFJQSxTQUFTLENBQUMsQ0FBRCxDQUFULEtBQWlCLEdBQXJCLEVBQTBCO0FBQ3RCLGNBQUksQ0FBQ3BGLEtBQUssQ0FBQ0MsT0FBTixDQUFjNEUsa0JBQWQsQ0FBRCxJQUFzQ0Esa0JBQWtCLENBQUNTLE1BQW5CLEtBQThCLENBQXhFLEVBQTJFO0FBQ3ZFLGtCQUFNLElBQUlwRixLQUFKLENBQVV6RCxlQUFWLENBQU47QUFDSDs7QUFHRCxnQkFBTXlILFlBQVksR0FBR2tCLFNBQVMsQ0FBQ0csTUFBVixDQUFpQixDQUFqQixFQUFvQixDQUFwQixDQUFyQjtBQUNBSCxVQUFBQSxTQUFTLEdBQUdBLFNBQVMsQ0FBQ0csTUFBVixDQUFpQixDQUFqQixDQUFaO0FBRUEsZ0JBQU1sRCxNQUFNLEdBQUc3QixHQUFHLENBQUN1RCxpQkFBSixDQUFzQnZDLEdBQXRCLENBQTBCNEQsU0FBMUIsQ0FBZjs7QUFDQSxjQUFJLENBQUMvQyxNQUFMLEVBQWE7QUFDVCxrQkFBTSxJQUFJbkMsS0FBSixDQUFVL0Qsc0JBQXNCLENBQUNpSixTQUFELENBQWhDLENBQU47QUFDSDs7QUFFRCxnQkFBTWhCLFdBQVcsR0FBR0osZUFBZSxDQUFDQyxNQUFELEVBQVNDLFlBQVQsRUFBdUI3QixNQUF2QixFQUErQndDLGtCQUEvQixFQUFtRHJFLEdBQW5ELEVBQXdEM0QsTUFBeEQsQ0FBbkM7QUFDQSxjQUFJdUgsV0FBSixFQUFpQixPQUFPQSxXQUFQO0FBQ2pCO0FBQ0gsU0FqQkQsTUFpQk87QUFFSCxnQkFBTUYsWUFBWSxHQUFHa0IsU0FBUyxDQUFDRyxNQUFWLENBQWlCLENBQWpCLEVBQW9CLENBQXBCLENBQXJCO0FBQ0FILFVBQUFBLFNBQVMsR0FBR0EsU0FBUyxDQUFDRyxNQUFWLENBQWlCLENBQWpCLENBQVo7QUFFQSxnQkFBTWhKLEVBQUUsR0FBR2lFLEdBQUcsQ0FBQ3NELGNBQUosQ0FBbUJ0QyxHQUFuQixDQUF1QjRELFNBQXZCLENBQVg7O0FBQ0EsY0FBSSxDQUFDN0ksRUFBTCxFQUFTO0FBQ0wsa0JBQU0sSUFBSTJELEtBQUosQ0FBVTdELHFCQUFxQixDQUFDK0ksU0FBRCxDQUEvQixDQUFOO0FBQ0g7O0FBRUQsZ0JBQU1oQixXQUFXLEdBQUdRLGtCQUFrQixDQUFDWCxNQUFELEVBQVNDLFlBQVQsRUFBdUIzSCxFQUF2QixFQUEyQnNJLGtCQUEzQixFQUErQ3JFLEdBQS9DLEVBQW9EM0QsTUFBcEQsQ0FBdEM7QUFDQSxjQUFJdUgsV0FBSixFQUFpQixPQUFPQSxXQUFQO0FBQ2pCO0FBQ0g7QUFDSjs7QUFFRCxVQUFJZ0IsU0FBUyxDQUFDLENBQUQsQ0FBVCxLQUFpQixHQUFyQixFQUEwQjtBQUN0QixZQUFJQyxDQUFDLEdBQUcsQ0FBSixJQUFTRCxTQUFTLENBQUMsQ0FBRCxDQUFULEtBQWlCLEdBQTlCLEVBQW1DO0FBQy9CQSxVQUFBQSxTQUFTLEdBQUdBLFNBQVMsQ0FBQ0csTUFBVixDQUFpQixDQUFqQixDQUFaO0FBR0EsZ0JBQU1sRCxNQUFNLEdBQUc3QixHQUFHLENBQUN1RCxpQkFBSixDQUFzQnZDLEdBQXRCLENBQTBCNEQsU0FBMUIsQ0FBZjs7QUFDQSxjQUFJLENBQUMvQyxNQUFMLEVBQWE7QUFDVCxrQkFBTSxJQUFJbkMsS0FBSixDQUFVL0Qsc0JBQXNCLENBQUNpSixTQUFELENBQWhDLENBQU47QUFDSDs7QUFFRCxjQUFJLENBQUMvQyxNQUFNLENBQUMsQ0FBRCxDQUFYLEVBQWdCO0FBQ1osa0JBQU0sSUFBSW5DLEtBQUosQ0FBVXhELGlCQUFWLENBQU47QUFDSDs7QUFFRCxnQkFBTThJLFdBQVcsR0FBRzlCLGFBQWEsQ0FBQ08sTUFBRCxFQUFTNUIsTUFBTSxDQUFDLENBQUQsQ0FBZixFQUFvQjdCLEdBQXBCLEVBQXlCM0QsTUFBekIsQ0FBakM7QUFDQSxnQkFBTXVILFdBQVcsR0FBR3pELEtBQUssQ0FBQzZFLFdBQUQsRUFBY1gsa0JBQWQsRUFBa0NyRSxHQUFsQyxFQUF1Q3dCLFlBQVksQ0FBQ0ksV0FBVyxDQUFDQyxNQUFELENBQVosRUFBc0J4RixNQUF0QixDQUFuRCxDQUF6Qjs7QUFFQSxjQUFJLENBQUN1SCxXQUFXLENBQUMsQ0FBRCxDQUFoQixFQUFxQjtBQUNqQixtQkFBT0EsV0FBUDtBQUNIOztBQUVEO0FBQ0g7O0FBR0QsY0FBTTdILEVBQUUsR0FBR2lFLEdBQUcsQ0FBQ3NELGNBQUosQ0FBbUJ0QyxHQUFuQixDQUF1QjRELFNBQXZCLENBQVg7O0FBQ0EsWUFBSSxDQUFDN0ksRUFBTCxFQUFTO0FBQ0wsZ0JBQU0sSUFBSTJELEtBQUosQ0FBVTdELHFCQUFxQixDQUFDK0ksU0FBRCxDQUEvQixDQUFOO0FBQ0g7O0FBRUQsWUFBSSxDQUFDbEMsSUFBSSxDQUFDZSxNQUFELEVBQVMxSCxFQUFULEVBQWFzSSxrQkFBYixFQUFpQ3JFLEdBQWpDLEVBQXNDM0QsTUFBdEMsQ0FBVCxFQUF3RDtBQUNwRCxpQkFBTyxDQUNILEtBREcsRUFFSGdHLHVCQUF1QixDQUFDckMsR0FBRCxFQUFNakUsRUFBTixFQUFVLElBQVYsRUFBZ0IwSCxNQUFoQixFQUF3Qlksa0JBQXhCLEVBQTRDaEksTUFBNUMsQ0FGcEIsQ0FBUDtBQUlIOztBQUVEO0FBQ0g7QUFDSjs7QUFFRCxRQUFJLENBQUNzSSxlQUFMLEVBQXNCO0FBQ2xCLFVBQUlsQixNQUFNLElBQUksSUFBZCxFQUFvQixPQUFPLENBQ3ZCLEtBRHVCLEVBRXZCekQsR0FBRyxDQUFDeUMsb0JBQUosQ0FBeUJ2RixTQUF6QixDQUFtQyxJQUFuQyxFQUF5QyxJQUF6QyxFQUErQyxJQUEvQyxFQUFxRGIsTUFBckQsQ0FGdUIsQ0FBUDtBQUtwQixZQUFNNEksVUFBVSxHQUFHLE9BQU94QixNQUExQjtBQUVBLFVBQUl3QixVQUFVLEtBQUssUUFBbkIsRUFBNkIsT0FBTyxDQUNoQyxLQURnQyxFQUVoQ2pGLEdBQUcsQ0FBQ3lDLG9CQUFKLENBQXlCcEYsT0FBekIsQ0FBaUMsSUFBakMsRUFBdUM0SCxVQUF2QyxFQUFtRCxRQUFuRCxFQUE2RDVJLE1BQTdELENBRmdDLENBQVA7QUFJaEM7O0FBRURzSSxJQUFBQSxlQUFlLEdBQUcsSUFBbEI7O0FBRUEsUUFBSU8sZ0JBQWdCLEdBQUc1SixDQUFDLENBQUMwRixHQUFGLENBQU15QyxNQUFOLEVBQWNtQixTQUFkLENBQXZCOztBQUVBLFFBQUlQLGtCQUFrQixJQUFJLElBQXRCLElBQThCLE9BQU9BLGtCQUFQLEtBQThCLFFBQWhFLEVBQTBFO0FBQ3RFLFlBQU0sQ0FBRWMsRUFBRixFQUFNQyxNQUFOLElBQWlCakYsS0FBSyxDQUFDK0UsZ0JBQUQsRUFBbUJiLGtCQUFuQixFQUF1Q3JFLEdBQXZDLEVBQTRDd0IsWUFBWSxDQUFDb0QsU0FBRCxFQUFZdkksTUFBWixDQUF4RCxDQUE1Qjs7QUFDQSxVQUFJLENBQUM4SSxFQUFMLEVBQVM7QUFDTCxlQUFPLENBQUUsS0FBRixFQUFTQyxNQUFULENBQVA7QUFDSDtBQUNKLEtBTEQsTUFLTztBQUNILFVBQUksQ0FBQzFDLElBQUksQ0FBQ3dDLGdCQUFELEVBQW1CLFVBQW5CLEVBQStCYixrQkFBL0IsRUFBbURyRSxHQUFuRCxFQUF3RDNELE1BQXhELENBQVQsRUFBMEU7QUFDdEUsZUFBTyxDQUNILEtBREcsRUFFSDJELEdBQUcsQ0FBQ3lDLG9CQUFKLENBQXlCL0YsUUFBekIsQ0FBa0NrSSxTQUFsQyxFQUE2Q00sZ0JBQTdDLEVBQStEYixrQkFBL0QsRUFBbUZoSSxNQUFuRixDQUZHLENBQVA7QUFJSDtBQUNKO0FBQ0o7O0FBRUQsU0FBTyxDQUFDLElBQUQsQ0FBUDtBQUNIOztBQWdCRCxTQUFTK0UsWUFBVCxDQUFzQmdDLFlBQXRCLEVBQW9DaUMsSUFBcEMsRUFBMENyRixHQUExQyxFQUErQzNELE1BQS9DLEVBQXVEMkcsT0FBdkQsRUFBZ0U7QUFDNURoRCxFQUFBQSxHQUFHLElBQUksSUFBUCxLQUFnQkEsR0FBRyxHQUFHcUQsaUJBQXRCOztBQUNBLE1BQUk3RCxLQUFLLENBQUNDLE9BQU4sQ0FBYzRGLElBQWQsQ0FBSixFQUF5QjtBQUNyQixXQUFPQSxJQUFJLENBQUM3RSxNQUFMLENBQVksQ0FBQzhFLE1BQUQsRUFBU0MsUUFBVCxLQUFzQm5FLFlBQVksQ0FBQ2tFLE1BQUQsRUFBU0MsUUFBVCxFQUFtQnZGLEdBQW5CLEVBQXdCM0QsTUFBeEIsRUFBZ0MyRyxPQUFoQyxDQUE5QyxFQUF3RkksWUFBeEYsQ0FBUDtBQUNIOztBQUVELFFBQU1vQyxRQUFRLEdBQUcsT0FBT0gsSUFBeEI7O0FBRUEsTUFBSUcsUUFBUSxLQUFLLFNBQWpCLEVBQTRCO0FBQ3hCLFdBQU9ILElBQUksR0FBR2pDLFlBQUgsR0FBa0JlLFNBQTdCO0FBQ0g7O0FBRUQsTUFBSXFCLFFBQVEsS0FBSyxRQUFqQixFQUEyQjtBQUN2QixRQUFJSCxJQUFJLENBQUNJLFVBQUwsQ0FBZ0IsSUFBaEIsQ0FBSixFQUEyQjtBQUV2QixZQUFNQyxHQUFHLEdBQUdMLElBQUksQ0FBQzVELE9BQUwsQ0FBYSxHQUFiLENBQVo7O0FBQ0EsVUFBSWlFLEdBQUcsS0FBSyxDQUFDLENBQWIsRUFBZ0I7QUFDWixlQUFPMUMsT0FBTyxDQUFDcUMsSUFBRCxDQUFkO0FBQ0g7O0FBRUQsYUFBTy9KLENBQUMsQ0FBQzBGLEdBQUYsQ0FBTWdDLE9BQU8sQ0FBQ3FDLElBQUksQ0FBQ04sTUFBTCxDQUFZLENBQVosRUFBZVcsR0FBZixDQUFELENBQWIsRUFBb0NMLElBQUksQ0FBQ04sTUFBTCxDQUFZVyxHQUFHLEdBQUMsQ0FBaEIsQ0FBcEMsQ0FBUDtBQUNIOztBQUVELFVBQU03RCxNQUFNLEdBQUc3QixHQUFHLENBQUN1RCxpQkFBSixDQUFzQnZDLEdBQXRCLENBQTBCcUUsSUFBMUIsQ0FBZjs7QUFDQSxRQUFJLENBQUN4RCxNQUFMLEVBQWE7QUFDVCxZQUFNLElBQUluQyxLQUFKLENBQVUvRCxzQkFBc0IsQ0FBQzBKLElBQUQsQ0FBaEMsQ0FBTjtBQUNIOztBQUVELFFBQUksQ0FBQ3hELE1BQU0sQ0FBQyxDQUFELENBQVgsRUFBZ0I7QUFDWixZQUFNLElBQUluQyxLQUFKLENBQVVqRCxxQkFBcUIsQ0FBQzRJLElBQUQsQ0FBL0IsQ0FBTjtBQUNIOztBQUVELFdBQU9uQyxhQUFhLENBQUNFLFlBQUQsRUFBZXZCLE1BQU0sQ0FBQyxDQUFELENBQXJCLEVBQTBCN0IsR0FBMUIsRUFBK0IzRCxNQUEvQixDQUFwQjtBQUNIOztBQUVELE1BQUkyRyxPQUFPLElBQUksSUFBZixFQUFxQjtBQUNqQkEsSUFBQUEsT0FBTyxHQUFHO0FBQUUyQyxNQUFBQSxNQUFNLEVBQUV2QyxZQUFWO0FBQXdCd0MsTUFBQUEsUUFBUSxFQUFFLElBQWxDO0FBQXdDQyxNQUFBQSxTQUFTLEVBQUV6QztBQUFuRCxLQUFWO0FBQ0gsR0FGRCxNQUVPO0FBQ0hKLElBQUFBLE9BQU8sR0FBRyxFQUFFLEdBQUdBLE9BQUw7QUFBYzRDLE1BQUFBLFFBQVEsRUFBRTVDLE9BQU8sQ0FBQzZDLFNBQWhDO0FBQTJDQSxNQUFBQSxTQUFTLEVBQUV6QztBQUF0RCxLQUFWO0FBQ0g7O0FBRUQsTUFBSWtDLE1BQUo7QUFBQSxNQUFZUSxXQUFXLEdBQUcsS0FBMUI7O0FBRUEsT0FBSyxJQUFJbEIsU0FBVCxJQUFzQlMsSUFBdEIsRUFBNEI7QUFDeEIsUUFBSWhCLGtCQUFrQixHQUFHZ0IsSUFBSSxDQUFDVCxTQUFELENBQTdCO0FBRUEsVUFBTUMsQ0FBQyxHQUFHRCxTQUFTLENBQUNFLE1BQXBCOztBQUVBLFFBQUlELENBQUMsR0FBRyxDQUFSLEVBQVc7QUFDUCxVQUFJRCxTQUFTLENBQUMsQ0FBRCxDQUFULEtBQWlCLEdBQXJCLEVBQTBCO0FBQ3RCLFlBQUlVLE1BQUosRUFBWTtBQUNSLGdCQUFNLElBQUk1RixLQUFKLENBQVVoRSxrQkFBVixDQUFOO0FBQ0g7O0FBRUQsY0FBTW1HLE1BQU0sR0FBRzdCLEdBQUcsQ0FBQ3VELGlCQUFKLENBQXNCdkMsR0FBdEIsQ0FBMEI0RCxTQUExQixDQUFmOztBQUNBLFlBQUksQ0FBQy9DLE1BQUwsRUFBYTtBQUNULGdCQUFNLElBQUluQyxLQUFKLENBQVUvRCxzQkFBc0IsQ0FBQ2lKLFNBQUQsQ0FBaEMsQ0FBTjtBQUNIOztBQUVEVSxRQUFBQSxNQUFNLEdBQUduQyxnQkFBZ0IsQ0FBQ0MsWUFBRCxFQUFlaUIsa0JBQWYsRUFBbUN4QyxNQUFuQyxFQUEyQzdCLEdBQTNDLEVBQWdEM0QsTUFBaEQsRUFBd0QyRyxPQUF4RCxDQUF6QjtBQUNBOEMsUUFBQUEsV0FBVyxHQUFHLElBQWQ7QUFDQTtBQUNIOztBQUVELFVBQUlqQixDQUFDLEdBQUcsQ0FBSixJQUFTRCxTQUFTLENBQUMsQ0FBRCxDQUFULEtBQWlCLEdBQTFCLElBQWlDQSxTQUFTLENBQUMsQ0FBRCxDQUFULEtBQWlCLEdBQXRELEVBQTJEO0FBQ3ZELFlBQUlVLE1BQUosRUFBWTtBQUNSLGdCQUFNLElBQUk1RixLQUFKLENBQVVoRSxrQkFBVixDQUFOO0FBQ0g7O0FBRUQsY0FBTWdJLFlBQVksR0FBR2tCLFNBQVMsQ0FBQ0csTUFBVixDQUFpQixDQUFqQixFQUFvQixDQUFwQixDQUFyQjtBQUNBSCxRQUFBQSxTQUFTLEdBQUdBLFNBQVMsQ0FBQ0csTUFBVixDQUFpQixDQUFqQixDQUFaO0FBRUEsY0FBTWxELE1BQU0sR0FBRzdCLEdBQUcsQ0FBQ3VELGlCQUFKLENBQXNCdkMsR0FBdEIsQ0FBMEI0RCxTQUExQixDQUFmOztBQUNBLFlBQUksQ0FBQy9DLE1BQUwsRUFBYTtBQUNULGdCQUFNLElBQUluQyxLQUFKLENBQVUvRCxzQkFBc0IsQ0FBQ2lKLFNBQUQsQ0FBaEMsQ0FBTjtBQUNIOztBQUVEVSxRQUFBQSxNQUFNLEdBQUdiLGtCQUFrQixDQUFDckIsWUFBRCxFQUFlTSxZQUFmLEVBQTZCN0IsTUFBN0IsRUFBcUN3QyxrQkFBckMsRUFBeURyRSxHQUF6RCxFQUE4RDNELE1BQTlELENBQTNCO0FBQ0F5SixRQUFBQSxXQUFXLEdBQUcsSUFBZDtBQUNBO0FBQ0g7QUFDSjs7QUFFRCxRQUFJQSxXQUFKLEVBQWlCO0FBQ2IsWUFBTSxJQUFJcEcsS0FBSixDQUFVaEUsa0JBQVYsQ0FBTjtBQUNIOztBQUdELFFBQUl3SixnQkFBZ0IsR0FBRzlCLFlBQVksSUFBSSxJQUFoQixHQUF1QjlILENBQUMsQ0FBQzBGLEdBQUYsQ0FBTW9DLFlBQU4sRUFBb0J3QixTQUFwQixDQUF2QixHQUF3RFQsU0FBL0U7QUFFQSxVQUFNNEIsZUFBZSxHQUFHM0UsWUFBWSxDQUFDOEQsZ0JBQUQsRUFBbUJiLGtCQUFuQixFQUF1Q3JFLEdBQXZDLEVBQTRDd0IsWUFBWSxDQUFDb0QsU0FBRCxFQUFZdkksTUFBWixDQUF4RCxFQUE2RTJHLE9BQTdFLENBQXBDOztBQUNBLFFBQUksT0FBTytDLGVBQVAsS0FBMkIsV0FBL0IsRUFBNEM7QUFDeENULE1BQUFBLE1BQU0sR0FBRyxFQUNMLEdBQUdBLE1BREU7QUFFTCxTQUFDVixTQUFELEdBQWFtQjtBQUZSLE9BQVQ7QUFJSDtBQUNKOztBQUVELFNBQU9ULE1BQVA7QUFDSDs7QUFFRCxNQUFNVSxHQUFOLENBQVU7QUFDTkMsRUFBQUEsV0FBVyxDQUFDdEQsS0FBRCxFQUFRdUQsVUFBUixFQUFvQjtBQUMzQixTQUFLdkQsS0FBTCxHQUFhQSxLQUFiO0FBQ0EsU0FBS3VELFVBQUwsR0FBa0JBLFVBQWxCO0FBQ0g7O0FBT0QvRixFQUFBQSxLQUFLLENBQUN1RSxRQUFELEVBQVc7QUFDWixVQUFNWSxNQUFNLEdBQUduRixLQUFLLENBQUMsS0FBS3dDLEtBQU4sRUFBYStCLFFBQWIsRUFBdUIsS0FBS3dCLFVBQTVCLENBQXBCO0FBQ0EsUUFBSVosTUFBTSxDQUFDLENBQUQsQ0FBVixFQUFlLE9BQU8sSUFBUDtBQUVmLFVBQU0sSUFBSTdKLGVBQUosQ0FBb0I2SixNQUFNLENBQUMsQ0FBRCxDQUExQixFQUErQjtBQUNqQzdCLE1BQUFBLE1BQU0sRUFBRSxLQUFLZCxLQURvQjtBQUVqQytCLE1BQUFBO0FBRmlDLEtBQS9CLENBQU47QUFJSDs7QUFFRDNCLEVBQUFBLFFBQVEsQ0FBQ3NDLElBQUQsRUFBTztBQUNYLFdBQU9qRSxZQUFZLENBQUMsS0FBS3VCLEtBQU4sRUFBYTBDLElBQWIsRUFBbUIsS0FBS2EsVUFBeEIsQ0FBbkI7QUFDSDs7QUFFREMsRUFBQUEsTUFBTSxDQUFDZCxJQUFELEVBQU87QUFDVCxVQUFNMUMsS0FBSyxHQUFHdkIsWUFBWSxDQUFDLEtBQUt1QixLQUFOLEVBQWEwQyxJQUFiLEVBQW1CLEtBQUthLFVBQXhCLENBQTFCO0FBQ0EsU0FBS3ZELEtBQUwsR0FBYUEsS0FBYjtBQUNBLFdBQU8sSUFBUDtBQUNIOztBQTdCSzs7QUFnQ1ZxRCxHQUFHLENBQUM3RixLQUFKLEdBQVlBLEtBQVo7QUFDQTZGLEdBQUcsQ0FBQ2pELFFBQUosR0FBZTNCLFlBQWY7QUFDQTRFLEdBQUcsQ0FBQzNDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQStDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHt0b2tlbn1cIi5gO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9IQU5ETEVSID0gb3AgPT4gYEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9IQU5MREVSID0gb3AgPT4gYEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHtvcH1cIiBoYW5kbGVyIG5vdCBmb3VuZC5gO1xuY29uc3QgTk9UX0FfVFdPX1RVUExFID0gJ1RoZSB2YWx1ZSBvZiBjb2xsZWN0aW9uIG9wZXJhdG9yIHNob3VsZCBiZSBhIHR3by10dXBsZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfQVJSQVkgPSBvcCA9PiBgVGhlIHJpZ2h0IG9wZXJhbmQgb2YgSkVTIG9wZXJhdG9yIFwiJHtvcH1cIiBzaG91bGQgYmUgYW4gYXJyYXkuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX0JPT0w9IG9wID0+IGBUaGUgcmlnaHQgb3BlcmFuZCBvZiBKRVMgb3BlcmF0b3IgXCIke29wfVwiIHNob3VsZCBiZSBhIGJvb2xlYW4gdmFsdWUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1NUUklORz0gb3AgPT4gYFRoZSByaWdodCBvcGVyYW5kIG9mIEpFUyBvcGVyYXRvciBcIiR7b3B9XCIgc2hvdWxkIGJlIGEgc3RyaW5nLmA7XG5cbmNvbnN0IFJFUVVJUkVfUklHSFRfT1BFUkFORCA9IG9wID0+IGBCaW5hcnkgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIHJlcXVpcmVzIHRoZSByaWdodCBvcGVyYW5kLmBcblxuLy9Db25kaXRpb24gb3BlcmF0b3JcbmNvbnN0IE9QX0VRVUFMID0gWyAnJGVxJywgJyRlcWwnLCAnJGVxdWFsJyBdO1xuY29uc3QgT1BfTk9UX0VRVUFMID0gWyAnJG5lJywgJyRuZXEnLCAnJG5vdEVxdWFsJyBdO1xuXG5jb25zdCBPUF9HUkVBVEVSX1RIQU4gPSBbICckZ3QnLCAnJD4nLCAnJGdyZWF0ZXJUaGFuJyBdO1xuY29uc3QgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMID0gWyAnJGd0ZScsICckPD0nLCAnJGdyZWF0ZXJUaGFuT3JFcXVhbCcgXTtcblxuY29uc3QgT1BfTEVTU19USEFOID0gWyAnJGx0JywgJyQ8JywgJyRsZXNzVGhhbicgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTl9PUl9FUVVBTCA9IFsgJyRsdGUnLCAnJDw9JywgJyRsZXNzVGhhbk9yRXF1YWwnIF07XG5cbmNvbnN0IE9QX0lOID0gWyAnJGluJyBdO1xuY29uc3QgT1BfTk9UX0lOID0gWyAnJG5pbicsICckbm90SW4nIF07XG5cbmNvbnN0IE9QX0VYSVNUUyA9IFsgJyRleGlzdCcsICckZXhpc3RzJyBdO1xuXG5jb25zdCBPUF9NQVRDSCA9IFsgJyRoYXMnLCAnJG1hdGNoJywgJyRhbGwnIF07XG5cbmNvbnN0IE9QX01BVENIX0FOWSA9IFsgJyRhbnknLCAnJG9yJywgJyRlaXRoZXInIF07XG5cbmNvbnN0IE9QX1RZUEUgPSBbICckaXMnLCAnJHR5cGVPZicgXTtcblxuY29uc3QgT1BfSEFTX0tFWVMgPSBbICckaGFzS2V5cycsICckd2l0aEtleXMnIF07XG5cbi8vUXVlcnkgJiBhZ2dyZWdhdGUgb3BlcmF0b3JcbmNvbnN0IE9QX1NJWkUgPSBbICckc2l6ZScsICckbGVuZ3RoJywgJyRjb3VudCcgXTtcbmNvbnN0IE9QX1NVTSA9IFsgJyRzdW0nLCAnJHRvdGFsJyBdO1xuY29uc3QgT1BfS0VZUyA9IFsgJyRrZXlzJyBdO1xuY29uc3QgT1BfVkFMVUVTID0gWyAnJHZhbHVlcycgXTtcbmNvbnN0IE9QX0dFVF9UWVBFID0gWyAnJHR5cGUnIF07XG5cbi8vTWFuaXB1bGF0ZSBvcGVyYXRpb25cbmNvbnN0IE9QX0FERCA9IFsgJyRhZGQnLCAnJHBsdXMnLCAgICAgJyRpbmMnIF07XG5jb25zdCBPUF9TVUIgPSBbICckc3ViJywgJyRzdWJ0cmFjdCcsICckbWludXMnLCAnJGRlYycgXTtcbmNvbnN0IE9QX01VTCA9IFsgJyRtdWwnLCAnJG11bHRpcGx5JywgICckdGltZXMnIF07XG5jb25zdCBPUF9ESVYgPSBbICckZGl2JywgJyRkaXZpZGUnIF07XG5jb25zdCBPUF9TRVQgPSBbICckc2V0JywgJyQ9JyBdO1xuXG5jb25zdCBPUF9QSUNLID0gWyAnJHBpY2snIF07XG5jb25zdCBPUF9HRVRfQllfSU5ERVggPSBbICckYXQnLCAnJGdldEJ5SW5kZXgnLCAnJG50aCcgXTtcbmNvbnN0IE9QX0dFVF9CWV9LRVkgPSBbICckb2YnLCAnJGdldEJ5S2V5JyBdO1xuY29uc3QgT1BfT01JVCA9IFsgJyRvbWl0JyBdO1xuY29uc3QgT1BfR1JPVVAgPSBbICckZ3JvdXAnLCAnJGdyb3VwQnknIF07XG5jb25zdCBPUF9TT1JUID0gWyAnJHNvcnQnLCAnJG9yZGVyQnknLCAnJHNvcnRCeScgXTtcbmNvbnN0IE9QX1JFVkVSU0UgPSBbICckcmV2ZXJzZScgXTtcbmNvbnN0IE9QX0VWQUwgPSBbICckZXZhbCcsICckYXBwbHknIF07XG5cbmNvbnN0IFBGWF9GT1JfRUFDSCA9ICd8Pic7IC8vIGZvciBlYWNoXG5jb25zdCBQRlhfV0lUSF9BTlkgPSAnfConOyAvLyB3aXRoIGFueVxuXG5jb25zdCBNYXBPZk9wcyA9IG5ldyBNYXAoKTtcbmNvbnN0IGFkZE9wVG9NYXAgPSAodG9rZW5zLCB0YWcpID0+IHRva2Vucy5mb3JFYWNoKHRva2VuID0+IE1hcE9mT3BzLnNldCh0b2tlbiwgdGFnKSk7XG5hZGRPcFRvTWFwKE9QX0VRVUFMLCAnT1BfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTk9UX0VRVUFMLCAnT1BfTk9UX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTiwgJ09QX0dSRUFURVJfVEhBTicpO1xuYWRkT3BUb01hcChPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwsICdPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOLCAnT1BfTEVTU19USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0xFU1NfVEhBTl9PUl9FUVVBTCwgJ09QX0xFU1NfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9JTiwgJ09QX0lOJyk7XG5hZGRPcFRvTWFwKE9QX05PVF9JTiwgJ09QX05PVF9JTicpO1xuYWRkT3BUb01hcChPUF9FWElTVFMsICdPUF9FWElTVFMnKTtcbmFkZE9wVG9NYXAoT1BfTUFUQ0gsICdPUF9NQVRDSCcpO1xuYWRkT3BUb01hcChPUF9NQVRDSF9BTlksICdPUF9NQVRDSF9BTlknKTtcbmFkZE9wVG9NYXAoT1BfVFlQRSwgJ09QX1RZUEUnKTtcbmFkZE9wVG9NYXAoT1BfSEFTX0tFWVMsICdPUF9IQVNfS0VZUycpO1xuXG5jb25zdCBNYXBPZk1hbnMgPSBuZXcgTWFwKCk7XG5jb25zdCBhZGRNYW5Ub01hcCA9ICh0b2tlbnMsIHRhZykgPT4gdG9rZW5zLmZvckVhY2godG9rZW4gPT4gTWFwT2ZNYW5zLnNldCh0b2tlbiwgdGFnKSk7XG4vLyBbIDxvcCBuYW1lPiwgPHVuYXJ5PiBdXG5hZGRNYW5Ub01hcChPUF9TSVpFLCBbJ09QX1NJWkUnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1NVTSwgWydPUF9TVU0nLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX0tFWVMsIFsnT1BfS0VZUycsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfVkFMVUVTLCBbJ09QX1ZBTFVFUycsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfR0VUX1RZUEUsIFsnT1BfR0VUX1RZUEUnLCB0cnVlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1JFVkVSU0UsIFsnT1BfUkVWRVJTRScsIHRydWVdKTtcblxuYWRkTWFuVG9NYXAoT1BfQURELCBbJ09QX0FERCcsIGZhbHNlIF0pOyBcbmFkZE1hblRvTWFwKE9QX1NVQiwgWydPUF9TVUInLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX01VTCwgWydPUF9NVUwnLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX0RJViwgWydPUF9ESVYnLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX1NFVCwgWydPUF9TRVQnLCBmYWxzZSBdKTtcbmFkZE1hblRvTWFwKE9QX1BJQ0ssIFsnT1BfUElDSycsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HRVRfQllfSU5ERVgsIFsnT1BfR0VUX0JZX0lOREVYJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9LRVksIFsnT1BfR0VUX0JZX0tFWScsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9PTUlULCBbJ09QX09NSVQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR1JPVVAsIFsnT1BfR1JPVVAnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfU09SVCwgWydPUF9TT1JUJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0VWQUwsIFsnT1BfRVZBTCcsIGZhbHNlXSk7XG5cbmNvbnN0IGRlZmF1bHRKZXNIYW5kbGVycyA9IHtcbiAgICBPUF9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBfLmlzRXF1YWwobGVmdCwgcmlnaHQpLFxuICAgIE9QX05PVF9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiAhXy5pc0VxdWFsKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HUkVBVEVSX1RIQU46IChsZWZ0LCByaWdodCkgPT4gbGVmdCA+IHJpZ2h0LFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ID49IHJpZ2h0LFxuICAgIE9QX0xFU1NfVEhBTjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IDwgcmlnaHQsXG4gICAgT1BfTEVTU19USEFOX09SX0VRVUFMOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPD0gcmlnaHQsXG4gICAgT1BfSU46IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAocmlnaHQgPT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX0lOJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJpZ2h0LmZpbmQoZWxlbWVudCA9PiBkZWZhdWx0SmVzSGFuZGxlcnMuT1BfRVFVQUwobGVmdCwgZWxlbWVudCkpO1xuICAgIH0sXG4gICAgT1BfTk9UX0lOOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHJpZ2h0ID09IG51bGwpIHJldHVybiB0cnVlO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX05PVF9JTicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBlbGVtZW50ID0+IGRlZmF1bHRKZXNIYW5kbGVycy5PUF9OT1RfRVFVQUwobGVmdCwgZWxlbWVudCkpO1xuICAgIH0sXG4gICAgT1BfRVhJU1RTOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByaWdodCAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQk9PTCgnT1BfRVhJU1RTJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJpZ2h0ID8gbGVmdCAhPSBudWxsIDogbGVmdCA9PSBudWxsO1xuICAgIH0sXG4gICAgT1BfVFlQRTogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfU1RSSU5HKCdPUF9UWVBFJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmlnaHQgPSByaWdodC50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ2FycmF5Jykge1xuICAgICAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkobGVmdCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKHJpZ2h0ID09PSAnaW50ZWdlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmlzSW50ZWdlcihsZWZ0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICByZXR1cm4gdHlwZW9mIGxlZnQgPT09ICdzdHJpbmcnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHR5cGVvZiBsZWZ0ID09PSByaWdodDtcbiAgICB9LFxuICAgIE9QX01BVENIOiAobGVmdCwgcmlnaHQsIGplcywgcHJlZml4KSA9PiB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkocmlnaHQsIHJ1bGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCBydWxlLCBqZXMsIHByZWZpeCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHIgPSBtYXRjaChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpO1xuICAgICAgICByZXR1cm4gclswXTtcbiAgICB9LFxuICAgIE9QX01BVENIX0FOWTogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmlnaHQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFORF9OT1RfQVJSQVkoJ09QX01BVENIX0FOWScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyaWdodCwgcnVsZSA9PiB7XG4gICAgICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcnVsZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgICAgIH0pOyAgIFxuICAgIFxuICAgICAgICByZXR1cm4gZm91bmQgPyB0cnVlIDogZmFsc2U7XG4gICAgfSxcbiAgICBPUF9IQVNfS0VZUzogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgbGVmdCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBrZXkgPT4gaGFzS2V5QnlQYXRoKGxlZnQsIGtleSkpO1xuICAgIH0gICAgXG59O1xuXG5jb25zdCBkZWZhdWx0TWFuaXB1bGF0aW9ucyA9IHtcbiAgICAvL3VuYXJ5XG4gICAgT1BfU0laRTogKGxlZnQpID0+IF8uc2l6ZShsZWZ0KSxcbiAgICBPUF9TVU06IChsZWZ0KSA9PiBfLnJlZHVjZShsZWZ0LCAoc3VtLCBpdGVtKSA9PiB7XG4gICAgICAgICAgICBzdW0gKz0gaXRlbTtcbiAgICAgICAgICAgIHJldHVybiBzdW07XG4gICAgICAgIH0sIDApLFxuXG4gICAgT1BfS0VZUzogKGxlZnQpID0+IF8ua2V5cyhsZWZ0KSxcbiAgICBPUF9WQUxVRVM6IChsZWZ0KSA9PiBfLnZhbHVlcyhsZWZ0KSwgICBcbiAgICBPUF9HRVRfVFlQRTogKGxlZnQpID0+IEFycmF5LmlzQXJyYXkobGVmdCkgPyAnYXJyYXknIDogKF8uaXNJbnRlZ2VyKGxlZnQpID8gJ2ludGVnZXInIDogdHlwZW9mIGxlZnQpLCAgXG4gICAgT1BfUkVWRVJTRTogKGxlZnQpID0+IF8ucmV2ZXJzZShsZWZ0KSxcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgKyByaWdodCxcbiAgICBPUF9TVUI6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAtIHJpZ2h0LFxuICAgIE9QX01VTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ICogcmlnaHQsXG4gICAgT1BfRElWOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgLyByaWdodCwgXG4gICAgT1BfU0VUOiAobGVmdCwgcmlnaHQpID0+IHJpZ2h0LCBcbiAgICBPUF9QSUNLOiAobGVmdCwgcmlnaHQpID0+IF8ucGljayhsZWZ0LCByaWdodCksXG4gICAgT1BfR0VUX0JZX0lOREVYOiAobGVmdCwgcmlnaHQpID0+IF8ubnRoKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9HRVRfQllfS0VZOiAobGVmdCwgcmlnaHQpID0+IF8uZ2V0KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9PTUlUOiAobGVmdCwgcmlnaHQpID0+IF8ub21pdChsZWZ0LCByaWdodCksXG4gICAgT1BfR1JPVVA6IChsZWZ0LCByaWdodCkgPT4gXy5ncm91cEJ5KGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9TT1JUOiAobGVmdCwgcmlnaHQpID0+IF8uc29ydEJ5KGxlZnQsIHJpZ2h0KSwgIFxuICAgIE9QX0VWQUw6IGV2YWx1YXRlRXhwcixcbn1cblxuY29uc3QgZm9ybWF0TmFtZSA9IChuYW1lLCBwcmVmaXgpID0+IHtcbiAgICBjb25zdCBmdWxsTmFtZSA9IG5hbWUgPT0gbnVsbCA/IHByZWZpeCA6IGZvcm1hdFByZWZpeChuYW1lLCBwcmVmaXgpO1xuICAgIHJldHVybiBmdWxsTmFtZSA9PSBudWxsID8gXCJUaGUgdmFsdWVcIiA6IChmdWxsTmFtZS5pbmRleE9mKCcoJykgIT09IC0xID8gYFRoZSBxdWVyeSBcIl8uJHtmdWxsTmFtZX1cImAgOiBgXCIke2Z1bGxOYW1lfVwiYCk7XG59O1xuY29uc3QgZm9ybWF0S2V5ID0gKGtleSwgaGFzUHJlZml4KSA9PiBfLmlzSW50ZWdlcihrZXkpID8gYFske2tleX1dYCA6IChoYXNQcmVmaXggPyAnLicgKyBrZXkgOiBrZXkpO1xuY29uc3QgZm9ybWF0UHJlZml4ID0gKGtleSwgcHJlZml4KSA9PiBwcmVmaXggIT0gbnVsbCA/IGAke3ByZWZpeH0ke2Zvcm1hdEtleShrZXksIHRydWUpfWAgOiBmb3JtYXRLZXkoa2V5LCBmYWxzZSk7XG5jb25zdCBmb3JtYXRRdWVyeSA9IChvcE1ldGEpID0+IGAke2RlZmF1bHRRdWVyeUV4cGxhbmF0aW9uc1tvcE1ldGFbMF1dfSgke29wTWV0YVsxXSA/ICcnIDogJz8nfSlgOyAgXG5jb25zdCBmb3JtYXRNYXAgPSAobmFtZSkgPT4gYGVhY2goLT4ke25hbWV9KWA7XG5jb25zdCBmb3JtYXRBbnkgPSAobmFtZSkgPT4gYGFueSgtPiR7bmFtZX0pYDtcblxuY29uc3QgZGVmYXVsdEplc0V4cGxhbmF0aW9ucyA9IHtcbiAgICBPUF9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgZ3JlYXRlciB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0xFU1NfVEhBTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGxlc3MgdGhhbiAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOX09SX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuIG9yIGVxdWFsIHRvICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIG9uZSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX05PVF9JTjogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG5vdCBiZSBhbnkgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfRVhJU1RTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQke3JpZ2h0ID8gJyBub3QgJzogJyAnfWJlIE5VTEwuYCwgICAgXG4gICAgT1BfVFlQRTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGBUaGUgdHlwZSBvZiAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIFwiJHtyaWdodH1cIiwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgICAgICBcbiAgICBPUF9NQVRDSDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX01BVENIX0FOWTogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIG1hdGNoIGFueSBvZiAke0pTT04uc3RyaW5naWZ5KHJpZ2h0KX0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLCAgICBcbiAgICBPUF9IQVNfS0VZUzogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGhhdmUgYWxsIG9mIHRoZXNlIGtleXMgWyR7cmlnaHQuam9pbignLCAnKX1dLmAsICAgICAgICBcbn07XG5cbmNvbnN0IGRlZmF1bHRRdWVyeUV4cGxhbmF0aW9ucyA9IHtcbiAgICAvL3VuYXJ5XG4gICAgT1BfU0laRTogJ3NpemUnLFxuICAgIE9QX1NVTTogJ3N1bScsXG4gICAgT1BfS0VZUzogJ2tleXMnLFxuICAgIE9QX1ZBTFVFUzogJ3ZhbHVlcycsICAgIFxuICAgIE9QX0dFVF9UWVBFOiAnZ2V0IHR5cGUnLFxuICAgIE9QX1JFVkVSU0U6ICdyZXZlcnNlJywgXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogJ2FkZCcsXG4gICAgT1BfU1VCOiAnc3VidHJhY3QnLFxuICAgIE9QX01VTDogJ211bHRpcGx5JyxcbiAgICBPUF9ESVY6ICdkaXZpZGUnLCBcbiAgICBPUF9TRVQ6ICdhc3NpZ24nLFxuICAgIE9QX1BJQ0s6ICdwaWNrJyxcbiAgICBPUF9HRVRfQllfSU5ERVg6ICdnZXQgZWxlbWVudCBhdCBpbmRleCcsXG4gICAgT1BfR0VUX0JZX0tFWTogJ2dldCBlbGVtZW50IG9mIGtleScsXG4gICAgT1BfT01JVDogJ29taXQnLFxuICAgIE9QX0dST1VQOiAnZ3JvdXBCeScsXG4gICAgT1BfU09SVDogJ3NvcnRCeScsXG4gICAgT1BfRVZBTDogJ2V2YWx1YXRlJyxcbn07XG5cbmZ1bmN0aW9uIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KSB7XG4gICAgY29uc3QgZ2V0dGVyID0gamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zW29wXSB8fCBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfTUFUQ0g7XG4gICAgcmV0dXJuIGdldHRlcihuYW1lLCBsZWZ0VmFsdWUsIHJpZ2h0VmFsdWUsIHByZWZpeCk7ICAgIFxufVxuXG5mdW5jdGlvbiB0ZXN0KHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5vcGVyYXRvckhhbmRsZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX0hBTkxERVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZSh2YWx1ZSwgb3AsIG9wVmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlVW5hcnkodmFsdWUsIG9wLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLnF1ZXJ5SGFubGRlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX0hBTkRMRVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgcmlnaHRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIGlmIChvcE1ldGFbMV0pIHtcbiAgICAgICAgcmV0dXJuIHJpZ2h0VmFsdWUgPyBldmFsdWF0ZVVuYXJ5KGN1cnJlbnRWYWx1ZSwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCkgOiBjdXJyZW50VmFsdWU7XG4gICAgfSBcbiAgICBcbiAgICByZXR1cm4gZXZhbHVhdGUoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIHJpZ2h0VmFsdWUsIGplcywgcHJlZml4LCBjb250ZXh0KTtcbn1cblxuY29uc3QgZGVmYXVsdEN1c3RvbWl6ZXIgPSB7XG4gICAgbWFwT2ZPcGVyYXRvcnM6IE1hcE9mT3BzLFxuICAgIG1hcE9mTWFuaXB1bGF0b3JzOiBNYXBPZk1hbnMsXG4gICAgb3BlcmF0b3JIYW5kbGVyczogZGVmYXVsdEplc0hhbmRsZXJzLFxuICAgIG9wZXJhdG9yRXhwbGFuYXRpb25zOiBkZWZhdWx0SmVzRXhwbGFuYXRpb25zLFxuICAgIHF1ZXJ5SGFubGRlcnM6IGRlZmF1bHRNYW5pcHVsYXRpb25zXG59O1xuXG5mdW5jdGlvbiBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgb3BlcmFuZHMsIGplcywgcHJlZml4KSB7XG4gICAgbGV0IG1hdGNoUmVzdWx0LCBuZXh0UHJlZml4O1xuXG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCBtYXBSZXN1bHQgPSBfLmlzUGxhaW5PYmplY3QoYWN0dWFsKSA/IF8ubWFwVmFsdWVzKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpKSA6IF8ubWFwKGFjdHVhbCwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgb3BlcmFuZHNbMF0sIG9wTWV0YSwgamVzLCBmb3JtYXRQcmVmaXgoaSwgcHJlZml4KSkpO1xuICAgICAgICAgICAgbmV4dFByZWZpeCA9IGZvcm1hdFByZWZpeChmb3JtYXRNYXAoZm9ybWF0UXVlcnkob3BNZXRhKSksIHByZWZpeCk7XG4gICAgICAgICAgICBtYXRjaFJlc3VsdCA9IG1hdGNoKG1hcFJlc3VsdCwgb3BlcmFuZHNbMV0sIGplcywgbmV4dFByZWZpeCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICAgXG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdEFueShmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gbWF0Y2goZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBqZXMsIGZvcm1hdFByZWZpeChrZXksIHByZWZpeCkpLCBvcGVyYW5kc1sxXSwgamVzLCBuZXh0UHJlZml4KSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCB1bm1hdGNoZWRLZXkgPSBfLmZpbmRJbmRleChhY3R1YWwsIChpdGVtKSA9PiAhdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgICAgICBpZiAodW5tYXRjaGVkS2V5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIHVubWF0Y2hlZEtleSwgYWN0dWFsW3VubWF0Y2hlZEtleV0sIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgXG4gICAgICAgICAgICBjb25zdCBtYXRjaGVkID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgIFxuICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCwgY29udGV4dCkge1xuICAgIHN3aXRjaCAoY29sbGVjdGlvbk9wKSB7XG4gICAgICAgIGNhc2UgUEZYX0ZPUl9FQUNIOlxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGN1cnJlbnRWYWx1ZSwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIGplcywgZm9ybWF0UHJlZml4KGksIHByZWZpeCksIGNvbnRleHQpKTtcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICBcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihQUlhfT1BfTk9UX0ZPUl9FVkFMKGNvbGxlY3Rpb25PcCkpO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBcbiAqIEBwYXJhbSB7Kn0gYWN0dWFsIFxuICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAqIEBwYXJhbSB7Kn0gamVzIFxuICogQHBhcmFtIHsqfSBwcmVmaXggIFxuICogXG4gKiB7IGtleTogeyAkbWF0Y2ggfSB9XG4gKi9cbmZ1bmN0aW9uIG1hdGNoKGFjdHVhbCwgZXhwZWN0ZWQsIGplcywgcHJlZml4KSB7XG4gICAgamVzICE9IG51bGwgfHwgKGplcyA9IGRlZmF1bHRDdXN0b21pemVyKTtcbiAgICBsZXQgcGFzc09iamVjdENoZWNrID0gZmFsc2U7XG5cbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChleHBlY3RlZCkpIHtcbiAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbCwgJ09QX0VRVUFMJywgZXhwZWN0ZWQsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVFVQUwobnVsbCwgYWN0dWFsLCBleHBlY3RlZCwgcHJlZml4KSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIF07XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIFt0cnVlXTtcbiAgICB9XG5cbiAgICBmb3IgKGxldCBmaWVsZE5hbWUgaW4gZXhwZWN0ZWQpIHtcbiAgICAgICAgbGV0IGV4cGVjdGVkRmllbGRWYWx1ZSA9IGV4cGVjdGVkW2ZpZWxkTmFtZV07IFxuICAgICAgICBcbiAgICAgICAgY29uc3QgbCA9IGZpZWxkTmFtZS5sZW5ndGg7XG5cbiAgICAgICAgaWYgKGwgPiAxKSB7ICAgICBcbiAgICAgICAgICAgIGlmIChsID4gNCAmJiBmaWVsZE5hbWVbMF0gPT09ICd8JyAmJiBmaWVsZE5hbWVbMl0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbM10gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZXhwZWN0ZWRGaWVsZFZhbHVlKSAmJiBleHBlY3RlZEZpZWxkVmFsdWUubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTk9UX0FfVFdPX1RVUExFKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigzKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IG1hdGNoQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoUmVzdWx0KSByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uT3AgPSBmaWVsZE5hbWUuc3Vic3RyKDAsIDIpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3ApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IHZhbGlkYXRlQ29sbGVjdGlvbihhY3R1YWwsIGNvbGxlY3Rpb25PcCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAobCA+IDIgJiYgZmllbGROYW1lWzFdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigxKTtcblxuICAgICAgICAgICAgICAgICAgICAvL3Byb2Nlc3NvcnNcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5PVF9BX1VOQVJZX1FVRVJZKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gZXZhbHVhdGVVbmFyeShhY3R1YWwsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2gocXVlcnlSZXN1bHQsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZm9ybWF0UXVlcnkob3BNZXRhKSwgcHJlZml4KSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaFJlc3VsdFswXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdmFsaWRhdG9yXG4gICAgICAgICAgICAgICAgY29uc3Qgb3AgPSBqZXMubWFwT2ZPcGVyYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghdGVzdChhY3R1YWwsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBnZXRVbm1hdGNoZWRFeHBsYW5hdGlvbihqZXMsIG9wLCBudWxsLCBhY3R1YWwsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoIXBhc3NPYmplY3RDaGVjaykge1xuICAgICAgICAgICAgaWYgKGFjdHVhbCA9PSBudWxsKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfRVhJU1RTKG51bGwsIG51bGwsIHRydWUsIHByZWZpeClcbiAgICAgICAgICAgIF07IFxuXG4gICAgICAgICAgICBjb25zdCBhY3R1YWxUeXBlID0gdHlwZW9mIGFjdHVhbDtcbiAgICBcbiAgICAgICAgICAgIGlmIChhY3R1YWxUeXBlICE9PSAnb2JqZWN0JykgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfVFlQRShudWxsLCBhY3R1YWxUeXBlLCAnb2JqZWN0JywgcHJlZml4KVxuICAgICAgICAgICAgXTsgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHBhc3NPYmplY3RDaGVjayA9IHRydWU7XG5cbiAgICAgICAgbGV0IGFjdHVhbEZpZWxkVmFsdWUgPSBfLmdldChhY3R1YWwsIGZpZWxkTmFtZSk7ICAgICBcbiAgICAgICAgXG4gICAgICAgIGlmIChleHBlY3RlZEZpZWxkVmFsdWUgIT0gbnVsbCAmJiB0eXBlb2YgZXhwZWN0ZWRGaWVsZFZhbHVlID09PSAnb2JqZWN0JykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgWyBvaywgcmVhc29uIF0gPSBtYXRjaChhY3R1YWxGaWVsZFZhbHVlLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgZm9ybWF0UHJlZml4KGZpZWxkTmFtZSwgcHJlZml4KSk7XG4gICAgICAgICAgICBpZiAoIW9rKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFsgZmFsc2UsIHJlYXNvbiBdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbEZpZWxkVmFsdWUsICdPUF9FUVVBTCcsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChmaWVsZE5hbWUsIGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIFt0cnVlXTtcbn1cblxuLyoqXG4gKiBJZiAkIG9wZXJhdG9yIHVzZWQsIG9ubHkgb25lIGEgdGltZSBpcyBhbGxvd2VkXG4gKiBlLmcuXG4gKiB7XG4gKiAgICAkZ3JvdXBCeTogJ2pmaWVqZidcbiAqIH1cbiAqIFxuICogXG4gKiBAcGFyYW0geyp9IGN1cnJlbnRWYWx1ZSBcbiAqIEBwYXJhbSB7Kn0gZXhwciBcbiAqIEBwYXJhbSB7Kn0gcHJlZml4IFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBAcGFyYW0geyp9IGNvbnRleHRcbiAqL1xuZnVuY3Rpb24gZXZhbHVhdGVFeHByKGN1cnJlbnRWYWx1ZSwgZXhwciwgamVzLCBwcmVmaXgsIGNvbnRleHQpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGV4cHIpKSB7XG4gICAgICAgIHJldHVybiBleHByLnJlZHVjZSgocmVzdWx0LCBleHBySXRlbSkgPT4gZXZhbHVhdGVFeHByKHJlc3VsdCwgZXhwckl0ZW0sIGplcywgcHJlZml4LCBjb250ZXh0KSwgY3VycmVudFZhbHVlKTtcbiAgICB9XG5cbiAgICBjb25zdCB0eXBlRXhwciA9IHR5cGVvZiBleHByO1xuXG4gICAgaWYgKHR5cGVFeHByID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICByZXR1cm4gZXhwciA/IGN1cnJlbnRWYWx1ZSA6IHVuZGVmaW5lZDtcbiAgICB9ICAgIFxuXG4gICAgaWYgKHR5cGVFeHByID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoZXhwci5zdGFydHNXaXRoKCckJCcpKSB7XG4gICAgICAgICAgICAvL2dldCBmcm9tIGNvbnRleHRcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IGV4cHIuaW5kZXhPZignLicpO1xuICAgICAgICAgICAgaWYgKHBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29udGV4dFtleHByXTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8uZ2V0KGNvbnRleHRbZXhwci5zdWJzdHIoMCwgcG9zKV0sIGV4cHIuc3Vic3RyKHBvcysxKSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGV4cHIpO1xuICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFvcE1ldGFbMV0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihSRVFVSVJFX1JJR0hUX09QRVJBTkQoZXhwcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGV2YWx1YXRlVW5hcnkoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIGplcywgcHJlZml4KTtcbiAgICB9IFxuXG4gICAgaWYgKGNvbnRleHQgPT0gbnVsbCkgeyBcbiAgICAgICAgY29udGV4dCA9IHsgJCRST09UOiBjdXJyZW50VmFsdWUsICQkUEFSRU5UOiBudWxsLCAkJENVUlJFTlQ6IGN1cnJlbnRWYWx1ZSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnRleHQgPSB7IC4uLmNvbnRleHQsICQkUEFSRU5UOiBjb250ZXh0LiQkQ1VSUkVOVCwgJCRDVVJSRU5UOiBjdXJyZW50VmFsdWUgfTtcbiAgICB9XG5cbiAgICBsZXQgcmVzdWx0LCBoYXNPcGVyYXRvciA9IGZhbHNlOyAgICBcblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHByKSB7XG4gICAgICAgIGxldCBleHBlY3RlZEZpZWxkVmFsdWUgPSBleHByW2ZpZWxkTmFtZV07ICBcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGwgPSBmaWVsZE5hbWUubGVuZ3RoO1xuXG4gICAgICAgIGlmIChsID4gMSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVCeU9wTWV0YShjdXJyZW50VmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgb3BNZXRhLCBqZXMsIHByZWZpeCwgY29udGV4dCk7XG4gICAgICAgICAgICAgICAgaGFzT3BlcmF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobCA+IDMgJiYgZmllbGROYW1lWzBdID09PSAnfCcgJiYgZmllbGROYW1lWzJdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGZpZWxkTmFtZSA9IGZpZWxkTmFtZS5zdWJzdHIoMik7IFxuXG4gICAgICAgICAgICAgICAgY29uc3Qgb3BNZXRhID0gamVzLm1hcE9mTWFuaXB1bGF0b3JzLmdldChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX09QRVJBVE9SKGZpZWxkTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGV2YWx1YXRlQ29sbGVjdGlvbihjdXJyZW50VmFsdWUsIGNvbGxlY3Rpb25PcCwgb3BNZXRhLCBleHBlY3RlZEZpZWxkVmFsdWUsIGplcywgcHJlZml4KTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gXG5cbiAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoT1BFUkFUT1JfTk9UX0FMT05FKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vcGljayBhIGZpZWxkIGFuZCB0aGVuIGFwcGx5IG1hbmlwdWxhdGlvblxuICAgICAgICBsZXQgYWN0dWFsRmllbGRWYWx1ZSA9IGN1cnJlbnRWYWx1ZSAhPSBudWxsID8gXy5nZXQoY3VycmVudFZhbHVlLCBmaWVsZE5hbWUpIDogdW5kZWZpbmVkOyAgICAgXG5cbiAgICAgICAgY29uc3QgY2hpbGRGaWVsZFZhbHVlID0gZXZhbHVhdGVFeHByKGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBmb3JtYXRQcmVmaXgoZmllbGROYW1lLCBwcmVmaXgpLCBjb250ZXh0KTtcbiAgICAgICAgaWYgKHR5cGVvZiBjaGlsZEZpZWxkVmFsdWUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICByZXN1bHQgPSB7XG4gICAgICAgICAgICAgICAgLi4ucmVzdWx0LFxuICAgICAgICAgICAgICAgIFtmaWVsZE5hbWVdOiBjaGlsZEZpZWxkVmFsdWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gICAgICAgIFxuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG59XG5cbmNsYXNzIEpFUyB7XG4gICAgY29uc3RydWN0b3IodmFsdWUsIGN1c3RvbWl6ZXIpIHtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlO1xuICAgICAgICB0aGlzLmN1c3RvbWl6ZXIgPSBjdXN0b21pemVyO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZXhwZWN0ZWQgXG4gICAgICogQHBhcmFtICB7Li4uYW55fSBhcmdzIFxuICAgICAqL1xuICAgIG1hdGNoKGV4cGVjdGVkKSB7ICAgICAgICBcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gbWF0Y2godGhpcy52YWx1ZSwgZXhwZWN0ZWQsIHRoaXMuY3VzdG9taXplcik7XG4gICAgICAgIGlmIChyZXN1bHRbMF0pIHJldHVybiB0aGlzO1xuXG4gICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IocmVzdWx0WzFdLCB7XG4gICAgICAgICAgICBhY3R1YWw6IHRoaXMudmFsdWUsXG4gICAgICAgICAgICBleHBlY3RlZFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBldmFsdWF0ZShleHByKSB7XG4gICAgICAgIHJldHVybiBldmFsdWF0ZUV4cHIodGhpcy52YWx1ZSwgZXhwciwgdGhpcy5jdXN0b21pemVyKTtcbiAgICB9XG5cbiAgICB1cGRhdGUoZXhwcikge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGV2YWx1YXRlRXhwcih0aGlzLnZhbHVlLCBleHByLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cbn1cblxuSkVTLm1hdGNoID0gbWF0Y2g7XG5KRVMuZXZhbHVhdGUgPSBldmFsdWF0ZUV4cHI7XG5KRVMuZGVmYXVsdEN1c3RvbWl6ZXIgPSBkZWZhdWx0Q3VzdG9taXplcjtcblxubW9kdWxlLmV4cG9ydHMgPSBKRVM7Il19
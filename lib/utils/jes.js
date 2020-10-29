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
addManToMap(OP_REVERSE, ['OP_REVERSE', true]);
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
        const r = match(left, rule, prefix, jes);
        return r[0];
      });
    }

    const r = match(left, right, prefix, jes);
    return r[0];
  },
  OP_MATCH_ANY: (left, right, jes, prefix) => {
    if (!Array.isArray(right)) {
      throw new Error(OPERAND_NOT_ARRAY('OP_MATCH_ANY'));
    }

    let found = _.find(right, rule => {
      const r = match(left, rule, prefix, jes);
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
  OP_SORT: (left, right) => _.sortBy(left, right)
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
  OP_SORT: 'sortBy'
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

function evaluate(value, op, opValue, jes, prefix) {
  const handler = jes.queryHanlders[op];

  if (!handler) {
    throw new Error(INVALID_QUERY_HANDLER(op));
  }

  return handler(value, opValue, jes, prefix);
}

function evaluateUnary(value, op, jes, prefix) {
  const handler = jes.queryHanlders[op];

  if (!handler) {
    throw new Error(INVALID_QUERY_HANDLER(op));
  }

  return handler(value, jes, prefix);
}

function evaluateByOpMeta(currentValue, rightValue, opMeta, prefix, jes) {
  if (opMeta[1]) {
    return rightValue ? evaluateUnary(currentValue, opMeta[0], jes, prefix) : currentValue;
  }

  return evaluate(currentValue, opMeta[0], rightValue, jes, prefix);
}

const defaultCustomizer = {
  mapOfOperators: MapOfOps,
  mapOfManipulators: MapOfMans,
  operatorHandlers: defaultJesHandlers,
  operatorExplanations: defaultJesExplanations,
  queryHanlders: defaultManipulations
};

function matchCollection(actual, collectionOp, opMeta, operands, prefix, jes) {
  let matchResult, nextPrefix;

  switch (collectionOp) {
    case PFX_FOR_EACH:
      const mapResult = _.isPlainObject(actual) ? _.mapValues(actual, (item, key) => evaluateByOpMeta(item, operands[0], opMeta, formatPrefix(key, prefix), jes)) : _.map(actual, (item, i) => evaluateByOpMeta(item, operands[0], opMeta, formatPrefix(i, prefix), jes));
      nextPrefix = formatPrefix(formatMap(formatQuery(opMeta)), prefix);
      matchResult = match(mapResult, operands[1], nextPrefix, jes);
      break;

    case PFX_WITH_ANY:
      nextPrefix = formatPrefix(formatAny(formatQuery(opMeta)), prefix);
      matchResult = _.find(actual, (item, key) => match(evaluateByOpMeta(item, operands[0], opMeta, formatPrefix(key, prefix), jes), operands[1], nextPrefix, jes));
      break;

    default:
      throw new Error(INVALID_COLLECTION_OP(collectionOp));
  }

  if (!matchResult[0]) {
    return matchResult;
  }

  return undefined;
}

function validateCollection(actual, collectionOp, op, expectedFieldValue, prefix, jes) {
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

function evaluateCollection(currentValue, collectionOp, opMeta, expectedFieldValue, prefix, jes) {
  switch (collectionOp) {
    case PFX_FOR_EACH:
      return _.map(currentValue, (item, i) => evaluateByOpMeta(item, expectedFieldValue, opMeta, formatPrefix(i, prefix), jes));

    case PFX_WITH_ANY:
      throw new Error(PRX_OP_NOT_FOR_EVAL(collectionOp));

    default:
      throw new Error(INVALID_COLLECTION_OP(collectionOp));
  }
}

function match(actual, expected, prefix, jes) {
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

          const matchResult = matchCollection(actual, collectionOp, opMeta, expectedFieldValue, prefix, jes);
          if (matchResult) return matchResult;
          continue;
        } else {
          const collectionOp = fieldName.substr(0, 2);
          fieldName = fieldName.substr(2);
          const op = jes.mapOfOperators.get(fieldName);

          if (!op) {
            throw new Error(INVALID_TEST_OPERATOR(fieldName));
          }

          const matchResult = validateCollection(actual, collectionOp, op, expectedFieldValue, prefix, jes);
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
          const matchResult = match(queryResult, expectedFieldValue, formatPrefix(formatQuery(opMeta), prefix), jes);

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
      const [ok, reason] = match(actualFieldValue, expectedFieldValue, formatPrefix(fieldName, prefix), jes);

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

function evaluateExpr(currentValue, expr, prefix, jes, context) {
  jes != null || (jes = defaultCustomizer);

  if (Array.isArray(expr)) {
    return expr.reduce((result, exprItem) => evaluateExpr(result, exprItem, prefix, jes, context), currentValue);
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

        result = evaluateByOpMeta(currentValue, expectedFieldValue, opMeta, prefix, jes);
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

        result = evaluateCollection(currentValue, collectionOp, opMeta, expectedFieldValue, prefix, jes);
        hasOperator = true;
        continue;
      }
    }

    if (hasOperator) {
      throw new Error(OPERATOR_NOT_ALONE);
    }

    let actualFieldValue = currentValue != null ? _.get(currentValue, fieldName) : undefined;
    const childFieldValue = evaluateExpr(actualFieldValue, expectedFieldValue, formatPrefix(fieldName, prefix), jes, context);

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
    const result = match(this.value, expected, undefined, this.customizer);
    if (result[0]) return this;
    throw new ValidationError(result[1], {
      actual: this.value,
      expected
    });
  }

  evaluate(expr) {
    return evaluateExpr(this.value, expr, undefined, this.customizer);
  }

  update(expr) {
    const value = evaluateExpr(this.value, expr, undefined, this.customizer);
    this.value = value;
    return this;
  }

}

JES.match = match;
JES.evaluate = evaluateExpr;
JES.defaultCustomizer = defaultCustomizer;
module.exports = JES;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9qZXMuanMiXSwibmFtZXMiOlsiXyIsImhhc0tleUJ5UGF0aCIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJPUEVSQVRPUl9OT1RfQUxPTkUiLCJJTlZBTElEX1FVRVJZX09QRVJBVE9SIiwidG9rZW4iLCJJTlZBTElEX1RFU1RfT1BFUkFUT1IiLCJJTlZBTElEX1FVRVJZX0hBTkRMRVIiLCJvcCIsIklOVkFMSURfVEVTVF9IQU5MREVSIiwiTk9UX0FfVFdPX1RVUExFIiwiTk9UX0FfVU5BUllfUVVFUlkiLCJJTlZBTElEX0NPTExFQ1RJT05fT1AiLCJQUlhfT1BfTk9UX0ZPUl9FVkFMIiwicHJlZml4IiwiT1BFUkFORF9OT1RfQVJSQVkiLCJPUEVSQU5EX05PVF9CT09MIiwiT1BFUkFORF9OT1RfU1RSSU5HIiwiUkVRVUlSRV9SSUdIVF9PUEVSQU5EIiwiT1BfRVFVQUwiLCJPUF9OT1RfRVFVQUwiLCJPUF9HUkVBVEVSX1RIQU4iLCJPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUwiLCJPUF9MRVNTX1RIQU4iLCJPUF9MRVNTX1RIQU5fT1JfRVFVQUwiLCJPUF9JTiIsIk9QX05PVF9JTiIsIk9QX0VYSVNUUyIsIk9QX01BVENIIiwiT1BfTUFUQ0hfQU5ZIiwiT1BfVFlQRSIsIk9QX0hBU19LRVlTIiwiT1BfU0laRSIsIk9QX1NVTSIsIk9QX0tFWVMiLCJPUF9WQUxVRVMiLCJPUF9HRVRfVFlQRSIsIk9QX0FERCIsIk9QX1NVQiIsIk9QX01VTCIsIk9QX0RJViIsIk9QX1NFVCIsIk9QX1BJQ0siLCJPUF9HRVRfQllfSU5ERVgiLCJPUF9HRVRfQllfS0VZIiwiT1BfT01JVCIsIk9QX0dST1VQIiwiT1BfU09SVCIsIk9QX1JFVkVSU0UiLCJQRlhfRk9SX0VBQ0giLCJQRlhfV0lUSF9BTlkiLCJNYXBPZk9wcyIsIk1hcCIsImFkZE9wVG9NYXAiLCJ0b2tlbnMiLCJ0YWciLCJmb3JFYWNoIiwic2V0IiwiTWFwT2ZNYW5zIiwiYWRkTWFuVG9NYXAiLCJkZWZhdWx0SmVzSGFuZGxlcnMiLCJsZWZ0IiwicmlnaHQiLCJpc0VxdWFsIiwiQXJyYXkiLCJpc0FycmF5IiwiRXJyb3IiLCJmaW5kIiwiZWxlbWVudCIsImV2ZXJ5IiwidG9Mb3dlckNhc2UiLCJpc0ludGVnZXIiLCJqZXMiLCJydWxlIiwiciIsIm1hdGNoIiwiZm91bmQiLCJrZXkiLCJkZWZhdWx0TWFuaXB1bGF0aW9ucyIsInNpemUiLCJyZWR1Y2UiLCJzdW0iLCJpdGVtIiwia2V5cyIsInZhbHVlcyIsInJldmVyc2UiLCJwaWNrIiwibnRoIiwiZ2V0Iiwib21pdCIsImdyb3VwQnkiLCJzb3J0QnkiLCJmb3JtYXROYW1lIiwibmFtZSIsImZ1bGxOYW1lIiwiZm9ybWF0UHJlZml4IiwiaW5kZXhPZiIsImZvcm1hdEtleSIsImhhc1ByZWZpeCIsImZvcm1hdFF1ZXJ5Iiwib3BNZXRhIiwiZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zIiwiZm9ybWF0TWFwIiwiZm9ybWF0QW55IiwiZGVmYXVsdEplc0V4cGxhbmF0aW9ucyIsIkpTT04iLCJzdHJpbmdpZnkiLCJqb2luIiwiZ2V0VW5tYXRjaGVkRXhwbGFuYXRpb24iLCJsZWZ0VmFsdWUiLCJyaWdodFZhbHVlIiwiZ2V0dGVyIiwib3BlcmF0b3JFeHBsYW5hdGlvbnMiLCJ0ZXN0IiwidmFsdWUiLCJvcFZhbHVlIiwiaGFuZGxlciIsIm9wZXJhdG9ySGFuZGxlcnMiLCJldmFsdWF0ZSIsInF1ZXJ5SGFubGRlcnMiLCJldmFsdWF0ZVVuYXJ5IiwiZXZhbHVhdGVCeU9wTWV0YSIsImN1cnJlbnRWYWx1ZSIsImRlZmF1bHRDdXN0b21pemVyIiwibWFwT2ZPcGVyYXRvcnMiLCJtYXBPZk1hbmlwdWxhdG9ycyIsIm1hdGNoQ29sbGVjdGlvbiIsImFjdHVhbCIsImNvbGxlY3Rpb25PcCIsIm9wZXJhbmRzIiwibWF0Y2hSZXN1bHQiLCJuZXh0UHJlZml4IiwibWFwUmVzdWx0IiwiaXNQbGFpbk9iamVjdCIsIm1hcFZhbHVlcyIsIm1hcCIsImkiLCJ1bmRlZmluZWQiLCJ2YWxpZGF0ZUNvbGxlY3Rpb24iLCJleHBlY3RlZEZpZWxkVmFsdWUiLCJ1bm1hdGNoZWRLZXkiLCJmaW5kSW5kZXgiLCJtYXRjaGVkIiwiZXZhbHVhdGVDb2xsZWN0aW9uIiwiZXhwZWN0ZWQiLCJwYXNzT2JqZWN0Q2hlY2siLCJmaWVsZE5hbWUiLCJsIiwibGVuZ3RoIiwic3Vic3RyIiwicXVlcnlSZXN1bHQiLCJhY3R1YWxUeXBlIiwiYWN0dWFsRmllbGRWYWx1ZSIsIm9rIiwicmVhc29uIiwiZXZhbHVhdGVFeHByIiwiZXhwciIsImNvbnRleHQiLCJyZXN1bHQiLCJleHBySXRlbSIsInR5cGVFeHByIiwic3RhcnRzV2l0aCIsInBvcyIsIiQkUk9PVCIsIiQkUEFSRU5UIiwiJCRDVVJSRU5UIiwiaGFzT3BlcmF0b3IiLCJjaGlsZEZpZWxkVmFsdWUiLCJKRVMiLCJjb25zdHJ1Y3RvciIsImN1c3RvbWl6ZXIiLCJ1cGRhdGUiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQ0EsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBc0JDLE9BQU8sQ0FBQyxVQUFELENBQW5DOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFzQkQsT0FBTyxDQUFDLFVBQUQsQ0FBbkM7O0FBR0EsTUFBTUUsa0JBQWtCLEdBQUcsbURBQTNCOztBQUNBLE1BQU1DLHNCQUFzQixHQUFHQyxLQUFLLElBQUssK0JBQThCQSxLQUFNLElBQTdFOztBQUNBLE1BQU1DLHFCQUFxQixHQUFHRCxLQUFLLElBQUssOEJBQTZCQSxLQUFNLElBQTNFOztBQUNBLE1BQU1FLHFCQUFxQixHQUFHQyxFQUFFLElBQUssdUJBQXNCQSxFQUFHLHNCQUE5RDs7QUFDQSxNQUFNQyxvQkFBb0IsR0FBR0QsRUFBRSxJQUFLLHNCQUFxQkEsRUFBRyxzQkFBNUQ7O0FBQ0EsTUFBTUUsZUFBZSxHQUFHLHlEQUF4QjtBQUNBLE1BQU1DLGlCQUFpQixHQUFHLHlFQUExQjs7QUFD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TWMsTUFBTSxHQUFHbkYsS0FBSyxDQUFDLEtBQUt1QyxLQUFOLEVBQWE4QixRQUFiLEVBQXVCUCxTQUF2QixFQUFrQyxLQUFLaUMsVUFBdkMsQ0FBcEI7QUFDQSxRQUFJWixNQUFNLENBQUMsQ0FBRCxDQUFWLEVBQWUsT0FBTyxJQUFQO0FBRWYsVUFBTSxJQUFJNUosZUFBSixDQUFvQjRKLE1BQU0sQ0FBQyxDQUFELENBQTFCLEVBQStCO0FBQ2pDL0IsTUFBQUEsTUFBTSxFQUFFLEtBQUtiLEtBRG9CO0FBRWpDOEIsTUFBQUE7QUFGaUMsS0FBL0IsQ0FBTjtBQUlIOztBQUVEMUIsRUFBQUEsUUFBUSxDQUFDc0MsSUFBRCxFQUFPO0FBQ1gsV0FBT0QsWUFBWSxDQUFDLEtBQUt6QyxLQUFOLEVBQWEwQyxJQUFiLEVBQW1CbkIsU0FBbkIsRUFBOEIsS0FBS2lDLFVBQW5DLENBQW5CO0FBQ0g7O0FBRURDLEVBQUFBLE1BQU0sQ0FBQ2YsSUFBRCxFQUFPO0FBQ1QsVUFBTTFDLEtBQUssR0FBR3lDLFlBQVksQ0FBQyxLQUFLekMsS0FBTixFQUFhMEMsSUFBYixFQUFtQm5CLFNBQW5CLEVBQThCLEtBQUtpQyxVQUFuQyxDQUExQjtBQUNBLFNBQUt4RCxLQUFMLEdBQWFBLEtBQWI7QUFDQSxXQUFPLElBQVA7QUFDSDs7QUE3Qks7O0FBZ0NWc0QsR0FBRyxDQUFDN0YsS0FBSixHQUFZQSxLQUFaO0FBQ0E2RixHQUFHLENBQUNsRCxRQUFKLEdBQWVxQyxZQUFmO0FBQ0FhLEdBQUcsQ0FBQzdDLGlCQUFKLEdBQXdCQSxpQkFBeEI7QUFFQWlELE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQkwsR0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKU09OIEV4cHJlc3Npb24gU3ludGF4IChKRVMpXG5jb25zdCB7IF8sIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuXG4vL0V4Y2VwdGlvbiBtZXNzYWdlc1xuY29uc3QgT1BFUkFUT1JfTk9UX0FMT05FID0gJ1F1ZXJ5IG9wZXJhdG9yIGNhbiBvbmx5IGJlIHVzZWQgYWxvbmUgaW4gYSBzdGFnZS4nO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7dG9rZW59XCIuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9PUEVSQVRPUiA9IHRva2VuID0+IGBJbnZhbGlkIEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHt0b2tlbn1cIi5gO1xuY29uc3QgSU5WQUxJRF9RVUVSWV9IQU5ETEVSID0gb3AgPT4gYEpFUyBxdWVyeSBvcGVyYXRvciBcIiR7b3B9XCIgaGFuZGxlciBub3QgZm91bmQuYDtcbmNvbnN0IElOVkFMSURfVEVTVF9IQU5MREVSID0gb3AgPT4gYEpFUyB0ZXN0IG9wZXJhdG9yIFwiJHtvcH1cIiBoYW5kbGVyIG5vdCBmb3VuZC5gO1xuY29uc3QgTk9UX0FfVFdPX1RVUExFID0gJ1RoZSB2YWx1ZSBvZiBjb2xsZWN0aW9uIG9wZXJhdG9yIHNob3VsZCBiZSBhIHR3by10dXBsZS4nO1xuY29uc3QgTk9UX0FfVU5BUllfUVVFUlkgPSAnT25seSB1bmFyeSBxdWVyeSBvcGVyYXRvciBpcyBhbGxvd2VkIHRvIGJlIHVzZWQgZGlyZWN0bHkgaW4gYSBtYXRjaGluZy4nO1xuY29uc3QgSU5WQUxJRF9DT0xMRUNUSU9OX09QID0gb3AgPT4gYEludmFsaWQgY29sbGVjdGlvbiBvcGVyYXRvciBcIiR7b3B9XCIuYDtcbmNvbnN0IFBSWF9PUF9OT1RfRk9SX0VWQUwgPSBwcmVmaXggPT4gYE9wZXJhdG9yIHByZWZpeCBcIiR7cHJlZml4fVwiIGNhbm5vdCBiZSB1c2VkIGluIGV2YWx1YXRpb24uYDtcblxuY29uc3QgT1BFUkFORF9OT1RfQVJSQVkgPSBvcCA9PiBgVGhlIHJpZ2h0IG9wZXJhbmQgb2YgSkVTIG9wZXJhdG9yIFwiJHtvcH1cIiBzaG91bGQgYmUgYW4gYXJyYXkuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX0JPT0w9IG9wID0+IGBUaGUgcmlnaHQgb3BlcmFuZCBvZiBKRVMgb3BlcmF0b3IgXCIke29wfVwiIHNob3VsZCBiZSBhIGJvb2xlYW4gdmFsdWUuYDtcbmNvbnN0IE9QRVJBTkRfTk9UX1NUUklORz0gb3AgPT4gYFRoZSByaWdodCBvcGVyYW5kIG9mIEpFUyBvcGVyYXRvciBcIiR7b3B9XCIgc2hvdWxkIGJlIGEgc3RyaW5nLmA7XG5cbmNvbnN0IFJFUVVJUkVfUklHSFRfT1BFUkFORCA9IG9wID0+IGBCaW5hcnkgcXVlcnkgb3BlcmF0b3IgXCIke29wfVwiIHJlcXVpcmVzIHRoZSByaWdodCBvcGVyYW5kLmBcblxuLy9Db25kaXRpb24gb3BlcmF0b3JcbmNvbnN0IE9QX0VRVUFMID0gWyAnJGVxJywgJyRlcWwnLCAnJGVxdWFsJyBdO1xuY29uc3QgT1BfTk9UX0VRVUFMID0gWyAnJG5lJywgJyRuZXEnLCAnJG5vdEVxdWFsJyBdO1xuXG5jb25zdCBPUF9HUkVBVEVSX1RIQU4gPSBbICckZ3QnLCAnJD4nLCAnJGdyZWF0ZXJUaGFuJyBdO1xuY29uc3QgT1BfR1JFQVRFUl9USEFOX09SX0VRVUFMID0gWyAnJGd0ZScsICckPD0nLCAnJGdyZWF0ZXJUaGFuT3JFcXVhbCcgXTtcblxuY29uc3QgT1BfTEVTU19USEFOID0gWyAnJGx0JywgJyQ8JywgJyRsZXNzVGhhbicgXTtcbmNvbnN0IE9QX0xFU1NfVEhBTl9PUl9FUVVBTCA9IFsgJyRsdGUnLCAnJDw9JywgJyRsZXNzVGhhbk9yRXF1YWwnIF07XG5cbmNvbnN0IE9QX0lOID0gWyAnJGluJyBdO1xuY29uc3QgT1BfTk9UX0lOID0gWyAnJG5pbicsICckbm90SW4nIF07XG5cbmNvbnN0IE9QX0VYSVNUUyA9IFsgJyRleGlzdCcsICckZXhpc3RzJyBdO1xuXG5jb25zdCBPUF9NQVRDSCA9IFsgJyRoYXMnLCAnJG1hdGNoJywgJyRhbGwnIF07XG5cbmNvbnN0IE9QX01BVENIX0FOWSA9IFsgJyRhbnknLCAnJG9yJywgJyRlaXRoZXInIF07XG5cbmNvbnN0IE9QX1RZUEUgPSBbICckaXMnLCAnJHR5cGVPZicgXTtcblxuY29uc3QgT1BfSEFTX0tFWVMgPSBbICckaGFzS2V5cycsICckd2l0aEtleXMnIF07XG5cbi8vUXVlcnkgJiBhZ2dyZWdhdGUgb3BlcmF0b3JcbmNvbnN0IE9QX1NJWkUgPSBbICckc2l6ZScsICckbGVuZ3RoJywgJyRjb3VudCcgXTtcbmNvbnN0IE9QX1NVTSA9IFsgJyRzdW0nLCAnJHRvdGFsJyBdO1xuY29uc3QgT1BfS0VZUyA9IFsgJyRrZXlzJyBdO1xuY29uc3QgT1BfVkFMVUVTID0gWyAnJHZhbHVlcycgXTtcbmNvbnN0IE9QX0dFVF9UWVBFID0gWyAnJHR5cGUnIF07XG5cbi8vTWFuaXB1bGF0ZSBvcGVyYXRpb25cbmNvbnN0IE9QX0FERCA9IFsgJyRhZGQnLCAnJHBsdXMnLCAgICAgJyRpbmMnIF07XG5jb25zdCBPUF9TVUIgPSBbICckc3ViJywgJyRzdWJ0cmFjdCcsICckbWludXMnLCAnJGRlYycgXTtcbmNvbnN0IE9QX01VTCA9IFsgJyRtdWwnLCAnJG11bHRpcGx5JywgICckdGltZXMnIF07XG5jb25zdCBPUF9ESVYgPSBbICckZGl2JywgJyRkaXZpZGUnIF07XG5jb25zdCBPUF9TRVQgPSBbICckc2V0JywgJyQ9JyBdO1xuXG5jb25zdCBPUF9QSUNLID0gWyAnJHBpY2snIF07XG5jb25zdCBPUF9HRVRfQllfSU5ERVggPSBbICckYXQnLCAnJGdldEJ5SW5kZXgnLCAnJG50aCcgXTtcbmNvbnN0IE9QX0dFVF9CWV9LRVkgPSBbICckb2YnLCAnJGdldEJ5S2V5JyBdO1xuY29uc3QgT1BfT01JVCA9IFsgJyRvbWl0JyBdO1xuY29uc3QgT1BfR1JPVVAgPSBbICckZ3JvdXAnLCAnJGdyb3VwQnknIF07XG5jb25zdCBPUF9TT1JUID0gWyAnJHNvcnQnLCAnJG9yZGVyQnknLCAnJHNvcnRCeScgXTtcbmNvbnN0IE9QX1JFVkVSU0UgPSBbICckcmV2ZXJzZScgXTtcblxuY29uc3QgUEZYX0ZPUl9FQUNIID0gJ3w+JzsgLy8gZm9yIGVhY2hcbmNvbnN0IFBGWF9XSVRIX0FOWSA9ICd8Kic7IC8vIHdpdGggYW55XG5cbmNvbnN0IE1hcE9mT3BzID0gbmV3IE1hcCgpO1xuY29uc3QgYWRkT3BUb01hcCA9ICh0b2tlbnMsIHRhZykgPT4gdG9rZW5zLmZvckVhY2godG9rZW4gPT4gTWFwT2ZPcHMuc2V0KHRva2VuLCB0YWcpKTtcbmFkZE9wVG9NYXAoT1BfRVFVQUwsICdPUF9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9OT1RfRVFVQUwsICdPUF9OT1RfRVFVQUwnKTtcbmFkZE9wVG9NYXAoT1BfR1JFQVRFUl9USEFOLCAnT1BfR1JFQVRFUl9USEFOJyk7XG5hZGRPcFRvTWFwKE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCwgJ09QX0dSRUFURVJfVEhBTl9PUl9FUVVBTCcpO1xuYWRkT3BUb01hcChPUF9MRVNTX1RIQU4sICdPUF9MRVNTX1RIQU4nKTtcbmFkZE9wVG9NYXAoT1BfTEVTU19USEFOX09SX0VRVUFMLCAnT1BfTEVTU19USEFOX09SX0VRVUFMJyk7XG5hZGRPcFRvTWFwKE9QX0lOLCAnT1BfSU4nKTtcbmFkZE9wVG9NYXAoT1BfTk9UX0lOLCAnT1BfTk9UX0lOJyk7XG5hZGRPcFRvTWFwKE9QX0VYSVNUUywgJ09QX0VYSVNUUycpO1xuYWRkT3BUb01hcChPUF9NQVRDSCwgJ09QX01BVENIJyk7XG5hZGRPcFRvTWFwKE9QX01BVENIX0FOWSwgJ09QX01BVENIX0FOWScpO1xuYWRkT3BUb01hcChPUF9UWVBFLCAnT1BfVFlQRScpO1xuYWRkT3BUb01hcChPUF9IQVNfS0VZUywgJ09QX0hBU19LRVlTJyk7XG5cbmNvbnN0IE1hcE9mTWFucyA9IG5ldyBNYXAoKTtcbmNvbnN0IGFkZE1hblRvTWFwID0gKHRva2VucywgdGFnKSA9PiB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiBNYXBPZk1hbnMuc2V0KHRva2VuLCB0YWcpKTtcbi8vIFsgPG9wIG5hbWU+LCA8dW5hcnk+IF1cbmFkZE1hblRvTWFwKE9QX1NJWkUsIFsnT1BfU0laRScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VNLCBbJ09QX1NVTScsIHRydWUgXSk7IFxuYWRkTWFuVG9NYXAoT1BfS0VZUywgWydPUF9LRVlTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9WQUxVRVMsIFsnT1BfVkFMVUVTJywgdHJ1ZSBdKTsgXG5hZGRNYW5Ub01hcChPUF9HRVRfVFlQRSwgWydPUF9HRVRfVFlQRScsIHRydWUgXSk7IFxuXG5hZGRNYW5Ub01hcChPUF9BREQsIFsnT1BfQUREJywgZmFsc2UgXSk7IFxuYWRkTWFuVG9NYXAoT1BfU1VCLCBbJ09QX1NVQicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfTVVMLCBbJ09QX01VTCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfRElWLCBbJ09QX0RJVicsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfU0VULCBbJ09QX1NFVCcsIGZhbHNlIF0pO1xuYWRkTWFuVG9NYXAoT1BfUElDSywgWydPUF9QSUNLJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX0dFVF9CWV9JTkRFWCwgWydPUF9HRVRfQllfSU5ERVgnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfR0VUX0JZX0tFWSwgWydPUF9HRVRfQllfS0VZJywgZmFsc2VdKTtcbmFkZE1hblRvTWFwKE9QX09NSVQsIFsnT1BfT01JVCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9HUk9VUCwgWydPUF9HUk9VUCcsIGZhbHNlXSk7XG5hZGRNYW5Ub01hcChPUF9TT1JULCBbJ09QX1NPUlQnLCBmYWxzZV0pO1xuYWRkTWFuVG9NYXAoT1BfUkVWRVJTRSwgWydPUF9SRVZFUlNFJywgdHJ1ZV0pO1xuXG5jb25zdCBkZWZhdWx0SmVzSGFuZGxlcnMgPSB7XG4gICAgT1BfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gXy5pc0VxdWFsKGxlZnQsIHJpZ2h0KSxcbiAgICBPUF9OT1RfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gIV8uaXNFcXVhbChsZWZ0LCByaWdodCksXG4gICAgT1BfR1JFQVRFUl9USEFOOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgPiByaWdodCxcbiAgICBPUF9HUkVBVEVSX1RIQU5fT1JfRVFVQUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCA+PSByaWdodCxcbiAgICBPUF9MRVNTX1RIQU46IChsZWZ0LCByaWdodCkgPT4gbGVmdCA8IHJpZ2h0LFxuICAgIE9QX0xFU1NfVEhBTl9PUl9FUVVBTDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IDw9IHJpZ2h0LFxuICAgIE9QX0lOOiAobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgaWYgKHJpZ2h0ID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9JTicpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodC5maW5kKGVsZW1lbnQgPT4gZGVmYXVsdEplc0hhbmRsZXJzLk9QX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX05PVF9JTjogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmIChyaWdodCA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9OT1RfSU4nKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwgZWxlbWVudCA9PiBkZWZhdWx0SmVzSGFuZGxlcnMuT1BfTk9UX0VRVUFMKGxlZnQsIGVsZW1lbnQpKTtcbiAgICB9LFxuICAgIE9QX0VYSVNUUzogKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgcmlnaHQgIT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0JPT0woJ09QX0VYSVNUUycpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByaWdodCA/IGxlZnQgIT0gbnVsbCA6IGxlZnQgPT0gbnVsbDtcbiAgICB9LFxuICAgIE9QX1RZUEU6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHJpZ2h0ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX1NUUklORygnT1BfVFlQRScpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJpZ2h0ID0gcmlnaHQudG9Mb3dlckNhc2UoKTtcblxuICAgICAgICBpZiAocmlnaHQgPT09ICdhcnJheScpIHtcbiAgICAgICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KGxlZnQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChyaWdodCA9PT0gJ2ludGVnZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5pc0ludGVnZXIobGVmdCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBsZWZ0ID09PSAnc3RyaW5nJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0eXBlb2YgbGVmdCA9PT0gcmlnaHQ7XG4gICAgfSxcbiAgICBPUF9NQVRDSDogKGxlZnQsIHJpZ2h0LCBqZXMsIHByZWZpeCkgPT4ge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyaWdodCkpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KHJpZ2h0LCBydWxlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcnVsZSwgcHJlZml4LCBqZXMpO1xuICAgICAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByID0gbWF0Y2gobGVmdCwgcmlnaHQsIHByZWZpeCwgamVzKTtcbiAgICAgICAgcmV0dXJuIHJbMF07XG4gICAgfSxcbiAgICBPUF9NQVRDSF9BTlk6IChsZWZ0LCByaWdodCwgamVzLCBwcmVmaXgpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJpZ2h0KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBTkRfTk9UX0FSUkFZKCdPUF9NQVRDSF9BTlknKSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmlnaHQsIHJ1bGUgPT4ge1xuICAgICAgICAgICAgY29uc3QgciA9IG1hdGNoKGxlZnQsIHJ1bGUsIHByZWZpeCwgamVzKTtcbiAgICAgICAgICAgIHJldHVybiByWzBdO1xuICAgICAgICB9KTsgICBcbiAgICBcbiAgICAgICAgcmV0dXJuIGZvdW5kID8gdHJ1ZSA6IGZhbHNlO1xuICAgIH0sXG4gICAgT1BfSEFTX0tFWVM6IChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGxlZnQgIT09IFwib2JqZWN0XCIpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gXy5ldmVyeShyaWdodCwga2V5ID0+IGhhc0tleUJ5UGF0aChsZWZ0LCBrZXkpKTtcbiAgICB9ICAgIFxufTtcblxuY29uc3QgZGVmYXVsdE1hbmlwdWxhdGlvbnMgPSB7XG4gICAgLy91bmFyeVxuICAgIE9QX1NJWkU6IChsZWZ0KSA9PiBfLnNpemUobGVmdCksXG4gICAgT1BfU1VNOiAobGVmdCkgPT4gXy5yZWR1Y2UobGVmdCwgKHN1bSwgaXRlbSkgPT4ge1xuICAgICAgICAgICAgc3VtICs9IGl0ZW07XG4gICAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICB9LCAwKSxcblxuICAgIE9QX0tFWVM6IChsZWZ0KSA9PiBfLmtleXMobGVmdCksXG4gICAgT1BfVkFMVUVTOiAobGVmdCkgPT4gXy52YWx1ZXMobGVmdCksICAgXG4gICAgT1BfR0VUX1RZUEU6IChsZWZ0KSA9PiBBcnJheS5pc0FycmF5KGxlZnQpID8gJ2FycmF5JyA6IChfLmlzSW50ZWdlcihsZWZ0KSA/ICdpbnRlZ2VyJyA6IHR5cGVvZiBsZWZ0KSwgIFxuICAgIE9QX1JFVkVSU0U6IChsZWZ0KSA9PiBfLnJldmVyc2UobGVmdCksXG5cbiAgICAvL2JpbmFyeVxuICAgIE9QX0FERDogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0ICsgcmlnaHQsXG4gICAgT1BfU1VCOiAobGVmdCwgcmlnaHQpID0+IGxlZnQgLSByaWdodCxcbiAgICBPUF9NVUw6IChsZWZ0LCByaWdodCkgPT4gbGVmdCAqIHJpZ2h0LFxuICAgIE9QX0RJVjogKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0IC8gcmlnaHQsIFxuICAgIE9QX1NFVDogKGxlZnQsIHJpZ2h0KSA9PiByaWdodCwgXG4gICAgT1BfUElDSzogKGxlZnQsIHJpZ2h0KSA9PiBfLnBpY2sobGVmdCwgcmlnaHQpLFxuICAgIE9QX0dFVF9CWV9JTkRFWDogKGxlZnQsIHJpZ2h0KSA9PiBfLm50aChsZWZ0LCByaWdodCksXG4gICAgT1BfR0VUX0JZX0tFWTogKGxlZnQsIHJpZ2h0KSA9PiBfLmdldChsZWZ0LCByaWdodCksXG4gICAgT1BfT01JVDogKGxlZnQsIHJpZ2h0KSA9PiBfLm9taXQobGVmdCwgcmlnaHQpLFxuICAgIE9QX0dST1VQOiAobGVmdCwgcmlnaHQpID0+IF8uZ3JvdXBCeShsZWZ0LCByaWdodCksXG4gICAgT1BfU09SVDogKGxlZnQsIHJpZ2h0KSA9PiBfLnNvcnRCeShsZWZ0LCByaWdodCksICAgIFxufVxuXG5jb25zdCBmb3JtYXROYW1lID0gKG5hbWUsIHByZWZpeCkgPT4ge1xuICAgIGNvbnN0IGZ1bGxOYW1lID0gbmFtZSA9PSBudWxsID8gcHJlZml4IDogZm9ybWF0UHJlZml4KG5hbWUsIHByZWZpeCk7XG4gICAgcmV0dXJuIGZ1bGxOYW1lID09IG51bGwgPyBcIlRoZSB2YWx1ZVwiIDogKGZ1bGxOYW1lLmluZGV4T2YoJygnKSAhPT0gLTEgPyBgVGhlIHF1ZXJ5IFwiXy4ke2Z1bGxOYW1lfVwiYCA6IGBcIiR7ZnVsbE5hbWV9XCJgKTtcbn07XG5jb25zdCBmb3JtYXRLZXkgPSAoa2V5LCBoYXNQcmVmaXgpID0+IF8uaXNJbnRlZ2VyKGtleSkgPyBgWyR7a2V5fV1gIDogKGhhc1ByZWZpeCA/ICcuJyArIGtleSA6IGtleSk7XG5jb25zdCBmb3JtYXRQcmVmaXggPSAoa2V5LCBwcmVmaXgpID0+IHByZWZpeCAhPSBudWxsID8gYCR7cHJlZml4fSR7Zm9ybWF0S2V5KGtleSwgdHJ1ZSl9YCA6IGZvcm1hdEtleShrZXksIGZhbHNlKTtcbmNvbnN0IGZvcm1hdFF1ZXJ5ID0gKG9wTWV0YSkgPT4gYCR7ZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zW29wTWV0YVswXV19KCR7b3BNZXRhWzFdID8gJycgOiAnPyd9KWA7ICBcbmNvbnN0IGZvcm1hdE1hcCA9IChuYW1lKSA9PiBgZWFjaCgtPiR7bmFtZX0pYDtcbmNvbnN0IGZvcm1hdEFueSA9IChuYW1lKSA9PiBgYW55KC0+JHtuYW1lfSlgO1xuXG5jb25zdCBkZWZhdWx0SmVzRXhwbGFuYXRpb25zID0ge1xuICAgIE9QX0VRVUFMOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9OT1RfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBub3QgYmUgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9HUkVBVEVSX1RIQU46IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBncmVhdGVyIHRoYW4gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0dSRUFURVJfVEhBTl9PUl9FUVVBTDogKG5hbWUsIGxlZnQsIHJpZ2h0LCBwcmVmaXgpID0+IGAke2Zvcm1hdE5hbWUobmFtZSwgcHJlZml4KX0gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiBvciBlcXVhbCB0byAke3JpZ2h0fSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTEVTU19USEFOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgbGVzcyB0aGFuICR7cmlnaHR9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9MRVNTX1RIQU5fT1JfRVFVQUw6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gJHtyaWdodH0sIGJ1dCAke0pTT04uc3RyaW5naWZ5KGxlZnQpfSBnaXZlbi5gLFxuICAgIE9QX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgb25lIG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsXG4gICAgT1BfTk9UX0lOOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbm90IGJlIGFueSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCxcbiAgICBPUF9FWElTVFM6IChuYW1lLCBsZWZ0LCByaWdodCwgcHJlZml4KSA9PiBgJHtmb3JtYXROYW1lKG5hbWUsIHByZWZpeCl9IHNob3VsZCR7cmlnaHQgPyAnIG5vdCAnOiAnICd9YmUgTlVMTC5gLCAgICBcbiAgICBPUF9UWVBFOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYFRoZSB0eXBlIG9mICR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgYmUgXCIke3JpZ2h0fVwiLCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgICAgIFxuICAgIE9QX01BVENIOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggJHtKU09OLnN0cmluZ2lmeShyaWdodCl9LCBidXQgJHtKU09OLnN0cmluZ2lmeShsZWZ0KX0gZ2l2ZW4uYCwgICAgXG4gICAgT1BfTUFUQ0hfQU5ZOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgbWF0Y2ggYW55IG9mICR7SlNPTi5zdHJpbmdpZnkocmlnaHQpfSwgYnV0ICR7SlNPTi5zdHJpbmdpZnkobGVmdCl9IGdpdmVuLmAsICAgIFxuICAgIE9QX0hBU19LRVlTOiAobmFtZSwgbGVmdCwgcmlnaHQsIHByZWZpeCkgPT4gYCR7Zm9ybWF0TmFtZShuYW1lLCBwcmVmaXgpfSBzaG91bGQgaGF2ZSBhbGwgb2YgdGhlc2Uga2V5cyBbJHtyaWdodC5qb2luKCcsICcpfV0uYCwgICAgICAgIFxufTtcblxuY29uc3QgZGVmYXVsdFF1ZXJ5RXhwbGFuYXRpb25zID0ge1xuICAgIC8vdW5hcnlcbiAgICBPUF9TSVpFOiAnc2l6ZScsXG4gICAgT1BfU1VNOiAnc3VtJyxcbiAgICBPUF9LRVlTOiAna2V5cycsXG4gICAgT1BfVkFMVUVTOiAndmFsdWVzJywgICAgXG4gICAgT1BfR0VUX1RZUEU6ICdnZXQgdHlwZScsXG4gICAgT1BfUkVWRVJTRTogJ3JldmVyc2UnLCBcblxuICAgIC8vYmluYXJ5XG4gICAgT1BfQUREOiAnYWRkJyxcbiAgICBPUF9TVUI6ICdzdWJ0cmFjdCcsXG4gICAgT1BfTVVMOiAnbXVsdGlwbHknLFxuICAgIE9QX0RJVjogJ2RpdmlkZScsIFxuICAgIE9QX1NFVDogJ2Fzc2lnbicsXG4gICAgT1BfUElDSzogJ3BpY2snLFxuICAgIE9QX0dFVF9CWV9JTkRFWDogJ2dldCBlbGVtZW50IGF0IGluZGV4JyxcbiAgICBPUF9HRVRfQllfS0VZOiAnZ2V0IGVsZW1lbnQgb2Yga2V5JyxcbiAgICBPUF9PTUlUOiAnb21pdCcsXG4gICAgT1BfR1JPVVA6ICdncm91cEJ5JyxcbiAgICBPUF9TT1JUOiAnc29ydEJ5Jyxcbn07XG5cbmZ1bmN0aW9uIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG5hbWUsIGxlZnRWYWx1ZSwgcmlnaHRWYWx1ZSwgcHJlZml4KSB7XG4gICAgY29uc3QgZ2V0dGVyID0gamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zW29wXSB8fCBqZXMub3BlcmF0b3JFeHBsYW5hdGlvbnMuT1BfTUFUQ0g7XG4gICAgcmV0dXJuIGdldHRlcihuYW1lLCBsZWZ0VmFsdWUsIHJpZ2h0VmFsdWUsIHByZWZpeCk7ICAgIFxufVxuXG5mdW5jdGlvbiB0ZXN0KHZhbHVlLCBvcCwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpIHsgXG4gICAgY29uc3QgaGFuZGxlciA9IGplcy5vcGVyYXRvckhhbmRsZXJzW29wXTtcblxuICAgIGlmICghaGFuZGxlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9URVNUX0hBTkxERVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgb3BWYWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZSh2YWx1ZSwgb3AsIG9wVmFsdWUsIGplcywgcHJlZml4KSB7IFxuICAgIGNvbnN0IGhhbmRsZXIgPSBqZXMucXVlcnlIYW5sZGVyc1tvcF07XG5cbiAgICBpZiAoIWhhbmRsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfSEFORExFUihvcCkpO1xuICAgIH1cblxuICAgIHJldHVybiBoYW5kbGVyKHZhbHVlLCBvcFZhbHVlLCBqZXMsIHByZWZpeCk7XG59XG5cbmZ1bmN0aW9uIGV2YWx1YXRlVW5hcnkodmFsdWUsIG9wLCBqZXMsIHByZWZpeCkgeyBcbiAgICBjb25zdCBoYW5kbGVyID0gamVzLnF1ZXJ5SGFubGRlcnNbb3BdO1xuXG4gICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1FVRVJZX0hBTkRMRVIob3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gaGFuZGxlcih2YWx1ZSwgamVzLCBwcmVmaXgpO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgcmlnaHRWYWx1ZSwgb3BNZXRhLCBwcmVmaXgsIGplcykge1xuICAgIGlmIChvcE1ldGFbMV0pIHtcbiAgICAgICAgcmV0dXJuIHJpZ2h0VmFsdWUgPyBldmFsdWF0ZVVuYXJ5KGN1cnJlbnRWYWx1ZSwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCkgOiBjdXJyZW50VmFsdWU7XG4gICAgfSBcbiAgICBcbiAgICByZXR1cm4gZXZhbHVhdGUoY3VycmVudFZhbHVlLCBvcE1ldGFbMF0sIHJpZ2h0VmFsdWUsIGplcywgcHJlZml4KTtcbn1cblxuY29uc3QgZGVmYXVsdEN1c3RvbWl6ZXIgPSB7XG4gICAgbWFwT2ZPcGVyYXRvcnM6IE1hcE9mT3BzLFxuICAgIG1hcE9mTWFuaXB1bGF0b3JzOiBNYXBPZk1hbnMsXG4gICAgb3BlcmF0b3JIYW5kbGVyczogZGVmYXVsdEplc0hhbmRsZXJzLFxuICAgIG9wZXJhdG9yRXhwbGFuYXRpb25zOiBkZWZhdWx0SmVzRXhwbGFuYXRpb25zLFxuICAgIHF1ZXJ5SGFubGRlcnM6IGRlZmF1bHRNYW5pcHVsYXRpb25zXG59O1xuXG5mdW5jdGlvbiBtYXRjaENvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgb3BlcmFuZHMsIHByZWZpeCwgamVzKSB7XG4gICAgbGV0IG1hdGNoUmVzdWx0LCBuZXh0UHJlZml4O1xuXG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCBtYXBSZXN1bHQgPSBfLmlzUGxhaW5PYmplY3QoYWN0dWFsKSA/IF8ubWFwVmFsdWVzKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBmb3JtYXRQcmVmaXgoa2V5LCBwcmVmaXgpLCBqZXMpKSA6IF8ubWFwKGFjdHVhbCwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgb3BlcmFuZHNbMF0sIG9wTWV0YSwgZm9ybWF0UHJlZml4KGksIHByZWZpeCksIGplcykpO1xuICAgICAgICAgICAgbmV4dFByZWZpeCA9IGZvcm1hdFByZWZpeChmb3JtYXRNYXAoZm9ybWF0UXVlcnkob3BNZXRhKSksIHByZWZpeCk7XG4gICAgICAgICAgICBtYXRjaFJlc3VsdCA9IG1hdGNoKG1hcFJlc3VsdCwgb3BlcmFuZHNbMV0sIG5leHRQcmVmaXgsIGplcyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICAgXG4gICAgICAgICAgICBuZXh0UHJlZml4ID0gZm9ybWF0UHJlZml4KGZvcm1hdEFueShmb3JtYXRRdWVyeShvcE1ldGEpKSwgcHJlZml4KTtcbiAgICAgICAgICAgIG1hdGNoUmVzdWx0ID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gbWF0Y2goZXZhbHVhdGVCeU9wTWV0YShpdGVtLCBvcGVyYW5kc1swXSwgb3BNZXRhLCBmb3JtYXRQcmVmaXgoa2V5LCBwcmVmaXgpLCBqZXMpLCBvcGVyYW5kc1sxXSwgbmV4dFByZWZpeCwgamVzKSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbGxlY3Rpb24oYWN0dWFsLCBjb2xsZWN0aW9uT3AsIG9wLCBleHBlY3RlZEZpZWxkVmFsdWUsIHByZWZpeCwgamVzKSB7XG4gICAgc3dpdGNoIChjb2xsZWN0aW9uT3ApIHtcbiAgICAgICAgY2FzZSBQRlhfRk9SX0VBQ0g6XG4gICAgICAgICAgICBjb25zdCB1bm1hdGNoZWRLZXkgPSBfLmZpbmRJbmRleChhY3R1YWwsIChpdGVtKSA9PiAhdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgICAgICBpZiAodW5tYXRjaGVkS2V5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIHVubWF0Y2hlZEtleSwgYWN0dWFsW3VubWF0Y2hlZEtleV0sIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgXG4gICAgICAgICAgICBjb25zdCBtYXRjaGVkID0gXy5maW5kKGFjdHVhbCwgKGl0ZW0sIGtleSkgPT4gdGVzdChpdGVtLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpXG4gICAgICAgIFxuICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfQ09MTEVDVElPTl9PUChjb2xsZWN0aW9uT3ApKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBldmFsdWF0ZUNvbGxlY3Rpb24oY3VycmVudFZhbHVlLCBjb2xsZWN0aW9uT3AsIG9wTWV0YSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgsIGplcykge1xuICAgIHN3aXRjaCAoY29sbGVjdGlvbk9wKSB7XG4gICAgICAgIGNhc2UgUEZYX0ZPUl9FQUNIOlxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGN1cnJlbnRWYWx1ZSwgKGl0ZW0sIGkpID0+IGV2YWx1YXRlQnlPcE1ldGEoaXRlbSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIGZvcm1hdFByZWZpeChpLCBwcmVmaXgpLCBqZXMpKTtcblxuICAgICAgICBjYXNlIFBGWF9XSVRIX0FOWTogICAgICAgICBcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihQUlhfT1BfTk9UX0ZPUl9FVkFMKGNvbGxlY3Rpb25PcCkpO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9DT0xMRUNUSU9OX09QKGNvbGxlY3Rpb25PcCkpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBcbiAqIEBwYXJhbSB7Kn0gYWN0dWFsIFxuICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAqIEBwYXJhbSB7Kn0gcHJlZml4IFxuICogQHBhcmFtIHsqfSBqZXMgXG4gKiBcbiAqIHsga2V5OiB7ICRtYXRjaCB9IH1cbiAqL1xuZnVuY3Rpb24gbWF0Y2goYWN0dWFsLCBleHBlY3RlZCwgcHJlZml4LCBqZXMpIHtcbiAgICBqZXMgIT0gbnVsbCB8fCAoamVzID0gZGVmYXVsdEN1c3RvbWl6ZXIpO1xuICAgIGxldCBwYXNzT2JqZWN0Q2hlY2sgPSBmYWxzZTtcblxuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGV4cGVjdGVkKSkge1xuICAgICAgICBpZiAoIXRlc3QoYWN0dWFsLCAnT1BfRVFVQUwnLCBleHBlY3RlZCwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FUVVBTChudWxsLCBhY3R1YWwsIGV4cGVjdGVkLCBwcmVmaXgpICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gW3RydWVdO1xuICAgIH1cblxuICAgIGZvciAobGV0IGZpZWxkTmFtZSBpbiBleHBlY3RlZCkge1xuICAgICAgICBsZXQgZXhwZWN0ZWRGaWVsZFZhbHVlID0gZXhwZWN0ZWRbZmllbGROYW1lXTsgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBsID0gZmllbGROYW1lLmxlbmd0aDtcblxuICAgICAgICBpZiAobCA+IDEpIHsgICAgIFxuICAgICAgICAgICAgaWYgKGwgPiA0ICYmIGZpZWxkTmFtZVswXSA9PT0gJ3wnICYmIGZpZWxkTmFtZVsyXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZVszXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEZpZWxkVmFsdWUpICYmIGV4cGVjdGVkRmllbGRWYWx1ZS5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihOT1RfQV9UV09fVFVQTEUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9wcm9jZXNzb3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDMpOyBcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gbWF0Y2hDb2xsZWN0aW9uKGFjdHVhbCwgY29sbGVjdGlvbk9wLCBvcE1ldGEsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4LCBqZXMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hSZXN1bHQpIHJldHVybiBtYXRjaFJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy92YWxpZGF0b3JzXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb25PcCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgMik7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDIpOyBcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGplcy5tYXBPZk9wZXJhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfVEVTVF9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gdmFsaWRhdGVDb2xsZWN0aW9uKGFjdHVhbCwgY29sbGVjdGlvbk9wLCBvcCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgsIGplcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXRjaFJlc3VsdCkgcmV0dXJuIG1hdGNoUmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWVbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChsID4gMiAmJiBmaWVsZE5hbWVbMV0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPSBmaWVsZE5hbWUuc3Vic3RyKDEpO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vcHJvY2Vzc29yc1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BNZXRhWzFdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTk9UX0FfVU5BUllfUVVFUlkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnlSZXN1bHQgPSBldmFsdWF0ZVVuYXJ5KGFjdHVhbCwgb3BNZXRhWzBdLCBqZXMsIHByZWZpeCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBtYXRjaChxdWVyeVJlc3VsdCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBmb3JtYXRQcmVmaXgoZm9ybWF0UXVlcnkob3BNZXRhKSwgcHJlZml4KSwgamVzKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIW1hdGNoUmVzdWx0WzBdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWF0Y2hSZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy92YWxpZGF0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGplcy5tYXBPZk9wZXJhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihJTlZBTElEX1RFU1RfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCF0ZXN0KGFjdHVhbCwgb3AsIGV4cGVjdGVkRmllbGRWYWx1ZSwgamVzLCBwcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdldFVubWF0Y2hlZEV4cGxhbmF0aW9uKGplcywgb3AsIG51bGwsIGFjdHVhbCwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IFxuXG4gICAgICAgIGlmICghcGFzc09iamVjdENoZWNrKSB7XG4gICAgICAgICAgICBpZiAoYWN0dWFsID09IG51bGwpIHJldHVybiBbXG4gICAgICAgICAgICAgICAgZmFsc2UsICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9FWElTVFMobnVsbCwgbnVsbCwgdHJ1ZSwgcHJlZml4KVxuICAgICAgICAgICAgXTsgXG5cbiAgICAgICAgICAgIGNvbnN0IGFjdHVhbFR5cGUgPSB0eXBlb2YgYWN0dWFsO1xuICAgIFxuICAgICAgICAgICAgaWYgKGFjdHVhbFR5cGUgIT09ICdvYmplY3QnKSByZXR1cm4gW1xuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIGplcy5vcGVyYXRvckV4cGxhbmF0aW9ucy5PUF9UWVBFKG51bGwsIGFjdHVhbFR5cGUsICdvYmplY3QnLCBwcmVmaXgpXG4gICAgICAgICAgICBdOyAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcGFzc09iamVjdENoZWNrID0gdHJ1ZTtcblxuICAgICAgICBsZXQgYWN0dWFsRmllbGRWYWx1ZSA9IF8uZ2V0KGFjdHVhbCwgZmllbGROYW1lKTsgICAgIFxuICAgICAgICBcbiAgICAgICAgaWYgKGV4cGVjdGVkRmllbGRWYWx1ZSAhPSBudWxsICYmIHR5cGVvZiBleHBlY3RlZEZpZWxkVmFsdWUgPT09ICdvYmplY3QnKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBbIG9rLCByZWFzb24gXSA9IG1hdGNoKGFjdHVhbEZpZWxkVmFsdWUsIGV4cGVjdGVkRmllbGRWYWx1ZSwgZm9ybWF0UHJlZml4KGZpZWxkTmFtZSwgcHJlZml4KSwgamVzKTtcbiAgICAgICAgICAgIGlmICghb2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gWyBmYWxzZSwgcmVhc29uIF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIXRlc3QoYWN0dWFsRmllbGRWYWx1ZSwgJ09QX0VRVUFMJywgZXhwZWN0ZWRGaWVsZFZhbHVlLCBqZXMsIHByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgamVzLm9wZXJhdG9yRXhwbGFuYXRpb25zLk9QX0VRVUFMKGZpZWxkTmFtZSwgYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBwcmVmaXgpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIH0gXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gW3RydWVdO1xufVxuXG4vKipcbiAqIElmICQgb3BlcmF0b3IgdXNlZCwgb25seSBvbmUgYSB0aW1lIGlzIGFsbG93ZWRcbiAqIGUuZy5cbiAqIHtcbiAqICAgICRncm91cEJ5OiAnamZpZWpmJ1xuICogfVxuICogXG4gKiBcbiAqIEBwYXJhbSB7Kn0gY3VycmVudFZhbHVlIFxuICogQHBhcmFtIHsqfSBleHByIFxuICogQHBhcmFtIHsqfSBwcmVmaXggXG4gKiBAcGFyYW0geyp9IGplcyBcbiAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICovXG5mdW5jdGlvbiBldmFsdWF0ZUV4cHIoY3VycmVudFZhbHVlLCBleHByLCBwcmVmaXgsIGplcywgY29udGV4dCkge1xuICAgIGplcyAhPSBudWxsIHx8IChqZXMgPSBkZWZhdWx0Q3VzdG9taXplcik7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZXhwcikpIHtcbiAgICAgICAgcmV0dXJuIGV4cHIucmVkdWNlKChyZXN1bHQsIGV4cHJJdGVtKSA9PiBldmFsdWF0ZUV4cHIocmVzdWx0LCBleHBySXRlbSwgcHJlZml4LCBqZXMsIGNvbnRleHQpLCBjdXJyZW50VmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGVFeHByID0gdHlwZW9mIGV4cHI7XG5cbiAgICBpZiAodHlwZUV4cHIgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIHJldHVybiBleHByID8gY3VycmVudFZhbHVlIDogdW5kZWZpbmVkO1xuICAgIH0gICAgXG5cbiAgICBpZiAodHlwZUV4cHIgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmIChleHByLnN0YXJ0c1dpdGgoJyQkJykpIHtcbiAgICAgICAgICAgIC8vZ2V0IGZyb20gY29udGV4dFxuICAgICAgICAgICAgY29uc3QgcG9zID0gZXhwci5pbmRleE9mKCcuJyk7XG4gICAgICAgICAgICBpZiAocG9zID09PSAtMSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjb250ZXh0W2V4cHJdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5nZXQoY29udGV4dFtleHByLnN1YnN0cigwLCBwb3MpXSwgZXhwci5zdWJzdHIocG9zKzEpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZXhwcik7XG4gICAgICAgIGlmICghb3BNZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW9wTWV0YVsxXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFJFUVVJUkVfUklHSFRfT1BFUkFORChleHByKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZXZhbHVhdGVVbmFyeShjdXJyZW50VmFsdWUsIG9wTWV0YVswXSwgamVzLCBwcmVmaXgpO1xuICAgIH0gXG5cbiAgICBpZiAoY29udGV4dCA9PSBudWxsKSB7IFxuICAgICAgICBjb250ZXh0ID0geyAkJFJPT1Q6IGN1cnJlbnRWYWx1ZSwgJCRQQVJFTlQ6IG51bGwsICQkQ1VSUkVOVDogY3VycmVudFZhbHVlIH07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY29udGV4dCA9IHsgLi4uY29udGV4dCwgJCRQQVJFTlQ6IGNvbnRleHQuJCRDVVJSRU5ULCAkJENVUlJFTlQ6IGN1cnJlbnRWYWx1ZSB9O1xuICAgIH1cblxuICAgIGxldCByZXN1bHQsIGhhc09wZXJhdG9yID0gZmFsc2U7ICAgIFxuXG4gICAgZm9yIChsZXQgZmllbGROYW1lIGluIGV4cHIpIHtcbiAgICAgICAgbGV0IGV4cGVjdGVkRmllbGRWYWx1ZSA9IGV4cHJbZmllbGROYW1lXTsgIFxuICAgICAgICBcbiAgICAgICAgY29uc3QgbCA9IGZpZWxkTmFtZS5sZW5ndGg7XG5cbiAgICAgICAgaWYgKGwgPiAxKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IG9wTWV0YSA9IGplcy5tYXBPZk1hbmlwdWxhdG9ycy5nZXQoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoSU5WQUxJRF9RVUVSWV9PUEVSQVRPUihmaWVsZE5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXN1bHQgPSBldmFsdWF0ZUJ5T3BNZXRhKGN1cnJlbnRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBvcE1ldGEsIHByZWZpeCwgamVzKTtcbiAgICAgICAgICAgICAgICBoYXNPcGVyYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChsID4gMyAmJiBmaWVsZE5hbWVbMF0gPT09ICd8JyAmJiBmaWVsZE5hbWVbMl0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKE9QRVJBVE9SX05PVF9BTE9ORSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbk9wID0gZmllbGROYW1lLnN1YnN0cigwLCAyKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZmllbGROYW1lID0gZmllbGROYW1lLnN1YnN0cigyKTsgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBvcE1ldGEgPSBqZXMubWFwT2ZNYW5pcHVsYXRvcnMuZ2V0KGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFvcE1ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKElOVkFMSURfUVVFUllfT1BFUkFUT1IoZmllbGROYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gZXZhbHVhdGVDb2xsZWN0aW9uKGN1cnJlbnRWYWx1ZSwgY29sbGVjdGlvbk9wLCBvcE1ldGEsIGV4cGVjdGVkRmllbGRWYWx1ZSwgcHJlZml4LCBqZXMpO1xuICAgICAgICAgICAgICAgIGhhc09wZXJhdG9yID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihPUEVSQVRPUl9OT1RfQUxPTkUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9waWNrIGEgZmllbGQgYW5kIHRoZW4gYXBwbHkgbWFuaXB1bGF0aW9uXG4gICAgICAgIGxldCBhY3R1YWxGaWVsZFZhbHVlID0gY3VycmVudFZhbHVlICE9IG51bGwgPyBfLmdldChjdXJyZW50VmFsdWUsIGZpZWxkTmFtZSkgOiB1bmRlZmluZWQ7ICAgICBcblxuICAgICAgICBjb25zdCBjaGlsZEZpZWxkVmFsdWUgPSBldmFsdWF0ZUV4cHIoYWN0dWFsRmllbGRWYWx1ZSwgZXhwZWN0ZWRGaWVsZFZhbHVlLCBmb3JtYXRQcmVmaXgoZmllbGROYW1lLCBwcmVmaXgpLCBqZXMsIGNvbnRleHQpO1xuICAgICAgICBpZiAodHlwZW9mIGNoaWxkRmllbGRWYWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9IHtcbiAgICAgICAgICAgICAgICAuLi5yZXN1bHQsXG4gICAgICAgICAgICAgICAgW2ZpZWxkTmFtZV06IGNoaWxkRmllbGRWYWx1ZVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuY2xhc3MgSkVTIHtcbiAgICBjb25zdHJ1Y3Rvcih2YWx1ZSwgY3VzdG9taXplcikge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgIHRoaXMuY3VzdG9taXplciA9IGN1c3RvbWl6ZXI7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBleHBlY3RlZCBcbiAgICAgKiBAcGFyYW0gIHsuLi5hbnl9IGFyZ3MgXG4gICAgICovXG4gICAgbWF0Y2goZXhwZWN0ZWQpIHsgICAgICAgIFxuICAgICAgICBjb25zdCByZXN1bHQgPSBtYXRjaCh0aGlzLnZhbHVlLCBleHBlY3RlZCwgdW5kZWZpbmVkLCB0aGlzLmN1c3RvbWl6ZXIpO1xuICAgICAgICBpZiAocmVzdWx0WzBdKSByZXR1cm4gdGhpcztcblxuICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKHJlc3VsdFsxXSwge1xuICAgICAgICAgICAgYWN0dWFsOiB0aGlzLnZhbHVlLFxuICAgICAgICAgICAgZXhwZWN0ZWRcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZXZhbHVhdGUoZXhwcikge1xuICAgICAgICByZXR1cm4gZXZhbHVhdGVFeHByKHRoaXMudmFsdWUsIGV4cHIsIHVuZGVmaW5lZCwgdGhpcy5jdXN0b21pemVyKTtcbiAgICB9XG5cbiAgICB1cGRhdGUoZXhwcikge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGV2YWx1YXRlRXhwcih0aGlzLnZhbHVlLCBleHByLCB1bmRlZmluZWQsIHRoaXMuY3VzdG9taXplcik7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxufVxuXG5KRVMubWF0Y2ggPSBtYXRjaDtcbkpFUy5ldmFsdWF0ZSA9IGV2YWx1YXRlRXhwcjtcbkpFUy5kZWZhdWx0Q3VzdG9taXplciA9IGRlZmF1bHRDdXN0b21pemVyO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEpFUzsiXX0=
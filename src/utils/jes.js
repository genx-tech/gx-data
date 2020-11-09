// JSON Expression Syntax (JES)
const { _, hasKeyByPath } = require('rk-utils');
const { ValidationError } = require('./Errors');

//Exception messages
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

const REQUIRE_RIGHT_OPERAND = op => `Binary query operator "${op}" requires the right operand.`

//Condition operator
const OP_EQUAL = [ '$eq', '$eql', '$equal' ];
const OP_NOT_EQUAL = [ '$ne', '$neq', '$notEqual' ];
const OP_NOT = [ '$not' ];
const OP_GREATER_THAN = [ '$gt', '$>', '$greaterThan' ];
const OP_GREATER_THAN_OR_EQUAL = [ '$gte', '$<=', '$greaterThanOrEqual' ];
const OP_LESS_THAN = [ '$lt', '$<', '$lessThan' ];
const OP_LESS_THAN_OR_EQUAL = [ '$lte', '$<=', '$lessThanOrEqual' ];

const OP_IN = [ '$in' ];
const OP_NOT_IN = [ '$nin', '$notIn' ];
const OP_EXISTS = [ '$exist', '$exists', '$notNull' ];
const OP_MATCH = [ '$has', '$match', '$all' ];
const OP_MATCH_ANY = [ '$any', '$or', '$either' ];
const OP_TYPE = [ '$is', '$typeOf' ];
const OP_HAS_KEYS = [ '$hasKeys', '$withKeys' ];
const OP_START_WITH = [ '$startWith', '$startsWith' ];
const OP_END_WITH = [ '$endWith', '$endsWith' ];

//Query & aggregate operator
const OP_SIZE = [ '$size', '$length', '$count' ];
const OP_SUM = [ '$sum', '$total' ];
const OP_KEYS = [ '$keys' ];
const OP_VALUES = [ '$values' ];
const OP_GET_TYPE = [ '$type' ];

//Manipulate operation
const OP_ADD = [ '$add', '$plus',     '$inc' ];
const OP_SUB = [ '$sub', '$subtract', '$minus', '$dec' ];
const OP_MUL = [ '$mul', '$multiply',  '$times' ];
const OP_DIV = [ '$div', '$divide' ];
const OP_SET = [ '$set', '$=' ];
const OP_ADD_ITEM = [ '$addItem' ];

const OP_PICK = [ '$pick' ];
const OP_GET_BY_INDEX = [ '$at', '$getByIndex', '$nth' ];
const OP_GET_BY_KEY = [ '$of', '$getByKey' ];
const OP_OMIT = [ '$omit' ];
const OP_GROUP = [ '$group', '$groupBy' ];
const OP_SORT = [ '$sort', '$orderBy', '$sortBy' ];
const OP_REVERSE = [ '$reverse' ];
const OP_EVAL = [ '$eval', '$apply' ];
const OP_MERGE = [ '$merge' ];

//Condition operation
const OP_IF = [ '$if' ];

const PFX_FOR_EACH = '|>'; // for each
const PFX_WITH_ANY = '|*'; // with any

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
// [ <op name>, <unary> ]
addManToMap(OP_SIZE, ['OP_SIZE', true ]); 
addManToMap(OP_SUM, ['OP_SUM', true ]); 
addManToMap(OP_KEYS, ['OP_KEYS', true ]); 
addManToMap(OP_VALUES, ['OP_VALUES', true ]); 
addManToMap(OP_GET_TYPE, ['OP_GET_TYPE', true ]); 
addManToMap(OP_REVERSE, ['OP_REVERSE', true]);

addManToMap(OP_ADD, ['OP_ADD', false ]); 
addManToMap(OP_SUB, ['OP_SUB', false ]);
addManToMap(OP_MUL, ['OP_MUL', false ]);
addManToMap(OP_DIV, ['OP_DIV', false ]);
addManToMap(OP_SET, ['OP_SET', false ]);
addManToMap(OP_ADD_ITEM, ['OP_ADD_ITEM', false ]);
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
    //unary
    OP_SIZE: (left) => _.size(left),
    OP_SUM: (left) => _.reduce(left, (sum, item) => {
            sum += item;
            return sum;
        }, 0),

    OP_KEYS: (left) => _.keys(left),
    OP_VALUES: (left) => _.values(left),   
    OP_GET_TYPE: (left) => Array.isArray(left) ? 'array' : (_.isInteger(left) ? 'integer' : typeof left),  
    OP_REVERSE: (left) => _.reverse(left),

    //binary
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

        return { ...left, [right[0]]: evaluateExpr(undefined, right[1], jes, prefix, context, true) };
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
        
        return right.reduce((result, expr) => Object.assign(result, evaluateExpr(left, expr, jes, prefix, { ...context })), {});
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
}

const formatName = (name, prefix) => {
    const fullName = name == null ? prefix : formatPrefix(name, prefix);
    return fullName == null ? "The value" : (fullName.indexOf('(') !== -1 ? `The query "_.${fullName}"` : `"${fullName}"`);
};
const formatKey = (key, hasPrefix) => _.isInteger(key) ? `[${key}]` : (hasPrefix ? '.' + key : key);
const formatPrefix = (key, prefix) => prefix != null ? `${prefix}${formatKey(key, true)}` : formatKey(key, false);
const formatQuery = (opMeta) => `${defaultQueryExplanations[opMeta[0]]}(${opMeta[1] ? '' : '?'})`;  
const formatMap = (name) => `each(->${name})`;
const formatAny = (name) => `any(->${name})`;

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
    OP_EXISTS: (name, left, right, prefix) => `${formatName(name, prefix)} should${right ? ' not ': ' '}be NULL.`,    
    OP_TYPE: (name, left, right, prefix) => `The type of ${formatName(name, prefix)} should be "${right}", but ${JSON.stringify(left)} given.`,        
    OP_MATCH: (name, left, right, prefix) => `${formatName(name, prefix)} should match ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,    
    OP_MATCH_ANY: (name, left, right, prefix) => `${formatName(name, prefix)} should match any of ${JSON.stringify(right)}, but ${JSON.stringify(left)} given.`,    
    OP_HAS_KEYS: (name, left, right, prefix) => `${formatName(name, prefix)} should have all of these keys [${right.join(', ')}].`,        
    OP_START_WITH: (name, left, right, prefix) => `${formatName(name, prefix)} should start with "${right}".`,        
    OP_END_WITH: (name, left, right, prefix) => `${formatName(name, prefix)} should end with "${right}".`,        
};

const defaultQueryExplanations = {
    //unary
    OP_SIZE: 'size',
    OP_SUM: 'sum',
    OP_KEYS: 'keys',
    OP_VALUES: 'values',    
    OP_GET_TYPE: 'get type',
    OP_REVERSE: 'reverse', 

    //binary
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
            const unmatchedKey = _.findIndex(actual, (item) => !test(item, op, expectedFieldValue, jes, prefix))
            if (unmatchedKey) {
                return [
                    false,
                    getUnmatchedExplanation(jes, op, unmatchedKey, actual[unmatchedKey], expectedFieldValue, prefix)
                ];
            }
            break;

        case PFX_WITH_ANY:       
            const matched = _.find(actual, (item, key) => test(item, op, expectedFieldValue, jes, prefix))
        
            if (!matched) {
                return [
                    false,
                    getUnmatchedExplanation(jes, op, null, actual, expectedFieldValue, prefix)
                ];
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
            return _.map(currentValue, (item, i) => evaluateByOpMeta(item, expectedFieldValue, opMeta, jes, formatPrefix(i, prefix), { ...context, $$PARENT: currentValue, $$CURRENT: item }));

        case PFX_WITH_ANY:         
            throw new Error(PRX_OP_NOT_FOR_EVAL(collectionOp));

        default:
            throw new Error(INVALID_COLLECTION_OP(collectionOp));
    }
}

/**
 * 
 * @param {*} actual 
 * @param {*} expected 
 * @param {*} jes 
 * @param {*} prefix  
 * 
 * { key: { $match } }
 */
function match(actual, expected, jes, prefix) {
    jes != null || (jes = defaultCustomizer);
    let passObjectCheck = false;

    if (!_.isPlainObject(expected)) {
        if (!test(actual, 'OP_EQUAL', expected, jes, prefix)) {
            return [
                false,
                jes.operatorExplanations.OP_EQUAL(null, actual, expected, prefix)                
            ];
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

                    //processors
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
                    //validators
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

                    //processors
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

                //validator
                const op = jes.mapOfOperators.get(fieldName);
                if (!op) {
                    throw new Error(INVALID_TEST_OPERATOR(fieldName));
                }

                if (!test(actual, op, expectedFieldValue, jes, prefix)) {
                    return [
                        false,
                        getUnmatchedExplanation(jes, op, null, actual, expectedFieldValue, prefix)
                    ];
                } 

                continue;
            }            
        } 

        if (!passObjectCheck) {
            if (actual == null) return [
                false,                
                jes.operatorExplanations.OP_EXISTS(null, null, true, prefix)
            ]; 

            const actualType = typeof actual;
    
            if (actualType !== 'object') return [
                false,
                jes.operatorExplanations.OP_TYPE(null, actualType, 'object', prefix)
            ];    
        }        

        passObjectCheck = true;

        let actualFieldValue = _.get(actual, fieldName);     
        
        if (expectedFieldValue != null && typeof expectedFieldValue === 'object') {            
            const [ ok, reason ] = match(actualFieldValue, expectedFieldValue, jes, formatPrefix(fieldName, prefix));
            if (!ok) {
                return [ false, reason ];
            }
        } else {            
            if (!test(actualFieldValue, 'OP_EQUAL', expectedFieldValue, jes, prefix)) {
                return [
                    false,
                    jes.operatorExplanations.OP_EQUAL(fieldName, actualFieldValue, expectedFieldValue, prefix)
                ];
            } 
        }
    }

    return [true];
}

/**
 * If $ operator used, only one a time is allowed
 * e.g.
 * {
 *    $groupBy: 'key'
 * }
 * 
 * 
 * @param {*} currentValue 
 * @param {*} expr 
 * @param {*} prefix 
 * @param {*} jes 
 * @param {*} context
 */
function evaluateExpr(currentValue, expr, jes, prefix, context, setOp) {
    jes != null || (jes = defaultCustomizer);
    if (Array.isArray(expr)) {
        if (setOp) {
            return expr.map(item => evaluateExpr(undefined, item, jes, prefix, { ...context }, true));
        }
        
        return expr.reduce((result, exprItem) => evaluateExpr(result, exprItem, jes, prefix, { ...context }), currentValue);
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
            //get from context
            const pos = expr.indexOf('.');
            if (pos === -1) {                
                return context[expr];
            }

            return _.get(context[expr.substr(0, pos)], expr.substr(pos+1));
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
        context = { $$ROOT: currentValue, $$PARENT: null, $$CURRENT: currentValue };        
    } 

    let result, hasOperator = false;    

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

        //pick a field and then apply manipulation
        let actualFieldValue = currentValue != null ? (compleyKey ? _.get(currentValue, fieldName) : currentValue[fieldName]) : undefined;         

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

    /**
     * 
     * @param {*} expected 
     * @param  {...any} args 
     */
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
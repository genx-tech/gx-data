// JSON Expression Syntax (JES)
const { _ } = require('rk-utils');

//Condition operator
const OP_EQUAL = [ '$eq', '$eql', '$equal' ];
const OP_NOT_EQUAL = [ '$ne', '$neq', '$notEqual' ];

const OP_GREATER_THAN = [ '$gt', '$>', '$greaterThan' ];
const OP_GREATER_THAN_OR_EQUAL = [ '$gte', '$<=', '$greaterThanOrEqual' ];

const OP_LESS_THAN = [ '$lt', '$<', '$lessThan' ];
const OP_LESS_THAN_OR_EQUAL = [ '$lte', '$<=', '$lessThanOrEqual' ];

const OP_IN = [ '$in' ];
const OP_NOT_IN = [ '$nin', '$notIn' ];

const OP_EXISTS = [ '$exist', '$exists' ];

const OP_HAS = [ '$has' ];

const OP_TYPE = [ '$type' ];

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
addOpToMap(OP_HAS, 'OP_HAS');
addOpToMap(OP_TYPE, 'OP_TYPE');

//Array condition operator
const OP_ELEMENT_ALL = [ '$all' ];
const OP_ELEMENT_ANY = [ '$any' ];

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
            throw new Error('The right operand of JES operator "OP_IN" should be an array.');
        }
        return right.find(element => defaultJesHandlers.OP_EQUAL(left, element));
    },
    OP_NOT_IN: (left, right) => {
        if (right == null) return true;
        if (!Array.isArray(right)) {
            throw new Error('The right operand of JES operator "OP_NOT_IN" should be an array.');
        }
        return _.every(right, element => defaultJesHandlers.OP_NOT_EQUAL(left, element));
    },
    OP_EXISTS: (left, right) => {
        if (typeof right !== 'boolean') {
            throw new Error('The right operand of JES operator "OP_EXISTS" should be a boolean value.');
        }

        console.log(left, right);

        return right ? left != null : left == null;
    },
    OP_TYPE: (left, right) => {
        if (typeof right !== 'string') {
            throw new Error('The right operand of JES operator "OP_TYPE" should be a string.');
        }
        return typeof left === right;
    }
};

const formatName = (name) => name ? `"${name}"` : 'The value';

const defaultJesExplanations = {
    OP_EQUAL: (name, right) => `${formatName(name)} should be ${JSON.stringify(right)}.`,
    OP_NOT_EQUAL: (name, right) => `${formatName(name)} should not be ${JSON.stringify(right)}.`,
    OP_GREATER_THAN: (name, right) => `${formatName(name)} should be greater than ${right}.`,
    OP_GREATER_THAN_OR_EQUAL: (name, right) => `${formatName(name)} should be greater than or equal to ${right}.`,
    OP_LESS_THAN: (name, right) => `${formatName(name)} should be less than ${right}.`,
    OP_LESS_THAN_OR_EQUAL: (name, right) => `${formatName(name)} should be less than or equal to ${right}.`,
    OP_IN: (name, right) => `${formatName(name)} should be one of ${JSON.stringify(right)}.`,
    OP_NOT_IN: (name, right) => `${formatName(name)} should not be any one of ${JSON.stringify(right)}.`,
    OP_EXISTS: (name, right) => `${formatName(name)} should${right ? ' not ': ' '}be NULL.`,    
    OP_TYPE: (name, right) => `The type of ${formatName(name)} should be "${right}".`,
};

function test (value, op, opValue, jes = defaultCustomizer) {   
    const handler = jes.operatorHandlers[op];

    if (!handler) {
        throw new Error(`JES operator "${op}" handler not found.`);
    }

    return handler(value, opValue);
}

const defaultCustomizer = {
    operatorHandlers: defaultJesHandlers,
    operatorEplanations: defaultJesExplanations,
    has: has
};

/**
 * 
 * @param {*} actual 
 * @param {*} expected 
 * @param {*} prefix 
 * @param {*} jes 
 * 
 * { key: { $has } }
 */
function has(actual, expected, prefix, jes = defaultCustomizer) {
    let passObjectCheck = false;

    for (let fieldName in expected) {
        let expectedFieldValue = expected[fieldName];        

        if (fieldName.length > 1 && fieldName[0] === '$') {            
            const op = MapOfOps.get(fieldName);
            if (!op) {
                throw new Error(`Invalid JES operator token "${fieldName}".`);
            }

            if (!test(actual, op, expectedFieldValue, jes)) {
                return [
                    false,
                    jes.operatorEplanations[op](prefix, expectedFieldValue)
                ];
            } 

            continue;
        } 

        if (!passObjectCheck) {
            if (actual == null) return [
                false,
                jes.operatorEplanations.OP_EXISTS(prefix, true)
            ]; 
    
            if (typeof actual !== 'object') return [
                false,
                jes.operatorEplanations.OP_TYPE(prefix, 'object')
            ];    
        }        

        passObjectCheck = true;

        let actualFieldValue = actual[fieldName];     
        
        if (expectedFieldValue != null && typeof expectedFieldValue === 'object') {            
            const [ ok, reason ] = has(actualFieldValue, expectedFieldValue, prefix ? (prefix + '.' + fieldName) : fieldName, jes);
            if (!ok) {
                return [ false, reason ];
            }
        } else {            
            if (!test(actualFieldValue, 'OP_EQUAL', expectedFieldValue, jes)) {
                return [
                    false,
                    jes.operatorEplanations.OP_EQUAL(prefix ? (prefix + '.' + fieldName) : fieldName, expectedFieldValue)
                ];
            } 
        }
    }

    return [true];
}

exports.test = test;
exports.has = has;
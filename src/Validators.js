"use strict";

const Util = require('rk-utils');
const { _ } = Util;
const { isNothing } = require('./utils/lang');
const { tryRequire } = require('./utils/lib');

const validator = require('validator');

module.exports = _.pick(validator, [ 
    'equals',
    'contains',
    'matches',
    'isEmail',
    'isURL',
    'isMACAddress',
    'isIP',
    'isFQDN',
    'isBoolean',
    'isAlpha',
    'isAlphanumeric',
    'isNumeric',
    'isPort',
    'isLowercase',
    'isUppercase',
    'isAscii',
    'isFullWidth',
    'isHalfWidth',
    'isVariableWidth',
    'isMultibyte',
    'isSurrogatePair',
    'isInt',
    'isFloat',
    'isDecimal',
    'isHexadecimal',
    'isDivisibleBy',
    'isHexColor',
    'isISRC',
    'isMD5',
    'isHash',
    'isJSON',
    'isEmpty',
    'isLength',
    'isByteLength',
    'isUUID',
    'isMongoId',
    'isAfter',
    'isBefore',
    'isIn',
    'isCreditCard',
    'isISIN',
    'isISBN',
    'isISSN',
    'isMobilePhone',
    'isPostalCode',
    'isCurrency',
    'isISO8601',
    'isISO31661Alpha2',
    'isBase64',
    'isDataURI',
    'isMimeType',
    'isLatLong'
]);

const RE_PHONE = /^((\+|00)\d+)?(\(\d+\))?((\ |-)?\d+)*$/;

module.exports.isPhone = function (value) {
    return RE_PHONE.test(value);
}

module.exports.min = function (value, minValue) {
    return value >= minValue;
};

module.exports.max = function (value, maxValue) {
    return value <= maxValue;
};

module.exports.gt = function (value, minValue) {
    return value > minValue;
};

module.exports.lt = function (value, maxValue) {
    return value < maxValue;
};

module.exports.maxLength = function (value, maxLength) {
    return value.length <= maxLength;
};

module.exports.notNull = function (value) {
    return !isNothing(value);
};

module.exports.notNullIf = function (value, condition) {
    return !condition || !isNothing(value);
};

/**
 * Validate an obj with condition like mongo-style query
 * @param {*} obj 
 * @param {array|object} condition 
 * @returns {boolean}
 */
function validate(obj, condition) {    
    const { Query } = tryRequire('mingo');
    let query = new Query(condition);
    
    // test if an object matches query
    return query.test(obj);
}

module.exports.validate = validate;
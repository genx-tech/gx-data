"use strict";

const Util = require('rk-utils');
const { _ } = Util;
const { isNothing } = require('./utils/lang');
const { tryRequire } = require('./utils/lib');
const { ValidationError } = require('./utils/Errors');
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

function validateObjectBySchema(raw, schema, i18n, prefix) {   
    let latest = {};
    const Types = require('./types');

    if (schema.type && schema.type !== 'object') {
        return Types.sanitize(raw, schema, i18n, prefix);
    }

    _.forOwn(schema, (fieldInfo, fieldName) => {
        if (fieldName in raw) {
            let value = raw[fieldName];
            
            //sanitize first
            if (isNothing(value)) {
                if (!fieldInfo.optional && isNothing(fieldInfo.default)) {
                    throw new ValidationError(`Value of property "${prefix ? prefix + '.' : ''}${fieldName}${fieldInfo.comment ? ' - ' + fieldInfo.comment : ''}" cannot be null`);
                }

                latest[fieldName] = fieldInfo.default ?? null;
            } else {
                if (fieldInfo.type) {
                    latest[fieldName] = Types.sanitize(value, fieldInfo, i18n, (prefix ? prefix + '.' : '') + fieldName);
                } else {                    
                    latest[fieldName] = value;
                }
            }

            return;
        }       

        if (!fieldInfo.optional) {
            throw new ValidationError(`Missing required property "${prefix ? prefix + '.' : ''}${fieldName}${fieldInfo.comment ? ' - ' + fieldInfo.comment : ''}"`);
        }        

        if ('default' in fieldInfo) {
            latest[fieldName] = fieldInfo.default
        }
    });

    return latest;
}

module.exports.validateObjectBySchema = validateObjectBySchema;
"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const {
  isNothing
} = require('./utils/lang');

const {
  ValidationError
} = require('./utils/Errors');

const validator = require('validator');

const Types = require('./types');

module.exports = _.pick(validator, ['equals', 'contains', 'matches', 'isEmail', 'isURL', 'isMACAddress', 'isIP', 'isFQDN', 'isBoolean', 'isAlpha', 'isAlphanumeric', 'isNumeric', 'isPort', 'isLowercase', 'isUppercase', 'isAscii', 'isFullWidth', 'isHalfWidth', 'isVariableWidth', 'isMultibyte', 'isSurrogatePair', 'isInt', 'isFloat', 'isDecimal', 'isHexadecimal', 'isDivisibleBy', 'isHexColor', 'isISRC', 'isMD5', 'isHash', 'isJSON', 'isEmpty', 'isLength', 'isByteLength', 'isUUID', 'isMongoId', 'isAfter', 'isBefore', 'isIn', 'isCreditCard', 'isISIN', 'isISBN', 'isISSN', 'isMobilePhone', 'isPostalCode', 'isCurrency', 'isISO8601', 'isISO31661Alpha2', 'isBase64', 'isDataURI', 'isMimeType', 'isLatLong']);
const RE_PHONE = /^((\+|00)\d+)?(\(\d+\))?(( |-)?\d+)*$/;

module.exports.isPhone = function (value) {
  return RE_PHONE.test(value);
};

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

const NIL = Symbol('nil');

function validateObjectMember(raw, fieldName, fieldInfo, i18n, prefix) {
  if (fieldName in raw) {
    const value = raw[fieldName];

    if (isNothing(value)) {
      if (!fieldInfo.optional && isNothing(fieldInfo.default)) {
        throw new ValidationError(`Value of property "${prefix ? prefix + '.' : ''}${fieldName}${fieldInfo.comment ? ' - ' + fieldInfo.comment : ''}" cannot be null`);
      }

      return fieldInfo.default ?? null;
    }

    if (fieldInfo.type) {
      return Types.sanitize(value, fieldInfo, i18n, (prefix ? prefix + '.' : '') + fieldName);
    }

    return value;
  }

  if (!fieldInfo.optional) {
    throw new ValidationError(`Missing required property "${prefix ? prefix + '.' : ''}${fieldName}${fieldInfo.comment ? ' - ' + fieldInfo.comment : ''}"`);
  }

  if ('default' in fieldInfo) {
    return fieldInfo.default;
  }

  return NIL;
}

function validateObjectBySchema(raw, schema, i18n, prefix) {
  const latest = {};

  if (typeof raw !== 'object') {
    throw new ValidationError('The value is not an object.', {
      raw,
      prefix
    });
  }

  if (typeof schema === 'function') {
    schema = schema();
  }

  _.forOwn(schema, (fieldInfo, fieldName) => {
    if (Array.isArray(fieldInfo)) {
      if (!fieldInfo.find(fieldInfoOption => {
        let validated;
        let hasError = false;

        try {
          validated = validateObjectMember(raw, fieldName, { ...fieldInfoOption,
            skipTypeCast: true
          }, i18n, prefix);
        } catch (error) {
          hasError = true;
          validated = NIL;
        }

        if (validated !== NIL) {
          latest[fieldName] = validated;
        }

        return !hasError;
      })) {
        throw new ValidationError(`Invalid "${fieldName}" value.`, {
          raw,
          prefix
        });
      }
    } else {
      const validated = validateObjectMember(raw, fieldName, fieldInfo, i18n, prefix);

      if (validated !== NIL) {
        latest[fieldName] = validated;
      }
    }
  });

  return latest;
}

module.exports.validateObjectBySchema = validateObjectBySchema;
//# sourceMappingURL=Validators.js.map
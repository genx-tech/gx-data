"use strict";

require("source-map-support/register");

const Convertors = require('../Convertors');

const randomstring = require('randomstring');

const {
  _
} = require('@genx/july');

const {
  ValidationError
} = require('../utils/Errors');

const any = require('./any');

module.exports = {
  name: 'text',
  alias: ['string', 'char'],
  sanitize: (value, info, i18n) => {
    if (value == null) return null;

    if (!info || !info.skipTypeCast) {
      value = Convertors.toText(value, info && info.noTrim);
    }

    if (value === '' && info.emptyAsNull) {
      return null;
    }

    if (!_.isNil(value)) {
      if (info && info.fixedLength && value.length !== info.fixedLength) {
        throw new ValidationError(`The length of the ${info.name || 'text'} value is not correct (expected: ${info.fixedLength}, actual: ${value.length}).`, {
          value,
          feild: info
        });
      }

      if (info && info.maxLength && value.length > info.maxLength) {
        throw new ValidationError(`The length of the ${info.name || 'text'} value exceeds max limit (maximum: ${info.maxLength}, actual: ${value.length}).`, {
          value,
          feild: info
        });
      }

      if (info && info.minLength && value.length < info.minLength) {
        throw new ValidationError(`The length of the ${info.name || 'text'} value does not reach min requirement (minimum: ${info.minLength}, actual: ${value.length}).`, {
          value,
          feild: info
        });
      }
    }

    return value;
  },
  defaultValue: '',
  generate: (info, i18n) => {
    const randOpt = {};

    if (info.fixedLength) {
      randOpt.length = info.fixedLength;
    }

    if (info.maxLength) {
      randOpt.length = info.maxLength > 32 ? 32 : info.maxLength;
    }

    if (info.allowedChars) {
      randOpt.charset = info.allowedChars;
    }

    if (info.caps) {
      randOpt.capitalization = info.caps;
    }

    return randomstring.generate(randOpt);
  },
  serialize: value => value,
  qualifiers: any.qualifiers.concat(['fixedLength', 'maxLength', 'encoding', 'allowedChars', 'caps', 'noTrim', 'emptyAsNull'])
};
//# sourceMappingURL=text.js.map
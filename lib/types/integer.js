"use strict";

require("source-map-support/register");

const Convertors = require('../Convertors');

const {
  ValidationError
} = require('../utils/Errors');

const any = require('./any');

module.exports = {
  name: 'integer',
  alias: ['int'],
  sanitize: (value, info, i18n, field) => {
    if (value == null) return null;
    const raw = value;
    value = Convertors.toInt(value);

    if (isNaN(value)) {
      throw new ValidationError('Invalid integer value', {
        value: raw,
        field: info
      });
    }

    if (info && 'max' in info && value > info.max) {
      throw new ValidationError(`The field "${field || ''}" value should smaller than ${info.max}`, {
        value,
        feild: info
      });
    }

    if (info && 'min' in info && value < info.min) {
      throw new ValidationError(`The field "${field || ''}" value should bigger than ${info.min}`, {
        value,
        feild: info
      });
    }

    return value;
  },
  defaultValue: 0,
  generate: (info, i18n) => 0,
  serialize: value => value,
  qualifiers: any.qualifiers.concat(['bytes', 'digits', 'unsigned'])
};
//# sourceMappingURL=integer.js.map
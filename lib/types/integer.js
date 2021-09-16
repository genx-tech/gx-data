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
  sanitize: (value, info, i18n) => {
    if (value == null) return null;
    let raw = value;
    value = Convertors.toInt(value);

    if (isNaN(value)) {
      throw new ValidationError('Invalid integer value', {
        value: raw,
        field: info
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
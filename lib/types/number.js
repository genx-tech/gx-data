"use strict";

require("source-map-support/register");
const Convertors = require('../Convertors');
const any = require('./any');
module.exports = {
  name: 'number',
  alias: ['float', 'decimal', 'double'],
  sanitize: (value, info, i18n) => value == null ? null : Convertors.toFloat(value),
  defaultValue: 0,
  generate: (info, i18n) => 0,
  serialize: value => value,
  qualifiers: any.qualifiers.concat(['exact', 'totalDigits', 'decimalDigits', 'bytes', 'double'])
};
//# sourceMappingURL=number.js.map
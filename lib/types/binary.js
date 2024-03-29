"use strict";

require("source-map-support/register");
const {
  isNothing
} = require('../utils/lang');
const any = require('./any');
module.exports = {
  name: 'binary',
  alias: ['blob', 'buffer'],
  sanitize: (value, info, i18n) => value == null ? null : value instanceof Buffer ? value : Buffer.from(value.toString()),
  defaultValue: 0,
  generate: (info, i18n) => null,
  serialize: (value, options) => isNothing(value) ? null : value.toString(options && options.encoding || 'base64'),
  qualifiers: any.qualifiers.concat(['fixedLength', 'maxLength'])
};
//# sourceMappingURL=binary.js.map
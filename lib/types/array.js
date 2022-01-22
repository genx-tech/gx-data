"use strict";

require("source-map-support/register");

const {
  quote
} = require('@genx/july');

const {
  isNothing
} = require('../utils/lang');

const any = require('./any');

const {
  ValidationError
} = require('../utils/Errors');

function sanitize(value, info, i18n, prefix) {
  if (value == null) return null;
  const raw = value;

  if (typeof value === 'string') {
    if (info.csv) {
      return value;
    } else {
      const trimmed = value.trim();

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        value = sanitize(JSON.parse(trimmed), info, i18n, prefix);
      }
    }
  }

  if (Array.isArray(value)) {
    if (info.elementSchema) {
      const schema = typeof info.elementSchema === 'function' ? info.elementSchema() : info.elementSchema;

      const Types = require('.');

      return value.map((a, i) => Types.sanitize(a, schema, i18n, prefix + `[${i}]`));
    }

    return value;
  }

  throw new ValidationError('Invalid array value', {
    value: raw,
    field: info
  });
}

module.exports = {
  name: 'array',
  alias: ['list'],
  sanitize: sanitize,
  defaultValue: [],
  generate: (info, i18n) => [],
  serialize: value => isNothing(value) ? null : JSON.stringify(value),
  qualifiers: any.qualifiers.concat(['csv', 'of', 'elementSchema']),
  toCsv: (data, separator = ',') => data.map(elem => {
    elem = elem.toString();
    return elem.indexOf(separator) !== -1 ? quote(elem, '"') : elem;
  }).join(separator)
};
//# sourceMappingURL=array.js.map
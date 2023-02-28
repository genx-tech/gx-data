"use strict";

require("source-map-support/register");
const {
  DateTime
} = require('luxon');
const any = require('./any');
const {
  ValidationError
} = require('../utils/Errors');
module.exports = {
  name: 'datetime',
  typeObject: DateTime,
  alias: ['date', 'time', 'timestamp'],
  sanitize: (value, info, i18n) => {
    if (value == null) return null;
    const opts = {
      zone: (i18n == null ? void 0 : i18n.timezone) || 'local'
    };
    const raw = value;
    if (value instanceof Date) {
      value = DateTime.fromJSDate(value, opts);
    } else {
      const type = typeof value;
      if (type === 'string' && !info.dontParse) {
        if (info.inputFormat) {
          value = DateTime.fromFormat(value, info.inputFormat, opts);
        } else {
          value = DateTime.fromISO(value, opts);
        }
      } else if (type === 'number') {
        value = DateTime.fromMillis(value, opts);
      } else if (type !== 'object' || !value.isLuxonDateTime) {
        throw new ValidationError('Invalid datetime object.', {
          value: raw,
          field: info
        });
      }
    }
    if (!value.isValid) {
      throw new ValidationError('Invalid datetime object.', {
        value: raw,
        field: info
      });
    }
    return value;
  },
  defaultValue: 0,
  generate: (info, i18n) => i18n ? i18n.now() : DateTime.local(),
  serialize: value => {
    if (value && value.toISO) {
      return value.toISO({
        includeOffset: false
      });
    }
    return value;
  },
  qualifiers: any.qualifiers.concat(['timezone', 'dateOnly', 'timeOnly', 'inputFormat', 'dontParse'])
};
//# sourceMappingURL=datetime.js.map
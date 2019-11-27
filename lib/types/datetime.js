"use strict";

const _ = require('rk-utils')._;

const {
  DateTime
} = require('luxon');

const any = require('./any');

module.exports = {
  name: 'datetime',
  typeObject: DateTime,
  alias: ['date', 'time', 'timestamp'],
  sanitize: (value, info, i18n) => {
    if (value instanceof Date) {
      return i18n ? i18n.datetime.fromJSDate(value) : DateTime.fromJSDate(value);
    }

    if (value instanceof DateTime) {
      return value;
    }

    if (typeof value === 'string') {
      return i18n ? i18n.datetime.fromISO(value) : DateTime.fromISO(value, {
        setZone: true
      });
    }

    if (typeof value === 'number') {
      return i18n ? i18n.datetime.fromMillis(value) : DateTime.fromMillis(value);
    }

    if (_.isPlainObject(value)) {
      return i18n ? i18n.datetime.fromObject(value) : DateTime.fromObject(value);
    }

    throw new TypeError(`Invalid datetime: ${value}`);
  },
  defaultValue: 0,
  generate: (info, i18n) => i18n ? i18n.now() : DateTime.local(),
  serialize: value => value.toISO({
    includeOffset: false
  }),
  qualifiers: any.qualifiers.concat(['timezone', 'dateOnly', 'timeOnly'])
};
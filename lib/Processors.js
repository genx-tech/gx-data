"use strict";

const {
  _,
  replaceAll
} = require('rk-utils');

const normalizePhone = require('./processors/normalizePhone');

module.exports = {
  trim: (s, chars) => _.trim(s, chars),
  stringDasherize: s => _.words(s).join('-'),
  isSet: v => !_.isNil(v),
  upperCase: s => s.toUpperCase(),
  lowerCase: s => s.toLowerCase(),
  ifNullSetTo: (v, other) => _.isNil(v) ? other : v,
  normalizePhone: normalizePhone,
  removeSpace: s => replaceAll(s, ' ', '')
};
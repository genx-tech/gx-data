"use strict";

const _ = require('rk-utils')._;
const any = require('./any');

module.exports = {
    name: 'number',

    alias: [ 'float', 'decimal', 'double' ],

    sanitize: (value, info, i18n) => _.isFinite(value) ? value : _.toNumber(value),

    defaultValue: 0,

    generate: (info, i18n) => 0,

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'exact',
        'totalDigits',        
        'decimalDigits'
    ])
};
"use strict";

const validator = require('validator');
const _ = require('rk-utils')._;
const any = require('./any');

module.exports = {
    name: 'integer',

    alias: [ 'int' ],

    sanitize: (value, info, i18n) => _.isInteger(value) ? value : validator.toInt(value),

    defaultValue: 0,

    generate: (info, i18n) => 0,

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'bytes',
        'digits',        
        'unsigned'
    ])
};
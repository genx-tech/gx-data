"use strict";

const Convertors = require('../Convertors');
const _ = require('rk-utils')._;
const any = require('./any');

module.exports = {
    name: 'integer',

    alias: [ 'int' ],

    sanitize: (value, info, i18n) => Convertors.toInt(value),

    defaultValue: 0,

    generate: (info, i18n) => 0,

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'bytes',
        'digits',        
        'unsigned'
    ])
};
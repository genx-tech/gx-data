"use strict";

const Convertors = require('../Convertors');
const any = require('./any');

module.exports = {
    name: 'boolean',

    alias: [ 'bool' ],

    sanitize: (value, info, i18n) => value == null ? null : Convertors.toBoolean(value),

    defaultValue: false,

    generate: (info, i18n) => false,

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
    ])
};
"use strict";

const any = require('./any');

module.exports = {
    name: 'enum',    

    sanitize: (value) => (typeof raw !== 'string' ? value.toString() : value).trim(),

    defaultValue: 0,

    generate: (info, i18n) => info.values && info.values.length > 0 && info.values[0],

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'values'
    ])
};
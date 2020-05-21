"use strict";

const any = require('./any');
const { ValidationError } = require('../utils/Errors');

module.exports = {
    name: 'enum',    

    sanitize: (value, info) => {
        if (value == null) return null;

        let raw = value;
        value = (typeof value !== 'string' ? value.toString() : value).trim();

        if (info.values && info.values.indexOf(value) === -1) {
            throw new ValidationError('Invalid enum value', { value: raw, field: info });
        }

        return value;
    },

    defaultValue: 0,

    generate: (info) => info.values && info.values.length > 0 && info.values[0],

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'values'
    ])
};
"use strict";

const { _, quote } = require('rk-utils');
const { isNothing } = require('../utils/lang');
const any = require('./any');
const { ValidationError } = require('../utils/Errors');

function sanitize(value, info, i18n, prefix) {
    if (value == null) return null;

    let raw = value;

    if (typeof value === 'string') {
        if (info.csv) {
            return value;
        } else {
            let trimmed = value.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                value = sanitize(JSON.parse(trimmed), info, i18n, prefix);
            }
        }
    }

    if (Array.isArray(value)) {
        if (info.elementSchema) {
            const Validators = require('../Validators');
            return value.map((a, i) => Validators.validateAny(a, info.elementSchema, i18n, prefix + `[${i}]`));
        }

        return value;
    }    

    throw new ValidationError('Invalid array value', { value: raw, field: info });
}

module.exports = {
    name: 'array',

    alias: [ 'list' ],

    sanitize: sanitize,

    defaultValue: [],

    generate: (info, i18n) => ([]),

    //when it's csv, should call toCsv in driver specific EntityModel
    serialize: (value) => isNothing(value) ? null :  JSON.stringify(value),

    qualifiers: any.qualifiers.concat([
        'csv',
        'of',
        'elementSchema'
    ]),

    toCsv: (data, separator = ',') => data.map(
        elem => { elem = elem.toString(); return elem.indexOf(separator) != -1 ? quote(elem, '"') : elem; }
        ).join(separator)
};
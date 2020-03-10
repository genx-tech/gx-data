"use strict";

const _ = require('rk-utils')._;
const { isNothing } = require('../utils/lang');
const { ValidationError } = require('../utils/Errors');
const any = require('./any');

module.exports = {
    name: 'object',

    alias: [ 'json' ],

    sanitize: (value, info, i18n, prefix) => {
        let raw = value;
        let type = typeof value;

        if (type === 'string') {
            value = JSON.parse(value);
        }

        if (type !== 'object') {
            throw new ValidationError('Invalid object value', { value: raw, feild: info });
        }

        if (info.schema) {
            const Validators = require('../Validators');
            return Validators.validateObjectBySchema(value, info.schema, i18n, prefix);
        }
        
        return _.toPlainObject(value);
    },

    defaultValue: {},

    generate: (info, i18n) => ({}),

    serialize: (value) => isNothing(value) ? null : JSON.stringify(value),

    qualifiers: any.qualifiers.concat([
        'schema'
    ])
};
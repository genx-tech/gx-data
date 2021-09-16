const { _ } = require('@genx/july');
const { isNothing } = require('../utils/lang');
const { ValidationError } = require('../utils/Errors');
const any = require('./any');

const jsonStarter = new Set('"', '[', '{');
const jsonEnding = {
    '"': '"',
    '[': ']',
    '{': '}',
};

// info.dontParse
// info.schema

module.exports = {
    name: 'object',

    alias: ['json'],

    sanitize: (value, info, i18n, prefix) => {
        if (value == null) return null;

        let raw = value;
        let type = typeof value;

        switch (type) {
            case 'string':
                if (
                    !info.dontParse &&
                    value.length > 0 &&
                    jsonStarter.has(value[0]) &&
                    jsonEnding[value[0]] === value[value.length - 1]
                ) {
                    value = JSON.parse(value);
                }
                break;

            case 'boolean':
            case 'number':
            case 'bigint':
                //skip, keep original value
                break;

            case 'object':
                if (!Array.isArray(value)) {
                    value = _.toPlainObject(value);
                }
                break;

            default:
                throw new ValidationError('Invalid object value', {
                    value: raw,
                    feild: info,
                });
        }

        if (info.schema) {
            const Validators = require('../Validators');
            return Validators.validateObjectBySchema(
                value,
                info.schema,
                i18n,
                prefix
            );
        }

        return value;
    },

    defaultValue: {},

    generate: (info, i18n) => ({}),

    serialize: (value) => (isNothing(value) ? null : JSON.stringify(value)),

    qualifiers: any.qualifiers.concat(['schema']),
};

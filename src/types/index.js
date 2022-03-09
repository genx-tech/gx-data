const { _ } = require('@genx/july');
const { InvalidArgument } = require('@genx/error');

const ARRAY = require('./array');
const BINARY = require('./binary');
const BOOLEAN = require('./boolean');
const ENUM = require('./enum');
const DATETIME = require('./datetime');
const INTEGER = require('./integer');
const NUMBER = require('./number');
const OBJECT = require('./object');
const TEXT = require('./text');

const types = {
    ARRAY,
    BINARY,
    BOOLEAN,
    ENUM,
    DATETIME,
    INTEGER,
    NUMBER,
    OBJECT,
    TEXT,
};

const Types = {
    ...types,
    ..._.mapKeys(types, (v, k) => v.name),

    Builtin: new Set(_.map(types, (t) => t.name)),

    FunctionalQualifiers: Object.freeze([
        'optional',
        'default',
        'auto',
        'readOnly',
        'writeOnce',
        'forceUpdate',
        'freezeAfterNonDefault',
    ]),

    sanitize: function (value, info, i18n, field) {
        if (!Types.Builtin.has(info.type)) {
            throw new InvalidArgument(`Unknown primitive type: "${info.type}"."`);
        }

        const typeObject = Types[info.type];
        return typeObject.sanitize(value, info, i18n, field);
    },
};

module.exports = Types;

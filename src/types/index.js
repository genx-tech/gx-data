 const { _ } = require('rk-utils');
 const { Set } = require('immutable');

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
    ARRAY, BINARY, BOOLEAN, ENUM, DATETIME, INTEGER, NUMBER, OBJECT, TEXT
};

const Types = { 
    ...types, 
    ..._.mapKeys(types, (v, k) => v.name), 
    
    Builtin: Set(_.map(types, t => t.name)),

    FunctionalQualifiers: Object.freeze([
        'optional',
        'default',
        'auto',
        'readOnly',
        'writeOnce',
        'forceUpdate',
        'freezeAfterNonDefault',
    ]),

    sanitize: function (value, info, i18n) {
        pre: {
            Types.Builtin.has(info.type), `Unknown primitive type: "${info.type}"."`;
        }
    
        let typeObjerct = Types[info.type];
        return typeObjerct.sanitize(value, info, i18n);
    } 
};

module.exports = Types;
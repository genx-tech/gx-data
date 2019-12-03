"use strict";

const Convertors = require('../Convertors');
const randomstring = require("randomstring");
const any = require('./any');

module.exports = {
    name: 'text',

    alias: [ 'string', 'char' ],

    sanitize: (value, info, i18n) => Convertors.toText(value),

    defaultValue: '',

    generate: (info, i18n) => {
        let randOpt = {};

        if (info.fixedLength) {
            randOpt.length = info.fixedLength;
        }

        if (info.maxLength) {
            randOpt.length = info.maxLength > 32 ? 32 : info.maxLength;
        }

        if (info.allowedChars) {
            randOpt.charset = info.allowedChars;
        }

        return randomstring.generate(randOpt);
    },  

    serialize: value => value,

    qualifiers: any.qualifiers.concat([
        'fixedLength',
        'maxLength',
        'encoding',
        'allowedChars'
    ])
};
"use strict";

const { tryRequire } = require('@genx/sys');

module.exports = function (info, i18n, options) {
    const uuidv4 = tryRequire('uuid/v4', __dirname);
    
    return uuidv4();
}
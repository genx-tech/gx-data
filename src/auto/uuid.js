"use strict";

const { tryRequire } = require('../utils/lib');

module.exports = function (info, i18n, options) {
    const uuidv4 = tryRequire('uuid/v4');
    
    return uuidv4();
}
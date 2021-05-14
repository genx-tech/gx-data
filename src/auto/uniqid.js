"use strict";

const { tryRequire } = require('@genx/sys');

module.exports = function (info, i18n, options) {
    const uniqid = tryRequire('uniqid', __dirname);

    return uniqid();
}
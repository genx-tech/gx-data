"use strict";

const { tryRequire } = require('@genx/sys');

module.exports = function (info, i18n, options) {
    const shortid = tryRequire('shortid', __dirname);

    return shortid.generate();
}
"use strict";

const { tryRequire } = require('../utils/lib');

module.exports = function (info, i18n, options) {
    const uniqid = tryRequire('uniqid');

    return uniqid();
}
"use strict";

const { tryRequire } = require('../utils/lib');

module.exports = function (info, i18n, options) {
    const shortid = tryRequire('shortid');

    return shortid.generate();
}
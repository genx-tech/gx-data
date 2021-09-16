"use strict";

require("source-map-support/register");

const {
  tryRequire
} = require('@genx/sys');

module.exports = function (info, i18n, options) {
  const shortid = tryRequire('shortid');
  return shortid.generate();
};
//# sourceMappingURL=shortid.js.map
"use strict";

require("source-map-support/register");
const {
  tryRequire
} = require('@genx/sys');
module.exports = function (info, i18n, options) {
  const uniqid = tryRequire('uniqid');
  return uniqid();
};
//# sourceMappingURL=uniqid.js.map
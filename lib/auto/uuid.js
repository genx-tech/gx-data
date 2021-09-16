"use strict";

require("source-map-support/register");

const {
  tryRequire
} = require('@genx/sys');

module.exports = function (info, i18n, options) {
  const uuidv4 = tryRequire('uuid/v4');
  return uuidv4();
};
//# sourceMappingURL=uuid.js.map
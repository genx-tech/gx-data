"use strict";

require("source-map-support/register");
const {
  tryRequire
} = require('@genx/sys');
module.exports = function (info, i18n, options) {
  const {
    v4: uuidv4
  } = tryRequire('uuid');
  return uuidv4();
};
//# sourceMappingURL=uuid.js.map
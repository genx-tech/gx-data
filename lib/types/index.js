"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const ARRAY = require('./array');

const BINARY = require('./binary');

const BOOLEAN = require('./boolean');

const ENUM = require('./enum');

const DATETIME = require('./datetime');

const INTEGER = require('./integer');

const NUMBER = require('./number');

const OBJECT = require('./object');

const TEXT = require('./text');

const types = {
  ARRAY,
  BINARY,
  BOOLEAN,
  ENUM,
  DATETIME,
  INTEGER,
  NUMBER,
  OBJECT,
  TEXT
};
const Types = { ...types,
  ..._.mapKeys(types, (v, k) => v.name),
  Builtin: new Set(_.map(types, t => t.name)),
  FunctionalQualifiers: Object.freeze(['optional', 'default', 'auto', 'readOnly', 'writeOnce', 'forceUpdate', 'freezeAfterNonDefault']),
  sanitize: function (value, info, ...others) {
    pre: {
      Types.Builtin.has(info.type), `Unknown primitive type: "${info.type}"."`;
    }

    let typeObjerct = Types[info.type];
    return typeObjerct.sanitize(value, info, ...others);
  }
};
module.exports = Types;
//# sourceMappingURL=index.js.map
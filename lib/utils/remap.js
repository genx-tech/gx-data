"use strict";

require("source-map-support/register");

function remap(object, mapping, keepUnmapped) {
  if (typeof mapping === 'string') return {
    [mapping]: object
  };
  let newObj = {};
  Object.entries(object).map(([k, v]) => {
    if (k in mapping) {
      let nk = mapping[k];

      if (Array.isArray(nk)) {
        newObj[nk[0]] = { ...newObj[nk[0]],
          ...remap(v, nk[1], keepUnmapped)
        };
      } else {
        newObj[nk] = v;
      }
    } else {
      if (keepUnmapped) {
        newObj[k] = v;
      }
    }
  });
  return newObj;
}

module.exports = remap;
//# sourceMappingURL=remap.js.map
"use strict";

require("source-map-support/register");

const Rules = require('../enum/Rules');

const Generators = require('../Generators');

module.exports = {
  [Rules.RULE_AFTER_VALIDATION]: (feature, entityModel, context) => {
    feature.forEach(featureItem => {
      if (featureItem.field in context.latest) {
        const targetState = context.latest[featureItem.field];
        const timestampFieldName = featureItem.stateMapping[targetState];

        if (!timestampFieldName) {
          throw new Error(`State "${targetState}" is not one of the pre-defined states of field "${featureItem.field}" of entity "${entityModel.meta.name}".`);
        }

        context.latest[timestampFieldName] = Generators.default(entityModel.meta.fields[timestampFieldName], context.i18n);
      }
    });
    return true;
  }
};
//# sourceMappingURL=stateTracking.js.map
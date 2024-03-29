"use strict";

require("source-map-support/register");
const Rules = require('../enum/Rules');
const {
  InvalidArgument
} = require('../utils/Errors');
const Lang = require('../utils/lang');
function addCreatedBy_(entityModel, feature, context) {
  if (context.options.$migration) {
    context.latest[feature.fields.createdBy] = feature.migrationUser;
    return true;
  }
  const uid = entityModel.getValueFromContext(context, feature.uidSource);
  if (uid == null) {
    throw new InvalidArgument(`Context "${feature.uidSource}" not found. Entity: ${entityModel.meta.name}`);
  }
  context.latest[feature.fields.createdBy] = uid;
  return true;
}
function addUpdatedBy_(entityModel, feature, context) {
  var _context$options$$ski;
  if ((_context$options$$ski = context.options.$skipFeatures) != null && _context$options$$ski.includes('userEditTracking')) return true;
  const uid = entityModel.getValueFromContext(context, feature.uidSource);
  if (uid == null) {
    throw new InvalidArgument(`Context "${feature.uidSource}" not found.`);
  }
  context.latest[feature.fields.updatedBy] = uid;
  context.latest[feature.fields.revision] = Lang.$inc(feature.fields.revision, 1);
  return true;
}
module.exports = {
  [Rules.RULE_BEFORE_VALIDATION]: (feature, entityModel, context) => context.op === 'create' ? addCreatedBy_(entityModel, feature, context) : addUpdatedBy_(entityModel, feature, context)
};
//# sourceMappingURL=userEditTracking.js.map
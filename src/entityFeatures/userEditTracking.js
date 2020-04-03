"use strict";

const Rules = require('../enum/Rules');

function addCreatedBy_(entityModel, feature, context) {
    let uid = entityModel.getValueFromContext(context, feature.uidSource);
    context.latest[feature.fields.createdBy] = uid;
}

function addUpdatedBy_(entityModel, feature, context) {
    let uid = entityModel.getValueFromContext(context, feature.uidSource);
    context.latest[feature.fields.updatedBy] = uid;
}

/**
 * A rule specifies the change of state will be tracked automatically.
 * @module EntityFeatureRuntime_ChangeLog
 */

module.exports = {
    [Rules.RULE_BEFORE_CREATE]: (feature, entityModel, context) => addCreatedBy_(entityModel, feature, context),
    [Rules.RULE_BEFORE_UPDATE]: (feature, entityModel, context) => addUpdatedBy_(entityModel, feature, context)
};
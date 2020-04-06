"use strict";

const Rules = require('../enum/Rules');
const { InvalidArgument } = require('../utils/Errors');

function addCreatedBy_(entityModel, feature, context) {
    if (context.options.$migration && context.latest[feature.fields.createdBy] != null) {
        return true;
    }

    let uid = entityModel.getValueFromContext(context, feature.uidSource);
    if (uid == null) {
        throw new InvalidArgument(`Context "${feature.uidSource}" not found.`)
    }
    context.latest[feature.fields.createdBy] = uid;
    return true;
}

function addUpdatedBy_(entityModel, feature, context) {
    let uid = entityModel.getValueFromContext(context, feature.uidSource);
    if (uid == null) {
        throw new InvalidArgument(`Context "${feature.uidSource}" not found.`)
    }
    context.latest[feature.fields.updatedBy] = uid;
    return true;
}

/**
 * A rule specifies the change of state will be tracked automatically.
 * @module EntityFeatureRuntime_ChangeLog
 */

module.exports = {
    [Rules.RULE_BEFORE_CREATE]: (feature, entityModel, context) => addCreatedBy_(entityModel, feature, context),
    [Rules.RULE_BEFORE_UPDATE]: (feature, entityModel, context) => addUpdatedBy_(entityModel, feature, context)
};
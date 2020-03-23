"use strict";

const Rules = require('../enum/Rules');
const { mergeCondition } = require('../utils/lang');
const Generators = require('../Generators');

/**
 * A rule specifies the entity will not be deleted physically.
 * @module EntityFeatureRuntime_LogicalDeletion
 */

module.exports = {
    [Rules.RULE_BEFORE_FIND]: (feature, entityModel, context) => {
        let findOptions = context.options;
        if (!findOptions.$includeDeleted) {
            findOptions.$query = mergeCondition(findOptions.$query, { [feature.field]: { $ne: feature.value } });
        }

        return true;
    },
    [Rules.RULE_BEFORE_DELETE]: async (feature, entityModel, context) => {
        let options = context.options;
        if (!options.$physicalDeletion) {
            let { field, value, timestampField } = feature;
            let updateTo = {
                [field]: value
            };

            if (timestampField) {
                updateTo[timestampField] = Generators.default(entityModel.meta.fields[timestampField], context.i18n);
            }

            context.return = await entityModel._update_(updateTo, { 
                $query: options.$query, 
                $retrieveUpdated: options.$retrieveDeleted,
                $bypassReadOnly: new Set([field, timestampField])
            });

            return false;
        }

        return true;
    }
};
"use strict";

const Util = require('rk-utils');

const {
  _
} = Util;

const {
  ValidationError
} = require('../Errors');

const Rules = require('../../enum/Rules');

module.exports = {
  [Rules.RULE_BEFORE_CREATE]: (feature, entityModel, context) => {
    _.each(feature, item => {
      if (_.every(item, fieldName => _.isNil(context.latest[fieldName]))) {
        throw new ValidationError(`At least one of these fields ${item.map(f => Util.quote(f)).join(', ')} should not be null.`, {
          entity: entityModel.meta.name,
          fields: feature
        });
      }
    });

    return true;
  },
  [Rules.RULE_BEFORE_UPDATE]: (feature, entityModel, context) => {
    _.each(feature, item => {
      if (_.every(item, fieldName => context.latest.hasOwnProperty(fieldName) ? _.isNil(context.latest[fieldName]) : context.existing && _.isNil(context.existing[fieldName]))) {
        throw new ValidationError(`At least one of these fields ${item.map(f => Util.quote(f)).join(', ')} should not be null.`, {
          entity: entityModel.meta.name,
          fields: feature
        });
      }
    });

    return true;
  }
};
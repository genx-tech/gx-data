"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const {
  _,
  eachAsync_,
  getValueByPath,
  hasKeyByPath
} = require('rk-utils');

const Errors = require('./utils/Errors');

const Generators = require('./Generators');

const Types = require('./types');

const {
  ValidationError,
  DatabaseError,
  ApplicationError
} = Errors;

const Features = require('./entityFeatures');

const Rules = require('../enum/Rules');

const {
  isNothing
} = require('../utils/lang');

const NEED_OVERRIDE = 'Should be overrided by driver-specific subclass.';

function minifyAssocs(assocs) {
  let sorted = _.uniq(assocs).sort().reverse();

  let minified = _.take(sorted, 1),
      l = sorted.length - 1;

  for (let i = 1; i < l; i++) {
    let k = sorted[i] + '.';

    if (!_.find(minified, a => a.startsWith(k))) {
      minified.push(sorted[i]);
    }
  }

  return minified;
}

const oorTypesToBypass = new Set(['ColumnReference', 'Function', 'BinaryExpression']);

class EntityModel {
  constructor(rawData) {
    if (rawData) {
      Object.assign(this, rawData);
    }
  }

  static valueOfKey(data) {
    return Array.isArray(this.meta.keyField) ? _.pick(data, this.meta.keyField) : data[this.meta.keyField];
  }

  static queryColumn(name) {
    return {
      oorType: 'ColumnReference',
      name
    };
  }

  static queryBinExpr(left, op, right) {
    return {
      oorType: 'BinaryExpression',
      left,
      op,
      right
    };
  }

  static queryFunction(name, ...args) {
    return {
      oorType: 'Function',
      name,
      args
    };
  }

  static getUniqueKeyFieldsFrom(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }

  static getUniqueKeyValuePairsFrom(data) {
    if (!(typeof data === 'object')) {
      throw new Error("Function  precondition failed: typeof data === 'object'");
    }

    let ukFields = this.getUniqueKeyFieldsFrom(data);
    return _.pick(data, ukFields);
  }

  static getNestedObject(entityObj, keyPath, defaultValue) {
    let nodes = (Array.isArray(keyPath) ? keyPath : keyPath.split('.')).map(key => key[0] === ':' ? key : ':' + key);
    return getValueByPath(entityObj, nodes, defaultValue);
  }

  static ensureRetrieveCreated(context, customOptions) {
    if (!context.options.$retrieveCreated) {
      context.options.$retrieveCreated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveUpdated(context, customOptions) {
    if (!context.options.$retrieveUpdated) {
      context.options.$retrieveUpdated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveDeleted(context, customOptions) {
    if (!context.options.$retrieveDeleted) {
      context.options.$retrieveDeleted = customOptions ? customOptions : true;
    }
  }

  static async ensureTransaction_(context) {
    if (!context.connOptions || !context.connOptions.connection) {
      context.connOptions || (context.connOptions = {});
      context.connOptions.connection = await this.db.connector.beginTransaction_();
    }
  }

  static getValueFromContext(context, key) {
    return getValueByPath(context, 'options.$variables.' + key);
  }

  static async cached_(key, associations, connOptions) {
    if (key) {
      let combinedKey = key;

      if (!_.isEmpty(associations)) {
        combinedKey += '/' + minifyAssocs(associations).join('&');
      }

      let cachedData;

      if (!this._cachedData) {
        this._cachedData = {};
      } else if (this._cachedData[combinedKey]) {
        cachedData = this._cachedData[combinedKey];
      }

      if (!cachedData) {
        cachedData = this._cachedData[combinedKey] = await this.findAll_({
          $association: associations,
          $toDictionary: key
        }, connOptions);
      }

      return cachedData;
    }

    return this.cached_(this.meta.keyField, associations, connOptions);
  }

  static toDictionary(entityCollection, key) {
    key || (key = this.meta.keyField);
    return entityCollection.reduce((dict, v) => {
      dict[v[key]] = v;
      return dict;
    }, {});
  }

  static async findOne_(findOptions, connOptions) {
    if (!findOptions) {
      throw new Error("Function  precondition failed: findOptions");
    }

    findOptions = this._prepareQueries(findOptions, true);
    let context = {
      options: findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);
    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.options, context.connOptions);
      if (!records) throw new DatabaseError('connector.find_() returns undefined data record.');

      if (findOptions.$relationships && !findOptions.$skipOrm) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$relationships);
      } else if (records.length === 0) {
        return undefined;
      }

      if (records.length !== 1) {
        this.db.connector.log('error', `findOne() returns more than one record.`, {
          entity: this.meta.name,
          options: context.options
        });
      }

      let result = records[0];
      return result;
    }, context);
  }

  static async findAll_(findOptions, connOptions) {
    findOptions = this._prepareQueries(findOptions);
    let context = {
      options: findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);
    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.options, context.connOptions);
      if (!records) throw new DatabaseError('connector.find_() returns undefined data record.');

      if (findOptions.$relationships) {
        if (findOptions.$totalCount) {
          totalCount = records[3];
        }

        if (!findOptions.$skipOrm) {
          records = this._mapRecordsToObjects(records, findOptions.$relationships);
        } else {
          records = records[0];
        }
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
          records = records[0];
        }
      }

      return this.afterFindAll_(context, records);
    }, context);

    if (findOptions.$totalCount) {
      let ret = {
        totalItems: totalCount,
        items: rows
      };

      if (!isNothing(findOptions.$offset)) {
        ret.offset = findOptions.$offset;
      }

      if (!isNothing(findOptions.$limit)) {
        ret.limit = findOptions.$limit;
      }

      return ret;
    }

    return rows;
  }

  static async create_(data, createOptions, connOptions) {
    let rawOptions = createOptions;

    if (!createOptions) {
      createOptions = {};
    }

    let [raw, associations] = this._extractAssociations(data);

    let context = {
      raw,
      rawOptions,
      options: createOptions,
      connOptions
    };
    let needCreateAssocs = !_.isEmpty(associations);

    if (!(await this.beforeCreate_(context))) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
      }

      await this._prepareEntityData_(context);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context))) {
        return false;
      }

      if (!(await this._internalBeforeCreate_(context))) {
        return false;
      }

      context.latest = Object.freeze(context.latest);
      context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
      context.return = context.latest;
      await this._internalAfterCreate_(context);

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
      }

      await Features.applyRules_(Rules.RULE_AFTER_CREATE, this, context);

      if (needCreateAssocs) {
        await this._createAssocs_(context, associations);
      }

      return true;
    }, context);

    if (success) {
      await this.afterCreate_(context);
    }

    return context.return;
  }

  static async updateOne_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$bypassReadOnly) {
      throw new ApplicationError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, true);
  }

  static async updateMany_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$bypassReadOnly) {
      throw new ApplicationError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, false);
  }

  static async _update_(data, updateOptions, connOptions, forSingleRecord) {
    let rawOptions = updateOptions;

    if (!updateOptions) {
      let conditionFields = this.getUniqueKeyFieldsFrom(data);

      if (_.isEmpty(conditionFields)) {
        throw new ApplicationError('Primary key value(s) or at least one group of unique key value(s) is required for updating an entity.');
      }

      updateOptions = {
        $query: _.pick(data, conditionFields)
      };
      data = _.omit(data, conditionFields);
    }

    let [raw, associations] = this._extractAssociations(data);

    let context = {
      raw,
      rawOptions,
      options: this._prepareQueries(updateOptions, forSingleRecord),
      connOptions
    };
    let needCreateAssocs = !_.isEmpty(associations);
    let toUpdate;

    if (forSingleRecord) {
      toUpdate = await this.beforeUpdate_(context);
    } else {
      toUpdate = await this.beforeUpdateMany_(context);
    }

    if (!toUpdate) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
      }

      await this._prepareEntityData_(context, true, forSingleRecord);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context))) {
        return false;
      }

      if (forSingleRecord) {
        toUpdate = await this._internalBeforeUpdate_(context);
      } else {
        toUpdate = await this._internalBeforeUpdateMany_(context);
      }

      if (!toUpdate) {
        return false;
      }

      context.latest = Object.freeze(context.latest);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.options.$query, context.options, context.connOptions);
      context.return = context.latest;

      if (forSingleRecord) {
        await this._internalAfterUpdate_(context);
      } else {
        await this._internalAfterUpdateMany_(context);
      }

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
      }

      await Features.applyRules_(Rules.RULE_AFTER_UPDATE, this, context);

      if (needCreateAssocs) {
        await this._updateAssocs_(context, associations);
      }

      return true;
    }, context);

    if (success) {
      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }
    }

    return context.return;
  }

  static async replaceOne_(data, updateOptions, connOptions) {
    let rawOptions = updateOptions;

    if (!updateOptions) {
      let conditionFields = this.getUniqueKeyFieldsFrom(data);

      if (_.isEmpty(conditionFields)) {
        throw new ApplicationError('Primary key value(s) or at least one group of unique key value(s) is required for replacing an entity.');
      }

      updateOptions = { ...updateOptions,
        $query: _.pick(data, conditionFields)
      };
    } else {
      updateOptions = this._prepareQueries(updateOptions, true);
    }

    let context = {
      raw: data,
      rawOptions,
      options: updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      return this._doReplaceOne_(context);
    }, context);
  }

  static async deleteOne_(deleteOptions, connOptions) {
    return this._delete_(deleteOptions, connOptions, true);
  }

  static async deleteMany_(deleteOptions, connOptions) {
    return this._delete_(deleteOptions, connOptions, false);
  }

  static async _delete_(deleteOptions, connOptions, forSingleRecord) {
    let rawOptions = deleteOptions;
    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);

    if (_.isEmpty(deleteOptions.$query)) {
      throw new ApplicationError('Empty condition is not allowed for deleting an entity.');
    }

    let context = {
      rawOptions,
      options: deleteOptions,
      connOptions
    };
    let toDelete;

    if (forSingleRecord) {
      toDelete = await this.beforeDelete_(context);
    } else {
      toDelete = await this.beforeDeleteMany_(context);
    }

    if (!toDelete) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      if (!(await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context))) {
        return false;
      }

      if (forSingleRecord) {
        toDelete = await this._internalBeforeDelete_(context);
      } else {
        toDelete = await this._internalBeforeDeleteMany_(context);
      }

      if (!toDelete) {
        return false;
      }

      context.result = await this.db.connector.delete_(this.meta.name, context.options.$query, context.connOptions);

      if (forSingleRecord) {
        await this._internalAfterDelete_(context);
      } else {
        await this._internalAfterDeleteMany_(context);
      }

      if (!context.queryKey) {
        if (forSingleRecord) {
          context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
        } else {
          context.queryKey = context.options.$query;
        }
      }

      await Features.applyRules_(Rules.RULE_AFTER_DELETE, this, context);
      return true;
    }, context);

    if (success) {
      if (forSingleRecord) {
        await this.afterDelete_(context);
      } else {
        await this.afterDeleteMany_(context);
      }
    }

    return context.return;
  }

  static _containsUniqueKey(data) {
    let hasKeyNameOnly = false;

    let hasNotNullKey = _.find(this.meta.uniqueKeys, fields => {
      let hasKeys = _.every(fields, f => f in data);

      hasKeyNameOnly = hasKeyNameOnly || hasKeys;
      return _.every(fields, f => !_.isNil(data[f]));
    });

    return [hasNotNullKey, hasKeyNameOnly];
  }

  static _ensureContainsUniqueKey(condition) {
    let [containsUniqueKeyAndValue, containsUniqueKeyOnly] = this._containsUniqueKey(condition);

    if (!containsUniqueKeyAndValue) {
      if (containsUniqueKeyOnly) {
        throw new ValidationError('One of the unique key field as query condition is null. Condition: ' + JSON.stringify(condition));
      }

      throw new ApplicationError('Single record operation requires at least one unique key value pair in the query condition.', {
        entity: this.meta.name,
        condition
      });
    }
  }

  static async _prepareEntityData_(context, isUpdating = false, forSingleRecord = true) {
    let meta = this.meta;
    let i18n = this.i18n;
    let {
      name,
      fields
    } = meta;
    let {
      raw
    } = context;
    let latest = {},
        existing = context.options.$existing;
    context.latest = latest;

    if (!context.i18n) {
      context.i18n = i18n;
    }

    let opOptions = context.options;

    if (isUpdating && _.isEmpty(existing) && (this._dependsOnExistingData(raw) || opOptions.$retrieveExisting)) {
      await this.ensureTransaction_(context);

      if (forSingleRecord) {
        existing = await this.findOne_({
          $query: opOptions.$query
        }, context.connOptions);
      } else {
        existing = await this.findAll_({
          $query: opOptions.$query
        }, context.connOptions);
      }

      context.existing = existing;
    }

    if (opOptions.$retrieveExisting && !context.rawOptions.$existing) {
      context.rawOptions.$existing = existing;
    }

    await eachAsync_(fields, async (fieldInfo, fieldName) => {
      if (fieldName in raw) {
        let value = raw[fieldName];

        if (fieldInfo.readOnly) {
          if (!isUpdating || !opOptions.$bypassReadOnly.has(fieldName)) {
            throw new ValidationError(`Read-only field "${fieldName}" is not allowed to be set by manual input.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }
        }

        if (isUpdating && fieldInfo.freezeAfterNonDefault) {
          if (!existing) {
            throw new Error('"freezeAfterNonDefault" qualifier requires existing data.');
          }

          if (existing[fieldName] !== fieldInfo.default) {
            throw new ValidationError(`FreezeAfterNonDefault field "${fieldName}" is not allowed to be changed.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }
        }

        if (isNothing(value)) {
          if (!fieldInfo.optional) {
            throw new ValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }

          latest[fieldName] = null;
        } else {
          if (_.isPlainObject(value) && value.oorType) {
            latest[fieldName] = value;
            return;
          }

          try {
            latest[fieldName] = Types.sanitize(value, fieldInfo, i18n);
          } catch (error) {
            throw new ValidationError(`Invalid "${fieldName}" value of "${name}" entity.`, {
              entity: name,
              fieldInfo: fieldInfo,
              error: error.message || error.stack
            });
          }
        }

        return;
      }

      if (isUpdating) {
        if (fieldInfo.forceUpdate) {
          if (fieldInfo.updateByDb) {
            return;
          }

          if (fieldInfo.auto) {
            latest[fieldName] = await Generators.default(fieldInfo, i18n);
            return;
          }

          throw new ValidationError(`"${fieldName}" of "${name}" enttiy is required for each update.`, {
            entity: name,
            fieldInfo: fieldInfo
          });
        }

        return;
      }

      if (!fieldInfo.createByDb) {
        if (fieldInfo.hasOwnProperty('default')) {
          latest[fieldName] = fieldInfo.default;
        } else if (fieldInfo.optional) {
          return;
        } else if (fieldInfo.auto) {
          latest[fieldName] = await Generators.default(fieldInfo, i18n);
        } else {
          throw new ValidationError(`"${fieldName}" of "${name}" entity is required.`, {
            entity: name,
            fieldInfo: fieldInfo
          });
        }
      }
    });
    latest = context.latest = this._translateValue(latest, opOptions.$variables, true);
    await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);
    await this.applyModifiers_(context, isUpdating);
    context.latest = _.mapValues(latest, (value, key) => {
      let fieldInfo = fields[key];

      if (!fieldInfo) {
        throw new Error("Assertion failed: fieldInfo");
      }

      if (_.isPlainObject(value) && value.oorType) {
        opOptions.$requireSplitColumns = true;
        return value;
      }

      return this._serializeByTypeInfo(value, fieldInfo);
    });
    return context;
  }

  static async _safeExecute_(executor, context) {
    executor = executor.bind(this);

    if (context.connOptions && context.connOptions.connection) {
      return executor(context);
    }

    try {
      let result = await executor(context);

      if (context.connOptions && context.connOptions.connection) {
        await this.db.connector.commit_(context.connOptions.connection);
        delete context.connOptions.connection;
      }

      return result;
    } catch (error) {
      if (context.connOptions && context.connOptions.connection) {
        this.db.connector.log('error', `Rollbacked, reason: ${error.message}`, {
          entity: this.meta.name,
          context: context.options,
          rawData: context.raw,
          latestData: context.latest
        });
        await this.db.connector.rollback_(context.connOptions.connection);
        delete context.connOptions.connection;
      }

      throw error;
    }
  }

  static _dependencyChanged(fieldName, context) {
    let deps = this.meta.fieldDependencies[fieldName];
    return _.find(deps, d => _.isPlainObject(d) ? hasKeyByPath(context, d.reference) : hasKeyByPath(context, d));
  }

  static _referenceExist(input, ref) {
    let pos = ref.indexOf('.');

    if (pos > 0) {
      return ref.substr(pos + 1) in input;
    }

    return ref in input;
  }

  static _dependsOnExistingData(input) {
    let deps = this.meta.fieldDependencies;
    let hasDepends = false;

    if (deps) {
      let nullDepends = new Set();
      hasDepends = _.find(deps, (dep, fieldName) => _.find(dep, d => {
        if (_.isPlainObject(d)) {
          if (d.whenNull) {
            if (_.isNil(input[fieldName])) {
              nullDepends.add(dep);
            }

            return false;
          }

          d = d.reference;
        }

        return fieldName in input && !this._referenceExist(input, d);
      }));

      if (hasDepends) {
        return true;
      }

      for (let dep of nullDepends) {
        if (_.find(dep, d => !this._referenceExist(input, d.reference))) {
          return true;
        }
      }
    }

    let atLeastOneNotNull = this.meta.features.atLeastOneNotNull;

    if (atLeastOneNotNull) {
      hasDepends = _.find(atLeastOneNotNull, fields => _.find(fields, field => field in input && _.isNil(input[field])));

      if (hasDepends) {
        return true;
      }
    }

    return false;
  }

  static _hasReservedKeys(obj) {
    return _.find(obj, (v, k) => k[0] === '$');
  }

  static _prepareQueries(options, forSingleRecord = false) {
    if (!_.isPlainObject(options)) {
      if (forSingleRecord && Array.isArray(this.meta.keyField)) {
        throw new ApplicationError('Cannot use a singular value as condition to query against a entity with combined primary key.');
      }

      return options ? {
        $query: {
          [this.meta.keyField]: this._translateValue(options)
        }
      } : {};
    }

    let normalizedOptions = {},
        query = {};

    _.forOwn(options, (v, k) => {
      if (k[0] === '$') {
        normalizedOptions[k] = v;
      } else {
        query[k] = v;
      }
    });

    normalizedOptions.$query = { ...query,
      ...normalizedOptions.$query
    };

    if (forSingleRecord && !options.$bypassEnsureUnique) {
      this._ensureContainsUniqueKey(normalizedOptions.$query);
    }

    normalizedOptions.$query = this._translateValue(normalizedOptions.$query, normalizedOptions.$variables, null, true);

    if (normalizedOptions.$groupBy) {
      if (_.isPlainObject(normalizedOptions.$groupBy)) {
        if (normalizedOptions.$groupBy.having) {
          normalizedOptions.$groupBy.having = this._translateValue(normalizedOptions.$groupBy.having, normalizedOptions.$variables);
        }
      }
    }

    if (normalizedOptions.$projection) {
      normalizedOptions.$projection = this._translateValue(normalizedOptions.$projection, normalizedOptions.$variables);
    }

    if (normalizedOptions.$association && !normalizedOptions.$relationships) {
      normalizedOptions.$relationships = this._prepareAssociations(normalizedOptions);
    }

    return normalizedOptions;
  }

  static async beforeCreate_(context) {
    return true;
  }

  static async beforeUpdate_(context) {
    return true;
  }

  static async beforeUpdateMany_(context) {
    return true;
  }

  static async beforeDelete_(context) {
    return true;
  }

  static async beforeDeleteMany_(context) {
    return true;
  }

  static async afterCreate_(context) {}

  static async afterUpdate_(context) {}

  static async afterUpdateMany_(context) {}

  static async afterDelete_(context) {}

  static async afterDeleteMany_(context) {}

  static async afterFindAll_(context, records) {
    if (context.options.$toDictionary) {
      let keyField = this.meta.keyField;

      if (typeof context.options.$toDictionary === 'string') {
        keyField = context.options.$toDictionary;

        if (!(keyField in this.meta.fields)) {
          throw new ApplicationError(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`);
        }
      }

      return this.toDictionary(records, keyField);
    }

    return records;
  }

  static _prepareAssociations() {
    throw new Error(NEED_OVERRIDE);
  }

  static _mapRecordsToObjects() {
    throw new Error(NEED_OVERRIDE);
  }

  static _extractAssociations(data) {
    throw new Error(NEED_OVERRIDE);
  }

  static async _createAssocs_(context, assocs) {
    throw new Error(NEED_OVERRIDE);
  }

  static async _updateAssocs_(context, assocs) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateSymbolToken(name) {
    throw new Error(NEED_OVERRIDE);
  }

  static _serialize(value) {
    throw new Error(NEED_OVERRIDE);
  }

  static _serializeByTypeInfo(value, info) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateValue(value, variables, skipSerialize, arrayToInOperator) {
    if (_.isPlainObject(value)) {
      if (value.oorType) {
        if (oorTypesToBypass.has(value.oorType)) return value;

        if (value.oorType === 'SessionVariable') {
          if (!variables) {
            throw new ApplicationError('Variables context missing.');
          }

          if ((!variables.session || !(value.name in variables.session)) && !value.optional) {
            let errArgs = [];

            if (value.missingMessage) {
              errArgs.push(value.missingMessage);
            }

            if (value.missingStatus) {
              errArgs.push(value.missingStatus || HttpCode.BAD_REQUEST);
            }

            throw new RequestError(...errArgs);
          }

          return variables.session[value.name];
        } else if (value.oorType === 'QueryVariable') {
          if (!variables) {
            throw new ApplicationError('Variables context missing.');
          }

          if (!variables.query || !(value.name in variables.query)) {
            throw new ApplicationError(`Query parameter "${value.name}" in configuration not found.`);
          }

          return variables.query[value.name];
        } else if (value.oorType === 'SymbolToken') {
          return this._translateSymbolToken(value.name);
        }

        throw new Error('Not impletemented yet. ' + value.oorType);
      }

      return _.mapValues(value, (v, k) => this._translateValue(v, variables, skipSerialize, arrayToInOperator && k[0] !== '$'));
    }

    if (Array.isArray(value)) {
      let ret = value.map(v => this._translateValue(v, variables, skipSerialize, arrayToInOperator));
      return arrayToInOperator ? {
        $in: ret
      } : ret;
    }

    if (skipSerialize) return value;
    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiVmFsaWRhdGlvbkVycm9yIiwiRGF0YWJhc2VFcnJvciIsIkFwcGxpY2F0aW9uRXJyb3IiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiTkVFRF9PVkVSUklERSIsIm1pbmlmeUFzc29jcyIsImFzc29jcyIsInNvcnRlZCIsInVuaXEiLCJzb3J0IiwicmV2ZXJzZSIsIm1pbmlmaWVkIiwidGFrZSIsImwiLCJsZW5ndGgiLCJpIiwiayIsImZpbmQiLCJhIiwic3RhcnRzV2l0aCIsInB1c2giLCJvb3JUeXBlc1RvQnlwYXNzIiwiU2V0IiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCJ2YWx1ZU9mS2V5IiwiZGF0YSIsIkFycmF5IiwiaXNBcnJheSIsIm1ldGEiLCJrZXlGaWVsZCIsInBpY2siLCJxdWVyeUNvbHVtbiIsIm5hbWUiLCJvb3JUeXBlIiwicXVlcnlCaW5FeHByIiwibGVmdCIsIm9wIiwicmlnaHQiLCJxdWVyeUZ1bmN0aW9uIiwiYXJncyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsImRlZmF1bHRWYWx1ZSIsIm5vZGVzIiwic3BsaXQiLCJtYXAiLCJrZXkiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwidG9EaWN0aW9uYXJ5IiwiZW50aXR5Q29sbGVjdGlvbiIsInJlZHVjZSIsImRpY3QiLCJ2IiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJsb2ciLCJlbnRpdHkiLCJyZXN1bHQiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJsYXRlc3QiLCJmcmVlemUiLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiX2NyZWF0ZUFzc29jc18iLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiX3VwZGF0ZUFzc29jc18iLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwiJGV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJyZWFkT25seSIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsImlzUGxhaW5PYmplY3QiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIl90cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsImxhdGVzdERhdGEiLCJyb2xsYmFja18iLCJfZGVwZW5kZW5jeUNoYW5nZWQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJkIiwicmVmZXJlbmNlIiwiX3JlZmVyZW5jZUV4aXN0IiwiaW5wdXQiLCJyZWYiLCJwb3MiLCJpbmRleE9mIiwic3Vic3RyIiwiaGFzRGVwZW5kcyIsIm51bGxEZXBlbmRzIiwiZGVwIiwid2hlbk51bGwiLCJhZGQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiZmllbGQiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFNlcmlhbGl6ZSIsImFycmF5VG9Jbk9wZXJhdG9yIiwic2Vzc2lvbiIsImVyckFyZ3MiLCJtaXNzaW5nTWVzc2FnZSIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIlJlcXVlc3RFcnJvciIsIiRpbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxLQUFLLEdBQUdQLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVEsRUFBQUEsZUFBRjtBQUFtQkMsRUFBQUEsYUFBbkI7QUFBa0NDLEVBQUFBO0FBQWxDLElBQXVETCxNQUE3RDs7QUFDQSxNQUFNTSxRQUFRLEdBQUdYLE9BQU8sQ0FBQyxrQkFBRCxDQUF4Qjs7QUFDQSxNQUFNWSxLQUFLLEdBQUdaLE9BQU8sQ0FBQyxlQUFELENBQXJCOztBQUVBLE1BQU07QUFBRWEsRUFBQUE7QUFBRixJQUFnQmIsT0FBTyxDQUFDLGVBQUQsQ0FBN0I7O0FBRUEsTUFBTWMsYUFBYSxHQUFHLGtEQUF0Qjs7QUFFQSxTQUFTQyxZQUFULENBQXNCQyxNQUF0QixFQUE4QjtBQUMxQixNQUFJQyxNQUFNLEdBQUdoQixDQUFDLENBQUNpQixJQUFGLENBQU9GLE1BQVAsRUFBZUcsSUFBZixHQUFzQkMsT0FBdEIsRUFBYjs7QUFFQSxNQUFJQyxRQUFRLEdB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Q0FBZixDQUFWO0FBQ0EsYUFBT0EsaUJBQWlCLEdBQUc7QUFBRU8sUUFBQUEsR0FBRyxFQUFFNUo7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUlvSixhQUFKLEVBQW1CLE9BQU85RCxLQUFQO0FBRW5CLFdBQU8sS0FBSzJELFVBQUwsQ0FBZ0IzRCxLQUFoQixDQUFQO0FBQ0g7O0FBbHJDYTs7QUFxckNsQnVFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnJQLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBBcHBsaWNhdGlvbkVycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSA/IF8ucGljayhkYXRhLCB0aGlzLm1ldGEua2V5RmllbGQpIDogZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdWVyeUNvbHVtbihuYW1lKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJyxcbiAgICAgICAgICAgIG5hbWVcbiAgICAgICAgfTsgXG4gICAgfVxuXG4gICAgc3RhdGljIHF1ZXJ5QmluRXhwcihsZWZ0LCBvcCwgcmlnaHQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9vclR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgIGxlZnQsXG4gICAgICAgICAgICBvcCxcbiAgICAgICAgICAgIHJpZ2h0XG4gICAgICAgIH07IFxuICAgIH1cblxuICAgIHN0YXRpYyBxdWVyeUZ1bmN0aW9uKG5hbWUsIC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9vclR5cGU6ICdGdW5jdGlvbicsXG4gICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgYXJnc1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCwgZGVmYXVsdFZhbHVlKSB7XG4gICAgICAgIGxldCBub2RlcyA9IChBcnJheS5pc0FycmF5KGtleVBhdGgpID8ga2V5UGF0aCA6IGtleVBhdGguc3BsaXQoJy4nKSkubWFwKGtleSA9PiBrZXlbMF0gPT09ICc6JyA/IGtleSA6ICgnOicgKyBrZXkpKTtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwgbm9kZXMsIGRlZmF1bHRWYWx1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKiB7c3RyaW5nfSBba2V5XSAtIFRoZSBrZXkgZmllbGQgdG8gdXNlZCBieSB0aGUgaGFzaHRhYmxlLlxuICAgICAqIHthcnJheX0gW2Fzc29jaWF0aW9uc10gLSBXaXRoIGFuIGFycmF5IG9mIGFzc29jaWF0aW9ucy5cbiAgICAgKiB7b2JqZWN0fSBbY29ubk9wdGlvbnNdIC0gQ29ubmVjdGlvbiBvcHRpb25zLCBlLmcuIHRyYW5zYWN0aW9uIGhhbmRsZVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY29tYmluZWRLZXkgPSBrZXk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBjb21iaW5lZEtleSArPSAnLycgKyBtaW5pZnlBc3NvY3MoYXNzb2NpYXRpb25zKS5qb2luKCcmJylcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkYXNzb2NpYXRpb246IGFzc29jaWF0aW9ucywgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiB0aGlzLmNhY2hlZF8odGhpcy5tZXRhLmtleUZpZWxkLCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdG9EaWN0aW9uYXJ5KGVudGl0eUNvbGxlY3Rpb24sIGtleSkge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eUNvbGxlY3Rpb24ucmVkdWNlKChkaWN0LCB2KSA9PiB7XG4gICAgICAgICAgICBkaWN0W3Zba2V5XV0gPSB2O1xuICAgICAgICAgICAgcmV0dXJuIGRpY3Q7XG4gICAgICAgIH0sIHt9KTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIHByZTogZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlY29yZHMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBmaW5kT25lKCkgcmV0dXJucyBtb3JlIHRoYW4gb25lIHJlY29yZC5gLCB7IGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIG9wdGlvbnM6IGNvbnRleHQub3B0aW9ucyB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSBPYmplY3QuZnJlZXplKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuXG4gICAgICAgIGxldCB0b1VwZGF0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8sIGZvclNpbmdsZVJlY29yZCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7ICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfREVMRVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHZhbHVlIHBhaXIgaW4gdGhlIHF1ZXJ5IGNvbmRpdGlvbi4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQgPSB0cnVlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nID0gY29udGV4dC5vcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBfLmlzRW1wdHkoZXhpc3RpbmcpICYmICh0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSB8fCBvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcgJiYgIWNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgbGV0IHZhbHVlID0gcmF3W2ZpZWxkTmFtZV07XG5cbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUodmFsdWUsIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfHwgZXJyb3Iuc3RhY2sgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgLy90aGVyZSBpcyBzcGVjaWFsIGlucHV0IGNvbHVtbiB3aGljaCBtYXliZSBhIGZ1bmN0aW9uIG9yIGFuIGV4cHJlc3Npb25cbiAgICAgICAgICAgICAgICBvcE9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBSb2xsYmFja2VkLCByZWFzb246ICR7ZXJyb3IubWVzc2FnZX1gLCB7ICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICByYXdEYXRhOiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0RGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRlbmN5Q2hhbmdlZChmaWVsZE5hbWUsIGNvbnRleHQpIHtcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXNbZmllbGROYW1lXTtcblxuICAgICAgICByZXR1cm4gXy5maW5kKGRlcHMsIGQgPT4gXy5pc1BsYWluT2JqZWN0KGQpID8gaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQucmVmZXJlbmNlKSA6IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkKSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9yZWZlcmVuY2VFeGlzdChpbnB1dCwgcmVmKSB7XG4gICAgICAgIGxldCBwb3MgPSByZWYuaW5kZXhPZignLicpO1xuXG4gICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmLnN1YnN0cihwb3MrMSkgaW4gaW5wdXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmIGluIGlucHV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBudWxsRGVwZW5kcyA9IG5ldyBTZXQoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IFxuICAgICAgICAgICAgICAgIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZC53aGVuTnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGlucHV0W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bGxEZXBlbmRzLmFkZChkZXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZCA9IGQucmVmZXJlbmNlO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSBpbiBpbnB1dCAmJiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGxldCBkZXAgb2YgbnVsbERlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5maW5kKGRlcCwgZCA9PiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQucmVmZXJlbmNlKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFNlcmlhbGl6ZSwgYXJyYXlUb0luT3BlcmF0b3IpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9vclR5cGVzVG9CeXBhc3MuaGFzKHZhbHVlLm9vclR5cGUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlcXVlc3RFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
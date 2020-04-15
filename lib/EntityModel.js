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

const Convertors = require('./Convertors');

const Types = require('./types');

const {
  ValidationError,
  DatabaseError,
  InvalidArgument
} = Errors;

const Features = require('./entityFeatures');

const Rules = require('./enum/Rules');

const {
  isNothing
} = require('./utils/lang');

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

  static toDictionary(entityCollection, key, transformer) {
    key || (key = this.meta.keyField);
    return Convertors.toKVPairs(entityCollection, key, transformer);
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

    if (!(await this.beforeCreate_(context))) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      let needCreateAssocs = !_.isEmpty(associations);

      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
        const [finished, pendingAssocs] = await this._createAssocs_(context, associations, true);

        _.forOwn(finished, (refFieldValue, localField) => {
          if (_.isNil(raw[localField])) {
            raw[localField] = refFieldValue;
          } else {
            throw new ValidationError(`Association data ":${localField}" of entity "${this.meta.name}" conflicts with input value of field "${localField}".`);
          }
        });

        associations = pendingAssocs;
        needCreateAssocs = !_.isEmpty(associations);
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
      throw new InvalidArgument('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, true);
  }

  static async updateMany_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$bypassReadOnly) {
      throw new InvalidArgument('Unexpected usage.', {
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
        throw new InvalidArgument('Primary key value(s) or at least one group of unique key value(s) is required for updating an entity.', {
          entity: this.meta.name,
          data
        });
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
    let toUpdate;

    if (forSingleRecord) {
      toUpdate = await this.beforeUpdate_(context);
    } else {
      toUpdate = await this.beforeUpdateMany_(context);
    }

    if (!toUpdate) {
      return context.return;
    }

    let needCreateAssocs = !_.isEmpty(associations);
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
        throw new InvalidArgument('Primary key value(s) or at least one group of unique key value(s) is required for replacing an entity.', {
          entity: this.meta.name,
          data
        });
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
      throw new InvalidArgument('Empty condition is not allowed for deleting an entity.', {
        entity: this.meta.name,
        deleteOptions
      });
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

      throw new InvalidArgument('Single record operation requires at least one unique key value pair in the query condition.', {
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
          if (!opOptions.$migration && (!isUpdating || !opOptions.$bypassReadOnly.has(fieldName))) {
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
              error: error.stack,
              value
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
        throw new InvalidArgument('Cannot use a singular value as condition to query against a entity with combined primary key.', {
          entity: this.meta.name,
          keyFields: this.meta.keyField
        });
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
          throw new InvalidArgument(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`, {
            entity: this.meta.name,
            inputKeyField: keyField
          });
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
            throw new InvalidArgument('Variables context missing.', {
              entity: this.meta.name
            });
          }

          if ((!variables.session || !(value.name in variables.session)) && !value.optional) {
            let errArgs = [];

            if (value.missingMessage) {
              errArgs.push(value.missingMessage);
            }

            if (value.missingStatus) {
              errArgs.push(value.missingStatus || HttpCode.BAD_REQUEST);
            }

            throw new ValidationError(...errArgs);
          }

          return variables.session[value.name];
        } else if (value.oorType === 'QueryVariable') {
          if (!variables) {
            throw new InvalidArgument('Variables context missing.', {
              entity: this.meta.name
            });
          }

          if (!variables.query || !(value.name in variables.query)) {
            throw new InvalidArgument(`Query parameter "${value.name}" in configuration not found.`, {
              entity: this.meta.name
            });
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiTkVFRF9PVkVSUklERSIsIm1pbmlmeUFzc29jcyIsImFzc29jcyIsInNvcnRlZCIsInVuaXEiLCJzb3J0IiwicmV2ZXJzZSIsIm1pbmlmaWVkIiwidGFrZSIsImwiLCJsZW5ndGgiLCJpIiwiayIsImZpbmQiLCJhIiwic3RhcnRzV2l0aCIsInB1c2giLCJvb3JUeXBlc1RvQnlwYXNzIiwiU2V0IiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCJ2YWx1ZU9mS2V5IiwiZGF0YSIsIkFycmF5IiwiaXNBcnJheSIsIm1ldGEiLCJrZXlGaWVsZCIsInBpY2siLCJxdWVyeUNvbHVtbiIsIm5hbWUiLCJvb3JUeXBlIiwicXVlcnlCaW5FeHByIiwibGVmdCIsIm9wIiwicmlnaHQiLCJxdWVyeUZ1bmN0aW9uIiwiYXJncyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsImRlZmF1bHRWYWx1ZSIsIm5vZGVzIiwic3BsaXQiLCJtYXAiLCJrZXkiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwidG9EaWN0aW9uYXJ5IiwiZW50aXR5Q29sbGVjdGlvbiIsInRyYW5zZm9ybWVyIiwidG9LVlBhaXJzIiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJsb2ciLCJlbnRpdHkiLCJyZXN1bHQiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiZmluaXNoZWQiLCJwZW5kaW5nQXNzb2NzIiwiX2NyZWF0ZUFzc29jc18iLCJmb3JPd24iLCJyZWZGaWVsZFZhbHVlIiwibG9jYWxGaWVsZCIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwibGF0ZXN0IiwiZnJlZXplIiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsIm9taXQiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJfdXBkYXRlQXNzb2NzXyIsImFmdGVyVXBkYXRlXyIsImFmdGVyVXBkYXRlTWFueV8iLCJyZXBsYWNlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiZGVsZXRlT25lXyIsImRlbGV0ZU9wdGlvbnMiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIlJVTEVfQUZURVJfREVMRVRFIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiSlNPTiIsInN0cmluZ2lmeSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJ2YWx1ZSIsInJlYWRPbmx5IiwiJG1pZ3JhdGlvbiIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsImlzUGxhaW5PYmplY3QiLCJzYW5pdGl6ZSIsImVycm9yIiwic3RhY2siLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiX3RyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwibWVzc2FnZSIsImxhdGVzdERhdGEiLCJyb2xsYmFja18iLCJfZGVwZW5kZW5jeUNoYW5nZWQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJkIiwicmVmZXJlbmNlIiwiX3JlZmVyZW5jZUV4aXN0IiwiaW5wdXQiLCJyZWYiLCJwb3MiLCJpbmRleE9mIiwic3Vic3RyIiwiaGFzRGVwZW5kcyIsIm51bGxEZXBlbmRzIiwiZGVwIiwid2hlbk51bGwiLCJhZGQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiZmllbGQiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImtleUZpZWxkcyIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiaW5wdXRLZXlGaWVsZCIsIkVycm9yIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiJGluIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUEsY0FBakI7QUFBaUNDLEVBQUFBO0FBQWpDLElBQWtESixPQUFPLENBQUMsVUFBRCxDQUEvRDs7QUFDQSxNQUFNSyxNQUFNLEdBQUdMLE9BQU8sQ0FBQyxnQkFBRCxDQUF0Qjs7QUFDQSxNQUFNTSxVQUFVLEdBQUdOLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1PLFVBQVUsR0FBR1AsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTVEsS0FBSyxHQUFHUixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVTLEVBQUFBLGVBQUY7QUFBbUJDLEVBQUFBLGFBQW5CO0FBQWtDQyxFQUFBQTtBQUFsQyxJQUFzRE4sTUFBNUQ7O0FBQ0EsTUFBTU8sUUFBUSxHQUFHWixPQUFPLENBQUMsa0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTWEsS0FBSyxHQUFHYixPQUFPLENBQUMsY0FBRCxDQUFyQjs7QUFFQSxNQUFNO0FBQUVjLEVBQUFBO0FBQUYsSUFBZ0JkLE9BQU8sQ0FBQyxjQUFELENBQTdCOztBQUVBLE1BQU1lLGFBQWEs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a0QsQ0FBRCxFQUFJMU8sQ0FBSixLQUFVLEtBQUt3TSxlQUFMLENBQXFCa0MsQ0FBckIsRUFBd0JjLFNBQXhCLEVBQW1DQyxhQUFuQyxFQUFrREMsaUJBQWlCLElBQUkxUCxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBaEYsQ0FBN0IsQ0FBUDtBQUNIOztBQUVELFFBQUljLEtBQUssQ0FBQ0MsT0FBTixDQUFjeUssS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLFVBQUkzRixHQUFHLEdBQUcyRixLQUFLLENBQUM5SSxHQUFOLENBQVVnTSxDQUFDLElBQUksS0FBS2xDLGVBQUwsQ0FBcUJrQyxDQUFyQixFQUF3QmMsU0FBeEIsRUFBbUNDLGFBQW5DLEVBQWtEQyxpQkFBbEQsQ0FBZixDQUFWO0FBQ0EsYUFBT0EsaUJBQWlCLEdBQUc7QUFBRU0sUUFBQUEsR0FBRyxFQUFFbks7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUk0SixhQUFKLEVBQW1CLE9BQU9qRSxLQUFQO0FBRW5CLFdBQU8sS0FBSzhELFVBQUwsQ0FBZ0I5RCxLQUFoQixDQUFQO0FBQ0g7O0FBeHRDYTs7QUEydENsQnlFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjNQLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSA/IF8ucGljayhkYXRhLCB0aGlzLm1ldGEua2V5RmllbGQpIDogZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdWVyeUNvbHVtbihuYW1lKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJyxcbiAgICAgICAgICAgIG5hbWVcbiAgICAgICAgfTsgXG4gICAgfVxuXG4gICAgc3RhdGljIHF1ZXJ5QmluRXhwcihsZWZ0LCBvcCwgcmlnaHQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9vclR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgIGxlZnQsXG4gICAgICAgICAgICBvcCxcbiAgICAgICAgICAgIHJpZ2h0XG4gICAgICAgIH07IFxuICAgIH1cblxuICAgIHN0YXRpYyBxdWVyeUZ1bmN0aW9uKG5hbWUsIC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9vclR5cGU6ICdGdW5jdGlvbicsXG4gICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgYXJnc1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCwgZGVmYXVsdFZhbHVlKSB7XG4gICAgICAgIGxldCBub2RlcyA9IChBcnJheS5pc0FycmF5KGtleVBhdGgpID8ga2V5UGF0aCA6IGtleVBhdGguc3BsaXQoJy4nKSkubWFwKGtleSA9PiBrZXlbMF0gPT09ICc6JyA/IGtleSA6ICgnOicgKyBrZXkpKTtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwgbm9kZXMsIGRlZmF1bHRWYWx1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKiB7c3RyaW5nfSBba2V5XSAtIFRoZSBrZXkgZmllbGQgdG8gdXNlZCBieSB0aGUgaGFzaHRhYmxlLlxuICAgICAqIHthcnJheX0gW2Fzc29jaWF0aW9uc10gLSBXaXRoIGFuIGFycmF5IG9mIGFzc29jaWF0aW9ucy5cbiAgICAgKiB7b2JqZWN0fSBbY29ubk9wdGlvbnNdIC0gQ29ubmVjdGlvbiBvcHRpb25zLCBlLmcuIHRyYW5zYWN0aW9uIGhhbmRsZVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY29tYmluZWRLZXkgPSBrZXk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBjb21iaW5lZEtleSArPSAnLycgKyBtaW5pZnlBc3NvY3MoYXNzb2NpYXRpb25zKS5qb2luKCcmJylcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkYXNzb2NpYXRpb246IGFzc29jaWF0aW9ucywgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiB0aGlzLmNhY2hlZF8odGhpcy5tZXRhLmtleUZpZWxkLCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdG9EaWN0aW9uYXJ5KGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpIHtcbiAgICAgICAga2V5IHx8IChrZXkgPSB0aGlzLm1ldGEua2V5RmllbGQpO1xuXG4gICAgICAgIHJldHVybiBDb252ZXJ0b3JzLnRvS1ZQYWlycyhlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIHByZTogZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlY29yZHMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBmaW5kT25lKCkgcmV0dXJucyBtb3JlIHRoYW4gb25lIHJlY29yZC5gLCB7IGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIG9wdGlvbnM6IGNvbnRleHQub3B0aW9ucyB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGNvbnN0IFsgZmluaXNoZWQsIHBlbmRpbmdBc3NvY3MgXSA9IGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSBjcmVhdGUgKi8pOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyYXdbbG9jYWxGaWVsZF0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByYXdbbG9jYWxGaWVsZF0gPSByZWZGaWVsZFZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gZGF0YSBcIjoke2xvY2FsRmllbGR9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7bG9jYWxGaWVsZH1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gcGVuZGluZ0Fzc29jcztcbiAgICAgICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSBPYmplY3QuZnJlZXplKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgICAgICAgICBcblxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXY6IHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IE9iamVjdC5mcmVlemUoY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKCdPbmUgb2YgdGhlIHVuaXF1ZSBrZXkgZmllbGQgYXMgcXVlcnkgY29uZGl0aW9uIGlzIG51bGwuIENvbmRpdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSB2YWx1ZSBwYWlyIGluIHRoZSBxdWVyeSBjb25kaXRpb24uJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkID0gdHJ1ZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZyA9IGNvbnRleHQub3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgXy5pc0VtcHR5KGV4aXN0aW5nKSAmJiAodGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykgfHwgb3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAob3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nICYmICFjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIGxldCB2YWx1ZSA9IHJhd1tmaWVsZE5hbWVdO1xuXG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3ksIGNoZWNrIHdyaXRlUHJvdGVjdCBcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHZhbHVlLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5zdGFjayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnR0aXkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGF0ZXN0ID0gY29udGV4dC5sYXRlc3QgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzLCB0cnVlKTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcblxuICAgICAgICAvL2ZpbmFsIHJvdW5kIHByb2Nlc3MgYmVmb3JlIGVudGVyaW5nIGRhdGFiYXNlXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gXy5tYXBWYWx1ZXMobGF0ZXN0LCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgbGV0IGZpZWxkSW5mbyA9IGZpZWxkc1trZXldO1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZEluZm87XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAvL3RoZXJlIGlzIHNwZWNpYWwgaW5wdXQgY29sdW1uIHdoaWNoIG1heWJlIGEgZnVuY3Rpb24gb3IgYW4gZXhwcmVzc2lvblxuICAgICAgICAgICAgICAgIG9wT3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucyA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29tbWl0IG9yIHJvbGxiYWNrIGlzIGNhbGxlZCBpZiB0cmFuc2FjdGlvbiBpcyBjcmVhdGVkIHdpdGhpbiB0aGUgZXhlY3V0b3IuXG4gICAgICogQHBhcmFtIHsqfSBleGVjdXRvciBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYFJvbGxiYWNrZWQsIHJlYXNvbjogJHtlcnJvci5tZXNzYWdlfWAsIHsgIFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBjb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIHJhd0RhdGE6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3REYXRhOiBjb250ZXh0LmxhdGVzdFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZGVuY3lDaGFuZ2VkKGZpZWxkTmFtZSwgY29udGV4dCkge1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llc1tmaWVsZE5hbWVdO1xuXG4gICAgICAgIHJldHVybiBfLmZpbmQoZGVwcywgZCA9PiBfLmlzUGxhaW5PYmplY3QoZCkgPyBoYXNLZXlCeVBhdGgoY29udGV4dCwgZC5yZWZlcmVuY2UpIDogaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQpKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3JlZmVyZW5jZUV4aXN0KGlucHV0LCByZWYpIHtcbiAgICAgICAgbGV0IHBvcyA9IHJlZi5pbmRleE9mKCcuJyk7XG5cbiAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiByZWYuc3Vic3RyKHBvcysxKSBpbiBpbnB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWYgaW4gaW5wdXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG51bGxEZXBlbmRzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4gXG4gICAgICAgICAgICAgICAgXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkLndoZW5OdWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoaW5wdXRbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbERlcGVuZHMuYWRkKGRlcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkID0gZC5yZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmllbGROYW1lIGluIGlucHV0ICYmICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZCk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IGRlcCBvZiBudWxsRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIGlmIChfLmZpbmQoZGVwLCBkID0+ICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZC5yZWZlcmVuY2UpKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgIFxuICAgICAgICAgICAgICAgICAgICBrZXlGaWVsZHM6IHRoaXMubWV0YS5rZXlGaWVsZCAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBpbnB1dEtleUZpZWxkOiBrZXlGaWVsZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFNlcmlhbGl6ZSwgYXJyYXlUb0luT3BlcmF0b3IpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9vclR5cGVzVG9CeXBhc3MuaGFzKHZhbHVlLm9vclR5cGUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
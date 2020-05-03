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
  isNothing,
  hasValueIn
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
    return data[this.meta.keyField];
  }

  static fieldMeta(name) {
    return _.omit(this.meta.fields[name], ['default']);
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

    let [raw, associations] = this._extractAssociations(data, true);

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
          raw[localField] = refFieldValue;
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

      if (context.options.$upsert) {
        context.result = await this.db.connector.upsertOne_(this.meta.name, context.latest, this.getUniqueKeyFieldsFrom(context.latest), context.connOptions);
      } else {
        context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
      }

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
      connOptions,
      forSingleRecord
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

    let success = await this._safeExecute_(async context => {
      let needUpdateAssocs = !_.isEmpty(associations);
      let doneUpdateAssocs;

      if (needUpdateAssocs) {
        await this.ensureTransaction_(context);
        associations = await this._updateAssocs_(context, associations, true, forSingleRecord);
        needUpdateAssocs = !_.isEmpty(associations);
        doneUpdateAssocs = true;
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

      if (_.isEmpty(context.latest)) {
        if (!doneUpdateAssocs && !needUpdateAssocs) {
          throw new InvalidArgument('Cannot do the update with empty record. Entity: ' + this.meta.name);
        }
      } else {
        context.latest = Object.freeze(context.latest);
        const {
          $query,
          ...otherOptions
        } = context.options;

        if (needUpdateAssocs && !hasValueIn([$query, context.latest], this.meta.keyField) && !otherOptions.$retrieveUpdated) {
          otherOptions.$retrieveUpdated = true;
        }

        context.result = await this.db.connector.update_(this.meta.name, context.latest, $query, otherOptions, context.connOptions);
        context.return = context.latest;

        if (forSingleRecord) {
          await this._internalAfterUpdate_(context);

          if (!context.queryKey) {
            context.queryKey = this.getUniqueKeyValuePairsFrom($query);
          }
        } else {
          await this._internalAfterUpdateMany_(context);
        }

        await Features.applyRules_(Rules.RULE_AFTER_UPDATE, this, context);
      }

      if (needUpdateAssocs) {
        await this._updateAssocs_(context, associations, false, forSingleRecord);
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
      connOptions,
      forSingleRecord
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
          if (!opOptions.$migration && (!isUpdating || !opOptions.$bypassReadOnly || !opOptions.$bypassReadOnly.has(fieldName))) {
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

          if (fieldInfo['default']) {
            latest[fieldName] = fieldInfo['default'];
          } else {
            latest[fieldName] = null;
          }
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

        throw new Error('Not implemented yet. ' + value.oorType);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwib21pdCIsImZpZWxkcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwibG9nIiwiZW50aXR5IiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhd09wdGlvbnMiLCJyYXciLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwibmVlZENyZWF0ZUFzc29jcyIsImZpbmlzaGVkIiwicGVuZGluZ0Fzc29jcyIsIl9jcmVhdGVBc3NvY3NfIiwiZm9yT3duIiwicmVmRmllbGRWYWx1ZSIsImxvY2FsRmllbGQiLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsImxhdGVzdCIsImZyZWV6ZSIsIiR1cHNlcnQiLCJ1cHNlcnRPbmVfIiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsInRvVXBkYXRlIiwiYmVmb3JlVXBkYXRlXyIsImJlZm9yZVVwZGF0ZU1hbnlfIiwibmVlZFVwZGF0ZUFzc29jcyIsImRvbmVVcGRhdGVBc3NvY3MiLCJfdXBkYXRlQXNzb2NzXyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIm90aGVyT3B0aW9ucyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwiJGV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJtZXNzYWdlIiwibGF0ZXN0RGF0YSIsInJvbGxiYWNrXyIsIl9kZXBlbmRlbmN5Q2hhbmdlZCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImQiLCJyZWZlcmVuY2UiLCJfcmVmZXJlbmNlRXhpc3QiLCJpbnB1dCIsInJlZiIsInBvcyIsImluZGV4T2YiLCJzdWJzdHIiLCJoYXNEZXBlbmRzIiwibnVsbERlcGVuZHMiLCJkZXAiLCJ3aGVuTnVsbCIsImFkZCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJmaWVsZCIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2Iiwia2V5RmllbGRzIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJpbnB1dEtleUZpZWxkIiwiRXJyb3IiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJfc2VyaWFsaXplIiwiaW5mbyIsInZhcmlhYmxlcyIsInNraXBTZXJpYWxpemUiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQSxjQUFqQjtBQUFpQ0MsRUFBQUE7QUFBakMsSUFBa0RKLE9BQU8sQ0FBQyxVQUFELENBQS9EOztBQUNBLE1BQU1LLE1BQU0sR0FBR0wsT0FBTyxDQUFDLGdCQUFELENBQXRCOztBQUNBLE1BQU1NLFVBQVUsR0FBR04sT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU8sVUFBVSxHQUFHUCxPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNUSxLQUFLLEdBQUdSLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVMsRUFBQUEsZUFBRjtBQUFtQkMsRUFBQUEsYUFBbkI7QUFBa0NDLEVBQUFBO0FBQWxDLElBQXNETixNQUE1RDs7QUFDQSxNQUFNTyxRQUFRLEdBQUdaLE9BQU8sQ0FBQyxrQkFBRCxDQUF4Qjs7QUFDQSxNQUFNYSxLQUFLLEdBQUdiLE9BQU8sQ0FBQyxjQUFELENBQXJCOztBQUVBLE1BQU07QUFBRWMsRUFBQUEsU0FBRjtBQUFhQyxFQUFBQTtBQUFi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YyxTQUF4QixFQUFtQ0MsYUFBbkMsRUFBa0RDLGlCQUFsRCxDQUFmLENBQVY7QUFDQSxhQUFPQSxpQkFBaUIsR0FBRztBQUFFTSxRQUFBQSxHQUFHLEVBQUV4SztBQUFQLE9BQUgsR0FBa0JBLEdBQTFDO0FBQ0g7O0FBRUQsUUFBSWlLLGFBQUosRUFBbUIsT0FBT2xFLEtBQVA7QUFFbkIsV0FBTyxLQUFLK0QsVUFBTCxDQUFnQi9ELEtBQWhCLENBQVA7QUFDSDs7QUExdUNhOztBQTZ1Q2xCMEUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCMVAsV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCwgaGFzS2V5QnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IENvbnZlcnRvcnMgPSByZXF1aXJlKCcuL0NvbnZlcnRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZywgaGFzVmFsdWVJbiB9ID0gcmVxdWlyZSgnLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuY29uc3Qgb29yVHlwZXNUb0J5cGFzcyA9IG5ldyBTZXQoWydDb2x1bW5SZWZlcmVuY2UnLCAnRnVuY3Rpb24nLCAnQmluYXJ5RXhwcmVzc2lvbiddKTtcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZmllbGRNZXRhKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIF8ub21pdCh0aGlzLm1ldGEuZmllbGRzW25hbWVdLCBbJ2RlZmF1bHQnXSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoLCBkZWZhdWx0VmFsdWUpIHtcbiAgICAgICAgbGV0IG5vZGVzID0gKEFycmF5LmlzQXJyYXkoa2V5UGF0aCkgPyBrZXlQYXRoIDoga2V5UGF0aC5zcGxpdCgnLicpKS5tYXAoa2V5ID0+IGtleVswXSA9PT0gJzonID8ga2V5IDogKCc6JyArIGtleSkpO1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBub2RlcywgZGVmYXVsdFZhbHVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqIHtzdHJpbmd9IFtrZXldIC0gVGhlIGtleSBmaWVsZCB0byB1c2VkIGJ5IHRoZSBoYXNodGFibGUuXG4gICAgICoge2FycmF5fSBbYXNzb2NpYXRpb25zXSAtIFdpdGggYW4gYXJyYXkgb2YgYXNzb2NpYXRpb25zLlxuICAgICAqIHtvYmplY3R9IFtjb25uT3B0aW9uc10gLSBDb25uZWN0aW9uIG9wdGlvbnMsIGUuZy4gdHJhbnNhY3Rpb24gaGFuZGxlXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0b0RpY3Rpb25hcnkoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcikge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIENvbnZlcnRvcnMudG9LVlBhaXJzKGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVwc2VydD1mYWxzZV0gLSBJZiBhbHJlYWR5IGV4aXN0LCBqdXN0IHVwZGF0ZSB0aGUgcmVjb3JkLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIWNyZWF0ZU9wdGlvbnMpIHsgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zID0ge307IFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgdHJ1ZSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBbIGZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzIF0gPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IHBlbmRpbmdBc3NvY3M7XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBzZXJ0T25lXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShjb250ZXh0LmxhdGVzdCksXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGxldCBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgbGV0IGRvbmVVcGRhdGVBc3NvY3M7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgdXBkYXRlICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgZG9uZVVwZGF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQubGF0ZXN0KSkge1xuICAgICAgICAgICAgICAgIGlmICghZG9uZVVwZGF0ZUFzc29jcyAmJiAhbmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgZG8gdGhlIHVwZGF0ZSB3aXRoIGVtcHR5IHJlY29yZC4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgIWhhc1ZhbHVlSW4oWyRxdWVyeSwgY29udGV4dC5sYXRlc3RdLCB0aGlzLm1ldGEua2V5RmllbGQpICYmICFvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBhc3NvY2lhdGVkIGRhdGEgZGVwZW5kaW5nIG9uIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuXG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKCRxdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zLFxuICAgICAgICAgICAgZm9yU2luZ2xlUmVjb3JkXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKCdPbmUgb2YgdGhlIHVuaXF1ZSBrZXkgZmllbGQgYXMgcXVlcnkgY29uZGl0aW9uIGlzIG51bGwuIENvbmRpdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSB2YWx1ZSBwYWlyIGluIHRoZSBxdWVyeSBjb25kaXRpb24uJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkID0gdHJ1ZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZyA9IGNvbnRleHQub3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgXy5pc0VtcHR5KGV4aXN0aW5nKSAmJiAodGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykgfHwgb3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAob3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nICYmICFjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIGxldCB2YWx1ZSA9IHJhd1tmaWVsZE5hbWVdO1xuXG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seSB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvWydkZWZhdWx0J10pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvWydkZWZhdWx0J107XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWUgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIC8vdGhlcmUgaXMgc3BlY2lhbCBpbnB1dCBjb2x1bW4gd2hpY2ggbWF5YmUgYSBmdW5jdGlvbiBvciBhbiBleHByZXNzaW9uXG4gICAgICAgICAgICAgICAgb3BPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgUm9sbGJhY2tlZCwgcmVhc29uOiAke2Vycm9yLm1lc3NhZ2V9YCwgeyAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RGF0YTogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdERhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kZW5jeUNoYW5nZWQoZmllbGROYW1lLCBjb250ZXh0KSB7XG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzW2ZpZWxkTmFtZV07XG5cbiAgICAgICAgcmV0dXJuIF8uZmluZChkZXBzLCBkID0+IF8uaXNQbGFpbk9iamVjdChkKSA/IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBoYXNLZXlCeVBhdGgoY29udGV4dCwgZCkpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcmVmZXJlbmNlRXhpc3QoaW5wdXQsIHJlZikge1xuICAgICAgICBsZXQgcG9zID0gcmVmLmluZGV4T2YoJy4nKTtcblxuICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZi5zdWJzdHIocG9zKzEpIGluIGlucHV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZiBpbiBpbnB1dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbnVsbERlcGVuZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiBcbiAgICAgICAgICAgICAgICBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQud2hlbk51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChpbnB1dFtmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsRGVwZW5kcy5hZGQoZGVwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGQgPSBkLnJlZmVyZW5jZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWVsZE5hbWUgaW4gaW5wdXQgJiYgIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChsZXQgZGVwIG9mIG51bGxEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uZmluZChkZXAsIGQgPT4gIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkLnJlZmVyZW5jZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgXG4gICAgICAgICAgICAgICAgICAgIGtleUZpZWxkczogdGhpcy5tZXRhLmtleUZpZWxkICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcywgbnVsbCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBmaW5kQWxsIHByb2Nlc3NpbmdcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0S2V5RmllbGQ6IGtleUZpZWxkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMudG9EaWN0aW9uYXJ5KHJlY29yZHMsIGtleUZpZWxkKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplLCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
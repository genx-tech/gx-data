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

const oorTypesToBypass = new Set(['ColumnReference', 'Function', 'BinaryExpression', 'DataSet', 'SQL']);

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
    const meta = this.meta.fields[name];

    if (!meta) {
      throw new InvalidArgument(`Uknown field "${name}" of entity "${this.meta.name}".`);
    }

    return _.omit(meta, ['default']);
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
        records = this._mapRecordsToObjects(records, findOptions.$relationships, findOptions.$nestedKeyGetter);
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
          records = this._mapRecordsToObjects(records, findOptions.$relationships, findOptions.$nestedKeyGetter);
        } else {
          records = records[0];
        }
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
          records = records[0];
        } else if (findOptions.$skipOrm) {
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
        context.result = await this.db.connector.upsertOne_(this.meta.name, context.latest, this.getUniqueKeyFieldsFrom(context.latest), context.connOptions, context.options.$upsert);
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

  static async deleteAll_(connOptions) {
    return this.deleteMany_({
      $deleteAll: true
    }, connOptions);
  }

  static async _delete_(deleteOptions, connOptions, forSingleRecord) {
    let rawOptions = deleteOptions;
    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);

    if (_.isEmpty(deleteOptions.$query) && (forSingleRecord || !deleteOptions.$deleteAll)) {
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

    let deletedCount = await this._safeExecute_(async context => {
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

      const {
        $query,
        ...otherOptions
      } = context.options;
      context.result = await this.db.connector.delete_(this.meta.name, $query, otherOptions, context.connOptions);

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
      return this.db.connector.deletedCount(context);
    }, context);

    if (deletedCount) {
      if (forSingleRecord) {
        await this.afterDelete_(context);
      } else {
        await this.afterDeleteMany_(context);
      }
    }

    return context.return || deletedCount;
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
          if (fieldInfo['default']) {
            latest[fieldName] = fieldInfo['default'];
          } else if (!fieldInfo.optional) {
            throw new ValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
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
          if (fieldInfo.updateByDb || fieldInfo.hasActivator) {
            return;
          }

          if (fieldInfo.auto) {
            latest[fieldName] = await Generators.default(fieldInfo, i18n);
            return;
          }

          throw new ValidationError(`"${fieldName}" of "${name}" entity is required for each update.`, {
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

    if (!opOptions.$skipModifiers) {
      await this.applyModifiers_(context, isUpdating);
    }

    context.latest = _.mapValues(latest, (value, key) => {
      if (value == null) return value;

      if (_.isPlainObject(value) && value.oorType) {
        opOptions.$requireSplitColumns = true;
        return value;
      }

      let fieldInfo = fields[key];

      if (!fieldInfo) {
        throw new Error("Assertion failed: fieldInfo");
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

  static _serializeByTypeInfo(value, info) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateValue(value, variables, skipTypeCast, arrayToInOperator) {
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

      return _.mapValues(value, (v, k) => this._translateValue(v, variables, skipTypeCast, arrayToInOperator && k[0] !== '$'));
    }

    if (Array.isArray(value)) {
      let ret = value.map(v => this._translateValue(v, variables, skipTypeCast, arrayToInOperator));
      return arrayToInOperator ? {
        $in: ret
      } : ret;
    }

    if (skipTypeCast) return value;
    return this.db.connector.typeCast(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwiJG5lc3RlZEtleUdldHRlciIsImxvZyIsImVudGl0eSIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXdPcHRpb25zIiwicmF3IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJiZWZvcmVDcmVhdGVfIiwicmV0dXJuIiwic3VjY2VzcyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJmaW5pc2hlZCIsInBlbmRpbmdBc3NvY3MiLCJfY3JlYXRlQXNzb2NzXyIsImZvck93biIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJsYXRlc3QiLCJmcmVlemUiLCIkdXBzZXJ0IiwidXBzZXJ0T25lXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIm5lZWRVcGRhdGVBc3NvY3MiLCJkb25lVXBkYXRlQXNzb2NzIiwiX3VwZGF0ZUFzc29jc18iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJvdGhlck9wdGlvbnMiLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJkZWxldGVBbGxfIiwiJGRlbGV0ZUFsbCIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlZENvdW50IiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwiJGV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1RLEtBQUssR0FBR1IsT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFUyxFQUFBQSxlQUFGO0FBQW1CQyxFQUFBQSxhQUFuQjtBQUFrQ0MsRUFBQUE7QUFBbEMsSUFBc0ROLE1BQTVEOztBQUNBLE1BQU1PLFFBQVEsR0FBR1osT0FBTyxDQUFDLGtCQUFELENBQXhCOztBQUNBLE1BQU1hLEtBQUssR0FBR2IsT0FBTyxDQUFDLGNBQUQsQ0FBckI7O0FBRUEsTUFBTTtBQUFFYyxFQUFBQSxTQUFGO0FBQWFDLEVBQUFBO0FBQWIsSUFBNEJmLE9BQU8sQ0FBQyxjQUFELENBQXpDOztBQUVBLE1BQU1nQixhQUFhLEdBQUcsa0RBQXRCOztBQUVBLFNBQVNDLFlBQVQsQ0FBc0JDLE1BQXRCLEVBQThCO0FBQzFCLE1BQUlDLE1BQU0sR0FBR2xCLENBQUMsQ0FBQ21CLElBQUYsQ0FBT0YsTUFBUCxFQUFlRyxJQUFmLEdBQXNCQyxPQUF0QixFQUFiOztBQUVBLE1BQUlDLFFBQVEsR0FBR3RCLENBQUMsQ0FBQ3VCLElBQUYsQ0FBT0wsTUFBUCxFQUFlLENBQWYsQ0FBZjtBQUFBLE1BQWtDTSxDQUFDLEdBQUdOLE1BQU0sQ0FBQ08sTUFBUCxHQUFnQixDQUF0RDs7QUFFQSxPQUFLLElBQUlDLENBQUMsR0FBRyxDQUFiLEVBQWdCQSxDQUFDLEdBQUdGLENBQXBCLEVBQXVCRSxDQUFDLEVBQXhCLEVBQTRCO0FBQ3hCLFFBQUlDLENBQUMsR0FBR1QsTUFBTSxDQUFDUSxDQUFELENBQU4sR0FBWSxHQUFwQjs7QUFFQSxRQUFJLENBQUMxQixDQUFDLENBQUM0QixJQUFGLENBQU9OLFFBQVAsRUFBaUJPLENBQUMsSUFBSUEsQ0FBQyxDQUFDQyxVQUFGLENBQWFILENBQWIsQ0FBdEIsQ0FBTCxFQUE2QztBQUN6Q0wsTUFBQUEsUUFBUSxDQUFDUyxJQUFULENBQWNiLE1BQU0sQ0FBQ1EsQ0FBRCxDQUFwQjtBQUNIO0FBQ0o7O0FBRUQsU0FBT0osUUFBUDtBQUNIOztBQUVELE1BQU1VLGdCQUFnQixHQUFHLElBQUlDLEdBQUosQ0FBUSxDQUFDLGlCQUFELEVBQW9CLFVBQXBCLEVBQWdDLGtCQUFoQyxFQUFvRCxTQUFwRCxFQUErRCxLQUEvRCxDQUFSLENBQXpCOztBQU1BLE1BQU1DLFdBQU4sQ0FBa0I7QUFJZEMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVU7QUFDakIsUUFBSUEsT0FBSixFQUFhO0FBRVRDLE1BQUFBLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjLElBQWQsRUFBb0JGLE9BQXBCO0FBQ0g7QUFDSjs7QUFFRCxTQUFPRyxVQUFQLENBQWtCQyxJQUFsQixFQUF3QjtBQUNwQixXQUFPQSxJQUFJLENBQUMsS0FBS0MsSUFBTCxDQUFVQyxRQUFYLENBQVg7QUFDSDs7QUFNRCxTQUFPQyxTQUFQLENBQWlCQyxJQUFqQixFQUF1QjtBQUNuQixVQUFNSCxJQUFJLEdBQUcsS0FBS0EsSUFBTCxDQUFVSSxNQUFWLENBQWlCRCxJQUFqQixDQUFiOztBQUNBLFFBQUksQ0FBQ0gsSUFBTCxFQUFXO0FBQ1AsWUFBTSxJQUFJL0IsZUFBSixDQUFxQixpQkFBZ0JrQyxJQUFLLGdCQUFlLEtBQUtILElBQUwsQ0FBVUcsSUFBSyxJQUF4RSxDQUFOO0FBQ0g7O0FBQ0QsV0FBTzVDLENBQUMsQ0FBQzhDLElBQUYsQ0FBT0wsSUFBUCxFQUFhLENBQUMsU0FBRCxDQUFiLENBQVA7QUFDSDs7QUFNRCxTQUFPTSxzQkFBUCxDQUE4QlAsSUFBOUIsRUFBb0M7QUFDaEMsV0FBT3hDLENBQUMsQ0FBQzRCLElBQUYsQ0FBTyxLQUFLYSxJQUFMLENBQVVPLFVBQWpCLEVBQTZCSCxNQUFNLElBQUk3QyxDQUFDLENBQUNpRCxLQUFGLENBQVFKLE1BQVIsRUFBZ0JLLENBQUMsSUFBSSxDQUFDbEQsQ0FBQyxDQUFDbUQsS0FBRixDQUFRWCxJQUFJLENBQUNVLENBQUQsQ0FBWixDQUF0QixDQUF2QyxDQUFQO0FBQ0g7O0FBTUQsU0FBT0UsMEJBQVAsQ0FBa0NaLElBQWxDLEVBQXdDO0FBQUEsVUFDL0IsT0FBT0EsSUFBUCxLQUFnQixRQURlO0FBQUE7QUFBQTs7QUFHcEMsUUFBSWEsUUFBUSxHQUFHLEtBQUtOLHNCQUFMLENBQTRCUCxJQUE1QixDQUFmO0FBQ0EsV0FBT3hDLENBQUMsQ0FBQ3NELElBQUYsQ0FBT2QsSUFBUCxFQUFhYSxRQUFiLENBQVA7QUFDSDs7QUFPRCxTQUFPRSxlQUFQLENBQXVCQyxTQUF2QixFQUFrQ0MsT0FBbEMsRUFBMkNDLFlBQTNDLEVBQXlEO0FBQ3JELFFBQUlDLEtBQUssR0FBRyxDQUFDQyxLQUFLLENBQUNDLE9BQU4sQ0FBY0osT0FBZCxJQUF5QkEsT0FBekIsR0FBbUNBLE9BQU8sQ0FBQ0ssS0FBUixDQUFjLEdBQWQsQ0FBcEMsRUFBd0RDLEdBQXhELENBQTREQyxHQUFHLElBQUlBLEdBQUcsQ0FBQyxDQUFELENBQUgsS0FBVyxHQUFYLEdBQWlCQSxHQUFqQixHQUF3QixNQUFNQSxHQUFqRyxDQUFaO0FBQ0EsV0FBTzlELGNBQWMsQ0FBQ3NELFNBQUQsRUFBWUcsS0FBWixFQUFtQkQsWUFBbkIsQ0FBckI7QUFDSDs7QUFPRCxTQUFPTyxxQkFBUCxDQUE2QkMsT0FBN0IsRUFBc0NDLGFBQXRDLEVBQXFEO0FBQ2pELFFBQUksQ0FBQ0QsT0FBTyxDQUFDRSxPQUFSLENBQWdCQyxnQkFBckIsRUFBdUM7QUFDbkNILE1BQUFBLE9BQU8sQ0FBQ0UsT0FBUixDQUFnQkMsZ0JBQWhCLEdBQW1DRixhQUFhLEdBQUdBLGFBQUgsR0FBbUIsSUFBbkU7QUFDSDtBQUNKOztBQU9ELFNBQU9HLHFCQUFQLENBQTZCSixPQUE3QixFQUFzQ0MsYUFBdEMsRUFBcUQ7QUFDakQsUUFBSSxDQUFDRCxPQUFPLENBQUNFLE9BQVIsQ0FBZ0JHLGdCQUFyQixFQUF1QztBQUNuQ0wsTUFBQUEsT0FBTyxDQUFDRSxPQUFSLENBQWdCRyxnQkFBaEIsR0FBbUNKLGFBQWEsR0FBR0EsYUFBSCxHQUFtQixJQUFuRTtBQUNIO0FBQ0o7O0FBT0QsU0FBT0sscUJBQVAsQ0FBNkJOLE9BQTdCLEVBQXNDQyxhQUF0QyxFQUFxRDtBQUNqRCxRQUFJLENBQUNELE9BQU8sQ0FBQ0UsT0FBUixDQUFnQkssZ0JBQXJCLEVBQXVDO0FBQ25DUCxNQUFBQSxPQUFPLENBQUNFLE9BQVIsQ0FBZ0JLLGdCQUFoQixHQUFtQ04sYUFBYSxHQUFHQSxhQUFILEdBQW1CLElBQW5FO0FBQ0g7QUFDSjs7QUFNRCxlQUFhTyxrQkFBYixDQUFnQ1IsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFPLENBQUNTLFdBQVQsSUFBd0IsQ0FBQ1QsT0FBTyxDQUFDUyxXQUFSLENBQW9CQyxVQUFqRCxFQUE2RDtBQUN6RFYsTUFBQUEsT0FBTyxDQUFDUyxXQUFSLEtBQXdCVCxPQUFPLENBQUNTLFdBQVIsR0FBc0IsRUFBOUM7QUFFQVQsTUFBQUEsT0FBTyxDQUFDUyxXQUFSLENBQW9CQyxVQUFwQixHQUFpQyxNQUFNLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsaUJBQWxCLEVBQXZDO0FBQ0g7QUFDSjs7QUFRRCxTQUFPQyxtQkFBUCxDQUEyQmQsT0FBM0IsRUFBb0NGLEdBQXBDLEVBQXlDO0FBQ3JDLFdBQU85RCxjQUFjLENBQUNnRSxPQUFELEVBQVUsd0JBQXdCRixHQUFsQyxDQUFyQjtBQUNIOztBQVFELGVBQWFpQixPQUFiLENBQXFCakIsR0FBckIsRUFBMEJrQixZQUExQixFQUF3Q1AsV0FBeEMsRUFBcUQ7QUFDakQsUUFBSVgsR0FBSixFQUFTO0FBQ0wsVUFBSW1CLFdBQVcsR0FBR25CLEdBQWxCOztBQUVBLFVBQUksQ0FBQ2hFLENBQUMsQ0FBQ29GLE9BQUYsQ0FBVUYsWUFBVixDQUFMLEVBQThCO0FBQzFCQyxRQUFBQSxXQUFXLElBQUksTUFBTW5FLFlBQVksQ0FBQ2tFLFlBQUQsQ0FBWixDQUEyQkcsSUFBM0IsQ0FBZ0MsR0FBaEMsQ0FBckI7QUFDSDs7QUFFRCxVQUFJQyxVQUFKOztBQUVBLFVBQUksQ0FBQyxLQUFLQyxXQUFWLEVBQXVCO0FBQ25CLGFBQUtBLFdBQUwsR0FBbUIsRUFBbkI7QUFDSCxPQUZELE1BRU8sSUFBSSxLQUFLQSxXQUFMLENBQWlCSixXQUFqQixDQUFKLEVBQW1DO0FBQ3RDRyxRQUFBQSxVQUFVLEdBQUcsS0FBS0MsV0FBTCxDQUFpQkosV0FBakIsQ0FBYjtBQUNIOztBQUVELFVBQUksQ0FBQ0csVUFBTCxFQUFpQjtBQUNiQSxRQUFBQSxVQUFVLEdBQUcsS0FBS0MsV0FBTCxDQUFpQkosV0FBakIsSUFBZ0MsTUFBTSxLQUFLSyxRQUFMLENBQWM7QUFBRUMsVUFBQUEsWUFBWSxFQUFFUCxZQUFoQjtBQUE4QlEsVUFBQUEsYUFBYSxFQUFFMUI7QUFBN0MsU0FBZCxFQUFrRVcsV0FBbEUsQ0FBbkQ7QUFDSDs7QUFFRCxhQUFPVyxVQUFQO0FBQ0g7O0FBRUQsV0FBTyxLQUFLTCxPQUFMLENBQWEsS0FBS3hDLElBQUwsQ0FBVUMsUUFBdkIsRUFBaUN3QyxZQUFqQyxFQUErQ1AsV0FBL0MsQ0FBUDtBQUNIOztBQUVELFNBQU9nQixZQUFQLENBQW9CQyxnQkFBcEIsRUFBc0M1QixHQUF0QyxFQUEyQzZCLFdBQTNDLEVBQXdEO0FBQ3BEN0IsSUFBQUEsR0FBRyxLQUFLQSxHQUFHLEdBQUcsS0FBS3ZCLElBQUwsQ0FBVUMsUUFBckIsQ0FBSDtBQUVBLFdBQU9wQyxVQUFVLENBQUN3RixTQUFYLENBQXFCRixnQkFBckIsRUFBdUM1QixHQUF2QyxFQUE0QzZCLFdBQTVDLENBQVA7QUFDSDs7QUFrQkQsZUFBYUUsUUFBYixDQUFzQkMsV0FBdEIsRUFBbUNyQixXQUFuQyxFQUFnRDtBQUFBLFNBQ3ZDcUIsV0FEdUM7QUFBQTtBQUFBOztBQUc1Q0EsSUFBQUEsV0FBVyxHQUFHLEtBQUtDLGVBQUwsQ0FBcUJELFdBQXJCLEVBQWtDLElBQWxDLENBQWQ7QUFFQSxRQUFJOUIsT0FBTyxHQUFHO0FBQ1ZFLE1BQUFBLE9BQU8sRUFBRTRCLFdBREM7QUFFVnJCLE1BQUFBO0FBRlUsS0FBZDtBQUtBLFVBQU1oRSxRQUFRLENBQUN1RixXQUFULENBQXFCdEYsS0FBSyxDQUFDdUYsZ0JBQTNCLEVBQTZDLElBQTdDLEVBQW1EakMsT0FBbkQsQ0FBTjtBQUVBLFdBQU8sS0FBS2tDLGFBQUwsQ0FBbUIsTUFBT2xDLE9BQVAsSUFBbUI7QUFDekMsVUFBSW1DLE9BQU8sR0FBRyxNQUFNLEtBQUt4QixFQUFMLENBQVFDLFNBQVIsQ0FBa0J3QixLQUFsQixDQUNoQixLQUFLN0QsSUFBTCxDQUFVRyxJQURNLEVBRWhCc0IsT0FBTyxDQUFDRSxPQUZRLEVBR2hCRixPQUFPLENBQUNTLFdBSFEsQ0FBcEI7QUFLQSxVQUFJLENBQUMwQixPQUFMLEVBQWMsTUFBTSxJQUFJNUYsYUFBSixDQUFrQixrREFBbEIsQ0FBTjs7QUFFZCxVQUFJdUYsV0FBVyxDQUFDTyxjQUFaLElBQThCLENBQUNQLFdBQVcsQ0FBQ1EsUUFBL0MsRUFBeUQ7QUFFckQsWUFBSUgsT0FBTyxDQUFDLENBQUQsQ0FBUCxDQUFXNUUsTUFBWCxLQUFzQixDQUExQixFQUE2QixPQUFPZ0YsU0FBUDtBQUU3QkosUUFBQUEsT0FBTyxHQUFHLEtBQUtLLG9CQUFMLENBQTBCTCxPQUExQixFQUFtQ0wsV0FBVyxDQUFDTyxjQUEvQyxFQUErRFAsV0FBVyxDQUFDVyxnQkFBM0UsQ0FBVjtBQUNILE9BTEQsTUFLTyxJQUFJTixPQUFPLENBQUM1RSxNQUFSLEtBQW1CLENBQXZCLEVBQTBCO0FBQzdCLGVBQU9nRixTQUFQO0FBQ0g7O0FBRUQsVUFBSUosT0FBTyxDQUFDNUUsTUFBUixLQUFtQixDQUF2QixFQUEwQjtBQUN0QixhQUFLb0QsRUFBTCxDQUFRQyxTQUFSLENBQWtCOEIsR0FBbEIsQ0FBc0IsT0FBdEIsRUFBZ0MseUNBQWhDLEVBQTBFO0FBQUVDLFVBQUFBLE1BQU0sRUFBRSxLQUFLcEUsSUFBTCxDQUFVRyxJQUFwQjtBQUEwQndCLFVBQUFBLE9BQU8sRUFBRUYsT0FBTyxDQUFDRTtBQUEzQyxTQUExRTtBQUNIOztBQUVELFVBQUkwQyxNQUFNLEdBQUdULE9BQU8sQ0FBQyxDQUFELENBQXBCO0FBRUEsYUFBT1MsTUFBUDtBQUNILEtBeEJNLEVBd0JKNUMsT0F4QkksQ0FBUDtBQXlCSDs7QUFrQkQsZUFBYXNCLFFBQWIsQ0FBc0JRLFdBQXRCLEVBQW1DckIsV0FBbkMsRUFBZ0Q7QUFDNUNxQixJQUFBQSxXQUFXLEdBQUcsS0FBS0MsZUFBTCxDQUFxQkQsV0FBckIsQ0FBZDtBQUVBLFFBQUk5QixPQUFPLEdBQUc7QUFDVkUsTUFBQUEsT0FBTyxFQUFFNEIsV0FEQztBQUVWckIsTUFBQUE7QUFGVSxLQUFkO0FBS0EsVUFBTWhFLFFBQVEsQ0FBQ3VGLFdBQVQsQ0FBcUJ0RixLQUFLLENBQUN1RixnQkFBM0IsRUFBNkMsSUFBN0MsRUFBbURqQyxPQUFuRCxDQUFOO0FBRUEsUUFBSTZDLFVBQUo7QUFFQSxRQUFJQyxJQUFJLEdBQUcsTUFBTSxLQUFLWixhQUFMLENBQW1CLE1BQU9sQyxPQUFQLElBQW1CO0FBQ25ELFVBQUltQyxPQUFPLEdBQUcsTUFBTSxLQUFLeEIsRUFBTCxDQUFRQyxTQUFSLENBQWtCd0IsS0FBbEIsQ0FDaEIsS0FBSzdELElBQUwsQ0FBVUcsSUFETSxFQUVoQnNCLE9BQU8sQ0FBQ0UsT0FGUSxFQUdoQkYsT0FBTyxDQUFDUyxXQUhRLENBQXBCO0FBTUEsVUFBSSxDQUFDMEIsT0FBTCxFQUFjLE1BQU0sSUFBSTVGLGFBQUosQ0FBa0Isa0RBQWxCLENBQU47O0FBRWQsVUFBSXVGLFdBQVcsQ0FBQ08sY0FBaEIsRUFBZ0M7QUFDNUIsWUFBSVAsV0FBVyxDQUFDaUIsV0FBaEIsRUFBNkI7QUFDekJGLFVBQUFBLFVBQVUsR0FBR1YsT0FBTyxDQUFDLENBQUQsQ0FBcEI7QUFDSDs7QUFFRCxZQUFJLENBQUNMLFdBQVcsQ0FBQ1EsUUFBakIsRUFBMkI7QUFDdkJILFVBQUFBLE9BQU8sR0FBRyxLQUFLSyxvQkFBTCxDQUEwQkwsT0FBMUIsRUFBbUNMLFdBQVcsQ0FBQ08sY0FBL0MsRUFBK0RQLFdBQVcsQ0FBQ1csZ0JBQTNFLENBQVY7QUFDSCxTQUZELE1BRU87QUFDSE4sVUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUMsQ0FBRCxDQUFqQjtBQUNIO0FBQ0osT0FWRCxNQVVPO0FBQ0gsWUFBSUwsV0FBVyxDQUFDaUIsV0FBaEIsRUFBNkI7QUFDekJGLFVBQUFBLFVBQVUsR0FBR1YsT0FBTyxDQUFDLENBQUQsQ0FBcEI7QUFDQUEsVUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUMsQ0FBRCxDQUFqQjtBQUNILFNBSEQsTUFHTyxJQUFJTCxXQUFXLENBQUNRLFFBQWhCLEVBQTBCO0FBQzdCSCxVQUFBQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQyxDQUFELENBQWpCO0FBQ0g7QUFDSjs7QUFFRCxhQUFPLEtBQUthLGFBQUwsQ0FBbUJoRCxPQUFuQixFQUE0Qm1DLE9BQTVCLENBQVA7QUFDSCxLQTdCZ0IsRUE2QmRuQyxPQTdCYyxDQUFqQjs7QUErQkEsUUFBSThCLFdBQVcsQ0FBQ2lCLFdBQWhCLEVBQTZCO0FBQ3pCLFVBQUlFLEdBQUcsR0FBRztBQUFFQyxRQUFBQSxVQUFVLEVBQUVMLFVBQWQ7QUFBMEJNLFFBQUFBLEtBQUssRUFBRUw7QUFBakMsT0FBVjs7QUFFQSxVQUFJLENBQUNuRyxTQUFTLENBQUNtRixXQUFXLENBQUNzQixPQUFiLENBQWQsRUFBcUM7QUFDakNILFFBQUFBLEdBQUcsQ0FBQ0ksTUFBSixHQUFhdkIsV0FBVyxDQUFDc0IsT0FBekI7QUFDSDs7QUFFRCxVQUFJLENBQUN6RyxTQUFTLENBQUNtRixXQUFXLENBQUN3QixNQUFiLENBQWQsRUFBb0M7QUFDaENMLFFBQUFBLEdBQUcsQ0FBQ00sS0FBSixHQUFZekIsV0FBVyxDQUFDd0IsTUFBeEI7QUFDSDs7QUFFRCxhQUFPTCxHQUFQO0FBQ0g7O0FBRUQsV0FBT0gsSUFBUDtBQUNIOztBQVlELGVBQWFVLE9BQWIsQ0FBcUJsRixJQUFyQixFQUEyQm1GLGFBQTNCLEVBQTBDaEQsV0FBMUMsRUFBdUQ7QUFDbkQsUUFBSWlELFVBQVUsR0FBR0QsYUFBakI7O0FBRUEsUUFBSSxDQUFDQSxhQUFMLEVBQW9CO0FBQ2hCQSxNQUFBQSxhQUFhLEdBQUcsRUFBaEI7QUFDSDs7QUFFRCxRQUFJLENBQUVFLEdBQUYsRUFBTzNDLFlBQVAsSUFBd0IsS0FBSzRDLG9CQUFMLENBQTBCdEYsSUFBMUIsRUFBZ0MsSUFBaEMsQ0FBNUI7O0FBRUEsUUFBSTBCLE9BQU8sR0FBRztBQUNWMkQsTUFBQUEsR0FEVTtBQUVWRCxNQUFBQSxVQUZVO0FBR1Z4RCxNQUFBQSxPQUFPLEVBQUV1RCxhQUhDO0FBSVZoRCxNQUFBQTtBQUpVLEtBQWQ7O0FBT0EsUUFBSSxFQUFFLE1BQU0sS0FBS29ELGFBQUwsQ0FBbUI3RCxPQUFuQixDQUFSLENBQUosRUFBMEM7QUFDdEMsYUFBT0EsT0FBTyxDQUFDOEQsTUFBZjtBQUNIOztBQUVELFFBQUlDLE9BQU8sR0FBRyxNQUFNLEtBQUs3QixhQUFMLENBQW1CLE1BQU9sQyxPQUFQLElBQW1CO0FBQ3RELFVBQUlnRSxnQkFBZ0IsR0FBRyxDQUFDbEksQ0FBQyxDQUFDb0YsT0FBRixDQUFVRixZQUFWLENBQXhCOztBQUNBLFVBQUlnRCxnQkFBSixFQUFzQjtBQUNsQixjQUFNLEtBQUt4RCxrQkFBTCxDQUF3QlIsT0FBeEIsQ0FBTjtBQUVBLGNBQU0sQ0FBRWlFLFFBQUYsRUFBWUMsYUFBWixJQUE4QixNQUFNLEtBQUtDLGNBQUwsQ0FBb0JuRSxPQUFwQixFQUE2QmdCLFlBQTdCLEVBQTJDLElBQTNDLENBQTFDOztBQUVBbEYsUUFBQUEsQ0FBQyxDQUFDc0ksTUFBRixDQUFTSCxRQUFULEVBQW1CLENBQUNJLGFBQUQsRUFBZ0JDLFVBQWhCLEtBQStCO0FBQzlDWCxVQUFBQSxHQUFHLENBQUNXLFVBQUQsQ0FBSCxHQUFrQkQsYUFBbEI7QUFDSCxTQUZEOztBQUlBckQsUUFBQUEsWUFBWSxHQUFHa0QsYUFBZjtBQUNBRixRQUFBQSxnQkFBZ0IsR0FBRyxDQUFDbEksQ0FBQyxDQUFDb0YsT0FBRixDQUFVRixZQUFWLENBQXBCO0FBQ0g7O0FBRUQsWUFBTSxLQUFLdUQsbUJBQUwsQ0FBeUJ2RSxPQUF6QixDQUFOOztBQUVBLFVBQUksRUFBRSxNQUFNdkQsUUFBUSxDQUFDdUYsV0FBVCxDQUFxQnRGLEtBQUssQ0FBQzhILGtCQUEzQixFQUErQyxJQUEvQyxFQUFxRHhFLE9BQXJELENBQVIsQ0FBSixFQUE0RTtBQUN4RSxlQUFPLEtBQVA7QUFDSDs7QUFFRCxVQUFJLEVBQUUsTUFBTSxLQUFLeUUsc0JBQUwsQ0FBNEJ6RSxPQUE1QixDQUFSLENBQUosRUFBbUQ7QUFDL0MsZUFBTyxLQUFQO0FBQ0g7O0FBR0dBLE1BQUFBLE9BQU8sQ0FBQzBFLE1BQVIsR0FBaUJ2RyxNQUFNLENBQUN3RyxNQUFQLENBQWMzRSxPQUFPLENBQUMwRSxNQUF0QixDQUFqQjs7QUFHSixVQUFJMUUsT0FBTyxDQUFDRSxPQUFSLENBQWdCMEUsT0FBcEIsRUFBNkI7QUFDekI1RSxRQUFBQSxPQUFPLENBQUM0QyxNQUFSLEdBQWlCLE1BQU0sS0FBS2pDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQmlFLFVBQWxCLENBQ25CLEtBQUt0RyxJQUFMLENBQVVHLElBRFMsRUFFbkJzQixPQUFPLENBQUMwRSxNQUZXLEVBR25CLEtBQUs3RixzQkFBTCxDQUE0Qm1CLE9BQU8sQ0FBQzBFLE1BQXBDLENBSG1CLEVBSW5CMUUsT0FBTyxDQUFDUyxXQUpXLEVBS25CVCxPQUFPLENBQUNFLE9BQVIsQ0FBZ0IwRSxPQUxHLENBQXZCO0FBT0gsT0FSRCxNQVFPO0FBQ0g1RSxRQUFBQSxPQUFPLENBQUM0QyxNQUFSLEdBQWlCLE1BQU0sS0FBS2pDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQjRDLE9BQWxCLENBQ25CLEtBQUtqRixJQUFMLENBQVVHLElBRFMsRUFFbkJzQixPQUFPLENBQUMwRSxNQUZXLEVBR25CMUUsT0FBTyxDQUFDUyxXQUhXLENBQXZCO0FBS0g7O0FBRURULE1BQUFBLE9BQU8sQ0FBQzhELE1BQVIsR0FBaUI5RCxPQUFPLENBQUMwRSxNQUF6QjtBQUVBLFlBQU0sS0FBS0kscUJBQUwsQ0FBMkI5RSxPQUEzQixDQUFOOztBQUVBLFVBQUksQ0FBQ0EsT0FBTyxDQUFDK0UsUUFBYixFQUF1QjtBQUNuQi9FLFFBQUFBLE9BQU8sQ0FBQytFLFFBQVIsR0FBbUIsS0FBSzdGLDBCQUFMLENBQWdDYyxPQUFPLENBQUMwRSxNQUF4QyxDQUFuQjtBQUNIOztBQUVELFlBQU1qSSxRQUFRLENBQUN1RixXQUFULENBQXFCdEYsS0FBSyxDQUFDc0ksaUJBQTNCLEVBQThDLElBQTlDLEVBQW9EaEYsT0FBcEQsQ0FBTjs7QUFFQSxVQUFJZ0UsZ0JBQUosRUFBc0I7QUFDbEIsY0FBTSxLQUFLRyxjQUFMLENBQW9CbkUsT0FBcEIsRUFBNkJnQixZQUE3QixDQUFOO0FBQ0g7O0FBRUQsYUFBTyxJQUFQO0FBQ0gsS0E1RG1CLEVBNERqQmhCLE9BNURpQixDQUFwQjs7QUE4REEsUUFBSStELE9BQUosRUFBYTtBQUNULFlBQU0sS0FBS2tCLFlBQUwsQ0FBa0JqRixPQUFsQixDQUFOO0FBQ0g7O0FBRUQsV0FBT0EsT0FBTyxDQUFDOEQsTUFBZjtBQUNIOztBQVlELGVBQWFvQixVQUFiLENBQXdCNUcsSUFBeEIsRUFBOEI2RyxhQUE5QixFQUE2QzFFLFdBQTdDLEVBQTBEO0FBQ3RELFFBQUkwRSxhQUFhLElBQUlBLGFBQWEsQ0FBQ0MsZUFBbkMsRUFBb0Q7QUFDaEQsWUFBTSxJQUFJNUksZUFBSixDQUFvQixtQkFBcEIsRUFBeUM7QUFDM0NtRyxRQUFBQSxNQUFNLEVBQUUsS0FBS3BFLElBQUwsQ0FBVUcsSUFEeUI7QUFFM0MyRyxRQUFBQSxNQUFNLEVBQUUsMkVBRm1DO0FBRzNDRixRQUFBQTtBQUgyQyxPQUF6QyxDQUFOO0FBS0g7O0FBRUQsV0FBTyxLQUFLRyxRQUFMLENBQWNoSCxJQUFkLEVBQW9CNkcsYUFBcEIsRUFBbUMxRSxXQUFuQyxFQUFnRCxJQUFoRCxDQUFQO0FBQ0g7O0FBUUQsZUFBYThFLFdBQWIsQ0FBeUJqSCxJQUF6QixFQUErQjZHLGFBQS9CLEVBQThDMUUsV0FBOUMsRUFBMkQ7QUFDdkQsUUFBSTBFLGFBQWEsSUFBSUEsYUFBYSxDQUFDQyxlQUFuQyxFQUFvRDtBQUNoRCxZQUFNLElBQUk1SSxlQUFKLENBQW9CLG1CQUFwQixFQUF5QztBQUMzQ21HLFFBQUFBLE1BQU0sRUFBRSxLQUFLcEUsSUFBTCxDQUFVRyxJQUR5QjtBQUUzQzJHLFFBQUFBLE1BQU0sRUFBRSwyRUFGbUM7QUFHM0NGLFFBQUFBO0FBSDJDLE9BQXpDLENBQU47QUFLSDs7QUFFRCxXQUFPLEtBQUtHLFFBQUwsQ0FBY2hILElBQWQsRUFBb0I2RyxhQUFwQixFQUFtQzFFLFdBQW5DLEVBQWdELEtBQWhELENBQVA7QUFDSDs7QUFFRCxlQUFhNkUsUUFBYixDQUFzQmhILElBQXRCLEVBQTRCNkcsYUFBNUIsRUFBMkMxRSxXQUEzQyxFQUF3RCtFLGVBQXhELEVBQXlFO0FBQ3JFLFFBQUk5QixVQUFVLEdBQUd5QixhQUFqQjs7QUFFQSxRQUFJLENBQUNBLGFBQUwsRUFBb0I7QUFFaEIsVUFBSU0sZUFBZSxHQUFHLEtBQUs1RyxzQkFBTCxDQUE0QlAsSUFBNUIsQ0FBdEI7O0FBQ0EsVUFBSXhDLENBQUMsQ0FBQ29GLE9BQUYsQ0FBVXVFLGVBQVYsQ0FBSixFQUFnQztBQUM1QixjQUFNLElBQUlqSixlQUFKLENBQ0YsdUdBREUsRUFDdUc7QUFDckdtRyxVQUFBQSxNQUFNLEVBQUUsS0FBS3BFLElBQUwsQ0FBVUcsSUFEbUY7QUFFckdKLFVBQUFBO0FBRnFHLFNBRHZHLENBQU47QUFNSDs7QUFDRDZHLE1BQUFBLGFBQWEsR0FBRztBQUFFTyxRQUFBQSxNQUFNLEVBQUU1SixDQUFDLENBQUNzRCxJQUFGLENBQU9kLElBQVAsRUFBYW1ILGVBQWI7QUFBVixPQUFoQjtBQUNBbkgsTUFBQUEsSUFBSSxHQUFHeEMsQ0FBQyxDQUFDOEMsSUFBRixDQUFPTixJQUFQLEVBQWFtSCxlQUFiLENBQVA7QUFDSDs7QUFHRCxRQUFJLENBQUU5QixHQUFGLEVBQU8zQyxZQUFQLElBQXdCLEtBQUs0QyxvQkFBTCxDQUEwQnRGLElBQTFCLENBQTVCOztBQUVBLFFBQUkwQixPQUFPLEdBQUc7QUFDVjJELE1BQUFBLEdBRFU7QUFFVkQsTUFBQUEsVUFGVTtBQUdWeEQsTUFBQUEsT0FBTyxFQUFFLEtBQUs2QixlQUFMLENBQXFCb0QsYUFBckIsRUFBb0NLLGVBQXBDLENBSEM7QUFJVi9FLE1BQUFBLFdBSlU7QUFLVitFLE1BQUFBO0FBTFUsS0FBZDtBQVNBLFFBQUlHLFFBQUo7O0FBRUEsUUFBSUgsZUFBSixFQUFxQjtBQUNqQkcsTUFBQUEsUUFBUSxHQUFHLE1BQU0sS0FBS0MsYUFBTCxDQUFtQjVGLE9BQW5CLENBQWpCO0FBQ0gsS0FGRCxNQUVPO0FBQ0gyRixNQUFBQSxRQUFRLEdBQUcsTUFBTSxLQUFLRSxpQkFBTCxDQUF1QjdGLE9BQXZCLENBQWpCO0FBQ0g7O0FBRUQsUUFBSSxDQUFDMkYsUUFBTCxFQUFlO0FBQ1gsYUFBTzNGLE9BQU8sQ0FBQzhELE1BQWY7QUFDSDs7QUFFRCxRQUFJQyxPQUFPLEdBQUcsTUFBTSxLQUFLN0IsYUFBTCxDQUFtQixNQUFPbEMsT0FBUCxJQUFtQjtBQUN0RCxVQUFJOEYsZ0JBQWdCLEdBQUcsQ0FBQ2hLLENBQUMsQ0FBQ29GLE9BQUYsQ0FBVUYsWUFBVixDQUF4QjtBQUNBLFVBQUkrRSxnQkFBSjs7QUFFQSxVQUFJRCxnQkFBSixFQUFzQjtBQUNsQixjQUFNLEtBQUt0RixrQkFBTCxDQUF3QlIsT0FBeEIsQ0FBTjtBQUVBZ0IsUUFBQUEsWUFBWSxHQUFHLE1BQU0sS0FBS2dGLGNBQUwsQ0FBb0JoRyxPQUFwQixFQUE2QmdCLFlBQTdCLEVBQTJDLElBQTNDLEVBQXFFd0UsZUFBckUsQ0FBckI7QUFDQU0sUUFBQUEsZ0JBQWdCLEdBQUcsQ0FBQ2hLLENBQUMsQ0FBQ29GLE9BQUYsQ0FBVUYsWUFBVixDQUFwQjtBQUNBK0UsUUFBQUEsZ0JBQWdCLEdBQUcsSUFBbkI7QUFDSDs7QUFFRCxZQUFNLEtBQUt4QixtQkFBTCxDQUF5QnZFLE9BQXpCLEVBQWtDLElBQWxDLEVBQTBEd0YsZUFBMUQsQ0FBTjs7QUFFQSxVQUFJLEVBQUUsTUFBTS9JLFFBQVEsQ0FBQ3VGLFdBQVQsQ0FBcUJ0RixLQUFLLENBQUN1SixrQkFBM0IsRUFBK0MsSUFBL0MsRUFBcURqRyxPQUFyRCxDQUFSLENBQUosRUFBNEU7QUFDeEUsZUFBTyxLQUFQO0FBQ0g7O0FBRUQsVUFBSXdGLGVBQUosRUFBcUI7QUFDakJHLFFBQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUtPLHNCQUFMLENBQTRCbEcsT0FBNUIsQ0FBakI7QUFDSCxPQUZELE1BRU87QUFDSDJGLFFBQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUtRLDBCQUFMLENBQWdDbkcsT0FBaEMsQ0FBakI7QUFDSDs7QUFFRCxVQUFJLENBQUMyRixRQUFMLEVBQWU7QUFDWCxlQUFPLEtBQVA7QUFDSDs7QUFFRCxVQUFJN0osQ0FBQyxDQUFDb0YsT0FBRixDQUFVbEIsT0FBTyxDQUFDMEUsTUFBbEIsQ0FBSixFQUErQjtBQUMzQixZQUFJLENBQUNxQixnQkFBRCxJQUFxQixDQUFDRCxnQkFBMUIsRUFBNEM7QUFDeEMsZ0JBQU0sSUFBSXRKLGVBQUosQ0FBb0IscURBQXFELEtBQUsrQixJQUFMLENBQVVHLElBQW5GLENBQU47QUFDSDtBQUNKLE9BSkQsTUFJTztBQUVDc0IsUUFBQUEsT0FBTyxDQUFDMEUsTUFBUixHQUFpQnZHLE1BQU0sQ0FBQ3dHLE1BQVAsQ0FBYzNFLE9BQU8sQ0FBQzBFLE1BQXRCLENBQWpCO0FBR0osY0FBTTtBQUFFZ0IsVUFBQUEsTUFBRjtBQUFVLGFBQUdVO0FBQWIsWUFBOEJwRyxPQUFPLENBQUNFLE9BQTVDOztBQUVBLFlBQUk0RixnQkFBZ0IsSUFBSSxDQUFDbEosVUFBVSxDQUFDLENBQUM4SSxNQUFELEVBQVMxRixPQUFPLENBQUMwRSxNQUFqQixDQUFELEVBQTJCLEtBQUtuRyxJQUFMLENBQVVDLFFBQXJDLENBQS9CLElBQWlGLENBQUM0SCxZQUFZLENBQUMvRixnQkFBbkcsRUFBcUg7QUFHakgrRixVQUFBQSxZQUFZLENBQUMvRixnQkFBYixHQUFnQyxJQUFoQztBQUNIOztBQUVETCxRQUFBQSxPQUFPLENBQUM0QyxNQUFSLEdBQWlCLE1BQU0sS0FBS2pDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQnlGLE9BQWxCLENBQ25CLEtBQUs5SCxJQUFMLENBQVVHLElBRFMsRUFFbkJzQixPQUFPLENBQUMwRSxNQUZXLEVBR25CZ0IsTUFIbUIsRUFJbkJVLFlBSm1CLEVBS25CcEcsT0FBTyxDQUFDUyxXQUxXLENBQXZCO0FBUUFULFFBQUFBLE9BQU8sQ0FBQzhELE1BQVIsR0FBaUI5RCxPQUFPLENBQUMwRSxNQUF6Qjs7QUFFQSxZQUFJYyxlQUFKLEVBQXFCO0FBQ2pCLGdCQUFNLEtBQUtjLHFCQUFMLENBQTJCdEcsT0FBM0IsQ0FBTjs7QUFFQSxjQUFJLENBQUNBLE9BQU8sQ0FBQytFLFFBQWIsRUFBdUI7QUFDbkIvRSxZQUFBQSxPQUFPLENBQUMrRSxRQUFSLEdBQW1CLEtBQUs3RiwwQkFBTCxDQUFnQ3dHLE1BQWhDLENBQW5CO0FBQ0g7QUFDSixTQU5ELE1BTU87QUFDSCxnQkFBTSxLQUFLYSx5QkFBTCxDQUErQnZHLE9BQS9CLENBQU47QUFDSDs7QUFFRCxjQUFNdkQsUUFBUSxDQUFDdUYsV0FBVCxDQUFxQnRGLEtBQUssQ0FBQzhKLGlCQUEzQixFQUE4QyxJQUE5QyxFQUFvRHhHLE9BQXBELENBQU47QUFDSDs7QUFFRCxVQUFJOEYsZ0JBQUosRUFBc0I7QUFDbEIsY0FBTSxLQUFLRSxjQUFMLENBQW9CaEcsT0FBcEIsRUFBNkJnQixZQUE3QixFQUEyQyxLQUEzQyxFQUFrRHdFLGVBQWxELENBQU47QUFDSDs7QUFFRCxhQUFPLElBQVA7QUFDSCxLQXpFbUIsRUF5RWpCeEYsT0F6RWlCLENBQXBCOztBQTJFQSxRQUFJK0QsT0FBSixFQUFhO0FBQ1QsVUFBSXlCLGVBQUosRUFBcUI7QUFDakIsY0FBTSxLQUFLaUIsWUFBTCxDQUFrQnpHLE9BQWxCLENBQU47QUFDSCxPQUZELE1BRU87QUFDSCxjQUFNLEtBQUswRyxnQkFBTCxDQUFzQjFHLE9BQXRCLENBQU47QUFDSDtBQUNKOztBQUVELFdBQU9BLE9BQU8sQ0FBQzhELE1BQWY7QUFDSDs7QUFRRCxlQUFhNkMsV0FBYixDQUF5QnJJLElBQXpCLEVBQStCNkcsYUFBL0IsRUFBOEMxRSxXQUE5QyxFQUEyRDtBQUN2RCxRQUFJaUQsVUFBVSxHQUFHeUIsYUFBakI7O0FBRUEsUUFBSSxDQUFDQSxhQUFMLEVBQW9CO0FBQ2hCLFVBQUlNLGVBQWUsR0FBRyxLQUFLNUcsc0JBQUwsQ0FBNEJQLElBQTVCLENBQXRCOztBQUNBLFVBQUl4QyxDQUFDLENBQUNvRixPQUFGLENBQVV1RSxlQUFWLENBQUosRUFBZ0M7QUFDNUIsY0FBTSxJQUFJakosZUFBSixDQUNGLHdHQURFLEVBQ3dHO0FBQ3RHbUcsVUFBQUEsTUFBTSxFQUFFLEtBQUtwRSxJQUFMLENBQVVHLElBRG9GO0FBRXRHSixVQUFBQTtBQUZzRyxTQUR4RyxDQUFOO0FBS0g7O0FBRUQ2RyxNQUFBQSxhQUFhLEdBQUcsRUFBRSxHQUFHQSxhQUFMO0FBQW9CTyxRQUFBQSxNQUFNLEVBQUU1SixDQUFDLENBQUNzRCxJQUFGLENBQU9kLElBQVAsRUFBYW1ILGVBQWI7QUFBNUIsT0FBaEI7QUFDSCxLQVhELE1BV087QUFDSE4sTUFBQUEsYUFBYSxHQUFHLEtBQUtwRCxlQUFMLENBQXFCb0QsYUFBckIsRUFBb0MsSUFBcEMsQ0FBaEI7QUFDSDs7QUFFRCxRQUFJbkYsT0FBTyxHQUFHO0FBQ1YyRCxNQUFBQSxHQUFHLEVBQUVyRixJQURLO0FBRVZvRixNQUFBQSxVQUZVO0FBR1Z4RCxNQUFBQSxPQUFPLEVBQUVpRixhQUhDO0FBSVYxRSxNQUFBQTtBQUpVLEtBQWQ7QUFPQSxXQUFPLEtBQUt5QixhQUFMLENBQW1CLE1BQU9sQyxPQUFQLElBQW1CO0FBQ3pDLGFBQU8sS0FBSzRHLGNBQUwsQ0FBb0I1RyxPQUFwQixDQUFQO0FBQ0gsS0FGTSxFQUVKQSxPQUZJLENBQVA7QUFHSDs7QUFXRCxlQUFhNkcsVUFBYixDQUF3QkMsYUFBeEIsRUFBdUNyRyxXQUF2QyxFQUFvRDtBQUNoRCxXQUFPLEtBQUtzRyxRQUFMLENBQWNELGFBQWQsRUFBNkJyRyxXQUE3QixFQUEwQyxJQUExQyxDQUFQO0FBQ0g7O0FBWUQsZUFBYXVHLFdBQWIsQ0FBeUJGLGFBQXpCLEVBQXdDckcsV0FBeEMsRUFBcUQ7QUFDakQsV0FBTyxLQUFLc0csUUFBTCxDQUFjRCxhQUFkLEVBQTZCckcsV0FBN0IsRUFBMEMsS0FBMUMsQ0FBUDtBQUNIOztBQUVELGVBQWF3RyxVQUFiLENBQXdCeEcsV0FBeEIsRUFBcUM7QUFDakMsV0FBTyxLQUFLdUcsV0FBTCxDQUFpQjtBQUFFRSxNQUFBQSxVQUFVLEVBQUU7QUFBZCxLQUFqQixFQUF1Q3pHLFdBQXZDLENBQVA7QUFDSDs7QUFXRCxlQUFhc0csUUFBYixDQUFzQkQsYUFBdEIsRUFBcUNyRyxXQUFyQyxFQUFrRCtFLGVBQWxELEVBQW1FO0FBQy9ELFFBQUk5QixVQUFVLEdBQUdvRCxhQUFqQjtBQUVBQSxJQUFBQSxhQUFhLEdBQUcsS0FBSy9FLGVBQUwsQ0FBcUIrRSxhQUFyQixFQUFvQ3RCLGVBQXBDLENBQWhCOztBQUVBLFFBQUkxSixDQUFDLENBQUNvRixPQUFGLENBQVU0RixhQUFhLENBQUNwQixNQUF4QixNQUFvQ0YsZUFBZSxJQUFJLENBQUNzQixhQUFhLENBQUNJLFVBQXRFLENBQUosRUFBdUY7QUFDbkYsWUFBTSxJQUFJMUssZUFBSixDQUFvQix3REFBcEIsRUFBOEU7QUFDaEZtRyxRQUFBQSxNQUFNLEVBQUUsS0FBS3BFLElBQUwsQ0FBVUcsSUFEOEQ7QUFFaEZvSSxRQUFBQTtBQUZnRixPQUE5RSxDQUFOO0FBSUg7O0FBRUQsUUFBSTlHLE9BQU8sR0FBRztBQUNWMEQsTUFBQUEsVUFEVTtBQUVWeEQsTUFBQUEsT0FBTyxFQUFFNEcsYUFGQztBQUdWckcsTUFBQUEsV0FIVTtBQUlWK0UsTUFBQUE7QUFKVSxLQUFkO0FBT0EsUUFBSTJCLFFBQUo7O0FBRUEsUUFBSTNCLGVBQUosRUFBcUI7QUFDakIyQixNQUFBQSxRQUFRLEdBQUcsTUFBTSxLQUFLQyxhQUFMLENBQW1CcEgsT0FBbkIsQ0FBakI7QUFDSCxLQUZELE1BRU87QUFDSG1ILE1BQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUtFLGlCQUFMLENBQXVCckgsT0FBdkIsQ0FBakI7QUFDSDs7QUFFRCxRQUFJLENBQUNtSCxRQUFMLEVBQWU7QUFDWCxhQUFPbkgsT0FBTyxDQUFDOEQsTUFBZjtBQUNIOztBQUVELFFBQUl3RCxZQUFZLEdBQUcsTUFBTSxLQUFLcEYsYUFBTCxDQUFtQixNQUFPbEMsT0FBUCxJQUFtQjtBQUMzRCxVQUFJLEVBQUUsTUFBTXZELFFBQVEsQ0FBQ3VGLFdBQVQsQ0FBcUJ0RixLQUFLLENBQUM2SyxrQkFBM0IsRUFBK0MsSUFBL0MsRUFBcUR2SCxPQUFyRCxDQUFSLENBQUosRUFBNEU7QUFDeEUsZUFBTyxLQUFQO0FBQ0g7O0FBRUQsVUFBSXdGLGVBQUosRUFBcUI7QUFDakIyQixRQUFBQSxRQUFRLEdBQUcsTUFBTSxLQUFLSyxzQkFBTCxDQUE0QnhILE9BQTVCLENBQWpCO0FBQ0gsT0FGRCxNQUVPO0FBQ0htSCxRQUFBQSxRQUFRLEdBQUcsTUFBTSxLQUFLTSwwQkFBTCxDQUFnQ3pILE9BQWhDLENBQWpCO0FBQ0g7O0FBRUQsVUFBSSxDQUFDbUgsUUFBTCxFQUFlO0FBQ1gsZUFBTyxLQUFQO0FBQ0g7O0FBRUQsWUFBTTtBQUFFekIsUUFBQUEsTUFBRjtBQUFVLFdBQUdVO0FBQWIsVUFBOEJwRyxPQUFPLENBQUNFLE9BQTVDO0FBRUFGLE1BQUFBLE9BQU8sQ0FBQzRDLE1BQVIsR0FBaUIsTUFBTSxLQUFLakMsRUFBTCxDQUFRQyxTQUFSLENBQWtCOEcsT0FBbEIsQ0FDbkIsS0FBS25KLElBQUwsQ0FBVUcsSUFEUyxFQUVuQmdILE1BRm1CLEVBR25CVSxZQUhtQixFQUluQnBHLE9BQU8sQ0FBQ1MsV0FKVyxDQUF2Qjs7QUFPQSxVQUFJK0UsZUFBSixFQUFxQjtBQUNqQixjQUFNLEtBQUttQyxxQkFBTCxDQUEyQjNILE9BQTNCLENBQU47QUFDSCxPQUZELE1BRU87QUFDSCxjQUFNLEtBQUs0SCx5QkFBTCxDQUErQjVILE9BQS9CLENBQU47QUFDSDs7QUFFRCxVQUFJLENBQUNBLE9BQU8sQ0FBQytFLFFBQWIsRUFBdUI7QUFDbkIsWUFBSVMsZUFBSixFQUFxQjtBQUNqQnhGLFVBQUFBLE9BQU8sQ0FBQytFLFFBQVIsR0FBbUIsS0FBSzdGLDBCQUFMLENBQWdDYyxPQUFPLENBQUNFLE9BQVIsQ0FBZ0J3RixNQUFoRCxDQUFuQjtBQUNILFNBRkQsTUFFTztBQUNIMUYsVUFBQUEsT0FBTyxDQUFDK0UsUUFBUixHQUFtQi9FLE9BQU8sQ0FBQ0UsT0FBUixDQUFnQndGLE1BQW5DO0FBQ0g7QUFDSjs7QUFFRCxZQUFNakosUUFBUSxDQUFDdUYsV0FBVCxDQUFxQnRGLEtBQUssQ0FBQ21MLGlCQUEzQixFQUE4QyxJQUE5QyxFQUFvRDdILE9BQXBELENBQU47QUFFQSxhQUFPLEtBQUtXLEVBQUwsQ0FBUUMsU0FBUixDQUFrQjBHLFlBQWxCLENBQStCdEgsT0FBL0IsQ0FBUDtBQUNILEtBekN3QixFQXlDdEJBLE9BekNzQixDQUF6Qjs7QUEyQ0EsUUFBSXNILFlBQUosRUFBa0I7QUFDZCxVQUFJOUIsZUFBSixFQUFxQjtBQUNqQixjQUFNLEtBQUtzQyxZQUFMLENBQWtCOUgsT0FBbEIsQ0FBTjtBQUNILE9BRkQsTUFFTztBQUNILGNBQU0sS0FBSytILGdCQUFMLENBQXNCL0gsT0FBdEIsQ0FBTjtBQUNIO0FBQ0o7O0FBRUQsV0FBT0EsT0FBTyxDQUFDOEQsTUFBUixJQUFrQndELFlBQXpCO0FBQ0g7O0FBTUQsU0FBT1Usa0JBQVAsQ0FBMEIxSixJQUExQixFQUFnQztBQUM1QixRQUFJMkosY0FBYyxHQUFHLEtBQXJCOztBQUVBLFFBQUlDLGFBQWEsR0FBR3BNLENBQUMsQ0FBQzRCLElBQUYsQ0FBTyxLQUFLYSxJQUFMLENBQVVPLFVBQWpCLEVBQTZCSCxNQUFNLElBQUk7QUFDdkQsVUFBSXdKLE9BQU8sR0FBR3JNLENBQUMsQ0FBQ2lELEtBQUYsQ0FBUUosTUFBUixFQUFnQkssQ0FBQyxJQUFJQSxDQUFDLElBQUlWLElBQTFCLENBQWQ7O0FBQ0EySixNQUFBQSxjQUFjLEdBQUdBLGNBQWMsSUFBSUUsT0FBbkM7QUFFQSxhQUFPck0sQ0FBQyxDQUFDaUQsS0FBRixDQUFRSixNQUFSLEVBQWdCSyxDQUFDLElBQUksQ0FBQ2xELENBQUMsQ0FBQ21ELEtBQUYsQ0FBUVgsSUFBSSxDQUFDVSxDQUFELENBQVosQ0FBdEIsQ0FBUDtBQUNILEtBTG1CLENBQXBCOztBQU9BLFdBQU8sQ0FBRWtKLGFBQUYsRUFBaUJELGNBQWpCLENBQVA7QUFDSDs7QUFNRCxTQUFPRyx3QkFBUCxDQUFnQ0MsU0FBaEMsRUFBMkM7QUFDdkMsUUFBSSxDQUFFQyx5QkFBRixFQUE2QkMscUJBQTdCLElBQXVELEtBQUtQLGtCQUFMLENBQXdCSyxTQUF4QixDQUEzRDs7QUFFQSxRQUFJLENBQUNDLHlCQUFMLEVBQWdDO0FBQzVCLFVBQUlDLHFCQUFKLEVBQTJCO0FBQ3ZCLGNBQU0sSUFBSWpNLGVBQUosQ0FBb0Isd0VBQXdFa00sSUFBSSxDQUFDQyxTQUFMLENBQWVKLFNBQWYsQ0FBNUYsQ0FBTjtBQUNIOztBQUVELFlBQU0sSUFBSTdMLGVBQUosQ0FBb0IsNkZBQXBCLEVBQW1IO0FBQ2pIbUcsUUFBQUEsTUFBTSxFQUFFLEtBQUtwRSxJQUFMLENBQVVHLElBRCtGO0FBRWpIMkosUUFBQUE7QUFGaUgsT0FBbkgsQ0FBTjtBQUtIO0FBQ0o7O0FBU0QsZUFBYTlELG1CQUFiLENBQWlDdkUsT0FBakMsRUFBMEMwSSxVQUFVLEdBQUcsS0FBdkQsRUFBOERsRCxlQUFlLEdBQUcsSUFBaEYsRUFBc0Y7QUFDbEYsUUFBSWpILElBQUksR0FBRyxLQUFLQSxJQUFoQjtBQUNBLFFBQUlvSyxJQUFJLEdBQUcsS0FBS0EsSUFBaEI7QUFDQSxRQUFJO0FBQUVqSyxNQUFBQSxJQUFGO0FBQVFDLE1BQUFBO0FBQVIsUUFBbUJKLElBQXZCO0FBRUEsUUFBSTtBQUFFb0YsTUFBQUE7QUFBRixRQUFVM0QsT0FBZDtBQUNBLFFBQUkwRSxNQUFNLEdBQUcsRUFBYjtBQUFBLFFBQWlCa0UsUUFBUSxHQUFHNUksT0FBTyxDQUFDRSxPQUFSLENBQWdCMkksU0FBNUM7QUFDQTdJLElBQUFBLE9BQU8sQ0FBQzBFLE1BQVIsR0FBaUJBLE1BQWpCOztBQUVBLFFBQUksQ0FBQzFFLE9BQU8sQ0FBQzJJLElBQWIsRUFBbUI7QUFDZjNJLE1BQUFBLE9BQU8sQ0FBQzJJLElBQVIsR0FBZUEsSUFBZjtBQUNIOztBQUVELFFBQUlHLFNBQVMsR0FBRzlJLE9BQU8sQ0FBQ0UsT0FBeEI7O0FBRUEsUUFBSXdJLFVBQVUsSUFBSTVNLENBQUMsQ0FBQ29GLE9BQUYsQ0FBVTBILFFBQVYsQ0FBZCxLQUFzQyxLQUFLRyxzQkFBTCxDQUE0QnBGLEdBQTVCLEtBQW9DbUYsU0FBUyxDQUFDRSxpQkFBcEYsQ0FBSixFQUE0RztBQUN4RyxZQUFNLEtBQUt4SSxrQkFBTCxDQUF3QlIsT0FBeEIsQ0FBTjs7QUFFQSxVQUFJd0YsZUFBSixFQUFxQjtBQUNqQm9ELFFBQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUsvRyxRQUFMLENBQWM7QUFBRTZELFVBQUFBLE1BQU0sRUFBRW9ELFNBQVMsQ0FBQ3BEO0FBQXBCLFNBQWQsRUFBNEMxRixPQUFPLENBQUNTLFdBQXBELENBQWpCO0FBQ0gsT0FGRCxNQUVPO0FBQ0htSSxRQUFBQSxRQUFRLEdBQUcsTUFBTSxLQUFLdEgsUUFBTCxDQUFjO0FBQUVvRSxVQUFBQSxNQUFNLEVBQUVvRCxTQUFTLENBQUNwRDtBQUFwQixTQUFkLEVBQTRDMUYsT0FBTyxDQUFDUyxXQUFwRCxDQUFqQjtBQUNIOztBQUNEVCxNQUFBQSxPQUFPLENBQUM0SSxRQUFSLEdBQW1CQSxRQUFuQjtBQUNIOztBQUVELFFBQUlFLFNBQVMsQ0FBQ0UsaUJBQVYsSUFBK0IsQ0FBQ2hKLE9BQU8sQ0FBQzBELFVBQVIsQ0FBbUJtRixTQUF2RCxFQUFrRTtBQUM5RDdJLE1BQUFBLE9BQU8sQ0FBQzBELFVBQVIsQ0FBbUJtRixTQUFuQixHQUErQkQsUUFBL0I7QUFDSDs7QUFFRCxVQUFNN00sVUFBVSxDQUFDNEMsTUFBRCxFQUFTLE9BQU9zSyxTQUFQLEVBQWtCQyxTQUFsQixLQUFnQztBQUNyRCxVQUFJQSxTQUFTLElBQUl2RixHQUFqQixFQUFzQjtBQUNsQixZQUFJd0YsS0FBSyxHQUFHeEYsR0FBRyxDQUFDdUYsU0FBRCxDQUFmOztBQUdBLFlBQUlELFNBQVMsQ0FBQ0csUUFBZCxFQUF3QjtBQUNwQixjQUFJLENBQUNOLFNBQVMsQ0FBQ08sVUFBWCxLQUEwQixDQUFDWCxVQUFELElBQWMsQ0FBQ0ksU0FBUyxDQUFDMUQsZUFBekIsSUFBNEMsQ0FBQzBELFNBQVMsQ0FBQzFELGVBQVYsQ0FBMEJrRSxHQUExQixDQUE4QkosU0FBOUIsQ0FBdkUsQ0FBSixFQUFzSDtBQUVsSCxrQkFBTSxJQUFJNU0sZUFBSixDQUFxQixvQkFBbUI0TSxTQUFVLDZDQUFsRCxFQUFnRztBQUNsR3ZHLGNBQUFBLE1BQU0sRUFBRWpFLElBRDBGO0FBRWxHdUssY0FBQUEsU0FBUyxFQUFFQTtBQUZ1RixhQUFoRyxDQUFOO0FBSUg7QUFDSjs7QUFFRCxZQUFJUCxVQUFVLElBQUlPLFNBQVMsQ0FBQ00scUJBQTVCLEVBQW1EO0FBQUEsZUFDdkNYLFFBRHVDO0FBQUEsNEJBQzdCLDJEQUQ2QjtBQUFBOztBQUcvQyxjQUFJQSxRQUFRLENBQUNNLFNBQUQsQ0FBUixLQUF3QkQsU0FBUyxDQUFDTyxPQUF0QyxFQUErQztBQUUzQyxrQkFBTSxJQUFJbE4sZUFBSixDQUFxQixnQ0FBK0I0TSxTQUFVLGlDQUE5RCxFQUFnRztBQUNsR3ZHLGNBQUFBLE1BQU0sRUFBRWpFLElBRDBGO0FBRWxHdUssY0FBQUEsU0FBUyxFQUFFQTtBQUZ1RixhQUFoRyxDQUFOO0FBSUg7QUFDSjs7QUFjRCxZQUFJdE0sU0FBUyxDQUFDd00sS0FBRCxDQUFiLEVBQXNCO0FBQ2xCLGNBQUlGLFNBQVMsQ0FBQyxTQUFELENBQWIsRUFBMEI7QUFFdEJ2RSxZQUFBQSxNQUFNLENBQUN3RSxTQUFELENBQU4sR0FBb0JELFNBQVMsQ0FBQyxTQUFELENBQTdCO0FBQ0gsV0FIRCxNQUdPLElBQUksQ0FBQ0EsU0FBUyxDQUFDUSxRQUFmLEVBQXlCO0FBQzVCLGtCQUFNLElBQUluTixlQUFKLENBQXFCLFFBQU80TSxTQUFVLGVBQWN4SyxJQUFLLDBCQUF6RCxFQUFvRjtBQUN0RmlFLGNBQUFBLE1BQU0sRUFBRWpFLElBRDhFO0FBRXRGdUssY0FBQUEsU0FBUyxFQUFFQTtBQUYyRSxhQUFwRixDQUFOO0FBSUgsV0FMTSxNQUtBO0FBQ0h2RSxZQUFBQSxNQUFNLENBQUN3RSxTQUFELENBQU4sR0FBb0IsSUFBcEI7QUFDSDtBQUNKLFNBWkQsTUFZTztBQUNILGNBQUlwTixDQUFDLENBQUM0TixhQUFGLENBQWdCUCxLQUFoQixLQUEwQkEsS0FBSyxDQUFDUSxPQUFwQyxFQUE2QztBQUN6Q2pGLFlBQUFBLE1BQU0sQ0FBQ3dFLFNBQUQsQ0FBTixHQUFvQkMsS0FBcEI7QUFFQTtBQUNIOztBQUVELGNBQUk7QUFDQXpFLFlBQUFBLE1BQU0sQ0FBQ3dFLFNBQUQsQ0FBTixHQUFvQjdNLEtBQUssQ0FBQ3VOLFFBQU4sQ0FBZVQsS0FBZixFQUFzQkYsU0FBdEIsRUFBaUNOLElBQWpDLENBQXBCO0FBQ0gsV0FGRCxDQUVFLE9BQU9rQixLQUFQLEVBQWM7QUFDWixrQkFBTSxJQUFJdk4sZUFBSixDQUFxQixZQUFXNE0sU0FBVSxlQUFjeEssSUFBSyxXQUE3RCxFQUF5RTtBQUMzRWlFLGNBQUFBLE1BQU0sRUFBRWpFLElBRG1FO0FBRTNFdUssY0FBQUEsU0FBUyxFQUFFQSxTQUZnRTtBQUczRVksY0FBQUEsS0FBSyxFQUFFQSxLQUFLLENBQUNDLEtBSDhEO0FBSTNFWCxjQUFBQTtBQUoyRSxhQUF6RSxDQUFOO0FBTUg7QUFDSjs7QUFFRDtBQUNIOztBQUdELFVBQUlULFVBQUosRUFBZ0I7QUFDWixZQUFJTyxTQUFTLENBQUNjLFdBQWQsRUFBMkI7QUFFdkIsY0FBSWQsU0FBUyxDQUFDZSxVQUFWLElBQXdCZixTQUFTLENBQUNnQixZQUF0QyxFQUFvRDtBQUNoRDtBQUNIOztBQUdELGNBQUloQixTQUFTLENBQUNpQixJQUFkLEVBQW9CO0FBQ2hCeEYsWUFBQUEsTUFBTSxDQUFDd0UsU0FBRCxDQUFOLEdBQW9CLE1BQU0vTSxVQUFVLENBQUNxTixPQUFYLENBQW1CUCxTQUFuQixFQUE4Qk4sSUFBOUIsQ0FBMUI7QUFDQTtBQUNIOztBQUVELGdCQUFNLElBQUlyTSxlQUFKLENBQ0QsSUFBRzRNLFNBQVUsU0FBUXhLLElBQUssdUNBRHpCLEVBQ2lFO0FBQy9EaUUsWUFBQUEsTUFBTSxFQUFFakUsSUFEdUQ7QUFFL0R1SyxZQUFBQSxTQUFTLEVBQUVBO0FBRm9ELFdBRGpFLENBQU47QUFNSDs7QUFFRDtBQUNIOztBQUdELFVBQUksQ0FBQ0EsU0FBUyxDQUFDa0IsVUFBZixFQUEyQjtBQUN2QixZQUFJbEIsU0FBUyxDQUFDbUIsY0FBVixDQUF5QixTQUF6QixDQUFKLEVBQXlDO0FBRXJDMUYsVUFBQUEsTUFBTSxDQUFDd0UsU0FBRCxDQUFOLEdBQW9CRCxTQUFTLENBQUNPLE9BQTlCO0FBQ0gsU0FIRCxNQUdPLElBQUlQLFNBQVMsQ0FBQ1EsUUFBZCxFQUF3QjtBQUMzQjtBQUNILFNBRk0sTUFFQSxJQUFJUixTQUFTLENBQUNpQixJQUFkLEVBQW9CO0FBRXZCeEYsVUFBQUEsTUFBTSxDQUFDd0UsU0FBRCxDQUFOLEdBQW9CLE1BQU0vTSxVQUFVLENBQUNxTixPQUFYLENBQW1CUCxTQUFuQixFQUE4Qk4sSUFBOUIsQ0FBMUI7QUFFSCxTQUpNLE1BSUE7QUFHSCxnQkFBTSxJQUFJck0sZUFBSixDQUFxQixJQUFHNE0sU0FBVSxTQUFReEssSUFBSyx1QkFBL0MsRUFBdUU7QUFDekVpRSxZQUFBQSxNQUFNLEVBQUVqRSxJQURpRTtBQUV6RXVLLFlBQUFBLFNBQVMsRUFBRUE7QUFGOEQsV0FBdkUsQ0FBTjtBQUlIO0FBQ0o7QUFDSixLQXRIZSxDQUFoQjtBQXdIQXZFLElBQUFBLE1BQU0sR0FBRzFFLE9BQU8sQ0FBQzBFLE1BQVIsR0FBaUIsS0FBSzJGLGVBQUwsQ0FBcUIzRixNQUFyQixFQUE2Qm9FLFNBQVMsQ0FBQ3dCLFVBQXZDLEVBQW1ELElBQW5ELENBQTFCO0FBRUEsVUFBTTdOLFFBQVEsQ0FBQ3VGLFdBQVQsQ0FBcUJ0RixLQUFLLENBQUM2TixxQkFBM0IsRUFBa0QsSUFBbEQsRUFBd0R2SyxPQUF4RCxDQUFOOztBQUVBLFFBQUksQ0FBQzhJLFNBQVMsQ0FBQzBCLGNBQWYsRUFBK0I7QUFDM0IsWUFBTSxLQUFLQyxlQUFMLENBQXFCekssT0FBckIsRUFBOEIwSSxVQUE5QixDQUFOO0FBQ0g7O0FBR0QxSSxJQUFBQSxPQUFPLENBQUMwRSxNQUFSLEdBQWlCNUksQ0FBQyxDQUFDNE8sU0FBRixDQUFZaEcsTUFBWixFQUFvQixDQUFDeUUsS0FBRCxFQUFRckosR0FBUixLQUFnQjtBQUNqRCxVQUFJcUosS0FBSyxJQUFJLElBQWIsRUFBbUIsT0FBT0EsS0FBUDs7QUFFbkIsVUFBSXJOLENBQUMsQ0FBQzROLGFBQUYsQ0FBZ0JQLEtBQWhCLEtBQTBCQSxLQUFLLENBQUNRLE9BQXBDLEVBQTZDO0FBRXpDYixRQUFBQSxTQUFTLENBQUM2QixvQkFBVixHQUFpQyxJQUFqQztBQUNBLGVBQU94QixLQUFQO0FBQ0g7O0FBRUQsVUFBSUYsU0FBUyxHQUFHdEssTUFBTSxDQUFDbUIsR0FBRCxDQUF0Qjs7QUFUaUQsV0FVekNtSixTQVZ5QztBQUFBO0FBQUE7O0FBWWpELGFBQU8sS0FBSzJCLG9CQUFMLENBQTBCekIsS0FBMUIsRUFBaUNGLFNBQWpDLENBQVA7QUFDSCxLQWJnQixDQUFqQjtBQWVBLFdBQU9qSixPQUFQO0FBQ0g7O0FBT0QsZUFBYWtDLGFBQWIsQ0FBMkIySSxRQUEzQixFQUFxQzdLLE9BQXJDLEVBQThDO0FBQzFDNkssSUFBQUEsUUFBUSxHQUFHQSxRQUFRLENBQUNDLElBQVQsQ0FBYyxJQUFkLENBQVg7O0FBRUEsUUFBSTlLLE9BQU8sQ0FBQ1MsV0FBUixJQUF1QlQsT0FBTyxDQUFDUyxXQUFSLENBQW9CQyxVQUEvQyxFQUEyRDtBQUN0RCxhQUFPbUssUUFBUSxDQUFDN0ssT0FBRCxDQUFmO0FBQ0o7O0FBRUQsUUFBSTtBQUNBLFVBQUk0QyxNQUFNLEdBQUcsTUFBTWlJLFFBQVEsQ0FBQzdLLE9BQUQsQ0FBM0I7O0FBR0EsVUFBSUEsT0FBTyxDQUFDUyxXQUFSLElBQXVCVCxPQUFPLENBQUNTLFdBQVIsQ0FBb0JDLFVBQS9DLEVBQTJEO0FBQ3ZELGNBQU0sS0FBS0MsRUFBTCxDQUFRQyxTQUFSLENBQWtCbUssT0FBbEIsQ0FBMEIvSyxPQUFPLENBQUNTLFdBQVIsQ0FBb0JDLFVBQTlDLENBQU47QUFDQSxlQUFPVixPQUFPLENBQUNTLFdBQVIsQ0FBb0JDLFVBQTNCO0FBQ0g7O0FBRUQsYUFBT2tDLE1BQVA7QUFDSCxLQVZELENBVUUsT0FBT2lILEtBQVAsRUFBYztBQUVaLFVBQUk3SixPQUFPLENBQUNTLFdBQVIsSUFBdUJULE9BQU8sQ0FBQ1MsV0FBUixDQUFvQkMsVUFBL0MsRUFBMkQ7QUFDdkQsYUFBS0MsRUFBTCxDQUFRQyxTQUFSLENBQWtCOEIsR0FBbEIsQ0FBc0IsT0FBdEIsRUFBZ0MsdUJBQXNCbUgsS0FBSyxDQUFDbUIsT0FBUSxFQUFwRSxFQUF1RTtBQUNuRXJJLFVBQUFBLE1BQU0sRUFBRSxLQUFLcEUsSUFBTCxDQUFVRyxJQURpRDtBQUVuRXNCLFVBQUFBLE9BQU8sRUFBRUEsT0FBTyxDQUFDRSxPQUZrRDtBQUduRWhDLFVBQUFBLE9BQU8sRUFBRThCLE9BQU8sQ0FBQzJELEdBSGtEO0FBSW5Fc0gsVUFBQUEsVUFBVSxFQUFFakwsT0FBTyxDQUFDMEU7QUFKK0MsU0FBdkU7QUFNQSxjQUFNLEtBQUsvRCxFQUFMLENBQVFDLFNBQVIsQ0FBa0JzSyxTQUFsQixDQUE0QmxMLE9BQU8sQ0FBQ1MsV0FBUixDQUFvQkMsVUFBaEQsQ0FBTjtBQUNBLGVBQU9WLE9BQU8sQ0FBQ1MsV0FBUixDQUFvQkMsVUFBM0I7QUFDSDs7QUFFRCxZQUFNbUosS0FBTjtBQUNIO0FBQ0o7O0FBRUQsU0FBT3NCLGtCQUFQLENBQTBCakMsU0FBMUIsRUFBcUNsSixPQUFyQyxFQUE4QztBQUMxQyxRQUFJb0wsSUFBSSxHQUFHLEtBQUs3TSxJQUFMLENBQVU4TSxpQkFBVixDQUE0Qm5DLFNBQTVCLENBQVg7QUFFQSxXQUFPcE4sQ0FBQyxDQUFDNEIsSUFBRixDQUFPME4sSUFBUCxFQUFhRSxDQUFDLElBQUl4UCxDQUFDLENBQUM0TixhQUFGLENBQWdCNEIsQ0FBaEIsSUFBcUJyUCxZQUFZLENBQUMrRCxPQUFELEVBQVVzTCxDQUFDLENBQUNDLFNBQVosQ0FBakMsR0FBMER0UCxZQUFZLENBQUMrRCxPQUFELEVBQVVzTCxDQUFWLENBQXhGLENBQVA7QUFDSDs7QUFFRCxTQUFPRSxlQUFQLENBQXVCQyxLQUF2QixFQUE4QkMsR0FBOUIsRUFBbUM7QUFDL0IsUUFBSUMsR0FBRyxHQUFHRCxHQUFHLENBQUNFLE9BQUosQ0FBWSxHQUFaLENBQVY7O0FBRUEsUUFBSUQsR0FBRyxHQUFHLENBQVYsRUFBYTtBQUNULGFBQU9ELEdBQUcsQ0FBQ0csTUFBSixDQUFXRixHQUFHLEdBQUMsQ0FBZixLQUFxQkYsS0FBNUI7QUFDSDs7QUFFRCxXQUFPQyxHQUFHLElBQUlELEtBQWQ7QUFDSDs7QUFFRCxTQUFPMUMsc0JBQVAsQ0FBOEIwQyxLQUE5QixFQUFxQztBQUVqQyxRQUFJTCxJQUFJLEdBQUcsS0FBSzdNLElBQUwsQ0FBVThNLGlCQUFyQjtBQUNBLFFBQUlTLFVBQVUsR0FBRyxLQUFqQjs7QUFFQSxRQUFJVixJQUFKLEVBQVU7QUFDTixVQUFJVyxXQUFXLEdBQUcsSUFBSWhPLEdBQUosRUFBbEI7QUFFQStOLE1BQUFBLFVBQVUsR0FBR2hRLENBQUMsQ0FBQzRCLElBQUYsQ0FBTzBOLElBQVAsRUFBYSxDQUFDWSxHQUFELEVBQU05QyxTQUFOLEtBQ3RCcE4sQ0FBQyxDQUFDNEIsSUFBRixDQUFPc08sR0FBUCxFQUFZVixDQUFDLElBQUk7QUFDYixZQUFJeFAsQ0FBQyxDQUFDNE4sYUFBRixDQUFnQjRCLENBQWhCLENBQUosRUFBd0I7QUFDcEIsY0FBSUEsQ0FBQyxDQUFDVyxRQUFOLEVBQWdCO0FBQ1osZ0JBQUluUSxDQUFDLENBQUNtRCxLQUFGLENBQVF3TSxLQUFLLENBQUN2QyxTQUFELENBQWIsQ0FBSixFQUErQjtBQUMzQjZDLGNBQUFBLFdBQVcsQ0FBQ0csR0FBWixDQUFnQkYsR0FBaEI7QUFDSDs7QUFFRCxtQkFBTyxLQUFQO0FBQ0g7O0FBRURWLFVBQUFBLENBQUMsR0FBR0EsQ0FBQyxDQUFDQyxTQUFOO0FBQ0g7O0FBRUQsZUFBT3JDLFNBQVMsSUFBSXVDLEtBQWIsSUFBc0IsQ0FBQyxLQUFLRCxlQUFMLENBQXFCQyxLQUFyQixFQUE0QkgsQ0FBNUIsQ0FBOUI7QUFDSCxPQWRELENBRFMsQ0FBYjs7QUFrQkEsVUFBSVEsVUFBSixFQUFnQjtBQUNaLGVBQU8sSUFBUDtBQUNIOztBQUVELFdBQUssSUFBSUUsR0FBVCxJQUFnQkQsV0FBaEIsRUFBNkI7QUFDekIsWUFBSWpRLENBQUMsQ0FBQzRCLElBQUYsQ0FBT3NPLEdBQVAsRUFBWVYsQ0FBQyxJQUFJLENBQUMsS0FBS0UsZUFBTCxDQUFxQkMsS0FBckIsRUFBNEJILENBQUMsQ0FBQ0MsU0FBOUIsQ0FBbEIsQ0FBSixFQUFpRTtBQUM3RCxpQkFBTyxJQUFQO0FBQ0g7QUFDSjtBQUNKOztBQUdELFFBQUlZLGlCQUFpQixHQUFHLEtBQUs1TixJQUFMLENBQVU2TixRQUFWLENBQW1CRCxpQkFBM0M7O0FBQ0EsUUFBSUEsaUJBQUosRUFBdUI7QUFDbkJMLE1BQUFBLFVBQVUsR0FBR2hRLENBQUMsQ0FBQzRCLElBQUYsQ0FBT3lPLGlCQUFQLEVBQTBCeE4sTUFBTSxJQUFJN0MsQ0FBQyxDQUFDNEIsSUFBRixDQUFPaUIsTUFBUCxFQUFlME4sS0FBSyxJQUFLQSxLQUFLLElBQUlaLEtBQVYsSUFBb0IzUCxDQUFDLENBQUNtRCxLQUFGLENBQVF3TSxLQUFLLENBQUNZLEtBQUQsQ0FBYixDQUE1QyxDQUFwQyxDQUFiOztBQUNBLFVBQUlQLFVBQUosRUFBZ0I7QUFDWixlQUFPLElBQVA7QUFDSDtBQUNKOztBQUVELFdBQU8sS0FBUDtBQUNIOztBQUVELFNBQU9RLGdCQUFQLENBQXdCQyxHQUF4QixFQUE2QjtBQUN6QixXQUFPelEsQ0FBQyxDQUFDNEIsSUFBRixDQUFPNk8sR0FBUCxFQUFZLENBQUNDLENBQUQsRUFBSS9PLENBQUosS0FBVUEsQ0FBQyxDQUFDLENBQUQsQ0FBRCxLQUFTLEdBQS9CLENBQVA7QUFDSDs7QUFFRCxTQUFPc0UsZUFBUCxDQUF1QjdCLE9BQXZCLEVBQWdDc0YsZUFBZSxHQUFHLEtBQWxELEVBQXlEO0FBQ3JELFFBQUksQ0FBQzFKLENBQUMsQ0FBQzROLGFBQUYsQ0FBZ0J4SixPQUFoQixDQUFMLEVBQStCO0FBQzNCLFVBQUlzRixlQUFlLElBQUk5RixLQUFLLENBQUNDLE9BQU4sQ0FBYyxLQUFLcEIsSUFBTCxDQUFVQyxRQUF4QixDQUF2QixFQUEwRDtBQUN0RCxjQUFNLElBQUloQyxlQUFKLENBQW9CLCtGQUFwQixFQUFxSDtBQUN2SG1HLFVBQUFBLE1BQU0sRUFBRSxLQUFLcEUsSUFBTCxDQUFVRyxJQURxRztBQUV2SCtOLFVBQUFBLFNBQVMsRUFBRSxLQUFLbE8sSUFBTCxDQUFVQztBQUZrRyxTQUFySCxDQUFOO0FBSUg7O0FBRUQsYUFBTzBCLE9BQU8sR0FBRztBQUFFd0YsUUFBQUEsTUFBTSxFQUFFO0FBQUUsV0FBQyxLQUFLbkgsSUFBTCxDQUFVQyxRQUFYLEdBQXNCLEtBQUs2TCxlQUFMLENBQXFCbkssT0FBckI7QUFBeEI7QUFBVixPQUFILEdBQXlFLEVBQXZGO0FBQ0g7O0FBRUQsUUFBSXdNLGlCQUFpQixHQUFHLEVBQXhCO0FBQUEsUUFBNEJDLEtBQUssR0FBRyxFQUFwQzs7QUFFQTdRLElBQUFBLENBQUMsQ0FBQ3NJLE1BQUYsQ0FBU2xFLE9BQVQsRUFBa0IsQ0FBQ3NNLENBQUQsRUFBSS9PLENBQUosS0FBVTtBQUN4QixVQUFJQSxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBYixFQUFrQjtBQUNkaVAsUUFBQUEsaUJBQWlCLENBQUNqUCxDQUFELENBQWpCLEdBQXVCK08sQ0FBdkI7QUFDSCxPQUZELE1BRU87QUFDSEcsUUFBQUEsS0FBSyxDQUFDbFAsQ0FBRCxDQUFMLEdBQVcrTyxDQUFYO0FBQ0g7QUFDSixLQU5EOztBQVFBRSxJQUFBQSxpQkFBaUIsQ0FBQ2hILE1BQWxCLEdBQTJCLEVBQUUsR0FBR2lILEtBQUw7QUFBWSxTQUFHRCxpQkFBaUIsQ0FBQ2hIO0FBQWpDLEtBQTNCOztBQUVBLFFBQUlGLGVBQWUsSUFBSSxDQUFDdEYsT0FBTyxDQUFDME0sbUJBQWhDLEVBQXFEO0FBQ2pELFdBQUt4RSx3QkFBTCxDQUE4QnNFLGlCQUFpQixDQUFDaEgsTUFBaEQ7QUFDSDs7QUFFRGdILElBQUFBLGlCQUFpQixDQUFDaEgsTUFBbEIsR0FBMkIsS0FBSzJFLGVBQUwsQ0FBcUJxQyxpQkFBaUIsQ0FBQ2hILE1BQXZDLEVBQStDZ0gsaUJBQWlCLENBQUNwQyxVQUFqRSxFQUE2RSxJQUE3RSxFQUFtRixJQUFuRixDQUEzQjs7QUFFQSxRQUFJb0MsaUJBQWlCLENBQUNHLFFBQXRCLEVBQWdDO0FBQzVCLFVBQUkvUSxDQUFDLENBQUM0TixhQUFGLENBQWdCZ0QsaUJBQWlCLENBQUNHLFFBQWxDLENBQUosRUFBaUQ7QUFDN0MsWUFBSUgsaUJBQWlCLENBQUNHLFFBQWxCLENBQTJCQyxNQUEvQixFQUF1QztBQUNuQ0osVUFBQUEsaUJBQWlCLENBQUNHLFFBQWxCLENBQTJCQyxNQUEzQixHQUFvQyxLQUFLekMsZUFBTCxDQUFxQnFDLGlCQUFpQixDQUFDRyxRQUFsQixDQUEyQkMsTUFBaEQsRUFBd0RKLGlCQUFpQixDQUFDcEMsVUFBMUUsQ0FBcEM7QUFDSDtBQUNKO0FBQ0o7O0FBRUQsUUFBSW9DLGlCQUFpQixDQUFDSyxXQUF0QixFQUFtQztBQUMvQkwsTUFBQUEsaUJBQWlCLENBQUNLLFdBQWxCLEdBQWdDLEtBQUsxQyxlQUFMLENBQXFCcUMsaUJBQWlCLENBQUNLLFdBQXZDLEVBQW9ETCxpQkFBaUIsQ0FBQ3BDLFVBQXRFLENBQWhDO0FBQ0g7O0FBRUQsUUFBSW9DLGlCQUFpQixDQUFDbkwsWUFBbEIsSUFBa0MsQ0FBQ21MLGlCQUFpQixDQUFDckssY0FBekQsRUFBeUU7QUFDckVxSyxNQUFBQSxpQkFBaUIsQ0FBQ3JLLGNBQWxCLEdBQW1DLEtBQUsySyxvQkFBTCxDQUEwQk4saUJBQTFCLENBQW5DO0FBQ0g7O0FBRUQsV0FBT0EsaUJBQVA7QUFDSDs7QUFNRCxlQUFhN0ksYUFBYixDQUEyQjdELE9BQTNCLEVBQW9DO0FBQ2hDLFdBQU8sSUFBUDtBQUNIOztBQU1ELGVBQWE0RixhQUFiLENBQTJCNUYsT0FBM0IsRUFBb0M7QUFDaEMsV0FBTyxJQUFQO0FBQ0g7O0FBTUQsZUFBYTZGLGlCQUFiLENBQStCN0YsT0FBL0IsRUFBd0M7QUFDcEMsV0FBTyxJQUFQO0FBQ0g7O0FBTUQsZUFBYW9ILGFBQWIsQ0FBMkJwSCxPQUEzQixFQUFvQztBQUNoQyxXQUFPLElBQVA7QUFDSDs7QUFNRCxlQUFhcUgsaUJBQWIsQ0FBK0JySCxPQUEvQixFQUF3QztBQUNwQyxXQUFPLElBQVA7QUFDSDs7QUFNRCxlQUFhaUYsWUFBYixDQUEwQmpGLE9BQTFCLEVBQW1DLENBQ2xDOztBQU1ELGVBQWF5RyxZQUFiLENBQTBCekcsT0FBMUIsRUFBbUMsQ0FDbEM7O0FBTUQsZUFBYTBHLGdCQUFiLENBQThCMUcsT0FBOUIsRUFBdUMsQ0FDdEM7O0FBTUQsZUFBYThILFlBQWIsQ0FBMEI5SCxPQUExQixFQUFtQyxDQUNsQzs7QUFNRCxlQUFhK0gsZ0JBQWIsQ0FBOEIvSCxPQUE5QixFQUF1QyxDQUN0Qzs7QUFPRCxlQUFhZ0QsYUFBYixDQUEyQmhELE9BQTNCLEVBQW9DbUMsT0FBcEMsRUFBNkM7QUFDekMsUUFBSW5DLE9BQU8sQ0FBQ0UsT0FBUixDQUFnQnNCLGFBQXBCLEVBQW1DO0FBQy9CLFVBQUloRCxRQUFRLEdBQUcsS0FBS0QsSUFBTCxDQUFVQyxRQUF6Qjs7QUFFQSxVQUFJLE9BQU93QixPQUFPLENBQUNFLE9BQVIsQ0FBZ0JzQixhQUF2QixLQUF5QyxRQUE3QyxFQUF1RDtBQUNuRGhELFFBQUFBLFFBQVEsR0FBR3dCLE9BQU8sQ0FBQ0UsT0FBUixDQUFnQnNCLGFBQTNCOztBQUVBLFlBQUksRUFBRWhELFFBQVEsSUFBSSxLQUFLRCxJQUFMLENBQVVJLE1BQXhCLENBQUosRUFBcUM7QUFDakMsZ0JBQU0sSUFBSW5DLGVBQUosQ0FBcUIsa0JBQWlCZ0MsUUFBUyx1RUFBc0UsS0FBS0QsSUFBTCxDQUFVRyxJQUFLLElBQXBJLEVBQXlJO0FBQzNJaUUsWUFBQUEsTUFBTSxFQUFFLEtBQUtwRSxJQUFMLENBQVVHLElBRHlIO0FBRTNJdU8sWUFBQUEsYUFBYSxFQUFFek87QUFGNEgsV0FBekksQ0FBTjtBQUlIO0FBQ0o7O0FBRUQsYUFBTyxLQUFLaUQsWUFBTCxDQUFrQlUsT0FBbEIsRUFBMkIzRCxRQUEzQixDQUFQO0FBQ0g7O0FBRUQsV0FBTzJELE9BQVA7QUFDSDs7QUFFRCxTQUFPNkssb0JBQVAsR0FBOEI7QUFDMUIsVUFBTSxJQUFJRSxLQUFKLENBQVVyUSxhQUFWLENBQU47QUFDSDs7QUFFRCxTQUFPMkYsb0JBQVAsR0FBOEI7QUFDMUIsVUFBTSxJQUFJMEssS0FBSixDQUFVclEsYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBTytHLG9CQUFQLENBQTRCdEYsSUFBNUIsRUFBa0M7QUFDOUIsVUFBTSxJQUFJNE8sS0FBSixDQUFVclEsYUFBVixDQUFOO0FBQ0g7O0FBRUQsZUFBYXNILGNBQWIsQ0FBNEJuRSxPQUE1QixFQUFxQ2pELE1BQXJDLEVBQTZDO0FBQ3pDLFVBQU0sSUFBSW1RLEtBQUosQ0FBVXJRLGFBQVYsQ0FBTjtBQUNIOztBQUVELGVBQWFtSixjQUFiLENBQTRCaEcsT0FBNUIsRUFBcUNqRCxNQUFyQyxFQUE2QztBQUN6QyxVQUFNLElBQUltUSxLQUFKLENBQVVyUSxhQUFWLENBQU47QUFDSDs7QUFFRCxTQUFPc1EscUJBQVAsQ0FBNkJ6TyxJQUE3QixFQUFtQztBQUMvQixVQUFNLElBQUl3TyxLQUFKLENBQVVyUSxhQUFWLENBQU47QUFDSDs7QUFFRCxTQUFPK04sb0JBQVAsQ0FBNEJ6QixLQUE1QixFQUFtQ2lFLElBQW5DLEVBQXlDO0FBQ3JDLFVBQU0sSUFBSUYsS0FBSixDQUFVclEsYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBT3dOLGVBQVAsQ0FBdUJsQixLQUF2QixFQUE4QmtFLFNBQTlCLEVBQXlDQyxZQUF6QyxFQUF1REMsaUJBQXZELEVBQTBFO0FBQ3RFLFFBQUl6UixDQUFDLENBQUM0TixhQUFGLENBQWdCUCxLQUFoQixDQUFKLEVBQTRCO0FBQ3hCLFVBQUlBLEtBQUssQ0FBQ1EsT0FBVixFQUFtQjtBQUNmLFlBQUk3TCxnQkFBZ0IsQ0FBQ3dMLEdBQWpCLENBQXFCSCxLQUFLLENBQUNRLE9BQTNCLENBQUosRUFBeUMsT0FBT1IsS0FBUDs7QUFFekMsWUFBSUEsS0FBSyxDQUFDUSxPQUFOLEtBQWtCLGlCQUF0QixFQUF5QztBQUNyQyxjQUFJLENBQUMwRCxTQUFMLEVBQWdCO0FBQ1osa0JBQU0sSUFBSTdRLGVBQUosQ0FBb0IsNEJBQXBCLEVBQWtEO0FBQ3BEbUcsY0FBQUEsTUFBTSxFQUFFLEtBQUtwRSxJQUFMLENBQVVHO0FBRGtDLGFBQWxELENBQU47QUFHSDs7QUFFRCxjQUFJLENBQUMsQ0FBQzJPLFNBQVMsQ0FBQ0csT0FBWCxJQUFzQixFQUFFckUsS0FBSyxDQUFDekssSUFBTixJQUFlMk8sU0FBUyxDQUFDRyxPQUEzQixDQUF2QixLQUErRCxDQUFDckUsS0FBSyxDQUFDTSxRQUExRSxFQUFvRjtBQUNoRixnQkFBSWdFLE9BQU8sR0FBRyxFQUFkOztBQUNBLGdCQUFJdEUsS0FBSyxDQUFDdUUsY0FBVixFQUEwQjtBQUN0QkQsY0FBQUEsT0FBTyxDQUFDNVAsSUFBUixDQUFhc0wsS0FBSyxDQUFDdUUsY0FBbkI7QUFDSDs7QUFDRCxnQkFBSXZFLEtBQUssQ0FBQ3dFLGFBQVYsRUFBeUI7QUFDckJGLGNBQUFBLE9BQU8sQ0FBQzVQLElBQVIsQ0FBYXNMLEtBQUssQ0FBQ3dFLGFBQU4sSUFBdUIvUixRQUFRLENBQUNnUyxXQUE3QztBQUNIOztBQUVELGtCQUFNLElBQUl0UixlQUFKLENBQW9CLEdBQUdtUixPQUF2QixDQUFOO0FBQ0g7O0FBRUQsaUJBQU9KLFNBQVMsQ0FBQ0csT0FBVixDQUFrQnJFLEtBQUssQ0FBQ3pLLElBQXhCLENBQVA7QUFDSCxTQXBCRCxNQW9CTyxJQUFJeUssS0FBSyxDQUFDUSxPQUFOLEtBQWtCLGVBQXRCLEVBQXVDO0FBQzFDLGNBQUksQ0FBQzBELFNBQUwsRUFBZ0I7QUFDWixrQkFBTSxJQUFJN1EsZUFBSixDQUFvQiw0QkFBcEIsRUFBa0Q7QUFDcERtRyxjQUFBQSxNQUFNLEVBQUUsS0FBS3BFLElBQUwsQ0FBVUc7QUFEa0MsYUFBbEQsQ0FBTjtBQUdIOztBQUVELGNBQUksQ0FBQzJPLFNBQVMsQ0FBQ1YsS0FBWCxJQUFvQixFQUFFeEQsS0FBSyxDQUFDekssSUFBTixJQUFjMk8sU0FBUyxDQUFDVixLQUExQixDQUF4QixFQUEwRDtBQUN0RCxrQkFBTSxJQUFJblEsZUFBSixDQUFxQixvQkFBbUIyTSxLQUFLLENBQUN6SyxJQUFLLCtCQUFuRCxFQUFtRjtBQUNyRmlFLGNBQUFBLE1BQU0sRUFBRSxLQUFLcEUsSUFBTCxDQUFVRztBQURtRSxhQUFuRixDQUFOO0FBR0g7O0FBRUQsaUJBQU8yTyxTQUFTLENBQUNWLEtBQVYsQ0FBZ0J4RCxLQUFLLENBQUN6SyxJQUF0QixDQUFQO0FBQ0gsU0FkTSxNQWNBLElBQUl5SyxLQUFLLENBQUNRLE9BQU4sS0FBa0IsYUFBdEIsRUFBcUM7QUFDeEMsaUJBQU8sS0FBS3dELHFCQUFMLENBQTJCaEUsS0FBSyxDQUFDekssSUFBakMsQ0FBUDtBQUNIOztBQUVELGNBQU0sSUFBSXdPLEtBQUosQ0FBVSwwQkFBMEIvRCxLQUFLLENBQUNRLE9BQTFDLENBQU47QUFDSDs7QUFFRCxhQUFPN04sQ0FBQyxDQUFDNE8sU0FBRixDQUFZdkIsS0FBWixFQUFtQixDQUFDcUQsQ0FBRCxFQUFJL08sQ0FBSixLQUFVLEtBQUs0TSxlQUFMLENBQXFCbUMsQ0FBckIsRUFBd0JhLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWlCLElBQUk5UCxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBL0UsQ0FBN0IsQ0FBUDtBQUNIOztBQUVELFFBQUlpQyxLQUFLLENBQUNDLE9BQU4sQ0FBY3dKLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixVQUFJbEcsR0FBRyxHQUFHa0csS0FBSyxDQUFDdEosR0FBTixDQUFVMk0sQ0FBQyxJQUFJLEtBQUtuQyxlQUFMLENBQXFCbUMsQ0FBckIsRUFBd0JhLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWpELENBQWYsQ0FBVjtBQUNBLGFBQU9BLGlCQUFpQixHQUFHO0FBQUVNLFFBQUFBLEdBQUcsRUFBRTVLO0FBQVAsT0FBSCxHQUFrQkEsR0FBMUM7QUFDSDs7QUFFRCxRQUFJcUssWUFBSixFQUFrQixPQUFPbkUsS0FBUDtBQUVsQixXQUFPLEtBQUt4SSxFQUFMLENBQVFDLFNBQVIsQ0FBa0JrTixRQUFsQixDQUEyQjNFLEtBQTNCLENBQVA7QUFDSDs7QUF4dkNhOztBQTJ2Q2xCNEUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCaFEsV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCwgaGFzS2V5QnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IENvbnZlcnRvcnMgPSByZXF1aXJlKCcuL0NvbnZlcnRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZywgaGFzVmFsdWVJbiB9ID0gcmVxdWlyZSgnLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuY29uc3Qgb29yVHlwZXNUb0J5cGFzcyA9IG5ldyBTZXQoWydDb2x1bW5SZWZlcmVuY2UnLCAnRnVuY3Rpb24nLCAnQmluYXJ5RXhwcmVzc2lvbicsICdEYXRhU2V0JywgJ1NRTCddKTtcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZmllbGRNZXRhKG5hbWUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5maWVsZHNbbmFtZV07XG4gICAgICAgIGlmICghbWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVWtub3duIGZpZWxkIFwiJHtuYW1lfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYClcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gXy5vbWl0KG1ldGEsIFsnZGVmYXVsdCddKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCc7XG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBuZXN0ZWQgb2JqZWN0IG9mIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgsIGRlZmF1bHRWYWx1ZSkge1xuICAgICAgICBsZXQgbm9kZXMgPSAoQXJyYXkuaXNBcnJheShrZXlQYXRoKSA/IGtleVBhdGggOiBrZXlQYXRoLnNwbGl0KCcuJykpLm1hcChrZXkgPT4ga2V5WzBdID09PSAnOicgPyBrZXkgOiAoJzonICsga2V5KSk7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIG5vZGVzLCBkZWZhdWx0VmFsdWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICoge3N0cmluZ30gW2tleV0gLSBUaGUga2V5IGZpZWxkIHRvIHVzZWQgYnkgdGhlIGhhc2h0YWJsZS5cbiAgICAgKiB7YXJyYXl9IFthc3NvY2lhdGlvbnNdIC0gV2l0aCBhbiBhcnJheSBvZiBhc3NvY2lhdGlvbnMuXG4gICAgICoge29iamVjdH0gW2Nvbm5PcHRpb25zXSAtIENvbm5lY3Rpb24gb3B0aW9ucywgZS5nLiB0cmFuc2FjdGlvbiBoYW5kbGVcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXksIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNvbWJpbmVkS2V5ID0ga2V5O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgY29tYmluZWRLZXkgKz0gJy8nICsgbWluaWZ5QXNzb2NzKGFzc29jaWF0aW9ucykuam9pbignJicpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJGFzc29jaWF0aW9uOiBhc3NvY2lhdGlvbnMsICR0b0RpY3Rpb25hcnk6IGtleSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gdGhpcy5jYWNoZWRfKHRoaXMubWV0YS5rZXlGaWVsZCwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRvRGljdGlvbmFyeShlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKSB7XG4gICAgICAgIGtleSB8fCAoa2V5ID0gdGhpcy5tZXRhLmtleUZpZWxkKTtcblxuICAgICAgICByZXR1cm4gQ29udmVydG9ycy50b0tWUGFpcnMoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcik7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgZmluZE9uZSgpIHJldHVybnMgbW9yZSB0aGFuIG9uZSByZWNvcmQuYCwgeyBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBvcHRpb25zOiBjb250ZXh0Lm9wdGlvbnMgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiByZWNvcmRzLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgICBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmluZE9wdGlvbnMuJHNraXBPcm0pIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdXBzZXJ0PWZhbHNlXSAtIElmIGFscmVhZHkgZXhpc3QsIGp1c3QgdXBkYXRlIHRoZSByZWNvcmQuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCB0cnVlKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGNvbnN0IFsgZmluaXNoZWQsIHBlbmRpbmdBc3NvY3MgXSA9IGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSBjcmVhdGUgKi8pOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICByYXdbbG9jYWxGaWVsZF0gPSByZWZGaWVsZFZhbHVlO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gcGVuZGluZ0Fzc29jcztcbiAgICAgICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSBPYmplY3QuZnJlZXplKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cHNlcnRPbmVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGNvbnRleHQubGF0ZXN0KSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiR1cHNlcnRcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGxldCBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgbGV0IGRvbmVVcGRhdGVBc3NvY3M7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgdXBkYXRlICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgZG9uZVVwZGF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQubGF0ZXN0KSkge1xuICAgICAgICAgICAgICAgIGlmICghZG9uZVVwZGF0ZUFzc29jcyAmJiAhbmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgZG8gdGhlIHVwZGF0ZSB3aXRoIGVtcHR5IHJlY29yZC4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgIWhhc1ZhbHVlSW4oWyRxdWVyeSwgY29udGV4dC5sYXRlc3RdLCB0aGlzLm1ldGEua2V5RmllbGQpICYmICFvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBhc3NvY2lhdGVkIGRhdGEgZGVwZW5kaW5nIG9uIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuXG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKCRxdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsPWZhbHNlXSAtIFdoZW4gJGRlbGV0ZUFsbCA9IHRydWUsIHRoZSBvcGVyYXRpb24gd2lsbCBwcm9jZWVkIGV2ZW4gZW1wdHkgY29uZGl0aW9uIGlzIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBkZWxldGVBbGxfKGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmRlbGV0ZU1hbnlfKHsgJGRlbGV0ZUFsbDogdHJ1ZSB9LCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSAmJiAoZm9yU2luZ2xlUmVjb3JkIHx8ICFkZWxldGVPcHRpb25zLiRkZWxldGVBbGwpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IGRlbGV0ZWRDb3VudCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVkQ291bnQoY29udGV4dCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChkZWxldGVkQ291bnQpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybiB8fCBkZWxldGVkQ291bnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgdmFsdWUgcGFpciBpbiB0aGUgcXVlcnkgY29uZGl0aW9uLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UsIGZvclNpbmdsZVJlY29yZCA9IHRydWUpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3RpbmcgPSBjb250ZXh0Lm9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIF8uaXNFbXB0eShleGlzdGluZykgJiYgKHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpIHx8IG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZyAmJiAhY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICBsZXQgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcblxuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BPcHRpb25zLiRtaWdyYXRpb24gJiYgKCFpc1VwZGF0aW5nIHx8IW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3ksIGNoZWNrIHdyaXRlUHJvdGVjdCBcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm9bJ2RlZmF1bHQnXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm9bJ2RlZmF1bHQnXTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUodmFsdWUsIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLnN0YWNrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIgfHwgZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBjaGVjayBpZiB0aGVyZSBpcyBhbiBhY3RpdmF0b3JcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGlmICghb3BPcHRpb25zLiRza2lwTW9kaWZpZXJzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIHZhbHVlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgLy90aGVyZSBpcyBzcGVjaWFsIGlucHV0IGNvbHVtbiB3aGljaCBtYXliZSBhIGZ1bmN0aW9uIG9yIGFuIGV4cHJlc3Npb25cbiAgICAgICAgICAgICAgICBvcE9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZpZWxkSW5mbyA9IGZpZWxkc1trZXldO1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZEluZm87XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgUm9sbGJhY2tlZCwgcmVhc29uOiAke2Vycm9yLm1lc3NhZ2V9YCwgeyAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RGF0YTogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdERhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kZW5jeUNoYW5nZWQoZmllbGROYW1lLCBjb250ZXh0KSB7XG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzW2ZpZWxkTmFtZV07XG5cbiAgICAgICAgcmV0dXJuIF8uZmluZChkZXBzLCBkID0+IF8uaXNQbGFpbk9iamVjdChkKSA/IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBoYXNLZXlCeVBhdGgoY29udGV4dCwgZCkpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcmVmZXJlbmNlRXhpc3QoaW5wdXQsIHJlZikge1xuICAgICAgICBsZXQgcG9zID0gcmVmLmluZGV4T2YoJy4nKTtcblxuICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZi5zdWJzdHIocG9zKzEpIGluIGlucHV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZiBpbiBpbnB1dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbnVsbERlcGVuZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiBcbiAgICAgICAgICAgICAgICBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQud2hlbk51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChpbnB1dFtmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsRGVwZW5kcy5hZGQoZGVwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGQgPSBkLnJlZmVyZW5jZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWVsZE5hbWUgaW4gaW5wdXQgJiYgIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChsZXQgZGVwIG9mIG51bGxEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uZmluZChkZXAsIGQgPT4gIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkLnJlZmVyZW5jZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgXG4gICAgICAgICAgICAgICAgICAgIGtleUZpZWxkczogdGhpcy5tZXRhLmtleUZpZWxkICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcywgbnVsbCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBmaW5kQWxsIHByb2Nlc3NpbmdcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0S2V5RmllbGQ6IGtleUZpZWxkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMudG9EaWN0aW9uYXJ5KHJlY29yZHMsIGtleUZpZWxkKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9vclR5cGVzVG9CeXBhc3MuaGFzKHZhbHVlLm9vclR5cGUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodiwgaykgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpKTtcbiAgICAgICAgICAgIHJldHVybiBhcnJheVRvSW5PcGVyYXRvciA/IHsgJGluOiByZXQgfSA6IHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChza2lwVHlwZUNhc3QpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IudHlwZUNhc3QodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
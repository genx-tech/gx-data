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
      op: 'find',
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
      op: 'find',
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
      op: 'create',
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
      op: 'update',
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
      op: 'replace',
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
      op: 'delete',
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

    await Features.applyRules_(Rules.RULE_BEFORE_VALIDATION, this, context);
    await eachAsync_(fields, async (fieldInfo, fieldName) => {
      let value,
          useRaw = false;

      if (fieldName in raw) {
        value = raw[fieldName];
        useRaw = true;
      } else if (fieldName in latest) {
        value = latest[fieldName];
      }

      if (typeof value !== 'undefined') {
        if (fieldInfo.readOnly && useRaw) {
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
              value,
              error: error.stack
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
        } else if (!fieldInfo.hasActivator) {
          throw new ValidationError(`"${fieldName}" of "${name}" entity is required.`, {
            entity: name,
            fieldInfo: fieldInfo,
            raw
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJvcCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhd09wdGlvbnMiLCJyYXciLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwibmVlZENyZWF0ZUFzc29jcyIsImZpbmlzaGVkIiwicGVuZGluZ0Fzc29jcyIsIl9jcmVhdGVBc3NvY3NfIiwiZm9yT3duIiwicmVmRmllbGRWYWx1ZSIsImxvY2FsRmllbGQiLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIiR1cHNlcnQiLCJ1cHNlcnRPbmVfIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsInRvVXBkYXRlIiwiYmVmb3JlVXBkYXRlXyIsImJlZm9yZVVwZGF0ZU1hbnlfIiwibmVlZFVwZGF0ZUFzc29jcyIsImRvbmVVcGRhdGVBc3NvY3MiLCJfdXBkYXRlQXNzb2NzXyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIm90aGVyT3B0aW9ucyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsImRlbGV0ZUFsbF8iLCIkZGVsZXRlQWxsIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVkQ291bnQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIlJVTEVfQUZURVJfREVMRVRFIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiSlNPTiIsInN0cmluZ2lmeSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJSVUxFX0JFRk9SRV9WQUxJREFUSU9OIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJ1c2VSYXciLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1RLEtBQUssR0FBR1IsT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFUyxFQUFBQSxlQUFGO0FBQW1CQyxFQUFBQSxhQUFuQjtBQUFrQ0MsRUFBQUE7QUFBbEMsSUFBc0ROLE1BQTVEOztBQUNBLE1BQU1PLFFB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QUFxQm1DLENBQXJCLEVBQXdCYSxTQUF4QixFQUFtQ0MsWUFBbkMsRUFBaURDLGlCQUFpQixJQUFJaFEsQ0FBQyxDQUFDLENBQUQsQ0FBRCxLQUFTLEdBQS9FLENBQTdCLENBQVA7QUFDSDs7QUFFRCxRQUFJaUMsS0FBSyxDQUFDQyxPQUFOLENBQWN5SixLQUFkLENBQUosRUFBMEI7QUFDdEIsVUFBSWxHLEdBQUcsR0FBR2tHLEtBQUssQ0FBQ3ZKLEdBQU4sQ0FBVTZNLENBQUMsSUFBSSxLQUFLbkMsZUFBTCxDQUFxQm1DLENBQXJCLEVBQXdCYSxTQUF4QixFQUFtQ0MsWUFBbkMsRUFBaURDLGlCQUFqRCxDQUFmLENBQVY7QUFDQSxhQUFPQSxpQkFBaUIsR0FBRztBQUFFTSxRQUFBQSxHQUFHLEVBQUU3SztBQUFQLE9BQUgsR0FBa0JBLEdBQTFDO0FBQ0g7O0FBRUQsUUFBSXNLLFlBQUosRUFBa0IsT0FBT3BFLEtBQVA7QUFFbEIsV0FBTyxLQUFLekksRUFBTCxDQUFRQyxTQUFSLENBQWtCb04sUUFBbEIsQ0FBMkI1RSxLQUEzQixDQUFQO0FBQ0g7O0FBaHdDYTs7QUFtd0NsQjZFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmxRLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcsIGhhc1ZhbHVlSW4gfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nLCAnRGF0YVNldCcsICdTUUwnXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIGRhdGFbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIGZpZWxkTWV0YShuYW1lKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuZmllbGRzW25hbWVdO1xuICAgICAgICBpZiAoIW1ldGEpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFVrbm93biBmaWVsZCBcIiR7bmFtZX1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIF8ub21pdChtZXRhLCBbJ2RlZmF1bHQnXSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoLCBkZWZhdWx0VmFsdWUpIHtcbiAgICAgICAgbGV0IG5vZGVzID0gKEFycmF5LmlzQXJyYXkoa2V5UGF0aCkgPyBrZXlQYXRoIDoga2V5UGF0aC5zcGxpdCgnLicpKS5tYXAoa2V5ID0+IGtleVswXSA9PT0gJzonID8ga2V5IDogKCc6JyArIGtleSkpO1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBub2RlcywgZGVmYXVsdFZhbHVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqIHtzdHJpbmd9IFtrZXldIC0gVGhlIGtleSBmaWVsZCB0byB1c2VkIGJ5IHRoZSBoYXNodGFibGUuXG4gICAgICoge2FycmF5fSBbYXNzb2NpYXRpb25zXSAtIFdpdGggYW4gYXJyYXkgb2YgYXNzb2NpYXRpb25zLlxuICAgICAqIHtvYmplY3R9IFtjb25uT3B0aW9uc10gLSBDb25uZWN0aW9uIG9wdGlvbnMsIGUuZy4gdHJhbnNhY3Rpb24gaGFuZGxlXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0b0RpY3Rpb25hcnkoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcikge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIENvbnZlcnRvcnMudG9LVlBhaXJzKGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZmluZCcsICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgICBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmluZE9wdGlvbnMuJHNraXBPcm0pIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdXBzZXJ0PWZhbHNlXSAtIElmIGFscmVhZHkgZXhpc3QsIGp1c3QgdXBkYXRlIHRoZSByZWNvcmQuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCB0cnVlKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdjcmVhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBbIGZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzIF0gPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IHBlbmRpbmdBc3NvY3M7XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBzZXJ0T25lXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShjb250ZXh0LmxhdGVzdCksXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIC8vaWYgbm8gY29uZGl0aW9uIGdpdmVuLCBleHRyYWN0IGZyb20gZGF0YSBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFzc29jaWF0ZWQgZW50aXR5IGRhdGEgcHJvdmlkZWQgdG9nZXRoZXJcbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3A6ICd1cGRhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTsgICAgICAgICAgICAgICBcblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhbnkgcnVudGltZSBmZWF0dXJlIHN0b3BwaW5nIHRoZSB1cGRhdGVcbiAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBsZXQgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGxldCBkb25lVXBkYXRlQXNzb2NzO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIGRvbmVVcGRhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmxhdGVzdCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRvbmVVcGRhdGVBc3NvY3MgJiYgIW5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IGRvIHRoZSB1cGRhdGUgd2l0aCBlbXB0eSByZWNvcmQuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzICYmICFoYXNWYWx1ZUluKFskcXVlcnksIGNvbnRleHQubGF0ZXN0XSwgdGhpcy5tZXRhLmtleUZpZWxkKSAmJiAhb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICAvL3Nob3VsZCBlbnN1cmUgdGhlIGxhdGVzdCByZXN1bHQgd2lsbCBjb250YWluIHRoZSBrZXkgb2YgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgZmFsc2UsIGZvclNpbmdsZVJlY29yZCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3JlcGxhY2UnLFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRkZWxldGVBbGw9ZmFsc2VdIC0gV2hlbiAkZGVsZXRlQWxsID0gdHJ1ZSwgdGhlIG9wZXJhdGlvbiB3aWxsIHByb2NlZWQgZXZlbiBlbXB0eSBjb25kaXRpb24gaXMgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZUFsbF8oY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlTWFueV8oeyAkZGVsZXRlQWxsOiB0cnVlIH0sIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpICYmIChmb3JTaW5nbGVSZWNvcmQgfHwgIWRlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdkZWxldGUnLFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IGRlbGV0ZWRDb3VudCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVkQ291bnQoY29udGV4dCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChkZWxldGVkQ291bnQpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybiB8fCBkZWxldGVkQ291bnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgdmFsdWUgcGFpciBpbiB0aGUgcXVlcnkgY29uZGl0aW9uLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UsIGZvclNpbmdsZVJlY29yZCA9IHRydWUpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3RpbmcgPSBjb250ZXh0Lm9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIF8uaXNFbXB0eShleGlzdGluZykgJiYgKHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpIHx8IG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZyAmJiAhY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWx1ZSwgdXNlUmF3ID0gZmFsc2U7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICB1c2VSYXcgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgaW4gbGF0ZXN0KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBsYXRlc3RbZmllbGROYW1lXTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSAmJiB1c2VSYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seSB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mb1snZGVmYXVsdCddKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mb1snZGVmYXVsdCddO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2sgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIgfHwgZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vc2tpcCB0aG9zZSBoYXZlIGFjdGl2YXRvcnNcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJhdyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgaWYgKCFvcE9wdGlvbnMuJHNraXBNb2RpZmllcnMpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gdmFsdWU7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAvL3RoZXJlIGlzIHNwZWNpYWwgaW5wdXQgY29sdW1uIHdoaWNoIG1heWJlIGEgZnVuY3Rpb24gb3IgYW4gZXhwcmVzc2lvblxuICAgICAgICAgICAgICAgIG9wT3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucyA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBSb2xsYmFja2VkLCByZWFzb246ICR7ZXJyb3IubWVzc2FnZX1gLCB7ICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICByYXdEYXRhOiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0RGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRlbmN5Q2hhbmdlZChmaWVsZE5hbWUsIGNvbnRleHQpIHtcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXNbZmllbGROYW1lXTtcblxuICAgICAgICByZXR1cm4gXy5maW5kKGRlcHMsIGQgPT4gXy5pc1BsYWluT2JqZWN0KGQpID8gaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQucmVmZXJlbmNlKSA6IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkKSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9yZWZlcmVuY2VFeGlzdChpbnB1dCwgcmVmKSB7XG4gICAgICAgIGxldCBwb3MgPSByZWYuaW5kZXhPZignLicpO1xuXG4gICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmLnN1YnN0cihwb3MrMSkgaW4gaW5wdXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmIGluIGlucHV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBudWxsRGVwZW5kcyA9IG5ldyBTZXQoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IFxuICAgICAgICAgICAgICAgIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZC53aGVuTnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGlucHV0W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bGxEZXBlbmRzLmFkZChkZXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZCA9IGQucmVmZXJlbmNlO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSBpbiBpbnB1dCAmJiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGxldCBkZXAgb2YgbnVsbERlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5maW5kKGRlcCwgZCA9PiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQucmVmZXJlbmNlKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICBcbiAgICAgICAgICAgICAgICAgICAga2V5RmllbGRzOiB0aGlzLm1ldGEua2V5RmllbGQgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgIW9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzLCBudWxsLCB0cnVlKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKG5vcm1hbGl6ZWRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgY3JlYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGZpbmRBbGwgcHJvY2Vzc2luZ1xuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IHJlY29yZHMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcykge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSA9PT0gJ3N0cmluZycpIHsgXG4gICAgICAgICAgICAgICAga2V5RmllbGQgPSBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeTsgXG5cbiAgICAgICAgICAgICAgICBpZiAoIShrZXlGaWVsZCBpbiB0aGlzLm1ldGEuZmllbGRzKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgaW5wdXRLZXlGaWVsZDoga2V5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy50b0RpY3Rpb25hcnkocmVjb3Jkcywga2V5RmllbGQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiByZWNvcmRzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IgJiYga1swXSAhPT0gJyQnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHsgIFxuICAgICAgICAgICAgbGV0IHJldCA9IHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikpO1xuICAgICAgICAgICAgcmV0dXJuIGFycmF5VG9Jbk9wZXJhdG9yID8geyAkaW46IHJldCB9IDogcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBUeXBlQ2FzdCkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci50eXBlQ2FzdCh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==
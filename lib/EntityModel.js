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

const JES = require('@genx/jes');

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
    let rawOptions = findOptions;
    findOptions = this._prepareQueries(findOptions, true);
    let context = {
      op: 'find',
      options: findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);
    const result = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.options, context.connOptions);
      if (!records) throw new DatabaseError('connector.find_() returns undefined data record.');

      if (rawOptions.$retrieveDbResult) {
        rawOptions.$result = records.slice(1);
      }

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

    if (findOptions.$transformer) {
      return JES.evaluate(result, findOptions.$transformer);
    }

    return result;
  }

  static async findAll_(findOptions, connOptions) {
    let rawOptions = findOptions;
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

      if (rawOptions.$retrieveDbResult) {
        rawOptions.$result = records.slice(1);
      }

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

    if (findOptions.$transformer) {
      rows = rows.map(row => JES.evaluate(row, findOptions.$transformer));
    }

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

    let [raw, associations, references] = this._extractAssociations(data, true);

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
      if (!_.isEmpty(references)) {
        await this.ensureTransaction_(context);
        await this._populateReferences_(context, references);
      }

      let needCreateAssocs = !_.isEmpty(associations);

      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
        associations = await this._createAssocs_(context, associations, true);
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

    let [raw, associations, references] = this._extractAssociations(data);

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
      if (!_.isEmpty(references)) {
        await this.ensureTransaction_(context);
        await this._populateReferences_(context, references);
      }

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

      const {
        $query,
        ...otherOptions
      } = context.options;

      if (_.isEmpty(context.latest)) {
        if (!doneUpdateAssocs && !needUpdateAssocs) {
          throw new InvalidArgument('Cannot do the update with empty record. Entity: ' + this.meta.name);
        }
      } else {
        if (needUpdateAssocs && !hasValueIn([$query, context.latest], this.meta.keyField) && !otherOptions.$retrieveUpdated) {
          otherOptions.$retrieveUpdated = true;
        }

        context.result = await this.db.connector.update_(this.meta.name, context.latest, $query, otherOptions, context.connOptions);
        context.return = context.latest;
      }

      if (forSingleRecord) {
        await this._internalAfterUpdate_(context);

        if (!context.queryKey) {
          context.queryKey = this.getUniqueKeyValuePairsFrom($query);
        }
      } else {
        await this._internalAfterUpdateMany_(context);
      }

      await Features.applyRules_(Rules.RULE_AFTER_UPDATE, this, context);

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

          throw new ValidationError(`Field "${fieldName}" of "${name}" entity is required for each update.`, {
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
          throw new ValidationError(`Field "${fieldName}" of "${name}" entity is required.`, {
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

  static async _populateReferences_(context, references) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJyYXdPcHRpb25zIiwiX3ByZXBhcmVRdWVyaWVzIiwib3AiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJyZXN1bHQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCIkcmVzdWx0Iiwic2xpY2UiLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwiJHRyYW5zZm9ybWVyIiwiZXZhbHVhdGUiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJvdyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwicmVmZXJlbmNlcyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJfcG9wdWxhdGVSZWZlcmVuY2VzXyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJfY3JlYXRlQXNzb2NzXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwiJHVwc2VydCIsInVwc2VydE9uZV8iLCJsYXRlc3QiLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiYWZ0ZXJDcmVhdGVfIiwidXBkYXRlT25lXyIsInVwZGF0ZU9wdGlvbnMiLCIkYnlwYXNzUmVhZE9ubHkiLCJyZWFzb24iLCJfdXBkYXRlXyIsInVwZGF0ZU1hbnlfIiwiZm9yU2luZ2xlUmVjb3JkIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJuZWVkVXBkYXRlQXNzb2NzIiwiZG9uZVVwZGF0ZUFzc29jcyIsIl91cGRhdGVBc3NvY3NfIiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwib3RoZXJPcHRpb25zIiwidXBkYXRlXyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJSVUxFX0FGVEVSX1VQREFURSIsImFmdGVyVXBkYXRlXyIsImFmdGVyVXBkYXRlTWFueV8iLCJyZXBsYWNlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiZGVsZXRlT25lXyIsImRlbGV0ZU9wdGlvbnMiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwiZGVsZXRlQWxsXyIsIiRkZWxldGVBbGwiLCJ0b0RlbGV0ZSIsImJlZm9yZURlbGV0ZV8iLCJiZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZWRDb3VudCIsIlJVTEVfQkVGT1JFX0RFTEVURSIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiUlVMRV9BRlRFUl9ERUxFVEUiLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJKU09OIiwic3RyaW5naWZ5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJleGlzdGluZyIsIiRleGlzdGluZyIsIm9wT3B0aW9ucyIsIl9kZXBlbmRzT25FeGlzdGluZ0RhdGEiLCIkcmV0cmlldmVFeGlzdGluZyIsIlJVTEVfQkVGT1JFX1ZBTElEQVRJT04iLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJ2YWx1ZSIsInVzZVJhdyIsInJlYWRPbmx5IiwiJG1pZ3JhdGlvbiIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsImlzUGxhaW5PYmplY3QiLCJvb3JUeXBlIiwic2FuaXRpemUiLCJlcnJvciIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiaGFzQWN0aXZhdG9yIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIl90cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCIkc2tpcE1vZGlmaWVycyIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwibWVzc2FnZSIsImxhdGVzdERhdGEiLCJyb2xsYmFja18iLCJfZGVwZW5kZW5jeUNoYW5nZWQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJkIiwicmVmZXJlbmNlIiwiX3JlZmVyZW5jZUV4aXN0IiwiaW5wdXQiLCJyZWYiLCJwb3MiLCJpbmRleE9mIiwic3Vic3RyIiwiaGFzRGVwZW5kcyIsIm51bGxEZXBlbmRzIiwiZGVwIiwid2hlbk51bGwiLCJhZGQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiZmllbGQiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImtleUZpZWxkcyIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiaW5wdXRLZXlGaWVsZCIsIkVycm9yIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiaW5mbyIsInZhcmlhYmxlcyIsInNraXBUeXBlQ2FzdCIsImFycmF5VG9Jbk9wZXJhdG9yIiwic2Vzc2lvbiIsImVyckFyZ3MiLCJtaXNzaW5nTWVzc2FnZSIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIiRpbiIsInR5cGVDYXN0IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUEsY0FBakI7QUFBaUNDLEVBQUFBO0FBQWpDLElBQWtESixPQUFPLENBQUMsVUFBRCxDQUEvRDs7QUFDQSxNQUFNSyxNQUFNLEdBQUdMLE9BQU8sQ0FBQyxnQkFBRCxDQUF0Qjs7QUFDQSxNQUFNTSxVQUFVLEdBQUdOLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1PLFVBQVUsR0FBR1AsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTVEsS0FBSyxHQUFHUixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVTLEVBQUFBLGVBQUY7QUFBbUJDLEVB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cFAsQ0FBSixLQUFVLEtBQUtpTixlQUFMLENBQXFCbUMsQ0FBckIsRUFBd0JjLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWlCLElBQUlwUSxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBL0UsQ0FBN0IsQ0FBUDtBQUNIOztBQUVELFFBQUlpQyxLQUFLLENBQUNDLE9BQU4sQ0FBYzRKLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixVQUFJOUYsR0FBRyxHQUFHOEYsS0FBSyxDQUFDMUosR0FBTixDQUFVZ04sQ0FBQyxJQUFJLEtBQUtuQyxlQUFMLENBQXFCbUMsQ0FBckIsRUFBd0JjLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWpELENBQWYsQ0FBVjtBQUNBLGFBQU9BLGlCQUFpQixHQUFHO0FBQUVNLFFBQUFBLEdBQUcsRUFBRTFLO0FBQVAsT0FBSCxHQUFrQkEsR0FBMUM7QUFDSDs7QUFFRCxRQUFJbUssWUFBSixFQUFrQixPQUFPckUsS0FBUDtBQUVsQixXQUFPLEtBQUs1SSxFQUFMLENBQVFDLFNBQVIsQ0FBa0J3TixRQUFsQixDQUEyQjdFLEtBQTNCLENBQVA7QUFDSDs7QUFqeUNhOztBQW95Q2xCOEUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCdFEsV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCwgaGFzS2V5QnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IENvbnZlcnRvcnMgPSByZXF1aXJlKCcuL0NvbnZlcnRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZywgaGFzVmFsdWVJbiB9ID0gcmVxdWlyZSgnLi91dGlscy9sYW5nJyk7XG5jb25zdCBKRVMgPSByZXF1aXJlKCdAZ2VueC9qZXMnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG5mdW5jdGlvbiBtaW5pZnlBc3NvY3MoYXNzb2NzKSB7XG4gICAgbGV0IHNvcnRlZCA9IF8udW5pcShhc3NvY3MpLnNvcnQoKS5yZXZlcnNlKCk7XG5cbiAgICBsZXQgbWluaWZpZWQgPSBfLnRha2Uoc29ydGVkLCAxKSwgbCA9IHNvcnRlZC5sZW5ndGggLSAxO1xuXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgbGV0IGsgPSBzb3J0ZWRbaV0gKyAnLic7XG5cbiAgICAgICAgaWYgKCFfLmZpbmQobWluaWZpZWQsIGEgPT4gYS5zdGFydHNXaXRoKGspKSkge1xuICAgICAgICAgICAgbWluaWZpZWQucHVzaChzb3J0ZWRbaV0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG1pbmlmaWVkO1xufVxuXG5jb25zdCBvb3JUeXBlc1RvQnlwYXNzID0gbmV3IFNldChbJ0NvbHVtblJlZmVyZW5jZScsICdGdW5jdGlvbicsICdCaW5hcnlFeHByZXNzaW9uJywgJ0RhdGFTZXQnLCAnU1FMJ10pO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBmaWVsZE1ldGEobmFtZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmZpZWxkc1tuYW1lXTtcbiAgICAgICAgaWYgKCFtZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBVa25vd24gZmllbGQgXCIke25hbWV9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBfLm9taXQobWV0YSwgWydkZWZhdWx0J10pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCwgZGVmYXVsdFZhbHVlKSB7XG4gICAgICAgIGxldCBub2RlcyA9IChBcnJheS5pc0FycmF5KGtleVBhdGgpID8ga2V5UGF0aCA6IGtleVBhdGguc3BsaXQoJy4nKSkubWFwKGtleSA9PiBrZXlbMF0gPT09ICc6JyA/IGtleSA6ICgnOicgKyBrZXkpKTtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwgbm9kZXMsIGRlZmF1bHRWYWx1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKiB7c3RyaW5nfSBba2V5XSAtIFRoZSBrZXkgZmllbGQgdG8gdXNlZCBieSB0aGUgaGFzaHRhYmxlLlxuICAgICAqIHthcnJheX0gW2Fzc29jaWF0aW9uc10gLSBXaXRoIGFuIGFycmF5IG9mIGFzc29jaWF0aW9ucy5cbiAgICAgKiB7b2JqZWN0fSBbY29ubk9wdGlvbnNdIC0gQ29ubmVjdGlvbiBvcHRpb25zLCBlLmcuIHRyYW5zYWN0aW9uIGhhbmRsZVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY29tYmluZWRLZXkgPSBrZXk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBjb21iaW5lZEtleSArPSAnLycgKyBtaW5pZnlBc3NvY3MoYXNzb2NpYXRpb25zKS5qb2luKCcmJylcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkYXNzb2NpYXRpb246IGFzc29jaWF0aW9ucywgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiB0aGlzLmNhY2hlZF8odGhpcy5tZXRhLmtleUZpZWxkLCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdG9EaWN0aW9uYXJ5KGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpIHtcbiAgICAgICAga2V5IHx8IChrZXkgPSB0aGlzLm1ldGEua2V5RmllbGQpO1xuXG4gICAgICAgIHJldHVybiBDb252ZXJ0b3JzLnRvS1ZQYWlycyhlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXJdIC0gVHJhbnNmb3JtIGZpZWxkcyBiZWZvcmUgcmV0dXJuaW5nXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZmluZCcsXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKHJhd09wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByYXdPcHRpb25zLiRyZXN1bHQgPSByZWNvcmRzLnNsaWNlKDEpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgZmluZE9uZSgpIHJldHVybnMgbW9yZSB0aGFuIG9uZSByZWNvcmQuYCwgeyBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBvcHRpb25zOiBjb250ZXh0Lm9wdGlvbnMgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSB7XG4gICAgICAgICAgICByZXR1cm4gSkVTLmV2YWx1YXRlKHJlc3VsdCwgZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcl0gLSBUcmFuc2Zvcm0gZmllbGRzIGJlZm9yZSByZXR1cm5pbmdcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJywgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAocmF3T3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgICAgIHJhd09wdGlvbnMuJHJlc3VsdCA9IHJlY29yZHMuc2xpY2UoMSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpbmRPcHRpb25zLiRza2lwT3JtKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikge1xuICAgICAgICAgICAgcm93cyA9IHJvd3MubWFwKHJvdyA9PiBKRVMuZXZhbHVhdGUocm93LCBmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiR1cHNlcnQ9ZmFsc2VdIC0gSWYgYWxyZWFkeSBleGlzdCwganVzdCB1cGRhdGUgdGhlIHJlY29yZC4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCFjcmVhdGVPcHRpb25zKSB7IFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyA9IHt9OyBcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zLCByZWZlcmVuY2VzIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIHRydWUpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2NyZWF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkocmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcyk7ICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL2NoZWNrIGFueSBvdGhlciBhc3NvY2lhdGlvbnMgbGVmdFxuICAgICAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIShhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR1cHNlcnQpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwc2VydE9uZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oY29udGV4dC5sYXRlc3QpLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHVwc2VydFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0NSRUFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIG1hbnkgZXhpc3RpbmcgZW50aXRlcyB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICAvL2lmIG5vIGNvbmRpdGlvbiBnaXZlbiwgZXh0cmFjdCBmcm9tIGRhdGEgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhc3NvY2lhdGVkIGVudGl0eSBkYXRhIHByb3ZpZGVkIHRvZ2V0aGVyXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zLCByZWZlcmVuY2VzIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIG9wOiAndXBkYXRlJyxcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKSwgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5PcHRpb25zLFxuICAgICAgICAgICAgZm9yU2luZ2xlUmVjb3JkXG4gICAgICAgIH07ICAgICAgICAgICAgICAgXG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYW55IHJ1bnRpbWUgZmVhdHVyZSBzdG9wcGluZyB0aGUgdXBkYXRlXG4gICAgICAgIGxldCB0b1VwZGF0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkocmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcyk7ICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIGxldCBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgbGV0IGRvbmVVcGRhdGVBc3NvY3M7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgdXBkYXRlICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgZG9uZVVwZGF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCB7ICRxdWVyeSwgLi4ub3RoZXJPcHRpb25zIH0gPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5sYXRlc3QpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFkb25lVXBkYXRlQXNzb2NzICYmICFuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhbm5vdCBkbyB0aGUgdXBkYXRlIHdpdGggZW1wdHkgcmVjb3JkLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcyAmJiAhaGFzVmFsdWVJbihbJHF1ZXJ5LCBjb250ZXh0LmxhdGVzdF0sIHRoaXMubWV0YS5rZXlGaWVsZCkgJiYgIW90aGVyT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGFzc29jaWF0ZWQgZGF0YSBkZXBlbmRpbmcgb24gdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgLy9zaG91bGQgZW5zdXJlIHRoZSBsYXRlc3QgcmVzdWx0IHdpbGwgY29udGFpbiB0aGUga2V5IG9mIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICAkcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7ICBcblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oJHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIG9wOiAncmVwbGFjZScsXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbD1mYWxzZV0gLSBXaGVuICRkZWxldGVBbGwgPSB0cnVlLCB0aGUgb3BlcmF0aW9uIHdpbGwgcHJvY2VlZCBldmVuIGVtcHR5IGNvbmRpdGlvbiBpcyBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlQWxsXyhjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5kZWxldGVNYW55Xyh7ICRkZWxldGVBbGw6IHRydWUgfSwgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkgJiYgKGZvclNpbmdsZVJlY29yZCB8fCAhZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2RlbGV0ZScsXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zLFxuICAgICAgICAgICAgZm9yU2luZ2xlUmVjb3JkXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgZGVsZXRlZENvdW50ID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAkcXVlcnksXG4gICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfREVMRVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZWRDb3VudChjb250ZXh0KTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGRlbGV0ZWRDb3VudCkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuIHx8IGRlbGV0ZWRDb3VudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKCdPbmUgb2YgdGhlIHVuaXF1ZSBrZXkgZmllbGQgYXMgcXVlcnkgY29uZGl0aW9uIGlzIG51bGwuIENvbmRpdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSB2YWx1ZSBwYWlyIGluIHRoZSBxdWVyeSBjb25kaXRpb24uJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkID0gdHJ1ZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZyA9IGNvbnRleHQub3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgXy5pc0VtcHR5KGV4aXN0aW5nKSAmJiAodGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykgfHwgb3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAob3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nICYmICFjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgbGV0IHZhbHVlLCB1c2VSYXcgPSBmYWxzZTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZSA9IHJhd1tmaWVsZE5hbWVdO1xuICAgICAgICAgICAgICAgIHVzZVJhdyA9IHRydWU7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSBpbiBsYXRlc3QpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZSA9IGxhdGVzdFtmaWVsZE5hbWVdO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5ICYmIHVzZVJhdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wT3B0aW9ucy4kbWlncmF0aW9uICYmICghaXNVcGRhdGluZyB8fCFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5IHx8ICFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5LCBjaGVjayB3cml0ZVByb3RlY3QgXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvWydkZWZhdWx0J10pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvWydkZWZhdWx0J107XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHZhbHVlLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5zdGFjayAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYiB8fCBmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmllbGQgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWZpZWxkSW5mby5oYXNBY3RpdmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9za2lwIHRob3NlIGhhdmUgYWN0aXZhdG9yc1xuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmF3IFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGF0ZXN0ID0gY29udGV4dC5sYXRlc3QgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzLCB0cnVlKTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBpZiAoIW9wT3B0aW9ucy4kc2tpcE1vZGlmaWVycykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG4gICAgICAgIH1cblxuICAgICAgICAvL2ZpbmFsIHJvdW5kIHByb2Nlc3MgYmVmb3JlIGVudGVyaW5nIGRhdGFiYXNlXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gXy5tYXBWYWx1ZXMobGF0ZXN0LCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbHVlID09IG51bGwpIHJldHVybiB2YWx1ZTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIC8vdGhlcmUgaXMgc3BlY2lhbCBpbnB1dCBjb2x1bW4gd2hpY2ggbWF5YmUgYSBmdW5jdGlvbiBvciBhbiBleHByZXNzaW9uXG4gICAgICAgICAgICAgICAgb3BPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29tbWl0IG9yIHJvbGxiYWNrIGlzIGNhbGxlZCBpZiB0cmFuc2FjdGlvbiBpcyBjcmVhdGVkIHdpdGhpbiB0aGUgZXhlY3V0b3IuXG4gICAgICogQHBhcmFtIHsqfSBleGVjdXRvciBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYFJvbGxiYWNrZWQsIHJlYXNvbjogJHtlcnJvci5tZXNzYWdlfWAsIHsgIFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBjb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIHJhd0RhdGE6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3REYXRhOiBjb250ZXh0LmxhdGVzdFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZGVuY3lDaGFuZ2VkKGZpZWxkTmFtZSwgY29udGV4dCkge1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llc1tmaWVsZE5hbWVdO1xuXG4gICAgICAgIHJldHVybiBfLmZpbmQoZGVwcywgZCA9PiBfLmlzUGxhaW5PYmplY3QoZCkgPyBoYXNLZXlCeVBhdGgoY29udGV4dCwgZC5yZWZlcmVuY2UpIDogaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQpKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3JlZmVyZW5jZUV4aXN0KGlucHV0LCByZWYpIHtcbiAgICAgICAgbGV0IHBvcyA9IHJlZi5pbmRleE9mKCcuJyk7XG5cbiAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiByZWYuc3Vic3RyKHBvcysxKSBpbiBpbnB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWYgaW4gaW5wdXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG51bGxEZXBlbmRzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4gXG4gICAgICAgICAgICAgICAgXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkLndoZW5OdWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoaW5wdXRbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbERlcGVuZHMuYWRkKGRlcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkID0gZC5yZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmllbGROYW1lIGluIGlucHV0ICYmICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZCk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IGRlcCBvZiBudWxsRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIGlmIChfLmZpbmQoZGVwLCBkID0+ICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZC5yZWZlcmVuY2UpKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgIFxuICAgICAgICAgICAgICAgICAgICBrZXlGaWVsZHM6IHRoaXMubWV0YS5rZXlGaWVsZCAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBpbnB1dEtleUZpZWxkOiBrZXlGaWVsZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICAvL3dpbGwgdXBkYXRlIGNvbnRleHQucmF3IGlmIGFwcGxpY2FibGVcbiAgICBzdGF0aWMgYXN5bmMgX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgLy93aWxsIHVwZGF0ZSBjb250ZXh0LnJhdyBpZiBhcHBsaWNhYmxlXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IgJiYga1swXSAhPT0gJyQnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHsgIFxuICAgICAgICAgICAgbGV0IHJldCA9IHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikpO1xuICAgICAgICAgICAgcmV0dXJuIGFycmF5VG9Jbk9wZXJhdG9yID8geyAkaW46IHJldCB9IDogcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBUeXBlQ2FzdCkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci50eXBlQ2FzdCh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==
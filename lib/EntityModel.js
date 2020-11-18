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

const JES = require('./utils/jes');

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
    const result = await this._safeExecute_(async context => {
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

    if (findOptions.$transformer) {
      return JES.evaluate(result, findOptions.$transformer);
    }

    return result;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJvcCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsInJlc3VsdCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwiJHRyYW5zZm9ybWVyIiwiZXZhbHVhdGUiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJvdyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsInJlZmVyZW5jZXMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJuZWVkQ3JlYXRlQXNzb2NzIiwiX2NyZWF0ZUFzc29jc18iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIiR1cHNlcnQiLCJ1cHNlcnRPbmVfIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsInRvVXBkYXRlIiwiYmVmb3JlVXBkYXRlXyIsImJlZm9yZVVwZGF0ZU1hbnlfIiwibmVlZFVwZGF0ZUFzc29jcyIsImRvbmVVcGRhdGVBc3NvY3MiLCJfdXBkYXRlQXNzb2NzXyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIm90aGVyT3B0aW9ucyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsImRlbGV0ZUFsbF8iLCIkZGVsZXRlQWxsIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVkQ291bnQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIlJVTEVfQUZURVJfREVMRVRFIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiSlNPTiIsInN0cmluZ2lmeSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJSVUxFX0JFRk9SRV9WQUxJREFUSU9OIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJ1c2VSYXciLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1RLEtBQUssR0FBR1IsT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFUyxFQUFBQSxlQUFGO0FBQW1CQyxFQUFBQSxhQUFuQjtBQUFrQ0MsRUFBQUE7QUFBbEMsSUFBc0ROLE1B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QUFtQ0MsWUFBbkMsRUFBaURDLGlCQUFqRCxDQUFmLENBQVY7QUFDQSxhQUFPQSxpQkFBaUIsR0FBRztBQUFFTSxRQUFBQSxHQUFHLEVBQUUzSztBQUFQLE9BQUgsR0FBa0JBLEdBQTFDO0FBQ0g7O0FBRUQsUUFBSW9LLFlBQUosRUFBa0IsT0FBT3JFLEtBQVA7QUFFbEIsV0FBTyxLQUFLekksRUFBTCxDQUFRQyxTQUFSLENBQWtCcU4sUUFBbEIsQ0FBMkI3RSxLQUEzQixDQUFQO0FBQ0g7O0FBdnhDYTs7QUEweENsQjhFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQm5RLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcsIGhhc1ZhbHVlSW4gfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuY29uc3QgSkVTID0gcmVxdWlyZSgnLi91dGlscy9qZXMnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG5mdW5jdGlvbiBtaW5pZnlBc3NvY3MoYXNzb2NzKSB7XG4gICAgbGV0IHNvcnRlZCA9IF8udW5pcShhc3NvY3MpLnNvcnQoKS5yZXZlcnNlKCk7XG5cbiAgICBsZXQgbWluaWZpZWQgPSBfLnRha2Uoc29ydGVkLCAxKSwgbCA9IHNvcnRlZC5sZW5ndGggLSAxO1xuXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgbGV0IGsgPSBzb3J0ZWRbaV0gKyAnLic7XG5cbiAgICAgICAgaWYgKCFfLmZpbmQobWluaWZpZWQsIGEgPT4gYS5zdGFydHNXaXRoKGspKSkge1xuICAgICAgICAgICAgbWluaWZpZWQucHVzaChzb3J0ZWRbaV0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG1pbmlmaWVkO1xufVxuXG5jb25zdCBvb3JUeXBlc1RvQnlwYXNzID0gbmV3IFNldChbJ0NvbHVtblJlZmVyZW5jZScsICdGdW5jdGlvbicsICdCaW5hcnlFeHByZXNzaW9uJywgJ0RhdGFTZXQnLCAnU1FMJ10pO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBmaWVsZE1ldGEobmFtZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmZpZWxkc1tuYW1lXTtcbiAgICAgICAgaWYgKCFtZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBVa25vd24gZmllbGQgXCIke25hbWV9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBfLm9taXQobWV0YSwgWydkZWZhdWx0J10pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCwgZGVmYXVsdFZhbHVlKSB7XG4gICAgICAgIGxldCBub2RlcyA9IChBcnJheS5pc0FycmF5KGtleVBhdGgpID8ga2V5UGF0aCA6IGtleVBhdGguc3BsaXQoJy4nKSkubWFwKGtleSA9PiBrZXlbMF0gPT09ICc6JyA/IGtleSA6ICgnOicgKyBrZXkpKTtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwgbm9kZXMsIGRlZmF1bHRWYWx1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKiB7c3RyaW5nfSBba2V5XSAtIFRoZSBrZXkgZmllbGQgdG8gdXNlZCBieSB0aGUgaGFzaHRhYmxlLlxuICAgICAqIHthcnJheX0gW2Fzc29jaWF0aW9uc10gLSBXaXRoIGFuIGFycmF5IG9mIGFzc29jaWF0aW9ucy5cbiAgICAgKiB7b2JqZWN0fSBbY29ubk9wdGlvbnNdIC0gQ29ubmVjdGlvbiBvcHRpb25zLCBlLmcuIHRyYW5zYWN0aW9uIGhhbmRsZVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY29tYmluZWRLZXkgPSBrZXk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBjb21iaW5lZEtleSArPSAnLycgKyBtaW5pZnlBc3NvY3MoYXNzb2NpYXRpb25zKS5qb2luKCcmJylcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkYXNzb2NpYXRpb246IGFzc29jaWF0aW9ucywgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiB0aGlzLmNhY2hlZF8odGhpcy5tZXRhLmtleUZpZWxkLCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdG9EaWN0aW9uYXJ5KGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpIHtcbiAgICAgICAga2V5IHx8IChrZXkgPSB0aGlzLm1ldGEua2V5RmllbGQpO1xuXG4gICAgICAgIHJldHVybiBDb252ZXJ0b3JzLnRvS1ZQYWlycyhlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXJdIC0gVHJhbnNmb3JtIGZpZWxkcyBiZWZvcmUgcmV0dXJuaW5nXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIHByZTogZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZmluZCcsXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikge1xuICAgICAgICAgICAgcmV0dXJuIEpFUy5ldmFsdWF0ZShyZXN1bHQsIGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcik7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXJdIC0gVHJhbnNmb3JtIGZpZWxkcyBiZWZvcmUgcmV0dXJuaW5nXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2ZpbmQnLCAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpbmRPcHRpb25zLiRza2lwT3JtKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikge1xuICAgICAgICAgICAgcm93cyA9IHJvd3MubWFwKHJvdyA9PiBKRVMuZXZhbHVhdGUocm93LCBmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiR1cHNlcnQ9ZmFsc2VdIC0gSWYgYWxyZWFkeSBleGlzdCwganVzdCB1cGRhdGUgdGhlIHJlY29yZC4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCFjcmVhdGVPcHRpb25zKSB7IFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyA9IHt9OyBcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zLCByZWZlcmVuY2VzIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIHRydWUpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2NyZWF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkocmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcyk7ICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL2NoZWNrIGFueSBvdGhlciBhc3NvY2lhdGlvbnMgbGVmdFxuICAgICAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIShhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR1cHNlcnQpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwc2VydE9uZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oY29udGV4dC5sYXRlc3QpLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHVwc2VydFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0NSRUFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIG1hbnkgZXhpc3RpbmcgZW50aXRlcyB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICAvL2lmIG5vIGNvbmRpdGlvbiBnaXZlbiwgZXh0cmFjdCBmcm9tIGRhdGEgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhc3NvY2lhdGVkIGVudGl0eSBkYXRhIHByb3ZpZGVkIHRvZ2V0aGVyXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zLCByZWZlcmVuY2VzIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIG9wOiAndXBkYXRlJyxcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKSwgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5PcHRpb25zLFxuICAgICAgICAgICAgZm9yU2luZ2xlUmVjb3JkXG4gICAgICAgIH07ICAgICAgICAgICAgICAgXG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYW55IHJ1bnRpbWUgZmVhdHVyZSBzdG9wcGluZyB0aGUgdXBkYXRlXG4gICAgICAgIGxldCB0b1VwZGF0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkocmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcyk7ICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIGxldCBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgbGV0IGRvbmVVcGRhdGVBc3NvY3M7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgdXBkYXRlICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgZG9uZVVwZGF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovLCBmb3JTaW5nbGVSZWNvcmQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQubGF0ZXN0KSkge1xuICAgICAgICAgICAgICAgIGlmICghZG9uZVVwZGF0ZUFzc29jcyAmJiAhbmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgZG8gdGhlIHVwZGF0ZSB3aXRoIGVtcHR5IHJlY29yZC4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgIWhhc1ZhbHVlSW4oWyRxdWVyeSwgY29udGV4dC5sYXRlc3RdLCB0aGlzLm1ldGEua2V5RmllbGQpICYmICFvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBhc3NvY2lhdGVkIGRhdGEgZGVwZW5kaW5nIG9uIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuXG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKCRxdWVyeSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIG9wOiAncmVwbGFjZScsXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbD1mYWxzZV0gLSBXaGVuICRkZWxldGVBbGwgPSB0cnVlLCB0aGUgb3BlcmF0aW9uIHdpbGwgcHJvY2VlZCBldmVuIGVtcHR5IGNvbmRpdGlvbiBpcyBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlQWxsXyhjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5kZWxldGVNYW55Xyh7ICRkZWxldGVBbGw6IHRydWUgfSwgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkgJiYgKGZvclNpbmdsZVJlY29yZCB8fCAhZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2RlbGV0ZScsXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zLFxuICAgICAgICAgICAgZm9yU2luZ2xlUmVjb3JkXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgZGVsZXRlZENvdW50ID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAkcXVlcnksXG4gICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfREVMRVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZWRDb3VudChjb250ZXh0KTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGRlbGV0ZWRDb3VudCkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuIHx8IGRlbGV0ZWRDb3VudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKCdPbmUgb2YgdGhlIHVuaXF1ZSBrZXkgZmllbGQgYXMgcXVlcnkgY29uZGl0aW9uIGlzIG51bGwuIENvbmRpdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGNvbmRpdGlvbikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSB2YWx1ZSBwYWlyIGluIHRoZSBxdWVyeSBjb25kaXRpb24uJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSwgZm9yU2luZ2xlUmVjb3JkID0gdHJ1ZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZyA9IGNvbnRleHQub3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgXy5pc0VtcHR5KGV4aXN0aW5nKSAmJiAodGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykgfHwgb3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAob3BPcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nICYmICFjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgbGV0IHZhbHVlLCB1c2VSYXcgPSBmYWxzZTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZSA9IHJhd1tmaWVsZE5hbWVdO1xuICAgICAgICAgICAgICAgIHVzZVJhdyA9IHRydWU7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSBpbiBsYXRlc3QpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZSA9IGxhdGVzdFtmaWVsZE5hbWVdO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5ICYmIHVzZVJhdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wT3B0aW9ucy4kbWlncmF0aW9uICYmICghaXNVcGRhdGluZyB8fCFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5IHx8ICFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5LCBjaGVjayB3cml0ZVByb3RlY3QgXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvWydkZWZhdWx0J10pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvWydkZWZhdWx0J107XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHZhbHVlLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5zdGFjayAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYiB8fCBmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmllbGQgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWZpZWxkSW5mby5oYXNBY3RpdmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9za2lwIHRob3NlIGhhdmUgYWN0aXZhdG9yc1xuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmF3IFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGF0ZXN0ID0gY29udGV4dC5sYXRlc3QgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzLCB0cnVlKTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBpZiAoIW9wT3B0aW9ucy4kc2tpcE1vZGlmaWVycykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG4gICAgICAgIH1cblxuICAgICAgICAvL2ZpbmFsIHJvdW5kIHByb2Nlc3MgYmVmb3JlIGVudGVyaW5nIGRhdGFiYXNlXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gXy5tYXBWYWx1ZXMobGF0ZXN0LCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbHVlID09IG51bGwpIHJldHVybiB2YWx1ZTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIC8vdGhlcmUgaXMgc3BlY2lhbCBpbnB1dCBjb2x1bW4gd2hpY2ggbWF5YmUgYSBmdW5jdGlvbiBvciBhbiBleHByZXNzaW9uXG4gICAgICAgICAgICAgICAgb3BPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29tbWl0IG9yIHJvbGxiYWNrIGlzIGNhbGxlZCBpZiB0cmFuc2FjdGlvbiBpcyBjcmVhdGVkIHdpdGhpbiB0aGUgZXhlY3V0b3IuXG4gICAgICogQHBhcmFtIHsqfSBleGVjdXRvciBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYFJvbGxiYWNrZWQsIHJlYXNvbjogJHtlcnJvci5tZXNzYWdlfWAsIHsgIFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBjb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIHJhd0RhdGE6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3REYXRhOiBjb250ZXh0LmxhdGVzdFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZGVuY3lDaGFuZ2VkKGZpZWxkTmFtZSwgY29udGV4dCkge1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llc1tmaWVsZE5hbWVdO1xuXG4gICAgICAgIHJldHVybiBfLmZpbmQoZGVwcywgZCA9PiBfLmlzUGxhaW5PYmplY3QoZCkgPyBoYXNLZXlCeVBhdGgoY29udGV4dCwgZC5yZWZlcmVuY2UpIDogaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQpKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3JlZmVyZW5jZUV4aXN0KGlucHV0LCByZWYpIHtcbiAgICAgICAgbGV0IHBvcyA9IHJlZi5pbmRleE9mKCcuJyk7XG5cbiAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiByZWYuc3Vic3RyKHBvcysxKSBpbiBpbnB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWYgaW4gaW5wdXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG51bGxEZXBlbmRzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4gXG4gICAgICAgICAgICAgICAgXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkLndoZW5OdWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoaW5wdXRbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbERlcGVuZHMuYWRkKGRlcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkID0gZC5yZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmllbGROYW1lIGluIGlucHV0ICYmICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZCk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IGRlcCBvZiBudWxsRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIGlmIChfLmZpbmQoZGVwLCBkID0+ICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZC5yZWZlcmVuY2UpKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgIFxuICAgICAgICAgICAgICAgICAgICBrZXlGaWVsZHM6IHRoaXMubWV0YS5rZXlGaWVsZCAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBpbnB1dEtleUZpZWxkOiBrZXlGaWVsZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICAvL3dpbGwgdXBkYXRlIGNvbnRleHQucmF3IGlmIGFwcGxpY2FibGVcbiAgICBzdGF0aWMgYXN5bmMgX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgLy93aWxsIHVwZGF0ZSBjb250ZXh0LnJhdyBpZiBhcHBsaWNhYmxlXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IgJiYga1swXSAhPT0gJyQnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHsgIFxuICAgICAgICAgICAgbGV0IHJldCA9IHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikpO1xuICAgICAgICAgICAgcmV0dXJuIGFycmF5VG9Jbk9wZXJhdG9yID8geyAkaW46IHJldCB9IDogcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBUeXBlQ2FzdCkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci50eXBlQ2FzdCh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==
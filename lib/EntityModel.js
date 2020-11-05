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

    const result = this._safeExecute_(async context => {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJvcCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsInJlc3VsdCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwiJHRyYW5zZm9ybWVyIiwiZXZhbHVhdGUiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJvdyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsInJlZmVyZW5jZXMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJuZWVkQ3JlYXRlQXNzb2NzIiwiX2NyZWF0ZUFzc29jc18iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIiR1cHNlcnQiLCJ1cHNlcnRPbmVfIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsInRvVXBkYXRlIiwiYmVmb3JlVXBkYXRlXyIsImJlZm9yZVVwZGF0ZU1hbnlfIiwibmVlZFVwZGF0ZUFzc29jcyIsImRvbmVVcGRhdGVBc3NvY3MiLCJfdXBkYXRlQXNzb2NzXyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIm90aGVyT3B0aW9ucyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsImRlbGV0ZUFsbF8iLCIkZGVsZXRlQWxsIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVkQ291bnQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIlJVTEVfQUZURVJfREVMRVRFIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiSlNPTiIsInN0cmluZ2lmeSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJSVUxFX0JFRk9SRV9WQUxJREFUSU9OIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJ1c2VSYXciLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1RLEtBQUssR0FBR1IsT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFUyxFQUFBQSxlQUFGO0FBQW1CQyxFQUFBQSxhQUFuQjtBQUFrQ0MsRUFBQUE7QUFBbEMsSUFBc0ROLE1B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QW5DLEVBQWlEQyxpQkFBakQsQ0FBZixDQUFWO0FBQ0EsYUFBT0EsaUJBQWlCLEdBQUc7QUFBRU0sUUFBQUEsR0FBRyxFQUFFM0s7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUlvSyxZQUFKLEVBQWtCLE9BQU9yRSxLQUFQO0FBRWxCLFdBQU8sS0FBS3pJLEVBQUwsQ0FBUUMsU0FBUixDQUFrQnFOLFFBQWxCLENBQTJCN0UsS0FBM0IsQ0FBUDtBQUNIOztBQXZ4Q2E7O0FBMHhDbEI4RSxNQUFNLENBQUNDLE9BQVAsR0FBaUJuUSxXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18sIGdldFZhbHVlQnlQYXRoLCBoYXNLZXlCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgQ29udmVydG9ycyA9IHJlcXVpcmUoJy4vQ29udmVydG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IFZhbGlkYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nLCBoYXNWYWx1ZUluIH0gPSByZXF1aXJlKCcuL3V0aWxzL2xhbmcnKTtcbmNvbnN0IEpFUyA9IHJlcXVpcmUoJy4vdXRpbHMvamVzJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuY29uc3Qgb29yVHlwZXNUb0J5cGFzcyA9IG5ldyBTZXQoWydDb2x1bW5SZWZlcmVuY2UnLCAnRnVuY3Rpb24nLCAnQmluYXJ5RXhwcmVzc2lvbicsICdEYXRhU2V0JywgJ1NRTCddKTtcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZmllbGRNZXRhKG5hbWUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5maWVsZHNbbmFtZV07XG4gICAgICAgIGlmICghbWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVWtub3duIGZpZWxkIFwiJHtuYW1lfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYClcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gXy5vbWl0KG1ldGEsIFsnZGVmYXVsdCddKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCc7XG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBuZXN0ZWQgb2JqZWN0IG9mIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgsIGRlZmF1bHRWYWx1ZSkge1xuICAgICAgICBsZXQgbm9kZXMgPSAoQXJyYXkuaXNBcnJheShrZXlQYXRoKSA/IGtleVBhdGggOiBrZXlQYXRoLnNwbGl0KCcuJykpLm1hcChrZXkgPT4ga2V5WzBdID09PSAnOicgPyBrZXkgOiAoJzonICsga2V5KSk7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIG5vZGVzLCBkZWZhdWx0VmFsdWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICoge3N0cmluZ30gW2tleV0gLSBUaGUga2V5IGZpZWxkIHRvIHVzZWQgYnkgdGhlIGhhc2h0YWJsZS5cbiAgICAgKiB7YXJyYXl9IFthc3NvY2lhdGlvbnNdIC0gV2l0aCBhbiBhcnJheSBvZiBhc3NvY2lhdGlvbnMuXG4gICAgICoge29iamVjdH0gW2Nvbm5PcHRpb25zXSAtIENvbm5lY3Rpb24gb3B0aW9ucywgZS5nLiB0cmFuc2FjdGlvbiBoYW5kbGVcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXksIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNvbWJpbmVkS2V5ID0ga2V5O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgY29tYmluZWRLZXkgKz0gJy8nICsgbWluaWZ5QXNzb2NzKGFzc29jaWF0aW9ucykuam9pbignJicpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJGFzc29jaWF0aW9uOiBhc3NvY2lhdGlvbnMsICR0b0RpY3Rpb25hcnk6IGtleSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gdGhpcy5jYWNoZWRfKHRoaXMubWV0YS5rZXlGaWVsZCwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRvRGljdGlvbmFyeShlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKSB7XG4gICAgICAgIGtleSB8fCAoa2V5ID0gdGhpcy5tZXRhLmtleUZpZWxkKTtcblxuICAgICAgICByZXR1cm4gQ29udmVydG9ycy50b0tWUGFpcnMoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcik7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyXSAtIFRyYW5zZm9ybSBmaWVsZHMgYmVmb3JlIHJldHVybmluZ1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2ZpbmQnLFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlY29yZHMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBmaW5kT25lKCkgcmV0dXJucyBtb3JlIHRoYW4gb25lIHJlY29yZC5gLCB7IGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIG9wdGlvbnM6IGNvbnRleHQub3B0aW9ucyB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpIHtcbiAgICAgICAgICAgIHJldHVybiBKRVMuZXZhbHVhdGUocmVzdWx0LCBmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiByZWNvcmRzLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyXSAtIFRyYW5zZm9ybSBmaWVsZHMgYmVmb3JlIHJldHVybmluZ1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJywgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaW5kT3B0aW9ucy4kc2tpcE9ybSkge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpIHtcbiAgICAgICAgICAgIHJvd3MgPSByb3dzLm1hcChyb3cgPT4gSkVTLmV2YWx1YXRlKHJvdywgZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdXBzZXJ0PWZhbHNlXSAtIElmIGFscmVhZHkgZXhpc3QsIGp1c3QgdXBkYXRlIHRoZSByZWNvcmQuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucywgcmVmZXJlbmNlcyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCB0cnVlKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdjcmVhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpOyAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIGNyZWF0ZSAqLyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9jaGVjayBhbnkgb3RoZXIgYXNzb2NpYXRpb25zIGxlZnRcbiAgICAgICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cHNlcnRPbmVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGNvbnRleHQubGF0ZXN0KSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiR1cHNlcnRcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucywgcmVmZXJlbmNlcyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3VwZGF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpOyAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGxldCBkb25lVXBkYXRlQXNzb2NzO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIGRvbmVVcGRhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmxhdGVzdCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRvbmVVcGRhdGVBc3NvY3MgJiYgIW5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IGRvIHRoZSB1cGRhdGUgd2l0aCBlbXB0eSByZWNvcmQuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzICYmICFoYXNWYWx1ZUluKFskcXVlcnksIGNvbnRleHQubGF0ZXN0XSwgdGhpcy5tZXRhLmtleUZpZWxkKSAmJiAhb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICAvL3Nob3VsZCBlbnN1cmUgdGhlIGxhdGVzdCByZXN1bHQgd2lsbCBjb250YWluIHRoZSBrZXkgb2YgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgZmFsc2UsIGZvclNpbmdsZVJlY29yZCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3JlcGxhY2UnLFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRkZWxldGVBbGw9ZmFsc2VdIC0gV2hlbiAkZGVsZXRlQWxsID0gdHJ1ZSwgdGhlIG9wZXJhdGlvbiB3aWxsIHByb2NlZWQgZXZlbiBlbXB0eSBjb25kaXRpb24gaXMgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZUFsbF8oY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlTWFueV8oeyAkZGVsZXRlQWxsOiB0cnVlIH0sIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpICYmIChmb3JTaW5nbGVSZWNvcmQgfHwgIWRlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdkZWxldGUnLFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IGRlbGV0ZWRDb3VudCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVkQ291bnQoY29udGV4dCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChkZWxldGVkQ291bnQpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybiB8fCBkZWxldGVkQ291bnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgdmFsdWUgcGFpciBpbiB0aGUgcXVlcnkgY29uZGl0aW9uLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UsIGZvclNpbmdsZVJlY29yZCA9IHRydWUpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3RpbmcgPSBjb250ZXh0Lm9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIF8uaXNFbXB0eShleGlzdGluZykgJiYgKHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpIHx8IG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZyAmJiAhY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWx1ZSwgdXNlUmF3ID0gZmFsc2U7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICB1c2VSYXcgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgaW4gbGF0ZXN0KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBsYXRlc3RbZmllbGROYW1lXTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSAmJiB1c2VSYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seSB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mb1snZGVmYXVsdCddKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mb1snZGVmYXVsdCddO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2sgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIgfHwgZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vc2tpcCB0aG9zZSBoYXZlIGFjdGl2YXRvcnNcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJhdyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgaWYgKCFvcE9wdGlvbnMuJHNraXBNb2RpZmllcnMpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gdmFsdWU7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAvL3RoZXJlIGlzIHNwZWNpYWwgaW5wdXQgY29sdW1uIHdoaWNoIG1heWJlIGEgZnVuY3Rpb24gb3IgYW4gZXhwcmVzc2lvblxuICAgICAgICAgICAgICAgIG9wT3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucyA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBSb2xsYmFja2VkLCByZWFzb246ICR7ZXJyb3IubWVzc2FnZX1gLCB7ICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICByYXdEYXRhOiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0RGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRlbmN5Q2hhbmdlZChmaWVsZE5hbWUsIGNvbnRleHQpIHtcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXNbZmllbGROYW1lXTtcblxuICAgICAgICByZXR1cm4gXy5maW5kKGRlcHMsIGQgPT4gXy5pc1BsYWluT2JqZWN0KGQpID8gaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQucmVmZXJlbmNlKSA6IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkKSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9yZWZlcmVuY2VFeGlzdChpbnB1dCwgcmVmKSB7XG4gICAgICAgIGxldCBwb3MgPSByZWYuaW5kZXhPZignLicpO1xuXG4gICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmLnN1YnN0cihwb3MrMSkgaW4gaW5wdXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmIGluIGlucHV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBudWxsRGVwZW5kcyA9IG5ldyBTZXQoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IFxuICAgICAgICAgICAgICAgIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZC53aGVuTnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGlucHV0W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bGxEZXBlbmRzLmFkZChkZXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZCA9IGQucmVmZXJlbmNlO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSBpbiBpbnB1dCAmJiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGxldCBkZXAgb2YgbnVsbERlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5maW5kKGRlcCwgZCA9PiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQucmVmZXJlbmNlKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICBcbiAgICAgICAgICAgICAgICAgICAga2V5RmllbGRzOiB0aGlzLm1ldGEua2V5RmllbGQgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgIW9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzLCBudWxsLCB0cnVlKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKG5vcm1hbGl6ZWRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgY3JlYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGZpbmRBbGwgcHJvY2Vzc2luZ1xuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IHJlY29yZHMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcykge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSA9PT0gJ3N0cmluZycpIHsgXG4gICAgICAgICAgICAgICAga2V5RmllbGQgPSBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeTsgXG5cbiAgICAgICAgICAgICAgICBpZiAoIShrZXlGaWVsZCBpbiB0aGlzLm1ldGEuZmllbGRzKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgaW5wdXRLZXlGaWVsZDoga2V5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy50b0RpY3Rpb25hcnkocmVjb3Jkcywga2V5RmllbGQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiByZWNvcmRzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgLy93aWxsIHVwZGF0ZSBjb250ZXh0LnJhdyBpZiBhcHBsaWNhYmxlXG4gICAgc3RhdGljIGFzeW5jIF9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIC8vd2lsbCB1cGRhdGUgY29udGV4dC5yYXcgaWYgYXBwbGljYWJsZVxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9vclR5cGVzVG9CeXBhc3MuaGFzKHZhbHVlLm9vclR5cGUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodiwgaykgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpKTtcbiAgICAgICAgICAgIHJldHVybiBhcnJheVRvSW5PcGVyYXRvciA/IHsgJGluOiByZXQgfSA6IHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChza2lwVHlwZUNhc3QpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IudHlwZUNhc3QodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
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
      throw new InvalidArgument(`Unknown field "${name}" of entity "${this.meta.name}".`);
    }

    return _.omit(meta, ['default']);
  }

  static inputSchema(inputSetName, options) {
    const key = inputSetName + (options == null ? '{}' : JSON.stringify(options));

    if (this._cachedSchema) {
      const cache = this._cachedSchema[key];

      if (cache) {
        return cache;
      }
    } else {
      this._cachedSchema = {};
    }

    const schemaGenerator = this.db.require(`inputs/${this.meta.name}-${inputSetName}`);

    return this._cachedSchema[key] = schemaGenerator(options);
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

      if (rawOptions && rawOptions.$retrieveDbResult) {
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

      if (rawOptions && rawOptions.$retrieveDbResult) {
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

      this._fillResult(context);

      if (needCreateAssocs) {
        await this._createAssocs_(context, associations);
      }

      await this._internalAfterCreate_(context);

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
      }

      await Features.applyRules_(Rules.RULE_AFTER_CREATE, this, context);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImlucHV0U2NoZW1hIiwiaW5wdXRTZXROYW1lIiwib3B0aW9ucyIsImtleSIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY2FjaGVkU2NoZW1hIiwiY2FjaGUiLCJzY2hlbWFHZW5lcmF0b3IiLCJkYiIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJyYXdPcHRpb25zIiwiX3ByZXBhcmVRdWVyaWVzIiwib3AiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJyZXN1bHQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCIkcmVzdWx0Iiwic2xpY2UiLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwiJHRyYW5zZm9ybWVyIiwiZXZhbHVhdGUiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJvdyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwicmVmZXJlbmNlcyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJfcG9wdWxhdGVSZWZlcmVuY2VzXyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJfY3JlYXRlQXNzb2NzXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwiJHVwc2VydCIsInVwc2VydE9uZV8iLCJsYXRlc3QiLCJfZmlsbFJlc3VsdCIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIm5lZWRVcGRhdGVBc3NvY3MiLCJkb25lVXBkYXRlQXNzb2NzIiwiX3VwZGF0ZUFzc29jc18iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJvdGhlck9wdGlvbnMiLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJkZWxldGVBbGxfIiwiJGRlbGV0ZUFsbCIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlZENvdW50IiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJSVUxFX0JFRk9SRV9WQUxJREFUSU9OIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJ1c2VSYXciLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENB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cUJtQyxDQUFyQixFQUF3QmMsU0FBeEIsRUFBbUNDLFlBQW5DLEVBQWlEQyxpQkFBakQsQ0FBZixDQUFWO0FBQ0EsYUFBT0EsaUJBQWlCLEdBQUc7QUFBRU0sUUFBQUEsR0FBRyxFQUFFeks7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUlrSyxZQUFKLEVBQWtCLE9BQU9yRSxLQUFQO0FBRWxCLFdBQU8sS0FBS3ZLLEVBQUwsQ0FBUTZCLFNBQVIsQ0FBa0J1TixRQUFsQixDQUEyQjdFLEtBQTNCLENBQVA7QUFDSDs7QUFsekNhOztBQXF6Q2xCOEUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCNVEsV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCwgaGFzS2V5QnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IENvbnZlcnRvcnMgPSByZXF1aXJlKCcuL0NvbnZlcnRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZywgaGFzVmFsdWVJbiB9ID0gcmVxdWlyZSgnLi91dGlscy9sYW5nJyk7XG5jb25zdCBKRVMgPSByZXF1aXJlKCdAZ2VueC9qZXMnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG5mdW5jdGlvbiBtaW5pZnlBc3NvY3MoYXNzb2NzKSB7XG4gICAgbGV0IHNvcnRlZCA9IF8udW5pcShhc3NvY3MpLnNvcnQoKS5yZXZlcnNlKCk7XG5cbiAgICBsZXQgbWluaWZpZWQgPSBfLnRha2Uoc29ydGVkLCAxKSwgbCA9IHNvcnRlZC5sZW5ndGggLSAxO1xuXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgbGV0IGsgPSBzb3J0ZWRbaV0gKyAnLic7XG5cbiAgICAgICAgaWYgKCFfLmZpbmQobWluaWZpZWQsIGEgPT4gYS5zdGFydHNXaXRoKGspKSkge1xuICAgICAgICAgICAgbWluaWZpZWQucHVzaChzb3J0ZWRbaV0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG1pbmlmaWVkO1xufVxuXG5jb25zdCBvb3JUeXBlc1RvQnlwYXNzID0gbmV3IFNldChbJ0NvbHVtblJlZmVyZW5jZScsICdGdW5jdGlvbicsICdCaW5hcnlFeHByZXNzaW9uJywgJ0RhdGFTZXQnLCAnU1FMJ10pO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBmaWVsZE1ldGEobmFtZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmZpZWxkc1tuYW1lXTtcbiAgICAgICAgaWYgKCFtZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBVbmtub3duIGZpZWxkIFwiJHtuYW1lfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYClcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gXy5vbWl0KG1ldGEsIFsnZGVmYXVsdCddKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW5wdXRTY2hlbWEoaW5wdXRTZXROYW1lLCBvcHRpb25zKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICBjb25zdCBrZXkgPSBpbnB1dFNldE5hbWUgKyAob3B0aW9ucyA9PSBudWxsID8gJ3t9JyA6IEpTT04uc3RyaW5naWZ5KG9wdGlvbnMpKTtcblxuICAgICAgICBpZiAodGhpcy5fY2FjaGVkU2NoZW1hKSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuX2NhY2hlZFNjaGVtYVtrZXldO1xuICAgICAgICAgICAgaWYgKGNhY2hlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkU2NoZW1hID0ge307XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzY2hlbWFHZW5lcmF0b3IgPSB0aGlzLmRiLnJlcXVpcmUoYGlucHV0cy8ke3RoaXMubWV0YS5uYW1lfS0ke2lucHV0U2V0TmFtZX1gKTtcblxuICAgICAgICByZXR1cm4gKHRoaXMuX2NhY2hlZFNjaGVtYVtrZXldID0gc2NoZW1hR2VuZXJhdG9yKG9wdGlvbnMpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCc7XG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBuZXN0ZWQgb2JqZWN0IG9mIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgsIGRlZmF1bHRWYWx1ZSkge1xuICAgICAgICBsZXQgbm9kZXMgPSAoQXJyYXkuaXNBcnJheShrZXlQYXRoKSA/IGtleVBhdGggOiBrZXlQYXRoLnNwbGl0KCcuJykpLm1hcChrZXkgPT4ga2V5WzBdID09PSAnOicgPyBrZXkgOiAoJzonICsga2V5KSk7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIG5vZGVzLCBkZWZhdWx0VmFsdWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICoge3N0cmluZ30gW2tleV0gLSBUaGUga2V5IGZpZWxkIHRvIHVzZWQgYnkgdGhlIGhhc2h0YWJsZS5cbiAgICAgKiB7YXJyYXl9IFthc3NvY2lhdGlvbnNdIC0gV2l0aCBhbiBhcnJheSBvZiBhc3NvY2lhdGlvbnMuXG4gICAgICoge29iamVjdH0gW2Nvbm5PcHRpb25zXSAtIENvbm5lY3Rpb24gb3B0aW9ucywgZS5nLiB0cmFuc2FjdGlvbiBoYW5kbGVcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXksIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNvbWJpbmVkS2V5ID0ga2V5O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgY29tYmluZWRLZXkgKz0gJy8nICsgbWluaWZ5QXNzb2NzKGFzc29jaWF0aW9ucykuam9pbignJicpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJGFzc29jaWF0aW9uOiBhc3NvY2lhdGlvbnMsICR0b0RpY3Rpb25hcnk6IGtleSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gdGhpcy5jYWNoZWRfKHRoaXMubWV0YS5rZXlGaWVsZCwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRvRGljdGlvbmFyeShlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKSB7XG4gICAgICAgIGtleSB8fCAoa2V5ID0gdGhpcy5tZXRhLmtleUZpZWxkKTtcblxuICAgICAgICByZXR1cm4gQ29udmVydG9ycy50b0tWUGFpcnMoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcik7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyXSAtIFRyYW5zZm9ybSBmaWVsZHMgYmVmb3JlIHJldHVybmluZ1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2ZpbmQnLFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChyYXdPcHRpb25zICYmIHJhd09wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByYXdPcHRpb25zLiRyZXN1bHQgPSByZWNvcmRzLnNsaWNlKDEpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgZmluZE9uZSgpIHJldHVybnMgbW9yZSB0aGFuIG9uZSByZWNvcmQuYCwgeyBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBvcHRpb25zOiBjb250ZXh0Lm9wdGlvbnMgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSB7XG4gICAgICAgICAgICByZXR1cm4gSkVTLmV2YWx1YXRlKHJlc3VsdCwgZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcl0gLSBUcmFuc2Zvcm0gZmllbGRzIGJlZm9yZSByZXR1cm5pbmdcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJywgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAocmF3T3B0aW9ucyAmJiByYXdPcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgcmF3T3B0aW9ucy4kcmVzdWx0ID0gcmVjb3Jkcy5zbGljZSgxKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmluZE9wdGlvbnMuJHNraXBPcm0pIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSB7XG4gICAgICAgICAgICByb3dzID0gcm93cy5tYXAocm93ID0+IEpFUy5ldmFsdWF0ZShyb3csIGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVwc2VydD1mYWxzZV0gLSBJZiBhbHJlYWR5IGV4aXN0LCBqdXN0IHVwZGF0ZSB0aGUgcmVjb3JkLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIWNyZWF0ZU9wdGlvbnMpIHsgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zID0ge307IFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMsIHJlZmVyZW5jZXMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgdHJ1ZSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnY3JlYXRlJyxcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShyZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKTsgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSBjcmVhdGUgKi8pOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vY2hlY2sgYW55IG90aGVyIGFzc29jaWF0aW9ucyBsZWZ0XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBzZXJ0T25lXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShjb250ZXh0LmxhdGVzdCksXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX2ZpbGxSZXN1bHQoY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIC8vaWYgbm8gY29uZGl0aW9uIGdpdmVuLCBleHRyYWN0IGZyb20gZGF0YSBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFzc29jaWF0ZWQgZW50aXR5IGRhdGEgcHJvdmlkZWQgdG9nZXRoZXJcbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMsIHJlZmVyZW5jZXMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3A6ICd1cGRhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTsgICAgICAgICAgICAgICBcblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhbnkgcnVudGltZSBmZWF0dXJlIHN0b3BwaW5nIHRoZSB1cGRhdGVcbiAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShyZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKTsgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgbGV0IG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBsZXQgZG9uZVVwZGF0ZUFzc29jcztcblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSB1cGRhdGUgKi8sIGZvclNpbmdsZVJlY29yZCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgICAgICBkb25lVXBkYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8sIGZvclNpbmdsZVJlY29yZCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmxhdGVzdCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRvbmVVcGRhdGVBc3NvY3MgJiYgIW5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IGRvIHRoZSB1cGRhdGUgd2l0aCBlbXB0eSByZWNvcmQuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzICYmICFoYXNWYWx1ZUluKFskcXVlcnksIGNvbnRleHQubGF0ZXN0XSwgdGhpcy5tZXRhLmtleUZpZWxkKSAmJiAhb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICAvL3Nob3VsZCBlbnN1cmUgdGhlIGxhdGVzdCByZXN1bHQgd2lsbCBjb250YWluIHRoZSBrZXkgb2YgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3A6ICdyZXBsYWNlJyxcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsPWZhbHNlXSAtIFdoZW4gJGRlbGV0ZUFsbCA9IHRydWUsIHRoZSBvcGVyYXRpb24gd2lsbCBwcm9jZWVkIGV2ZW4gZW1wdHkgY29uZGl0aW9uIGlzIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBkZWxldGVBbGxfKGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmRlbGV0ZU1hbnlfKHsgJGRlbGV0ZUFsbDogdHJ1ZSB9LCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSAmJiAoZm9yU2luZ2xlUmVjb3JkIHx8ICFkZWxldGVPcHRpb25zLiRkZWxldGVBbGwpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZGVsZXRlJyxcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9EZWxldGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBkZWxldGVkQ291bnQgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCB7ICRxdWVyeSwgLi4ub3RoZXJPcHRpb25zIH0gPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlZENvdW50KGNvbnRleHQpO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZGVsZXRlZENvdW50KSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm4gfHwgZGVsZXRlZENvdW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICBsZXQgaGFzS2V5TmFtZU9ubHkgPSBmYWxzZTtcblxuICAgICAgICBsZXQgaGFzTm90TnVsbEtleSA9IF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IHtcbiAgICAgICAgICAgIGxldCBoYXNLZXlzID0gXy5ldmVyeShmaWVsZHMsIGYgPT4gZiBpbiBkYXRhKTtcbiAgICAgICAgICAgIGhhc0tleU5hbWVPbmx5ID0gaGFzS2V5TmFtZU9ubHkgfHwgaGFzS2V5cztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgaGFzTm90TnVsbEtleSwgaGFzS2V5TmFtZU9ubHkgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBbIGNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUsIGNvbnRhaW5zVW5pcXVlS2V5T25seSBdID0gdGhpcy5fY29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKTsgICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zVW5pcXVlS2V5T25seSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4gQ29uZGl0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHZhbHVlIHBhaXIgaW4gdGhlIHF1ZXJ5IGNvbmRpdGlvbi4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQgPSB0cnVlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nID0gY29udGV4dC5vcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBfLmlzRW1wdHkoZXhpc3RpbmcpICYmICh0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSB8fCBvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcgJiYgIWNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdmFsdWUsIHVzZVJhdyA9IGZhbHNlO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gcmF3W2ZpZWxkTmFtZV07XG4gICAgICAgICAgICAgICAgdXNlUmF3ID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGROYW1lIGluIGxhdGVzdCkge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gbGF0ZXN0W2ZpZWxkTmFtZV07XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkgJiYgdXNlUmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BPcHRpb25zLiRtaWdyYXRpb24gJiYgKCFpc1VwZGF0aW5nIHx8IW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3ksIGNoZWNrIHdyaXRlUHJvdGVjdCBcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm9bJ2RlZmF1bHQnXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm9bJ2RlZmF1bHQnXTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUodmFsdWUsIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLnN0YWNrICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiIHx8IGZpZWxkSW5mby5oYXNBY3RpdmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBGaWVsZCBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICghZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAvL3NraXAgdGhvc2UgaGF2ZSBhY3RpdmF0b3JzXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgRmllbGQgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICByYXcgXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGlmICghb3BPcHRpb25zLiRza2lwTW9kaWZpZXJzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIHZhbHVlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgLy90aGVyZSBpcyBzcGVjaWFsIGlucHV0IGNvbHVtbiB3aGljaCBtYXliZSBhIGZ1bmN0aW9uIG9yIGFuIGV4cHJlc3Npb25cbiAgICAgICAgICAgICAgICBvcE9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZpZWxkSW5mbyA9IGZpZWxkc1trZXldO1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZEluZm87XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgUm9sbGJhY2tlZCwgcmVhc29uOiAke2Vycm9yLm1lc3NhZ2V9YCwgeyAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RGF0YTogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdERhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kZW5jeUNoYW5nZWQoZmllbGROYW1lLCBjb250ZXh0KSB7XG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzW2ZpZWxkTmFtZV07XG5cbiAgICAgICAgcmV0dXJuIF8uZmluZChkZXBzLCBkID0+IF8uaXNQbGFpbk9iamVjdChkKSA/IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBoYXNLZXlCeVBhdGgoY29udGV4dCwgZCkpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcmVmZXJlbmNlRXhpc3QoaW5wdXQsIHJlZikge1xuICAgICAgICBsZXQgcG9zID0gcmVmLmluZGV4T2YoJy4nKTtcblxuICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZi5zdWJzdHIocG9zKzEpIGluIGlucHV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZiBpbiBpbnB1dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbnVsbERlcGVuZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiBcbiAgICAgICAgICAgICAgICBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQud2hlbk51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChpbnB1dFtmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsRGVwZW5kcy5hZGQoZGVwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGQgPSBkLnJlZmVyZW5jZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWVsZE5hbWUgaW4gaW5wdXQgJiYgIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChsZXQgZGVwIG9mIG51bGxEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uZmluZChkZXAsIGQgPT4gIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkLnJlZmVyZW5jZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgXG4gICAgICAgICAgICAgICAgICAgIGtleUZpZWxkczogdGhpcy5tZXRhLmtleUZpZWxkICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcywgbnVsbCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBmaW5kQWxsIHByb2Nlc3NpbmdcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0S2V5RmllbGQ6IGtleUZpZWxkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMudG9EaWN0aW9uYXJ5KHJlY29yZHMsIGtleUZpZWxkKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIC8vd2lsbCB1cGRhdGUgY29udGV4dC5yYXcgaWYgYXBwbGljYWJsZVxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICAvL3dpbGwgdXBkYXRlIGNvbnRleHQucmF3IGlmIGFwcGxpY2FibGVcbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmIChvb3JUeXBlc1RvQnlwYXNzLmhhcyh2YWx1ZS5vb3JUeXBlKSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYsIGspID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvciAmJiBrWzBdICE9PSAnJCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgeyAgXG4gICAgICAgICAgICBsZXQgcmV0ID0gdmFsdWUubWFwKHYgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFR5cGVDYXN0KSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnR5cGVDYXN0KHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19
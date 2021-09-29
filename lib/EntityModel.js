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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImlucHV0U2NoZW1hIiwiaW5wdXRTZXROYW1lIiwib3B0aW9ucyIsImtleSIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY2FjaGVkU2NoZW1hIiwiY2FjaGUiLCJzY2hlbWFHZW5lcmF0b3IiLCJkYiIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJyYXdPcHRpb25zIiwiX3ByZXBhcmVRdWVyaWVzIiwib3AiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJyZXN1bHQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCIkcmVzdWx0Iiwic2xpY2UiLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCIkbmVzdGVkS2V5R2V0dGVyIiwibG9nIiwiZW50aXR5IiwiJHRyYW5zZm9ybWVyIiwiZXZhbHVhdGUiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJvdyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwicmVmZXJlbmNlcyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJfcG9wdWxhdGVSZWZlcmVuY2VzXyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJfY3JlYXRlQXNzb2NzXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwiJHVwc2VydCIsInVwc2VydE9uZV8iLCJsYXRlc3QiLCJfZmlsbFJlc3VsdCIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIm5lZWRVcGRhdGVBc3NvY3MiLCJkb25lVXBkYXRlQXNzb2NzIiwiX3VwZGF0ZUFzc29jc18iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJvdGhlck9wdGlvbnMiLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJkZWxldGVBbGxfIiwiJGRlbGV0ZUFsbCIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlZENvdW50IiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCIkZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiJHJldHJpZXZlRXhpc3RpbmciLCJSVUxFX0JFRk9SRV9WQUxJREFUSU9OIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJ1c2VSYXciLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiJHNraXBNb2RpZmllcnMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCIkcmVxdWlyZVNwbGl0Q29sdW1ucyIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsIm1lc3NhZ2UiLCJsYXRlc3REYXRhIiwicm9sbGJhY2tfIiwiX2RlcGVuZGVuY3lDaGFuZ2VkIiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiZCIsInJlZmVyZW5jZSIsIl9yZWZlcmVuY2VFeGlzdCIsImlucHV0IiwicmVmIiwicG9zIiwiaW5kZXhPZiIsInN1YnN0ciIsImhhc0RlcGVuZHMiLCJudWxsRGVwZW5kcyIsImRlcCIsIndoZW5OdWxsIiwiYWRkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsImZpZWxkIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrZXlGaWVsZHMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImlucHV0S2V5RmllbGQiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwVHlwZUNhc3QiLCJhcnJheVRvSW5PcGVyYXRvciIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCIkaW4iLCJ0eXBlQ2FzdCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBLGNBQWpCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFrREosT0FBTyxDQUFDLFVBQUQsQ0FBL0Q7O0FBQ0EsTUFBTUssTUFBTSxHQUFHTCxPQUFPLENBQUMsZ0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTU0sVUFBVSxHQUFHTixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTyxVQUFVLEdBQUdQLE9BQU8sQ0FBQyxjQUFELENB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R0FBRztBQUFFTSxRQUFBQSxHQUFHLEVBQUV6SztBQUFQLE9BQUgsR0FBa0JBLEdBQTFDO0FBQ0g7O0FBRUQsUUFBSWtLLFlBQUosRUFBa0IsT0FBT3JFLEtBQVA7QUFFbEIsV0FBTyxLQUFLdkssRUFBTCxDQUFRNkIsU0FBUixDQUFrQnVOLFFBQWxCLENBQTJCN0UsS0FBM0IsQ0FBUDtBQUNIOztBQWx6Q2E7O0FBcXpDbEI4RSxNQUFNLENBQUNDLE9BQVAsR0FBaUI1USxXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18sIGdldFZhbHVlQnlQYXRoLCBoYXNLZXlCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgQ29udmVydG9ycyA9IHJlcXVpcmUoJy4vQ29udmVydG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IFZhbGlkYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nLCBoYXNWYWx1ZUluIH0gPSByZXF1aXJlKCcuL3V0aWxzL2xhbmcnKTtcbmNvbnN0IEpFUyA9IHJlcXVpcmUoJ0BnZW54L2plcycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nLCAnRGF0YVNldCcsICdTUUwnXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIGRhdGFbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIGZpZWxkTWV0YShuYW1lKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuZmllbGRzW25hbWVdO1xuICAgICAgICBpZiAoIW1ldGEpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFVua25vd24gZmllbGQgXCIke25hbWV9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBfLm9taXQobWV0YSwgWydkZWZhdWx0J10pO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnB1dFNjaGVtYShpbnB1dFNldE5hbWUsIG9wdGlvbnMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgIGNvbnN0IGtleSA9IGlucHV0U2V0TmFtZSArIChvcHRpb25zID09IG51bGwgPyAne30nIDogSlNPTi5zdHJpbmdpZnkob3B0aW9ucykpO1xuXG4gICAgICAgIGlmICh0aGlzLl9jYWNoZWRTY2hlbWEpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gdGhpcy5fY2FjaGVkU2NoZW1hW2tleV07XG4gICAgICAgICAgICBpZiAoY2FjaGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FjaGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLl9jYWNoZWRTY2hlbWEgPSB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNjaGVtYUdlbmVyYXRvciA9IHRoaXMuZGIucmVxdWlyZShgaW5wdXRzLyR7dGhpcy5tZXRhLm5hbWV9LSR7aW5wdXRTZXROYW1lfWApO1xuXG4gICAgICAgIHJldHVybiAodGhpcy5fY2FjaGVkU2NoZW1hW2tleV0gPSBzY2hlbWFHZW5lcmF0b3Iob3B0aW9ucykpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCwgZGVmYXVsdFZhbHVlKSB7XG4gICAgICAgIGxldCBub2RlcyA9IChBcnJheS5pc0FycmF5KGtleVBhdGgpID8ga2V5UGF0aCA6IGtleVBhdGguc3BsaXQoJy4nKSkubWFwKGtleSA9PiBrZXlbMF0gPT09ICc6JyA/IGtleSA6ICgnOicgKyBrZXkpKTtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwgbm9kZXMsIGRlZmF1bHRWYWx1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKiB7c3RyaW5nfSBba2V5XSAtIFRoZSBrZXkgZmllbGQgdG8gdXNlZCBieSB0aGUgaGFzaHRhYmxlLlxuICAgICAqIHthcnJheX0gW2Fzc29jaWF0aW9uc10gLSBXaXRoIGFuIGFycmF5IG9mIGFzc29jaWF0aW9ucy5cbiAgICAgKiB7b2JqZWN0fSBbY29ubk9wdGlvbnNdIC0gQ29ubmVjdGlvbiBvcHRpb25zLCBlLmcuIHRyYW5zYWN0aW9uIGhhbmRsZVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY29tYmluZWRLZXkgPSBrZXk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBjb21iaW5lZEtleSArPSAnLycgKyBtaW5pZnlBc3NvY3MoYXNzb2NpYXRpb25zKS5qb2luKCcmJylcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkYXNzb2NpYXRpb246IGFzc29jaWF0aW9ucywgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiB0aGlzLmNhY2hlZF8odGhpcy5tZXRhLmtleUZpZWxkLCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdG9EaWN0aW9uYXJ5KGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpIHtcbiAgICAgICAga2V5IHx8IChrZXkgPSB0aGlzLm1ldGEua2V5RmllbGQpO1xuXG4gICAgICAgIHJldHVybiBDb252ZXJ0b3JzLnRvS1ZQYWlycyhlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXJdIC0gVHJhbnNmb3JtIGZpZWxkcyBiZWZvcmUgcmV0dXJuaW5nXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZmluZCcsXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKHJhd09wdGlvbnMgJiYgcmF3T3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgICAgIHJhd09wdGlvbnMuJHJlc3VsdCA9IHJlY29yZHMuc2xpY2UoMSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlY29yZHMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBmaW5kT25lKCkgcmV0dXJucyBtb3JlIHRoYW4gb25lIHJlY29yZC5gLCB7IGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIG9wdGlvbnM6IGNvbnRleHQub3B0aW9ucyB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpIHtcbiAgICAgICAgICAgIHJldHVybiBKRVMuZXZhbHVhdGUocmVzdWx0LCBmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiByZWNvcmRzLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyXSAtIFRyYW5zZm9ybSBmaWVsZHMgYmVmb3JlIHJldHVybmluZ1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgXG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2ZpbmQnLCAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChyYXdPcHRpb25zICYmIHJhd09wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByYXdPcHRpb25zLiRyZXN1bHQgPSByZWNvcmRzLnNsaWNlKDEpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaW5kT3B0aW9ucy4kc2tpcE9ybSkge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpIHtcbiAgICAgICAgICAgIHJvd3MgPSByb3dzLm1hcChyb3cgPT4gSkVTLmV2YWx1YXRlKHJvdywgZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdXBzZXJ0PWZhbHNlXSAtIElmIGFscmVhZHkgZXhpc3QsIGp1c3QgdXBkYXRlIHRoZSByZWNvcmQuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucywgcmVmZXJlbmNlcyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCB0cnVlKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdjcmVhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpOyAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykgeyAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIGNyZWF0ZSAqLyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9jaGVjayBhbnkgb3RoZXIgYXNzb2NpYXRpb25zIGxlZnRcbiAgICAgICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cHNlcnRPbmVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGNvbnRleHQubGF0ZXN0KSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiR1cHNlcnRcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fZmlsbFJlc3VsdChjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucywgcmVmZXJlbmNlcyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3VwZGF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpOyAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICBsZXQgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGxldCBkb25lVXBkYXRlQXNzb2NzO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIGRvbmVVcGRhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQubGF0ZXN0KSkge1xuICAgICAgICAgICAgICAgIGlmICghZG9uZVVwZGF0ZUFzc29jcyAmJiAhbmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgZG8gdGhlIHVwZGF0ZSB3aXRoIGVtcHR5IHJlY29yZC4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgIWhhc1ZhbHVlSW4oWyRxdWVyeSwgY29udGV4dC5sYXRlc3RdLCB0aGlzLm1ldGEua2V5RmllbGQpICYmICFvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBhc3NvY2lhdGVkIGRhdGEgZGVwZW5kaW5nIG9uIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKCRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgZmFsc2UsIGZvclNpbmdsZVJlY29yZCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3JlcGxhY2UnLFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRkZWxldGVBbGw9ZmFsc2VdIC0gV2hlbiAkZGVsZXRlQWxsID0gdHJ1ZSwgdGhlIG9wZXJhdGlvbiB3aWxsIHByb2NlZWQgZXZlbiBlbXB0eSBjb25kaXRpb24gaXMgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZUFsbF8oY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlTWFueV8oeyAkZGVsZXRlQWxsOiB0cnVlIH0sIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpICYmIChmb3JTaW5nbGVSZWNvcmQgfHwgIWRlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdkZWxldGUnLFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IGRlbGV0ZWRDb3VudCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVkQ291bnQoY29udGV4dCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChkZWxldGVkQ291bnQpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybiB8fCBkZWxldGVkQ291bnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgdmFsdWUgcGFpciBpbiB0aGUgcXVlcnkgY29uZGl0aW9uLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UsIGZvclNpbmdsZVJlY29yZCA9IHRydWUpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3RpbmcgPSBjb250ZXh0Lm9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIF8uaXNFbXB0eShleGlzdGluZykgJiYgKHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpIHx8IG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZyAmJiAhY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWx1ZSwgdXNlUmF3ID0gZmFsc2U7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICB1c2VSYXcgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgaW4gbGF0ZXN0KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBsYXRlc3RbZmllbGROYW1lXTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSAmJiB1c2VSYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seSB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mb1snZGVmYXVsdCddKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mb1snZGVmYXVsdCddO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2sgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIgfHwgZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vc2tpcCB0aG9zZSBoYXZlIGFjdGl2YXRvcnNcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGaWVsZCBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJhdyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgaWYgKCFvcE9wdGlvbnMuJHNraXBNb2RpZmllcnMpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gdmFsdWU7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAvL3RoZXJlIGlzIHNwZWNpYWwgaW5wdXQgY29sdW1uIHdoaWNoIG1heWJlIGEgZnVuY3Rpb24gb3IgYW4gZXhwcmVzc2lvblxuICAgICAgICAgICAgICAgIG9wT3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucyA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBSb2xsYmFja2VkLCByZWFzb246ICR7ZXJyb3IubWVzc2FnZX1gLCB7ICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICByYXdEYXRhOiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0RGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRlbmN5Q2hhbmdlZChmaWVsZE5hbWUsIGNvbnRleHQpIHtcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXNbZmllbGROYW1lXTtcblxuICAgICAgICByZXR1cm4gXy5maW5kKGRlcHMsIGQgPT4gXy5pc1BsYWluT2JqZWN0KGQpID8gaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQucmVmZXJlbmNlKSA6IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkKSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9yZWZlcmVuY2VFeGlzdChpbnB1dCwgcmVmKSB7XG4gICAgICAgIGxldCBwb3MgPSByZWYuaW5kZXhPZignLicpO1xuXG4gICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmLnN1YnN0cihwb3MrMSkgaW4gaW5wdXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmIGluIGlucHV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBudWxsRGVwZW5kcyA9IG5ldyBTZXQoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IFxuICAgICAgICAgICAgICAgIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZC53aGVuTnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGlucHV0W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bGxEZXBlbmRzLmFkZChkZXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZCA9IGQucmVmZXJlbmNlO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSBpbiBpbnB1dCAmJiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGxldCBkZXAgb2YgbnVsbERlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5maW5kKGRlcCwgZCA9PiAhdGhpcy5fcmVmZXJlbmNlRXhpc3QoaW5wdXQsIGQucmVmZXJlbmNlKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgICBcbiAgICAgICAgICAgICAgICAgICAga2V5RmllbGRzOiB0aGlzLm1ldGEua2V5RmllbGQgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgIW9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzLCBudWxsLCB0cnVlKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKG5vcm1hbGl6ZWRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgY3JlYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGZpbmRBbGwgcHJvY2Vzc2luZ1xuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IHJlY29yZHMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcykge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSA9PT0gJ3N0cmluZycpIHsgXG4gICAgICAgICAgICAgICAga2V5RmllbGQgPSBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeTsgXG5cbiAgICAgICAgICAgICAgICBpZiAoIShrZXlGaWVsZCBpbiB0aGlzLm1ldGEuZmllbGRzKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgaW5wdXRLZXlGaWVsZDoga2V5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy50b0RpY3Rpb25hcnkocmVjb3Jkcywga2V5RmllbGQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiByZWNvcmRzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgLy93aWxsIHVwZGF0ZSBjb250ZXh0LnJhdyBpZiBhcHBsaWNhYmxlXG4gICAgc3RhdGljIGFzeW5jIF9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIC8vd2lsbCB1cGRhdGUgY29udGV4dC5yYXcgaWYgYXBwbGljYWJsZVxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9vclR5cGVzVG9CeXBhc3MuaGFzKHZhbHVlLm9vclR5cGUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodiwgaykgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IpKTtcbiAgICAgICAgICAgIHJldHVybiBhcnJheVRvSW5PcGVyYXRvciA/IHsgJGluOiByZXQgfSA6IHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChza2lwVHlwZUNhc3QpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IudHlwZUNhc3QodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
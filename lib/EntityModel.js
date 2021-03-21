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

  static fieldSchema(name, extra) {
    const meta = this.meta.fields[name];

    if (!meta) {
      throw new InvalidArgument(`Unknown field "${name}" of entity "${this.meta.name}".`);
    }

    const schema = _.omit(meta, ['default']);

    if (extra) {
      Object.assign(schema, extra);
    }

    return schema;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIkpFUyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZFNjaGVtYSIsIm5hbWUiLCJleHRyYSIsImZpZWxkcyIsInNjaGVtYSIsIm9taXQiLCJpbnB1dFNjaGVtYSIsImlucHV0U2V0TmFtZSIsIm9wdGlvbnMiLCJrZXkiLCJKU09OIiwic3RyaW5naWZ5IiwiX2NhY2hlZFNjaGVtYSIsImNhY2hlIiwic2NoZW1hR2VuZXJhdG9yIiwiZGIiLCJnZXRVbmlxdWVLZXlGaWVsZHNGcm9tIiwidW5pcXVlS2V5cyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJ1a0ZpZWxkcyIsInBpY2siLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwiZGVmYXVsdFZhbHVlIiwibm9kZXMiLCJBcnJheSIsImlzQXJyYXkiLCJzcGxpdCIsIm1hcCIsImVuc3VyZVJldHJpZXZlQ3JlYXRlZCIsImNvbnRleHQiLCJjdXN0b21PcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiY29ubmVjdG9yIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJnZXRWYWx1ZUZyb21Db250ZXh0IiwiY2FjaGVkXyIsImFzc29jaWF0aW9ucyIsImNvbWJpbmVkS2V5IiwiaXNFbXB0eSIsImpvaW4iLCJjYWNoZWREYXRhIiwiX2NhY2hlZERhdGEiLCJmaW5kQWxsXyIsIiRhc3NvY2lhdGlvbiIsIiR0b0RpY3Rpb25hcnkiLCJ0b0RpY3Rpb25hcnkiLCJlbnRpdHlDb2xsZWN0aW9uIiwidHJhbnNmb3JtZXIiLCJ0b0tWUGFpcnMiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwicmF3T3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsIm9wIiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwicmVzdWx0IiwiX3NhZmVFeGVjdXRlXyIsInJlY29yZHMiLCJmaW5kXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwiJHJlc3VsdCIsInNsaWNlIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwiJG5lc3RlZEtleUdldHRlciIsImxvZyIsImVudGl0eSIsIiR0cmFuc2Zvcm1lciIsImV2YWx1YXRlIiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyb3ciLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsInJlZmVyZW5jZXMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJuZWVkQ3JlYXRlQXNzb2NzIiwiX2NyZWF0ZUFzc29jc18iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIiR1cHNlcnQiLCJ1cHNlcnRPbmVfIiwibGF0ZXN0IiwiX2ZpbGxSZXN1bHQiLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiYWZ0ZXJDcmVhdGVfIiwidXBkYXRlT25lXyIsInVwZGF0ZU9wdGlvbnMiLCIkYnlwYXNzUmVhZE9ubHkiLCJyZWFzb24iLCJfdXBkYXRlXyIsInVwZGF0ZU1hbnlfIiwiZm9yU2luZ2xlUmVjb3JkIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJuZWVkVXBkYXRlQXNzb2NzIiwiZG9uZVVwZGF0ZUFzc29jcyIsIl91cGRhdGVBc3NvY3NfIiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwib3RoZXJPcHRpb25zIiwidXBkYXRlXyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJSVUxFX0FGVEVSX1VQREFURSIsImFmdGVyVXBkYXRlXyIsImFmdGVyVXBkYXRlTWFueV8iLCJyZXBsYWNlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiZGVsZXRlT25lXyIsImRlbGV0ZU9wdGlvbnMiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwiZGVsZXRlQWxsXyIsIiRkZWxldGVBbGwiLCJ0b0RlbGV0ZSIsImJlZm9yZURlbGV0ZV8iLCJiZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZWRDb3VudCIsIlJVTEVfQkVGT1JFX0RFTEVURSIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiUlVMRV9BRlRFUl9ERUxFVEUiLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwiJGV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwiUlVMRV9CRUZPUkVfVkFMSURBVElPTiIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInZhbHVlIiwidXNlUmF3IiwicmVhZE9ubHkiLCIkbWlncmF0aW9uIiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwiaXNQbGFpbk9iamVjdCIsIm9vclR5cGUiLCJzYW5pdGl6ZSIsImVycm9yIiwic3RhY2siLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJoYXNBY3RpdmF0b3IiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiX3RyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsIiRza2lwTW9kaWZpZXJzIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJtZXNzYWdlIiwibGF0ZXN0RGF0YSIsInJvbGxiYWNrXyIsIl9kZXBlbmRlbmN5Q2hhbmdlZCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImQiLCJyZWZlcmVuY2UiLCJfcmVmZXJlbmNlRXhpc3QiLCJpbnB1dCIsInJlZiIsInBvcyIsImluZGV4T2YiLCJzdWJzdHIiLCJoYXNEZXBlbmRzIiwibnVsbERlcGVuZHMiLCJkZXAiLCJ3aGVuTnVsbCIsImFkZCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJmaWVsZCIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2Iiwia2V5RmllbGRzIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJpbnB1dEtleUZpZWxkIiwiRXJyb3IiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFR5cGVDYXN0IiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiJGluIiwidHlwZUNhc3QiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQSxjQUFqQjtBQUFpQ0MsRUFBQUE7QUFBakMsSUFBa0RKLE9BQU8sQ0FBQyxVQUFELENBQS9EOztBQUNBLE1BQU1LLE1BQU0sR0FBR0wsT0FBTyxDQUFDLGdCQUFELENBQXRCOztBQUNBLE1BQU1NLFVBQVUsR0FBR04sT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU8sVUFBVSxHQUFH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Q0FBN0IsQ0FBUDtBQUNIOztBQUVELFFBQUk2QyxLQUFLLENBQUNDLE9BQU4sQ0FBY3dKLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixVQUFJN0YsR0FBRyxHQUFHNkYsS0FBSyxDQUFDdEosR0FBTixDQUFVNE0sQ0FBQyxJQUFJLEtBQUtuQyxlQUFMLENBQXFCbUMsQ0FBckIsRUFBd0JjLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWpELENBQWYsQ0FBVjtBQUNBLGFBQU9BLGlCQUFpQixHQUFHO0FBQUVNLFFBQUFBLEdBQUcsRUFBRXpLO0FBQVAsT0FBSCxHQUFrQkEsR0FBMUM7QUFDSDs7QUFFRCxRQUFJa0ssWUFBSixFQUFrQixPQUFPckUsS0FBUDtBQUVsQixXQUFPLEtBQUt2SyxFQUFMLENBQVE2QixTQUFSLENBQWtCdU4sUUFBbEIsQ0FBMkI3RSxLQUEzQixDQUFQO0FBQ0g7O0FBaDBDYTs7QUFtMENsQjhFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjlRLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcsIGhhc1ZhbHVlSW4gfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuY29uc3QgSkVTID0gcmVxdWlyZSgnQGdlbngvamVzJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuY29uc3Qgb29yVHlwZXNUb0J5cGFzcyA9IG5ldyBTZXQoWydDb2x1bW5SZWZlcmVuY2UnLCAnRnVuY3Rpb24nLCAnQmluYXJ5RXhwcmVzc2lvbicsICdEYXRhU2V0JywgJ1NRTCddKTtcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIGZpZWxkIHNjaGVtYSBiYXNlZCBvbiB0aGUgbWV0YWRhdGEgb2YgdGhlIGZpZWxkLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gRmllbGQgbmFtZVxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZXh0cmFdIC0gRXh0cmEgc2NoZW1hIG9wdGlvbnNcbiAgICAgKiBAcmV0dXJuIHtvYmplY3R9IFNjaGVtYSBvYmplY3RcbiAgICAgKi9cbiAgICBzdGF0aWMgZmllbGRTY2hlbWEobmFtZSwgZXh0cmEpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5maWVsZHNbbmFtZV07XG4gICAgICAgIGlmICghbWV0YSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVW5rbm93biBmaWVsZCBcIiR7bmFtZX1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzY2hlbWEgPSBfLm9taXQobWV0YSwgWydkZWZhdWx0J10pO1xuICAgICAgICBpZiAoZXh0cmEpIHtcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oc2NoZW1hLCBleHRyYSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc2NoZW1hO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIG1hcCBvZiBmaWVsZHMgc2NoZW1hIGJ5IHByZWRlZmluZWQgaW5wdXQgc2V0LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBpbnB1dFNldE5hbWUgLSBJbnB1dCBzZXQgbmFtZSwgcHJlZGVmaW5lZCBpbiBnZW1sXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIElucHV0IHNldCBvcHRpb25zXG4gICAgICogQHJldHVybiB7b2JqZWN0fSBTY2hlbWEgb2JqZWN0XG4gICAgICovXG4gICAgc3RhdGljIGlucHV0U2NoZW1hKGlucHV0U2V0TmFtZSwgb3B0aW9ucykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgY29uc3Qga2V5ID0gaW5wdXRTZXROYW1lICsgKG9wdGlvbnMgPT0gbnVsbCA/ICd7fScgOiBKU09OLnN0cmluZ2lmeShvcHRpb25zKSk7XG5cbiAgICAgICAgaWYgKHRoaXMuX2NhY2hlZFNjaGVtYSkge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLl9jYWNoZWRTY2hlbWFba2V5XTtcbiAgICAgICAgICAgIGlmIChjYWNoZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuX2NhY2hlZFNjaGVtYSA9IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc2NoZW1hR2VuZXJhdG9yID0gdGhpcy5kYi5yZXF1aXJlKGBpbnB1dHMvJHt0aGlzLm1ldGEubmFtZX0tJHtpbnB1dFNldE5hbWV9YCk7XG5cbiAgICAgICAgcmV0dXJuICh0aGlzLl9jYWNoZWRTY2hlbWFba2V5XSA9IHNjaGVtYUdlbmVyYXRvcihvcHRpb25zKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoLCBkZWZhdWx0VmFsdWUpIHtcbiAgICAgICAgbGV0IG5vZGVzID0gKEFycmF5LmlzQXJyYXkoa2V5UGF0aCkgPyBrZXlQYXRoIDoga2V5UGF0aC5zcGxpdCgnLicpKS5tYXAoa2V5ID0+IGtleVswXSA9PT0gJzonID8ga2V5IDogKCc6JyArIGtleSkpO1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBub2RlcywgZGVmYXVsdFZhbHVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqIHtzdHJpbmd9IFtrZXldIC0gVGhlIGtleSBmaWVsZCB0byB1c2VkIGJ5IHRoZSBoYXNodGFibGUuXG4gICAgICoge2FycmF5fSBbYXNzb2NpYXRpb25zXSAtIFdpdGggYW4gYXJyYXkgb2YgYXNzb2NpYXRpb25zLlxuICAgICAqIHtvYmplY3R9IFtjb25uT3B0aW9uc10gLSBDb25uZWN0aW9uIG9wdGlvbnMsIGUuZy4gdHJhbnNhY3Rpb24gaGFuZGxlXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0b0RpY3Rpb25hcnkoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcikge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIENvbnZlcnRvcnMudG9LVlBhaXJzKGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcl0gLSBUcmFuc2Zvcm0gZmllbGRzIGJlZm9yZSByZXR1cm5pbmdcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAocmF3T3B0aW9ucyAmJiByYXdPcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgcmF3T3B0aW9ucy4kcmVzdWx0ID0gcmVjb3Jkcy5zbGljZSgxKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikge1xuICAgICAgICAgICAgcmV0dXJuIEpFUy5ldmFsdWF0ZShyZXN1bHQsIGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcik7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXJdIC0gVHJhbnNmb3JtIGZpZWxkcyBiZWZvcmUgcmV0dXJuaW5nXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICBcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZmluZCcsICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgICBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKHJhd09wdGlvbnMgJiYgcmF3T3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgICAgIHJhd09wdGlvbnMuJHJlc3VsdCA9IHJlY29yZHMuc2xpY2UoMSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpbmRPcHRpb25zLiRza2lwT3JtKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikge1xuICAgICAgICAgICAgcm93cyA9IHJvd3MubWFwKHJvdyA9PiBKRVMuZXZhbHVhdGUocm93LCBmaW5kT3B0aW9ucy4kdHJhbnNmb3JtZXIpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiR1cHNlcnQ9ZmFsc2VdIC0gSWYgYWxyZWFkeSBleGlzdCwganVzdCB1cGRhdGUgdGhlIHJlY29yZC4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCFjcmVhdGVPcHRpb25zKSB7IFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyA9IHt9OyBcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zLCByZWZlcmVuY2VzIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIHRydWUpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2NyZWF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkocmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcyk7ICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnMgPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL2NoZWNrIGFueSBvdGhlciBhc3NvY2lhdGlvbnMgbGVmdFxuICAgICAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIShhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR1cHNlcnQpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cHNlcnRPbmVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGNvbnRleHQubGF0ZXN0KSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiR1cHNlcnRcbiAgICAgICAgICAgICAgICApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX2ZpbGxSZXN1bHQoY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIC8vaWYgbm8gY29uZGl0aW9uIGdpdmVuLCBleHRyYWN0IGZyb20gZGF0YSBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFzc29jaWF0ZWQgZW50aXR5IGRhdGEgcHJvdmlkZWQgdG9nZXRoZXJcbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMsIHJlZmVyZW5jZXMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3A6ICd1cGRhdGUnLFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTsgICAgICAgICAgICAgICBcblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhbnkgcnVudGltZSBmZWF0dXJlIHN0b3BwaW5nIHRoZSB1cGRhdGVcbiAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShyZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKTsgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgbGV0IG5lZWRVcGRhdGVBc3NvY3MgPSAhXy5pc0VtcHR5KGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICBsZXQgZG9uZVVwZGF0ZUFzc29jcztcblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IGF3YWl0IHRoaXMuX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSB1cGRhdGUgKi8sIGZvclNpbmdsZVJlY29yZCk7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgICAgICBkb25lVXBkYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8sIGZvclNpbmdsZVJlY29yZCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmxhdGVzdCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRvbmVVcGRhdGVBc3NvY3MgJiYgIW5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IGRvIHRoZSB1cGRhdGUgd2l0aCBlbXB0eSByZWNvcmQuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzICYmICFoYXNWYWx1ZUluKFskcXVlcnksIGNvbnRleHQubGF0ZXN0XSwgdGhpcy5tZXRhLmtleUZpZWxkKSAmJiAhb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICAvL3Nob3VsZCBlbnN1cmUgdGhlIGxhdGVzdCByZXN1bHQgd2lsbCBjb250YWluIHRoZSBrZXkgb2YgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3A6ICdyZXBsYWNlJyxcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsPWZhbHNlXSAtIFdoZW4gJGRlbGV0ZUFsbCA9IHRydWUsIHRoZSBvcGVyYXRpb24gd2lsbCBwcm9jZWVkIGV2ZW4gZW1wdHkgY29uZGl0aW9uIGlzIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBkZWxldGVBbGxfKGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmRlbGV0ZU1hbnlfKHsgJGRlbGV0ZUFsbDogdHJ1ZSB9LCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSAmJiAoZm9yU2luZ2xlUmVjb3JkIHx8ICFkZWxldGVPcHRpb25zLiRkZWxldGVBbGwpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnZGVsZXRlJyxcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9EZWxldGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBkZWxldGVkQ291bnQgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCB7ICRxdWVyeSwgLi4ub3RoZXJPcHRpb25zIH0gPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlZENvdW50KGNvbnRleHQpO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZGVsZXRlZENvdW50KSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm4gfHwgZGVsZXRlZENvdW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICBsZXQgaGFzS2V5TmFtZU9ubHkgPSBmYWxzZTtcblxuICAgICAgICBsZXQgaGFzTm90TnVsbEtleSA9IF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IHtcbiAgICAgICAgICAgIGxldCBoYXNLZXlzID0gXy5ldmVyeShmaWVsZHMsIGYgPT4gZiBpbiBkYXRhKTtcbiAgICAgICAgICAgIGhhc0tleU5hbWVPbmx5ID0gaGFzS2V5TmFtZU9ubHkgfHwgaGFzS2V5cztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgaGFzTm90TnVsbEtleSwgaGFzS2V5TmFtZU9ubHkgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBbIGNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUsIGNvbnRhaW5zVW5pcXVlS2V5T25seSBdID0gdGhpcy5fY29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKTsgICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zVW5pcXVlS2V5T25seSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4gQ29uZGl0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHZhbHVlIHBhaXIgaW4gdGhlIHF1ZXJ5IGNvbmRpdGlvbi4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQgPSB0cnVlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nID0gY29udGV4dC5vcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBfLmlzRW1wdHkoZXhpc3RpbmcpICYmICh0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSB8fCBvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcgJiYgIWNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdmFsdWUsIHVzZVJhdyA9IGZhbHNlO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gcmF3W2ZpZWxkTmFtZV07XG4gICAgICAgICAgICAgICAgdXNlUmF3ID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGROYW1lIGluIGxhdGVzdCkge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gbGF0ZXN0W2ZpZWxkTmFtZV07XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkgJiYgdXNlUmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghb3BPcHRpb25zLiRtaWdyYXRpb24gJiYgKCFpc1VwZGF0aW5nIHx8IW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3ksIGNoZWNrIHdyaXRlUHJvdGVjdCBcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm9bJ2RlZmF1bHQnXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm9bJ2RlZmF1bHQnXTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUodmFsdWUsIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLnN0YWNrICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiIHx8IGZpZWxkSW5mby5oYXNBY3RpdmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBGaWVsZCBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICghZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAvL3NraXAgdGhvc2UgaGF2ZSBhY3RpdmF0b3JzXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgRmllbGQgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICByYXcgXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGlmICghb3BPcHRpb25zLiRza2lwTW9kaWZpZXJzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIHZhbHVlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgLy90aGVyZSBpcyBzcGVjaWFsIGlucHV0IGNvbHVtbiB3aGljaCBtYXliZSBhIGZ1bmN0aW9uIG9yIGFuIGV4cHJlc3Npb25cbiAgICAgICAgICAgICAgICBvcE9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZpZWxkSW5mbyA9IGZpZWxkc1trZXldO1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZEluZm87XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgUm9sbGJhY2tlZCwgcmVhc29uOiAke2Vycm9yLm1lc3NhZ2V9YCwgeyAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RGF0YTogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdERhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kZW5jeUNoYW5nZWQoZmllbGROYW1lLCBjb250ZXh0KSB7XG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzW2ZpZWxkTmFtZV07XG5cbiAgICAgICAgcmV0dXJuIF8uZmluZChkZXBzLCBkID0+IF8uaXNQbGFpbk9iamVjdChkKSA/IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBoYXNLZXlCeVBhdGgoY29udGV4dCwgZCkpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcmVmZXJlbmNlRXhpc3QoaW5wdXQsIHJlZikge1xuICAgICAgICBsZXQgcG9zID0gcmVmLmluZGV4T2YoJy4nKTtcblxuICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZi5zdWJzdHIocG9zKzEpIGluIGlucHV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZiBpbiBpbnB1dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbnVsbERlcGVuZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiBcbiAgICAgICAgICAgICAgICBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQud2hlbk51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChpbnB1dFtmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsRGVwZW5kcy5hZGQoZGVwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGQgPSBkLnJlZmVyZW5jZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWVsZE5hbWUgaW4gaW5wdXQgJiYgIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChsZXQgZGVwIG9mIG51bGxEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uZmluZChkZXAsIGQgPT4gIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkLnJlZmVyZW5jZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgXG4gICAgICAgICAgICAgICAgICAgIGtleUZpZWxkczogdGhpcy5tZXRhLmtleUZpZWxkICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcywgbnVsbCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBmaW5kQWxsIHByb2Nlc3NpbmdcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0S2V5RmllbGQ6IGtleUZpZWxkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMudG9EaWN0aW9uYXJ5KHJlY29yZHMsIGtleUZpZWxkKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIC8vd2lsbCB1cGRhdGUgY29udGV4dC5yYXcgaWYgYXBwbGljYWJsZVxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICAvL3dpbGwgdXBkYXRlIGNvbnRleHQucmF3IGlmIGFwcGxpY2FibGVcbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmIChvb3JUeXBlc1RvQnlwYXNzLmhhcyh2YWx1ZS5vb3JUeXBlKSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYsIGspID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvciAmJiBrWzBdICE9PSAnJCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgeyAgXG4gICAgICAgICAgICBsZXQgcmV0ID0gdmFsdWUubWFwKHYgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFR5cGVDYXN0KSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnR5cGVDYXN0KHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19
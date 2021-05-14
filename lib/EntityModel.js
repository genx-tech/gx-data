"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const {
  _,
  eachAsync_
} = require('@genx/july');

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
    return _.get(entityObj, nodes, defaultValue);
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
    return _.get(context, 'options.$variables.' + key);
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
    return _.find(deps, d => _.isPlainObject(d) ? _.hasIn(context, d.reference) : _.hasIn(context, d));
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsIkVycm9ycyIsIkdlbmVyYXRvcnMiLCJDb252ZXJ0b3JzIiwiVHlwZXMiLCJWYWxpZGF0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsImhhc1ZhbHVlSW4iLCJKRVMiLCJORUVEX09WRVJSSURFIiwibWluaWZ5QXNzb2NzIiwiYXNzb2NzIiwic29ydGVkIiwidW5pcSIsInNvcnQiLCJyZXZlcnNlIiwibWluaWZpZWQiLCJ0YWtlIiwibCIsImxlbmd0aCIsImkiLCJrIiwiZmluZCIsImEiLCJzdGFydHNXaXRoIiwicHVzaCIsIm9vclR5cGVzVG9CeXBhc3MiLCJTZXQiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsInZhbHVlT2ZLZXkiLCJkYXRhIiwibWV0YSIsImtleUZpZWxkIiwiZmllbGRTY2hlbWEiLCJuYW1lIiwiZXh0cmEiLCJmaWVsZHMiLCJzY2hlbWEiLCJvbWl0IiwiaW5wdXRTY2hlbWEiLCJpbnB1dFNldE5hbWUiLCJvcHRpb25zIiwia2V5IiwiSlNPTiIsInN0cmluZ2lmeSIsIl9jYWNoZWRTY2hlbWEiLCJjYWNoZSIsInNjaGVtYUdlbmVyYXRvciIsImRiIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsInVuaXF1ZUtleXMiLCJldmVyeSIsImYiLCJpc05pbCIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwidWtGaWVsZHMiLCJwaWNrIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsImRlZmF1bHRWYWx1ZSIsIm5vZGVzIiwiQXJyYXkiLCJpc0FycmF5Iiwic3BsaXQiLCJtYXAiLCJnZXQiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCJlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiZW5zdXJlUmV0cmlldmVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImNvbm5PcHRpb25zIiwiY29ubmVjdGlvbiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwidG9EaWN0aW9uYXJ5IiwiZW50aXR5Q29sbGVjdGlvbiIsInRyYW5zZm9ybWVyIiwidG9LVlBhaXJzIiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsInJhd09wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJvcCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsInJlc3VsdCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmV0cmlldmVEYlJlc3VsdCIsIiRyZXN1bHQiLCJzbGljZSIsIiRyZWxhdGlvbnNoaXBzIiwiJHNraXBPcm0iLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsIiRuZXN0ZWRLZXlHZXR0ZXIiLCJsb2ciLCJlbnRpdHkiLCIkdHJhbnNmb3JtZXIiLCJldmFsdWF0ZSIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicm93IiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJyZWZlcmVuY2VzIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJiZWZvcmVDcmVhdGVfIiwicmV0dXJuIiwic3VjY2VzcyIsIl9wb3B1bGF0ZVJlZmVyZW5jZXNfIiwibmVlZENyZWF0ZUFzc29jcyIsIl9jcmVhdGVBc3NvY3NfIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCIkdXBzZXJ0IiwidXBzZXJ0T25lXyIsImxhdGVzdCIsIl9maWxsUmVzdWx0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwicXVlcnlLZXkiLCJSVUxFX0FGVEVSX0NSRUFURSIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsInRvVXBkYXRlIiwiYmVmb3JlVXBkYXRlXyIsImJlZm9yZVVwZGF0ZU1hbnlfIiwibmVlZFVwZGF0ZUFzc29jcyIsImRvbmVVcGRhdGVBc3NvY3MiLCJfdXBkYXRlQXNzb2NzXyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIm90aGVyT3B0aW9ucyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsImRlbGV0ZUFsbF8iLCIkZGVsZXRlQWxsIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVkQ291bnQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIlJVTEVfQUZURVJfREVMRVRFIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJleGlzdGluZyIsIiRleGlzdGluZyIsIm9wT3B0aW9ucyIsIl9kZXBlbmRzT25FeGlzdGluZ0RhdGEiLCIkcmV0cmlldmVFeGlzdGluZyIsIlJVTEVfQkVGT1JFX1ZBTElEQVRJT04iLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJ2YWx1ZSIsInVzZVJhdyIsInJlYWRPbmx5IiwiJG1pZ3JhdGlvbiIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsImlzUGxhaW5PYmplY3QiLCJvb3JUeXBlIiwic2FuaXRpemUiLCJlcnJvciIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiaGFzQWN0aXZhdG9yIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIl90cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCIkc2tpcE1vZGlmaWVycyIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwibWVzc2FnZSIsImxhdGVzdERhdGEiLCJyb2xsYmFja18iLCJfZGVwZW5kZW5jeUNoYW5nZWQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJkIiwiaGFzSW4iLCJyZWZlcmVuY2UiLCJfcmVmZXJlbmNlRXhpc3QiLCJpbnB1dCIsInJlZiIsInBvcyIsImluZGV4T2YiLCJzdWJzdHIiLCJoYXNEZXBlbmRzIiwibnVsbERlcGVuZHMiLCJkZXAiLCJ3aGVuTnVsbCIsImFkZCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJmaWVsZCIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2Iiwia2V5RmllbGRzIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJpbnB1dEtleUZpZWxkIiwiRXJyb3IiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFR5cGVDYXN0IiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiJGluIiwidHlwZUNhc3QiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQW9CRixPQUFPLENBQUMsWUFBRCxDQUFqQzs7QUFDQSxNQUFNRyxNQUFNLEdBQUdILE9BQU8sQ0FBQyxnQkFBRCxDQUF0Qjs7QUFDQSxNQUFNSSxVQUFVLEdBQUdKLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMs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UDtBQUNIOztBQUVELFFBQUk2QyxLQUFLLENBQUNDLE9BQU4sQ0FBY3lKLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixVQUFJN0YsR0FBRyxHQUFHNkYsS0FBSyxDQUFDdkosR0FBTixDQUFVOE0sQ0FBQyxJQUFJLEtBQUtwQyxlQUFMLENBQXFCb0MsQ0FBckIsRUFBd0JjLFNBQXhCLEVBQW1DQyxZQUFuQyxFQUFpREMsaUJBQWpELENBQWYsQ0FBVjtBQUNBLGFBQU9BLGlCQUFpQixHQUFHO0FBQUVNLFFBQUFBLEdBQUcsRUFBRTFLO0FBQVAsT0FBSCxHQUFrQkEsR0FBMUM7QUFDSDs7QUFFRCxRQUFJbUssWUFBSixFQUFrQixPQUFPdEUsS0FBUDtBQUVsQixXQUFPLEtBQUt4SyxFQUFMLENBQVE4QixTQUFSLENBQWtCd04sUUFBbEIsQ0FBMkI5RSxLQUEzQixDQUFQO0FBQ0g7O0FBaDBDYTs7QUFtMENsQitFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmhSLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXyB9ID0gcmVxdWlyZSgnQGdlbngvanVseScpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IENvbnZlcnRvcnMgPSByZXF1aXJlKCcuL0NvbnZlcnRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZywgaGFzVmFsdWVJbiB9ID0gcmVxdWlyZSgnLi91dGlscy9sYW5nJyk7XG5jb25zdCBKRVMgPSByZXF1aXJlKCdAZ2VueC9qZXMnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG5mdW5jdGlvbiBtaW5pZnlBc3NvY3MoYXNzb2NzKSB7XG4gICAgbGV0IHNvcnRlZCA9IF8udW5pcShhc3NvY3MpLnNvcnQoKS5yZXZlcnNlKCk7XG5cbiAgICBsZXQgbWluaWZpZWQgPSBfLnRha2Uoc29ydGVkLCAxKSwgbCA9IHNvcnRlZC5sZW5ndGggLSAxO1xuXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgbGV0IGsgPSBzb3J0ZWRbaV0gKyAnLic7XG5cbiAgICAgICAgaWYgKCFfLmZpbmQobWluaWZpZWQsIGEgPT4gYS5zdGFydHNXaXRoKGspKSkge1xuICAgICAgICAgICAgbWluaWZpZWQucHVzaChzb3J0ZWRbaV0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG1pbmlmaWVkO1xufVxuXG5jb25zdCBvb3JUeXBlc1RvQnlwYXNzID0gbmV3IFNldChbJ0NvbHVtblJlZmVyZW5jZScsICdGdW5jdGlvbicsICdCaW5hcnlFeHByZXNzaW9uJywgJ0RhdGFTZXQnLCAnU1FMJ10pO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgZmllbGQgc2NoZW1hIGJhc2VkIG9uIHRoZSBtZXRhZGF0YSBvZiB0aGUgZmllbGQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgLSBGaWVsZCBuYW1lXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtleHRyYV0gLSBFeHRyYSBzY2hlbWEgb3B0aW9uc1xuICAgICAqIEByZXR1cm4ge29iamVjdH0gU2NoZW1hIG9iamVjdFxuICAgICAqL1xuICAgIHN0YXRpYyBmaWVsZFNjaGVtYShuYW1lLCBleHRyYSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmZpZWxkc1tuYW1lXTtcbiAgICAgICAgaWYgKCFtZXRhKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBVbmtub3duIGZpZWxkIFwiJHtuYW1lfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYClcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNjaGVtYSA9IF8ub21pdChtZXRhLCBbJ2RlZmF1bHQnXSk7XG4gICAgICAgIGlmIChleHRyYSkge1xuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihzY2hlbWEsIGV4dHJhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzY2hlbWE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgbWFwIG9mIGZpZWxkcyBzY2hlbWEgYnkgcHJlZGVmaW5lZCBpbnB1dCBzZXQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGlucHV0U2V0TmFtZSAtIElucHV0IHNldCBuYW1lLCBwcmVkZWZpbmVkIGluIGdlbWxcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gSW5wdXQgc2V0IG9wdGlvbnNcbiAgICAgKiBAcmV0dXJuIHtvYmplY3R9IFNjaGVtYSBvYmplY3RcbiAgICAgKi9cbiAgICBzdGF0aWMgaW5wdXRTY2hlbWEoaW5wdXRTZXROYW1lLCBvcHRpb25zKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICBjb25zdCBrZXkgPSBpbnB1dFNldE5hbWUgKyAob3B0aW9ucyA9PSBudWxsID8gJ3t9JyA6IEpTT04uc3RyaW5naWZ5KG9wdGlvbnMpKTtcblxuICAgICAgICBpZiAodGhpcy5fY2FjaGVkU2NoZW1hKSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuX2NhY2hlZFNjaGVtYVtrZXldO1xuICAgICAgICAgICAgaWYgKGNhY2hlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkU2NoZW1hID0ge307XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzY2hlbWFHZW5lcmF0b3IgPSB0aGlzLmRiLnJlcXVpcmUoYGlucHV0cy8ke3RoaXMubWV0YS5uYW1lfS0ke2lucHV0U2V0TmFtZX1gKTtcblxuICAgICAgICByZXR1cm4gKHRoaXMuX2NhY2hlZFNjaGVtYVtrZXldID0gc2NoZW1hR2VuZXJhdG9yKG9wdGlvbnMpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCc7XG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBuZXN0ZWQgb2JqZWN0IG9mIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgsIGRlZmF1bHRWYWx1ZSkge1xuICAgICAgICBsZXQgbm9kZXMgPSAoQXJyYXkuaXNBcnJheShrZXlQYXRoKSA/IGtleVBhdGggOiBrZXlQYXRoLnNwbGl0KCcuJykpLm1hcChrZXkgPT4ga2V5WzBdID09PSAnOicgPyBrZXkgOiAoJzonICsga2V5KSk7XG4gICAgICAgIHJldHVybiBfLmdldChlbnRpdHlPYmosIG5vZGVzLCBkZWZhdWx0VmFsdWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBfLmdldChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICoge3N0cmluZ30gW2tleV0gLSBUaGUga2V5IGZpZWxkIHRvIHVzZWQgYnkgdGhlIGhhc2h0YWJsZS5cbiAgICAgKiB7YXJyYXl9IFthc3NvY2lhdGlvbnNdIC0gV2l0aCBhbiBhcnJheSBvZiBhc3NvY2lhdGlvbnMuXG4gICAgICoge29iamVjdH0gW2Nvbm5PcHRpb25zXSAtIENvbm5lY3Rpb24gb3B0aW9ucywgZS5nLiB0cmFuc2FjdGlvbiBoYW5kbGVcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXksIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNvbWJpbmVkS2V5ID0ga2V5O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgY29tYmluZWRLZXkgKz0gJy8nICsgbWluaWZ5QXNzb2NzKGFzc29jaWF0aW9ucykuam9pbignJicpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YVtjb21iaW5lZEtleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJGFzc29jaWF0aW9uOiBhc3NvY2lhdGlvbnMsICR0b0RpY3Rpb25hcnk6IGtleSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gdGhpcy5jYWNoZWRfKHRoaXMubWV0YS5rZXlGaWVsZCwgYXNzb2NpYXRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRvRGljdGlvbmFyeShlbnRpdHlDb2xsZWN0aW9uLCBrZXksIHRyYW5zZm9ybWVyKSB7XG4gICAgICAgIGtleSB8fCAoa2V5ID0gdGhpcy5tZXRhLmtleUZpZWxkKTtcblxuICAgICAgICByZXR1cm4gQ29udmVydG9ycy50b0tWUGFpcnMoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcik7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyXSAtIFRyYW5zZm9ybSBmaWVsZHMgYmVmb3JlIHJldHVybmluZ1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcDogJ2ZpbmQnLFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChyYXdPcHRpb25zICYmIHJhd09wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByYXdPcHRpb25zLiRyZXN1bHQgPSByZWNvcmRzLnNsaWNlKDEpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgZmluZE9uZSgpIHJldHVybnMgbW9yZSB0aGFuIG9uZSByZWNvcmQuYCwgeyBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBvcHRpb25zOiBjb250ZXh0Lm9wdGlvbnMgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSB7XG4gICAgICAgICAgICByZXR1cm4gSkVTLmV2YWx1YXRlKHJlc3VsdCwgZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcl0gLSBUcmFuc2Zvcm0gZmllbGRzIGJlZm9yZSByZXR1cm5pbmdcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdmaW5kJywgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICAgIFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAocmF3T3B0aW9ucyAmJiByYXdPcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgcmF3T3B0aW9ucy4kcmVzdWx0ID0gcmVjb3Jkcy5zbGljZSgxKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcywgZmluZE9wdGlvbnMuJG5lc3RlZEtleUdldHRlcik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmluZE9wdGlvbnMuJHNraXBPcm0pIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRyYW5zZm9ybWVyKSB7XG4gICAgICAgICAgICByb3dzID0gcm93cy5tYXAocm93ID0+IEpFUy5ldmFsdWF0ZShyb3csIGZpbmRPcHRpb25zLiR0cmFuc2Zvcm1lcikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVwc2VydD1mYWxzZV0gLSBJZiBhbHJlYWR5IGV4aXN0LCBqdXN0IHVwZGF0ZSB0aGUgcmVjb3JkLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIWNyZWF0ZU9wdGlvbnMpIHsgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zID0ge307IFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMsIHJlZmVyZW5jZXMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgdHJ1ZSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wOiAnY3JlYXRlJyxcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShyZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKTsgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zLCB0cnVlIC8qIGJlZm9yZSBjcmVhdGUgKi8pOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vY2hlY2sgYW55IG90aGVyIGFzc29jaWF0aW9ucyBsZWZ0XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwc2VydE9uZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oY29udGV4dC5sYXRlc3QpLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHVwc2VydFxuICAgICAgICAgICAgICAgICk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fZmlsbFJlc3VsdChjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucywgcmVmZXJlbmNlcyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3VwZGF0ZScsXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpOyAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICBsZXQgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGxldCBkb25lVXBkYXRlQXNzb2NzO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIGRvbmVVcGRhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQubGF0ZXN0KSkge1xuICAgICAgICAgICAgICAgIGlmICghZG9uZVVwZGF0ZUFzc29jcyAmJiAhbmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgZG8gdGhlIHVwZGF0ZSB3aXRoIGVtcHR5IHJlY29yZC4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgIWhhc1ZhbHVlSW4oWyRxdWVyeSwgY29udGV4dC5sYXRlc3RdLCB0aGlzLm1ldGEua2V5RmllbGQpICYmICFvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBhc3NvY2lhdGVkIGRhdGEgZGVwZW5kaW5nIG9uIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKCRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgZmFsc2UsIGZvclNpbmdsZVJlY29yZCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcDogJ3JlcGxhY2UnLFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuICRwaHlzaWNhbERlbGV0aW9uID0gdHJ1ZSwgZGVsZXRldGlvbiB3aWxsIG5vdCB0YWtlIGludG8gYWNjb3VudCBsb2dpY2FsZGVsZXRpb24gZmVhdHVyZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRkZWxldGVBbGw9ZmFsc2VdIC0gV2hlbiAkZGVsZXRlQWxsID0gdHJ1ZSwgdGhlIG9wZXJhdGlvbiB3aWxsIHByb2NlZWQgZXZlbiBlbXB0eSBjb25kaXRpb24gaXMgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZUFsbF8oY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlTWFueV8oeyAkZGVsZXRlQWxsOiB0cnVlIH0sIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpICYmIChmb3JTaW5nbGVSZWNvcmQgfHwgIWRlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICBkZWxldGVPcHRpb25zIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3A6ICdkZWxldGUnLFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9ucyxcbiAgICAgICAgICAgIGZvclNpbmdsZVJlY29yZFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IGRlbGV0ZWRDb3VudCA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVkQ291bnQoY29udGV4dCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChkZWxldGVkQ291bnQpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybiB8fCBkZWxldGVkQ291bnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLiBDb25kaXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgdmFsdWUgcGFpciBpbiB0aGUgcXVlcnkgY29uZGl0aW9uLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UsIGZvclNpbmdsZVJlY29yZCA9IHRydWUpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3RpbmcgPSBjb250ZXh0Lm9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIF8uaXNFbXB0eShleGlzdGluZykgJiYgKHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpIHx8IG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKG9wT3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZyAmJiAhY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWx1ZSwgdXNlUmF3ID0gZmFsc2U7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICB1c2VSYXcgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgaW4gbGF0ZXN0KSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBsYXRlc3RbZmllbGROYW1lXTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSAmJiB1c2VSYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvcE9wdGlvbnMuJG1pZ3JhdGlvbiAmJiAoIWlzVXBkYXRpbmcgfHwhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seSB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mb1snZGVmYXVsdCddKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mb1snZGVmYXVsdCddO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2sgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIgfHwgZmllbGRJbmZvLmhhc0FjdGl2YXRvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFmaWVsZEluZm8uaGFzQWN0aXZhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vc2tpcCB0aG9zZSBoYXZlIGFjdGl2YXRvcnNcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBGaWVsZCBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJhdyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgaWYgKCFvcE9wdGlvbnMuJHNraXBNb2RpZmllcnMpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gdmFsdWU7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAvL3RoZXJlIGlzIHNwZWNpYWwgaW5wdXQgY29sdW1uIHdoaWNoIG1heWJlIGEgZnVuY3Rpb24gb3IgYW4gZXhwcmVzc2lvblxuICAgICAgICAgICAgICAgIG9wT3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucyA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgdGhpcy5kYi5jb25uZWN0b3IubG9nKCdlcnJvcicsIGBSb2xsYmFja2VkLCByZWFzb246ICR7ZXJyb3IubWVzc2FnZX1gLCB7ICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICByYXdEYXRhOiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0RGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgXG4gICAgICAgICAgICB9ICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRlbmN5Q2hhbmdlZChmaWVsZE5hbWUsIGNvbnRleHQpIHtcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXNbZmllbGROYW1lXTtcblxuICAgICAgICByZXR1cm4gXy5maW5kKGRlcHMsIGQgPT4gXy5pc1BsYWluT2JqZWN0KGQpID8gXy5oYXNJbihjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBfLmhhc0luKGNvbnRleHQsIGQpKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3JlZmVyZW5jZUV4aXN0KGlucHV0LCByZWYpIHtcbiAgICAgICAgbGV0IHBvcyA9IHJlZi5pbmRleE9mKCcuJyk7XG5cbiAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiByZWYuc3Vic3RyKHBvcysxKSBpbiBpbnB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWYgaW4gaW5wdXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG51bGxEZXBlbmRzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4gXG4gICAgICAgICAgICAgICAgXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkLndoZW5OdWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoaW5wdXRbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbERlcGVuZHMuYWRkKGRlcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkID0gZC5yZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmllbGROYW1lIGluIGlucHV0ICYmICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZCk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IGRlcCBvZiBudWxsRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIGlmIChfLmZpbmQoZGVwLCBkID0+ICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZC5yZWZlcmVuY2UpKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgIFxuICAgICAgICAgICAgICAgICAgICBrZXlGaWVsZHM6IHRoaXMubWV0YS5rZXlGaWVsZCAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBpbnB1dEtleUZpZWxkOiBrZXlGaWVsZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICAvL3dpbGwgdXBkYXRlIGNvbnRleHQucmF3IGlmIGFwcGxpY2FibGVcbiAgICBzdGF0aWMgYXN5bmMgX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgLy93aWxsIHVwZGF0ZSBjb250ZXh0LnJhdyBpZiBhcHBsaWNhYmxlXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBUeXBlQ2FzdCwgYXJyYXlUb0luT3BlcmF0b3IgJiYga1swXSAhPT0gJyQnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHsgIFxuICAgICAgICAgICAgbGV0IHJldCA9IHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvcikpO1xuICAgICAgICAgICAgcmV0dXJuIGFycmF5VG9Jbk9wZXJhdG9yID8geyAkaW46IHJldCB9IDogcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBUeXBlQ2FzdCkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci50eXBlQ2FzdCh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==
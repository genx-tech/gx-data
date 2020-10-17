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
    await this.applyModifiers_(context, isUpdating);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiaGFzVmFsdWVJbiIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJtZXRhIiwia2V5RmllbGQiLCJmaWVsZE1ldGEiLCJuYW1lIiwiZmllbGRzIiwib21pdCIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwicGljayIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJkZWZhdWx0VmFsdWUiLCJub2RlcyIsIkFycmF5IiwiaXNBcnJheSIsInNwbGl0IiwibWFwIiwia2V5IiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJvcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJlbnN1cmVSZXRyaWV2ZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiY29ubk9wdGlvbnMiLCJjb25uZWN0aW9uIiwiZGIiLCJjb25uZWN0b3IiLCJiZWdpblRyYW5zYWN0aW9uXyIsImdldFZhbHVlRnJvbUNvbnRleHQiLCJjYWNoZWRfIiwiYXNzb2NpYXRpb25zIiwiY29tYmluZWRLZXkiLCJpc0VtcHR5Iiwiam9pbiIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YSIsImZpbmRBbGxfIiwiJGFzc29jaWF0aW9uIiwiJHRvRGljdGlvbmFyeSIsInRvRGljdGlvbmFyeSIsImVudGl0eUNvbGxlY3Rpb24iLCJ0cmFuc2Zvcm1lciIsInRvS1ZQYWlycyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwiJG5lc3RlZEtleUdldHRlciIsImxvZyIsImVudGl0eSIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXdPcHRpb25zIiwicmF3IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJiZWZvcmVDcmVhdGVfIiwicmV0dXJuIiwic3VjY2VzcyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJmaW5pc2hlZCIsInBlbmRpbmdBc3NvY3MiLCJfY3JlYXRlQXNzb2NzXyIsImZvck93biIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJsYXRlc3QiLCJmcmVlemUiLCIkdXBzZXJ0IiwidXBzZXJ0T25lXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIm5lZWRVcGRhdGVBc3NvY3MiLCJkb25lVXBkYXRlQXNzb2NzIiwiX3VwZGF0ZUFzc29jc18iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJvdGhlck9wdGlvbnMiLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJkZWxldGVBbGxfIiwiJGRlbGV0ZUFsbCIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlZENvdW50IiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwiJGV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwidmFsdWUiLCJyZWFkT25seSIsIiRtaWdyYXRpb24iLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwib29yVHlwZSIsInNhbml0aXplIiwiZXJyb3IiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImhhc0FjdGl2YXRvciIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJtZXNzYWdlIiwibGF0ZXN0RGF0YSIsInJvbGxiYWNrXyIsIl9kZXBlbmRlbmN5Q2hhbmdlZCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImQiLCJyZWZlcmVuY2UiLCJfcmVmZXJlbmNlRXhpc3QiLCJpbnB1dCIsInJlZiIsInBvcyIsImluZGV4T2YiLCJzdWJzdHIiLCJoYXNEZXBlbmRzIiwibnVsbERlcGVuZHMiLCJkZXAiLCJ3aGVuTnVsbCIsImFkZCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJmaWVsZCIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2Iiwia2V5RmllbGRzIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJpbnB1dEtleUZpZWxkIiwiRXJyb3IiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFR5cGVDYXN0IiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiJGluIiwidHlwZUNhc3QiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQSxjQUFqQjtBQUFpQ0MsRUFBQUE7QUFBakMsSUFBa0RKLE9BQU8sQ0FBQyxVQUFELENBQS9EOztBQUNBLE1BQU1LLE1BQU0sR0FBR0wsT0FBTyxDQUFDLGdCQUFELENBQXRCOztBQUNBLE1BQU1NLFVBQVUsR0FBR04sT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU8sVUFBVSxHQUFHUCxPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNUSxLQUFLLEdBQUdSLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVMsRUFBQUEsZUFBRjtBQUFtQkMsRUFBQUEsYUFBbkI7QUFBa0NDLEVBQUFBO0FBQWxDLElBQXNETixNQUE1RDs7QUFDQSxNQUFNTyxRQUFRLEdBQUdaLE9BQU8sQ0FBQyxrQkFBRCxDQUF4Qjs7QUFDQSxNQUFNYSxLQUFL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QUEzQixDQUFQO0FBQ0g7O0FBeHZDYTs7QUEydkNsQjJFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQi9QLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcsIGhhc1ZhbHVlSW4gfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nLCAnRGF0YVNldCcsICdTUUwnXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIGRhdGFbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIGZpZWxkTWV0YShuYW1lKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuZmllbGRzW25hbWVdO1xuICAgICAgICBpZiAoIW1ldGEpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFVrbm93biBmaWVsZCBcIiR7bmFtZX1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIF8ub21pdChtZXRhLCBbJ2RlZmF1bHQnXSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoLCBkZWZhdWx0VmFsdWUpIHtcbiAgICAgICAgbGV0IG5vZGVzID0gKEFycmF5LmlzQXJyYXkoa2V5UGF0aCkgPyBrZXlQYXRoIDoga2V5UGF0aC5zcGxpdCgnLicpKS5tYXAoa2V5ID0+IGtleVswXSA9PT0gJzonID8ga2V5IDogKCc6JyArIGtleSkpO1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBub2RlcywgZGVmYXVsdFZhbHVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqIHtzdHJpbmd9IFtrZXldIC0gVGhlIGtleSBmaWVsZCB0byB1c2VkIGJ5IHRoZSBoYXNodGFibGUuXG4gICAgICoge2FycmF5fSBbYXNzb2NpYXRpb25zXSAtIFdpdGggYW4gYXJyYXkgb2YgYXNzb2NpYXRpb25zLlxuICAgICAqIHtvYmplY3R9IFtjb25uT3B0aW9uc10gLSBDb25uZWN0aW9uIG9wdGlvbnMsIGUuZy4gdHJhbnNhY3Rpb24gaGFuZGxlXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0b0RpY3Rpb25hcnkoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcikge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIENvbnZlcnRvcnMudG9LVlBhaXJzKGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBmaW5kT3B0aW9ucy4kbmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIGZpbmRPcHRpb25zLiRuZXN0ZWRLZXlHZXR0ZXIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpbmRPcHRpb25zLiRza2lwT3JtKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVwc2VydD1mYWxzZV0gLSBJZiBhbHJlYWR5IGV4aXN0LCBqdXN0IHVwZGF0ZSB0aGUgcmVjb3JkLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIWNyZWF0ZU9wdGlvbnMpIHsgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zID0ge307IFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgdHJ1ZSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBbIGZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzIF0gPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IHBlbmRpbmdBc3NvY3M7XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBzZXJ0T25lXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShjb250ZXh0LmxhdGVzdCksXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kdXBzZXJ0XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gdXBkYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIC8vaWYgbm8gY29uZGl0aW9uIGdpdmVuLCBleHRyYWN0IGZyb20gZGF0YSBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KFxuICAgICAgICAgICAgICAgICAgICAnUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFzc29jaWF0ZWQgZW50aXR5IGRhdGEgcHJvdmlkZWQgdG9nZXRoZXJcbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTsgICAgICAgICAgICAgICBcblxuICAgICAgICAvL3NlZSBpZiB0aGVyZSBpcyBhbnkgcnVudGltZSBmZWF0dXJlIHN0b3BwaW5nIHRoZSB1cGRhdGVcbiAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBsZXQgbmVlZFVwZGF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIGxldCBkb25lVXBkYXRlQXNzb2NzO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIGRvbmVVcGRhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmxhdGVzdCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRvbmVVcGRhdGVBc3NvY3MgJiYgIW5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IGRvIHRoZSB1cGRhdGUgd2l0aCBlbXB0eSByZWNvcmQuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IE9iamVjdC5mcmVlemUoY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IHsgJHF1ZXJ5LCAuLi5vdGhlck9wdGlvbnMgfSA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzICYmICFoYXNWYWx1ZUluKFskcXVlcnksIGNvbnRleHQubGF0ZXN0XSwgdGhpcy5tZXRhLmtleUZpZWxkKSAmJiAhb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgICAgICAvL3Nob3VsZCBlbnN1cmUgdGhlIGxhdGVzdCByZXN1bHQgd2lsbCBjb250YWluIHRoZSBrZXkgb2YgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgb3RoZXJPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgZmFsc2UsIGZvclNpbmdsZVJlY29yZCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChcbiAgICAgICAgICAgICAgICAgICAgJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gJHBoeXNpY2FsRGVsZXRpb24gPSB0cnVlLCBkZWxldGV0aW9uIHdpbGwgbm90IHRha2UgaW50byBhY2NvdW50IGxvZ2ljYWxkZWxldGlvbiBmZWF0dXJlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJGRlbGV0ZUFsbD1mYWxzZV0gLSBXaGVuICRkZWxldGVBbGwgPSB0cnVlLCB0aGUgb3BlcmF0aW9uIHdpbGwgcHJvY2VlZCBldmVuIGVtcHR5IGNvbmRpdGlvbiBpcyBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlQWxsXyhjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5kZWxldGVNYW55Xyh7ICRkZWxldGVBbGw6IHRydWUgfSwgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiAkcGh5c2ljYWxEZWxldGlvbiA9IHRydWUsIGRlbGV0ZXRpb24gd2lsbCBub3QgdGFrZSBpbnRvIGFjY291bnQgbG9naWNhbGRlbGV0aW9uIGZlYXR1cmUgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkgJiYgKGZvclNpbmdsZVJlY29yZCB8fCAhZGVsZXRlT3B0aW9ucy4kZGVsZXRlQWxsKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnMsXG4gICAgICAgICAgICBmb3JTaW5nbGVSZWNvcmRcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9EZWxldGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBkZWxldGVkQ291bnQgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCB7ICRxdWVyeSwgLi4ub3RoZXJPcHRpb25zIH0gPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICRxdWVyeSxcbiAgICAgICAgICAgICAgICBvdGhlck9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlZENvdW50KGNvbnRleHQpO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZGVsZXRlZENvdW50KSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm4gfHwgZGVsZXRlZENvdW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICBsZXQgaGFzS2V5TmFtZU9ubHkgPSBmYWxzZTtcblxuICAgICAgICBsZXQgaGFzTm90TnVsbEtleSA9IF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IHtcbiAgICAgICAgICAgIGxldCBoYXNLZXlzID0gXy5ldmVyeShmaWVsZHMsIGYgPT4gZiBpbiBkYXRhKTtcbiAgICAgICAgICAgIGhhc0tleU5hbWVPbmx5ID0gaGFzS2V5TmFtZU9ubHkgfHwgaGFzS2V5cztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgaGFzTm90TnVsbEtleSwgaGFzS2V5TmFtZU9ubHkgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBbIGNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUsIGNvbnRhaW5zVW5pcXVlS2V5T25seSBdID0gdGhpcy5fY29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKTsgICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zVW5pcXVlS2V5T25seSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4gQ29uZGl0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHZhbHVlIHBhaXIgaW4gdGhlIHF1ZXJ5IGNvbmRpdGlvbi4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQgPSB0cnVlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nID0gY29udGV4dC5vcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBfLmlzRW1wdHkoZXhpc3RpbmcpICYmICh0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSB8fCBvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcgJiYgIWNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgbGV0IHZhbHVlID0gcmF3W2ZpZWxkTmFtZV07XG5cbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wT3B0aW9ucy4kbWlncmF0aW9uICYmICghaXNVcGRhdGluZyB8fCFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5IHx8ICFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5LCBjaGVjayB3cml0ZVByb3RlY3QgXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm9bJ2RlZmF1bHQnXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm9bJ2RlZmF1bHQnXTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gdmFsdWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHZhbHVlLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5zdGFjayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiIHx8IGZpZWxkSW5mby5oYXNBY3RpdmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogY2hlY2sgaWYgdGhlcmUgaXMgYW4gYWN0aXZhdG9yXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGF0ZXN0ID0gY29udGV4dC5sYXRlc3QgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzLCB0cnVlKTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcblxuICAgICAgICAvL2ZpbmFsIHJvdW5kIHByb2Nlc3MgYmVmb3JlIGVudGVyaW5nIGRhdGFiYXNlXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gXy5tYXBWYWx1ZXMobGF0ZXN0LCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbHVlID09IG51bGwpIHJldHVybiB2YWx1ZTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIC8vdGhlcmUgaXMgc3BlY2lhbCBpbnB1dCBjb2x1bW4gd2hpY2ggbWF5YmUgYSBmdW5jdGlvbiBvciBhbiBleHByZXNzaW9uXG4gICAgICAgICAgICAgICAgb3BPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29tbWl0IG9yIHJvbGxiYWNrIGlzIGNhbGxlZCBpZiB0cmFuc2FjdGlvbiBpcyBjcmVhdGVkIHdpdGhpbiB0aGUgZXhlY3V0b3IuXG4gICAgICogQHBhcmFtIHsqfSBleGVjdXRvciBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb247ICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYFJvbGxiYWNrZWQsIHJlYXNvbjogJHtlcnJvci5tZXNzYWdlfWAsIHsgIFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBjb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIHJhd0RhdGE6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3REYXRhOiBjb250ZXh0LmxhdGVzdFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZGVuY3lDaGFuZ2VkKGZpZWxkTmFtZSwgY29udGV4dCkge1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llc1tmaWVsZE5hbWVdO1xuXG4gICAgICAgIHJldHVybiBfLmZpbmQoZGVwcywgZCA9PiBfLmlzUGxhaW5PYmplY3QoZCkgPyBoYXNLZXlCeVBhdGgoY29udGV4dCwgZC5yZWZlcmVuY2UpIDogaGFzS2V5QnlQYXRoKGNvbnRleHQsIGQpKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3JlZmVyZW5jZUV4aXN0KGlucHV0LCByZWYpIHtcbiAgICAgICAgbGV0IHBvcyA9IHJlZi5pbmRleE9mKCcuJyk7XG5cbiAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiByZWYuc3Vic3RyKHBvcysxKSBpbiBpbnB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWYgaW4gaW5wdXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG51bGxEZXBlbmRzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4gXG4gICAgICAgICAgICAgICAgXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkLndoZW5OdWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoaW5wdXRbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbERlcGVuZHMuYWRkKGRlcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkID0gZC5yZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmllbGROYW1lIGluIGlucHV0ICYmICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZCk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IGRlcCBvZiBudWxsRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIGlmIChfLmZpbmQoZGVwLCBkID0+ICF0aGlzLl9yZWZlcmVuY2VFeGlzdChpbnB1dCwgZC5yZWZlcmVuY2UpKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgIFxuICAgICAgICAgICAgICAgICAgICBrZXlGaWVsZHM6IHRoaXMubWV0YS5rZXlGaWVsZCAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBpbnB1dEtleUZpZWxkOiBrZXlGaWVsZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnRvRGljdGlvbmFyeShyZWNvcmRzLCBrZXlGaWVsZCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmIChvb3JUeXBlc1RvQnlwYXNzLmhhcyh2YWx1ZS5vb3JUeXBlKSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYsIGspID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcywgc2tpcFR5cGVDYXN0LCBhcnJheVRvSW5PcGVyYXRvciAmJiBrWzBdICE9PSAnJCcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgeyAgXG4gICAgICAgICAgICBsZXQgcmV0ID0gdmFsdWUubWFwKHYgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwVHlwZUNhc3QsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFR5cGVDYXN0KSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnR5cGVDYXN0KHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19
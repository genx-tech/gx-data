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
  isNothing
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

const oorTypesToBypass = new Set(['ColumnReference', 'Function', 'BinaryExpression']);

class EntityModel {
  constructor(rawData) {
    if (rawData) {
      Object.assign(this, rawData);
    }
  }

  static valueOfKey(data) {
    return Array.isArray(this.meta.keyField) ? _.pick(data, this.meta.keyField) : data[this.meta.keyField];
  }

  static fieldMeta(name) {
    return _.omit(this.meta.fields[name], ['default']);
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
        records = this._mapRecordsToObjects(records, findOptions.$relationships);
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
          records = this._mapRecordsToObjects(records, findOptions.$relationships);
        } else {
          records = records[0];
        }
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
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

    let [raw, associations] = this._extractAssociations(data);

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
        context.result = await this.db.connector.upsertOne_(this.meta.name, context.latest, this.getUniqueKeyFieldsFrom(context.latest), context.connOptions);
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
      connOptions
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

      if (needUpdateAssocs) {
        await this.ensureTransaction_(context);
        associations = await this._updateAssocs_(context, associations, true, forSingleRecord);
        needUpdateAssocs = !_.isEmpty(associations);
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

      context.latest = Object.freeze(context.latest);
      const {
        $query,
        ...otherOptions
      } = context.options;

      if (needUpdateAssocs && _.isEmpty(this.valueOfKey($query)) && _.isEmpty(this.valueOfKey(context.latest)) && !otherOptions.$retrieveUpdated) {
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

  static async _delete_(deleteOptions, connOptions, forSingleRecord) {
    let rawOptions = deleteOptions;
    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);

    if (_.isEmpty(deleteOptions.$query)) {
      throw new InvalidArgument('Empty condition is not allowed for deleting an entity.', {
        entity: this.meta.name,
        deleteOptions
      });
    }

    let context = {
      rawOptions,
      options: deleteOptions,
      connOptions
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

    let success = await this._safeExecute_(async context => {
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

      context.result = await this.db.connector.delete_(this.meta.name, context.options.$query, context.connOptions);

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
      return true;
    }, context);

    if (success) {
      if (forSingleRecord) {
        await this.afterDelete_(context);
      } else {
        await this.afterDeleteMany_(context);
      }
    }

    return context.return;
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
          if (!opOptions.$migration && (!isUpdating || !opOptions.$bypassReadOnly.has(fieldName))) {
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
          if (fieldInfo.updateByDb) {
            return;
          }

          if (fieldInfo.auto) {
            latest[fieldName] = await Generators.default(fieldInfo, i18n);
            return;
          }

          throw new ValidationError(`"${fieldName}" of "${name}" enttiy is required for each update.`, {
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
      let fieldInfo = fields[key];

      if (!fieldInfo) {
        throw new Error("Assertion failed: fieldInfo");
      }

      if (_.isPlainObject(value) && value.oorType) {
        opOptions.$requireSplitColumns = true;
        return value;
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

  static _serialize(value) {
    throw new Error(NEED_OVERRIDE);
  }

  static _serializeByTypeInfo(value, info) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateValue(value, variables, skipSerialize, arrayToInOperator) {
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

      return _.mapValues(value, (v, k) => this._translateValue(v, variables, skipSerialize, arrayToInOperator && k[0] !== '$'));
    }

    if (Array.isArray(value)) {
      let ret = value.map(v => this._translateValue(v, variables, skipSerialize, arrayToInOperator));
      return arrayToInOperator ? {
        $in: ret
      } : ret;
    }

    if (skipSerialize) return value;
    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9FbnRpdHlNb2RlbC5qcyJdLCJuYW1lcyI6WyJIdHRwQ29kZSIsInJlcXVpcmUiLCJfIiwiZWFjaEFzeW5jXyIsImdldFZhbHVlQnlQYXRoIiwiaGFzS2V5QnlQYXRoIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIkNvbnZlcnRvcnMiLCJUeXBlcyIsIlZhbGlkYXRpb25FcnJvciIsIkRhdGFiYXNlRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJGZWF0dXJlcyIsIlJ1bGVzIiwiaXNOb3RoaW5nIiwiTkVFRF9PVkVSUklERSIsIm1pbmlmeUFzc29jcyIsImFzc29jcyIsInNvcnRlZCIsInVuaXEiLCJzb3J0IiwicmV2ZXJzZSIsIm1pbmlmaWVkIiwidGFrZSIsImwiLCJsZW5ndGgiLCJpIiwiayIsImZpbmQiLCJhIiwic3RhcnRzV2l0aCIsInB1c2giLCJvb3JUeXBlc1RvQnlwYXNzIiwiU2V0IiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCJ2YWx1ZU9mS2V5IiwiZGF0YSIsIkFycmF5IiwiaXNBcnJheSIsIm1ldGEiLCJrZXlGaWVsZCIsInBpY2siLCJmaWVsZE1ldGEiLCJuYW1lIiwib21pdCIsImZpZWxkcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJ1bmlxdWVLZXlzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsInVrRmllbGRzIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsImRlZmF1bHRWYWx1ZSIsIm5vZGVzIiwic3BsaXQiLCJtYXAiLCJrZXkiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwidG9EaWN0aW9uYXJ5IiwiZW50aXR5Q29sbGVjdGlvbiIsInRyYW5zZm9ybWVyIiwidG9LVlBhaXJzIiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJsb2ciLCJlbnRpdHkiLCJyZXN1bHQiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiZmluaXNoZWQiLCJwZW5kaW5nQXNzb2NzIiwiX2NyZWF0ZUFzc29jc18iLCJmb3JPd24iLCJyZWZGaWVsZFZhbHVlIiwibG9jYWxGaWVsZCIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwibGF0ZXN0IiwiZnJlZXplIiwiJHVwc2VydCIsInVwc2VydE9uZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiYWZ0ZXJDcmVhdGVfIiwidXBkYXRlT25lXyIsInVwZGF0ZU9wdGlvbnMiLCIkYnlwYXNzUmVhZE9ubHkiLCJyZWFzb24iLCJfdXBkYXRlXyIsInVwZGF0ZU1hbnlfIiwiZm9yU2luZ2xlUmVjb3JkIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJuZWVkVXBkYXRlQXNzb2NzIiwiX3VwZGF0ZUFzc29jc18iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJvdGhlck9wdGlvbnMiLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJ0b0RlbGV0ZSIsImJlZm9yZURlbGV0ZV8iLCJiZWZvcmVEZWxldGVNYW55XyIsIlJVTEVfQkVGT1JFX0RFTEVURSIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiUlVMRV9BRlRFUl9ERUxFVEUiLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJKU09OIiwic3RyaW5naWZ5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJleGlzdGluZyIsIiRleGlzdGluZyIsIm9wT3B0aW9ucyIsIl9kZXBlbmRzT25FeGlzdGluZ0RhdGEiLCIkcmV0cmlldmVFeGlzdGluZyIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInZhbHVlIiwicmVhZE9ubHkiLCIkbWlncmF0aW9uIiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwiaXNQbGFpbk9iamVjdCIsIm9vclR5cGUiLCJzYW5pdGl6ZSIsImVycm9yIiwic3RhY2siLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiX3RyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwibWVzc2FnZSIsImxhdGVzdERhdGEiLCJyb2xsYmFja18iLCJfZGVwZW5kZW5jeUNoYW5nZWQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJkIiwicmVmZXJlbmNlIiwiX3JlZmVyZW5jZUV4aXN0IiwiaW5wdXQiLCJyZWYiLCJwb3MiLCJpbmRleE9mIiwic3Vic3RyIiwiaGFzRGVwZW5kcyIsIm51bGxEZXBlbmRzIiwiZGVwIiwid2hlbk51bGwiLCJhZGQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiZmllbGQiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImtleUZpZWxkcyIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiaW5wdXRLZXlGaWVsZCIsIkVycm9yIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiJGluIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUEsY0FBakI7QUFBaUNDLEVBQUFBO0FBQWpDLElBQWtESixPQUFPLENBQUMsVUFBRCxDQUEvRDs7QUFDQSxNQUFNSyxNQUFNLEdBQUdMLE9BQU8sQ0FBQyxnQkFBRCxDQUF0Qjs7QUFDQSxNQUFNTSxVQUFVLEdBQUdOLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1PLFVBQVUsR0FBR1AsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTVEsS0FBSyxHQUFHUixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVTLEVBQUFBLGVBQUY7QUFBbUJDLEVBQUFBLGFBQW5CO0FBQWtDQyxFQUFBQTtBQUFsQyxJQUFzRE4sTUFBNUQ7O0FBQ0EsTUFBTU8sUUFBUSxHQUFHWixPQUFPLENBQUMsa0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTWEsS0FBSyxHQUFHYixPQUFPLENBQUMsY0FBRCxDQUFyQjs7QUFFQSxNQUFNO0FBQUVjLEVBQUFBO0FBQUYsSUFBZ0JkLE9BQU8sQ0FBQyxjQUFELENBQTdCOztBQUVBLE1BQU1lLGFBQWEsR0FB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dUNsQjBFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnpQLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGgsIGhhc0tleUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBDb252ZXJ0b3JzID0gcmVxdWlyZSgnLi9Db252ZXJ0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbmZ1bmN0aW9uIG1pbmlmeUFzc29jcyhhc3NvY3MpIHtcbiAgICBsZXQgc29ydGVkID0gXy51bmlxKGFzc29jcykuc29ydCgpLnJldmVyc2UoKTtcblxuICAgIGxldCBtaW5pZmllZCA9IF8udGFrZShzb3J0ZWQsIDEpLCBsID0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGw7IGkrKykge1xuICAgICAgICBsZXQgayA9IHNvcnRlZFtpXSArICcuJztcblxuICAgICAgICBpZiAoIV8uZmluZChtaW5pZmllZCwgYSA9PiBhLnN0YXJ0c1dpdGgoaykpKSB7XG4gICAgICAgICAgICBtaW5pZmllZC5wdXNoKHNvcnRlZFtpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbWluaWZpZWQ7XG59XG5cbmNvbnN0IG9vclR5cGVzVG9CeXBhc3MgPSBuZXcgU2V0KFsnQ29sdW1uUmVmZXJlbmNlJywgJ0Z1bmN0aW9uJywgJ0JpbmFyeUV4cHJlc3Npb24nXSk7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSA/IF8ucGljayhkYXRhLCB0aGlzLm1ldGEua2V5RmllbGQpIDogZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZmllbGRNZXRhKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIF8ub21pdCh0aGlzLm1ldGEuZmllbGRzW25hbWVdLCBbJ2RlZmF1bHQnXSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoLCBkZWZhdWx0VmFsdWUpIHtcbiAgICAgICAgbGV0IG5vZGVzID0gKEFycmF5LmlzQXJyYXkoa2V5UGF0aCkgPyBrZXlQYXRoIDoga2V5UGF0aC5zcGxpdCgnLicpKS5tYXAoa2V5ID0+IGtleVswXSA9PT0gJzonID8ga2V5IDogKCc6JyArIGtleSkpO1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBub2RlcywgZGVmYXVsdFZhbHVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqIHtzdHJpbmd9IFtrZXldIC0gVGhlIGtleSBmaWVsZCB0byB1c2VkIGJ5IHRoZSBoYXNodGFibGUuXG4gICAgICoge2FycmF5fSBbYXNzb2NpYXRpb25zXSAtIFdpdGggYW4gYXJyYXkgb2YgYXNzb2NpYXRpb25zLlxuICAgICAqIHtvYmplY3R9IFtjb25uT3B0aW9uc10gLSBDb25uZWN0aW9uIG9wdGlvbnMsIGUuZy4gdHJhbnNhY3Rpb24gaGFuZGxlXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0b0RpY3Rpb25hcnkoZW50aXR5Q29sbGVjdGlvbiwga2V5LCB0cmFuc2Zvcm1lcikge1xuICAgICAgICBrZXkgfHwgKGtleSA9IHRoaXMubWV0YS5rZXlGaWVsZCk7XG5cbiAgICAgICAgcmV0dXJuIENvbnZlcnRvcnMudG9LVlBhaXJzKGVudGl0eUNvbGxlY3Rpb24sIGtleSwgdHJhbnNmb3JtZXIpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVjb3Jkcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRiLmNvbm5lY3Rvci5sb2coJ2Vycm9yJywgYGZpbmRPbmUoKSByZXR1cm5zIG1vcmUgdGhhbiBvbmUgcmVjb3JkLmAsIHsgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgb3B0aW9uczogY29udGV4dC5vcHRpb25zIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVwc2VydD1mYWxzZV0gLSBJZiBhbHJlYWR5IGV4aXN0LCBqdXN0IHVwZGF0ZSB0aGUgcmVjb3JkLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoIWNyZWF0ZU9wdGlvbnMpIHsgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zID0ge307IFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG5cbiAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHsgIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBjb25zdCBbIGZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzIF0gPSBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucywgdHJ1ZSAvKiBiZWZvcmUgY3JlYXRlICovKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGFzc29jaWF0aW9ucyA9IHBlbmRpbmdBc3NvY3M7XG4gICAgICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9ICFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRldjoge1xuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHVwc2VydCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBzZXJ0T25lXyhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShjb250ZXh0LmxhdGVzdCksXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBtYW55IGV4aXN0aW5nIGVudGl0ZXMgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgLy9pZiBubyBjb25kaXRpb24gZ2l2ZW4sIGV4dHJhY3QgZnJvbSBkYXRhIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9zZWUgaWYgdGhlcmUgaXMgYXNzb2NpYXRlZCBlbnRpdHkgZGF0YSBwcm92aWRlZCB0b2dldGhlclxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyksICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICAgICAgICAgIFxuXG4gICAgICAgIC8vc2VlIGlmIHRoZXJlIGlzIGFueSBydW50aW1lIGZlYXR1cmUgc3RvcHBpbmcgdGhlIHVwZGF0ZVxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGxldCBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAobmVlZFVwZGF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zID0gYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIHRydWUgLyogYmVmb3JlIHVwZGF0ZSAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBuZWVkVXBkYXRlQXNzb2NzID0gIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLywgZm9yU2luZ2xlUmVjb3JkKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGV2OiB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSBPYmplY3QuZnJlZXplKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyAkcXVlcnksIC4uLm90aGVyT3B0aW9ucyB9ID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKG5lZWRVcGRhdGVBc3NvY3MgJiYgXy5pc0VtcHR5KHRoaXMudmFsdWVPZktleSgkcXVlcnkpKSAmJiBfLmlzRW1wdHkodGhpcy52YWx1ZU9mS2V5KGNvbnRleHQubGF0ZXN0KSkgJiYgIW90aGVyT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXMgYXNzb2NpYXRlZCBkYXRhIGRlcGVuZGluZyBvbiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgIC8vc2hvdWxkIGVuc3VyZSB0aGUgbGF0ZXN0IHJlc3VsdCB3aWxsIGNvbnRhaW4gdGhlIGtleSBvZiB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIG90aGVyT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSgkcXVlcnkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkVXBkYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMsIGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoXG4gICAgICAgICAgICAgICAgICAgICdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGxldCByYXdPcHRpb25zID0gZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9EZWxldGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX0RFTEVURSwgdGhpcywgY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICBsZXQgaGFzS2V5TmFtZU9ubHkgPSBmYWxzZTtcblxuICAgICAgICBsZXQgaGFzTm90TnVsbEtleSA9IF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IHtcbiAgICAgICAgICAgIGxldCBoYXNLZXlzID0gXy5ldmVyeShmaWVsZHMsIGYgPT4gZiBpbiBkYXRhKTtcbiAgICAgICAgICAgIGhhc0tleU5hbWVPbmx5ID0gaGFzS2V5TmFtZU9ubHkgfHwgaGFzS2V5cztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgaGFzTm90TnVsbEtleSwgaGFzS2V5TmFtZU9ubHkgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBbIGNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUsIGNvbnRhaW5zVW5pcXVlS2V5T25seSBdID0gdGhpcy5fY29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKTsgICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zVW5pcXVlS2V5T25seSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4gQ29uZGl0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHZhbHVlIHBhaXIgaW4gdGhlIHF1ZXJ5IGNvbmRpdGlvbi4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlLCBmb3JTaW5nbGVSZWNvcmQgPSB0cnVlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nID0gY29udGV4dC5vcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBfLmlzRW1wdHkoZXhpc3RpbmcpICYmICh0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSB8fCBvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChvcE9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcgJiYgIWNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgbGV0IHZhbHVlID0gcmF3W2ZpZWxkTmFtZV07XG5cbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW9wT3B0aW9ucy4kbWlncmF0aW9uICYmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeSwgY2hlY2sgd3JpdGVQcm90ZWN0IFxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvWydkZWZhdWx0J10pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvWydkZWZhdWx0J107XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IHZhbHVlO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZSh2YWx1ZSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3Iuc3RhY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWUgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIC8vdGhlcmUgaXMgc3BlY2lhbCBpbnB1dCBjb2x1bW4gd2hpY2ggbWF5YmUgYSBmdW5jdGlvbiBvciBhbiBleHByZXNzaW9uXG4gICAgICAgICAgICAgICAgb3BPcHRpb25zLiRyZXF1aXJlU3BsaXRDb2x1bW5zID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIHRoaXMuZGIuY29ubmVjdG9yLmxvZygnZXJyb3InLCBgUm9sbGJhY2tlZCwgcmVhc29uOiAke2Vycm9yLm1lc3NhZ2V9YCwgeyAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RGF0YTogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdERhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kZW5jeUNoYW5nZWQoZmllbGROYW1lLCBjb250ZXh0KSB7XG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzW2ZpZWxkTmFtZV07XG5cbiAgICAgICAgcmV0dXJuIF8uZmluZChkZXBzLCBkID0+IF8uaXNQbGFpbk9iamVjdChkKSA/IGhhc0tleUJ5UGF0aChjb250ZXh0LCBkLnJlZmVyZW5jZSkgOiBoYXNLZXlCeVBhdGgoY29udGV4dCwgZCkpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcmVmZXJlbmNlRXhpc3QoaW5wdXQsIHJlZikge1xuICAgICAgICBsZXQgcG9zID0gcmVmLmluZGV4T2YoJy4nKTtcblxuICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZi5zdWJzdHIocG9zKzEpIGluIGlucHV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZiBpbiBpbnB1dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgbnVsbERlcGVuZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiBcbiAgICAgICAgICAgICAgICBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQud2hlbk51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChpbnB1dFtmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsRGVwZW5kcy5hZGQoZGVwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGQgPSBkLnJlZmVyZW5jZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWVsZE5hbWUgaW4gaW5wdXQgJiYgIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChsZXQgZGVwIG9mIG51bGxEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uZmluZChkZXAsIGQgPT4gIXRoaXMuX3JlZmVyZW5jZUV4aXN0KGlucHV0LCBkLnJlZmVyZW5jZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nLCB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsICAgXG4gICAgICAgICAgICAgICAgICAgIGtleUZpZWxkczogdGhpcy5tZXRhLmtleUZpZWxkICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcywgbnVsbCwgdHJ1ZSk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBmaW5kQWxsIHByb2Nlc3NpbmdcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0S2V5RmllbGQ6IGtleUZpZWxkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMudG9EaWN0aW9uYXJ5KHJlY29yZHMsIGtleUZpZWxkKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplLCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudCgnVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=
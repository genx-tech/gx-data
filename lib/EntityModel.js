"use strict";

require("source-map-support/register");
const {
  HttpCode,
  UnexpectedState,
  ValidationError,
  DatabaseError,
  InvalidArgument
} = require('@genx/error');
const {
  _,
  eachAsync_
} = require('@genx/july');
const Generators = require('./Generators');
const Convertors = require('./Convertors');
const Types = require('./types');
const Features = require('./entityFeatures');
const Rules = require('./enum/Rules');
const {
  isNothing,
  hasValueIn
} = require('./utils/lang');
const JES = require('@genx/jes');
const NEED_OVERRIDE = 'Should be overrided by driver-specific subclass.';
function minifyAssocs(assocs) {
  const sorted = _.uniq(assocs).sort().reverse();
  const minified = _.take(sorted, 1);
  const l = sorted.length - 1;
  for (let i = 1; i < l; i++) {
    const k = sorted[i] + '.';
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
  static feildMeta(...args) {
    return this.fieldSchema(...args);
  }
  static fieldSchema(name, extra) {
    const meta = this.meta.fields[name];
    if (!meta) {
      throw new InvalidArgument(`Unknown field "${name}" of entity "${this.meta.name}".`);
    }
    const schema = _.omit(meta, ['default', 'optional']);
    if (extra) {
      const {
        $addEnumValues,
        $orAsArray,
        ...others
      } = extra;
      let arrayElem = schema;
      if ($orAsArray) {
        arrayElem = {
          ...schema,
          ...others
        };
      }
      if (meta.type === Types.ENUM.name && $addEnumValues) {
        schema.values = schema.values.concat($addEnumValues);
      }
      Object.assign(schema, others);
      if ($orAsArray) {
        return [schema, {
          type: 'array',
          elementSchema: arrayElem
        }];
      }
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
  static assocFrom(extraArray, fields) {
    const result = new Set(extraArray);
    if (fields) {
      fields.forEach(keyPath => {
        const keyNodes = keyPath.split('.');
        if (keyNodes.length > 1) {
          const assoc = keyNodes.slice(0, -1).map(p => p.startsWith(":") ? p.substring(1) : p).join('.');
          result.add(assoc);
        }
      });
    }
    return Array.from(result);
  }
  static getUniqueKeyFieldsFrom(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }
  static getUniqueKeyValuePairsFrom(data) {
    const ukFields = this.getUniqueKeyFieldsFrom(data);
    return _.pick(data, ukFields);
  }
  static getNestedObject(entityObj, keyPath, defaultValue) {
    const nodes = (Array.isArray(keyPath) ? keyPath : keyPath.split('.')).map(key => key[0] === ':' ? key : ':' + key);
    return _.get(entityObj, nodes, defaultValue);
  }
  static async ensureFields_(entityObj, fields, connOpts) {
    if (_.find(fields, field => !_.has(entityObj, field))) {
      const uk = this.getUniqueKeyValuePairsFrom(entityObj);
      if (_.isEmpty(uk)) {
        throw new UnexpectedState('None of the unique keys found from the data set.');
      }
      const findOptions = {
        $query: uk,
        $association: this.assocFrom(null, fields)
      };
      return this.findOne_(findOptions, connOpts);
    }
    return entityObj;
  }
  static ensureRetrieveCreated(context, customOptions) {
    if (!context.options.$retrieveCreated) {
      context.options.$retrieveCreated = customOptions || true;
    }
  }
  static ensureRetrieveUpdated(context, customOptions) {
    if (!context.options.$retrieveUpdated) {
      context.options.$retrieveUpdated = customOptions || true;
    }
  }
  static ensureRetrieveDeleted(context, customOptions) {
    if (!context.options.$retrieveDeleted) {
      context.options.$retrieveDeleted = customOptions || true;
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
  static async aggregate_(pipeline, connOptions) {
    const _pipeline = pipeline.map(q => this._prepareQueries(q));
    return this.db.connector.aggregate_(this.meta.name, _pipeline, connOptions);
  }
  static async findOne_(findOptions, connOptions) {
    const rawOptions = findOptions;
    findOptions = this._prepareQueries(findOptions, true);
    const context = {
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
      const result = records[0];
      return result;
    }, context);
    if (findOptions.$transformer) {
      return JES.evaluate(result, findOptions.$transformer);
    }
    return result;
  }
  static async findAll_(findOptions, connOptions) {
    const rawOptions = findOptions;
    findOptions = this._prepareQueries(findOptions);
    const context = {
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
      const ret = {
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
  static async retryCreateOnDuplicate_(dataGenerator_, maxRery, createOptions, connOptions) {
    let counter = 0;
    let errorRet;
    maxRery || (maxRery = 10);
    while (counter++ < maxRery) {
      const data = await dataGenerator_();
      try {
        return await this.create_(data, createOptions, connOptions);
      } catch (error) {
        if (error.code !== 'E_DUPLICATE') {
          throw error;
        }
        errorRet = error;
      }
    }
    return errorRet;
  }
  static async create_(data, createOptions, connOptions) {
    const rawOptions = createOptions;
    if (!createOptions) {
      createOptions = {};
    }
    let [raw, associations, references] = this._extractAssociations(data, true);
    const context = {
      op: 'create',
      raw,
      rawOptions,
      options: createOptions,
      connOptions
    };
    if (!(await this.beforeCreate_(context))) {
      return context.return;
    }
    const success = await this._safeExecute_(async context => {
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
      if (!context.options.$dryRun) {
        if (context.options.$upsert) {
          const dataForUpdating = _.pick(context.latest, Object.keys(context.raw));
          context.result = await this.db.connector.upsertOne_(this.meta.name, dataForUpdating, this.getUniqueKeyFieldsFrom(context.latest), context.connOptions, context.latest);
        } else {
          context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
        }
        this._fillResult(context);
      } else {
        context.return = context.latest;
        context.result = {
          insertId: context.latest[this.meta.keyField],
          affectedRows: 1
        };
      }
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
    if (success && !context.options.$dryRun) {
      await this.afterCreate_(context);
    }
    return context.return;
  }
  static async updateOne_(data, updateOptions, connOptions) {
    return this._update_(data, updateOptions, connOptions, true);
  }
  static async updateMany_(data, updateOptions, connOptions) {
    return this._update_(data, updateOptions, connOptions, false);
  }
  static async _update_(data, updateOptions, connOptions, forSingleRecord) {
    const rawOptions = updateOptions;
    if (!updateOptions) {
      const conditionFields = this.getUniqueKeyFieldsFrom(data);
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
    const context = {
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
    const success = await this._safeExecute_(async context => {
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
        if (forSingleRecord && !otherOptions.$limit) {
          otherOptions.$limit = 1;
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
    if (success && !context.options.$dryRun) {
      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }
    }
    return context.return;
  }
  static async replaceOne_(data, updateOptions, connOptions) {
    const rawOptions = updateOptions;
    if (!updateOptions) {
      const conditionFields = this.getUniqueKeyFieldsFrom(data);
      if (_.isEmpty(conditionFields)) {
        throw new InvalidArgument('Primary key value(s) or at least one group of unique key value(s) is required for replacing an entity.', {
          entity: this.meta.name,
          data
        });
      }
      updateOptions = {
        ...updateOptions,
        $query: _.pick(data, conditionFields)
      };
    } else {
      updateOptions = this._prepareQueries(updateOptions, true);
    }
    const context = {
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
    const rawOptions = deleteOptions;
    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);
    if (_.isEmpty(deleteOptions.$query) && (forSingleRecord || !deleteOptions.$deleteAll)) {
      throw new InvalidArgument('Empty condition is not allowed for deleting or add { $deleteAll: true } to delete all records.', {
        entity: this.meta.name,
        deleteOptions
      });
    }
    const context = {
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
    const deletedCount = await this._safeExecute_(async context => {
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
    if (deletedCount && !context.options.$dryRun) {
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
    const hasNotNullKey = _.find(this.meta.uniqueKeys, fields => {
      const hasKeys = _.every(fields, f => f in data);
      hasKeyNameOnly = hasKeyNameOnly || hasKeys;
      return _.every(fields, f => !_.isNil(data[f]));
    });
    return [hasNotNullKey, hasKeyNameOnly];
  }
  static _ensureContainsUniqueKey(condition) {
    const [containsUniqueKeyAndValue, containsUniqueKeyOnly] = this._containsUniqueKey(condition);
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
    const meta = this.meta;
    const i18n = this.i18n;
    const {
      name,
      fields
    } = meta;
    let {
      raw
    } = context;
    let latest = {};
    let existing = context.options.$existing;
    context.latest = latest;
    if (!context.i18n) {
      context.i18n = i18n;
    }
    const opOptions = context.options;
    if (opOptions.$upsert && typeof opOptions.$upsert === 'object') {
      raw = {
        ...raw,
        ...opOptions.$upsert
      };
    }
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
      let value;
      let useRaw = false;
      if (fieldName in raw) {
        value = raw[fieldName];
        useRaw = true;
      } else if (fieldName in latest) {
        value = latest[fieldName];
      }
      if (typeof value !== 'undefined') {
        if (fieldInfo.readOnly && useRaw) {
          if (!opOptions.$migration && (!opOptions.$bypassReadOnly || !opOptions.$bypassReadOnly.has(fieldName))) {
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
          if (fieldInfo.default) {
            latest[fieldName] = fieldInfo.default;
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
        if ('default' in fieldInfo) {
          latest[fieldName] = fieldInfo.default;
        } else if (fieldInfo.optional) {} else if (fieldInfo.auto) {
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
      const fieldInfo = fields[key];
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
      const result = await executor(context);
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
    if (this.meta.fieldDependencies) {
      const deps = this.meta.fieldDependencies[fieldName];
      return _.find(deps, d => _.isPlainObject(d) ? d.reference !== fieldName && _.hasIn(context, d.reference) : _.hasIn(context, d));
    }
    return false;
  }
  static _referenceExist(input, ref) {
    const pos = ref.indexOf('.');
    if (pos > 0) {
      return ref.substr(pos + 1) in input;
    }
    return ref in input;
  }
  static _dependsOnExistingData(input) {
    const deps = this.meta.fieldDependencies;
    let hasDepends = false;
    if (deps) {
      const nullDepends = new Set();
      hasDepends = _.find(deps, (dep, fieldName) => _.find(dep, d => {
        if (_.isPlainObject(d)) {
          if (d.whenNull) {
            if (_.isNil(input[fieldName])) {
              nullDepends.add(dep);
            }
            return false;
          }
          if (d.reference === fieldName) return false;
          d = d.reference;
        }
        return fieldName in input && !this._referenceExist(input, d) || this._referenceExist(input, d) && !(fieldName in input);
      }));
      if (hasDepends) {
        return true;
      }
      for (const dep of nullDepends) {
        if (_.find(dep, d => !this._referenceExist(input, d.reference))) {
          return true;
        }
      }
    }
    const atLeastOneNotNull = this.meta.features.atLeastOneNotNull;
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
        throw new InvalidArgument('Cannot use a singular value as condition to query against an entity with combined primary key.', {
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
    const normalizedOptions = {
      $key: this.meta.keyField
    };
    const query = {};
    _.forOwn(options, (v, k) => {
      if (k[0] === '$') {
        normalizedOptions[k] = v;
      } else {
        query[k] = v;
      }
    });
    normalizedOptions.$query = {
      ...query,
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
            const errArgs = [];
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
      const ret = value.map(v => this._translateValue(v, variables, skipTypeCast, arrayToInOperator));
      return arrayToInOperator ? {
        $in: ret
      } : ret;
    }
    if (skipTypeCast) return value;
    return this.db.connector.typeCast(value);
  }
}
module.exports = EntityModel;
//# sourceMappingURL=EntityModel.js.map
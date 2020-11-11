"use strict";

require("source-map-support/register");

-"use strict";

const Util = require("rk-utils");

const {
  _,
  getValueByPath,
  setValueByPath,
  eachAsync_
} = Util;

const EntityModel = require("../../EntityModel");

const {
  ApplicationError,
  ReferencedNotExistError,
  DuplicateError,
  ValidationError,
  InvalidArgument
} = require("../../utils/Errors");

const Types = require("../../types");

const {
  getValueFrom,
  mapFilter
} = require("../../utils/lang");

const defaultNestedKeyGetter = anchor => ':' + anchor;

class MySQLEntityModel extends EntityModel {
  static get hasAutoIncrement() {
    let autoId = this.meta.features.autoId;
    return autoId && this.meta.fields[autoId.field].autoIncrementId;
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath.split(".").map(p => ":" + p).join("."));
  }

  static _translateSymbolToken(name) {
    if (name === "NOW") {
      return this.db.connector.raw("NOW()");
    }

    throw new Error("not support: " + name);
  }

  static _serializeByTypeInfo(value, info) {
    if (info.type === "boolean") {
      return value ? 1 : 0;
    }

    if (info.type === "datetime") {
      return Types.DATETIME.serialize(value);
    }

    if (info.type === "array" && Array.isArray(value)) {
      if (info.csv) {
        return Types.ARRAY.toCsv(value);
      } else {
        return Types.ARRAY.serialize(value);
      }
    }

    if (info.type === "object") {
      return Types.OBJECT.serialize(value);
    }

    return value;
  }

  static async create_(...args) {
    try {
      return await super.create_(...args);
    } catch (error) {
      let errorCode = error.code;

      if (errorCode === "ER_NO_REFERENCED_ROW_2") {
        throw new ReferencedNotExistError("The new entity is referencing to an unexisting entity. Detail: " + error.message, error.info);
      } else if (errorCode === "ER_DUP_ENTRY") {
        throw new DuplicateError(error.message + ` while creating a new "${this.meta.name}".`, error.info);
      }

      throw error;
    }
  }

  static async updateOne_(...args) {
    try {
      return await super.updateOne_(...args);
    } catch (error) {
      let errorCode = error.code;

      if (errorCode === "ER_NO_REFERENCED_ROW_2") {
        throw new ReferencedNotExistError("The entity to be updated is referencing to an unexisting entity. Detail: " + error.message, error.info);
      } else if (errorCode === "ER_DUP_ENTRY") {
        throw new DuplicateError(error.message + ` while updating an existing "${this.meta.name}".`, error.info);
      }

      throw error;
    }
  }

  static async _doReplaceOne_(context) {
    await this.ensureTransaction_(context);
    let entity = await this.findOne_({
      $query: context.options.$query
    }, context.connOptions);
    let ret, options;

    if (entity) {
      if (context.options.$retrieveExisting) {
        context.rawOptions.$existing = entity;
      }

      options = { ...context.options,
        $query: {
          [this.meta.keyField]: super.valueOfKey(entity)
        },
        $existing: entity
      };
      ret = await this.updateOne_(context.raw, options, context.connOptions);
    } else {
      options = { ..._.omit(context.options, ["$retrieveUpdated", "$bypassEnsureUnique"]),
        $retrieveCreated: context.options.$retrieveUpdated
      };
      ret = await this.create_(context.raw, options, context.connOptions);
    }

    if (options.$existing) {
      context.rawOptions.$existing = options.$existing;
    }

    if (options.$result) {
      context.rawOptions.$result = options.$result;
    }

    return ret;
  }

  static _internalBeforeCreate_(context) {
    return true;
  }

  static async _internalAfterCreate_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (context.options.$retrieveCreated) {
      if (this.hasAutoIncrement) {
        if (context.result.affectedRows === 0) {
          context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);

          if (_.isEmpty(context.queryKey)) {
            throw new ApplicationError('Cannot extract unique keys from input data.', {
              entity: this.meta.name
            });
          }
        } else {
          let {
            insertId
          } = context.result;
          context.queryKey = {
            [this.meta.features.autoId.field]: insertId
          };
        }
      } else {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);

        if (_.isEmpty(context.queryKey)) {
          throw new ApplicationError('Cannot extract unique keys from input data.', {
            entity: this.meta.name
          });
        }
      }

      let retrieveOptions = _.isPlainObject(context.options.$retrieveCreated) ? context.options.$retrieveCreated : {};
      context.return = await this.findOne_({ ...retrieveOptions,
        $query: context.queryKey
      }, context.connOptions);
    } else {
      if (this.hasAutoIncrement) {
        if (context.result.affectedRows === 0) {
          context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
        } else {
          let {
            insertId
          } = context.result;
          context.queryKey = {
            [this.meta.features.autoId.field]: insertId
          };
        }

        context.return = context.latest = { ...context.return,
          ...context.queryKey
        };
      }
    }
  }

  static _internalBeforeUpdate_(context) {
    return true;
  }

  static _internalBeforeUpdateMany_(context) {
    return true;
  }

  static async _internalAfterUpdate_(context) {
    const options = context.options;

    if (options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    let retrieveUpdated = options.$retrieveUpdated;

    if (!retrieveUpdated) {
      if (options.$retrieveActualUpdated && context.result.affectedRows > 0) {
        retrieveUpdated = options.$retrieveActualUpdated;
      } else if (options.$retrieveNotUpdate && context.result.affectedRows === 0) {
        retrieveUpdated = options.$retrieveNotUpdate;
      }
    }

    if (retrieveUpdated) {
      let condition = {
        $query: this.getUniqueKeyValuePairsFrom(options.$query)
      };

      if (options.$bypassEnsureUnique) {
        condition.$bypassEnsureUnique = options.$bypassEnsureUnique;
      }

      let retrieveOptions = {};

      if (_.isPlainObject(retrieveUpdated)) {
        retrieveOptions = retrieveUpdated;
      } else if (options.$relationships) {
        retrieveOptions.$relationships = options.$relationships;
      }

      context.return = await this.findOne_({ ...condition,
        $includeDeleted: options.$retrieveDeleted,
        ...retrieveOptions
      }, context.connOptions);

      if (context.return) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.return);
      } else {
        context.queryKey = condition.$query;
      }
    }
  }

  static async _internalAfterUpdateMany_(context) {
    const options = context.options;

    if (options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (options.$retrieveUpdated) {
      let retrieveOptions = {};

      if (_.isPlainObject(options.$retrieveUpdated)) {
        retrieveOptions = options.$retrieveUpdated;
      } else if (options.$relationships) {
        retrieveOptions.$relationships = options.$relationships;
      }

      context.return = await this.findAll_({
        $query: options.$query,
        $includeDeleted: options.$retrieveDeleted,
        ...retrieveOptions
      }, context.connOptions);
    }

    context.queryKey = options.$query;
  }

  static async _internalBeforeDelete_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? { ...context.options.$retrieveDeleted,
        $query: context.options.$query
      } : {
        $query: context.options.$query
      };

      if (context.options.$physicalDeletion) {
        retrieveOptions.$includeDeleted = true;
      }

      context.return = context.existing = await this.findOne_(retrieveOptions, context.connOptions);
    }

    return true;
  }

  static async _internalBeforeDeleteMany_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? { ...context.options.$retrieveDeleted,
        $query: context.options.$query
      } : {
        $query: context.options.$query
      };

      if (context.options.$physicalDeletion) {
        retrieveOptions.$includeDeleted = true;
      }

      context.return = context.existing = await this.findAll_(retrieveOptions, context.connOptions);
    }

    return true;
  }

  static _internalAfterDelete_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }
  }

  static _internalAfterDeleteMany_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }
  }

  static _prepareAssociations(findOptions) {
    let associations = _.uniq(findOptions.$association).sort();

    let assocTable = {},
        counter = 0,
        cache = {};
    associations.forEach(assoc => {
      if (_.isPlainObject(assoc)) {
        assoc = this._translateSchemaNameToDb(assoc);
        let alias = assoc.alias;

        if (!assoc.alias) {
          alias = ":join" + ++counter;
        }

        assocTable[alias] = {
          entity: assoc.entity,
          joinType: assoc.type,
          output: assoc.output,
          key: assoc.key,
          alias,
          on: assoc.on,
          ...(assoc.dataset ? this.db.connector.buildQuery(assoc.entity, assoc.model._prepareQueries({ ...assoc.dataset,
            $variables: findOptions.$variables
          })) : {})
        };
      } else {
        this._loadAssocIntoTable(assocTable, cache, assoc);
      }
    });
    return assocTable;
  }

  static _loadAssocIntoTable(assocTable, cache, assoc) {
    if (cache[assoc]) return cache[assoc];
    let lastPos = assoc.lastIndexOf(".");
    let result;

    if (lastPos === -1) {
      let assocInfo = { ...this.meta.associations[assoc]
      };

      if (_.isEmpty(assocInfo)) {
        throw new InvalidArgument(`Entity "${this.meta.name}" does not have the association "${assoc}".`);
      }

      result = cache[assoc] = assocTable[assoc] = { ...this._translateSchemaNameToDb(assocInfo)
      };
    } else {
      let base = assoc.substr(0, lastPos);
      let last = assoc.substr(lastPos + 1);
      let baseNode = cache[base];

      if (!baseNode) {
        baseNode = this._loadAssocIntoTable(assocTable, cache, base);
      }

      let entity = baseNode.model || this.db.model(baseNode.entity);
      let assocInfo = { ...entity.meta.associations[last]
      };

      if (_.isEmpty(assocInfo)) {
        throw new InvalidArgument(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
      }

      result = { ...entity._translateSchemaNameToDb(assocInfo, this.db)
      };

      if (!baseNode.subAssocs) {
        baseNode.subAssocs = {};
      }

      cache[assoc] = baseNode.subAssocs[last] = result;
    }

    if (result.assoc) {
      this._loadAssocIntoTable(assocTable, cache, assoc + "." + result.assoc);
    }

    return result;
  }

  static _translateSchemaNameToDb(assoc, currentDb) {
    if (assoc.entity.indexOf(".") > 0) {
      let [schemaName, entityName] = assoc.entity.split(".", 2);
      let app = this.db.app;
      let refDb = app.db(schemaName);

      if (!refDb) {
        throw new ApplicationError(`The referenced schema "${schemaName}" does not have db model in the same application.`);
      }

      assoc.entity = refDb.connector.database + "." + entityName;
      assoc.model = refDb.model(entityName);

      if (!assoc.model) {
        throw new ApplicationError(`Failed load the entity model "${schemaName}.${entityName}".`);
      }
    } else {
      assoc.model = this.db.model(assoc.entity);

      if (currentDb && currentDb !== this.db) {
        assoc.entity = this.db.connector.database + "." + assoc.entity;
      }
    }

    if (!assoc.key) {
      assoc.key = assoc.model.meta.keyField;
    }

    return assoc;
  }

  static _mapRecordsToObjects([rows, columns, aliasMap], hierarchy, nestedKeyGetter) {
    nestedKeyGetter == null && (nestedKeyGetter = defaultNestedKeyGetter);
    aliasMap = _.mapValues(aliasMap, chain => chain.map(anchor => nestedKeyGetter(anchor)));
    let mainIndex = {};
    let self = this;
    columns = columns.map(col => {
      if (col.table === "") {
        const pos = col.name.indexOf('$');

        if (pos > 0) {
          return {
            table: col.name.substr(0, pos),
            name: col.name.substr(pos + 1)
          };
        }

        return {
          table: 'A',
          name: col.name
        };
      }

      return {
        table: col.table,
        name: col.name
      };
    });

    function mergeRecord(existingRow, rowObject, associations, nodePath) {
      return _.each(associations, ({
        sql,
        key,
        list,
        subAssocs
      }, anchor) => {
        if (sql) return;
        let currentPath = nodePath.concat();
        currentPath.push(anchor);
        let objKey = nestedKeyGetter(anchor);
        let subObj = rowObject[objKey];

        if (!subObj) {
          return;
        }

        let subIndexes = existingRow.subIndexes[objKey];
        let rowKeyValue = subObj[key];

        if (_.isNil(rowKeyValue)) {
          if (list && rowKeyValue == null) {
            if (existingRow.rowObject[objKey]) {
              existingRow.rowObject[objKey].push(subObj);
            } else {
              existingRow.rowObject[objKey] = [subObj];
            }
          }

          return;
        }

        let existingSubRow = subIndexes && subIndexes[rowKeyValue];

        if (existingSubRow) {
          if (subAssocs) {
            return mergeRecord(existingSubRow, subObj, subAssocs, currentPath);
          }
        } else {
          if (!list) {
            throw new ApplicationError(`The structure of association "${currentPath.join(".")}" with [key=${key}] of entity "${self.meta.name}" should be a list.`, {
              existingRow,
              rowObject
            });
          }

          if (existingRow.rowObject[objKey]) {
            existingRow.rowObject[objKey].push(subObj);
          } else {
            existingRow.rowObject[objKey] = [subObj];
          }

          let subIndex = {
            rowObject: subObj
          };

          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObj, subAssocs);
          }

          if (!subIndexes) {
            throw new ApplicationError(`The subIndexes of association "${currentPath.join(".")}" with [key=${key}] of entity "${self.meta.name}" does not exist.`, {
              existingRow,
              rowObject
            });
          }

          subIndexes[rowKeyValue] = subIndex;
        }
      });
    }

    function buildSubIndexes(rowObject, associations) {
      let indexes = {};

      _.each(associations, ({
        sql,
        key,
        list,
        subAssocs
      }, anchor) => {
        if (sql) {
          return;
        }

        if (!key) {
          throw new Error("Assertion failed: key");
        }

        let objKey = nestedKeyGetter(anchor);
        let subObject = rowObject[objKey];
        let subIndex = {
          rowObject: subObject
        };

        if (list) {
          if (!subObject) {
            return;
          }

          rowObject[objKey] = [subObject];

          if (_.isNil(subObject[key])) {
            subObject = null;
          }
        }

        if (subObject) {
          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
          }

          indexes[objKey] = subObject[key] ? {
            [subObject[key]]: subIndex
          } : {};
        }
      });

      return indexes;
    }

    let arrayOfObjs = [];
    const tableTemplate = columns.reduce((result, col) => {
      if (col.table !== 'A') {
        setValueByPath(result, [col.table, col.name], null);
      }

      return result;
    }, {});
    rows.forEach((row, i) => {
      let rowObject = {};
      let tableCache = {};
      row.reduce((result, value, i) => {
        let col = columns[i];

        if (col.table === "A") {
          result[col.name] = value;
        } else if (value != null) {
          let bucket = tableCache[col.table];

          if (bucket) {
            bucket[col.name] = value;
          } else {
            tableCache[col.table] = { ...tableTemplate[col.table],
              [col.name]: value
            };
          }
        }

        return result;
      }, rowObject);

      _.forOwn(tableCache, (obj, table) => {
        let nodePath = aliasMap[table];
        setValueByPath(rowObject, nodePath, obj);
      });

      let rowKey = rowObject[self.meta.keyField];
      let existingRow = mainIndex[rowKey];

      if (existingRow) {
        return mergeRecord(existingRow, rowObject, hierarchy, []);
      }

      arrayOfObjs.push(rowObject);
      mainIndex[rowKey] = {
        rowObject,
        subIndexes: buildSubIndexes(rowObject, hierarchy)
      };
    });
    return arrayOfObjs;
  }

  static _extractAssociations(data, isNew) {
    const raw = {},
          assocs = {},
          refs = {};
    const meta = this.meta.associations;

    _.forOwn(data, (v, k) => {
      if (k[0] === ":") {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if (isNew && (assocMeta.type === "refersTo" || assocMeta.type === "belongsTo") && anchor in data) {
          throw new ValidationError(`Association data ":${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`);
        }

        assocs[anchor] = v;
      } else if (k[0] === "@") {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if (assocMeta.type !== "refersTo" && assocMeta.type !== "belongsTo") {
          throw new ValidationError(`Association type "${assocMeta.type}" cannot be used for update by reference.`, {
            entity: this.meta.name,
            data
          });
        }

        if (isNew && anchor in data) {
          throw new ValidationError(`Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`);
        }

        const assocAnchor = ":" + anchor;

        if (assocAnchor in data) {
          throw new ValidationError(`Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with association data "${assocAnchor}".`);
        }

        if (v == null) {
          raw[anchor] = null;
        } else {
          refs[anchor] = v;
        }
      } else {
        raw[k] = v;
      }
    });

    return [raw, assocs, refs];
  }

  static async _populateReferences_(context, references) {
    const meta = this.meta.associations;
    await eachAsync_(references, async (refQuery, anchor) => {
      const assocMeta = meta[anchor];
      const ReferencedEntity = this.db.model(assocMeta.entity);

      if (!!assocMeta.list) {
        throw new Error("Assertion failed: !assocMeta.list");
      }

      let created = await ReferencedEntity.findOne_(refQuery, context.connOptions);

      if (!created) {
        throw new ReferencedNotExistError(`Referenced entity "${ReferencedEntity.meta.name}" with ${JSON.stringify(refQuery)} not exist.`);
      }

      context.raw[anchor] = created[assocMeta.field];
    });
  }

  static async _createAssocs_(context, assocs, beforeEntityCreate) {
    const meta = this.meta.associations;
    let keyValue;

    if (!beforeEntityCreate) {
      keyValue = context.return[this.meta.keyField];

      if (_.isNil(keyValue)) {
        if (context.result.affectedRows === 0) {
          const query = this.getUniqueKeyValuePairsFrom(context.return);
          context.return = await this.findOne_({
            $query: query
          }, context.connOptions);

          if (!context.return) {
            throw new ApplicationError("The parent entity is duplicated on unique keys different from the pair of keys used to query", {
              query,
              data: context.latest
            });
          }
        }

        keyValue = context.return[this.meta.keyField];

        if (_.isNil(keyValue)) {
          throw new ApplicationError("Missing required primary key field value. Entity: " + this.meta.name, {
            data: context.return,
            associations: assocs
          });
        }
      }
    }

    const pendingAssocs = {};
    const finished = {};

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables"]);

    await eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (beforeEntityCreate && assocMeta.type !== "refersTo" && assocMeta.type !== "belongsTo") {
        pendingAssocs[anchor] = data;
        return;
      }

      let assocModel = this.db.model(assocMeta.entity);

      if (assocMeta.list) {
        data = _.castArray(data);

        if (!assocMeta.field) {
          throw new ApplicationError(`Missing "field" property in the metadata of association "${anchor}" of entity "${this.meta.name}".`);
        }

        return eachAsync_(data, item => assocModel.create_({ ...item,
          [assocMeta.field]: keyValue
        }, passOnOptions, context.connOptions));
      } else if (!_.isPlainObject(data)) {
        if (Array.isArray(data)) {
          throw new ApplicationError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
        }

        if (!assocMeta.assoc) {
          throw new ApplicationError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
        }

        data = {
          [assocMeta.assoc]: data
        };
      }

      if (!beforeEntityCreate && assocMeta.field) {
        data = { ...data,
          [assocMeta.field]: keyValue
        };
      }

      passOnOptions.$retrieveDbResult = true;
      let created = await assocModel.create_(data, passOnOptions, context.connOptions);

      if (passOnOptions.$result.affectedRows === 0) {
        const assocQuery = assocModel.getUniqueKeyValuePairsFrom(data);
        created = await assocModel.findOne_({
          $query: assocQuery
        }, context.connOptions);

        if (!created) {
          throw new ApplicationError("The assoicated entity is duplicated on unique keys different from the pair of keys used to query", {
            query: assocQuery,
            data
          });
        }
      }

      finished[anchor] = beforeEntityCreate ? created[assocMeta.field] : created[assocMeta.key];
    });

    if (beforeEntityCreate) {
      _.forOwn(finished, (refFieldValue, localField) => {
        context.raw[localField] = refFieldValue;
      });
    }

    return pendingAssocs;
  }

  static async _updateAssocs_(context, assocs, beforeEntityUpdate, forSingleRecord) {
    const meta = this.meta.associations;
    let currentKeyValue;

    if (!beforeEntityUpdate) {
      currentKeyValue = getValueFrom([context.options.$query, context.return], this.meta.keyField);

      if (_.isNil(currentKeyValue)) {
        throw new ApplicationError("Missing required primary key field value. Entity: " + this.meta.name);
      }
    }

    const pendingAssocs = {};

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables"]);

    await eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (beforeEntityUpdate && assocMeta.type !== "refersTo" && assocMeta.type !== "belongsTo") {
        pendingAssocs[anchor] = data;
        return;
      }

      let assocModel = this.db.model(assocMeta.entity);

      if (assocMeta.list) {
        data = _.castArray(data);

        if (!assocMeta.field) {
          throw new ApplicationError(`Missing "field" property in the metadata of association "${anchor}" of entity "${this.meta.name}".`);
        }

        const assocKeys = mapFilter(data, record => record[assocMeta.key] != null, record => record[assocMeta.key]);
        const assocRecordsToRemove = {
          [assocMeta.field]: currentKeyValue
        };

        if (assocKeys.length > 0) {
          assocRecordsToRemove[assocMeta.key] = {
            $notIn: assocKeys
          };
        }

        await assocModel.deleteMany_(assocRecordsToRemove, context.connOptions);
        return eachAsync_(data, item => item[assocMeta.key] != null ? assocModel.updateOne_({ ..._.omit(item, [assocMeta.key]),
          [assocMeta.field]: currentKeyValue
        }, {
          $query: {
            [assocMeta.key]: item[assocMeta.key]
          },
          ...passOnOptions
        }, context.connOptions) : assocModel.create_({ ...item,
          [assocMeta.field]: currentKeyValue
        }, passOnOptions, context.connOptions));
      } else if (!_.isPlainObject(data)) {
        if (Array.isArray(data)) {
          throw new ApplicationError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
        }

        if (!assocMeta.assoc) {
          throw new ApplicationError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
        }

        data = {
          [assocMeta.assoc]: data
        };
      }

      if (beforeEntityUpdate) {
        if (_.isEmpty(data)) return;
        let destEntityId = getValueFrom([context.existing, context.options.$query, context.raw], anchor);

        if (destEntityId == null) {
          if (!_.isEmpty(context.existing)) {
            if (!(anchor in context.existing)) {
              throw new ApplicationError("Existing does not contain the referenced entity id.", {
                anchor,
                data,
                existing: context.existing,
                query: context.options.$query,
                raw: context.raw
              });
            }

            return;
          }

          context.existing = await this.findOne_(context.options.$query, context.connOptions);

          if (!context.existing) {
            throw new ValidationError(`Specified "${this.meta.name}" not found.`, {
              query: context.options.$query
            });
          }

          destEntityId = context.existing[anchor];

          if (destEntityId == null && !(anchor in context.existing)) {
            throw new ApplicationError("Existing does not contain the referenced entity id.", {
              anchor,
              data,
              existing: context.existing,
              query: context.options.$query
            });
          }
        }

        if (destEntityId) {
          return assocModel.updateOne_(data, {
            [assocMeta.field]: destEntityId,
            ...passOnOptions
          }, context.connOptions);
        }

        return;
      }

      await assocModel.deleteMany_({
        [assocMeta.field]: currentKeyValue
      }, context.connOptions);

      if (forSingleRecord) {
        return assocModel.create_({ ...data,
          [assocMeta.field]: currentKeyValue
        }, passOnOptions, context.connOptions);
      }

      throw new Error("update associated data for multiple records not implemented");
    });
    return pendingAssocs;
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwicmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlQWN0dWFsVXBkYXRlZCIsIiRyZXRyaWV2ZU5vdFVwZGF0ZSIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiJHBoeXNpY2FsRGVsZXRpb24iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJhbGlhcyIsImpvaW5UeXBlIiwib3V0cHV0Iiwia2V5Iiwib24iLCJkYXRhc2V0IiwiYnVpbGRRdWVyeSIsIm1vZGVsIiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsInNjaGVtYU5hbWUiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm5lc3RlZEtleUdldHRlciIsIm1hcFZhbHVlcyIsImNoYWluIiwibWFpbkluZGV4Iiwic2VsZiIsImNvbCIsInRhYmxlIiwicG9zIiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsIm5vZGVQYXRoIiwiZWFjaCIsInNxbCIsImxpc3QiLCJjdXJyZW50UGF0aCIsImNvbmNhdCIsInB1c2giLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5VmFsdWUiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJ0YWJsZVRlbXBsYXRlIiwicmVkdWNlIiwicm93IiwiaSIsInRhYmxlQ2FjaGUiLCJidWNrZXQiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiYXNzb2NRdWVyeSIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLENBQUMsWUFBRDs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUNBLE1BQU1NLFdBQVcsR0FBR0wsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLHVCQUFwQjtBQUE2Q0MsRUFBQUEsY0FBN0M7QUFBNkRDLEVBQUFBLGVBQTdEO0FBQThFQyxFQUFBQTtBQUE5RSxJQUFrR1YsT0FBTyxDQUFDLG9CQUFELENBQS9HOztBQUNBLE1BQU1XLEtBQUssR0FBR1gsT0FBTyxDQUFDLGFBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFWSxFQUFBQSxZQUFGO0FBQWdCQyxFQUFBQTtBQUFoQixJQUE4QmIsT0FBTyxDQUFDLGtCQUFELENBQTNDOztBQUVBLE1BQU1jLHNCQUFzQixHQUFJQyxNQUFELElBQWEsTUFBTUEsTUFBbEQ7O0FBS0EsTUFBTUMsZ0JBQU4sU0FBK0JYLFdBQS9CLENBQTJDO0FBSXZDLGFBQVdZLGdCQUFYLEdBQThC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bCA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIFJlZmVyZW5jZWROb3RFeGlzdEVycm9yLCBEdXBsaWNhdGVFcnJvciwgVmFsaWRhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9FcnJvcnNcIik7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoXCIuLi8uLi90eXBlc1wiKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tLCBtYXBGaWx0ZXIgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9sYW5nXCIpO1xuXG5jb25zdCBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyID0gKGFuY2hvcikgPT4gKCc6JyArIGFuY2hvcik7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICogQHBhcmFtIHsqfSBpbmZvXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImFycmF5XCIgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdCA9IHsgLi4uY29udGV4dC5yZXR1cm4sIC4uLmNvbnRleHQucXVlcnlLZXkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcblxuICAgICAgICBpZiAoIXJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZSAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShvcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSByZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5jb25kaXRpb24sICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAuLi5yZXRyaWV2ZU9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAkcXVlcnk6IG9wdGlvbnMuJHF1ZXJ5LCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCxcbiAgICAgICAgICAgICAgICAgICAgLi4ucmV0cmlldmVPcHRpb25zLCAgICAgICBcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gb3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7XG4gICAgICAgIGxldCBhc3NvY2lhdGlvbnMgPSBfLnVuaXEoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKS5zb3J0KCk7XG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sXG4gICAgICAgICAgICBjb3VudGVyID0gMCxcbiAgICAgICAgICAgIGNhY2hlID0ge307XG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goKGFzc29jKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IFwiOmpvaW5cIiArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0XG4gICAgICAgICAgICAgICAgICAgICAgICA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgICAgICAgbGV0IHJlc3VsdDtcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MgKyAxKTtcblxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgXCIuXCIgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgZW50aXR5TmFtZV0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoXCIuXCIsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5LCBuZXN0ZWRLZXlHZXR0ZXIpIHtcbiAgICAgICAgbmVzdGVkS2V5R2V0dGVyID09IG51bGwgJiYgKG5lc3RlZEtleUdldHRlciA9IGRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIpOyAgICAgICAgXG4gICAgICAgIGFsaWFzTWFwID0gXy5tYXBWYWx1ZXMoYWxpYXNNYXAsIGNoYWluID0+IGNoYWluLm1hcChhbmNob3IgPT4gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcikpKTtcblxuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICBjb2x1bW5zID0gY29sdW1ucy5tYXAoY29sID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb3MgPSBjb2wubmFtZS5pbmRleE9mKCckJyk7XG4gICAgICAgICAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wubmFtZS5zdWJzdHIoMCwgcG9zKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLnN1YnN0cihwb3MrMSlcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgdGFibGU6ICdBJyxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wudGFibGUsXG4gICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleGVzID0gZXhpc3RpbmdSb3cuc3ViSW5kZXhlc1tvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXlWYWx1ZSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAobGlzdCAmJiByb3dLZXlWYWx1ZSA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBzaG91bGQgYmUgYSBsaXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaixcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBkb2VzIG5vdCBleGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZCAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gLyplbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvL3Jvd09iamVjdFtvYmpLZXldID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHN1Yk9iamVjdFtrZXldID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXgsXG4gICAgICAgICAgICAgICAgICAgIH0gOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHRhYmxlVGVtcGxhdGUgPSBjb2x1bW5zLnJlZHVjZSgocmVzdWx0LCBjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgIT09ICdBJykge1xuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJlc3VsdCwgW2NvbC50YWJsZSwgY29sLm5hbWVdLCBudWxsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcblxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlICE9IG51bGwpIHsgLy8gYXZvaWQgYSBvYmplY3Qgd2l0aCBhbGwgbnVsbCB2YWx1ZSBleGlzdHNcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGVcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHsgLi4udGFibGVUZW1wbGF0ZVtjb2wudGFibGVdLCBbY29sLm5hbWVdOiB2YWx1ZSB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpO1xuXG4gICAgICAgICAgICBfLmZvck93bih0YWJsZUNhY2hlLCAob2JqLCB0YWJsZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW3RhYmxlXTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocm93T2JqZWN0LCBub2RlUGF0aCwgb2JqKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgcm93S2V5ID0gcm93T2JqZWN0W3NlbGYubWV0YS5rZXlGaWVsZF07XG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdSb3cgPSBtYWluSW5kZXhbcm93S2V5XTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdykge1xuICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgIHJvd09iamVjdCxcbiAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpLFxuICAgICAgICAgICAgfTsgIFxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXJyYXlPZk9ianM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIGlzTmV3KSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LFxuICAgICAgICAgICAgYXNzb2NzID0ge30sXG4gICAgICAgICAgICByZWZzID0ge307XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gXCI6XCIpIHtcbiAgICAgICAgICAgICAgICAvL2Nhc2NhZGUgdXBkYXRlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChrWzBdID09PSBcIkBcIikge1xuICAgICAgICAgICAgICAgIC8vdXBkYXRlIGJ5IHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBBc3NvY2lhdGlvbiB0eXBlIFwiJHthc3NvY01ldGEudHlwZX1cIiBjYW5ub3QgYmUgdXNlZCBmb3IgdXBkYXRlIGJ5IHJlZmVyZW5jZS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0FuY2hvciA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0FuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggYXNzb2NpYXRpb24gZGF0YSBcIiR7YXNzb2NBbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh2ID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2FuY2hvcl0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlZnNbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmF3W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFtyYXcsIGFzc29jcywgcmVmc107XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhyZWZlcmVuY2VzLCBhc3luYyAocmVmUXVlcnksIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgY29uc3QgUmVmZXJlbmNlZEVudGl0eSA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGFzc2VydDogIWFzc29jTWV0YS5saXN0O1xuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IFJlZmVyZW5jZWRFbnRpdHkuZmluZE9uZV8ocmVmUXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoYFJlZmVyZW5jZWQgZW50aXR5IFwiJHtSZWZlcmVuY2VkRW50aXR5Lm1ldGEubmFtZX1cIiB3aXRoICR7SlNPTi5zdHJpbmdpZnkocmVmUXVlcnkpfSBub3QgZXhpc3QuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiVGhlIHBhcmVudCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhOiBjb250ZXh0LnJldHVybixcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uczogYXNzb2NzXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkc2tpcE1vZGlmaWVyc1wiLCBcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAvL2hhc01hbnkgb3IgaGFzT25lXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQgPSB0cnVlO1xuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICBpZiAocGFzc09uT3B0aW9ucy4kcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUXVlcnkgPSBhc3NvY01vZGVsLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgICAgIGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmZpbmRPbmVfKHsgJHF1ZXJ5OiBhc3NvY1F1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogYXNzb2NRdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1tsb2NhbEZpZWxkXSA9IHJlZkZpZWxkVmFsdWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0tleXMgPSBtYXBGaWx0ZXIoZGF0YSwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSAhPSBudWxsLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NSZWNvcmRzVG9SZW1vdmUgPSB7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NSZWNvcmRzVG9SZW1vdmVbYXNzb2NNZXRhLmtleV0gPSB7ICRub3RJbjogYXNzb2NLZXlzIH07ICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKGFzc29jUmVjb3Jkc1RvUmVtb3ZlLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PiBpdGVtW2Fzc29jTWV0YS5rZXldICE9IG51bGwgP1xuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLl8ub21pdChpdGVtLCBbYXNzb2NNZXRhLmtleV0pLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7ICRxdWVyeTogeyBbYXNzb2NNZXRhLmtleV06IGl0ZW1bYXNzb2NNZXRhLmtleV0gfSwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApOlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG9cbiAgICAgICAgICAgICAgICBsZXQgZGVzdEVudGl0eUlkID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0LmV4aXN0aW5nLCBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJhd10sIGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiRXhpc3RpbmcgZG9lcyBub3QgY29udGFpbiB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgaWQuXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZzogY29udGV4dC5leGlzdGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFNwZWNpZmllZCBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgbm90IGZvdW5kLmAsIHsgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCAmJiAhKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
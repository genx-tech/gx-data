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

const defaultNestedKeyGetter = anchor => ":" + anchor;

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

  static _fillResult(context) {
    if (this.hasAutoIncrement && context.result.affectedRows > 0) {
      let {
        insertId
      } = context.result;

      if (insertId > 0) {
        context.latest = { ...context.latest,
          [this.meta.features.autoId.field]: insertId
        };
      }
    }

    context.return = context.latest;
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
            throw new ApplicationError("Cannot extract unique keys from input data.", {
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
          throw new ApplicationError("Cannot extract unique keys from input data.", {
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
      context.rawOptions.$result = context.result || {
        affectedRows: 0,
        changedRows: 0
      };
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
      context.rawOptions.$result = context.result || {
        affectedRows: 0,
        changedRows: 0
      };
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
    const [normalAssocs, customAssocs] = _.partition(findOptions.$association, assoc => typeof assoc === "string");

    let associations = _.uniq(normalAssocs).sort().concat(customAssocs);

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
        const pos = col.name.indexOf("$");

        if (pos > 0) {
          return {
            table: col.name.substr(0, pos),
            name: col.name.substr(pos + 1)
          };
        }

        return {
          table: "A",
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
            rowObject[objKey] = [];
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
      if (col.table !== "A") {
        let bucket = result[col.table];

        if (bucket) {
          bucket[col.name] = null;
        } else {
          result[col.table] = {
            [col.name]: null
          };
        }
      }

      return result;
    }, {});
    rows.forEach(row => {
      let tableCache = {};
      let rowObject = row.reduce((result, value, colIdx) => {
        let col = columns[colIdx];

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
      }, {});

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
              data: context.return,
              associations: assocs
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

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables", "$upsert"]);

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

      if (passOnOptions.$result.affectedRows === 0 || assocModel.hasAutoIncrement && passOnOptions.$result.insertId === 0) {
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

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables", "$upsert"]);

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
          if (_.isEmpty(context.existing)) {
            context.existing = await this.findOne_(context.options.$query, context.connOptions);

            if (!context.existing) {
              throw new ValidationError(`Specified "${this.meta.name}" not found.`, {
                query: context.options.$query
              });
            }

            destEntityId = context.existing[anchor];
          }

          if (destEntityId == null) {
            if (!(anchor in context.existing)) {
              throw new ApplicationError("Existing entity record does not contain the referenced entity id.", {
                anchor,
                data,
                existing: context.existing,
                query: context.options.$query,
                raw: context.raw
              });
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

            context.raw[anchor] = created[assocMeta.field];
            return;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfZmlsbFJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsImluc2VydElkIiwibGF0ZXN0IiwicmV0dXJuIiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwiaXNFbXB0eSIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJjaGFuZ2VkUm93cyIsInJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQiLCIkcmV0cmlldmVOb3RVcGRhdGUiLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIiRwaHlzaWNhbERlbGV0aW9uIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwibm9ybWFsQXNzb2NzIiwiY3VzdG9tQXNzb2NzIiwicGFydGl0aW9uIiwiJGFzc29jaWF0aW9uIiwiYXNzb2MiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwic29ydCIsImNvbmNhdCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJzY2hlbWFOYW1lIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJuZXN0ZWRLZXlHZXR0ZXIiLCJtYXBWYWx1ZXMiLCJjaGFpbiIsIm1haW5JbmRleCIsInNlbGYiLCJjb2wiLCJ0YWJsZSIsInBvcyIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiY3VycmVudFBhdGgiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleVZhbHVlIiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInN1YkluZGV4IiwiYnVpbGRTdWJJbmRleGVzIiwiaW5kZXhlcyIsInN1Yk9iamVjdCIsImFycmF5T2ZPYmpzIiwidGFibGVUZW1wbGF0ZSIsInJlZHVjZSIsImJ1Y2tldCIsInJvdyIsInRhYmxlQ2FjaGUiLCJjb2xJZHgiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiYXNzb2NRdWVyeSIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLENBQUMsWUFBRDs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUNBLE1BQU1NLFdBQVcsR0FBR0wsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFDRk0sRUFBQUEsZ0JBREU7QUFFRkMsRUFBQUEsdUJBRkU7QUFHRkMsRUFBQUEsY0FIRTtBQUlGQyxFQUFBQSxlQUpFO0FBS0ZDLEVBQUFBO0FBTEUsSUFNRlYsT0FBTyxDQUFDLG9CQUFELENBTlg7O0FBT0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVZLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCYixPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTWMsc0JBQXNCLEdBQUlDLE1BQUQsSUFBWSxNQUFNQSxN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LEVBQStEeEssT0FBTyxDQUFDTSxXQUF2RSxDQUFOOztBQUVBLFVBQUlpSyxlQUFKLEVBQXFCO0FBQ2pCLGVBQU9SLFVBQVUsQ0FBQ3ZLLE9BQVgsQ0FDSCxFQUFFLEdBQUdnSixJQUFMO0FBQVcsV0FBQ00sU0FBUyxDQUFDakwsS0FBWCxHQUFtQjJNO0FBQTlCLFNBREcsRUFFSFgsYUFGRyxFQUdIN0osT0FBTyxDQUFDTSxXQUhMLENBQVA7QUFLSDs7QUFFRCxZQUFNLElBQUkzQixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUdILEtBL0llLENBQWhCO0FBaUpBLFdBQU9nTCxhQUFQO0FBQ0g7O0FBaGxDc0M7O0FBbWxDM0NxQixNQUFNLENBQUNDLE9BQVAsR0FBaUIxTixnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyItXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZShcIi4uLy4uL0VudGl0eU1vZGVsXCIpO1xuY29uc3Qge1xuICAgIEFwcGxpY2F0aW9uRXJyb3IsXG4gICAgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IsXG4gICAgRHVwbGljYXRlRXJyb3IsXG4gICAgVmFsaWRhdGlvbkVycm9yLFxuICAgIEludmFsaWRBcmd1bWVudCxcbn0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuY29uc3QgZGVmYXVsdE5lc3RlZEtleUdldHRlciA9IChhbmNob3IpID0+IFwiOlwiICsgYW5jaG9yO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9maWxsUmVzdWx0KGNvbnRleHQpIHtcbiAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICBpZiAoaW5zZXJ0SWQgPiAwKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSB7IC4uLmNvbnRleHQubGF0ZXN0LCBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gXG5cbiAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkNhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkNhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQgfHwge1xuICAgICAgICAgICAgICAgIGFmZmVjdGVkUm93czogMCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VkUm93czogMCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuXG4gICAgICAgIGlmICghcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKG9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLmNvbmRpdGlvbiwgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsIC4uLnJldHJpZXZlT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQgfHwge1xuICAgICAgICAgICAgICAgIGFmZmVjdGVkUm93czogMCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VkUm93czogMCxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogb3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLFxuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IG9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyB7IC4uLmNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfVxuICAgICAgICAgICAgICAgIDogeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHJldHJpZXZlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyhyZXRyaWV2ZU9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7XG4gICAgICAgIGNvbnN0IFtub3JtYWxBc3NvY3MsIGN1c3RvbUFzc29jc10gPSBfLnBhcnRpdGlvbihcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbixcbiAgICAgICAgICAgIChhc3NvYykgPT4gdHlwZW9mIGFzc29jID09PSBcInN0cmluZ1wiXG4gICAgICAgICk7XG5cbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShub3JtYWxBc3NvY3MpLnNvcnQoKS5jb25jYXQoY3VzdG9tQXNzb2NzKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYyk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gXCI6am9pblwiICsgKytjb3VudGVyO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jVGFibGVbYWxpYXNdID0ge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgIG91dHB1dDogYXNzb2Mub3V0cHV0LFxuICAgICAgICAgICAgICAgICAgICBrZXk6IGFzc29jLmtleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMsXG4gICAgICAgICAgICAgICAgICAgIG9uOiBhc3NvYy5vbixcbiAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmRhdGFzZXRcbiAgICAgICAgICAgICAgICAgICAgICAgID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoXCIuXCIpO1xuICAgICAgICBsZXQgcmVzdWx0O1xuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkge1xuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcyArIDEpO1xuXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyBcIi5cIiArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoXCIuXCIpID4gMCkge1xuICAgICAgICAgICAgbGV0IFtzY2hlbWFOYW1lLCBlbnRpdHlOYW1lXSA9IGFzc29jLmVudGl0eS5zcGxpdChcIi5cIiwgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGFzc29jLmVudGl0eTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICBhc3NvYy5rZXkgPSBhc3NvYy5tb2RlbC5tZXRhLmtleUZpZWxkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHksIG5lc3RlZEtleUdldHRlcikge1xuICAgICAgICBuZXN0ZWRLZXlHZXR0ZXIgPT0gbnVsbCAmJiAobmVzdGVkS2V5R2V0dGVyID0gZGVmYXVsdE5lc3RlZEtleUdldHRlcik7XG4gICAgICAgIGFsaWFzTWFwID0gXy5tYXBWYWx1ZXMoYWxpYXNNYXAsIChjaGFpbikgPT4gY2hhaW4ubWFwKChhbmNob3IpID0+IG5lc3RlZEtleUdldHRlcihhbmNob3IpKSk7XG5cbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9O1xuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgLy9tYXAgbXlzcWwgY29sdW1uIHJlc3VsdCBpbnRvIGFycmF5IG9mIHsgdGFibGUgPHRhYmxlIGFsaWFzPiwgbmFtZTogPGNvbHVtbiBuYW1lPiB9XG4gICAgICAgIGNvbHVtbnMgPSBjb2x1bW5zLm1hcCgoY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIlwiKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcG9zID0gY29sLm5hbWUuaW5kZXhPZihcIiRcIik7XG4gICAgICAgICAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wubmFtZS5zdWJzdHIoMCwgcG9zKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLnN1YnN0cihwb3MgKyAxKSxcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICB0YWJsZTogXCJBXCIsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgdGFibGU6IGNvbC50YWJsZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vbWFwIGZsYXQgcmVjb3JkIGludG8gaGllcmFjaHlcbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IG5lc3RlZEtleUdldHRlcihhbmNob3IpO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG5cbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleVZhbHVlID0gc3ViT2JqW2tleV07XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwocm93S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChsaXN0ICYmIHJvd0tleVZhbHVlID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBzaG91bGQgYmUgYSBsaXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaixcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBkb2VzIG5vdCBleGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vYnVpbGQgc3ViIGluZGV4IGZvciBsaXN0IG1lbWJlclxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldO1xuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy93aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0gc3ViT2JqZWN0W2tleV1cbiAgICAgICAgICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9idWlsZCB0aGUgcmVzdWx0IG9iamVjdCBza2VsZXRvblxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSBcIkFcIikge1xuICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSByZXN1bHRbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wudGFibGVdID0geyBbY29sLm5hbWVdOiBudWxsIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93KSA9PiB7XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBjb2xJZHgpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tjb2xJZHhdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJBXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUgIT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBhdm9pZCBhIG9iamVjdCB3aXRoIGFsbCBudWxsIHZhbHVlIGV4aXN0c1xuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZVxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVDYWNoZVtjb2wudGFibGVdID0geyAuLi50YWJsZVRlbXBsYXRlW2NvbC50YWJsZV0sIFtjb2wubmFtZV06IHZhbHVlIH07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuXG4gICAgICAgICAgICBfLmZvck93bih0YWJsZUNhY2hlLCAob2JqLCB0YWJsZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW3RhYmxlXTtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyb3dPYmplY3QsIG5vZGVQYXRoLCBvYmopO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGhpZXJhcmNoeSwgW10pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUtcHJvY2VzcyBhc3NvaWNhdGVkIGRiIG9wZXJhdGlvblxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YVxuICAgICAqIEBwYXJhbSB7Kn0gaXNOZXcgLSBOZXcgcmVjb3JkIGZsYWcsIHRydWUgZm9yIGNyZWF0aW5nLCBmYWxzZSBmb3IgdXBkYXRpbmdcbiAgICAgKiBAcmV0dXJuc1xuICAgICAqL1xuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9LFxuICAgICAgICAgICAgcmVmcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09IFwiOlwiKSB7XG4gICAgICAgICAgICAgICAgLy9jYXNjYWRlIHVwZGF0ZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgKGFzc29jTWV0YS50eXBlID09PSBcInJlZmVyc1RvXCIgfHwgYXNzb2NNZXRhLnR5cGUgPT09IFwiYmVsb25nc1RvXCIpICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gZGF0YSBcIjoke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa1swXSA9PT0gXCJAXCIpIHtcbiAgICAgICAgICAgICAgICAvL3VwZGF0ZSBieSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiB0eXBlIFwiJHthc3NvY01ldGEudHlwZX1cIiBjYW5ub3QgYmUgdXNlZCBmb3IgdXBkYXRlIGJ5IHJlZmVyZW5jZS5gLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0FuY2hvciA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0FuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggYXNzb2NpYXRpb24gZGF0YSBcIiR7YXNzb2NBbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh2ID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2FuY2hvcl0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlZnNbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW3JhdywgYXNzb2NzLCByZWZzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcykge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKHJlZmVyZW5jZXMsIGFzeW5jIChyZWZRdWVyeSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBjb25zdCBSZWZlcmVuY2VkRW50aXR5ID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiAhYXNzb2NNZXRhLmxpc3Q7XG5cbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgUmVmZXJlbmNlZEVudGl0eS5maW5kT25lXyhyZWZRdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFJlZmVyZW5jZWQgZW50aXR5IFwiJHtSZWZlcmVuY2VkRW50aXR5Lm1ldGEubmFtZX1cIiB3aXRoICR7SlNPTi5zdHJpbmdpZnkocmVmUXVlcnkpfSBub3QgZXhpc3QuYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiVGhlIHBhcmVudCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhOiBjb250ZXh0LnJldHVybixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBhc3NvY3MgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQucmV0dXJuLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBhc3NvY3MsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkc2tpcE1vZGlmaWVyc1wiLCBcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCIsIFwiJHVwc2VydFwiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBwYXNzT25PcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0ID0gdHJ1ZTtcbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAocGFzc09uT3B0aW9ucy4kcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCB8fCAoYXNzb2NNb2RlbC5oYXNBdXRvSW5jcmVtZW50ICYmIHBhc3NPbk9wdGlvbnMuJHJlc3VsdC5pbnNlcnRJZCA9PT0gMCkpIHtcbiAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkIG9yIHVwc2VydGVkXG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1F1ZXJ5ID0gYXNzb2NNb2RlbC5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5maW5kT25lXyh7ICRxdWVyeTogYXNzb2NRdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBhc3NvY1F1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmaW5pc2hlZFthbmNob3JdID0gYmVmb3JlRW50aXR5Q3JlYXRlID8gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdIDogY3JlYXRlZFthc3NvY01ldGEua2V5XTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZmluaXNoZWQsIChyZWZGaWVsZFZhbHVlLCBsb2NhbEZpZWxkKSA9PiB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdbbG9jYWxGaWVsZF0gPSByZWZGaWVsZFZhbHVlO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcGVuZGluZ0Fzc29jcztcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQgY3VycmVudEtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICBjdXJyZW50S2V5VmFsdWUgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmV0dXJuXSwgdGhpcy5tZXRhLmtleUZpZWxkKTtcbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGN1cnJlbnRLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkc2tpcE1vZGlmaWVyc1wiLCBcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCIsIFwiJHVwc2VydFwiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgKHJlY29yZCkgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIChyZWNvcmQpID0+IHJlY29yZFthc3NvY01ldGEua2V5XVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NSZWNvcmRzVG9SZW1vdmUgPSB7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NSZWNvcmRzVG9SZW1vdmVbYXNzb2NNZXRhLmtleV0gPSB7ICRub3RJbjogYXNzb2NLZXlzIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyhhc3NvY1JlY29yZHNUb1JlbW92ZSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgaXRlbVthc3NvY01ldGEua2V5XSAhPSBudWxsXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiRXhpc3RpbmcgZW50aXR5IHJlY29yZCBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy90byBjcmVhdGUgdGhlIGFzc29jaWF0ZWQsIGV4aXN0aW5nIGlzIG51bGxcblxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBhc3NPbk9wdGlvbnMuJHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1F1ZXJ5ID0gYXNzb2NNb2RlbC5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5maW5kT25lXyh7ICRxdWVyeTogYXNzb2NRdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBhc3NvY1F1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
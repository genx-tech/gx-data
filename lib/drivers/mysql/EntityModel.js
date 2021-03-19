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
      context.return = context.latest = { ...context.latest,
        [this.meta.features.autoId.field]: insertId
      };
    } else {
      context.return = context.latest;
    }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfZmlsbFJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsImluc2VydElkIiwicmV0dXJuIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwiaXNFbXB0eSIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJjaGFuZ2VkUm93cyIsInJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQiLCIkcmV0cmlldmVOb3RVcGRhdGUiLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIiRwaHlzaWNhbERlbGV0aW9uIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwibm9ybWFsQXNzb2NzIiwiY3VzdG9tQXNzb2NzIiwicGFydGl0aW9uIiwiJGFzc29jaWF0aW9uIiwiYXNzb2MiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwic29ydCIsImNvbmNhdCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJzY2hlbWFOYW1lIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJuZXN0ZWRLZXlHZXR0ZXIiLCJtYXBWYWx1ZXMiLCJjaGFpbiIsIm1haW5JbmRleCIsInNlbGYiLCJjb2wiLCJ0YWJsZSIsInBvcyIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiY3VycmVudFBhdGgiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleVZhbHVlIiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInN1YkluZGV4IiwiYnVpbGRTdWJJbmRleGVzIiwiaW5kZXhlcyIsInN1Yk9iamVjdCIsImFycmF5T2ZPYmpzIiwidGFibGVUZW1wbGF0ZSIsInJlZHVjZSIsImJ1Y2tldCIsInJvdyIsInRhYmxlQ2FjaGUiLCJjb2xJZHgiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiYXNzb2NRdWVyeSIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLENBQUMsWUFBRDs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUNBLE1BQU1NLFdBQVcsR0FBR0wsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFDRk0sRUFBQUEsZ0JBREU7QUFFRkMsRUFBQUEsdUJBRkU7QUFHRkMsRUFBQUEsY0FIRTtBQUlGQyxFQUFBQSxlQUpFO0FBS0ZDLEVBQUFBO0FBTEUsSUFNRlYsT0FBTyxDQUFDLG9CQUFELENBTlg7O0FBT0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVZLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCYixPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTWMsc0JBQXNCLEdBQUlDLE1BQUQsSUFBWSxNQUFNQSxN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SixJQUFMO0FBQVcsV0FBQ00sU0FBUyxDQUFDakwsS0FBWCxHQUFtQjJNO0FBQTlCLFNBREcsRUFFSFgsYUFGRyxFQUdIN0osT0FBTyxDQUFDTSxXQUhMLENBQVA7QUFLSDs7QUFFRCxZQUFNLElBQUkzQixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUdILEtBL0llLENBQWhCO0FBaUpBLFdBQU9nTCxhQUFQO0FBQ0g7O0FBNWtDc0M7O0FBK2tDM0NxQixNQUFNLENBQUNDLE9BQVAsR0FBaUIxTixnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyItXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZShcIi4uLy4uL0VudGl0eU1vZGVsXCIpO1xuY29uc3Qge1xuICAgIEFwcGxpY2F0aW9uRXJyb3IsXG4gICAgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IsXG4gICAgRHVwbGljYXRlRXJyb3IsXG4gICAgVmFsaWRhdGlvbkVycm9yLFxuICAgIEludmFsaWRBcmd1bWVudCxcbn0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuY29uc3QgZGVmYXVsdE5lc3RlZEtleUdldHRlciA9IChhbmNob3IpID0+IFwiOlwiICsgYW5jaG9yO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9maWxsUmVzdWx0KGNvbnRleHQpIHtcbiAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0ID0geyAuLi5jb250ZXh0LmxhdGVzdCwgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgICAgIC4uLnJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gb3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8ocmV0cmlldmVPcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyB7IC4uLmNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfVxuICAgICAgICAgICAgICAgIDogeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHJldHJpZXZlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgW25vcm1hbEFzc29jcywgY3VzdG9tQXNzb2NzXSA9IF8ucGFydGl0aW9uKFxuICAgICAgICAgICAgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uLFxuICAgICAgICAgICAgKGFzc29jKSA9PiB0eXBlb2YgYXNzb2MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgKTtcblxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKG5vcm1hbEFzc29jcykuc29ydCgpLmNvbmNhdChjdXN0b21Bc3NvY3MpO1xuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LFxuICAgICAgICAgICAgY291bnRlciA9IDAsXG4gICAgICAgICAgICBjYWNoZSA9IHt9O1xuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSwgbmVzdGVkS2V5R2V0dGVyKSB7XG4gICAgICAgIG5lc3RlZEtleUdldHRlciA9PSBudWxsICYmIChuZXN0ZWRLZXlHZXR0ZXIgPSBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgYWxpYXNNYXAgPSBfLm1hcFZhbHVlcyhhbGlhc01hcCwgKGNoYWluKSA9PiBjaGFpbi5tYXAoKGFuY2hvcikgPT4gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcikpKTtcblxuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICAvL21hcCBteXNxbCBjb2x1bW4gcmVzdWx0IGludG8gYXJyYXkgb2YgeyB0YWJsZSA8dGFibGUgYWxpYXM+LCBuYW1lOiA8Y29sdW1uIG5hbWU+IH1cbiAgICAgICAgY29sdW1ucyA9IGNvbHVtbnMubWFwKChjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb3MgPSBjb2wubmFtZS5pbmRleE9mKFwiJFwiKTtcbiAgICAgICAgICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGU6IGNvbC5uYW1lLnN1YnN0cigwLCBwb3MpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUuc3Vic3RyKHBvcyArIDEpLFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHRhYmxlOiBcIkFcIixcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUsXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB0YWJsZTogY29sLnRhYmxlLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9tYXAgZmxhdCByZWNvcmQgaW50byBoaWVyYWNoeVxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXSA9IHN1YkluZGV4O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9idWlsZCBzdWIgaW5kZXggZm9yIGxpc3QgbWVtYmVyXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9iamVjdF07XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICpcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XVxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICAvL2J1aWxkIHRoZSByZXN1bHQgb2JqZWN0IHNrZWxldG9uXG4gICAgICAgIGNvbnN0IHRhYmxlVGVtcGxhdGUgPSBjb2x1bW5zLnJlZHVjZSgocmVzdWx0LCBjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgIT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHJlc3VsdFtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC50YWJsZV0gPSB7IFtjb2wubmFtZV06IG51bGwgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3cpID0+IHtcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGNvbElkeCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2NvbElkeF07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgICAgIF8uZm9yT3duKHRhYmxlQ2FjaGUsIChvYmosIHRhYmxlKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbdGFibGVdO1xuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgIHJvd09iamVjdCxcbiAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZS1wcm9jZXNzIGFzc29pY2F0ZWQgZGIgb3BlcmF0aW9uXG4gICAgICogQHBhcmFtIHsqfSBkYXRhXG4gICAgICogQHBhcmFtIHsqfSBpc05ldyAtIE5ldyByZWNvcmQgZmxhZywgdHJ1ZSBmb3IgY3JlYXRpbmcsIGZhbHNlIGZvciB1cGRhdGluZ1xuICAgICAqIEByZXR1cm5zXG4gICAgICovXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIGlzTmV3KSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LFxuICAgICAgICAgICAgYXNzb2NzID0ge30sXG4gICAgICAgICAgICByZWZzID0ge307XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gXCI6XCIpIHtcbiAgICAgICAgICAgICAgICAvL2Nhc2NhZGUgdXBkYXRlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChrWzBdID09PSBcIkBcIikge1xuICAgICAgICAgICAgICAgIC8vdXBkYXRlIGJ5IHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHR5cGUgXCIke2Fzc29jTWV0YS50eXBlfVwiIGNhbm5vdCBiZSB1c2VkIGZvciB1cGRhdGUgYnkgcmVmZXJlbmNlLmAsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jQW5jaG9yID0gXCI6XCIgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jQW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBhc3NvY2lhdGlvbiBkYXRhIFwiJHthc3NvY0FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHYgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICByYXdbYW5jaG9yXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVmc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3MsIHJlZnNdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18ocmVmZXJlbmNlcywgYXN5bmMgKHJlZlF1ZXJ5LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGNvbnN0IFJlZmVyZW5jZWRFbnRpdHkgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6ICFhc3NvY01ldGEubGlzdDtcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBSZWZlcmVuY2VkRW50aXR5LmZpbmRPbmVfKHJlZlF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgUmVmZXJlbmNlZCBlbnRpdHkgXCIke1JlZmVyZW5jZWRFbnRpdHkubWV0YS5uYW1lfVwiIHdpdGggJHtKU09OLnN0cmluZ2lmeShyZWZRdWVyeSl9IG5vdCBleGlzdC5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yYXdbYW5jaG9yXSA9IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJUaGUgcGFyZW50IGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQucmV0dXJuLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jcyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5yZXR1cm4sXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jcyxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBmaW5pc2hlZCA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcGFzc09uT3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCA9IHRydWU7XG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIGlmIChwYXNzT25PcHRpb25zLiRyZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NRdWVyeSA9IGFzc29jTW9kZWwuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICAgICAgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuZmluZE9uZV8oeyAkcXVlcnk6IGFzc29jUXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJUaGUgYXNzb2ljYXRlZCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogYXNzb2NRdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5VXBkYXRlLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgbGV0IGN1cnJlbnRLZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgY3VycmVudEtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgICAgICBpZiAoXy5pc05pbChjdXJyZW50S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgLy8gc2hvdWxkIGhhdmUgaW4gdXBkYXRpbmdcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgKHJlY29yZCkgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIChyZWNvcmQpID0+IHJlY29yZFthc3NvY01ldGEua2V5XVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NSZWNvcmRzVG9SZW1vdmUgPSB7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NSZWNvcmRzVG9SZW1vdmVbYXNzb2NNZXRhLmtleV0gPSB7ICRub3RJbjogYXNzb2NLZXlzIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyhhc3NvY1JlY29yZHNUb1JlbW92ZSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgaXRlbVthc3NvY01ldGEua2V5XSAhPSBudWxsXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiRXhpc3RpbmcgZW50aXR5IHJlY29yZCBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy90byBjcmVhdGUgdGhlIGFzc29jaWF0ZWQsIGV4aXN0aW5nIGlzIG51bGxcblxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBhc3NPbk9wdGlvbnMuJHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1F1ZXJ5ID0gYXNzb2NNb2RlbC5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5maW5kT25lXyh7ICRxdWVyeTogYXNzb2NRdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBhc3NvY1F1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
"use strict";

require("source-map-support/register");

-"use strict";

const {
  _,
  eachAsync_
} = require("@genx/july");

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
    return _.get(entityObj, keyPath.split(".").map(p => ":" + p).join("."));
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

        _.set(rowObject, nodePath, obj);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwicmVxdWlyZSIsIkVudGl0eU1vZGVsIiwiQXBwbGljYXRpb25FcnJvciIsIlJlZmVyZW5jZWROb3RFeGlzdEVycm9yIiwiRHVwbGljYXRlRXJyb3IiLCJWYWxpZGF0aW9uRXJyb3IiLCJJbnZhbGlkQXJndW1lbnQiLCJUeXBlcyIsImdldFZhbHVlRnJvbSIsIm1hcEZpbHRlciIsImRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIiLCJhbmNob3IiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsImdldCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwidmFsdWUiLCJpbmZvIiwidHlwZSIsIkRBVEVUSU1FIiwic2VyaWFsaXplIiwiQXJyYXkiLCJpc0FycmF5IiwiY3N2IiwiQVJSQVkiLCJ0b0NzdiIsIk9CSkVDVCIsImNyZWF0ZV8iLCJhcmdzIiwiZXJyb3IiLCJlcnJvckNvZGUiLCJjb2RlIiwibWVzc2FnZSIsInVwZGF0ZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImNvbnRleHQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJlbnRpdHkiLCJmaW5kT25lXyIsIiRxdWVyeSIsIm9wdGlvbnMiLCJjb25uT3B0aW9ucyIsInJldCIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwicmF3T3B0aW9ucyIsIiRleGlzdGluZyIsImtleUZpZWxkIiwidmFsdWVPZktleSIsIm9taXQiLCIkcmV0cmlldmVDcmVhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsIiRyZXN1bHQiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwiX2ZpbGxSZXN1bHQiLCJyZXN1bHQiLCJhZmZlY3RlZFJvd3MiLCJpbnNlcnRJZCIsImxhdGVzdCIsInJldHVybiIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicXVlcnlLZXkiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzRW1wdHkiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiY2hhbmdlZFJvd3MiLCJyZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVBY3R1YWxVcGRhdGVkIiwiJHJldHJpZXZlTm90VXBkYXRlIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiJGluY2x1ZGVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcGh5c2ljYWxEZWxldGlvbiIsImV4aXN0aW5nIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJmaW5kT3B0aW9ucyIsIm5vcm1hbEFzc29jcyIsImN1c3RvbUFzc29jcyIsInBhcnRpdGlvbiIsIiRhc3NvY2lhdGlvbiIsImFzc29jIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsInNvcnQiLCJjb25jYXQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsIl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYiIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImJhc2UiLCJzdWJzdHIiLCJsYXN0IiwiYmFzZU5vZGUiLCJzdWJBc3NvY3MiLCJjdXJyZW50RGIiLCJpbmRleE9mIiwic2NoZW1hTmFtZSIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibmVzdGVkS2V5R2V0dGVyIiwibWFwVmFsdWVzIiwiY2hhaW4iLCJtYWluSW5kZXgiLCJzZWxmIiwiY29sIiwidGFibGUiLCJwb3MiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImN1cnJlbnRQYXRoIiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJidWNrZXQiLCJyb3ciLCJ0YWJsZUNhY2hlIiwiY29sSWR4IiwiZm9yT3duIiwib2JqIiwic2V0Iiwicm93S2V5IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJkYXRhIiwiaXNOZXciLCJhc3NvY3MiLCJyZWZzIiwidiIsImsiLCJhc3NvY01ldGEiLCJhc3NvY0FuY2hvciIsIl9wb3B1bGF0ZVJlZmVyZW5jZXNfIiwicmVmZXJlbmNlcyIsInJlZlF1ZXJ5IiwiUmVmZXJlbmNlZEVudGl0eSIsImNyZWF0ZWQiLCJKU09OIiwic3RyaW5naWZ5IiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInF1ZXJ5IiwicGVuZGluZ0Fzc29jcyIsImZpbmlzaGVkIiwicGFzc09uT3B0aW9ucyIsInBpY2siLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsImFzc29jUXVlcnkiLCJyZWZGaWVsZFZhbHVlIiwibG9jYWxGaWVsZCIsIl91cGRhdGVBc3NvY3NfIiwiYmVmb3JlRW50aXR5VXBkYXRlIiwiZm9yU2luZ2xlUmVjb3JkIiwiY3VycmVudEtleVZhbHVlIiwiYXNzb2NLZXlzIiwicmVjb3JkIiwiYXNzb2NSZWNvcmRzVG9SZW1vdmUiLCJsZW5ndGgiLCIkbm90SW4iLCJkZWxldGVNYW55XyIsImRlc3RFbnRpdHlJZCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxDQUFDLFlBQUQ7O0FBRUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBb0JDLE9BQU8sQ0FBQyxZQUFELENBQWpDOztBQUNBLE1BQU1DLFdBQVcsR0FBR0QsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFDRkUsRUFBQUEsZ0JBREU7QUFFRkMsRUFBQUEsdUJBRkU7QUFHRkMsRUFBQUEsY0FIRTtBQUlGQyxFQUFBQSxlQUpFO0FBS0ZDLEVBQUFBO0FBTEUsSUFNRk4sT0FBTyxDQUFDLG9CQUFELENBTlg7O0FBT0EsTUFBTU8sS0FBSyxHQUFHUCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVRLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCVCxPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTVUsc0JBQXNCLEdBQUlDLE1BQUQsSUFBWSxNQUFNQSxNQUFqRDs7QUFLQSxNQUFNQyxnQkFBTixTQUErQlgsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1ksZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElB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QUFYLENBQ0gsRUFBRSxHQUFHaUosSUFBTDtBQUFXLFdBQUNNLFNBQVMsQ0FBQ25MLEtBQVgsR0FBbUI2TTtBQUE5QixTQURHLEVBRUhYLGFBRkcsRUFHSDlKLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBRUQsWUFBTSxJQUFJM0IsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQS9JZSxDQUFoQjtBQWlKQSxXQUFPaUwsYUFBUDtBQUNIOztBQWhsQ3NDOztBQW1sQzNDcUIsTUFBTSxDQUFDQyxPQUFQLEdBQWlCNU4sZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLVwidXNlIHN0cmljdFwiO1xuXG5jb25zdCB7IF8sIGVhY2hBc3luY18gfSA9IHJlcXVpcmUoXCJAZ2VueC9qdWx5XCIpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7XG4gICAgQXBwbGljYXRpb25FcnJvcixcbiAgICBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcixcbiAgICBEdXBsaWNhdGVFcnJvcixcbiAgICBWYWxpZGF0aW9uRXJyb3IsXG4gICAgSW52YWxpZEFyZ3VtZW50LFxufSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9FcnJvcnNcIik7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoXCIuLi8uLi90eXBlc1wiKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tLCBtYXBGaWx0ZXIgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9sYW5nXCIpO1xuXG5jb25zdCBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyID0gKGFuY2hvcikgPT4gXCI6XCIgKyBhbmNob3I7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBfLmdldChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICogQHBhcmFtIHsqfSBpbmZvXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImFycmF5XCIgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHksXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbXCIkcmV0cmlldmVVcGRhdGVkXCIsIFwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZVwiXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ZpbGxSZXN1bHQoY29udGV4dCkge1xuICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50ICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgIGlmIChpbnNlcnRJZCA+IDApIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IHsgLi4uY29udGV4dC5sYXRlc3QsIFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBcblxuICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgICAgIC4uLnJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gb3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8ocmV0cmlldmVPcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyB7IC4uLmNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfVxuICAgICAgICAgICAgICAgIDogeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHJldHJpZXZlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgW25vcm1hbEFzc29jcywgY3VzdG9tQXNzb2NzXSA9IF8ucGFydGl0aW9uKFxuICAgICAgICAgICAgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uLFxuICAgICAgICAgICAgKGFzc29jKSA9PiB0eXBlb2YgYXNzb2MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgKTtcblxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKG5vcm1hbEFzc29jcykuc29ydCgpLmNvbmNhdChjdXN0b21Bc3NvY3MpO1xuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LFxuICAgICAgICAgICAgY291bnRlciA9IDAsXG4gICAgICAgICAgICBjYWNoZSA9IHt9O1xuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSwgbmVzdGVkS2V5R2V0dGVyKSB7XG4gICAgICAgIG5lc3RlZEtleUdldHRlciA9PSBudWxsICYmIChuZXN0ZWRLZXlHZXR0ZXIgPSBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyKTtcbiAgICAgICAgYWxpYXNNYXAgPSBfLm1hcFZhbHVlcyhhbGlhc01hcCwgKGNoYWluKSA9PiBjaGFpbi5tYXAoKGFuY2hvcikgPT4gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcikpKTtcblxuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICAvL21hcCBteXNxbCBjb2x1bW4gcmVzdWx0IGludG8gYXJyYXkgb2YgeyB0YWJsZSA8dGFibGUgYWxpYXM+LCBuYW1lOiA8Y29sdW1uIG5hbWU+IH1cbiAgICAgICAgY29sdW1ucyA9IGNvbHVtbnMubWFwKChjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb3MgPSBjb2wubmFtZS5pbmRleE9mKFwiJFwiKTtcbiAgICAgICAgICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGU6IGNvbC5uYW1lLnN1YnN0cigwLCBwb3MpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUuc3Vic3RyKHBvcyArIDEpLFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHRhYmxlOiBcIkFcIixcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUsXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB0YWJsZTogY29sLnRhYmxlLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9tYXAgZmxhdCByZWNvcmQgaW50byBoaWVyYWNoeVxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXSA9IHN1YkluZGV4O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9idWlsZCBzdWIgaW5kZXggZm9yIGxpc3QgbWVtYmVyXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9iamVjdF07XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICpcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XVxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICAvL2J1aWxkIHRoZSByZXN1bHQgb2JqZWN0IHNrZWxldG9uXG4gICAgICAgIGNvbnN0IHRhYmxlVGVtcGxhdGUgPSBjb2x1bW5zLnJlZHVjZSgocmVzdWx0LCBjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgIT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHJlc3VsdFtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC50YWJsZV0gPSB7IFtjb2wubmFtZV06IG51bGwgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3cpID0+IHtcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGNvbElkeCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2NvbElkeF07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgICAgIF8uZm9yT3duKHRhYmxlQ2FjaGUsIChvYmosIHRhYmxlKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbdGFibGVdO1xuICAgICAgICAgICAgICAgIF8uc2V0KHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgIHJvd09iamVjdCxcbiAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZS1wcm9jZXNzIGFzc29pY2F0ZWQgZGIgb3BlcmF0aW9uXG4gICAgICogQHBhcmFtIHsqfSBkYXRhXG4gICAgICogQHBhcmFtIHsqfSBpc05ldyAtIE5ldyByZWNvcmQgZmxhZywgdHJ1ZSBmb3IgY3JlYXRpbmcsIGZhbHNlIGZvciB1cGRhdGluZ1xuICAgICAqIEByZXR1cm5zXG4gICAgICovXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIGlzTmV3KSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LFxuICAgICAgICAgICAgYXNzb2NzID0ge30sXG4gICAgICAgICAgICByZWZzID0ge307XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gXCI6XCIpIHtcbiAgICAgICAgICAgICAgICAvL2Nhc2NhZGUgdXBkYXRlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChrWzBdID09PSBcIkBcIikge1xuICAgICAgICAgICAgICAgIC8vdXBkYXRlIGJ5IHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHR5cGUgXCIke2Fzc29jTWV0YS50eXBlfVwiIGNhbm5vdCBiZSB1c2VkIGZvciB1cGRhdGUgYnkgcmVmZXJlbmNlLmAsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jQW5jaG9yID0gXCI6XCIgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jQW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBhc3NvY2lhdGlvbiBkYXRhIFwiJHthc3NvY0FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHYgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICByYXdbYW5jaG9yXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVmc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3MsIHJlZnNdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18ocmVmZXJlbmNlcywgYXN5bmMgKHJlZlF1ZXJ5LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGNvbnN0IFJlZmVyZW5jZWRFbnRpdHkgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6ICFhc3NvY01ldGEubGlzdDtcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBSZWZlcmVuY2VkRW50aXR5LmZpbmRPbmVfKHJlZlF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgUmVmZXJlbmNlZCBlbnRpdHkgXCIke1JlZmVyZW5jZWRFbnRpdHkubWV0YS5uYW1lfVwiIHdpdGggJHtKU09OLnN0cmluZ2lmeShyZWZRdWVyeSl9IG5vdCBleGlzdC5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yYXdbYW5jaG9yXSA9IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJUaGUgcGFyZW50IGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQucmV0dXJuLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jcyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5yZXR1cm4sXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jcyxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBmaW5pc2hlZCA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIiwgXCIkdXBzZXJ0XCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAvL2hhc01hbnkgb3IgaGFzT25lXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQgPSB0cnVlO1xuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChwYXNzT25PcHRpb25zLiRyZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwIHx8IChhc3NvY01vZGVsLmhhc0F1dG9JbmNyZW1lbnQgJiYgcGFzc09uT3B0aW9ucy4kcmVzdWx0Lmluc2VydElkID09PSAwKSkge1xuICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWQgb3IgdXBzZXJ0ZWRcblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUXVlcnkgPSBhc3NvY01vZGVsLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmZpbmRPbmVfKHsgJHF1ZXJ5OiBhc3NvY1F1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiVGhlIGFzc29pY2F0ZWQgZW50aXR5IGlzIGR1cGxpY2F0ZWQgb24gdW5pcXVlIGtleXMgZGlmZmVyZW50IGZyb20gdGhlIHBhaXIgb2Yga2V5cyB1c2VkIHRvIHF1ZXJ5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGFzc29jUXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1tsb2NhbEZpZWxkXSA9IHJlZkZpZWxkVmFsdWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIiwgXCIkdXBzZXJ0XCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NLZXlzID0gbWFwRmlsdGVyKFxuICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAocmVjb3JkKSA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0gIT0gbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgKHJlY29yZCkgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKGFzc29jUmVjb3Jkc1RvUmVtb3ZlLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBpdGVtW2Fzc29jTWV0YS5rZXldICE9IG51bGxcbiAgICAgICAgICAgICAgICAgICAgICAgID8gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5fLm9taXQoaXRlbSwgW2Fzc29jTWV0YS5rZXldKSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAkcXVlcnk6IHsgW2Fzc29jTWV0YS5rZXldOiBpdGVtW2Fzc29jTWV0YS5rZXldIH0sIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG9cbiAgICAgICAgICAgICAgICBsZXQgZGVzdEVudGl0eUlkID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0LmV4aXN0aW5nLCBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJhd10sIGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBTcGVjaWZpZWQgXCIke3RoaXMubWV0YS5uYW1lfVwiIG5vdCBmb3VuZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJFeGlzdGluZyBlbnRpdHkgcmVjb3JkIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3RvIGNyZWF0ZSB0aGUgYXNzb2NpYXRlZCwgZXhpc3RpbmcgaXMgbnVsbFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocGFzc09uT3B0aW9ucy4kcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUXVlcnkgPSBhc3NvY01vZGVsLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmZpbmRPbmVfKHsgJHF1ZXJ5OiBhc3NvY1F1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiVGhlIGFzc29pY2F0ZWQgZW50aXR5IGlzIGR1cGxpY2F0ZWQgb24gdW5pcXVlIGtleXMgZGlmZmVyZW50IGZyb20gdGhlIHBhaXIgb2Yga2V5cyB1c2VkIHRvIHF1ZXJ5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGFzc29jUXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkLCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9ub3RoaW5nIHRvIGRvIGZvciBudWxsIGRlc3QgZW50aXR5IGlkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidXBkYXRlIGFzc29jaWF0ZWQgZGF0YSBmb3IgbXVsdGlwbGUgcmVjb3JkcyBub3QgaW1wbGVtZW50ZWRcIik7XG5cbiAgICAgICAgICAgIC8vcmV0dXJuIGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5kYXRhLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7XG4iXX0=
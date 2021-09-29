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
    const [normalAssocs, customAssocs] = _.partition(findOptions.$association, assoc => typeof assoc === 'string');

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
      if (col.table !== 'A') {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfZmlsbFJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsImluc2VydElkIiwicmV0dXJuIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwiaXNFbXB0eSIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJjaGFuZ2VkUm93cyIsInJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQiLCIkcmV0cmlldmVOb3RVcGRhdGUiLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIiRwaHlzaWNhbERlbGV0aW9uIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwibm9ybWFsQXNzb2NzIiwiY3VzdG9tQXNzb2NzIiwicGFydGl0aW9uIiwiJGFzc29jaWF0aW9uIiwiYXNzb2MiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwic29ydCIsImNvbmNhdCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJzY2hlbWFOYW1lIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJuZXN0ZWRLZXlHZXR0ZXIiLCJtYXBWYWx1ZXMiLCJjaGFpbiIsIm1haW5JbmRleCIsInNlbGYiLCJjb2wiLCJ0YWJsZSIsInBvcyIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiY3VycmVudFBhdGgiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleVZhbHVlIiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInN1YkluZGV4IiwiYnVpbGRTdWJJbmRleGVzIiwiaW5kZXhlcyIsInN1Yk9iamVjdCIsImFycmF5T2ZPYmpzIiwidGFibGVUZW1wbGF0ZSIsInJlZHVjZSIsImJ1Y2tldCIsInJvdyIsInRhYmxlQ2FjaGUiLCJjb2xJZHgiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiYXNzb2NRdWVyeSIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLENBQUMsWUFBRDs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUNBLE1BQU1NLFdBQVcsR0FBR0wsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLHVCQUFwQjtBQUE2Q0MsRUFBQUEsY0FBN0M7QUFBNkRDLEVBQUFBLGVBQTdEO0FBQThFQyxFQUFBQTtBQUE5RSxJQUFrR1YsT0FBTyxDQUFDLG9CQUFELENBQS9HOztBQUNBLE1BQU1XLEtBQUssR0FBR1gsT0FBTyxDQUFDLGFBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFWSxFQUFBQSxZQUFGO0FBQWdCQyxFQUFBQTtBQUFoQixJQUE4QmIsT0FBTyxDQUFDLGtCQUFELENBQTNDOztBQUVBLE1BQU1jLHNCQUFzQixHQUFJQyxNQUFELElBQWEsTUFBTUEsTUFBbEQ7O0FBS0EsTUFBTUMsZ0JBQU4sU0FBK0JYLFdBQS9CLENBQTJDO0FBSVosYUFBaEJZLGdCQUFnQixHQUFHO0FBQzFCLFFBQUlDLE1BQU0sR0FBRyxLQUFLQyxJQUFMLENBQVVDLFFBQVYsQ0FBbUJGLE1BQWhDO0FBQ0EsV0FBT0EsTUFBTSxJQUFJLEtBQUtDLElBQUwsQ0FBVUUsTUFBVixDQUFpQkgsTUFBTSxDQUFDSSxLQUF4QixFQUErQkMsZUFBaEQ7QUFDSDs7QUFPcUIsU0FBZkMsZUFBZSxDQUFDQyxTQUFELEVBQVlDLE9BQVosRUFBcUI7QUFDdkMsV0FBT3hCLGNBQWMsQ0FDakJ1QixTQURpQixFQUVqQkMsT0FBTyxDQUNGQyxLQURMLENBQ1csR0FEWCxFQUVLQyxHQUZMLENBRVVDLENBQUQsSUFBTyxNQUFNQSxDQUZ0QixFQUdLQyxJQUhMLENBR1UsR0FIVixDQUZpQixDQUFyQjtBQU9IOztBQU0yQixTQUFyQkMscUJBQXFCLENBQUNDLElBQUQsRUFBTztBQUMvQixRQUFJQSxJQUFJLEtBQUssS0FBYixFQUFvQjtBQUNoQixhQUFPLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsR0FBbEIsQ0FBc0IsT0FBdEIsQ0FBUDtBQUNIOztBQUVELFVBQU0sSUFBSUMsS0FBSixDQUFVLGtCQUFrQkosSUFBNUIsQ0FBTjtBQUNIOztBQU8wQixTQUFwQkssb0JBQW9CLENBQUNDLEtBQUQsRUFBUUMsSUFBUixFQUFjO0FBQ3JDLFFBQUlBLElBQUksQ0FBQ0MsSUFBTCxLQUFjLFNBQWxCLEVBQTZCO0FBQ3pCLGFBQU9GLEtBQUssR0FBRyxDQUFILEdBQU8sQ0FBbkI7QUFDSDs7QUFFRCxRQUFJQyxJQUFJLENBQUNDLElBQUwsS0FBYyxVQUFsQixFQUE4QjtBQUMxQixhQUFPN0IsS0FBSyxDQUFDOEIsUUFBTixDQUFlQyxTQUFmLENBQXlCSixLQUF6QixDQUFQO0FBQ0g7O0FBRUQsUUFBSUMsSUFBSSxDQUFDQyxJQUFMLEtBQWMsT0FBZCxJQUF5QkcsS0FBSyxDQUFDQyxPQUFOLENBQWNOLEtBQWQsQ0FBN0IsRUFBbUQ7QUFDL0MsVUFBSUMsSUFBSSxDQUFDTSxHQUFULEVBQWM7QUFDVixlQUFPbEMsS0FBSyxDQUFDbUMsS0FBTixDQUFZQyxLQUFaLENBQWtCVCxLQUFsQixDQUFQO0FBQ0gsT0FGRCxNQUVPO0FBQ0gsZUFBTzNCLEtBQUssQ0FBQ21DLEtBQU4sQ0FBWUosU0FBWixDQUFzQkosS0FBdEIsQ0FBUDtBQUNIO0FBQ0o7O0FBRUQsUUFBSUMsSUFBSSxDQUFDQyxJQUFMLEtBQWMsUUFBbEIsRUFBNEI7QUFDeEIsYUFBTzdCLEtBQUssQ0FBQ3FDLE1BQU4sQ0FBYU4sU0FBYixDQUF1QkosS0FBdkIsQ0FBUDtBQUNIOztBQUVELFdBQU9BLEtBQVA7QUFDSDs7QUFFbUIsZUFBUFcsT0FBTyxDQUFDLEdBQUdDLElBQUosRUFBVTtBQUMxQixRQUFJO0FBQ0EsYUFBTyxNQUFNLE1BQU1ELE9BQU4sQ0FBYyxHQUFHQyxJQUFqQixDQUFiO0FBQ0gsS0FGRCxDQUVFLE9BQU9DLEtBQVAsRUFBYztBQUNaLFVBQUlDLFNBQVMsR0FBR0QsS0FBSyxDQUFDRSxJQUF0Qjs7QUFFQSxVQUFJRCxTQUFTLEtBQUssd0JBQWxCLEVBQTRDO0FBQ3hDLGNBQU0sSUFBSTdDLHVCQUFKLENBQ0Ysb0VBQW9FNEMsS0FBSyxDQUFDRyxPQUR4RSxFQUVGSCxLQUFLLENBQUNaLElBRkosQ0FBTjtBQUlILE9BTEQsTUFLTyxJQUFJYSxTQUFTLEtBQUssY0FBbEIsRUFBa0M7QUFDckMsY0FBTSxJQUFJNUMsY0FBSixDQUFtQjJDLEtBQUssQ0FBQ0csT0FBTixHQUFpQiwwQkFBeUIsS0FBS25DLElBQUwsQ0FBVWEsSUFBSyxJQUE1RSxFQUFpRm1CLEtBQUssQ0FBQ1osSUFBdkYsQ0FBTjtBQUNIOztBQUVELFlBQU1ZLEtBQU47QUFDSDtBQUNKOztBQUVzQixlQUFWSSxVQUFVLENBQUMsR0FBR0wsSUFBSixFQUFVO0FBQzdCLFFBQUk7QUFDQSxhQUFPLE1BQU0sTUFBTUssVUFBTixDQUFpQixHQUFHTCxJQUFwQixDQUFiO0FBQ0gsS0FGRCxDQUVFLE9BQU9DLEtBQVAsRUFBYztBQUNaLFVBQUlDLFNBQVMsR0FBR0QsS0FBSyxDQUFDRSxJQUF0Qjs7QUFFQSxVQUFJRCxTQUFTLEtBQUssd0JBQWxCLEVBQTRDO0FBQ3hDLGNBQU0sSUFBSTdDLHVCQUFKLENBQ0YsOEVBQThFNEMsS0FBSyxDQUFDRyxPQURsRixFQUVGSCxLQUFLLENBQUNaLElBRkosQ0FBTjtBQUlILE9BTEQsTUFLTyxJQUFJYSxTQUFTLEtBQUssY0FBbEIsRUFBa0M7QUFDckMsY0FBTSxJQUFJNUMsY0FBSixDQUFtQjJDLEtBQUssQ0FBQ0csT0FBTixHQUFpQixnQ0FBK0IsS0FBS25DLElBQUwsQ0FBVWEsSUFBSyxJQUFsRixFQUF1Rm1CLEtBQUssQ0FBQ1osSUFBN0YsQ0FBTjtBQUNIOztBQUVELFlBQU1ZLEtBQU47QUFDSDtBQUNKOztBQUUwQixlQUFkSyxjQUFjLENBQUNDLE9BQUQsRUFBVTtBQUNqQyxVQUFNLEtBQUtDLGtCQUFMLENBQXdCRCxPQUF4QixDQUFOO0FBRUEsUUFBSUUsTUFBTSxHQUFHLE1BQU0sS0FBS0MsUUFBTCxDQUFjO0FBQUVDLE1BQUFBLE1BQU0sRUFBRUosT0FBTyxDQUFDSyxPQUFSLENBQWdCRDtBQUExQixLQUFkLEVBQWtESixPQUFPLENBQUNNLFdBQTFELENBQW5CO0FBRUEsUUFBSUMsR0FBSixFQUFTRixPQUFUOztBQUVBLFFBQUlILE1BQUosRUFBWTtBQUNSLFVBQUlGLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkcsaUJBQXBCLEVBQXVDO0FBQ25DUixRQUFBQSxPQUFPLENBQUNTLFVBQVIsQ0FBbUJDLFNBQW5CLEdBQStCUixNQUEvQjtBQUNIOztBQUVERyxNQUFBQSxPQUFPLEdBQUcsRUFDTixHQUFHTCxPQUFPLENBQUNLLE9BREw7QUFFTkQsUUFBQUEsTUFBTSxFQUFFO0FBQUUsV0FBQyxLQUFLMUMsSUFBTCxDQUFVaUQsUUFBWCxHQUFzQixNQUFNQyxVQUFOLENBQWlCVixNQUFqQjtBQUF4QixTQUZGO0FBR05RLFFBQUFBLFNBQVMsRUFBRVI7QUFITCxPQUFWO0FBTUFLLE1BQUFBLEdBQUcsR0FBRyxNQUFNLEtBQUtULFVBQUwsQ0FBZ0JFLE9BQU8sQ0FBQ3RCLEdBQXhCLEVBQTZCMkIsT0FBN0IsRUFBc0NMLE9BQU8sQ0FBQ00sV0FBOUMsQ0FBWjtBQUNILEtBWkQsTUFZTztBQUNIRCxNQUFBQSxPQUFPLEdBQUcsRUFDTixHQUFHN0QsQ0FBQyxDQUFDcUUsSUFBRixDQUFPYixPQUFPLENBQUNLLE9BQWYsRUFBd0IsQ0FBQyxrQkFBRCxFQUFxQixxQkFBckIsQ0FBeEIsQ0FERztBQUVOUyxRQUFBQSxnQkFBZ0IsRUFBRWQsT0FBTyxDQUFDSyxPQUFSLENBQWdCVTtBQUY1QixPQUFWO0FBS0FSLE1BQUFBLEdBQUcsR0FBRyxNQUFNLEtBQUtmLE9BQUwsQ0FBYVEsT0FBTyxDQUFDdEIsR0FBckIsRUFBMEIyQixPQUExQixFQUFtQ0wsT0FBTyxDQUFDTSxXQUEzQyxDQUFaO0FBQ0g7O0FBRUQsUUFBSUQsT0FBTyxDQUFDSyxTQUFaLEVBQXVCO0FBQ25CVixNQUFBQSxPQUFPLENBQUNTLFVBQVIsQ0FBbUJDLFNBQW5CLEdBQStCTCxPQUFPLENBQUNLLFNBQXZDO0FBQ0g7O0FBRUQsUUFBSUwsT0FBTyxDQUFDVyxPQUFaLEVBQXFCO0FBQ2pCaEIsTUFBQUEsT0FBTyxDQUFDUyxVQUFSLENBQW1CTyxPQUFuQixHQUE2QlgsT0FBTyxDQUFDVyxPQUFyQztBQUNIOztBQUVELFdBQU9ULEdBQVA7QUFDSDs7QUFFNEIsU0FBdEJVLHNCQUFzQixDQUFDakIsT0FBRCxFQUFVO0FBQ25DLFdBQU8sSUFBUDtBQUNIOztBQUVpQixTQUFYa0IsV0FBVyxDQUFDbEIsT0FBRCxFQUFVO0FBQ3hCLFFBQUksS0FBS3hDLGdCQUFMLElBQXlCd0MsT0FBTyxDQUFDbUIsTUFBUixDQUFlQyxZQUFmLEdBQThCLENBQTNELEVBQThEO0FBQzFELFVBQUk7QUFBRUMsUUFBQUE7QUFBRixVQUFlckIsT0FBTyxDQUFDbUIsTUFBM0I7QUFDQW5CLE1BQUFBLE9BQU8sQ0FBQ3NCLE1BQVIsR0FBaUJ0QixPQUFPLENBQUN1QixNQUFSLEdBQWlCLEVBQUUsR0FBR3ZCLE9BQU8sQ0FBQ3VCLE1BQWI7QUFBcUIsU0FBQyxLQUFLN0QsSUFBTCxDQUFVQyxRQUFWLENBQW1CRixNQUFuQixDQUEwQkksS0FBM0IsR0FBbUN3RDtBQUF4RCxPQUFsQztBQUNILEtBSEQsTUFHTztBQUNIckIsTUFBQUEsT0FBTyxDQUFDc0IsTUFBUixHQUFpQnRCLE9BQU8sQ0FBQ3VCLE1BQXpCO0FBQ0g7QUFDSjs7QUFRaUMsZUFBckJDLHFCQUFxQixDQUFDeEIsT0FBRCxFQUFVO0FBQ3hDLFFBQUlBLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQm9CLGlCQUFwQixFQUF1QztBQUNuQ3pCLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNtQixNQUFyQztBQUNIOztBQUVELFFBQUluQixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JTLGdCQUFwQixFQUFzQztBQUNsQyxVQUFJLEtBQUt0RCxnQkFBVCxFQUEyQjtBQUN2QixZQUFJd0MsT0FBTyxDQUFDbUIsTUFBUixDQUFlQyxZQUFmLEtBQWdDLENBQXBDLEVBQXVDO0FBRW5DcEIsVUFBQUEsT0FBTyxDQUFDMEIsUUFBUixHQUFtQixLQUFLQywwQkFBTCxDQUFnQzNCLE9BQU8sQ0FBQ3VCLE1BQXhDLENBQW5COztBQUVBLGNBQUkvRSxDQUFDLENBQUNvRixPQUFGLENBQVU1QixPQUFPLENBQUMwQixRQUFsQixDQUFKLEVBQWlDO0FBQzdCLGtCQUFNLElBQUk3RSxnQkFBSixDQUFxQiw2Q0FBckIsRUFBb0U7QUFDdEVxRCxjQUFBQSxNQUFNLEVBQUUsS0FBS3hDLElBQUwsQ0FBVWE7QUFEb0QsYUFBcEUsQ0FBTjtBQUdIO0FBQ0osU0FURCxNQVNPO0FBQ0gsY0FBSTtBQUFFOEMsWUFBQUE7QUFBRixjQUFlckIsT0FBTyxDQUFDbUIsTUFBM0I7QUFDQW5CLFVBQUFBLE9BQU8sQ0FBQzBCLFFBQVIsR0FBbUI7QUFBRSxhQUFDLEtBQUtoRSxJQUFMLENBQVVDLFFBQVYsQ0FBbUJGLE1BQW5CLENBQTBCSSxLQUEzQixHQUFtQ3dEO0FBQXJDLFdBQW5CO0FBQ0g7QUFDSixPQWRELE1BY087QUFDSHJCLFFBQUFBLE9BQU8sQ0FBQzBCLFFBQVIsR0FBbUIsS0FBS0MsMEJBQUwsQ0FBZ0MzQixPQUFPLENBQUN1QixNQUF4QyxDQUFuQjs7QUFFQSxZQUFJL0UsQ0FBQyxDQUFDb0YsT0FBRixDQUFVNUIsT0FBTyxDQUFDMEIsUUFBbEIsQ0FBSixFQUFpQztBQUM3QixnQkFBTSxJQUFJN0UsZ0JBQUosQ0FBcUIsNkNBQXJCLEVBQW9FO0FBQ3RFcUQsWUFBQUEsTUFBTSxFQUFFLEtBQUt4QyxJQUFMLENBQVVhO0FBRG9ELFdBQXBFLENBQU47QUFHSDtBQUNKOztBQUVELFVBQUlzRCxlQUFlLEdBQUdyRixDQUFDLENBQUNzRixhQUFGLENBQWdCOUIsT0FBTyxDQUFDSyxPQUFSLENBQWdCUyxnQkFBaEMsSUFDaEJkLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQlMsZ0JBREEsR0FFaEIsRUFGTjtBQUdBZCxNQUFBQSxPQUFPLENBQUNzQixNQUFSLEdBQWlCLE1BQU0sS0FBS25CLFFBQUwsQ0FBYyxFQUFFLEdBQUcwQixlQUFMO0FBQXNCekIsUUFBQUEsTUFBTSxFQUFFSixPQUFPLENBQUMwQjtBQUF0QyxPQUFkLEVBQWdFMUIsT0FBTyxDQUFDTSxXQUF4RSxDQUF2QjtBQUNILEtBN0JELE1BNkJPO0FBQ0gsVUFBSSxLQUFLOUMsZ0JBQVQsRUFBMkI7QUFDdkIsWUFBSXdDLE9BQU8sQ0FBQ21CLE1BQVIsQ0FBZUMsWUFBZixLQUFnQyxDQUFwQyxFQUF1QztBQUNuQ3BCLFVBQUFBLE9BQU8sQ0FBQzBCLFFBQVIsR0FBbUIsS0FBS0MsMEJBQUwsQ0FBZ0MzQixPQUFPLENBQUN1QixNQUF4QyxDQUFuQjtBQUNILFNBRkQsTUFFTztBQUNILGNBQUk7QUFBRUYsWUFBQUE7QUFBRixjQUFlckIsT0FBTyxDQUFDbUIsTUFBM0I7QUFDQW5CLFVBQUFBLE9BQU8sQ0FBQzBCLFFBQVIsR0FBbUI7QUFBRSxhQUFDLEtBQUtoRSxJQUFMLENBQVVDLFFBQVYsQ0FBbUJGLE1BQW5CLENBQTBCSSxLQUEzQixHQUFtQ3dEO0FBQXJDLFdBQW5CO0FBQ0g7QUFDSjtBQUNKO0FBQ0o7O0FBRTRCLFNBQXRCVSxzQkFBc0IsQ0FBQy9CLE9BQUQsRUFBVTtBQUNuQyxXQUFPLElBQVA7QUFDSDs7QUFFZ0MsU0FBMUJnQywwQkFBMEIsQ0FBQ2hDLE9BQUQsRUFBVTtBQUN2QyxXQUFPLElBQVA7QUFDSDs7QUFRaUMsZUFBckJpQyxxQkFBcUIsQ0FBQ2pDLE9BQUQsRUFBVTtBQUN4QyxVQUFNSyxPQUFPLEdBQUdMLE9BQU8sQ0FBQ0ssT0FBeEI7O0FBRUEsUUFBSUEsT0FBTyxDQUFDb0IsaUJBQVosRUFBK0I7QUFDM0J6QixNQUFBQSxPQUFPLENBQUNTLFVBQVIsQ0FBbUJPLE9BQW5CLEdBQTZCaEIsT0FBTyxDQUFDbUIsTUFBUixJQUFrQjtBQUMzQ0MsUUFBQUEsWUFBWSxFQUFFLENBRDZCO0FBRTNDYyxRQUFBQSxXQUFXLEVBQUU7QUFGOEIsT0FBL0M7QUFJSDs7QUFFRCxRQUFJQyxlQUFlLEdBQUc5QixPQUFPLENBQUNVLGdCQUE5Qjs7QUFFQSxRQUFJLENBQUNvQixlQUFMLEVBQXNCO0FBQ2xCLFVBQUk5QixPQUFPLENBQUMrQixzQkFBUixJQUFrQ3BDLE9BQU8sQ0FBQ21CLE1BQVIsQ0FBZUMsWUFBZixHQUE4QixDQUFwRSxFQUF1RTtBQUNuRWUsUUFBQUEsZUFBZSxHQUFHOUIsT0FBTyxDQUFDK0Isc0JBQTFCO0FBQ0gsT0FGRCxNQUVPLElBQUkvQixPQUFPLENBQUNnQyxrQkFBUixJQUE4QnJDLE9BQU8sQ0FBQ21CLE1BQVIsQ0FBZUMsWUFBZixLQUFnQyxDQUFsRSxFQUFxRTtBQUN4RWUsUUFBQUEsZUFBZSxHQUFHOUIsT0FBTyxDQUFDZ0Msa0JBQTFCO0FBQ0g7QUFDSjs7QUFFRCxRQUFJRixlQUFKLEVBQXFCO0FBQ2pCLFVBQUlHLFNBQVMsR0FBRztBQUFFbEMsUUFBQUEsTUFBTSxFQUFFLEtBQUt1QiwwQkFBTCxDQUFnQ3RCLE9BQU8sQ0FBQ0QsTUFBeEM7QUFBVixPQUFoQjs7QUFDQSxVQUFJQyxPQUFPLENBQUNrQyxtQkFBWixFQUFpQztBQUM3QkQsUUFBQUEsU0FBUyxDQUFDQyxtQkFBVixHQUFnQ2xDLE9BQU8sQ0FBQ2tDLG1CQUF4QztBQUNIOztBQUVELFVBQUlWLGVBQWUsR0FBRyxFQUF0Qjs7QUFFQSxVQUFJckYsQ0FBQyxDQUFDc0YsYUFBRixDQUFnQkssZUFBaEIsQ0FBSixFQUFzQztBQUNsQ04sUUFBQUEsZUFBZSxHQUFHTSxlQUFsQjtBQUNILE9BRkQsTUFFTyxJQUFJOUIsT0FBTyxDQUFDbUMsY0FBWixFQUE0QjtBQUMvQlgsUUFBQUEsZUFBZSxDQUFDVyxjQUFoQixHQUFpQ25DLE9BQU8sQ0FBQ21DLGNBQXpDO0FBQ0g7O0FBRUR4QyxNQUFBQSxPQUFPLENBQUNzQixNQUFSLEdBQWlCLE1BQU0sS0FBS25CLFFBQUwsQ0FDbkIsRUFBRSxHQUFHbUMsU0FBTDtBQUFnQkcsUUFBQUEsZUFBZSxFQUFFcEMsT0FBTyxDQUFDcUMsZ0JBQXpDO0FBQTJELFdBQUdiO0FBQTlELE9BRG1CLEVBRW5CN0IsT0FBTyxDQUFDTSxXQUZXLENBQXZCOztBQUtBLFVBQUlOLE9BQU8sQ0FBQ3NCLE1BQVosRUFBb0I7QUFDaEJ0QixRQUFBQSxPQUFPLENBQUMwQixRQUFSLEdBQW1CLEtBQUtDLDBCQUFMLENBQWdDM0IsT0FBTyxDQUFDc0IsTUFBeEMsQ0FBbkI7QUFDSCxPQUZELE1BRU87QUFDSHRCLFFBQUFBLE9BQU8sQ0FBQzBCLFFBQVIsR0FBbUJZLFNBQVMsQ0FBQ2xDLE1BQTdCO0FBQ0g7QUFDSjtBQUNKOztBQVFxQyxlQUF6QnVDLHlCQUF5QixDQUFDM0MsT0FBRCxFQUFVO0FBQzVDLFVBQU1LLE9BQU8sR0FBR0wsT0FBTyxDQUFDSyxPQUF4Qjs7QUFFQSxRQUFJQSxPQUFPLENBQUNvQixpQkFBWixFQUErQjtBQUMzQnpCLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNtQixNQUFSLElBQWtCO0FBQzNDQyxRQUFBQSxZQUFZLEVBQUUsQ0FENkI7QUFFM0NjLFFBQUFBLFdBQVcsRUFBRTtBQUY4QixPQUEvQztBQWVIOztBQUVELFFBQUk3QixPQUFPLENBQUNVLGdCQUFaLEVBQThCO0FBQzFCLFVBQUljLGVBQWUsR0FBRyxFQUF0Qjs7QUFFQSxVQUFJckYsQ0FBQyxDQUFDc0YsYUFBRixDQUFnQnpCLE9BQU8sQ0FBQ1UsZ0JBQXhCLENBQUosRUFBK0M7QUFDM0NjLFFBQUFBLGVBQWUsR0FBR3hCLE9BQU8sQ0FBQ1UsZ0JBQTFCO0FBQ0gsT0FGRCxNQUVPLElBQUlWLE9BQU8sQ0FBQ21DLGNBQVosRUFBNEI7QUFDL0JYLFFBQUFBLGVBQWUsQ0FBQ1csY0FBaEIsR0FBaUNuQyxPQUFPLENBQUNtQyxjQUF6QztBQUNIOztBQUVEeEMsTUFBQUEsT0FBTyxDQUFDc0IsTUFBUixHQUFpQixNQUFNLEtBQUtzQixRQUFMLENBQ25CO0FBQ0l4QyxRQUFBQSxNQUFNLEVBQUVDLE9BQU8sQ0FBQ0QsTUFEcEI7QUFFSXFDLFFBQUFBLGVBQWUsRUFBRXBDLE9BQU8sQ0FBQ3FDLGdCQUY3QjtBQUdJLFdBQUdiO0FBSFAsT0FEbUIsRUFNbkI3QixPQUFPLENBQUNNLFdBTlcsQ0FBdkI7QUFRSDs7QUFFRE4sSUFBQUEsT0FBTyxDQUFDMEIsUUFBUixHQUFtQnJCLE9BQU8sQ0FBQ0QsTUFBM0I7QUFDSDs7QUFRa0MsZUFBdEJ5QyxzQkFBc0IsQ0FBQzdDLE9BQUQsRUFBVTtBQUN6QyxRQUFJQSxPQUFPLENBQUNLLE9BQVIsQ0FBZ0JxQyxnQkFBcEIsRUFBc0M7QUFDbEMsWUFBTSxLQUFLekMsa0JBQUwsQ0FBd0JELE9BQXhCLENBQU47QUFFQSxVQUFJNkIsZUFBZSxHQUFHckYsQ0FBQyxDQUFDc0YsYUFBRixDQUFnQjlCLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQnFDLGdCQUFoQyxJQUNoQixFQUFFLEdBQUcxQyxPQUFPLENBQUNLLE9BQVIsQ0FBZ0JxQyxnQkFBckI7QUFBdUN0QyxRQUFBQSxNQUFNLEVBQUVKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBL0QsT0FEZ0IsR0FFaEI7QUFBRUEsUUFBQUEsTUFBTSxFQUFFSixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JEO0FBQTFCLE9BRk47O0FBSUEsVUFBSUosT0FBTyxDQUFDSyxPQUFSLENBQWdCeUMsaUJBQXBCLEVBQXVDO0FBQ25DakIsUUFBQUEsZUFBZSxDQUFDWSxlQUFoQixHQUFrQyxJQUFsQztBQUNIOztBQUVEekMsTUFBQUEsT0FBTyxDQUFDc0IsTUFBUixHQUFpQnRCLE9BQU8sQ0FBQytDLFFBQVIsR0FBbUIsTUFBTSxLQUFLNUMsUUFBTCxDQUN0QzBCLGVBRHNDLEVBRXRDN0IsT0FBTyxDQUFDTSxXQUY4QixDQUExQztBQUlIOztBQUVELFdBQU8sSUFBUDtBQUNIOztBQUVzQyxlQUExQjBDLDBCQUEwQixDQUFDaEQsT0FBRCxFQUFVO0FBQzdDLFFBQUlBLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQnFDLGdCQUFwQixFQUFzQztBQUNsQyxZQUFNLEtBQUt6QyxrQkFBTCxDQUF3QkQsT0FBeEIsQ0FBTjtBQUVBLFVBQUk2QixlQUFlLEdBQUdyRixDQUFDLENBQUNzRixhQUFGLENBQWdCOUIsT0FBTyxDQUFDSyxPQUFSLENBQWdCcUMsZ0JBQWhDLElBQ2hCLEVBQUUsR0FBRzFDLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQnFDLGdCQUFyQjtBQUF1Q3RDLFFBQUFBLE1BQU0sRUFBRUosT0FBTyxDQUFDSyxPQUFSLENBQWdCRDtBQUEvRCxPQURnQixHQUVoQjtBQUFFQSxRQUFBQSxNQUFNLEVBQUVKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBMUIsT0FGTjs7QUFJQSxVQUFJSixPQUFPLENBQUNLLE9BQVIsQ0FBZ0J5QyxpQkFBcEIsRUFBdUM7QUFDbkNqQixRQUFBQSxlQUFlLENBQUNZLGVBQWhCLEdBQWtDLElBQWxDO0FBQ0g7O0FBRUR6QyxNQUFBQSxPQUFPLENBQUNzQixNQUFSLEdBQWlCdEIsT0FBTyxDQUFDK0MsUUFBUixHQUFtQixNQUFNLEtBQUtILFFBQUwsQ0FDdENmLGVBRHNDLEVBRXRDN0IsT0FBTyxDQUFDTSxXQUY4QixDQUExQztBQUlIOztBQUVELFdBQU8sSUFBUDtBQUNIOztBQU0yQixTQUFyQjJDLHFCQUFxQixDQUFDakQsT0FBRCxFQUFVO0FBQ2xDLFFBQUlBLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQm9CLGlCQUFwQixFQUF1QztBQUNuQ3pCLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNtQixNQUFyQztBQUNIO0FBQ0o7O0FBTStCLFNBQXpCK0IseUJBQXlCLENBQUNsRCxPQUFELEVBQVU7QUFDdEMsUUFBSUEsT0FBTyxDQUFDSyxPQUFSLENBQWdCb0IsaUJBQXBCLEVBQXVDO0FBQ25DekIsTUFBQUEsT0FBTyxDQUFDUyxVQUFSLENBQW1CTyxPQUFuQixHQUE2QmhCLE9BQU8sQ0FBQ21CLE1BQXJDO0FBQ0g7QUFDSjs7QUFNMEIsU0FBcEJnQyxvQkFBb0IsQ0FBQ0MsV0FBRCxFQUFjO0FBQ3JDLFVBQU0sQ0FBRUMsWUFBRixFQUFnQkMsWUFBaEIsSUFBaUM5RyxDQUFDLENBQUMrRyxTQUFGLENBQVlILFdBQVcsQ0FBQ0ksWUFBeEIsRUFBc0NDLEtBQUssSUFBSSxPQUFPQSxLQUFQLEtBQWlCLFFBQWhFLENBQXZDOztBQUVBLFFBQUlDLFlBQVksR0FBSWxILENBQUMsQ0FBQ21ILElBQUYsQ0FBT04sWUFBUCxFQUFxQk8sSUFBckIsR0FBNEJDLE1BQTVCLENBQW1DUCxZQUFuQyxDQUFwQjs7QUFDQSxRQUFJUSxVQUFVLEdBQUcsRUFBakI7QUFBQSxRQUNJQyxPQUFPLEdBQUcsQ0FEZDtBQUFBLFFBRUlDLEtBQUssR0FBRyxFQUZaO0FBSUFOLElBQUFBLFlBQVksQ0FBQ08sT0FBYixDQUFzQlIsS0FBRCxJQUFXO0FBQzVCLFVBQUlqSCxDQUFDLENBQUNzRixhQUFGLENBQWdCMkIsS0FBaEIsQ0FBSixFQUE0QjtBQUN4QkEsUUFBQUEsS0FBSyxHQUFHLEtBQUtTLHdCQUFMLENBQThCVCxLQUE5QixDQUFSO0FBRUEsWUFBSVUsS0FBSyxHQUFHVixLQUFLLENBQUNVLEtBQWxCOztBQUNBLFlBQUksQ0FBQ1YsS0FBSyxDQUFDVSxLQUFYLEVBQWtCO0FBQ2RBLFVBQUFBLEtBQUssR0FBRyxVQUFVLEVBQUVKLE9BQXBCO0FBQ0g7O0FBRURELFFBQUFBLFVBQVUsQ0FBQ0ssS0FBRCxDQUFWLEdBQW9CO0FBQ2hCakUsVUFBQUEsTUFBTSxFQUFFdUQsS0FBSyxDQUFDdkQsTUFERTtBQUVoQmtFLFVBQUFBLFFBQVEsRUFBRVgsS0FBSyxDQUFDMUUsSUFGQTtBQUdoQnNGLFVBQUFBLE1BQU0sRUFBRVosS0FBSyxDQUFDWSxNQUhFO0FBSWhCQyxVQUFBQSxHQUFHLEVBQUViLEtBQUssQ0FBQ2EsR0FKSztBQUtoQkgsVUFBQUEsS0FMZ0I7QUFNaEJJLFVBQUFBLEVBQUUsRUFBRWQsS0FBSyxDQUFDYyxFQU5NO0FBT2hCLGNBQUlkLEtBQUssQ0FBQ2UsT0FBTixHQUNFLEtBQUtoRyxFQUFMLENBQVFDLFNBQVIsQ0FBa0JnRyxVQUFsQixDQUNJaEIsS0FBSyxDQUFDdkQsTUFEVixFQUVJdUQsS0FBSyxDQUFDaUIsS0FBTixDQUFZQyxlQUFaLENBQTRCLEVBQUUsR0FBR2xCLEtBQUssQ0FBQ2UsT0FBWDtBQUFvQkksWUFBQUEsVUFBVSxFQUFFeEIsV0FBVyxDQUFDd0I7QUFBNUMsV0FBNUIsQ0FGSixDQURGLEdBS0UsRUFMTjtBQVBnQixTQUFwQjtBQWNILE9BdEJELE1Bc0JPO0FBQ0gsYUFBS0MsbUJBQUwsQ0FBeUJmLFVBQXpCLEVBQXFDRSxLQUFyQyxFQUE0Q1AsS0FBNUM7QUFDSDtBQUNKLEtBMUJEO0FBNEJBLFdBQU9LLFVBQVA7QUFDSDs7QUFReUIsU0FBbkJlLG1CQUFtQixDQUFDZixVQUFELEVBQWFFLEtBQWIsRUFBb0JQLEtBQXBCLEVBQTJCO0FBQ2pELFFBQUlPLEtBQUssQ0FBQ1AsS0FBRCxDQUFULEVBQWtCLE9BQU9PLEtBQUssQ0FBQ1AsS0FBRCxDQUFaO0FBRWxCLFFBQUlxQixPQUFPLEdBQUdyQixLQUFLLENBQUNzQixXQUFOLENBQWtCLEdBQWxCLENBQWQ7QUFDQSxRQUFJNUQsTUFBSjs7QUFFQSxRQUFJMkQsT0FBTyxLQUFLLENBQUMsQ0FBakIsRUFBb0I7QUFFaEIsVUFBSUUsU0FBUyxHQUFHLEVBQUUsR0FBRyxLQUFLdEgsSUFBTCxDQUFVZ0csWUFBVixDQUF1QkQsS0FBdkI7QUFBTCxPQUFoQjs7QUFDQSxVQUFJakgsQ0FBQyxDQUFDb0YsT0FBRixDQUFVb0QsU0FBVixDQUFKLEVBQTBCO0FBQ3RCLGNBQU0sSUFBSS9ILGVBQUosQ0FBcUIsV0FBVSxLQUFLUyxJQUFMLENBQVVhLElBQUssb0NBQW1Da0YsS0FBTSxJQUF2RixDQUFOO0FBQ0g7O0FBRUR0QyxNQUFBQSxNQUFNLEdBQUc2QyxLQUFLLENBQUNQLEtBQUQsQ0FBTCxHQUFlSyxVQUFVLENBQUNMLEtBQUQsQ0FBVixHQUFvQixFQUFFLEdBQUcsS0FBS1Msd0JBQUwsQ0FBOEJjLFNBQTlCO0FBQUwsT0FBNUM7QUFDSCxLQVJELE1BUU87QUFDSCxVQUFJQyxJQUFJLEdBQUd4QixLQUFLLENBQUN5QixNQUFOLENBQWEsQ0FBYixFQUFnQkosT0FBaEIsQ0FBWDtBQUNBLFVBQUlLLElBQUksR0FBRzFCLEtBQUssQ0FBQ3lCLE1BQU4sQ0FBYUosT0FBTyxHQUFHLENBQXZCLENBQVg7QUFFQSxVQUFJTSxRQUFRLEdBQUdwQixLQUFLLENBQUNpQixJQUFELENBQXBCOztBQUNBLFVBQUksQ0FBQ0csUUFBTCxFQUFlO0FBQ1hBLFFBQUFBLFFBQVEsR0FBRyxLQUFLUCxtQkFBTCxDQUF5QmYsVUFBekIsRUFBcUNFLEtBQXJDLEVBQTRDaUIsSUFBNUMsQ0FBWDtBQUNIOztBQUVELFVBQUkvRSxNQUFNLEdBQUdrRixRQUFRLENBQUNWLEtBQVQsSUFBa0IsS0FBS2xHLEVBQUwsQ0FBUWtHLEtBQVIsQ0FBY1UsUUFBUSxDQUFDbEYsTUFBdkIsQ0FBL0I7QUFDQSxVQUFJOEUsU0FBUyxHQUFHLEVBQUUsR0FBRzlFLE1BQU0sQ0FBQ3hDLElBQVAsQ0FBWWdHLFlBQVosQ0FBeUJ5QixJQUF6QjtBQUFMLE9BQWhCOztBQUNBLFVBQUkzSSxDQUFDLENBQUNvRixPQUFGLENBQVVvRCxTQUFWLENBQUosRUFBMEI7QUFDdEIsY0FBTSxJQUFJL0gsZUFBSixDQUFxQixXQUFVaUQsTUFBTSxDQUFDeEMsSUFBUCxDQUFZYSxJQUFLLG9DQUFtQ2tGLEtBQU0sSUFBekYsQ0FBTjtBQUNIOztBQUVEdEMsTUFBQUEsTUFBTSxHQUFHLEVBQUUsR0FBR2pCLE1BQU0sQ0FBQ2dFLHdCQUFQLENBQWdDYyxTQUFoQyxFQUEyQyxLQUFLeEcsRUFBaEQ7QUFBTCxPQUFUOztBQUVBLFVBQUksQ0FBQzRHLFFBQVEsQ0FBQ0MsU0FBZCxFQUF5QjtBQUNyQkQsUUFBQUEsUUFBUSxDQUFDQyxTQUFULEdBQXFCLEVBQXJCO0FBQ0g7O0FBRURyQixNQUFBQSxLQUFLLENBQUNQLEtBQUQsQ0FBTCxHQUFlMkIsUUFBUSxDQUFDQyxTQUFULENBQW1CRixJQUFuQixJQUEyQmhFLE1BQTFDO0FBQ0g7O0FBRUQsUUFBSUEsTUFBTSxDQUFDc0MsS0FBWCxFQUFrQjtBQUNkLFdBQUtvQixtQkFBTCxDQUF5QmYsVUFBekIsRUFBcUNFLEtBQXJDLEVBQTRDUCxLQUFLLEdBQUcsR0FBUixHQUFjdEMsTUFBTSxDQUFDc0MsS0FBakU7QUFDSDs7QUFFRCxXQUFPdEMsTUFBUDtBQUNIOztBQUU4QixTQUF4QitDLHdCQUF3QixDQUFDVCxLQUFELEVBQVE2QixTQUFSLEVBQW1CO0FBQzlDLFFBQUk3QixLQUFLLENBQUN2RCxNQUFOLENBQWFxRixPQUFiLENBQXFCLEdBQXJCLElBQTRCLENBQWhDLEVBQW1DO0FBQy9CLFVBQUksQ0FBQ0MsVUFBRCxFQUFhQyxVQUFiLElBQTJCaEMsS0FBSyxDQUFDdkQsTUFBTixDQUFhaEMsS0FBYixDQUFtQixHQUFuQixFQUF3QixDQUF4QixDQUEvQjtBQUVBLFVBQUl3SCxHQUFHLEdBQUcsS0FBS2xILEVBQUwsQ0FBUWtILEdBQWxCO0FBRUEsVUFBSUMsS0FBSyxHQUFHRCxHQUFHLENBQUNsSCxFQUFKLENBQU9nSCxVQUFQLENBQVo7O0FBQ0EsVUFBSSxDQUFDRyxLQUFMLEVBQVk7QUFDUixjQUFNLElBQUk5SSxnQkFBSixDQUNELDBCQUF5QjJJLFVBQVcsbURBRG5DLENBQU47QUFHSDs7QUFFRC9CLE1BQUFBLEtBQUssQ0FBQ3ZELE1BQU4sR0FBZXlGLEtBQUssQ0FBQ2xILFNBQU4sQ0FBZ0JtSCxRQUFoQixHQUEyQixHQUEzQixHQUFpQ0gsVUFBaEQ7QUFDQWhDLE1BQUFBLEtBQUssQ0FBQ2lCLEtBQU4sR0FBY2lCLEtBQUssQ0FBQ2pCLEtBQU4sQ0FBWWUsVUFBWixDQUFkOztBQUVBLFVBQUksQ0FBQ2hDLEtBQUssQ0FBQ2lCLEtBQVgsRUFBa0I7QUFDZCxjQUFNLElBQUk3SCxnQkFBSixDQUFzQixpQ0FBZ0MySSxVQUFXLElBQUdDLFVBQVcsSUFBL0UsQ0FBTjtBQUNIO0FBQ0osS0FsQkQsTUFrQk87QUFDSGhDLE1BQUFBLEtBQUssQ0FBQ2lCLEtBQU4sR0FBYyxLQUFLbEcsRUFBTCxDQUFRa0csS0FBUixDQUFjakIsS0FBSyxDQUFDdkQsTUFBcEIsQ0FBZDs7QUFFQSxVQUFJb0YsU0FBUyxJQUFJQSxTQUFTLEtBQUssS0FBSzlHLEVBQXBDLEVBQXdDO0FBQ3BDaUYsUUFBQUEsS0FBSyxDQUFDdkQsTUFBTixHQUFlLEtBQUsxQixFQUFMLENBQVFDLFNBQVIsQ0FBa0JtSCxRQUFsQixHQUE2QixHQUE3QixHQUFtQ25DLEtBQUssQ0FBQ3ZELE1BQXhEO0FBQ0g7QUFDSjs7QUFFRCxRQUFJLENBQUN1RCxLQUFLLENBQUNhLEdBQVgsRUFBZ0I7QUFDWmIsTUFBQUEsS0FBSyxDQUFDYSxHQUFOLEdBQVliLEtBQUssQ0FBQ2lCLEtBQU4sQ0FBWWhILElBQVosQ0FBaUJpRCxRQUE3QjtBQUNIOztBQUVELFdBQU84QyxLQUFQO0FBQ0g7O0FBRTBCLFNBQXBCb0Msb0JBQW9CLENBQUMsQ0FBQ0MsSUFBRCxFQUFPQyxPQUFQLEVBQWdCQyxRQUFoQixDQUFELEVBQTRCQyxTQUE1QixFQUF1Q0MsZUFBdkMsRUFBd0Q7QUFDL0VBLElBQUFBLGVBQWUsSUFBSSxJQUFuQixLQUE0QkEsZUFBZSxHQUFHN0ksc0JBQTlDO0FBQ0EySSxJQUFBQSxRQUFRLEdBQUd4SixDQUFDLENBQUMySixTQUFGLENBQVlILFFBQVosRUFBc0JJLEtBQUssSUFBSUEsS0FBSyxDQUFDakksR0FBTixDQUFVYixNQUFNLElBQUk0SSxlQUFlLENBQUM1SSxNQUFELENBQW5DLENBQS9CLENBQVg7QUFFQSxRQUFJK0ksU0FBUyxHQUFHLEVBQWhCO0FBQ0EsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFFQVAsSUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUM1SCxHQUFSLENBQVlvSSxHQUFHLElBQUk7QUFDekIsVUFBSUEsR0FBRyxDQUFDQyxLQUFKLEtBQWMsRUFBbEIsRUFBc0I7QUFDbEIsY0FBTUMsR0FBRyxHQUFHRixHQUFHLENBQUNoSSxJQUFKLENBQVNnSCxPQUFULENBQWlCLEdBQWpCLENBQVo7O0FBQ0EsWUFBSWtCLEdBQUcsR0FBRyxDQUFWLEVBQWE7QUFDVCxpQkFBTztBQUNIRCxZQUFBQSxLQUFLLEVBQUVELEdBQUcsQ0FBQ2hJLElBQUosQ0FBUzJHLE1BQVQsQ0FBZ0IsQ0FBaEIsRUFBbUJ1QixHQUFuQixDQURKO0FBRUhsSSxZQUFBQSxJQUFJLEVBQUVnSSxHQUFHLENBQUNoSSxJQUFKLENBQVMyRyxNQUFULENBQWdCdUIsR0FBRyxHQUFDLENBQXBCO0FBRkgsV0FBUDtBQUlIOztBQUVELGVBQU87QUFDSEQsVUFBQUEsS0FBSyxFQUFFLEdBREo7QUFFSGpJLFVBQUFBLElBQUksRUFBRWdJLEdBQUcsQ0FBQ2hJO0FBRlAsU0FBUDtBQUlIOztBQUVELGFBQU87QUFDSGlJLFFBQUFBLEtBQUssRUFBRUQsR0FBRyxDQUFDQyxLQURSO0FBRUhqSSxRQUFBQSxJQUFJLEVBQUVnSSxHQUFHLENBQUNoSTtBQUZQLE9BQVA7QUFJSCxLQXBCUyxDQUFWOztBQXNCQSxhQUFTbUksV0FBVCxDQUFxQkMsV0FBckIsRUFBa0NDLFNBQWxDLEVBQTZDbEQsWUFBN0MsRUFBMkRtRCxRQUEzRCxFQUFxRTtBQUNqRSxhQUFPckssQ0FBQyxDQUFDc0ssSUFBRixDQUFPcEQsWUFBUCxFQUFxQixDQUFDO0FBQUVxRCxRQUFBQSxHQUFGO0FBQU96QyxRQUFBQSxHQUFQO0FBQVkwQyxRQUFBQSxJQUFaO0FBQWtCM0IsUUFBQUE7QUFBbEIsT0FBRCxFQUFnQy9ILE1BQWhDLEtBQTJDO0FBQ25FLFlBQUl5SixHQUFKLEVBQVM7QUFFVCxZQUFJRSxXQUFXLEdBQUdKLFFBQVEsQ0FBQ2hELE1BQVQsRUFBbEI7QUFDQW9ELFFBQUFBLFdBQVcsQ0FBQ0MsSUFBWixDQUFpQjVKLE1BQWpCO0FBRUEsWUFBSTZKLE1BQU0sR0FBR2pCLGVBQWUsQ0FBQzVJLE1BQUQsQ0FBNUI7QUFDQSxZQUFJOEosTUFBTSxHQUFHUixTQUFTLENBQUNPLE1BQUQsQ0FBdEI7O0FBRUEsWUFBSSxDQUFDQyxNQUFMLEVBQWE7QUFFVDtBQUNIOztBQUVELFlBQUlDLFVBQVUsR0FBR1YsV0FBVyxDQUFDVSxVQUFaLENBQXVCRixNQUF2QixDQUFqQjtBQUdBLFlBQUlHLFdBQVcsR0FBR0YsTUFBTSxDQUFDOUMsR0FBRCxDQUF4Qjs7QUFDQSxZQUFJOUgsQ0FBQyxDQUFDK0ssS0FBRixDQUFRRCxXQUFSLENBQUosRUFBMEI7QUFDdEIsY0FBSU4sSUFBSSxJQUFJTSxXQUFXLElBQUksSUFBM0IsRUFBaUM7QUFDN0IsZ0JBQUlYLFdBQVcsQ0FBQ0MsU0FBWixDQUFzQk8sTUFBdEIsQ0FBSixFQUFtQztBQUMvQlIsY0FBQUEsV0FBVyxDQUFDQyxTQUFaLENBQXNCTyxNQUF0QixFQUE4QkQsSUFBOUIsQ0FBbUNFLE1BQW5DO0FBQ0gsYUFGRCxNQUVPO0FBQ0hULGNBQUFBLFdBQVcsQ0FBQ0MsU0FBWixDQUFzQk8sTUFBdEIsSUFBZ0MsQ0FBQ0MsTUFBRCxDQUFoQztBQUNIO0FBQ0o7O0FBRUQ7QUFDSDs7QUFFRCxZQUFJSSxjQUFjLEdBQUdILFVBQVUsSUFBSUEsVUFBVSxDQUFDQyxXQUFELENBQTdDOztBQUNBLFlBQUlFLGNBQUosRUFBb0I7QUFDaEIsY0FBSW5DLFNBQUosRUFBZTtBQUNYLG1CQUFPcUIsV0FBVyxDQUFDYyxjQUFELEVBQWlCSixNQUFqQixFQUF5Qi9CLFNBQXpCLEVBQW9DNEIsV0FBcEMsQ0FBbEI7QUFDSDtBQUNKLFNBSkQsTUFJTztBQUNILGNBQUksQ0FBQ0QsSUFBTCxFQUFXO0FBQ1Asa0JBQU0sSUFBSW5LLGdCQUFKLENBQ0QsaUNBQWdDb0ssV0FBVyxDQUFDNUksSUFBWixDQUFpQixHQUFqQixDQUFzQixlQUFjaUcsR0FBSSxnQkFDckVnQyxJQUFJLENBQUM1SSxJQUFMLENBQVVhLElBQ2IscUJBSEMsRUFJRjtBQUFFb0ksY0FBQUEsV0FBRjtBQUFlQyxjQUFBQTtBQUFmLGFBSkUsQ0FBTjtBQU1IOztBQUVELGNBQUlELFdBQVcsQ0FBQ0MsU0FBWixDQUFzQk8sTUFBdEIsQ0FBSixFQUFtQztBQUMvQlIsWUFBQUEsV0FBVyxDQUFDQyxTQUFaLENBQXNCTyxNQUF0QixFQUE4QkQsSUFBOUIsQ0FBbUNFLE1BQW5DO0FBQ0gsV0FGRCxNQUVPO0FBQ0hULFlBQUFBLFdBQVcsQ0FBQ0MsU0FBWixDQUFzQk8sTUFBdEIsSUFBZ0MsQ0FBQ0MsTUFBRCxDQUFoQztBQUNIOztBQUVELGNBQUlLLFFBQVEsR0FBRztBQUNYYixZQUFBQSxTQUFTLEVBQUVRO0FBREEsV0FBZjs7QUFJQSxjQUFJL0IsU0FBSixFQUFlO0FBQ1hvQyxZQUFBQSxRQUFRLENBQUNKLFVBQVQsR0FBc0JLLGVBQWUsQ0FBQ04sTUFBRCxFQUFTL0IsU0FBVCxDQUFyQztBQUNIOztBQUVELGNBQUksQ0FBQ2dDLFVBQUwsRUFBaUI7QUFDYixrQkFBTSxJQUFJeEssZ0JBQUosQ0FDRCxrQ0FBaUNvSyxXQUFXLENBQUM1SSxJQUFaLENBQWlCLEdBQWpCLENBQXNCLGVBQWNpRyxHQUFJLGdCQUN0RWdDLElBQUksQ0FBQzVJLElBQUwsQ0FBVWEsSUFDYixtQkFIQyxFQUlGO0FBQUVvSSxjQUFBQSxXQUFGO0FBQWVDLGNBQUFBO0FBQWYsYUFKRSxDQUFOO0FBTUg7O0FBRURTLFVBQUFBLFVBQVUsQ0FBQ0MsV0FBRCxDQUFWLEdBQTBCRyxRQUExQjtBQUNIO0FBQ0osT0F0RU0sQ0FBUDtBQXVFSDs7QUFFRCxhQUFTQyxlQUFULENBQXlCZCxTQUF6QixFQUFvQ2xELFlBQXBDLEVBQWtEO0FBQzlDLFVBQUlpRSxPQUFPLEdBQUcsRUFBZDs7QUFFQW5MLE1BQUFBLENBQUMsQ0FBQ3NLLElBQUYsQ0FBT3BELFlBQVAsRUFBcUIsQ0FBQztBQUFFcUQsUUFBQUEsR0FBRjtBQUFPekMsUUFBQUEsR0FBUDtBQUFZMEMsUUFBQUEsSUFBWjtBQUFrQjNCLFFBQUFBO0FBQWxCLE9BQUQsRUFBZ0MvSCxNQUFoQyxLQUEyQztBQUM1RCxZQUFJeUosR0FBSixFQUFTO0FBQ0w7QUFDSDs7QUFIMkQsYUFLcER6QyxHQUxvRDtBQUFBO0FBQUE7O0FBTzVELFlBQUk2QyxNQUFNLEdBQUdqQixlQUFlLENBQUM1SSxNQUFELENBQTVCO0FBQ0EsWUFBSXNLLFNBQVMsR0FBR2hCLFNBQVMsQ0FBQ08sTUFBRCxDQUF6QjtBQUNBLFlBQUlNLFFBQVEsR0FBRztBQUNYYixVQUFBQSxTQUFTLEVBQUVnQjtBQURBLFNBQWY7O0FBSUEsWUFBSVosSUFBSixFQUFVO0FBQ04sY0FBSSxDQUFDWSxTQUFMLEVBQWdCO0FBRVpoQixZQUFBQSxTQUFTLENBQUNPLE1BQUQsQ0FBVCxHQUFvQixFQUFwQjtBQUNBO0FBQ0g7O0FBRURQLFVBQUFBLFNBQVMsQ0FBQ08sTUFBRCxDQUFULEdBQW9CLENBQUNTLFNBQUQsQ0FBcEI7O0FBR0EsY0FBSXBMLENBQUMsQ0FBQytLLEtBQUYsQ0FBUUssU0FBUyxDQUFDdEQsR0FBRCxDQUFqQixDQUFKLEVBQTZCO0FBRXpCc0QsWUFBQUEsU0FBUyxHQUFHLElBQVo7QUFDSDtBQUNKOztBQUVELFlBQUlBLFNBQUosRUFBZTtBQUNYLGNBQUl2QyxTQUFKLEVBQWU7QUFDWG9DLFlBQUFBLFFBQVEsQ0FBQ0osVUFBVCxHQUFzQkssZUFBZSxDQUFDRSxTQUFELEVBQVl2QyxTQUFaLENBQXJDO0FBQ0g7O0FBRURzQyxVQUFBQSxPQUFPLENBQUNSLE1BQUQsQ0FBUCxHQUFrQlMsU0FBUyxDQUFDdEQsR0FBRCxDQUFULEdBQWlCO0FBQy9CLGFBQUNzRCxTQUFTLENBQUN0RCxHQUFELENBQVYsR0FBa0JtRDtBQURhLFdBQWpCLEdBRWQsRUFGSjtBQUdIO0FBQ0osT0F0Q0Q7O0FBd0NBLGFBQU9FLE9BQVA7QUFDSDs7QUFFRCxRQUFJRSxXQUFXLEdBQUcsRUFBbEI7QUFFQSxVQUFNQyxhQUFhLEdBQUcvQixPQUFPLENBQUNnQyxNQUFSLENBQWUsQ0FBQzVHLE1BQUQsRUFBU29GLEdBQVQsS0FBaUI7QUFDbEQsVUFBSUEsR0FBRyxDQUFDQyxLQUFKLEtBQWMsR0FBbEIsRUFBdUI7QUFDbkIsWUFBSXdCLE1BQU0sR0FBRzdHLE1BQU0sQ0FBQ29GLEdBQUcsQ0FBQ0MsS0FBTCxDQUFuQjs7QUFDQSxZQUFJd0IsTUFBSixFQUFZO0FBQ1JBLFVBQUFBLE1BQU0sQ0FBQ3pCLEdBQUcsQ0FBQ2hJLElBQUwsQ0FBTixHQUFtQixJQUFuQjtBQUNILFNBRkQsTUFFTztBQUNINEMsVUFBQUEsTUFBTSxDQUFDb0YsR0FBRyxDQUFDQyxLQUFMLENBQU4sR0FBb0I7QUFBRSxhQUFDRCxHQUFHLENBQUNoSSxJQUFMLEdBQVk7QUFBZCxXQUFwQjtBQUNIO0FBQ0o7O0FBRUQsYUFBTzRDLE1BQVA7QUFDSCxLQVhxQixFQVduQixFQVhtQixDQUF0QjtBQWNBMkUsSUFBQUEsSUFBSSxDQUFDN0IsT0FBTCxDQUFjZ0UsR0FBRCxJQUFTO0FBQ2xCLFVBQUlDLFVBQVUsR0FBRyxFQUFqQjtBQUdBLFVBQUl0QixTQUFTLEdBQUdxQixHQUFHLENBQUNGLE1BQUosQ0FBVyxDQUFDNUcsTUFBRCxFQUFTdEMsS0FBVCxFQUFnQnNKLE1BQWhCLEtBQTJCO0FBQ2xELFlBQUk1QixHQUFHLEdBQUdSLE9BQU8sQ0FBQ29DLE1BQUQsQ0FBakI7O0FBRUEsWUFBSTVCLEdBQUcsQ0FBQ0MsS0FBSixLQUFjLEdBQWxCLEVBQXVCO0FBQ25CckYsVUFBQUEsTUFBTSxDQUFDb0YsR0FBRyxDQUFDaEksSUFBTCxDQUFOLEdBQW1CTSxLQUFuQjtBQUNILFNBRkQsTUFFTyxJQUFJQSxLQUFLLElBQUksSUFBYixFQUFtQjtBQUN0QixjQUFJbUosTUFBTSxHQUFHRSxVQUFVLENBQUMzQixHQUFHLENBQUNDLEtBQUwsQ0FBdkI7O0FBQ0EsY0FBSXdCLE1BQUosRUFBWTtBQUVSQSxZQUFBQSxNQUFNLENBQUN6QixHQUFHLENBQUNoSSxJQUFMLENBQU4sR0FBbUJNLEtBQW5CO0FBQ0gsV0FIRCxNQUdPO0FBQ0hxSixZQUFBQSxVQUFVLENBQUMzQixHQUFHLENBQUNDLEtBQUwsQ0FBVixHQUF3QixFQUFFLEdBQUdzQixhQUFhLENBQUN2QixHQUFHLENBQUNDLEtBQUwsQ0FBbEI7QUFBK0IsZUFBQ0QsR0FBRyxDQUFDaEksSUFBTCxHQUFZTTtBQUEzQyxhQUF4QjtBQUNIO0FBQ0o7O0FBRUQsZUFBT3NDLE1BQVA7QUFDSCxPQWhCZSxFQWdCYixFQWhCYSxDQUFoQjs7QUFrQkEzRSxNQUFBQSxDQUFDLENBQUM0TCxNQUFGLENBQVNGLFVBQVQsRUFBcUIsQ0FBQ0csR0FBRCxFQUFNN0IsS0FBTixLQUFnQjtBQUNqQyxZQUFJSyxRQUFRLEdBQUdiLFFBQVEsQ0FBQ1EsS0FBRCxDQUF2QjtBQUNBOUosUUFBQUEsY0FBYyxDQUFDa0ssU0FBRCxFQUFZQyxRQUFaLEVBQXNCd0IsR0FBdEIsQ0FBZDtBQUNILE9BSEQ7O0FBS0EsVUFBSUMsTUFBTSxHQUFHMUIsU0FBUyxDQUFDTixJQUFJLENBQUM1SSxJQUFMLENBQVVpRCxRQUFYLENBQXRCO0FBQ0EsVUFBSWdHLFdBQVcsR0FBR04sU0FBUyxDQUFDaUMsTUFBRCxDQUEzQjs7QUFDQSxVQUFJM0IsV0FBSixFQUFpQjtBQUNiLGVBQU9ELFdBQVcsQ0FBQ0MsV0FBRCxFQUFjQyxTQUFkLEVBQXlCWCxTQUF6QixFQUFvQyxFQUFwQyxDQUFsQjtBQUNIOztBQUVENEIsTUFBQUEsV0FBVyxDQUFDWCxJQUFaLENBQWlCTixTQUFqQjtBQUNBUCxNQUFBQSxTQUFTLENBQUNpQyxNQUFELENBQVQsR0FBb0I7QUFDaEIxQixRQUFBQSxTQURnQjtBQUVoQlMsUUFBQUEsVUFBVSxFQUFFSyxlQUFlLENBQUNkLFNBQUQsRUFBWVgsU0FBWjtBQUZYLE9BQXBCO0FBSUgsS0F0Q0Q7QUF3Q0EsV0FBTzRCLFdBQVA7QUFDSDs7QUFRMEIsU0FBcEJVLG9CQUFvQixDQUFDQyxJQUFELEVBQU9DLEtBQVAsRUFBYztBQUNyQyxVQUFNL0osR0FBRyxHQUFHLEVBQVo7QUFBQSxVQUNJZ0ssTUFBTSxHQUFHLEVBRGI7QUFBQSxVQUVJQyxJQUFJLEdBQUcsRUFGWDtBQUdBLFVBQU1qTCxJQUFJLEdBQUcsS0FBS0EsSUFBTCxDQUFVZ0csWUFBdkI7O0FBRUFsSCxJQUFBQSxDQUFDLENBQUM0TCxNQUFGLENBQVNJLElBQVQsRUFBZSxDQUFDSSxDQUFELEVBQUlDLENBQUosS0FBVTtBQUNyQixVQUFJQSxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBYixFQUFrQjtBQUVkLGNBQU12TCxNQUFNLEdBQUd1TCxDQUFDLENBQUMzRCxNQUFGLENBQVMsQ0FBVCxDQUFmO0FBQ0EsY0FBTTRELFNBQVMsR0FBR3BMLElBQUksQ0FBQ0osTUFBRCxDQUF0Qjs7QUFDQSxZQUFJLENBQUN3TCxTQUFMLEVBQWdCO0FBQ1osZ0JBQU0sSUFBSTlMLGVBQUosQ0FBcUIsd0JBQXVCTSxNQUFPLGdCQUFlLEtBQUtJLElBQUwsQ0FBVWEsSUFBSyxJQUFqRixDQUFOO0FBQ0g7O0FBRUQsWUFBSWtLLEtBQUssS0FBS0ssU0FBUyxDQUFDL0osSUFBVixLQUFtQixVQUFuQixJQUFpQytKLFNBQVMsQ0FBQy9KLElBQVYsS0FBbUIsV0FBekQsQ0FBTCxJQUE4RXpCLE1BQU0sSUFBSWtMLElBQTVGLEVBQWtHO0FBQzlGLGdCQUFNLElBQUl4TCxlQUFKLENBQ0Qsc0JBQXFCTSxNQUFPLGdCQUFlLEtBQUtJLElBQUwsQ0FBVWEsSUFBSywwQ0FBeUNqQixNQUFPLElBRHpHLENBQU47QUFHSDs7QUFFRG9MLFFBQUFBLE1BQU0sQ0FBQ3BMLE1BQUQsQ0FBTixHQUFpQnNMLENBQWpCO0FBQ0gsT0FmRCxNQWVPLElBQUlDLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBUyxHQUFiLEVBQWtCO0FBRXJCLGNBQU12TCxNQUFNLEdBQUd1TCxDQUFDLENBQUMzRCxNQUFGLENBQVMsQ0FBVCxDQUFmO0FBQ0EsY0FBTTRELFNBQVMsR0FBR3BMLElBQUksQ0FBQ0osTUFBRCxDQUF0Qjs7QUFDQSxZQUFJLENBQUN3TCxTQUFMLEVBQWdCO0FBQ1osZ0JBQU0sSUFBSTlMLGVBQUosQ0FBcUIsd0JBQXVCTSxNQUFPLGdCQUFlLEtBQUtJLElBQUwsQ0FBVWEsSUFBSyxJQUFqRixDQUFOO0FBQ0g7O0FBRUQsWUFBSXVLLFNBQVMsQ0FBQy9KLElBQVYsS0FBbUIsVUFBbkIsSUFBaUMrSixTQUFTLENBQUMvSixJQUFWLEtBQW1CLFdBQXhELEVBQXFFO0FBQ2pFLGdCQUFNLElBQUkvQixlQUFKLENBQXFCLHFCQUFvQjhMLFNBQVMsQ0FBQy9KLElBQUssMkNBQXhELEVBQW9HO0FBQ3RHbUIsWUFBQUEsTUFBTSxFQUFFLEtBQUt4QyxJQUFMLENBQVVhLElBRG9GO0FBRXRHaUssWUFBQUE7QUFGc0csV0FBcEcsQ0FBTjtBQUlIOztBQUVELFlBQUlDLEtBQUssSUFBSW5MLE1BQU0sSUFBSWtMLElBQXZCLEVBQTZCO0FBQ3pCLGdCQUFNLElBQUl4TCxlQUFKLENBQ0QsMkJBQTBCTSxNQUFPLGdCQUFlLEtBQUtJLElBQUwsQ0FBVWEsSUFBSywwQ0FBeUNqQixNQUFPLElBRDlHLENBQU47QUFHSDs7QUFFRCxjQUFNeUwsV0FBVyxHQUFHLE1BQU16TCxNQUExQjs7QUFDQSxZQUFJeUwsV0FBVyxJQUFJUCxJQUFuQixFQUF5QjtBQUNyQixnQkFBTSxJQUFJeEwsZUFBSixDQUNELDJCQUEwQk0sTUFBTyxnQkFBZSxLQUFLSSxJQUFMLENBQVVhLElBQUssc0NBQXFDd0ssV0FBWSxJQUQvRyxDQUFOO0FBR0g7O0FBRUQsWUFBSUgsQ0FBQyxJQUFJLElBQVQsRUFBZTtBQUNYbEssVUFBQUEsR0FBRyxDQUFDcEIsTUFBRCxDQUFILEdBQWMsSUFBZDtBQUNILFNBRkQsTUFFTztBQUNIcUwsVUFBQUEsSUFBSSxDQUFDckwsTUFBRCxDQUFKLEdBQWVzTCxDQUFmO0FBQ0g7QUFDSixPQWpDTSxNQWlDQTtBQUNIbEssUUFBQUEsR0FBRyxDQUFDbUssQ0FBRCxDQUFILEdBQVNELENBQVQ7QUFDSDtBQUNKLEtBcEREOztBQXNEQSxXQUFPLENBQUNsSyxHQUFELEVBQU1nSyxNQUFOLEVBQWNDLElBQWQsQ0FBUDtBQUNIOztBQUVnQyxlQUFwQkssb0JBQW9CLENBQUNoSixPQUFELEVBQVVpSixVQUFWLEVBQXNCO0FBQ25ELFVBQU12TCxJQUFJLEdBQUcsS0FBS0EsSUFBTCxDQUFVZ0csWUFBdkI7QUFFQSxVQUFNL0csVUFBVSxDQUFDc00sVUFBRCxFQUFhLE9BQU9DLFFBQVAsRUFBaUI1TCxNQUFqQixLQUE0QjtBQUNyRCxZQUFNd0wsU0FBUyxHQUFHcEwsSUFBSSxDQUFDSixNQUFELENBQXRCO0FBQ0EsWUFBTTZMLGdCQUFnQixHQUFHLEtBQUszSyxFQUFMLENBQVFrRyxLQUFSLENBQWNvRSxTQUFTLENBQUM1SSxNQUF4QixDQUF6Qjs7QUFGcUQsV0FJN0MsQ0FBQzRJLFNBQVMsQ0FBQzlCLElBSmtDO0FBQUE7QUFBQTs7QUFNckQsVUFBSW9DLE9BQU8sR0FBRyxNQUFNRCxnQkFBZ0IsQ0FBQ2hKLFFBQWpCLENBQTBCK0ksUUFBMUIsRUFBb0NsSixPQUFPLENBQUNNLFdBQTVDLENBQXBCOztBQUVBLFVBQUksQ0FBQzhJLE9BQUwsRUFBYztBQUNWLGNBQU0sSUFBSXRNLHVCQUFKLENBQTZCLHNCQUFxQnFNLGdCQUFnQixDQUFDekwsSUFBakIsQ0FBc0JhLElBQUssVUFBUzhLLElBQUksQ0FBQ0MsU0FBTCxDQUFlSixRQUFmLENBQXlCLGFBQS9HLENBQU47QUFDSDs7QUFFRGxKLE1BQUFBLE9BQU8sQ0FBQ3RCLEdBQVIsQ0FBWXBCLE1BQVosSUFBc0I4TCxPQUFPLENBQUNOLFNBQVMsQ0FBQ2pMLEtBQVgsQ0FBN0I7QUFDSCxLQWJlLENBQWhCO0FBY0g7O0FBRTBCLGVBQWQwTCxjQUFjLENBQUN2SixPQUFELEVBQVUwSSxNQUFWLEVBQWtCYyxrQkFBbEIsRUFBc0M7QUFDN0QsVUFBTTlMLElBQUksR0FBRyxLQUFLQSxJQUFMLENBQVVnRyxZQUF2QjtBQUNBLFFBQUkrRixRQUFKOztBQUVBLFFBQUksQ0FBQ0Qsa0JBQUwsRUFBeUI7QUFDckJDLE1BQUFBLFFBQVEsR0FBR3pKLE9BQU8sQ0FBQ3NCLE1BQVIsQ0FBZSxLQUFLNUQsSUFBTCxDQUFVaUQsUUFBekIsQ0FBWDs7QUFFQSxVQUFJbkUsQ0FBQyxDQUFDK0ssS0FBRixDQUFRa0MsUUFBUixDQUFKLEVBQXVCO0FBQ25CLFlBQUl6SixPQUFPLENBQUNtQixNQUFSLENBQWVDLFlBQWYsS0FBZ0MsQ0FBcEMsRUFBdUM7QUFHbkMsZ0JBQU1zSSxLQUFLLEdBQUcsS0FBSy9ILDBCQUFMLENBQWdDM0IsT0FBTyxDQUFDc0IsTUFBeEMsQ0FBZDtBQUNBdEIsVUFBQUEsT0FBTyxDQUFDc0IsTUFBUixHQUFpQixNQUFNLEtBQUtuQixRQUFMLENBQWM7QUFBRUMsWUFBQUEsTUFBTSxFQUFFc0o7QUFBVixXQUFkLEVBQWlDMUosT0FBTyxDQUFDTSxXQUF6QyxDQUF2Qjs7QUFDQSxjQUFJLENBQUNOLE9BQU8sQ0FBQ3NCLE1BQWIsRUFBcUI7QUFDakIsa0JBQU0sSUFBSXpFLGdCQUFKLENBQXFCLDhGQUFyQixFQUFxSDtBQUN2SDZNLGNBQUFBLEtBRHVIO0FBRXZIbEIsY0FBQUEsSUFBSSxFQUFFeEksT0FBTyxDQUFDdUI7QUFGeUcsYUFBckgsQ0FBTjtBQUlIO0FBQ0o7O0FBRURrSSxRQUFBQSxRQUFRLEdBQUd6SixPQUFPLENBQUNzQixNQUFSLENBQWUsS0FBSzVELElBQUwsQ0FBVWlELFFBQXpCLENBQVg7O0FBRUEsWUFBSW5FLENBQUMsQ0FBQytLLEtBQUYsQ0FBUWtDLFFBQVIsQ0FBSixFQUF1QjtBQUNuQixnQkFBTSxJQUFJNU0sZ0JBQUosQ0FBcUIsdURBQXVELEtBQUthLElBQUwsQ0FBVWEsSUFBdEYsRUFBNEY7QUFDOUZpSyxZQUFBQSxJQUFJLEVBQUV4SSxPQUFPLENBQUNzQixNQURnRjtBQUU5Rm9DLFlBQUFBLFlBQVksRUFBRWdGO0FBRmdGLFdBQTVGLENBQU47QUFJSDtBQUNKO0FBQ0o7O0FBRUQsVUFBTWlCLGFBQWEsR0FBRyxFQUF0QjtBQUNBLFVBQU1DLFFBQVEsR0FBRyxFQUFqQjs7QUFHQSxVQUFNQyxhQUFhLEdBQUdyTixDQUFDLENBQUNzTixJQUFGLENBQU85SixPQUFPLENBQUNLLE9BQWYsRUFBd0IsQ0FBQyxnQkFBRCxFQUFtQixZQUFuQixFQUFpQyxZQUFqQyxDQUF4QixDQUF0Qjs7QUFFQSxVQUFNMUQsVUFBVSxDQUFDK0wsTUFBRCxFQUFTLE9BQU9GLElBQVAsRUFBYWxMLE1BQWIsS0FBd0I7QUFDN0MsVUFBSXdMLFNBQVMsR0FBR3BMLElBQUksQ0FBQ0osTUFBRCxDQUFwQjs7QUFFQSxVQUFJa00sa0JBQWtCLElBQUlWLFNBQVMsQ0FBQy9KLElBQVYsS0FBbUIsVUFBekMsSUFBdUQrSixTQUFTLENBQUMvSixJQUFWLEtBQW1CLFdBQTlFLEVBQTJGO0FBQ3ZGNEssUUFBQUEsYUFBYSxDQUFDck0sTUFBRCxDQUFiLEdBQXdCa0wsSUFBeEI7QUFDQTtBQUNIOztBQUVELFVBQUl1QixVQUFVLEdBQUcsS0FBS3ZMLEVBQUwsQ0FBUWtHLEtBQVIsQ0FBY29FLFNBQVMsQ0FBQzVJLE1BQXhCLENBQWpCOztBQUVBLFVBQUk0SSxTQUFTLENBQUM5QixJQUFkLEVBQW9CO0FBQ2hCd0IsUUFBQUEsSUFBSSxHQUFHaE0sQ0FBQyxDQUFDd04sU0FBRixDQUFZeEIsSUFBWixDQUFQOztBQUVBLFlBQUksQ0FBQ00sU0FBUyxDQUFDakwsS0FBZixFQUFzQjtBQUNsQixnQkFBTSxJQUFJaEIsZ0JBQUosQ0FDRCw0REFBMkRTLE1BQU8sZ0JBQWUsS0FBS0ksSUFBTCxDQUFVYSxJQUFLLElBRC9GLENBQU47QUFHSDs7QUFFRCxlQUFPNUIsVUFBVSxDQUFDNkwsSUFBRCxFQUFReUIsSUFBRCxJQUNwQkYsVUFBVSxDQUFDdkssT0FBWCxDQUFtQixFQUFFLEdBQUd5SyxJQUFMO0FBQVcsV0FBQ25CLFNBQVMsQ0FBQ2pMLEtBQVgsR0FBbUI0TDtBQUE5QixTQUFuQixFQUE2REksYUFBN0QsRUFBNEU3SixPQUFPLENBQUNNLFdBQXBGLENBRGEsQ0FBakI7QUFHSCxPQVpELE1BWU8sSUFBSSxDQUFDOUQsQ0FBQyxDQUFDc0YsYUFBRixDQUFnQjBHLElBQWhCLENBQUwsRUFBNEI7QUFDL0IsWUFBSXRKLEtBQUssQ0FBQ0MsT0FBTixDQUFjcUosSUFBZCxDQUFKLEVBQXlCO0FBQ3JCLGdCQUFNLElBQUkzTCxnQkFBSixDQUNELHNDQUFxQ2lNLFNBQVMsQ0FBQzVJLE1BQU8sMEJBQXlCLEtBQUt4QyxJQUFMLENBQVVhLElBQUssc0NBQXFDakIsTUFBTyxtQ0FEekksQ0FBTjtBQUdIOztBQUVELFlBQUksQ0FBQ3dMLFNBQVMsQ0FBQ3JGLEtBQWYsRUFBc0I7QUFDbEIsZ0JBQU0sSUFBSTVHLGdCQUFKLENBQ0QscUNBQW9DUyxNQUFPLDJDQUQxQyxDQUFOO0FBR0g7O0FBRURrTCxRQUFBQSxJQUFJLEdBQUc7QUFBRSxXQUFDTSxTQUFTLENBQUNyRixLQUFYLEdBQW1CK0U7QUFBckIsU0FBUDtBQUNIOztBQUVELFVBQUksQ0FBQ2dCLGtCQUFELElBQXVCVixTQUFTLENBQUNqTCxLQUFyQyxFQUE0QztBQUV4QzJLLFFBQUFBLElBQUksR0FBRyxFQUFFLEdBQUdBLElBQUw7QUFBVyxXQUFDTSxTQUFTLENBQUNqTCxLQUFYLEdBQW1CNEw7QUFBOUIsU0FBUDtBQUNIOztBQUVESSxNQUFBQSxhQUFhLENBQUNwSSxpQkFBZCxHQUFrQyxJQUFsQztBQUNBLFVBQUkySCxPQUFPLEdBQUcsTUFBTVcsVUFBVSxDQUFDdkssT0FBWCxDQUFtQmdKLElBQW5CLEVBQXlCcUIsYUFBekIsRUFBd0M3SixPQUFPLENBQUNNLFdBQWhELENBQXBCOztBQUNBLFVBQUl1SixhQUFhLENBQUM3SSxPQUFkLENBQXNCSSxZQUF0QixLQUF1QyxDQUEzQyxFQUE4QztBQUcxQyxjQUFNOEksVUFBVSxHQUFHSCxVQUFVLENBQUNwSSwwQkFBWCxDQUFzQzZHLElBQXRDLENBQW5CO0FBQ0FZLFFBQUFBLE9BQU8sR0FBRyxNQUFNVyxVQUFVLENBQUM1SixRQUFYLENBQW9CO0FBQUVDLFVBQUFBLE1BQU0sRUFBRThKO0FBQVYsU0FBcEIsRUFBNENsSyxPQUFPLENBQUNNLFdBQXBELENBQWhCOztBQUNBLFlBQUksQ0FBQzhJLE9BQUwsRUFBYztBQUNWLGdCQUFNLElBQUl2TSxnQkFBSixDQUFxQixrR0FBckIsRUFBeUg7QUFDM0g2TSxZQUFBQSxLQUFLLEVBQUVRLFVBRG9IO0FBRTNIMUIsWUFBQUE7QUFGMkgsV0FBekgsQ0FBTjtBQUlIO0FBQ0o7O0FBRURvQixNQUFBQSxRQUFRLENBQUN0TSxNQUFELENBQVIsR0FBbUJrTSxrQkFBa0IsR0FBR0osT0FBTyxDQUFDTixTQUFTLENBQUNqTCxLQUFYLENBQVYsR0FBOEJ1TCxPQUFPLENBQUNOLFNBQVMsQ0FBQ3hFLEdBQVgsQ0FBMUU7QUFDSCxLQTNEZSxDQUFoQjs7QUE2REEsUUFBSWtGLGtCQUFKLEVBQXdCO0FBQ3BCaE4sTUFBQUEsQ0FBQyxDQUFDNEwsTUFBRixDQUFTd0IsUUFBVCxFQUFtQixDQUFDTyxhQUFELEVBQWdCQyxVQUFoQixLQUErQjtBQUM5Q3BLLFFBQUFBLE9BQU8sQ0FBQ3RCLEdBQVIsQ0FBWTBMLFVBQVosSUFBMEJELGFBQTFCO0FBQ0gsT0FGRDtBQUdIOztBQUVELFdBQU9SLGFBQVA7QUFDSDs7QUFFMEIsZUFBZFUsY0FBYyxDQUFDckssT0FBRCxFQUFVMEksTUFBVixFQUFrQjRCLGtCQUFsQixFQUFzQ0MsZUFBdEMsRUFBdUQ7QUFDOUUsVUFBTTdNLElBQUksR0FBRyxLQUFLQSxJQUFMLENBQVVnRyxZQUF2QjtBQUVBLFFBQUk4RyxlQUFKOztBQUVBLFFBQUksQ0FBQ0Ysa0JBQUwsRUFBeUI7QUFDckJFLE1BQUFBLGVBQWUsR0FBR3JOLFlBQVksQ0FBQyxDQUFDNkMsT0FBTyxDQUFDSyxPQUFSLENBQWdCRCxNQUFqQixFQUF5QkosT0FBTyxDQUFDc0IsTUFBakMsQ0FBRCxFQUEyQyxLQUFLNUQsSUFBTCxDQUFVaUQsUUFBckQsQ0FBOUI7O0FBQ0EsVUFBSW5FLENBQUMsQ0FBQytLLEtBQUYsQ0FBUWlELGVBQVIsQ0FBSixFQUE4QjtBQUUxQixjQUFNLElBQUkzTixnQkFBSixDQUFxQix1REFBdUQsS0FBS2EsSUFBTCxDQUFVYSxJQUF0RixDQUFOO0FBQ0g7QUFDSjs7QUFFRCxVQUFNb0wsYUFBYSxHQUFHLEVBQXRCOztBQUdBLFVBQU1FLGFBQWEsR0FBR3JOLENBQUMsQ0FBQ3NOLElBQUYsQ0FBTzlKLE9BQU8sQ0FBQ0ssT0FBZixFQUF3QixDQUFDLGdCQUFELEVBQW1CLFlBQW5CLEVBQWlDLFlBQWpDLENBQXhCLENBQXRCOztBQUVBLFVBQU0xRCxVQUFVLENBQUMrTCxNQUFELEVBQVMsT0FBT0YsSUFBUCxFQUFhbEwsTUFBYixLQUF3QjtBQUM3QyxVQUFJd0wsU0FBUyxHQUFHcEwsSUFBSSxDQUFDSixNQUFELENBQXBCOztBQUVBLFVBQUlnTixrQkFBa0IsSUFBSXhCLFNBQVMsQ0FBQy9KLElBQVYsS0FBbUIsVUFBekMsSUFBdUQrSixTQUFTLENBQUMvSixJQUFWLEtBQW1CLFdBQTlFLEVBQTJGO0FBQ3ZGNEssUUFBQUEsYUFBYSxDQUFDck0sTUFBRCxDQUFiLEdBQXdCa0wsSUFBeEI7QUFDQTtBQUNIOztBQUVELFVBQUl1QixVQUFVLEdBQUcsS0FBS3ZMLEVBQUwsQ0FBUWtHLEtBQVIsQ0FBY29FLFNBQVMsQ0FBQzVJLE1BQXhCLENBQWpCOztBQUVBLFVBQUk0SSxTQUFTLENBQUM5QixJQUFkLEVBQW9CO0FBQ2hCd0IsUUFBQUEsSUFBSSxHQUFHaE0sQ0FBQyxDQUFDd04sU0FBRixDQUFZeEIsSUFBWixDQUFQOztBQUVBLFlBQUksQ0FBQ00sU0FBUyxDQUFDakwsS0FBZixFQUFzQjtBQUNsQixnQkFBTSxJQUFJaEIsZ0JBQUosQ0FDRCw0REFBMkRTLE1BQU8sZ0JBQWUsS0FBS0ksSUFBTCxDQUFVYSxJQUFLLElBRC9GLENBQU47QUFHSDs7QUFFRCxjQUFNa00sU0FBUyxHQUFHck4sU0FBUyxDQUFDb0wsSUFBRCxFQUFPa0MsTUFBTSxJQUFJQSxNQUFNLENBQUM1QixTQUFTLENBQUN4RSxHQUFYLENBQU4sSUFBeUIsSUFBMUMsRUFBZ0RvRyxNQUFNLElBQUlBLE1BQU0sQ0FBQzVCLFNBQVMsQ0FBQ3hFLEdBQVgsQ0FBaEUsQ0FBM0I7QUFDQSxjQUFNcUcsb0JBQW9CLEdBQUc7QUFBRSxXQUFDN0IsU0FBUyxDQUFDakwsS0FBWCxHQUFtQjJNO0FBQXJCLFNBQTdCOztBQUNBLFlBQUlDLFNBQVMsQ0FBQ0csTUFBVixHQUFtQixDQUF2QixFQUEwQjtBQUN0QkQsVUFBQUEsb0JBQW9CLENBQUM3QixTQUFTLENBQUN4RSxHQUFYLENBQXBCLEdBQXNDO0FBQUV1RyxZQUFBQSxNQUFNLEVBQUVKO0FBQVYsV0FBdEM7QUFDSDs7QUFFRCxjQUFNVixVQUFVLENBQUNlLFdBQVgsQ0FBdUJILG9CQUF2QixFQUE2QzNLLE9BQU8sQ0FBQ00sV0FBckQsQ0FBTjtBQUVBLGVBQU8zRCxVQUFVLENBQUM2TCxJQUFELEVBQVF5QixJQUFELElBQVVBLElBQUksQ0FBQ25CLFNBQVMsQ0FBQ3hFLEdBQVgsQ0FBSixJQUF1QixJQUF2QixHQUM5QnlGLFVBQVUsQ0FBQ2pLLFVBQVgsQ0FDSSxFQUFFLEdBQUd0RCxDQUFDLENBQUNxRSxJQUFGLENBQU9vSixJQUFQLEVBQWEsQ0FBQ25CLFNBQVMsQ0FBQ3hFLEdBQVgsQ0FBYixDQUFMO0FBQW9DLFdBQUN3RSxTQUFTLENBQUNqTCxLQUFYLEdBQW1CMk07QUFBdkQsU0FESixFQUVJO0FBQUVwSyxVQUFBQSxNQUFNLEVBQUU7QUFBRSxhQUFDMEksU0FBUyxDQUFDeEUsR0FBWCxHQUFpQjJGLElBQUksQ0FBQ25CLFNBQVMsQ0FBQ3hFLEdBQVg7QUFBdkIsV0FBVjtBQUFvRCxhQUFHdUY7QUFBdkQsU0FGSixFQUdJN0osT0FBTyxDQUFDTSxXQUhaLENBRDhCLEdBTTlCeUosVUFBVSxDQUFDdkssT0FBWCxDQUNJLEVBQUUsR0FBR3lLLElBQUw7QUFBVyxXQUFDbkIsU0FBUyxDQUFDakwsS0FBWCxHQUFtQjJNO0FBQTlCLFNBREosRUFFSVgsYUFGSixFQUdJN0osT0FBTyxDQUFDTSxXQUhaLENBTmEsQ0FBakI7QUFZSCxPQTdCRCxNQTZCTyxJQUFJLENBQUM5RCxDQUFDLENBQUNzRixhQUFGLENBQWdCMEcsSUFBaEIsQ0FBTCxFQUE0QjtBQUMvQixZQUFJdEosS0FBSyxDQUFDQyxPQUFOLENBQWNxSixJQUFkLENBQUosRUFBeUI7QUFDckIsZ0JBQU0sSUFBSTNMLGdCQUFKLENBQ0Qsc0NBQXFDaU0sU0FBUyxDQUFDNUksTUFBTywwQkFBeUIsS0FBS3hDLElBQUwsQ0FBVWEsSUFBSyxzQ0FBcUNqQixNQUFPLG1DQUR6SSxDQUFOO0FBR0g7O0FBRUQsWUFBSSxDQUFDd0wsU0FBUyxDQUFDckYsS0FBZixFQUFzQjtBQUNsQixnQkFBTSxJQUFJNUcsZ0JBQUosQ0FDRCxxQ0FBb0NTLE1BQU8sMkNBRDFDLENBQU47QUFHSDs7QUFHRGtMLFFBQUFBLElBQUksR0FBRztBQUFFLFdBQUNNLFNBQVMsQ0FBQ3JGLEtBQVgsR0FBbUIrRTtBQUFyQixTQUFQO0FBQ0g7O0FBRUQsVUFBSThCLGtCQUFKLEVBQXdCO0FBQ3BCLFlBQUk5TixDQUFDLENBQUNvRixPQUFGLENBQVU0RyxJQUFWLENBQUosRUFBcUI7QUFHckIsWUFBSXVDLFlBQVksR0FBRzVOLFlBQVksQ0FBQyxDQUFDNkMsT0FBTyxDQUFDK0MsUUFBVCxFQUFtQi9DLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQsTUFBbkMsRUFBMkNKLE9BQU8sQ0FBQ3RCLEdBQW5ELENBQUQsRUFBMERwQixNQUExRCxDQUEvQjs7QUFFQSxZQUFJeU4sWUFBWSxJQUFJLElBQXBCLEVBQTBCO0FBQ3RCLGNBQUl2TyxDQUFDLENBQUNvRixPQUFGLENBQVU1QixPQUFPLENBQUMrQyxRQUFsQixDQUFKLEVBQWlDO0FBQzdCL0MsWUFBQUEsT0FBTyxDQUFDK0MsUUFBUixHQUFtQixNQUFNLEtBQUs1QyxRQUFMLENBQWNILE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQsTUFBOUIsRUFBc0NKLE9BQU8sQ0FBQ00sV0FBOUMsQ0FBekI7O0FBQ0EsZ0JBQUksQ0FBQ04sT0FBTyxDQUFDK0MsUUFBYixFQUF1QjtBQUNuQixvQkFBTSxJQUFJL0YsZUFBSixDQUFxQixjQUFhLEtBQUtVLElBQUwsQ0FBVWEsSUFBSyxjQUFqRCxFQUFnRTtBQUFFbUwsZ0JBQUFBLEtBQUssRUFBRTFKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBekIsZUFBaEUsQ0FBTjtBQUNIOztBQUNEMkssWUFBQUEsWUFBWSxHQUFHL0ssT0FBTyxDQUFDK0MsUUFBUixDQUFpQnpGLE1BQWpCLENBQWY7QUFDSDs7QUFFRCxjQUFJeU4sWUFBWSxJQUFJLElBQXBCLEVBQTBCO0FBQ3RCLGdCQUFJLEVBQUV6TixNQUFNLElBQUkwQyxPQUFPLENBQUMrQyxRQUFwQixDQUFKLEVBQW1DO0FBQy9CLG9CQUFNLElBQUlsRyxnQkFBSixDQUFxQixtRUFBckIsRUFBMEY7QUFDNUZTLGdCQUFBQSxNQUQ0RjtBQUU1RmtMLGdCQUFBQSxJQUY0RjtBQUc1RnpGLGdCQUFBQSxRQUFRLEVBQUUvQyxPQUFPLENBQUMrQyxRQUgwRTtBQUk1RjJHLGdCQUFBQSxLQUFLLEVBQUUxSixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JELE1BSnFFO0FBSzVGMUIsZ0JBQUFBLEdBQUcsRUFBRXNCLE9BQU8sQ0FBQ3RCO0FBTCtFLGVBQTFGLENBQU47QUFPSDs7QUFJRG1MLFlBQUFBLGFBQWEsQ0FBQ3BJLGlCQUFkLEdBQWtDLElBQWxDO0FBQ0EsZ0JBQUkySCxPQUFPLEdBQUcsTUFBTVcsVUFBVSxDQUFDdkssT0FBWCxDQUFtQmdKLElBQW5CLEVBQXlCcUIsYUFBekIsRUFBd0M3SixPQUFPLENBQUNNLFdBQWhELENBQXBCOztBQUVBLGdCQUFJdUosYUFBYSxDQUFDN0ksT0FBZCxDQUFzQkksWUFBdEIsS0FBdUMsQ0FBM0MsRUFBOEM7QUFHMUMsb0JBQU04SSxVQUFVLEdBQUdILFVBQVUsQ0FBQ3BJLDBCQUFYLENBQXNDNkcsSUFBdEMsQ0FBbkI7QUFDQVksY0FBQUEsT0FBTyxHQUFHLE1BQU1XLFVBQVUsQ0FBQzVKLFFBQVgsQ0FBb0I7QUFBRUMsZ0JBQUFBLE1BQU0sRUFBRThKO0FBQVYsZUFBcEIsRUFBNENsSyxPQUFPLENBQUNNLFdBQXBELENBQWhCOztBQUNBLGtCQUFJLENBQUM4SSxPQUFMLEVBQWM7QUFDVixzQkFBTSxJQUFJdk0sZ0JBQUosQ0FBcUIsa0dBQXJCLEVBQXlIO0FBQzNINk0sa0JBQUFBLEtBQUssRUFBRVEsVUFEb0g7QUFFM0gxQixrQkFBQUE7QUFGMkgsaUJBQXpILENBQU47QUFJSDtBQUNKOztBQUVEeEksWUFBQUEsT0FBTyxDQUFDdEIsR0FBUixDQUFZcEIsTUFBWixJQUFzQjhMLE9BQU8sQ0FBQ04sU0FBUyxDQUFDakwsS0FBWCxDQUE3QjtBQUNBO0FBQ0g7QUFDSjs7QUFFRCxZQUFJa04sWUFBSixFQUFrQjtBQUNkLGlCQUFPaEIsVUFBVSxDQUFDakssVUFBWCxDQUNIMEksSUFERyxFQUVIO0FBQUUsYUFBQ00sU0FBUyxDQUFDakwsS0FBWCxHQUFtQmtOLFlBQXJCO0FBQW1DLGVBQUdsQjtBQUF0QyxXQUZHLEVBR0g3SixPQUFPLENBQUNNLFdBSEwsQ0FBUDtBQUtIOztBQUdEO0FBQ0g7O0FBRUQsWUFBTXlKLFVBQVUsQ0FBQ2UsV0FBWCxDQUF1QjtBQUFFLFNBQUNoQyxTQUFTLENBQUNqTCxLQUFYLEdBQW1CMk07QUFBckIsT0FBdkIsRUFBK0R4SyxPQUFPLENBQUNNLFdBQXZFLENBQU47O0FBRUEsVUFBSWlLLGVBQUosRUFBcUI7QUFDakIsZUFBT1IsVUFBVSxDQUFDdkssT0FBWCxDQUNILEVBQUUsR0FBR2dKLElBQUw7QUFBVyxXQUFDTSxTQUFTLENBQUNqTCxLQUFYLEdBQW1CMk07QUFBOUIsU0FERyxFQUVIWCxhQUZHLEVBR0g3SixPQUFPLENBQUNNLFdBSEwsQ0FBUDtBQUtIOztBQUVELFlBQU0sSUFBSTNCLEtBQUosQ0FBVSw2REFBVixDQUFOO0FBR0gsS0FsSWUsQ0FBaEI7QUFvSUEsV0FBT2dMLGFBQVA7QUFDSDs7QUE1aUNzQzs7QUEraUMzQ3FCLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjFOLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi1cInVzZSBzdHJpY3RcIjtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIFJlZmVyZW5jZWROb3RFeGlzdEVycm9yLCBEdXBsaWNhdGVFcnJvciwgVmFsaWRhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9FcnJvcnNcIik7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoXCIuLi8uLi90eXBlc1wiKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tLCBtYXBGaWx0ZXIgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9sYW5nXCIpO1xuXG5jb25zdCBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyID0gKGFuY2hvcikgPT4gKCc6JyArIGFuY2hvcik7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICogQHBhcmFtIHsqfSBpbmZvXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImFycmF5XCIgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9maWxsUmVzdWx0KGNvbnRleHQpIHtcbiAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0ID0geyAuLi5jb250ZXh0LmxhdGVzdCwgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQgfHwge1xuICAgICAgICAgICAgICAgIGFmZmVjdGVkUm93czogMCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VkUm93czogMFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAkcXVlcnk6IG9wdGlvbnMuJHF1ZXJ5LCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCxcbiAgICAgICAgICAgICAgICAgICAgLi4ucmV0cmlldmVPcHRpb25zLCAgICAgICBcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gb3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7XG4gICAgICAgIGNvbnN0IFsgbm9ybWFsQXNzb2NzLCBjdXN0b21Bc3NvY3MgXSA9IF8ucGFydGl0aW9uKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiwgYXNzb2MgPT4gdHlwZW9mIGFzc29jID09PSAnc3RyaW5nJyk7XG5cbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9ICBfLnVuaXEobm9ybWFsQXNzb2NzKS5zb3J0KCkuY29uY2F0KGN1c3RvbUFzc29jcyk7XG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sXG4gICAgICAgICAgICBjb3VudGVyID0gMCxcbiAgICAgICAgICAgIGNhY2hlID0ge307XG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goKGFzc29jKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IFwiOmpvaW5cIiArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0XG4gICAgICAgICAgICAgICAgICAgICAgICA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgICAgICAgbGV0IHJlc3VsdDtcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MgKyAxKTtcblxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgXCIuXCIgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgZW50aXR5TmFtZV0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoXCIuXCIsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5LCBuZXN0ZWRLZXlHZXR0ZXIpIHtcbiAgICAgICAgbmVzdGVkS2V5R2V0dGVyID09IG51bGwgJiYgKG5lc3RlZEtleUdldHRlciA9IGRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIpOyAgICAgICAgXG4gICAgICAgIGFsaWFzTWFwID0gXy5tYXBWYWx1ZXMoYWxpYXNNYXAsIGNoYWluID0+IGNoYWluLm1hcChhbmNob3IgPT4gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcikpKTtcblxuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICBjb2x1bW5zID0gY29sdW1ucy5tYXAoY29sID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb3MgPSBjb2wubmFtZS5pbmRleE9mKCckJyk7XG4gICAgICAgICAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wubmFtZS5zdWJzdHIoMCwgcG9zKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLnN1YnN0cihwb3MrMSlcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgdGFibGU6ICdBJyxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wudGFibGUsXG4gICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG5cbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleVZhbHVlID0gc3ViT2JqW2tleV07XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwocm93S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChsaXN0ICYmIHJvd0tleVZhbHVlID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBzaG91bGQgYmUgYSBsaXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaixcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBkb2VzIG5vdCBleGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqZWN0XTtcblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKlxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy93aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWQgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHN1Yk9iamVjdFtrZXldID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXgsXG4gICAgICAgICAgICAgICAgICAgIH0gOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTsgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgY29uc3QgdGFibGVUZW1wbGF0ZSA9IGNvbHVtbnMucmVkdWNlKChyZXN1bHQsIGNvbCkgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbC50YWJsZSAhPT0gJ0EnKSB7XG4gICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHJlc3VsdFtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC50YWJsZV0gPSB7IFtjb2wubmFtZV06IG51bGwgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3cpID0+IHtcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGNvbElkeCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2NvbElkeF07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7IC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZm9yT3duKHRhYmxlQ2FjaGUsIChvYmosIHRhYmxlKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbdGFibGVdOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyb3dPYmplY3QsIG5vZGVQYXRoLCBvYmopO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGhpZXJhcmNoeSwgW10pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7XG4gICAgICAgICAgICAgICAgcm93T2JqZWN0LFxuICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSksXG4gICAgICAgICAgICB9OyAgXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUtcHJvY2VzcyBhc3NvaWNhdGVkIGRiIG9wZXJhdGlvblxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGlzTmV3IC0gTmV3IHJlY29yZCBmbGFnLCB0cnVlIGZvciBjcmVhdGluZywgZmFsc2UgZm9yIHVwZGF0aW5nXG4gICAgICogQHJldHVybnMgXG4gICAgICovXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIGlzTmV3KSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LFxuICAgICAgICAgICAgYXNzb2NzID0ge30sXG4gICAgICAgICAgICByZWZzID0ge307XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gXCI6XCIpIHtcbiAgICAgICAgICAgICAgICAvL2Nhc2NhZGUgdXBkYXRlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChrWzBdID09PSBcIkBcIikge1xuICAgICAgICAgICAgICAgIC8vdXBkYXRlIGJ5IHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBBc3NvY2lhdGlvbiB0eXBlIFwiJHthc3NvY01ldGEudHlwZX1cIiBjYW5ub3QgYmUgdXNlZCBmb3IgdXBkYXRlIGJ5IHJlZmVyZW5jZS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0FuY2hvciA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0FuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggYXNzb2NpYXRpb24gZGF0YSBcIiR7YXNzb2NBbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh2ID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2FuY2hvcl0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlZnNbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmF3W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFtyYXcsIGFzc29jcywgcmVmc107XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhyZWZlcmVuY2VzLCBhc3luYyAocmVmUXVlcnksIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgY29uc3QgUmVmZXJlbmNlZEVudGl0eSA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGFzc2VydDogIWFzc29jTWV0YS5saXN0O1xuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IFJlZmVyZW5jZWRFbnRpdHkuZmluZE9uZV8ocmVmUXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoYFJlZmVyZW5jZWQgZW50aXR5IFwiJHtSZWZlcmVuY2VkRW50aXR5Lm1ldGEubmFtZX1cIiB3aXRoICR7SlNPTi5zdHJpbmdpZnkocmVmUXVlcnkpfSBub3QgZXhpc3QuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiVGhlIHBhcmVudCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQubGF0ZXN0XG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhOiBjb250ZXh0LnJldHVybixcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uczogYXNzb2NzXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkc2tpcE1vZGlmaWVyc1wiLCBcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAvL2hhc01hbnkgb3IgaGFzT25lXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQgPSB0cnVlO1xuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICBpZiAocGFzc09uT3B0aW9ucy4kcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUXVlcnkgPSBhc3NvY01vZGVsLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgICAgIGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmZpbmRPbmVfKHsgJHF1ZXJ5OiBhc3NvY1F1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogYXNzb2NRdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1tsb2NhbEZpZWxkXSA9IHJlZkZpZWxkVmFsdWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0tleXMgPSBtYXBGaWx0ZXIoZGF0YSwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSAhPSBudWxsLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NSZWNvcmRzVG9SZW1vdmUgPSB7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NSZWNvcmRzVG9SZW1vdmVbYXNzb2NNZXRhLmtleV0gPSB7ICRub3RJbjogYXNzb2NLZXlzIH07ICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKGFzc29jUmVjb3Jkc1RvUmVtb3ZlLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PiBpdGVtW2Fzc29jTWV0YS5rZXldICE9IG51bGwgP1xuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLl8ub21pdChpdGVtLCBbYXNzb2NNZXRhLmtleV0pLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7ICRxdWVyeTogeyBbYXNzb2NNZXRhLmtleV06IGl0ZW1bYXNzb2NNZXRhLmtleV0gfSwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApOlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG9cbiAgICAgICAgICAgICAgICBsZXQgZGVzdEVudGl0eUlkID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0LmV4aXN0aW5nLCBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJhd10sIGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBTcGVjaWZpZWQgXCIke3RoaXMubWV0YS5uYW1lfVwiIG5vdCBmb3VuZC5gLCB7IHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGVudGl0eSByZWNvcmQgZG9lcyBub3QgY29udGFpbiB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgaWQuXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZzogY29udGV4dC5leGlzdGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vdG8gY3JlYXRlIHRoZSBhc3NvY2lhdGVkLCBleGlzdGluZyBpcyBudWxsXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwYXNzT25PcHRpb25zLiRyZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYXNzb2NRdWVyeSA9IGFzc29jTW9kZWwuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuZmluZE9uZV8oeyAkcXVlcnk6IGFzc29jUXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiVGhlIGFzc29pY2F0ZWQgZW50aXR5IGlzIGR1cGxpY2F0ZWQgb24gdW5pcXVlIGtleXMgZGlmZmVyZW50IGZyb20gdGhlIHBhaXIgb2Yga2V5cyB1c2VkIHRvIHF1ZXJ5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBhc3NvY1F1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5yYXdbYW5jaG9yXSA9IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXTsgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkLCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9ub3RoaW5nIHRvIGRvIGZvciBudWxsIGRlc3QgZW50aXR5IGlkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidXBkYXRlIGFzc29jaWF0ZWQgZGF0YSBmb3IgbXVsdGlwbGUgcmVjb3JkcyBub3QgaW1wbGVtZW50ZWRcIik7XG5cbiAgICAgICAgICAgIC8vcmV0dXJuIGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5kYXRhLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7XG4iXX0=
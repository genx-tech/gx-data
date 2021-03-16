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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfZmlsbFJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsImluc2VydElkIiwicmV0dXJuIiwibGF0ZXN0IiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwiaXNFbXB0eSIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJjaGFuZ2VkUm93cyIsInJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQiLCIkcmV0cmlldmVOb3RVcGRhdGUiLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIiRwaHlzaWNhbERlbGV0aW9uIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwibm9ybWFsQXNzb2NzIiwiY3VzdG9tQXNzb2NzIiwicGFydGl0aW9uIiwiJGFzc29jaWF0aW9uIiwiYXNzb2MiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwic29ydCIsImNvbmNhdCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJzY2hlbWFOYW1lIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJuZXN0ZWRLZXlHZXR0ZXIiLCJtYXBWYWx1ZXMiLCJjaGFpbiIsIm1haW5JbmRleCIsInNlbGYiLCJjb2wiLCJ0YWJsZSIsInBvcyIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiY3VycmVudFBhdGgiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleVZhbHVlIiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInN1YkluZGV4IiwiYnVpbGRTdWJJbmRleGVzIiwiaW5kZXhlcyIsInN1Yk9iamVjdCIsImFycmF5T2ZPYmpzIiwidGFibGVUZW1wbGF0ZSIsInJlZHVjZSIsImJ1Y2tldCIsInJvdyIsInRhYmxlQ2FjaGUiLCJjb2xJZHgiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiYXNzb2NRdWVyeSIsInJlZkZpZWxkVmFsdWUiLCJsb2NhbEZpZWxkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLENBQUMsWUFBRDs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUNBLE1BQU1NLFdBQVcsR0FBR0wsT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLHVCQUFwQjtBQUE2Q0MsRUFBQUEsY0FBN0M7QUFBNkRDLEVBQUFBLGVBQTdEO0FBQThFQyxFQUFBQTtBQUE5RSxJQUFrR1YsT0FBTyxDQUFDLG9CQUFELENBQS9HOztBQUNBLE1BQU1XLEtBQUssR0FBR1gsT0FBTyxDQUFDLGFBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFWSxFQUFBQSxZQUFGO0FBQWdCQyxFQUFBQTtBQUFoQixJQUE4QmIsT0FBTyxDQUFDLGtCQUFELENBQTNDOztBQUVBLE1BQU1jLHNCQUFzQixHQUFJQyxNQUFELElB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QUFVLENBQUN2SyxPQUFYLENBQ0gsRUFBRSxHQUFHZ0osSUFBTDtBQUFXLFdBQUNNLFNBQVMsQ0FBQ2pMLEtBQVgsR0FBbUIyTTtBQUE5QixTQURHLEVBRUhYLGFBRkcsRUFHSDdKLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBRUQsWUFBTSxJQUFJM0IsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQWxJZSxDQUFoQjtBQW9JQSxXQUFPZ0wsYUFBUDtBQUNIOztBQTVpQ3NDOztBQStpQzNDcUIsTUFBTSxDQUFDQyxPQUFQLEdBQWlCMU4sZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLVwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoXCIuLi8uLi9FbnRpdHlNb2RlbFwiKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IsIER1cGxpY2F0ZUVycm9yLCBWYWxpZGF0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL0Vycm9yc1wiKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZShcIi4uLy4uL3R5cGVzXCIpO1xuY29uc3QgeyBnZXRWYWx1ZUZyb20sIG1hcEZpbHRlciB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL2xhbmdcIik7XG5cbmNvbnN0IGRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIgPSAoYW5jaG9yKSA9PiAoJzonICsgYW5jaG9yKTtcblxuLyoqXG4gKiBNeVNRTCBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKi9cbmNsYXNzIE15U1FMRW50aXR5TW9kZWwgZXh0ZW5kcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqXG4gICAgICogW3NwZWNpZmljXSBDaGVjayBpZiB0aGlzIGVudGl0eSBoYXMgYXV0byBpbmNyZW1lbnQgZmVhdHVyZS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKFxuICAgICAgICAgICAgZW50aXR5T2JqLFxuICAgICAgICAgICAga2V5UGF0aFxuICAgICAgICAgICAgICAgIC5zcGxpdChcIi5cIilcbiAgICAgICAgICAgICAgICAubWFwKChwKSA9PiBcIjpcIiArIHApXG4gICAgICAgICAgICAgICAgLmpvaW4oXCIuXCIpXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlblxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gXCJOT1dcIikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnJhdyhcIk5PVygpXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnQ6IFwiICsgbmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWVcbiAgICAgKiBAcGFyYW0geyp9IGluZm9cbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJkYXRldGltZVwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuREFURVRJTUUuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYXJyYXlcIiAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHksXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbXCIkcmV0cmlldmVVcGRhdGVkXCIsIFwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZVwiXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ZpbGxSZXN1bHQoY29udGV4dCkge1xuICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50ICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3QgPSB7IC4uLmNvbnRleHQubGF0ZXN0LCBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcblxuICAgICAgICBpZiAoIXJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZSAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShvcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSByZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5jb25kaXRpb24sICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAuLi5yZXRyaWV2ZU9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0IHx8IHtcbiAgICAgICAgICAgICAgICBhZmZlY3RlZFJvd3M6IDAsXG4gICAgICAgICAgICAgICAgY2hhbmdlZFJvd3M6IDBcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogb3B0aW9ucy4kcXVlcnksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLFxuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsICAgICAgIFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBvcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgWyBub3JtYWxBc3NvY3MsIGN1c3RvbUFzc29jcyBdID0gXy5wYXJ0aXRpb24oZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uLCBhc3NvYyA9PiB0eXBlb2YgYXNzb2MgPT09ICdzdHJpbmcnKTtcblxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gIF8udW5pcShub3JtYWxBc3NvY3MpLnNvcnQoKS5jb25jYXQoY3VzdG9tQXNzb2NzKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYyk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gXCI6am9pblwiICsgKytjb3VudGVyO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jVGFibGVbYWxpYXNdID0ge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgIG91dHB1dDogYXNzb2Mub3V0cHV0LFxuICAgICAgICAgICAgICAgICAgICBrZXk6IGFzc29jLmtleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMsXG4gICAgICAgICAgICAgICAgICAgIG9uOiBhc3NvYy5vbixcbiAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmRhdGFzZXRcbiAgICAgICAgICAgICAgICAgICAgICAgID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoXCIuXCIpO1xuICAgICAgICBsZXQgcmVzdWx0O1xuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkge1xuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcyArIDEpO1xuXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyBcIi5cIiArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoXCIuXCIpID4gMCkge1xuICAgICAgICAgICAgbGV0IFtzY2hlbWFOYW1lLCBlbnRpdHlOYW1lXSA9IGFzc29jLmVudGl0eS5zcGxpdChcIi5cIiwgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGFzc29jLmVudGl0eTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICBhc3NvYy5rZXkgPSBhc3NvYy5tb2RlbC5tZXRhLmtleUZpZWxkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHksIG5lc3RlZEtleUdldHRlcikge1xuICAgICAgICBuZXN0ZWRLZXlHZXR0ZXIgPT0gbnVsbCAmJiAobmVzdGVkS2V5R2V0dGVyID0gZGVmYXVsdE5lc3RlZEtleUdldHRlcik7ICAgICAgICBcbiAgICAgICAgYWxpYXNNYXAgPSBfLm1hcFZhbHVlcyhhbGlhc01hcCwgY2hhaW4gPT4gY2hhaW4ubWFwKGFuY2hvciA9PiBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKSkpO1xuXG4gICAgICAgIGxldCBtYWluSW5kZXggPSB7fTtcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGNvbHVtbnMgPSBjb2x1bW5zLm1hcChjb2wgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvcyA9IGNvbC5uYW1lLmluZGV4T2YoJyQnKTtcbiAgICAgICAgICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGU6IGNvbC5uYW1lLnN1YnN0cigwLCBwb3MpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUuc3Vic3RyKHBvcysxKVxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICB0YWJsZTogJ0EnLFxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgdGFibGU6IGNvbC50YWJsZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IG5lc3RlZEtleUdldHRlcihhbmNob3IpO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXSA9IHN1YkluZGV4O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IG5lc3RlZEtleUdldHRlcihhbmNob3IpO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSByb3dPYmplY3Rbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0LFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZCAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0gc3ViT2JqZWN0W2tleV0gPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleCxcbiAgICAgICAgICAgICAgICAgICAgfSA6IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdOyAgICAgICAgXG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gcmVzdWx0W2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLnRhYmxlXSA9IHsgW2NvbC5uYW1lXTogbnVsbCB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdykgPT4ge1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0gcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgY29sSWR4KSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbY29sSWR4XTtcblxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlICE9IG51bGwpIHsgLy8gYXZvaWQgYSBvYmplY3Qgd2l0aCBhbGwgbnVsbCB2YWx1ZSBleGlzdHNcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGVcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHsgLi4udGFibGVUZW1wbGF0ZVtjb2wudGFibGVdLCBbY29sLm5hbWVdOiB2YWx1ZSB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5mb3JPd24odGFibGVDYWNoZSwgKG9iaiwgdGFibGUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFt0YWJsZV07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZS1wcm9jZXNzIGFzc29pY2F0ZWQgZGIgb3BlcmF0aW9uXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gaXNOZXcgLSBOZXcgcmVjb3JkIGZsYWcsIHRydWUgZm9yIGNyZWF0aW5nLCBmYWxzZSBmb3IgdXBkYXRpbmdcbiAgICAgKiBAcmV0dXJucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgaXNOZXcpIHtcbiAgICAgICAgY29uc3QgcmF3ID0ge30sXG4gICAgICAgICAgICBhc3NvY3MgPSB7fSxcbiAgICAgICAgICAgIHJlZnMgPSB7fTtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSBcIjpcIikge1xuICAgICAgICAgICAgICAgIC8vY2FzY2FkZSB1cGRhdGVcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIChhc3NvY01ldGEudHlwZSA9PT0gXCJyZWZlcnNUb1wiIHx8IGFzc29jTWV0YS50eXBlID09PSBcImJlbG9uZ3NUb1wiKSAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIGRhdGEgXCI6JHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGtbMF0gPT09IFwiQFwiKSB7XG4gICAgICAgICAgICAgICAgLy91cGRhdGUgYnkgcmVmZXJlbmNlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYEFzc29jaWF0aW9uIHR5cGUgXCIke2Fzc29jTWV0YS50eXBlfVwiIGNhbm5vdCBiZSB1c2VkIGZvciB1cGRhdGUgYnkgcmVmZXJlbmNlLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jQW5jaG9yID0gXCI6XCIgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jQW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBhc3NvY2lhdGlvbiBkYXRhIFwiJHthc3NvY0FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHYgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICByYXdbYW5jaG9yXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVmc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW3JhdywgYXNzb2NzLCByZWZzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3BvcHVsYXRlUmVmZXJlbmNlc18oY29udGV4dCwgcmVmZXJlbmNlcykge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKHJlZmVyZW5jZXMsIGFzeW5jIChyZWZRdWVyeSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBjb25zdCBSZWZlcmVuY2VkRW50aXR5ID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiAhYXNzb2NNZXRhLmxpc3Q7XG5cbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgUmVmZXJlbmNlZEVudGl0eS5maW5kT25lXyhyZWZRdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihgUmVmZXJlbmNlZCBlbnRpdHkgXCIke1JlZmVyZW5jZWRFbnRpdHkubWV0YS5uYW1lfVwiIHdpdGggJHtKU09OLnN0cmluZ2lmeShyZWZRdWVyeSl9IG5vdCBleGlzdC5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yYXdbYW5jaG9yXSA9IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJUaGUgcGFyZW50IGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQucmV0dXJuLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBhc3NvY3NcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBmaW5pc2hlZCA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcGFzc09uT3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCA9IHRydWU7XG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIGlmIChwYXNzT25PcHRpb25zLiRyZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NRdWVyeSA9IGFzc29jTW9kZWwuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICAgICAgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuZmluZE9uZV8oeyAkcXVlcnk6IGFzc29jUXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiVGhlIGFzc29pY2F0ZWQgZW50aXR5IGlzIGR1cGxpY2F0ZWQgb24gdW5pcXVlIGtleXMgZGlmZmVyZW50IGZyb20gdGhlIHBhaXIgb2Yga2V5cyB1c2VkIHRvIHF1ZXJ5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBhc3NvY1F1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5VXBkYXRlLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgbGV0IGN1cnJlbnRLZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgY3VycmVudEtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgICAgICBpZiAoXy5pc05pbChjdXJyZW50S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgLy8gc2hvdWxkIGhhdmUgaW4gdXBkYXRpbmdcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihkYXRhLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTsgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oYXNzb2NSZWNvcmRzVG9SZW1vdmUsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+IGl0ZW1bYXNzb2NNZXRhLmtleV0gIT0gbnVsbCA/XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk6XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUb1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5leGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFNwZWNpZmllZCBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgbm90IGZvdW5kLmAsIHsgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5SWQgPSBjb250ZXh0LmV4aXN0aW5nW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiRXhpc3RpbmcgZW50aXR5IHJlY29yZCBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy90byBjcmVhdGUgdGhlIGFzc29jaWF0ZWQsIGV4aXN0aW5nIGlzIG51bGxcblxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBhc3NPbk9wdGlvbnMuJHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1F1ZXJ5ID0gYXNzb2NNb2RlbC5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5maW5kT25lXyh7ICRxdWVyeTogYXNzb2NRdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJUaGUgYXNzb2ljYXRlZCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGFzc29jUXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdOyAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFthc3NvY01ldGEuZmllbGRdOiBkZXN0RW50aXR5SWQsIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL25vdGhpbmcgdG8gZG8gZm9yIG51bGwgZGVzdCBlbnRpdHkgaWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oeyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgeyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZFwiKTtcblxuICAgICAgICAgICAgLy9yZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGVuZGluZ0Fzc29jcztcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxFbnRpdHlNb2RlbDtcbiJdfQ==
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiY2hhbmdlZFJvd3MiLCJyZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVBY3R1YWxVcGRhdGVkIiwiJHJldHJpZXZlTm90VXBkYXRlIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiJGluY2x1ZGVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcGh5c2ljYWxEZWxldGlvbiIsImV4aXN0aW5nIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJmaW5kT3B0aW9ucyIsIm5vcm1hbEFzc29jcyIsImN1c3RvbUFzc29jcyIsInBhcnRpdGlvbiIsIiRhc3NvY2lhdGlvbiIsImFzc29jIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsInNvcnQiLCJjb25jYXQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsIl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYiIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImJhc2UiLCJzdWJzdHIiLCJsYXN0IiwiYmFzZU5vZGUiLCJzdWJBc3NvY3MiLCJjdXJyZW50RGIiLCJpbmRleE9mIiwic2NoZW1hTmFtZSIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibmVzdGVkS2V5R2V0dGVyIiwibWFwVmFsdWVzIiwiY2hhaW4iLCJtYWluSW5kZXgiLCJzZWxmIiwiY29sIiwidGFibGUiLCJwb3MiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImN1cnJlbnRQYXRoIiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJidWNrZXQiLCJyb3ciLCJ0YWJsZUNhY2hlIiwiY29sSWR4IiwiZm9yT3duIiwib2JqIiwicm93S2V5IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJkYXRhIiwiaXNOZXciLCJhc3NvY3MiLCJyZWZzIiwidiIsImsiLCJhc3NvY01ldGEiLCJhc3NvY0FuY2hvciIsIl9wb3B1bGF0ZVJlZmVyZW5jZXNfIiwicmVmZXJlbmNlcyIsInJlZlF1ZXJ5IiwiUmVmZXJlbmNlZEVudGl0eSIsImNyZWF0ZWQiLCJKU09OIiwic3RyaW5naWZ5IiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInF1ZXJ5IiwicGVuZGluZ0Fzc29jcyIsImZpbmlzaGVkIiwicGFzc09uT3B0aW9ucyIsInBpY2siLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsImFzc29jUXVlcnkiLCJyZWZGaWVsZFZhbHVlIiwibG9jYWxGaWVsZCIsIl91cGRhdGVBc3NvY3NfIiwiYmVmb3JlRW50aXR5VXBkYXRlIiwiZm9yU2luZ2xlUmVjb3JkIiwiY3VycmVudEtleVZhbHVlIiwiYXNzb2NLZXlzIiwicmVjb3JkIiwiYXNzb2NSZWNvcmRzVG9SZW1vdmUiLCJsZW5ndGgiLCIkbm90SW4iLCJkZWxldGVNYW55XyIsImRlc3RFbnRpdHlJZCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxDQUFDLFlBQUQ7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsY0FBTDtBQUFxQkMsRUFBQUEsY0FBckI7QUFBcUNDLEVBQUFBO0FBQXJDLElBQW9ETCxJQUExRDs7QUFDQSxNQUFNTSxXQUFXLEdBQUdMLE9BQU8sQ0FBQyxtQkFBRCxDQUEzQjs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQSx1QkFBcEI7QUFBNkNDLEVBQUFBLGNBQTdDO0FBQTZEQyxFQUFBQSxlQUE3RDtBQUE4RUMsRUFBQUE7QUFBOUUsSUFBa0dWLE9BQU8sQ0FBQyxvQkFBRCxDQUEvRzs7QUFDQSxNQUFNVyxLQUFLLEdBQUdYLE9BQU8sQ0FBQyxhQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVksRUFBQUEsWUFBRjtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBOEJiLE9BQU8sQ0FBQyxrQkFBRCxDQUEzQzs7QUFFQSxNQUFNYyxzQkFBc0IsR0FBSUMsTUFBRCxJQUFhLE1BQU1BLE1BQWxE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PSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZShcIi4uLy4uL0VudGl0eU1vZGVsXCIpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBSZWZlcmVuY2VkTm90RXhpc3RFcnJvciwgRHVwbGljYXRlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuY29uc3QgZGVmYXVsdE5lc3RlZEtleUdldHRlciA9IChhbmNob3IpID0+ICgnOicgKyBhbmNob3IpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiBzdXBlci52YWx1ZU9mS2V5KGVudGl0eSkgfSxcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFtcIiRyZXRyaWV2ZVVwZGF0ZWRcIiwgXCIkYnlwYXNzRW5zdXJlVW5pcXVlXCJdKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3QgPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdCB8fCB7XG4gICAgICAgICAgICAgICAgYWZmZWN0ZWRSb3dzOiAwLFxuICAgICAgICAgICAgICAgIGNoYW5nZWRSb3dzOiAwXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcblxuICAgICAgICBpZiAoIXJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZSAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShvcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSByZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5jb25kaXRpb24sICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAuLi5yZXRyaWV2ZU9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0IHx8IHtcbiAgICAgICAgICAgICAgICBhZmZlY3RlZFJvd3M6IDAsXG4gICAgICAgICAgICAgICAgY2hhbmdlZFJvd3M6IDBcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogb3B0aW9ucy4kcXVlcnksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLFxuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsICAgICAgIFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBvcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgWyBub3JtYWxBc3NvY3MsIGN1c3RvbUFzc29jcyBdID0gXy5wYXJ0aXRpb24oZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uLCBhc3NvYyA9PiB0eXBlb2YgYXNzb2MgPT09ICdzdHJpbmcnKTtcblxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gIF8udW5pcShub3JtYWxBc3NvY3MpLnNvcnQoKS5jb25jYXQoY3VzdG9tQXNzb2NzKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYyk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gXCI6am9pblwiICsgKytjb3VudGVyO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jVGFibGVbYWxpYXNdID0ge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgIG91dHB1dDogYXNzb2Mub3V0cHV0LFxuICAgICAgICAgICAgICAgICAgICBrZXk6IGFzc29jLmtleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMsXG4gICAgICAgICAgICAgICAgICAgIG9uOiBhc3NvYy5vbixcbiAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmRhdGFzZXRcbiAgICAgICAgICAgICAgICAgICAgICAgID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoXCIuXCIpO1xuICAgICAgICBsZXQgcmVzdWx0O1xuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkge1xuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcyArIDEpO1xuXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyBcIi5cIiArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoXCIuXCIpID4gMCkge1xuICAgICAgICAgICAgbGV0IFtzY2hlbWFOYW1lLCBlbnRpdHlOYW1lXSA9IGFzc29jLmVudGl0eS5zcGxpdChcIi5cIiwgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGFzc29jLmVudGl0eTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICBhc3NvYy5rZXkgPSBhc3NvYy5tb2RlbC5tZXRhLmtleUZpZWxkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHksIG5lc3RlZEtleUdldHRlcikge1xuICAgICAgICBuZXN0ZWRLZXlHZXR0ZXIgPT0gbnVsbCAmJiAobmVzdGVkS2V5R2V0dGVyID0gZGVmYXVsdE5lc3RlZEtleUdldHRlcik7ICAgICAgICBcbiAgICAgICAgYWxpYXNNYXAgPSBfLm1hcFZhbHVlcyhhbGlhc01hcCwgY2hhaW4gPT4gY2hhaW4ubWFwKGFuY2hvciA9PiBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKSkpO1xuXG4gICAgICAgIGxldCBtYWluSW5kZXggPSB7fTtcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGNvbHVtbnMgPSBjb2x1bW5zLm1hcChjb2wgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvcyA9IGNvbC5uYW1lLmluZGV4T2YoJyQnKTtcbiAgICAgICAgICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGU6IGNvbC5uYW1lLnN1YnN0cigwLCBwb3MpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUuc3Vic3RyKHBvcysxKVxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICB0YWJsZTogJ0EnLFxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgdGFibGU6IGNvbC50YWJsZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IG5lc3RlZEtleUdldHRlcihhbmNob3IpO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXSA9IHN1YkluZGV4O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IG5lc3RlZEtleUdldHRlcihhbmNob3IpO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSByb3dPYmplY3Rbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0LFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZCAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0gc3ViT2JqZWN0W2tleV0gPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleCxcbiAgICAgICAgICAgICAgICAgICAgfSA6IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdOyAgICAgICAgXG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gcmVzdWx0W2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLnRhYmxlXSA9IHsgW2NvbC5uYW1lXTogbnVsbCB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdykgPT4ge1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0gcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgY29sSWR4KSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbY29sSWR4XTtcblxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlICE9IG51bGwpIHsgLy8gYXZvaWQgYSBvYmplY3Qgd2l0aCBhbGwgbnVsbCB2YWx1ZSBleGlzdHNcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGVcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHsgLi4udGFibGVUZW1wbGF0ZVtjb2wudGFibGVdLCBbY29sLm5hbWVdOiB2YWx1ZSB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5mb3JPd24odGFibGVDYWNoZSwgKG9iaiwgdGFibGUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFt0YWJsZV07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9LFxuICAgICAgICAgICAgcmVmcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09IFwiOlwiKSB7XG4gICAgICAgICAgICAgICAgLy9jYXNjYWRlIHVwZGF0ZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgKGFzc29jTWV0YS50eXBlID09PSBcInJlZmVyc1RvXCIgfHwgYXNzb2NNZXRhLnR5cGUgPT09IFwiYmVsb25nc1RvXCIpICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gZGF0YSBcIjoke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa1swXSA9PT0gXCJAXCIpIHtcbiAgICAgICAgICAgICAgICAvL3VwZGF0ZSBieSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gdHlwZSBcIiR7YXNzb2NNZXRhLnR5cGV9XCIgY2Fubm90IGJlIHVzZWQgZm9yIHVwZGF0ZSBieSByZWZlcmVuY2UuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NBbmNob3IgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NBbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGFzc29jaWF0aW9uIGRhdGEgXCIke2Fzc29jQW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodiA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhd1thbmNob3JdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWZzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3MsIHJlZnNdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18ocmVmZXJlbmNlcywgYXN5bmMgKHJlZlF1ZXJ5LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGNvbnN0IFJlZmVyZW5jZWRFbnRpdHkgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6ICFhc3NvY01ldGEubGlzdDtcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBSZWZlcmVuY2VkRW50aXR5LmZpbmRPbmVfKHJlZlF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKGBSZWZlcmVuY2VkIGVudGl0eSBcIiR7UmVmZXJlbmNlZEVudGl0eS5tZXRhLm5hbWV9XCIgd2l0aCAke0pTT04uc3RyaW5naWZ5KHJlZlF1ZXJ5KX0gbm90IGV4aXN0LmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBxdWVyeSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIlRoZSBwYXJlbnQgZW50aXR5IGlzIGR1cGxpY2F0ZWQgb24gdW5pcXVlIGtleXMgZGlmZmVyZW50IGZyb20gdGhlIHBhaXIgb2Yga2V5cyB1c2VkIHRvIHF1ZXJ5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhOiBjb250ZXh0LmxhdGVzdFxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5yZXR1cm4sXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jc1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG4gICAgICAgIGNvbnN0IGZpbmlzaGVkID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBwYXNzT25PcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0ID0gdHJ1ZTtcbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKHBhc3NPbk9wdGlvbnMuJHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1F1ZXJ5ID0gYXNzb2NNb2RlbC5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKTtcbiAgICAgICAgICAgICAgICBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5maW5kT25lXyh7ICRxdWVyeTogYXNzb2NRdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJUaGUgYXNzb2ljYXRlZCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGFzc29jUXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmaW5pc2hlZFthbmNob3JdID0gYmVmb3JlRW50aXR5Q3JlYXRlID8gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdIDogY3JlYXRlZFthc3NvY01ldGEua2V5XTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZmluaXNoZWQsIChyZWZGaWVsZFZhbHVlLCBsb2NhbEZpZWxkKSA9PiB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdbbG9jYWxGaWVsZF0gPSByZWZGaWVsZFZhbHVlO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcGVuZGluZ0Fzc29jcztcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQgY3VycmVudEtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICBjdXJyZW50S2V5VmFsdWUgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmV0dXJuXSwgdGhpcy5tZXRhLmtleUZpZWxkKTtcbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGN1cnJlbnRLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkc2tpcE1vZGlmaWVyc1wiLCBcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NLZXlzID0gbWFwRmlsdGVyKGRhdGEsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0gIT0gbnVsbCwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUmVjb3Jkc1RvUmVtb3ZlID0geyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc29jUmVjb3Jkc1RvUmVtb3ZlW2Fzc29jTWV0YS5rZXldID0geyAkbm90SW46IGFzc29jS2V5cyB9OyAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyhhc3NvY1JlY29yZHNUb1JlbW92ZSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT4gaXRlbVthc3NvY01ldGEua2V5XSAhPSBudWxsID9cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5fLm9taXQoaXRlbSwgW2Fzc29jTWV0YS5rZXldKSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAkcXVlcnk6IHsgW2Fzc29jTWV0YS5rZXldOiBpdGVtW2Fzc29jTWV0YS5rZXldIH0sIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTpcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwgeyBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBlbnRpdHkgcmVjb3JkIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3RvIGNyZWF0ZSB0aGUgYXNzb2NpYXRlZCwgZXhpc3RpbmcgaXMgbnVsbFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocGFzc09uT3B0aW9ucy4kcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUXVlcnkgPSBhc3NvY01vZGVsLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmZpbmRPbmVfKHsgJHF1ZXJ5OiBhc3NvY1F1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIlRoZSBhc3NvaWNhdGVkIGVudGl0eSBpcyBkdXBsaWNhdGVkIG9uIHVuaXF1ZSBrZXlzIGRpZmZlcmVudCBmcm9tIHRoZSBwYWlyIG9mIGtleXMgdXNlZCB0byBxdWVyeVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogYXNzb2NRdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
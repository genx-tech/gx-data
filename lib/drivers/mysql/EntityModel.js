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
              latest: context.latest
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

      let created = await assocModel.create_(data, passOnOptions, context.connOptions);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwicmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlQWN0dWFsVXBkYXRlZCIsIiRyZXRyaWV2ZU5vdFVwZGF0ZSIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiJHBoeXNpY2FsRGVsZXRpb24iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJhbGlhcyIsImpvaW5UeXBlIiwib3V0cHV0Iiwia2V5Iiwib24iLCJkYXRhc2V0IiwiYnVpbGRRdWVyeSIsIm1vZGVsIiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsInNjaGVtYU5hbWUiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm5lc3RlZEtleUdldHRlciIsIm1hcFZhbHVlcyIsImNoYWluIiwibWFpbkluZGV4Iiwic2VsZiIsImNvbCIsInRhYmxlIiwicG9zIiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsIm5vZGVQYXRoIiwiZWFjaCIsInNxbCIsImxpc3QiLCJjdXJyZW50UGF0aCIsImNvbmNhdCIsInB1c2giLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5VmFsdWUiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJ0YWJsZVRlbXBsYXRlIiwicmVkdWNlIiwicm93IiwiaSIsInRhYmxlQ2FjaGUiLCJidWNrZXQiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwicmVmRmllbGRWYWx1ZSIsImxvY2FsRmllbGQiLCJfdXBkYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eVVwZGF0ZSIsImZvclNpbmdsZVJlY29yZCIsImN1cnJlbnRLZXlWYWx1ZSIsImFzc29jS2V5cyIsInJlY29yZCIsImFzc29jUmVjb3Jkc1RvUmVtb3ZlIiwibGVuZ3RoIiwiJG5vdEluIiwiZGVsZXRlTWFueV8iLCJkZXN0RW50aXR5SWQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTU0sV0FBVyxHQUFHTCxPQUFPLENBQUMsbUJBQUQsQ0FBM0I7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUEsdUJBQXBCO0FBQTZDQyxFQUFBQSxjQUE3QztBQUE2REMsRUFBQUEsZUFBN0Q7QUFBOEVDLEVBQUFBO0FBQTlFLElBQWtHVixPQUFPLENBQUMsb0JBQUQsQ0FBL0c7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVZLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCYixPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTWMsc0JBQXNCLEdBQUlDLE1BQUQsSUFBYSxNQUFNQSxNQUFsRDs7QUFLQSxNQUFNQyxnQkFBTixTQUErQlgsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1ksZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMs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O0FBRUQsWUFBTW9KLFVBQVUsQ0FBQ2MsV0FBWCxDQUF1QjtBQUFFLFNBQUMvQixTQUFTLENBQUM1SyxLQUFYLEdBQW1CcU07QUFBckIsT0FBdkIsRUFBK0RsSyxPQUFPLENBQUNNLFdBQXZFLENBQU47O0FBRUEsVUFBSTJKLGVBQUosRUFBcUI7QUFDakIsZUFBT1AsVUFBVSxDQUFDbEssT0FBWCxDQUNILEVBQUUsR0FBRzJJLElBQUw7QUFBVyxXQUFDTSxTQUFTLENBQUM1SyxLQUFYLEdBQW1CcU07QUFBOUIsU0FERyxFQUVIVixhQUZHLEVBR0h4SixPQUFPLENBQUNNLFdBSEwsQ0FBUDtBQUtIOztBQUVELFlBQU0sSUFBSTNCLEtBQUosQ0FBVSw2REFBVixDQUFOO0FBR0gsS0F0SGUsQ0FBaEI7QUF3SEEsV0FBTzJLLGFBQVA7QUFDSDs7QUE5L0JzQzs7QUFpZ0MzQ29CLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBOLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi1cInVzZSBzdHJpY3RcIjtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIFJlZmVyZW5jZWROb3RFeGlzdEVycm9yLCBEdXBsaWNhdGVFcnJvciwgVmFsaWRhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9FcnJvcnNcIik7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoXCIuLi8uLi90eXBlc1wiKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tLCBtYXBGaWx0ZXIgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9sYW5nXCIpO1xuXG5jb25zdCBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyID0gKGFuY2hvcikgPT4gKCc6JyArIGFuY2hvcik7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICogQHBhcmFtIHsqfSBpbmZvXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImFycmF5XCIgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdCA9IHsgLi4uY29udGV4dC5yZXR1cm4sIC4uLmNvbnRleHQucXVlcnlLZXkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcblxuICAgICAgICBpZiAoIXJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZSAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShvcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSByZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5jb25kaXRpb24sICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAuLi5yZXRyaWV2ZU9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAkcXVlcnk6IG9wdGlvbnMuJHF1ZXJ5LCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCxcbiAgICAgICAgICAgICAgICAgICAgLi4ucmV0cmlldmVPcHRpb25zLCAgICAgICBcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gb3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IHsgLi4uY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9XG4gICAgICAgICAgICAgICAgOiB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRpbmNsdWRlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7XG4gICAgICAgIGxldCBhc3NvY2lhdGlvbnMgPSBfLnVuaXEoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKS5zb3J0KCk7XG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sXG4gICAgICAgICAgICBjb3VudGVyID0gMCxcbiAgICAgICAgICAgIGNhY2hlID0ge307XG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goKGFzc29jKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IFwiOmpvaW5cIiArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0XG4gICAgICAgICAgICAgICAgICAgICAgICA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgICAgICAgbGV0IHJlc3VsdDtcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MgKyAxKTtcblxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgXCIuXCIgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgZW50aXR5TmFtZV0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoXCIuXCIsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5LCBuZXN0ZWRLZXlHZXR0ZXIpIHtcbiAgICAgICAgbmVzdGVkS2V5R2V0dGVyID09IG51bGwgJiYgKG5lc3RlZEtleUdldHRlciA9IGRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIpOyAgICAgICAgXG4gICAgICAgIGFsaWFzTWFwID0gXy5tYXBWYWx1ZXMoYWxpYXNNYXAsIGNoYWluID0+IGNoYWluLm1hcChhbmNob3IgPT4gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcikpKTtcblxuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICBjb2x1bW5zID0gY29sdW1ucy5tYXAoY29sID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb3MgPSBjb2wubmFtZS5pbmRleE9mKCckJyk7XG4gICAgICAgICAgICAgICAgaWYgKHBvcyA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wubmFtZS5zdWJzdHIoMCwgcG9zKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lLnN1YnN0cihwb3MrMSlcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgdGFibGU6ICdBJyxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHRhYmxlOiBjb2wudGFibGUsXG4gICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHtcbiAgICAgICAgICAgIHJldHVybiBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleGVzID0gZXhpc3RpbmdSb3cuc3ViSW5kZXhlc1tvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXlWYWx1ZSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAobGlzdCAmJiByb3dLZXlWYWx1ZSA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBzaG91bGQgYmUgYSBsaXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaixcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBkb2VzIG5vdCBleGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBuZXN0ZWRLZXlHZXR0ZXIoYW5jaG9yKTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL3doZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZCAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gLyplbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvL3Jvd09iamVjdFtvYmpLZXldID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHN1Yk9iamVjdFtrZXldID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXgsXG4gICAgICAgICAgICAgICAgICAgIH0gOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHRhYmxlVGVtcGxhdGUgPSBjb2x1bW5zLnJlZHVjZSgocmVzdWx0LCBjb2wpID0+IHtcbiAgICAgICAgICAgIGlmIChjb2wudGFibGUgIT09ICdBJykge1xuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJlc3VsdCwgW2NvbC50YWJsZSwgY29sLm5hbWVdLCBudWxsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcblxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlICE9IG51bGwpIHsgLy8gYXZvaWQgYSBvYmplY3Qgd2l0aCBhbGwgbnVsbCB2YWx1ZSBleGlzdHNcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGVcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHsgLi4udGFibGVUZW1wbGF0ZVtjb2wudGFibGVdLCBbY29sLm5hbWVdOiB2YWx1ZSB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpO1xuXG4gICAgICAgICAgICBfLmZvck93bih0YWJsZUNhY2hlLCAob2JqLCB0YWJsZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW3RhYmxlXTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocm93T2JqZWN0LCBub2RlUGF0aCwgb2JqKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgcm93S2V5ID0gcm93T2JqZWN0W3NlbGYubWV0YS5rZXlGaWVsZF07XG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdSb3cgPSBtYWluSW5kZXhbcm93S2V5XTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdykge1xuICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgIHJvd09iamVjdCxcbiAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpLFxuICAgICAgICAgICAgfTsgIFxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXJyYXlPZk9ianM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEsIGlzTmV3KSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LFxuICAgICAgICAgICAgYXNzb2NzID0ge30sXG4gICAgICAgICAgICByZWZzID0ge307XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gXCI6XCIpIHtcbiAgICAgICAgICAgICAgICAvL2Nhc2NhZGUgdXBkYXRlXG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChrWzBdID09PSBcIkBcIikge1xuICAgICAgICAgICAgICAgIC8vdXBkYXRlIGJ5IHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBBc3NvY2lhdGlvbiB0eXBlIFwiJHthc3NvY01ldGEudHlwZX1cIiBjYW5ub3QgYmUgdXNlZCBmb3IgdXBkYXRlIGJ5IHJlZmVyZW5jZS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiByZWZlcmVuY2UgXCJAJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0FuY2hvciA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0FuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggYXNzb2NpYXRpb24gZGF0YSBcIiR7YXNzb2NBbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh2ID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3W2FuY2hvcl0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlZnNbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmF3W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFtyYXcsIGFzc29jcywgcmVmc107XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9wb3B1bGF0ZVJlZmVyZW5jZXNfKGNvbnRleHQsIHJlZmVyZW5jZXMpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhyZWZlcmVuY2VzLCBhc3luYyAocmVmUXVlcnksIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgY29uc3QgUmVmZXJlbmNlZEVudGl0eSA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGFzc2VydDogIWFzc29jTWV0YS5saXN0O1xuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IFJlZmVyZW5jZWRFbnRpdHkuZmluZE9uZV8ocmVmUXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoYFJlZmVyZW5jZWQgZW50aXR5IFwiJHtSZWZlcmVuY2VkRW50aXR5Lm1ldGEubmFtZX1cIiB3aXRoICR7SlNPTi5zdHJpbmdpZnkocmVmUXVlcnkpfSBub3QgZXhpc3QuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmF3W2FuY2hvcl0gPSBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiVGhlIHBhcmVudCBlbnRpdHkgaXMgZHVwbGljYXRlZCBvbiB1bmlxdWUga2V5cyBkaWZmZXJlbnQgZnJvbSB0aGUgcGFpciBvZiBrZXlzIHVzZWQgdG8gcXVlcnlcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdDogY29udGV4dC5sYXRlc3RcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IGNvbnRleHQucmV0dXJuLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBhc3NvY3NcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBmaW5pc2hlZCA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBfLmZvck93bihmaW5pc2hlZCwgKHJlZkZpZWxkVmFsdWUsIGxvY2FsRmllbGQpID0+IHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd1tsb2NhbEZpZWxkXSA9IHJlZkZpZWxkVmFsdWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRza2lwTW9kaWZpZXJzXCIsIFwiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY0tleXMgPSBtYXBGaWx0ZXIoZGF0YSwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSAhPSBudWxsLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NSZWNvcmRzVG9SZW1vdmUgPSB7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NSZWNvcmRzVG9SZW1vdmVbYXNzb2NNZXRhLmtleV0gPSB7ICRub3RJbjogYXNzb2NLZXlzIH07ICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKGFzc29jUmVjb3Jkc1RvUmVtb3ZlLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PiBpdGVtW2Fzc29jTWV0YS5rZXldICE9IG51bGwgP1xuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLl8ub21pdChpdGVtLCBbYXNzb2NNZXRhLmtleV0pLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7ICRxdWVyeTogeyBbYXNzb2NNZXRhLmtleV06IGl0ZW1bYXNzb2NNZXRhLmtleV0gfSwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApOlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICB7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShkYXRhKSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG9cbiAgICAgICAgICAgICAgICBsZXQgZGVzdEVudGl0eUlkID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0LmV4aXN0aW5nLCBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJhd10sIGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiRXhpc3RpbmcgZG9lcyBub3QgY29udGFpbiB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgaWQuXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZzogY29udGV4dC5leGlzdGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogY29udGV4dC5yYXcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFNwZWNpZmllZCBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgbm90IGZvdW5kLmAsIHsgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCAmJiAhKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
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

const {
  DateTime
} = require("luxon");

const EntityModel = require("../../EntityModel");

const {
  ApplicationError,
  DatabaseError,
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

  static _serialize(value) {
    if (typeof value === "boolean") return value ? 1 : 0;

    if (value instanceof DateTime) {
      return value.toISO({
        includeOffset: false
      });
    }

    return value;
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
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? context.options.$retrieveDeleted : {};
      context.return = context.existing = await this.findOne_({ ...retrieveOptions,
        $query: context.options.$query
      }, context.connOptions);
    }

    return true;
  }

  static async _internalBeforeDeleteMany_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? context.options.$retrieveDeleted : {};
      context.return = context.existing = await this.findAll_({ ...retrieveOptions,
        $query: context.options.$query
      }, context.connOptions);
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
        assoc = this._translateSchemaNameToDb(assoc, this.db.schemaName);
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

  static _mapRecordsToObjects([rows, columns, aliasMap], hierarchy) {
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
        let objKey = ":" + anchor;
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

        let objKey = ":" + anchor;
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
          assocs = {};
    const meta = this.meta.associations;

    _.forOwn(data, (v, k) => {
      if (k.startsWith(":")) {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if (isNew && (assocMeta.type === "refersTo" || assocMeta.type === "belongsTo") && anchor in data) {
          throw new ValidationError(`Association data ":${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`);
        }

        assocs[anchor] = v;
      } else {
        raw[k] = v;
      }
    });

    return [raw, assocs];
  }

  static async _createAssocs_(context, assocs, beforeEntityCreate) {
    const meta = this.meta.associations;
    let keyValue;

    if (!beforeEntityCreate) {
      keyValue = context.return[this.meta.keyField];

      if (_.isNil(keyValue)) {
        throw new ApplicationError("Missing required primary key field value. Entity: " + this.meta.name);
      }
    }

    const pendingAssocs = {};
    const finished = {};

    const passOnOptions = _.pick(context.options, ["$migration", "$variables"]);

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
    return [finished, pendingAssocs];
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

    const passOnOptions = _.pick(context.options, ["$migration", "$variables"]);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiTXlTUUxFbnRpdHlNb2RlbCIsImhhc0F1dG9JbmNyZW1lbnQiLCJhdXRvSWQiLCJtZXRhIiwiZmVhdHVyZXMiLCJmaWVsZHMiLCJmaWVsZCIsImF1dG9JbmNyZW1lbnRJZCIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJzcGxpdCIsIm1hcCIsInAiLCJqb2luIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwibmFtZSIsImRiIiwiY29ubmVjdG9yIiwicmF3IiwiRXJyb3IiLCJfc2VyaWFsaXplIiwidmFsdWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwicmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlQWN0dWFsVXBkYXRlZCIsIiRyZXRyaWV2ZU5vdFVwZGF0ZSIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImJhc2UiLCJzdWJzdHIiLCJsYXN0IiwiYmFzZU5vZGUiLCJzdWJBc3NvY3MiLCJjdXJyZW50RGIiLCJpbmRleE9mIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJtYWluSW5kZXgiLCJzZWxmIiwiY29sIiwidGFibGUiLCJwb3MiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImFuY2hvciIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsImJ1Y2tldCIsImZvck93biIsIm9iaiIsInJvd0tleSIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImlzTmV3IiwiYXNzb2NzIiwidiIsImsiLCJzdGFydHNXaXRoIiwiYXNzb2NNZXRhIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsInBhc3NPbk9wdGlvbnMiLCJwaWNrIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJjcmVhdGVkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwicXVlcnkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLGFBQXBCO0FBQW1DQyxFQUFBQSx1QkFBbkM7QUFBNERDLEVBQUFBLGNBQTVEO0FBQTRFQyxFQUFBQSxlQUE1RTtBQUE2RkMsRUFBQUE7QUFBN0YsSUFBaUhaLE9BQU8sQ0FBQyxvQkFBRCxDQUE5SDs7QUFDQSxNQUFNYSxLQUFLLEdBQUdiLE9BQU8sQ0FBQyxhQUFELENBQXJCOztBQUNBLE1BQU07QUFBRWMsRUFBQUEsWUFBRjtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBOEJmLE9BQU8sQ0FBQyxrQkFBRCxDQUEzQzs7QUFLQSxNQUFNZ0IsZ0JBQU4sU0FBK0JWLFdBQS9CLENBQTJDO0FBSXZDLGFBQVdXLGdCQUFYLEdBQThCO0FBQzFCLFFBQUlDLE1BQU0sR0FBRyxLQUFLQyxJQUFMLENBQVVDLFFBQVYsQ0FBbUJGLE1BQWhDO0FBQ0EsV0FBT0EsTUFBTSxJQUFJLEtBQUtDLElBQUwsQ0FBVUUsTUFBVixDQUFpQkgsTUFBTSxDQUFDSSxLQUF4QixF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QVgsR0FBbUIyTDtBQUE5QixTQURHLEVBRUhULGFBRkcsRUFHSDVJLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBRUQsWUFBTSxJQUFJOUIsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQXRIZSxDQUFoQjtBQXdIQSxXQUFPa0ssYUFBUDtBQUNIOztBQWo3QnNDOztBQW83QjNDb0IsTUFBTSxDQUFDQyxPQUFQLEdBQWlCM00sZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLVwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKFwibHV4b25cIik7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoXCIuLi8uLi9FbnRpdHlNb2RlbFwiKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciwgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IsIER1cGxpY2F0ZUVycm9yLCBWYWxpZGF0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL0Vycm9yc1wiKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZShcIi4uLy4uL3R5cGVzXCIpO1xuY29uc3QgeyBnZXRWYWx1ZUZyb20sIG1hcEZpbHRlciB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL2xhbmdcIik7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJib29sZWFuXCIpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiBzdXBlci52YWx1ZU9mS2V5KGVudGl0eSkgfSxcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFtcIiRyZXRyaWV2ZVVwZGF0ZWRcIiwgXCIkYnlwYXNzRW5zdXJlVW5pcXVlXCJdKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3QgPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgICAgIC4uLnJldHJpZXZlT3B0aW9ucywgICAgICAgXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IG9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBmaW5kT3B0aW9uc1xuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykge1xuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpO1xuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LFxuICAgICAgICAgICAgY291bnRlciA9IDAsXG4gICAgICAgICAgICBjYWNoZSA9IHt9O1xuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IFwiOmpvaW5cIiArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0XG4gICAgICAgICAgICAgICAgICAgICAgICA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgICAgICAgbGV0IHJlc3VsdDtcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MgKyAxKTtcblxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgXCIuXCIgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgZW50aXR5TmFtZV0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoXCIuXCIsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5KSB7XG4gICAgICAgIGxldCBtYWluSW5kZXggPSB7fTtcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGNvbHVtbnMgPSBjb2x1bW5zLm1hcChjb2wgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvcyA9IGNvbC5uYW1lLmluZGV4T2YoJyQnKTtcbiAgICAgICAgICAgICAgICBpZiAocG9zID4gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGU6IGNvbC5uYW1lLnN1YnN0cigwLCBwb3MpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY29sLm5hbWUuc3Vic3RyKHBvcysxKVxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICB0YWJsZTogJ0EnLFxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgdGFibGU6IGNvbC50YWJsZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXNzb2NpYXRlZCBlbnRpdHkgbm90IGluIHJlc3VsdCBzZXQsIHByb2JhYmx5IHdoZW4gY3VzdG9tIHByb2plY3Rpb24gaXMgdXNlZFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG5cbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleVZhbHVlID0gc3ViT2JqW2tleV07XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwocm93S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChsaXN0ICYmIHJvd0tleVZhbHVlID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXSA9IHN1YkluZGV4O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSByb3dPYmplY3Rbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0LFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9iamVjdF07XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICpcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSAvKmVsc2UgaWYgKHN1Yk9iamVjdCAmJiBfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0gc3ViT2JqZWN0W2tleV0gPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleCxcbiAgICAgICAgICAgICAgICAgICAgfSA6IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgdGFibGVUZW1wbGF0ZSA9IGNvbHVtbnMucmVkdWNlKChyZXN1bHQsIGNvbCkgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbC50YWJsZSAhPT0gJ0EnKSB7XG4gICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocmVzdWx0LCBbY29sLnRhYmxlLCBjb2wubmFtZV0sIG51bGwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJBXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUgIT0gbnVsbCkgeyAvLyBhdm9pZCBhIG9iamVjdCB3aXRoIGFsbCBudWxsIHZhbHVlIGV4aXN0c1xuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZVxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVDYWNoZVtjb2wudGFibGVdID0geyAuLi50YWJsZVRlbXBsYXRlW2NvbC50YWJsZV0sIFtjb2wubmFtZV06IHZhbHVlIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7XG5cbiAgICAgICAgICAgIF8uZm9yT3duKHRhYmxlQ2FjaGUsIChvYmosIHRhYmxlKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbdGFibGVdOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyb3dPYmplY3QsIG5vZGVQYXRoLCBvYmopO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGhpZXJhcmNoeSwgW10pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7XG4gICAgICAgICAgICAgICAgcm93T2JqZWN0LFxuICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSksXG4gICAgICAgICAgICB9OyAgXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgaXNOZXcpIHtcbiAgICAgICAgY29uc3QgcmF3ID0ge30sXG4gICAgICAgICAgICBhc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW3JhdywgYXNzb2NzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG4gICAgICAgIGNvbnN0IGZpbmlzaGVkID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW2ZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQgY3VycmVudEtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICBjdXJyZW50S2V5VmFsdWUgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmV0dXJuXSwgdGhpcy5tZXRhLmtleUZpZWxkKTtcbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGN1cnJlbnRLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihkYXRhLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTsgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oYXNzb2NSZWNvcmRzVG9SZW1vdmUsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+IGl0ZW1bYXNzb2NNZXRhLmtleV0gIT0gbnVsbCA/XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk6XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUb1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5leGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwgeyBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5SWQgPSBjb250ZXh0LmV4aXN0aW5nW2FuY2hvcl07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsICYmICEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnlcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkLCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9ub3RoaW5nIHRvIGRvIGZvciBudWxsIGRlc3QgZW50aXR5IGlkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidXBkYXRlIGFzc29jaWF0ZWQgZGF0YSBmb3IgbXVsdGlwbGUgcmVjb3JkcyBub3QgaW1wbGVtZW50ZWRcIik7XG5cbiAgICAgICAgICAgIC8vcmV0dXJuIGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5kYXRhLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7XG4iXX0=
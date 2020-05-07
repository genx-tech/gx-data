"use strict";

require("source-map-support/register");

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
  ValidationError,
  InvalidArgument
} = require("../../utils/Errors");

const Types = require("../../types");

const {
  getValueFrom
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
        throw new DatabaseError("The new entity is referencing to an unexisting entity. Detail: " + error.message);
      } else if (errorCode === "ER_DUP_ENTRY") {
        throw new DatabaseError(error.message + ` while creating a new "${this.meta.name}".`);
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
        throw new DatabaseError("The entity to be updated is referencing to an unexisting entity. Detail: " + error.message);
      } else if (errorCode === "ER_DUP_ENTRY") {
        throw new DatabaseError(error.message + ` while updating an existing "${this.meta.name}".`);
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

        context.return = { ...context.return,
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
        ...retrieveOptions,
        $includeDeleted: options.$retrieveDeleted
      }, context.connOptions);

      if (context.return) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.return);
      } else {
        context.queryKey = condition.$query;
      }
    }
  }

  static async _internalAfterUpdateMany_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (context.options.$retrieveUpdated) {
      let retrieveOptions = {};

      if (_.isPlainObject(context.options.$retrieveUpdated)) {
        retrieveOptions = context.options.$retrieveUpdated;
      } else if (context.options.$relationships) {
        retrieveOptions.$relationships = context.options.$relationships;
      }

      context.return = await this.findAll_({ ...retrieveOptions,
        $query: context.options.$query,
        $includeDeleted: context.options.$retrieveDeleted
      }, context.connOptions);
    }

    context.queryKey = context.options.$query;
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

    function mergeRecord(existingRow, rowObject, associations, nodePath) {
      _.each(associations, ({
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
        let rowKey = subObj[key];
        if (_.isNil(rowKey)) return;
        let existingSubRow = subIndexes && subIndexes[rowKey];

        if (existingSubRow) {
          if (subAssocs) {
            mergeRecord(existingSubRow, subObj, subAssocs, currentPath);
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

          subIndexes[rowKey] = subIndex;
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

          if (_.isNil(subObject[key])) {
            rowObject[objKey] = [];
            subObject = null;
          } else {
            rowObject[objKey] = [subObject];
          }
        } else if (subObject && _.isNil(subObject[key])) {
          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
          }

          return;
        }

        if (subObject) {
          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
          }

          indexes[objKey] = {
            [subObject[key]]: subIndex
          };
        }
      });

      return indexes;
    }

    let arrayOfObjs = [];
    rows.forEach((row, i) => {
      let rowObject = {};
      let tableCache = {};
      row.reduce((result, value, i) => {
        let col = columns[i];

        if (col.table === "A") {
          result[col.name] = value;
        } else {
          let bucket = tableCache[col.table];

          if (bucket) {
            bucket[col.name] = value;
          } else {
            let nodePath = aliasMap[col.table];

            if (nodePath) {
              let subObject = {
                [col.name]: value
              };
              tableCache[col.table] = subObject;
              setValueByPath(result, nodePath, subObject);
            }
          }
        }

        return result;
      }, rowObject);
      let rowKey = rowObject[self.meta.keyField];
      let existingRow = mainIndex[rowKey];

      if (existingRow) {
        mergeRecord(existingRow, rowObject, hierarchy, []);
      } else {
        arrayOfObjs.push(rowObject);
        mainIndex[rowKey] = {
          rowObject,
          subIndexes: buildSubIndexes(rowObject, hierarchy)
        };
      }
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

        await assocModel.deleteMany_({
          [assocMeta.field]: currentKeyValue
        }, context.connOptions);
        return eachAsync_(data, item => assocModel.create_({ ...item,
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwicXVlcnlLZXkiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImxhdGVzdCIsImlzRW1wdHkiLCJpbnNlcnRJZCIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJyZXR1cm4iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJyZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVBY3R1YWxVcGRhdGVkIiwiJHJldHJpZXZlTm90VXBkYXRlIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiJGluY2x1ZGVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJzY2hlbWFOYW1lIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm1haW5JbmRleCIsInNlbGYiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImFuY2hvciIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXkiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsInJlZHVjZSIsImNvbCIsInRhYmxlIiwiYnVja2V0IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJkYXRhIiwiaXNOZXciLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJhc3NvY01ldGEiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicGVuZGluZ0Fzc29jcyIsImZpbmlzaGVkIiwicGFzc09uT3B0aW9ucyIsInBpY2siLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsImNyZWF0ZWQiLCJfdXBkYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eVVwZGF0ZSIsImZvclNpbmdsZVJlY29yZCIsImN1cnJlbnRLZXlWYWx1ZSIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwicXVlcnkiLCJtb2R1bGUiLCJl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SUFGOEU7QUFHOUUvRSxjQUFBQSxRQUFRLEVBQUU1QyxPQUFPLENBQUM0QyxRQUg0RDtBQUk5RXdHLGNBQUFBLEtBQUssRUFBRXBKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFKdUQsYUFBNUUsQ0FBTjtBQU1IO0FBQ0o7O0FBRUQsWUFBSStJLFlBQUosRUFBa0I7QUFDZCxpQkFBT1QsVUFBVSxDQUFDNUksVUFBWCxDQUNINkgsSUFERyxFQUVIO0FBQUUsYUFBQ08sU0FBUyxDQUFDeEssS0FBWCxHQUFtQnlMLFlBQXJCO0FBQW1DLGVBQUdYO0FBQXRDLFdBRkcsRUFHSHhJLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBR0Q7QUFDSDs7QUFFRCxZQUFNb0ksVUFBVSxDQUFDUSxXQUFYLENBQXVCO0FBQUUsU0FBQ2hCLFNBQVMsQ0FBQ3hLLEtBQVgsR0FBbUJ1TDtBQUFyQixPQUF2QixFQUErRGpKLE9BQU8sQ0FBQ00sV0FBdkUsQ0FBTjs7QUFFQSxVQUFJMEksZUFBSixFQUFxQjtBQUNqQixlQUFPTixVQUFVLENBQUNsSixPQUFYLENBQ0gsRUFBRSxHQUFHbUksSUFBTDtBQUFXLFdBQUNPLFNBQVMsQ0FBQ3hLLEtBQVgsR0FBbUJ1TDtBQUE5QixTQURHLEVBRUhULGFBRkcsRUFHSHhJLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBRUQsWUFBTSxJQUFJOUIsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQXhHZSxDQUFoQjtBQTBHQSxXQUFPOEosYUFBUDtBQUNIOztBQXQzQnNDOztBQXkzQjNDZSxNQUFNLENBQUNDLE9BQVAsR0FBaUJsTSxnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgeyBEYXRlVGltZSB9ID0gcmVxdWlyZShcImx1eG9uXCIpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL2xhbmdcIik7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwge1xuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9ialxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChcbiAgICAgICAgICAgIGVudGl0eU9iaixcbiAgICAgICAgICAgIGtleVBhdGhcbiAgICAgICAgICAgICAgICAuc3BsaXQoXCIuXCIpXG4gICAgICAgICAgICAgICAgLm1hcCgocCkgPT4gXCI6XCIgKyBwKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiLlwiKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW5cbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09IFwiTk9XXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoXCJOT1coKVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0OiBcIiArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJib29sZWFuXCIpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKFxuICAgICAgICAgICAgICAgICAgICBcIlRoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2VcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiBzdXBlci52YWx1ZU9mS2V5KGVudGl0eSkgfSxcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFtcIiRyZXRyaWV2ZVVwZGF0ZWRcIiwgXCIkYnlwYXNzRW5zdXJlVW5pcXVlXCJdKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuXG4gICAgICAgIGlmICghcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKG9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLmNvbmRpdGlvbiwgLi4ucmV0cmlldmVPcHRpb25zLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZFxuICAgICAgICAgICAgICAgIDoge307XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAgeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgdGhpcy5kYi5zY2hlbWFOYW1lKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSkge1xuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307XG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG5cbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIHNob3VsZCBiZSBhIGxpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqLFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oXCIuXCIpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVwiIGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9zdWJPYmplY3Qgbm90IGV4aXN0LCBqdXN0IGZpbGxlZCB3aXRoIG51bGwgYnkgam9pbmluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmplY3RdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4LFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcblxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09IFwiQVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZVxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChub2RlUGF0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSB7IFtjb2wubmFtZV06IHZhbHVlIH07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVDYWNoZVtjb2wudGFibGVdID0gc3ViT2JqZWN0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJlc3VsdCwgbm9kZVBhdGgsIHN1Yk9iamVjdCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwgcm93T2JqZWN0KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIChhc3NvY01ldGEudHlwZSA9PT0gXCJyZWZlcnNUb1wiIHx8IGFzc29jTWV0YS50eXBlID09PSBcImJlbG9uZ3NUb1wiKSAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIGRhdGEgXCI6JHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbZmluaXNoZWQsIHBlbmRpbmdBc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCAmJiAhKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
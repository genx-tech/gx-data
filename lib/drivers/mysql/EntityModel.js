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
        let rowKeyValue = subObj[key];

        if (_.isNil(rowKeyValue)) {
          return;
        }

        let existingSubRow = subIndexes && subIndexes[rowKeyValue];

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
        setValueByPath(result, aliasMap[col.table].concat([col.name]), null);
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
            tableCache[col.table] = {
              [col.name]: value
            };
          }
        }

        return result;
      }, rowObject);

      _.forOwn(tableCache, (obj, table) => {
        let nodePath = aliasMap[table];
        const tmpl = getValueByPath(tableTemplate, nodePath);
        setValueByPath(rowObject, nodePath, { ...tmpl,
          ...obj
        });
      });

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJtYXBGaWx0ZXIiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwicXVlcnlLZXkiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImxhdGVzdCIsImlzRW1wdHkiLCJpbnNlcnRJZCIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJyZXR1cm4iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJyZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVBY3R1YWxVcGRhdGVkIiwiJHJldHJpZXZlTm90VXBkYXRlIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiJGluY2x1ZGVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJzY2hlbWFOYW1lIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm1haW5JbmRleCIsInNlbGYiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImFuY2hvciIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJjb2wiLCJ0YWJsZSIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwiYnVja2V0IiwiZm9yT3duIiwib2JqIiwidG1wbCIsInJvd0tleSIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImlzTmV3IiwiYXNzb2NzIiwidiIsImsiLCJzdGFydHNXaXRoIiwiYXNzb2NNZXRhIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsInBhc3NPbk9wdGlvbnMiLCJwaWNrIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJjcmVhdGVkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwicXVlcnkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLGFBQXBCO0FBQW1DQyxFQUFBQSxlQUFuQztBQUFvREMsRUFBQUE7QUFBcEQsSUFBd0VWLE9BQU8sQ0FBQyxvQkFBRCxDQUFyRjs7QUFDQSxNQUFNVyxLQUFLLEdBQUdYLE9BQU8sQ0FBQyxhQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVksRUFBQUEsWUFBRjtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBOEJiLE9BQU8sQ0FBQyxrQkFBRCxDQUEzQzs7QUFLQSxNQUFNYyxnQkFBTixTQUErQlIsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1MsZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBaEM7QUFDQSxXQUFPQSxNQUFNLElBQUksS0FBS0MsSUFBTCxDQUFVRSxNQUFWLENBQWlCSCxNQUFNLENBQUNJLEtBQXhCLEVBQStCQyxlQUFoRDtBQUNIOztBQU9ELFNBQU9DLGVBQVAsQ0FBdUJDLFNBQXZCLEVBQWtDQyxPQUFsQyxFQUEyQztBQUN2QyxXQUFPdEIsY0FB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IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgeyBEYXRlVGltZSB9ID0gcmVxdWlyZShcImx1eG9uXCIpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKFwiLi4vLi4vRW50aXR5TW9kZWxcIik7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuLyoqXG4gKiBNeVNRTCBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKi9cbmNsYXNzIE15U1FMRW50aXR5TW9kZWwgZXh0ZW5kcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqXG4gICAgICogW3NwZWNpZmljXSBDaGVjayBpZiB0aGlzIGVudGl0eSBoYXMgYXV0byBpbmNyZW1lbnQgZmVhdHVyZS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKFxuICAgICAgICAgICAgZW50aXR5T2JqLFxuICAgICAgICAgICAga2V5UGF0aFxuICAgICAgICAgICAgICAgIC5zcGxpdChcIi5cIilcbiAgICAgICAgICAgICAgICAubWFwKChwKSA9PiBcIjpcIiArIHApXG4gICAgICAgICAgICAgICAgLmpvaW4oXCIuXCIpXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlblxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gXCJOT1dcIikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnJhdyhcIk5PVygpXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnQ6IFwiICsgbmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWVcbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcImJvb2xlYW5cIikgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlXG4gICAgICogQHBhcmFtIHsqfSBpbmZvXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImFycmF5XCIgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09IFwiRVJfTk9fUkVGRVJFTkNFRF9ST1dfMlwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5LFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgW1wiJHJldHJpZXZlVXBkYXRlZFwiLCBcIiRieXBhc3NFbnN1cmVVbmlxdWVcIl0pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnNlcnQgaWdub3JlZFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nhbm5vdCBleHRyYWN0IHVuaXF1ZSBrZXlzIGZyb20gaW5wdXQgZGF0YS4nLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgICAgIC4uLnJldHJpZXZlT3B0aW9ucywgICAgICAgXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IG9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBmaW5kT3B0aW9uc1xuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykge1xuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpO1xuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LFxuICAgICAgICAgICAgY291bnRlciA9IDAsXG4gICAgICAgICAgICBjYWNoZSA9IHt9O1xuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9IFwiOmpvaW5cIiArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0XG4gICAgICAgICAgICAgICAgICAgICAgICA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgICAgICAgbGV0IHJlc3VsdDtcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MgKyAxKTtcblxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgXCIuXCIgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgZW50aXR5TmFtZV0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoXCIuXCIsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5KSB7XG4gICAgICAgIGxldCBtYWluSW5kZXggPSB7fTtcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHtcbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9IFwiOlwiICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcywgY3VycmVudFBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN0cnVjdHVyZSBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgc2hvdWxkIGJlIGEgbGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmosXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgZG9lcyBub3QgZXhpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdID0gc3ViSW5kZXg7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gXCI6XCIgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldO1xuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9iamVjdF07XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICpcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IC8qZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy9yb3dPYmplY3Rbb2JqS2V5XSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XSA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4LFxuICAgICAgICAgICAgICAgICAgICB9IDoge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIGFsaWFzTWFwW2NvbC50YWJsZV0uY29uY2F0KFtjb2wubmFtZV0pLCBudWxsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vY29uc29sZS5sb2codGFibGVUZW1wbGF0ZSk7XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gXCJBXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUgIT0gbnVsbCkgeyAvLyBhdm9pZCBhIG9iamVjdCB3aXRoIGFsbCBudWxsIHZhbHVlIGV4aXN0c1xuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZVxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVDYWNoZVtjb2wudGFibGVdID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpO1xuXG4gICAgICAgICAgICBfLmZvck93bih0YWJsZUNhY2hlLCAob2JqLCB0YWJsZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW3RhYmxlXTtcbiAgICAgICAgICAgICAgICBjb25zdCB0bXBsID0gZ2V0VmFsdWVCeVBhdGgodGFibGVUZW1wbGF0ZSwgbm9kZVBhdGgpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyb3dPYmplY3QsIG5vZGVQYXRoLCB7IC4uLnRtcGwsIC4uLm9iaiB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKHJvd09iamVjdCwgeyBkZXB0aDogMTAgfSk7XG5cbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSwgaXNOZXcpIHtcbiAgICAgICAgY29uc3QgcmF3ID0ge30sXG4gICAgICAgICAgICBhc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc05ldyAmJiAoYXNzb2NNZXRhLnR5cGUgPT09IFwicmVmZXJzVG9cIiB8fCBhc3NvY01ldGEudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikgJiYgYW5jaG9yIGluIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW3JhdywgYXNzb2NzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG4gICAgICAgIGNvbnN0IGZpbmlzaGVkID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJG1pZ3JhdGlvblwiLCBcIiR2YXJpYWJsZXNcIl0pO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT5cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIHBhc3NPbk9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGZpbmlzaGVkW2FuY2hvcl0gPSBiZWZvcmVFbnRpdHlDcmVhdGUgPyBjcmVhdGVkW2Fzc29jTWV0YS5maWVsZF0gOiBjcmVhdGVkW2Fzc29jTWV0YS5rZXldO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gW2ZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQgY3VycmVudEtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICBjdXJyZW50S2V5VmFsdWUgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmV0dXJuXSwgdGhpcy5tZXRhLmtleUZpZWxkKTtcbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGN1cnJlbnRLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihkYXRhLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTsgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oYXNzb2NSZWNvcmRzVG9SZW1vdmUsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+IGl0ZW1bYXNzb2NNZXRhLmtleV0gIT0gbnVsbCA/XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk6XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUb1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwgJiYgIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiRXhpc3RpbmcgZG9lcyBub3QgY29udGFpbiB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgaWQuXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZzogY29udGV4dC5leGlzdGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFthc3NvY01ldGEuZmllbGRdOiBkZXN0RW50aXR5SWQsIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL25vdGhpbmcgdG8gZG8gZm9yIG51bGwgZGVzdCBlbnRpdHkgaWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oeyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgeyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZFwiKTtcblxuICAgICAgICAgICAgLy9yZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGVuZGluZ0Fzc29jcztcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxFbnRpdHlNb2RlbDtcbiJdfQ==
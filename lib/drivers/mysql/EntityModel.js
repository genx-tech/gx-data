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
        setValueByPath(result, aliasMap[col.table] + '.' + col.name, null);
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

      console.dir(rowObject, {
        depth: 10
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJtYXBGaWx0ZXIiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiYWZmZWN0ZWRSb3dzIiwicXVlcnlLZXkiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImxhdGVzdCIsImlzRW1wdHkiLCJpbnNlcnRJZCIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJyZXR1cm4iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJyZXRyaWV2ZVVwZGF0ZWQiLCIkcmV0cmlldmVBY3R1YWxVcGRhdGVkIiwiJHJldHJpZXZlTm90VXBkYXRlIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiJGluY2x1ZGVEZWxldGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJzY2hlbWFOYW1lIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm1haW5JbmRleCIsInNlbGYiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImFuY2hvciIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJjb2wiLCJ0YWJsZSIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwiYnVja2V0IiwiZm9yT3duIiwib2JqIiwidG1wbCIsImNvbnNvbGUiLCJkaXIiLCJkZXB0aCIsInJvd0tleSIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImlzTmV3IiwiYXNzb2NzIiwidiIsImsiLCJzdGFydHNXaXRoIiwiYXNzb2NNZXRhIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsInBhc3NPbk9wdGlvbnMiLCJwaWNrIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJjcmVhdGVkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwicXVlcnkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLGFBQXBCO0FBQW1DQyxFQUFBQSxlQUFuQztBQUFvREMsRUFBQUE7QUFBcEQsSUFBd0VWLE9BQU8sQ0FBQyxvQkFBRCxDQUFyRjs7QUFDQSxNQUFNVyxLQUFLLEdBQUdYLE9BQU8sQ0FBQyxhQUFELENBQXJCOztBQUNBLE1BQU07QUFBRVksRUFBQUEsWUFBRjtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBOEJiLE9BQU8sQ0FBQyxrQkFBRCxDQUEzQzs7QUFLQSxNQUFNYyxnQkFBTixTQUErQlIsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1MsZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBaEM7QUFDQSxXQUFPQSxNQUFNLElBQUksS0FBS0MsSUFBTCxDQUFVRSxNQUFWLENBQWlCSCxNQUFNLENBQUNJLEtBQXhCLEVBQStCQyxlQUFoRDtBQUNIOztBQU9ELFNBQU9DLGVBQVAsQ0FBdUJDLFNBQXZCLEVBQWtDQyxPQUFs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QUFVLDZEQUFWLENBQU47QUFHSCxLQW5IZSxDQUFoQjtBQXFIQSxXQUFPcUssYUFBUDtBQUNIOztBQTU0QnNDOztBQSs0QjNDb0IsTUFBTSxDQUFDQyxPQUFQLEdBQWlCOU0sZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLVwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKFwibHV4b25cIik7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoXCIuLi8uLi9FbnRpdHlNb2RlbFwiKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciwgVmFsaWRhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9FcnJvcnNcIik7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoXCIuLi8uLi90eXBlc1wiKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tLCBtYXBGaWx0ZXIgfSA9IHJlcXVpcmUoXCIuLi8uLi91dGlscy9sYW5nXCIpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwiYm9vbGVhblwiKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWVcbiAgICAgKiBAcGFyYW0geyp9IGluZm9cbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJkYXRldGltZVwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuREFURVRJTUUuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYXJyYXlcIiAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2VcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHksXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbXCIkcmV0cmlldmVVcGRhdGVkXCIsIFwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZVwiXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IHsgLi4uY29udGV4dC5yZXR1cm4sIC4uLmNvbnRleHQucXVlcnlLZXkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcblxuICAgICAgICBpZiAoIXJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZCAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZSAmJiBjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZU5vdFVwZGF0ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShvcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSByZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBvcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5jb25kaXRpb24sIC4uLnJldHJpZXZlT3B0aW9ucywgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgLi4ucmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZFxuICAgICAgICAgICAgICAgIDoge307XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRcbiAgICAgICAgICAgICAgICA6IHt9O1xuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7XG4gICAgICAgIGxldCBhc3NvY2lhdGlvbnMgPSBfLnVuaXEoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKS5zb3J0KCk7XG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sXG4gICAgICAgICAgICBjb3VudGVyID0gMCxcbiAgICAgICAgICAgIGNhY2hlID0ge307XG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goKGFzc29jKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIHRoaXMuZGIuc2NoZW1hTmFtZSk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gXCI6am9pblwiICsgKytjb3VudGVyO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jVGFibGVbYWxpYXNdID0ge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgIG91dHB1dDogYXNzb2Mub3V0cHV0LFxuICAgICAgICAgICAgICAgICAgICBrZXk6IGFzc29jLmtleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMsXG4gICAgICAgICAgICAgICAgICAgIG9uOiBhc3NvYy5vbixcbiAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmRhdGFzZXRcbiAgICAgICAgICAgICAgICAgICAgICAgID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoXCIuXCIpO1xuICAgICAgICBsZXQgcmVzdWx0O1xuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkge1xuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcyArIDEpO1xuXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyBcIi5cIiArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoXCIuXCIpID4gMCkge1xuICAgICAgICAgICAgbGV0IFtzY2hlbWFOYW1lLCBlbnRpdHlOYW1lXSA9IGFzc29jLmVudGl0eS5zcGxpdChcIi5cIiwgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyBcIi5cIiArIGFzc29jLmVudGl0eTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICBhc3NvYy5rZXkgPSBhc3NvYy5tb2RlbC5tZXRhLmtleUZpZWxkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9O1xuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkge1xuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gXCI6XCIgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleGVzID0gZXhpc3RpbmdSb3cuc3ViSW5kZXhlc1tvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXlWYWx1ZSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBzaG91bGQgYmUgYSBsaXN0LmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gW3N1Yk9ial07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaixcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKFwiLlwiKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cIiBkb2VzIG5vdCBleGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXlWYWx1ZV0gPSBzdWJJbmRleDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07XG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqZWN0XTtcblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKlxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gLyplbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvL3Jvd09iamVjdFtvYmpLZXldID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHN1Yk9iamVjdFtrZXldID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXgsXG4gICAgICAgICAgICAgICAgICAgIH0gOiB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIGFsaWFzTWFwW2NvbC50YWJsZV0gKyAnLicgKyBjb2wubmFtZSwgbnVsbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IFtjb2wubmFtZV06IHZhbHVlIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7XG5cbiAgICAgICAgICAgIF8uZm9yT3duKHRhYmxlQ2FjaGUsIChvYmosIHRhYmxlKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbdGFibGVdO1xuICAgICAgICAgICAgICAgIGNvbnN0IHRtcGwgPSBnZXRWYWx1ZUJ5UGF0aCh0YWJsZVRlbXBsYXRlLCBub2RlUGF0aCk7XG4gICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocm93T2JqZWN0LCBub2RlUGF0aCwgeyAuLi50bXBsLCAuLi5vYmogfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgY29uc29sZS5kaXIocm93T2JqZWN0LCB7IGRlcHRoOiAxMCB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0ge1xuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIChhc3NvY01ldGEudHlwZSA9PT0gXCJyZWZlcnNUb1wiIHx8IGFzc29jTWV0YS50eXBlID09PSBcImJlbG9uZ3NUb1wiKSAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIGRhdGEgXCI6JHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbZmluaXNoZWQsIHBlbmRpbmdBc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NLZXlzID0gbWFwRmlsdGVyKGRhdGEsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0gIT0gbnVsbCwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUmVjb3Jkc1RvUmVtb3ZlID0geyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc29jUmVjb3Jkc1RvUmVtb3ZlW2Fzc29jTWV0YS5rZXldID0geyAkbm90SW46IGFzc29jS2V5cyB9OyAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyhhc3NvY1JlY29yZHNUb1JlbW92ZSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT4gaXRlbVthc3NvY01ldGEua2V5XSAhPSBudWxsID9cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5fLm9taXQoaXRlbSwgW2Fzc29jTWV0YS5rZXldKSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAkcXVlcnk6IHsgW2Fzc29jTWV0YS5rZXldOiBpdGVtW2Fzc29jTWV0YS5rZXldIH0sIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTpcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eUlkID0gY29udGV4dC5leGlzdGluZ1thbmNob3JdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCAmJiAhKGFuY2hvciBpbiBjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgW2Fzc29jTWV0YS5maWVsZF06IGRlc3RFbnRpdHlJZCwgLi4ucGFzc09uT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90aGluZyB0byBkbyBmb3IgbnVsbCBkZXN0IGVudGl0eSBpZFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBhc3NvY2lhdGVkIGRhdGEgZm9yIG11bHRpcGxlIHJlY29yZHMgbm90IGltcGxlbWVudGVkXCIpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwZW5kaW5nQXNzb2NzO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsO1xuIl19
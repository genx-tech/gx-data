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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkRBVEVUSU1FIiwic2VyaWFsaXplIiwiQXJyYXkiLCJpc0FycmF5IiwiY3N2IiwiQVJSQVkiLCJ0b0NzdiIsIk9CSkVDVCIsImNyZWF0ZV8iLCJhcmdzIiwiZXJyb3IiLCJlcnJvckNvZGUiLCJjb2RlIiwibWVzc2FnZSIsInVwZGF0ZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImNvbnRleHQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJlbnRpdHkiLCJmaW5kT25lXyIsIiRxdWVyeSIsIm9wdGlvbnMiLCJjb25uT3B0aW9ucyIsInJldCIsIiRyZXRyaWV2ZUV4aXN0aW5nIiwicmF3T3B0aW9ucyIsIiRleGlzdGluZyIsImtleUZpZWxkIiwidmFsdWVPZktleSIsIm9taXQiLCIkcmV0cmlldmVDcmVhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsIiRyZXN1bHQiLCJfaW50ZXJuYWxCZWZvcmVDcmVhdGVfIiwiX2ludGVybmFsQWZ0ZXJDcmVhdGVfIiwiJHJldHJpZXZlRGJSZXN1bHQiLCJyZXN1bHQiLCJhZmZlY3RlZFJvd3MiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwiaXNFbXB0eSIsImluc2VydElkIiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsInJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQiLCIkcmV0cmlldmVOb3RVcGRhdGUiLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcmV0cmlldmVEZWxldGVkIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsImV4aXN0aW5nIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJmaW5kT3B0aW9ucyIsImFzc29jaWF0aW9ucyIsInVuaXEiLCIkYXNzb2NpYXRpb24iLCJzb3J0IiwiYXNzb2NUYWJsZSIsImNvdW50ZXIiLCJjYWNoZSIsImZvckVhY2giLCJhc3NvYyIsIl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYiIsInNjaGVtYU5hbWUiLCJhbGlhcyIsImpvaW5UeXBlIiwib3V0cHV0Iiwia2V5Iiwib24iLCJkYXRhc2V0IiwiYnVpbGRRdWVyeSIsIm1vZGVsIiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibmVzdGVkS2V5R2V0dGVyIiwibWFwVmFsdWVzIiwiY2hhaW4iLCJtYWluSW5kZXgiLCJzZWxmIiwiY29sIiwidGFibGUiLCJwb3MiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXlWYWx1ZSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInRhYmxlVGVtcGxhdGUiLCJyZWR1Y2UiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsImJ1Y2tldCIsImZvck93biIsIm9iaiIsInJvd0tleSIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImlzTmV3IiwiYXNzb2NzIiwidiIsImsiLCJzdGFydHNXaXRoIiwiYXNzb2NNZXRhIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsInBhc3NPbk9wdGlvbnMiLCJwaWNrIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJjcmVhdGVkIiwiX3VwZGF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlVcGRhdGUiLCJmb3JTaW5nbGVSZWNvcmQiLCJjdXJyZW50S2V5VmFsdWUiLCJhc3NvY0tleXMiLCJyZWNvcmQiLCJhc3NvY1JlY29yZHNUb1JlbW92ZSIsImxlbmd0aCIsIiRub3RJbiIsImRlbGV0ZU1hbnlfIiwiZGVzdEVudGl0eUlkIiwicXVlcnkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBLGFBQXBCO0FBQW1DQyxFQUFBQSx1QkFBbkM7QUFBNERDLEVBQUFBLGNBQTVEO0FBQTRFQyxFQUFBQSxlQUE1RTtBQUE2RkMsRUFBQUE7QUFBN0YsSUFBaUhaLE9BQU8sQ0FBQyxvQkFBRCxDQUE5SDs7QUFDQSxNQUFNYSxLQUFLLEdBQUdiLE9BQU8sQ0FBQyxhQUFELENBQXJCOztBQUNBLE1BQU07QUFBRWMsRUFBQUEsWUFBRjtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBOEJmLE9BQU8sQ0FBQyxrQkFBRCxDQUEzQzs7QUFFQSxNQUFNZ0Isc0JBQXNCLEdBQUlDLE1BQUQsSUFBYSxNQUFNQSxNQUFsRDs7QUFLQSxNQUFNQyxnQkFBTixTQUErQlosV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV2EsZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFB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LElBREcsRUFFSDtBQUFFLGFBQUNNLFNBQVMsQ0FBQzlLLEtBQVgsR0FBbUJvTSxZQUFyQjtBQUFtQyxlQUFHaEI7QUFBdEMsV0FGRyxFQUdIOUksT0FBTyxDQUFDTSxXQUhMLENBQVA7QUFLSDs7QUFHRDtBQUNIOztBQUVELFlBQU0wSSxVQUFVLENBQUNhLFdBQVgsQ0FBdUI7QUFBRSxTQUFDckIsU0FBUyxDQUFDOUssS0FBWCxHQUFtQjZMO0FBQXJCLE9BQXZCLEVBQStEdkosT0FBTyxDQUFDTSxXQUF2RSxDQUFOOztBQUVBLFVBQUlnSixlQUFKLEVBQXFCO0FBQ2pCLGVBQU9OLFVBQVUsQ0FBQ3hKLE9BQVgsQ0FDSCxFQUFFLEdBQUcwSSxJQUFMO0FBQVcsV0FBQ00sU0FBUyxDQUFDOUssS0FBWCxHQUFtQjZMO0FBQTlCLFNBREcsRUFFSFQsYUFGRyxFQUdIOUksT0FBTyxDQUFDTSxXQUhMLENBQVA7QUFLSDs7QUFFRCxZQUFNLElBQUk5QixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUdILEtBdEhlLENBQWhCO0FBd0hBLFdBQU9vSyxhQUFQO0FBQ0g7O0FBcDdCc0M7O0FBdTdCM0NvQixNQUFNLENBQUNDLE9BQVAsR0FBaUI3TSxnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyItXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IHsgRGF0ZVRpbWUgfSA9IHJlcXVpcmUoXCJsdXhvblwiKTtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZShcIi4uLy4uL0VudGl0eU1vZGVsXCIpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBSZWZlcmVuY2VkTm90RXhpc3RFcnJvciwgRHVwbGljYXRlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuY29uc3QgZGVmYXVsdE5lc3RlZEtleUdldHRlciA9IChhbmNob3IpID0+ICgnOicgKyBhbmNob3IpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwiYm9vbGVhblwiKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWVcbiAgICAgKiBAcGFyYW0geyp9IGluZm9cbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJkYXRldGltZVwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuREFURVRJTUUuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYXJyYXlcIiAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHksXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbXCIkcmV0cmlldmVVcGRhdGVkXCIsIFwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZVwiXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0ID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuXG4gICAgICAgIGlmICghcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKG9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLmNvbmRpdGlvbiwgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsIC4uLnJldHJpZXZlT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogb3B0aW9ucy4kcXVlcnksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLFxuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsICAgICAgIFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBvcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZFxuICAgICAgICAgICAgICAgIDoge307XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAgeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgdGhpcy5kYi5zY2hlbWFOYW1lKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSwgbmVzdGVkS2V5R2V0dGVyKSB7XG4gICAgICAgIG5lc3RlZEtleUdldHRlciA9PSBudWxsICYmIChuZXN0ZWRLZXlHZXR0ZXIgPSBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyKTsgICAgICAgIFxuICAgICAgICBhbGlhc01hcCA9IF8ubWFwVmFsdWVzKGFsaWFzTWFwLCBjaGFpbiA9PiBjaGFpbi5tYXAoYW5jaG9yID0+IG5lc3RlZEtleUdldHRlcihhbmNob3IpKSk7XG5cbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9O1xuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgY29sdW1ucyA9IGNvbHVtbnMubWFwKGNvbCA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIlwiKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcG9zID0gY29sLm5hbWUuaW5kZXhPZignJCcpO1xuICAgICAgICAgICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZTogY29sLm5hbWUuc3Vic3RyKDAsIHBvcyksXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZS5zdWJzdHIocG9zKzEpXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHRhYmxlOiAnQScsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB0YWJsZTogY29sLnRhYmxlLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KTtcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcywgY3VycmVudFBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN0cnVjdHVyZSBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgc2hvdWxkIGJlIGEgbGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmosXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcyk7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgZG9lcyBub3QgZXhpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdID0gc3ViSW5kZXg7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldO1xuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqZWN0XTtcblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKlxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy93aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWQgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IC8qZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy9yb3dPYmplY3Rbb2JqS2V5XSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XSA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4LFxuICAgICAgICAgICAgICAgICAgICB9IDoge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIFtjb2wudGFibGUsIGNvbC5uYW1lXSwgbnVsbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7IC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwgcm93T2JqZWN0KTtcblxuICAgICAgICAgICAgXy5mb3JPd24odGFibGVDYWNoZSwgKG9iaiwgdGFibGUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFt0YWJsZV07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIChhc3NvY01ldGEudHlwZSA9PT0gXCJyZWZlcnNUb1wiIHx8IGFzc29jTWV0YS50eXBlID09PSBcImJlbG9uZ3NUb1wiKSAmJiBhbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIGRhdGEgXCI6JHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7YW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiBcIiArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICAvL3RvZG86IGRvdWJsZSBjaGVjayB0byBlbnN1cmUgaW5jbHVkaW5nIGFsbCByZXF1aXJlZCBvcHRpb25zXG4gICAgICAgIGNvbnN0IHBhc3NPbk9wdGlvbnMgPSBfLnBpY2soY29udGV4dC5vcHRpb25zLCBbXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbZmluaXNoZWQsIHBlbmRpbmdBc3NvY3NdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eVVwZGF0ZSwgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGxldCBjdXJyZW50S2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6IFwiICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuXG4gICAgICAgIC8vdG9kbzogZG91YmxlIGNoZWNrIHRvIGVuc3VyZSBpbmNsdWRpbmcgYWxsIHJlcXVpcmVkIG9wdGlvbnNcbiAgICAgICAgY29uc3QgcGFzc09uT3B0aW9ucyA9IF8ucGljayhjb250ZXh0Lm9wdGlvbnMsIFtcIiRtaWdyYXRpb25cIiwgXCIkdmFyaWFibGVzXCJdKTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJyZWZlcnNUb1wiICYmIGFzc29jTWV0YS50eXBlICE9PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NLZXlzID0gbWFwRmlsdGVyKGRhdGEsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0gIT0gbnVsbCwgcmVjb3JkID0+IHJlY29yZFthc3NvY01ldGEua2V5XSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jUmVjb3Jkc1RvUmVtb3ZlID0geyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc29jUmVjb3Jkc1RvUmVtb3ZlW2Fzc29jTWV0YS5rZXldID0geyAkbm90SW46IGFzc29jS2V5cyB9OyAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyhhc3NvY1JlY29yZHNUb1JlbW92ZSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCAoaXRlbSkgPT4gaXRlbVthc3NvY01ldGEua2V5XSAhPSBudWxsID9cbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC51cGRhdGVPbmVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5fLm9taXQoaXRlbSwgW2Fzc29jTWV0YS5rZXldKSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAkcXVlcnk6IHsgW2Fzc29jTWV0YS5rZXldOiBpdGVtW2Fzc29jTWV0YS5rZXldIH0sIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTpcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NNb2RlbC5jcmVhdGVfKFxuICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vY29ubmVjdGVkIGJ5XG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIC8vcmVmZXJzVG8gb3IgYmVsb25nc1RvXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IGNvbnRleHQucmF3LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBTcGVjaWZpZWQgXCIke3RoaXMubWV0YS5uYW1lfVwiIG5vdCBmb3VuZC5gLCB7IHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwgJiYgIShhbmNob3IgaW4gY29udGV4dC5leGlzdGluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFwiRXhpc3RpbmcgZG9lcyBub3QgY29udGFpbiB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgaWQuXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZzogY29udGV4dC5leGlzdGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFthc3NvY01ldGEuZmllbGRdOiBkZXN0RW50aXR5SWQsIC4uLnBhc3NPbk9wdGlvbnMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL25vdGhpbmcgdG8gZG8gZm9yIG51bGwgZGVzdCBlbnRpdHkgaWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oeyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgeyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sXG4gICAgICAgICAgICAgICAgICAgIHBhc3NPbk9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZFwiKTtcblxuICAgICAgICAgICAgLy9yZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGVuZGluZ0Fzc29jcztcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxFbnRpdHlNb2RlbDtcbiJdfQ==
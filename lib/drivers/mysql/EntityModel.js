"use strict";

require("source-map-support/register");

const Util = require('rk-utils');

const {
  _,
  getValueByPath,
  setValueByPath,
  eachAsync_
} = Util;

const {
  DateTime
} = require('luxon');

const EntityModel = require('../../EntityModel');

const {
  ApplicationError,
  DatabaseError,
  ValidationError,
  InvalidArgument
} = require('../../utils/Errors');

const Types = require('../../types');

const {
  getValueFrom
} = require('../../utils/lang');

class MySQLEntityModel extends EntityModel {
  static get hasAutoIncrement() {
    let autoId = this.meta.features.autoId;
    return autoId && this.meta.fields[autoId.field].autoIncrementId;
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath.split('.').map(p => ':' + p).join('.'));
  }

  static _translateSymbolToken(name) {
    if (name === 'NOW') {
      return this.db.connector.raw('NOW()');
    }

    throw new Error('not support: ' + name);
  }

  static _serialize(value) {
    if (typeof value === 'boolean') return value ? 1 : 0;

    if (value instanceof DateTime) {
      return value.toISO({
        includeOffset: false
      });
    }

    return value;
  }

  static _serializeByTypeInfo(value, info) {
    if (info.type === 'boolean') {
      return value ? 1 : 0;
    }

    if (info.type === 'datetime') {
      return Types.DATETIME.serialize(value);
    }

    if (info.type === 'array' && Array.isArray(value)) {
      if (info.csv) {
        return Types.ARRAY.toCsv(value);
      } else {
        return Types.ARRAY.serialize(value);
      }
    }

    if (info.type === 'object') {
      return Types.OBJECT.serialize(value);
    }

    return value;
  }

  static async create_(...args) {
    try {
      return await super.create_(...args);
    } catch (error) {
      let errorCode = error.code;

      if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
        throw new DatabaseError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
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

      if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
        throw new DatabaseError('The entity to be updated is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
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
      options = { ..._.omit(context.options, ['$retrieveUpdated', '$bypassEnsureUnique']),
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
        let {
          insertId
        } = context.result;
        context.queryKey = {
          [this.meta.features.autoId.field]: insertId
        };
      } else {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
      }

      let retrieveOptions = _.isPlainObject(context.options.$retrieveCreated) ? context.options.$retrieveCreated : {};
      context.return = await this.findOne_({ ...retrieveOptions,
        $query: context.queryKey
      }, context.connOptions);
    } else {
      if (this.hasAutoIncrement) {
        let {
          insertId
        } = context.result;
        context.queryKey = {
          [this.meta.features.autoId.field]: insertId
        };
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
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (context.options.$retrieveUpdated) {
      let condition = {
        $query: this.getUniqueKeyValuePairsFrom(context.options.$query)
      };

      if (context.options.$bypassEnsureUnique) {
        condition.$bypassEnsureUnique = context.options.$bypassEnsureUnique;
      }

      let retrieveOptions = {};

      if (_.isPlainObject(context.options.$retrieveUpdated)) {
        retrieveOptions = context.options.$retrieveUpdated;
      } else if (context.options.$relationships) {
        retrieveOptions.$relationships = context.options.$relationships;
      }

      context.return = await this.findOne_({ ...condition,
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
        $query: context.options.$query
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
          alias = ':join' + ++counter;
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
    let lastPos = assoc.lastIndexOf('.');
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
      this._loadAssocIntoTable(assocTable, cache, assoc + '.' + result.assoc);
    }

    return result;
  }

  static _translateSchemaNameToDb(assoc, currentDb) {
    if (assoc.entity.indexOf('.') > 0) {
      let [schemaName, entityName] = assoc.entity.split('.', 2);
      let app = this.db.app;
      let refDb = app.db(schemaName);

      if (!refDb) {
        throw new ApplicationError(`The referenced schema "${schemaName}" does not have db model in the same application.`);
      }

      assoc.entity = refDb.connector.database + '.' + entityName;
      assoc.model = refDb.model(entityName);

      if (!assoc.model) {
        throw new ApplicationError(`Failed load the entity model "${schemaName}.${entityName}".`);
      }
    } else {
      assoc.model = this.db.model(assoc.entity);

      if (currentDb && currentDb !== this.db) {
        assoc.entity = this.db.connector.database + '.' + assoc.entity;
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
        let objKey = ':' + anchor;
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
            throw new ApplicationError(`The structure of association "${currentPath.join('.')}" with [key=${key}] of entity "${self.meta.name}" should be a list.`, {
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
            throw new ApplicationError(`The subIndexes of association "${currentPath.join('.')}" with [key=${key}] of entity "${self.meta.name}" does not exist.`, {
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

        let objKey = ':' + anchor;
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

        if (col.table === 'A') {
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

  static _extractAssociations(data) {
    const raw = {},
          assocs = {};
    const meta = this.meta.associations;

    _.forOwn(data, (v, k) => {
      if (k.startsWith(':')) {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if ((assocMeta.type === 'refersTo' || assocMeta.type === 'belongsTo') && anchor in data) {
          throw new ValidationError(`Association data ":${localField}" of entity "${this.meta.name}" conflicts with input value of field "${localField}".`);
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
        throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
      }
    }

    const pendingAssocs = {};
    const finished = {};
    await eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (beforeEntityCreate && assocMeta.type !== 'refersTo' && assocMeta.type !== 'belongsTo') {
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
        }, context.options, context.connOptions));
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

      let created = await assocModel.create_(data, context.options, context.connOptions);
      finished[anchor] = beforeEntityCreate ? created[assocMeta.field] : created[assocMeta.key];
    });
    return [finished, pendingAssocs];
  }

  static async _updateAssocs_(context, assocs, beforeEntityUpdate, forSingleRecord) {
    const meta = this.meta.associations;
    let keyValue;

    if (beforeEntityUpdate) {
      keyValue = getValueFrom([context.options.$query, context.raw], this.meta.keyField);

      if (keyValue == null) {
        context.existing = await this.findOne_(context.options.$query, context.connOptions);
        keyValue = context.existing[this.meta.keyField];
      }
    } else {
      keyValue = getValueFrom([context.options.$query, context.return], this.meta.keyField);
    }

    if (_.isNil(keyValue)) {
      throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
    }

    const pendingAssocs = {};
    await eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (beforeEntityUpdate && assocMeta.type !== 'refersTo' && assocMeta.type !== 'belongsTo') {
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
          [assocMeta.field]: keyValue
        }, context.connOptions);
        return eachAsync_(data, item => assocModel.create_({ ...item,
          [assocMeta.field]: keyValue
        }, null, context.connOptions));
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
        return assocModel.updateOne_(data, {
          [assocMeta.field]: keyValue
        }, context.connOptions);
      }

      await assocModel.deleteMany_({
        [assocMeta.field]: keyValue
      }, context.connOptions);

      if (forSingleRecord) {
        return assocModel.create_({ ...data,
          [assocMeta.field]: keyValue
        }, null, context.connOptions);
      }

      throw new Error('update associated data for multiple records not implemented');
    });
    return pendingAssocs;
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4Iiwic2VsZiIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwiY3VycmVudFBhdGgiLCJjb25jYXQiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwicmVkdWNlIiwiY29sIiwidGFibGUiLCJidWNrZXQiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJhc3NvY01ldGEiLCJsb2NhbEZpZWxkIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiY3JlYXRlZCIsIl91cGRhdGVBc3NvY3NfIiwiYmVmb3JlRW50aXR5VXBkYXRlIiwiZm9yU2luZ2xlUmVjb3JkIiwiZGVsZXRlTWFueV8iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJ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O0FBRUQsWUFBTTZILFVBQVUsQ0FBQ08sV0FBWCxDQUF1QjtBQUFFLFNBQUNkLFNBQVMsQ0FBQ2xLLEtBQVgsR0FBbUJzSztBQUFyQixPQUF2QixFQUF3RGhJLE9BQU8sQ0FBQ00sV0FBaEUsQ0FBTjs7QUFFQSxVQUFJbUksZUFBSixFQUFxQjtBQUNqQixlQUFPTixVQUFVLENBQUMzSSxPQUFYLENBQW1CLEVBQUUsR0FBRzhILElBQUw7QUFBVyxXQUFDTSxTQUFTLENBQUNsSyxLQUFYLEdBQW1Cc0s7QUFBOUIsU0FBbkIsRUFBNkQsSUFBN0QsRUFBbUVoSSxPQUFPLENBQUNNLFdBQTNFLENBQVA7QUFDSDs7QUFFRCxZQUFNLElBQUk5QixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUdILEtBL0NlLENBQWhCO0FBaURBLFdBQU95SixhQUFQO0FBQ0g7O0FBcHVCc0M7O0FBdXVCM0NVLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnhMLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuY29uc3QgeyBEYXRlVGltZSB9ID0gcmVxdWlyZSgnbHV4b24nKTtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZSgnLi4vLi4vRW50aXR5TW9kZWwnKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciwgVmFsaWRhdGlvbkVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuY29uc3QgeyBnZXRWYWx1ZUZyb20gfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcblxuLyoqXG4gKiBNeVNRTCBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKi9cbmNsYXNzIE15U1FMRW50aXR5TW9kZWwgZXh0ZW5kcyBFbnRpdHlNb2RlbCB7ICBcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDsgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwga2V5UGF0aC5zcGxpdCgnLicpLm1hcChwID0+ICc6JytwKS5qb2luKCcuJykpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW4gXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSAnTk9XJykge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnJhdygnTk9XKCknKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignbm90IHN1cHBvcnQ6ICcgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHsqfSBpbmZvIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkRBVEVUSU1FLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYXJyYXknICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSAgICBcblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX05PX1JFRkVSRU5DRURfUk9XXzInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ1RoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuICAgICAgICAgICAgXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9ucyA9IHsgXG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHN1cGVyLnZhbHVlT2ZLZXkoZW50aXR5KSB9LCBcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSBcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7ICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbJyRyZXRyaWV2ZVVwZGF0ZWQnLCAnJGJ5cGFzc0Vuc3VyZVVuaXF1ZSddKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH07ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7ICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLmNvbmRpdGlvbiwgLi4ucmV0cmlldmVPcHRpb25zIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7IFxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpOyAgICAgICAgXG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sIGNvdW50ZXIgPSAwLCBjYWNoZSA9IHt9OyAgICAgICBcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIHRoaXMuZGIuc2NoZW1hTmFtZSk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gJzpqb2luJyArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsIFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0ID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiB7fSkgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKCcuJyk7ICAgICAgICBcbiAgICAgICAgbGV0IHJlc3VsdDsgIFxuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkgeyAgICAgICAgIFxuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07ICAgXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zKzEpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG5cbiAgICAgICAgICAgIGxldCByZWZEYiA9IGFwcC5kYihzY2hlbWFOYW1lKTtcbiAgICAgICAgICAgIGlmICghcmVmRGIpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSByZWZlcmVuY2VkIHNjaGVtYSBcIiR7c2NoZW1hTmFtZX1cIiBkb2VzIG5vdCBoYXZlIGRiIG1vZGVsIGluIHRoZSBzYW1lIGFwcGxpY2F0aW9uLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSByZWZEYi5jb25uZWN0b3IuZGF0YWJhc2UgKyAnLicgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTsgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGFzc29jLmVudGl0eTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICBhc3NvYy5rZXkgPSBhc3NvYy5tb2RlbC5tZXRhLmtleUZpZWxkOyAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBhc3NvYztcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoW3Jvd3MsIGNvbHVtbnMsIGFsaWFzTWFwXSwgaGllcmFyY2h5KSB7XG4gICAgICAgIGxldCBtYWluSW5kZXggPSB7fTsgICAgICAgIFxuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuOyAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIHN0cnVjdHVyZSBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbignLicpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7c2VsZi5tZXRhLm5hbWV9XCIgc2hvdWxkIGJlIGEgbGlzdC5gLCB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqIF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpXG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJJbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIHN1YkluZGV4ZXMgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oJy4nKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke3NlbGYubWV0YS5uYW1lfVwiIGRvZXMgbm90IGV4aXN0LmAsIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXNbcm93S2V5XSA9IHN1YkluZGV4OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yO1xuICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSByb3dPYmplY3Rbb2JqS2V5XTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0geyBcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7ICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKiAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9zdWJPYmplY3Qgbm90IGV4aXN0LCBqdXN0IGZpbGxlZCB3aXRoIG51bGwgYnkgam9pbmluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqZWN0IF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN1Yk9iamVjdCAmJiBfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXhcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTsgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSAnQScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlIFxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChub2RlUGF0aCkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0geyBcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0LCBcbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KVxuICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXJyYXlPZk9ianM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgY29uc3QgcmF3ID0ge30sIGFzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoay5zdGFydHNXaXRoKCc6JykpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgICAgICBpZiAoKGFzc29jTWV0YS50eXBlID09PSAncmVmZXJzVG8nIHx8IGFzc29jTWV0YS50eXBlID09PSAnYmVsb25nc1RvJykgJiYgKGFuY2hvciBpbiBkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBBc3NvY2lhdGlvbiBkYXRhIFwiOiR7bG9jYWxGaWVsZH1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHtsb2NhbEZpZWxkfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmF3W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gWyByYXcsIGFzc29jcyBdOyAgICAgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWU7XG4gICAgICAgIFxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBjb25zdCBmaW5pc2hlZCA9IHt9O1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS50eXBlICE9PSAncmVmZXJzVG8nICYmIGFzc29jTWV0YS50eXBlICE9PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBNaXNzaW5nIFwiZmllbGRcIiBwcm9wZXJ0eSBpbiB0aGUgbWV0YWRhdGEgb2YgYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIGl0ZW0gPT4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBhc3NvY01vZGVsLmNyZWF0ZV8oZGF0YSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTsgIFxuXG4gICAgICAgICAgICBmaW5pc2hlZFthbmNob3JdID0gYmVmb3JlRW50aXR5Q3JlYXRlID8gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdIDogY3JlYXRlZFthc3NvY01ldGEua2V5XTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgZmluaXNoZWQsIHBlbmRpbmdBc3NvY3MgXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQga2V5VmFsdWU7XG5cbiAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgdGhpcy5tZXRhLmtleUZpZWxkKTtcblxuICAgICAgICAgICAgaWYgKGtleVZhbHVlID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQuZXhpc3RpbmdbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkgeyAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ3JlZmVyc1RvJyAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgaXRlbSA9PiBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG8gICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oZGF0YSwgeyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZCcpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19
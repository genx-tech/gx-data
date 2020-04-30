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
        ...retrieveOptions,
        $includeDeleted: context.options.$retrieveDeleted
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

      if (!beforeEntityCreate && assocMeta.field) {
        data = { ...data,
          [assocMeta.field]: keyValue
        };
      }

      let created = await assocModel.create_(data, null, context.connOptions);
      finished[anchor] = beforeEntityCreate ? created[assocMeta.field] : created[assocMeta.key];
    });
    return [finished, pendingAssocs];
  }

  static async _updateAssocs_(context, assocs, beforeEntityUpdate, forSingleRecord) {
    const meta = this.meta.associations;
    let currentKeyValue;

    if (beforeEntityUpdate) {} else {
      currentKeyValue = getValueFrom([context.options.$query, context.return], this.meta.keyField);

      if (_.isNil(currentKeyValue)) {
        throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
      }
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
          [assocMeta.field]: currentKeyValue
        }, context.connOptions);
        return eachAsync_(data, item => assocModel.create_({ ...item,
          [assocMeta.field]: currentKeyValue
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
        let destEntityId = getValueFrom([context.existing, context.options.$query, context.raw], anchor);

        if (destEntityId == null) {
          if (!_.isEmpty(context.existing)) {
            throw new ApplicationError('Existing does not contain the referenced entity id.');
          }

          context.existing = await this.findOne_(context.options.$query, context.connOptions);
          destEntityId = context.existing[anchor];

          if (destEntityId == null) {
            throw new ApplicationError('Existing does not contain the referenced entity id.');
          }
        }

        return assocModel.updateOne_(data, {
          [assocMeta.field]: destEntityId
        }, context.connOptions);
      }

      await assocModel.deleteMany_({
        [assocMeta.field]: currentKeyValue
      }, context.connOptions);

      if (forSingleRecord) {
        return assocModel.create_({ ...data,
          [assocMeta.field]: currentKeyValue
        }, null, context.connOptions);
      }

      throw new Error('update associated data for multiple records not implemented');
    });
    return pendingAssocs;
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4Iiwic2VsZiIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwiY3VycmVudFBhdGgiLCJjb25jYXQiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwicmVkdWNlIiwiY29sIiwidGFibGUiLCJidWNrZXQiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJhc3NvY01ldGEiLCJsb2NhbEZpZWxkIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiY3JlYXRlZCIsIl91cGRhdGVBc3NvY3NfIiwiYmVmb3JlRW50aXR5VXBkYXRlIiwiZm9yU2luZ2xlUmVjb3JkIiwiY3VycmVudEtleVZhbHVlIiwiZGVsZXRlTWFueV8iLCJkZXN0RW50aXR5SWQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtD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SyxPQUFSLENBQWdCRCxNQUE5QixFQUFzQ0osT0FBTyxDQUFDTSxXQUE5QyxDQUF6QjtBQUNBdUksVUFBQUEsWUFBWSxHQUFHN0ksT0FBTyxDQUFDdUMsUUFBUixDQUFpQnlELE1BQWpCLENBQWY7O0FBRUEsY0FBSTZDLFlBQVksSUFBSSxJQUFwQixFQUEwQjtBQUN0QixrQkFBTSxJQUFJL0wsZ0JBQUosQ0FBcUIscURBQXJCLENBQU47QUFDSDtBQUNKOztBQUVELGVBQU9zTCxVQUFVLENBQUN0SSxVQUFYLENBQXNCeUgsSUFBdEIsRUFBNEI7QUFBRSxXQUFDTSxTQUFTLENBQUNuSyxLQUFYLEdBQW1CbUw7QUFBckIsU0FBNUIsRUFBaUU3SSxPQUFPLENBQUNNLFdBQXpFLENBQVA7QUFDSDs7QUFFRCxZQUFNOEgsVUFBVSxDQUFDUSxXQUFYLENBQXVCO0FBQUUsU0FBQ2YsU0FBUyxDQUFDbkssS0FBWCxHQUFtQmlMO0FBQXJCLE9BQXZCLEVBQStEM0ksT0FBTyxDQUFDTSxXQUF2RSxDQUFOOztBQUVBLFVBQUlvSSxlQUFKLEVBQXFCO0FBQ2pCLGVBQU9OLFVBQVUsQ0FBQzVJLE9BQVgsQ0FBbUIsRUFBRSxHQUFHK0gsSUFBTDtBQUFXLFdBQUNNLFNBQVMsQ0FBQ25LLEtBQVgsR0FBbUJpTDtBQUE5QixTQUFuQixFQUFvRSxJQUFwRSxFQUEwRTNJLE9BQU8sQ0FBQ00sV0FBbEYsQ0FBUDtBQUNIOztBQUVELFlBQU0sSUFBSTlCLEtBQUosQ0FBVSw2REFBVixDQUFOO0FBR0gsS0E5RGUsQ0FBaEI7QUFnRUEsV0FBTzBKLGFBQVA7QUFDSDs7QUE5dUJzQzs7QUFpdkIzQ1ksTUFBTSxDQUFDQyxPQUFQLEdBQWlCM0wsZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKCdsdXhvbicpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKCcuLi8uLi9FbnRpdHlNb2RlbCcpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBWYWxpZGF0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvRXJyb3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL3R5cGVzJyk7XG5jb25zdCB7IGdldFZhbHVlRnJvbSB9ID0gcmVxdWlyZSgnLi4vLi4vdXRpbHMvbGFuZycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgIFxuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdOT1cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydDogJyArIG5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0geyp9IGluZm8gXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuREFURVRJTUUuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdhcnJheScgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX05PX1JFRkVSRU5DRURfUk9XXzInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoJ1RoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6ICcgKyBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSAnRVJfRFVQX0VOVFJZJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6ICcgKyBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSAnRVJfRFVQX0VOVFJZJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG4gICAgICAgICAgICBcbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH0gICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sIFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5IFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHsgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IFxuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFsnJHJldHJpZXZlVXBkYXRlZCcsICckYnlwYXNzRW5zdXJlVW5pcXVlJ10pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfTsgICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IHsgLi4uY29udGV4dC5yZXR1cm4sIC4uLmNvbnRleHQucXVlcnlLZXkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDsgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4uY29uZGl0aW9uLCAuLi5yZXRyaWV2ZU9wdGlvbnMsICRpbmNsdWRlRGVsZXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCAkaW5jbHVkZURlbGV0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICApIDoge30pICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZignLicpOyAgICAgICAgXG4gICAgICAgIGxldCByZXN1bHQ7ICBcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHsgICAgICAgICBcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9OyAgIFxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcysxKTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyAnLicgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCBlbnRpdHlOYW1lIF0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoJy4nLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7ICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyAnLicgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDsgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSkge1xuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307ICAgICAgICBcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjsgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXkgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXkpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oJy4nKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke3NlbGYubWV0YS5uYW1lfVwiIHNob3VsZCBiZSBhIGxpc3QuYCwgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iaiBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmogICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKVxuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKCcuJyl9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtzZWxmLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBleGlzdC5gLCB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleV0gPSBzdWJJbmRleDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9ICc6JyArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0IFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkgeyAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4XG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7ICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gJ0EnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZSBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHsgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSBzdWJPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocmVzdWx0LCBub2RlUGF0aCwgc3ViT2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpOyAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdCwgXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSlcbiAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LCBhc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIFxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aCgnOicpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICAgICAgaWYgKChhc3NvY01ldGEudHlwZSA9PT0gJ3JlZmVyc1RvJyB8fCBhc3NvY01ldGEudHlwZSA9PT0gJ2JlbG9uZ3NUbycpICYmIChhbmNob3IgaW4gZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gZGF0YSBcIjoke2xvY2FsRmllbGR9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7bG9jYWxGaWVsZH1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIFsgcmF3LCBhc3NvY3MgXTsgICAgICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuICAgICAgICBcbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ3JlZmVyc1RvJyAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAvL2hhc01hbnkgb3IgaGFzT25lXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH07XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTsgIFxuXG4gICAgICAgICAgICBmaW5pc2hlZFthbmNob3JdID0gYmVmb3JlRW50aXR5Q3JlYXRlID8gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdIDogY3JlYXRlZFthc3NvY01ldGEua2V5XTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgZmluaXNoZWQsIHBlbmRpbmdBc3NvY3MgXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlVcGRhdGUsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBsZXQgY3VycmVudEtleVZhbHVlO1xuXG4gICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgY3VycmVudEtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgICAgICBpZiAoXy5pc05pbChjdXJyZW50S2V5VmFsdWUpKSB7IC8vIHNob3VsZCBoYXZlIGluIHVwZGF0aW5nXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eVVwZGF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ3JlZmVyc1RvJyAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIGl0ZW0gPT4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUbyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGRlc3RFbnRpdHlJZCA9IGdldFZhbHVlRnJvbShbY29udGV4dC5leGlzdGluZywgY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yYXddLCBhbmNob3IpOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0V4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oZGF0YSwgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oeyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZCcpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19
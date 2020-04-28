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

        if (!_.isEmpty(context.existing)) {
          throw new ApplicationError('Existing does not contain the referenced entity id.');
        }

        if (destEntityId == null) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiVmFsaWRhdGlvbkVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJnZXRWYWx1ZUZyb20iLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJEQVRFVElNRSIsInNlcmlhbGl6ZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4Iiwic2VsZiIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwiY3VycmVudFBhdGgiLCJjb25jYXQiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwicmVkdWNlIiwiY29sIiwidGFibGUiLCJidWNrZXQiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJhc3NvY01ldGEiLCJsb2NhbEZpZWxkIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiY3JlYXRlZCIsIl91cGRhdGVBc3NvY3NfIiwiYmVmb3JlRW50aXR5VXBkYXRlIiwiZm9yU2luZ2xlUmVjb3JkIiwiY3VycmVudEtleVZhbHVlIiwiZGVsZXRlTWFueV8iLCJkZXN0RW50aXR5SWQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJD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Q0FBZjs7QUFFQSxjQUFJNkMsWUFBWSxJQUFJLElBQXBCLEVBQTBCO0FBQ3RCLGtCQUFNLElBQUk5TCxnQkFBSixDQUFxQixxREFBckIsQ0FBTjtBQUNIO0FBQ0o7O0FBRUQsZUFBT3FMLFVBQVUsQ0FBQ3JJLFVBQVgsQ0FBc0J3SCxJQUF0QixFQUE0QjtBQUFFLFdBQUNNLFNBQVMsQ0FBQ2xLLEtBQVgsR0FBbUJrTDtBQUFyQixTQUE1QixFQUFpRTVJLE9BQU8sQ0FBQ00sV0FBekUsQ0FBUDtBQUNIOztBQUVELFlBQU02SCxVQUFVLENBQUNRLFdBQVgsQ0FBdUI7QUFBRSxTQUFDZixTQUFTLENBQUNsSyxLQUFYLEdBQW1CZ0w7QUFBckIsT0FBdkIsRUFBK0QxSSxPQUFPLENBQUNNLFdBQXZFLENBQU47O0FBRUEsVUFBSW1JLGVBQUosRUFBcUI7QUFDakIsZUFBT04sVUFBVSxDQUFDM0ksT0FBWCxDQUFtQixFQUFFLEdBQUc4SCxJQUFMO0FBQVcsV0FBQ00sU0FBUyxDQUFDbEssS0FBWCxHQUFtQmdMO0FBQTlCLFNBQW5CLEVBQW9FLElBQXBFLEVBQTBFMUksT0FBTyxDQUFDTSxXQUFsRixDQUFQO0FBQ0g7O0FBRUQsWUFBTSxJQUFJOUIsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQTlEZSxDQUFoQjtBQWdFQSxXQUFPeUosYUFBUDtBQUNIOztBQTd1QnNDOztBQWd2QjNDWSxNQUFNLENBQUNDLE9BQVAsR0FBaUIxTCxnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IHsgRGF0ZVRpbWUgfSA9IHJlcXVpcmUoJ2x1eG9uJyk7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoJy4uLy4uL0VudGl0eU1vZGVsJyk7XG5jb25zdCB7IEFwcGxpY2F0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9FcnJvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vdHlwZXMnKTtcbmNvbnN0IHsgZ2V0VmFsdWVGcm9tIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwgeyAgXG4gICAgLyoqXG4gICAgICogW3NwZWNpZmljXSBDaGVjayBpZiB0aGlzIGVudGl0eSBoYXMgYXV0byBpbmNyZW1lbnQgZmVhdHVyZS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7ICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIGtleVBhdGguc3BsaXQoJy4nKS5tYXAocCA9PiAnOicrcCkuam9pbignLicpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuIFxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gJ05PVycpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoJ05PVygpJyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBzdXBwb3J0OiAnICsgbmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7Kn0gaW5mbyBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcbiAgICAgICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IFxuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiBzdXBlci52YWx1ZU9mS2V5KGVudGl0eSkgfSwgXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHkgXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2UgeyAgICAgIFxuICAgICAgICAgICAgb3B0aW9ucyA9IHsgXG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgWyckcmV0cmlldmVVcGRhdGVkJywgJyRieXBhc3NFbnN1cmVVbmlxdWUnXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9OyAgICAgICAgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0OyAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5jb25kaXRpb24sIC4uLnJldHJpZXZlT3B0aW9ucyB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICApIDoge30pICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZignLicpOyAgICAgICAgXG4gICAgICAgIGxldCByZXN1bHQ7ICBcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHsgICAgICAgICBcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9OyAgIFxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcysxKTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGNhY2hlW2Fzc29jXSA9IGJhc2VOb2RlLnN1YkFzc29jc1tsYXN0XSA9IHJlc3VsdDtcbiAgICAgICAgfSAgICAgIFxuXG4gICAgICAgIGlmIChyZXN1bHQuYXNzb2MpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MgKyAnLicgKyByZXN1bHQuYXNzb2MpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCBjdXJyZW50RGIpIHtcbiAgICAgICAgaWYgKGFzc29jLmVudGl0eS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCBlbnRpdHlOYW1lIF0gPSBhc3NvYy5lbnRpdHkuc3BsaXQoJy4nLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7ICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyAnLicgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDsgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSkge1xuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307ICAgICAgICBcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjsgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXkgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXkpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oJy4nKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke3NlbGYubWV0YS5uYW1lfVwiIHNob3VsZCBiZSBhIGxpc3QuYCwgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iaiBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmogICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKVxuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKCcuJyl9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtzZWxmLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBleGlzdC5gLCB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleV0gPSBzdWJJbmRleDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9ICc6JyArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0IFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkgeyAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4XG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7ICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gJ0EnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZSBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHsgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSBzdWJPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocmVzdWx0LCBub2RlUGF0aCwgc3ViT2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpOyAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3Rbc2VsZi5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdCwgXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSlcbiAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHt9LCBhc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIFxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aCgnOicpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW5jaG9yID0gay5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICAgICAgaWYgKChhc3NvY01ldGEudHlwZSA9PT0gJ3JlZmVyc1RvJyB8fCBhc3NvY01ldGEudHlwZSA9PT0gJ2JlbG9uZ3NUbycpICYmIChhbmNob3IgaW4gZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gZGF0YSBcIjoke2xvY2FsRmllbGR9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBjb25mbGljdHMgd2l0aCBpbnB1dCB2YWx1ZSBvZiBmaWVsZCBcIiR7bG9jYWxGaWVsZH1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY3NbYW5jaG9yXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIFsgcmF3LCBhc3NvY3MgXTsgICAgICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlO1xuICAgICAgICBcbiAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdBc3NvY3MgPSB7fTtcbiAgICAgICAgY29uc3QgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ3JlZmVyc1RvJyAmJiBhc3NvY01ldGEudHlwZSAhPT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICBwZW5kaW5nQXNzb2NzW2FuY2hvcl0gPSBkYXRhO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgTWlzc2luZyBcImZpZWxkXCIgcHJvcGVydHkgaW4gdGhlIG1ldGFkYXRhIG9mIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9LCBjb250ZXh0Lm9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmFzc29jKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlICYmIGFzc29jTWV0YS5maWVsZCkge1xuICAgICAgICAgICAgICAgIC8vaGFzTWFueSBvciBoYXNPbmVcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGZpbmlzaGVkLCBwZW5kaW5nQXNzb2NzIF07XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5VXBkYXRlLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgbGV0IGN1cnJlbnRLZXlWYWx1ZTtcblxuICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGN1cnJlbnRLZXlWYWx1ZSA9IGdldFZhbHVlRnJvbShbY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5yZXR1cm5dLCB0aGlzLm1ldGEua2V5RmllbGQpO1xuICAgICAgICAgICAgaWYgKF8uaXNOaWwoY3VycmVudEtleVZhbHVlKSkgeyAvLyBzaG91bGQgaGF2ZSBpbiB1cGRhdGluZ1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09ICdyZWZlcnNUbycgJiYgYXNzb2NNZXRhLnR5cGUgIT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgcGVuZGluZ0Fzc29jc1thbmNob3JdID0gZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgYXNzb2NNb2RlbC5kZWxldGVNYW55Xyh7IFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9jb25uZWN0ZWQgYnlcbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmVmb3JlRW50aXR5VXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgLy9yZWZlcnNUbyBvciBiZWxvbmdzVG8gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC4nKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlJZCA9IGNvbnRleHQuZXhpc3RpbmdbYW5jaG9yXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eUlkID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oZGF0YSwgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oeyBbYXNzb2NNZXRhLmZpZWxkXTogY3VycmVudEtleVZhbHVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd1cGRhdGUgYXNzb2NpYXRlZCBkYXRhIGZvciBtdWx0aXBsZSByZWNvcmRzIG5vdCBpbXBsZW1lbnRlZCcpO1xuXG4gICAgICAgICAgICAvL3JldHVybiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19
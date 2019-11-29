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
  RequestError
} = require('../../Errors');

const Types = require('../../types');

class MySQLEntityModel extends EntityModel {
  static get hasAutoIncrement() {
    let autoId = this.meta.features.autoId;
    return autoId && this.meta.fields[autoId.field].autoIncrementId;
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath.split('.').map(p => ':' + p).join('.'));
  }

  static _translateSymbolToken(name) {
    if (name === 'now') {
      return this.db.connector.raw('NOW()');
    }

    throw new Error('not support');
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

    if (info.type === 'datetime' && value instanceof DateTime) {
      return value.toISO({
        includeOffset: false
      });
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
        throw new RequestError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
        throw new RequestError(error.message + ` while creating a new "${this.meta.name}".`);
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
        throw new RequestError('The entity to be updated is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
        throw new RequestError(error.message + ` while updating an existing "${this.meta.name}".`);
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
          [this.meta.keyField]: this.valueOfKey(entity)
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
        throw new RequestError(`Entity "${this.meta.name}" does not have the association "${assoc}".`);
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
        throw new RequestError(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
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

      if (!app) {
        throw new ApplicationError('Cross db association requires the db object have access to other db object.');
      }

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
          subObject = rowObject[objKey] = null;
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
      let rowKey = rowObject[this.meta.keyField];
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
    let raw = {},
        assocs = {};

    _.forOwn(data, (v, k) => {
      if (k.startsWith(':')) {
        assocs[k.substr(1)] = v;
      } else {
        raw[k] = v;
      }
    });

    return [raw, assocs];
  }

  static async _createAssocs_(context, assocs) {
    let meta = this.meta.associations;
    let keyValue = context.return[this.meta.keyField];

    if (_.isNil(keyValue)) {
      throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
    }

    return eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (!assocMeta) {
        throw new ApplicationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
      }

      let assocModel = this.db.model(assocMeta.entity);

      if (assocMeta.list) {
        data = _.castArray(data);
        return eachAsync_(data, item => assocModel.create_({ ...item,
          ...(assocMeta.field ? {
            [assocMeta.field]: keyValue
          } : {})
        }, context.options, context.connOptions));
      } else if (!_.isPlainObject(data)) {
        if (Array.isArray(data)) {
          throw new RequestError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
        }

        if (!assocMeta.assoc) {
          throw new ApplicationError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
        }

        data = {
          [assocMeta.assoc]: data
        };
      }

      return assocModel.create_({ ...data,
        ...(assocMeta.field ? {
          [assocMeta.field]: keyValue
        } : {})
      }, context.options, context.connOptions);
    });
  }

  static async _updateAssocs_(context, assocs) {
    let meta = this.meta.associations;
    let keyValue = context.return[this.meta.keyField];

    if (_.isNil(keyValue)) {
      throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
    }

    return eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (!assocMeta) {
        throw new ApplicationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
      }

      let assocModel = this.db.model(assocMeta.entity);

      if (assocMeta.list) {
        data = _.castArray(data);
        return eachAsync_(data, item => assocModel.replaceOne_({ ...item,
          ...(assocMeta.field ? {
            [assocMeta.field]: keyValue
          } : {})
        }, null, context.connOptions));
      } else if (!_.isPlainObject(data)) {
        if (Array.isArray(data)) {
          throw new RequestError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
        }

        if (!assocMeta.assoc) {
          throw new ApplicationError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
        }

        data = {
          [assocMeta.assoc]: data
        };
      }

      return assocModel.replaceOne_({ ...data,
        ...(assocMeta.field ? {
          [assocMeta.field]: keyValue
        } : {})
      }, null, context.connOptions);
    });
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJSZXF1ZXN0RXJyb3IiLCJUeXBlcyIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJzZXJpYWxpemUiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4Iiwic2VsZiIsIm1lcmdlUmVjb3JkIiwiZXhpc3RpbmdSb3ciLCJyb3dPYmplY3QiLCJub2RlUGF0aCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwiY3VycmVudFBhdGgiLCJjb25jYXQiLCJwdXNoIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwicmVkdWNlIiwiY29sIiwidGFibGUiLCJidWNrZXQiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJfY3JlYXRlQXNzb2NzXyIsImtleVZhbHVlIiwiYXNzb2NNZXRhIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJfdXBkYXRlQXNzb2NzXyIsInJlcGxhY2VPbmVfIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUVBLE1BQU07QUFBRU0sRUFBQUE7QUFBRixJQUFlTCxPQUFPLENBQUMsT0FBRCxDQUE1Qjs7QUFDQSxNQUFNTSxXQUFXLEdBQUdOLE9BQU8sQ0FBQyxtQkFBRCxDQUEzQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFxQ1IsT0FBTyxD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QUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuXG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKCdsdXhvbicpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKCcuLi8uLi9FbnRpdHlNb2RlbCcpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBSZXF1ZXN0RXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgIFxuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0geyp9IGluZm8gXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnICYmIHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVxdWVzdEVycm9yKCdUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVxdWVzdEVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVxdWVzdEVycm9yKCdUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlcXVlc3RFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuICAgICAgICAgICAgXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9ucyA9IHsgXG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudmFsdWVPZktleShlbnRpdHkpIH0sIFxuICAgICAgICAgICAgICAgICRleGlzdGluZzogZW50aXR5IFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHsgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IFxuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFsnJHJldHJpZXZlVXBkYXRlZCcsICckYnlwYXNzRW5zdXJlVW5pcXVlJ10pLFxuICAgICAgICAgICAgICAgICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfTsgICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0ID0gYXdhaXQgdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCBvcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA6IHt9O1xuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQucXVlcnlLZXkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IHsgLi4uY29udGV4dC5yZXR1cm4sIC4uLmNvbnRleHQucXVlcnlLZXkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDsgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSkgfTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4uY29uZGl0aW9uLCAuLi5yZXRyaWV2ZU9wdGlvbnMgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LnJldHVybik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb25kaXRpb24uJHF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBmaW5kT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHsgXG4gICAgICAgIGxldCBhc3NvY2lhdGlvbnMgPSBfLnVuaXEoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKS5zb3J0KCk7ICAgICAgICBcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSwgY291bnRlciA9IDAsIGNhY2hlID0ge307ICAgICAgIFxuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgdGhpcy5kYi5zY2hlbWFOYW1lKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSAnOmpvaW4nICsgKytjb3VudGVyO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jVGFibGVbYWxpYXNdID0geyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBhc3NvYy5lbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSwgXG4gICAgICAgICAgICAgICAgICAgIG91dHB1dDogYXNzb2Mub3V0cHV0LFxuICAgICAgICAgICAgICAgICAgICBrZXk6IGFzc29jLmtleSxcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMsXG4gICAgICAgICAgICAgICAgICAgIG9uOiBhc3NvYy5vbixcbiAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmRhdGFzZXQgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IHt9KSAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoJy4nKTsgICAgICAgIFxuICAgICAgICBsZXQgcmVzdWx0OyAgXG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7ICAgICAgICAgXG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTsgICBcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZXF1ZXN0RXJyb3IoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MrMSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZXF1ZXN0RXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgJy4nICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgZW50aXR5TmFtZSBdID0gYXNzb2MuZW50aXR5LnNwbGl0KCcuJywgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcbiAgICAgICAgICAgIGlmICghYXBwKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoJ0Nyb3NzIGRiIGFzc29jaWF0aW9uIHJlcXVpcmVzIHRoZSBkYiBvYmplY3QgaGF2ZSBhY2Nlc3MgdG8gb3RoZXIgZGIgb2JqZWN0LicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7ICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyAnLicgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDsgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSkge1xuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307ICAgICAgICBcbiAgICAgICAgbGV0IHNlbGYgPSB0aGlzO1xuXG4gICAgICAgIGZ1bmN0aW9uIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGFzc29jaWF0aW9ucywgbm9kZVBhdGgpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjsgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV07XG5cbiAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iaikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ZXMgPSBleGlzdGluZ1Jvdy5zdWJJbmRleGVzW29iaktleV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gam9pbmVkIGFuIGVtcHR5IHJlY29yZFxuICAgICAgICAgICAgICAgIGxldCByb3dLZXkgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXkpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdTdWJSb3cgPSBzdWJJbmRleGVzICYmIHN1YkluZGV4ZXNbcm93S2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdTdWJSb3csIHN1Yk9iaiwgc3ViQXNzb2NzLCBjdXJyZW50UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghbGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdHJ1Y3R1cmUgb2YgYXNzb2NpYXRpb24gXCIke2N1cnJlbnRQYXRoLmpvaW4oJy4nKX1cIiB3aXRoIFtrZXk9JHtrZXl9XSBvZiBlbnRpdHkgXCIke3NlbGYubWV0YS5uYW1lfVwiIHNob3VsZCBiZSBhIGxpc3QuYCwgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iaiBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmogICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iaiwgc3ViQXNzb2NzKVxuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViSW5kZXhlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBzdWJJbmRleGVzIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKCcuJyl9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtzZWxmLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBleGlzdC5gLCB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleV0gPSBzdWJJbmRleDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9ICc6JyArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0IFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkgeyAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pOyAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09ICdBJykge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGUgXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHksIFtdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJyYXlPZk9ianMucHVzaChyb3dPYmplY3QpO1xuICAgICAgICAgICAgICAgIG1haW5JbmRleFtyb3dLZXldID0geyBcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0LCBcbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KVxuICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXJyYXlPZk9ianM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgbGV0IHJhdyA9IHt9LCBhc3NvY3MgPSB7fTtcbiAgICAgICAgXG4gICAgICAgIF8uZm9yT3duKGRhdGEsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoay5zdGFydHNXaXRoKCc6JykpIHtcbiAgICAgICAgICAgICAgICBhc3NvY3Nbay5zdWJzdHIoMSldID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmF3W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gWyByYXcsIGFzc29jcyBdOyAgICAgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgaXRlbSA9PiBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBjb250ZXh0Lm9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIV8uaXNQbGFpbk9iamVjdChkYXRhKSkge1xuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZXF1ZXN0RXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgaWYgKF8uaXNOaWwoa2V5VmFsdWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignTWlzc2luZyByZXF1aXJlZCBwcmltYXJ5IGtleSBmaWVsZCB2YWx1ZS4gRW50aXR5OiAnICsgdGhpcy5tZXRhLm5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oYXNzb2NzLCBhc3luYyAoZGF0YSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICBsZXQgYXNzb2NNZXRhID0gbWV0YVthbmNob3JdO1xuICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBhc3NvY01vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvY01ldGEuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgZGF0YSA9IF8uY2FzdEFycmF5KGRhdGEpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgaXRlbSA9PiBhc3NvY01vZGVsLnJlcGxhY2VPbmVfKHsgLi4uaXRlbSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgbnVsbCwgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlcXVlc3RFcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsOyJdfQ==
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
  InvalidArgument
} = require('../../utils/Errors');

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

  static async _createAssocs_(context, assocs, beforeEntityCreate) {
    let meta = this.meta.associations;
    let keyValue;

    if (!beforeEntityCreate) {
      keyValue = context.return[this.meta.keyField];

      if (_.isNil(keyValue)) {
        throw new ApplicationError('Missing required primary key field value. Entity: ' + this.meta.name);
      }
    }

    let pendingAssocs = {};
    let finished = {};
    await eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (!assocMeta) {
        throw new ApplicationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
      }

      if (!beforeEntityCreate || assocMeta.type !== 'refersTo' && assocMeta.type !== 'belongsTo') {
        pendingAssocs[anchor] = data;
        return;
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
      finished[anchor] = created[assocMeta.field];
    });
    return [finished, pendingAssocs];
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
          throw new ApplicationError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIkFwcGxpY2F0aW9uRXJyb3IiLCJEYXRhYmFzZUVycm9yIiwiSW52YWxpZEFyZ3VtZW50IiwiVHlwZXMiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiZ2V0TmVzdGVkT2JqZWN0IiwiZW50aXR5T2JqIiwia2V5UGF0aCIsInNwbGl0IiwibWFwIiwicCIsImpvaW4iLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJuYW1lIiwiZGIiLCJjb25uZWN0b3IiLCJyYXciLCJFcnJvciIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInRvSVNPIiwiaW5jbHVkZU9mZnNldCIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiaW5mbyIsInR5cGUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2Iiwic2VyaWFsaXplIiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImluc2VydElkIiwicXVlcnlLZXkiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImxhdGVzdCIsInJldHJpZXZlT3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJyZXR1cm4iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJjb25kaXRpb24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJHJlbGF0aW9uc2hpcHMiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiJHJldHJpZXZlRGVsZXRlZCIsImV4aXN0aW5nIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJmaW5kT3B0aW9ucyIsImFzc29jaWF0aW9ucyIsInVuaXEiLCIkYXNzb2NpYXRpb24iLCJzb3J0IiwiYXNzb2NUYWJsZSIsImNvdW50ZXIiLCJjYWNoZSIsImZvckVhY2giLCJhc3NvYyIsIl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYiIsInNjaGVtYU5hbWUiLCJhbGlhcyIsImpvaW5UeXBlIiwib3V0cHV0Iiwia2V5Iiwib24iLCJkYXRhc2V0IiwiYnVpbGRRdWVyeSIsIm1vZGVsIiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJpc0VtcHR5IiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm1haW5JbmRleCIsInNlbGYiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0Iiwibm9kZVBhdGgiLCJlYWNoIiwic3FsIiwibGlzdCIsImFuY2hvciIsImN1cnJlbnRQYXRoIiwiY29uY2F0IiwicHVzaCIsIm9iaktleSIsInN1Yk9iaiIsInN1YkluZGV4ZXMiLCJyb3dLZXkiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsInJlZHVjZSIsImNvbCIsInRhYmxlIiwiYnVja2V0IiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJkYXRhIiwiYXNzb2NzIiwiZm9yT3duIiwidiIsImsiLCJzdGFydHNXaXRoIiwiX2NyZWF0ZUFzc29jc18iLCJiZWZvcmVFbnRpdHlDcmVhdGUiLCJrZXlWYWx1ZSIsInBlbmRpbmdBc3NvY3MiLCJmaW5pc2hlZCIsImFzc29jTWV0YSIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwiY3JlYXRlZCIsIl91cGRhdGVBc3NvY3NfIiwicmVwbGFjZU9uZV8iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBRUEsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxD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SixDQUFzQixzQ0FBcUNnTCxTQUFTLENBQUMvSCxNQUFPLDBCQUF5QixLQUFLMUMsSUFBTCxDQUFVYSxJQUFLLHNDQUFxQzBILE1BQU8sbUNBQWhLLENBQU47QUFDSDs7QUFFRCxZQUFJLENBQUNrQyxTQUFTLENBQUM3RSxLQUFmLEVBQXNCO0FBQ2xCLGdCQUFNLElBQUluRyxnQkFBSixDQUFzQixxQ0FBb0M4SSxNQUFPLDJDQUFqRSxDQUFOO0FBQ0g7O0FBRUR1QixRQUFBQSxJQUFJLEdBQUc7QUFBRSxXQUFDVyxTQUFTLENBQUM3RSxLQUFYLEdBQW1Ca0U7QUFBckIsU0FBUDtBQUNIOztBQUVELGFBQU9ZLFVBQVUsQ0FBQ0ssV0FBWCxDQUF1QixFQUFFLEdBQUdqQixJQUFMO0FBQVcsWUFBSVcsU0FBUyxDQUFDdEssS0FBVixHQUFrQjtBQUFFLFdBQUNzSyxTQUFTLENBQUN0SyxLQUFYLEdBQW1CbUs7QUFBckIsU0FBbEIsR0FBb0QsRUFBeEQ7QUFBWCxPQUF2QixFQUFpRyxJQUFqRyxFQUF1RzlILE9BQU8sQ0FBQ00sV0FBL0csQ0FBUDtBQUNILEtBekJnQixDQUFqQjtBQTBCSDs7QUFockJzQzs7QUFtckIzQ2tJLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBMLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuXG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKCdsdXhvbicpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKCcuLi8uLi9FbnRpdHlNb2RlbCcpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yLCBJbnZhbGlkQXJndW1lbnQgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgIFxuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0geyp9IGluZm8gXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnICYmIHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YWJhc2VFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhYmFzZUVycm9yKCdUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFiYXNlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcbiAgICAgICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IFxuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnZhbHVlT2ZLZXkoZW50aXR5KSB9LCBcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSBcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7ICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbJyRyZXRyaWV2ZVVwZGF0ZWQnLCAnJGJ5cGFzc0Vuc3VyZVVuaXF1ZSddKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH07ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7ICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLmNvbmRpdGlvbiwgLi4ucmV0cmlldmVPcHRpb25zIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7IFxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpOyAgICAgICAgXG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sIGNvdW50ZXIgPSAwLCBjYWNoZSA9IHt9OyAgICAgICBcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIHRoaXMuZGIuc2NoZW1hTmFtZSk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gJzpqb2luJyArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsIFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0ID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiB7fSkgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKCcuJyk7ICAgICAgICBcbiAgICAgICAgbGV0IHJlc3VsdDsgIFxuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkgeyAgICAgICAgIFxuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07ICAgXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zKzEpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYmFzZU5vZGUgPSBjYWNoZVtiYXNlXTtcbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgYmFzZU5vZGUgPSB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGJhc2UpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gYmFzZU5vZGUubW9kZWwgfHwgdGhpcy5kYi5tb2RlbChiYXNlTm9kZS5lbnRpdHkpO1xuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgSW52YWxpZEFyZ3VtZW50KGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpOyAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG4gICAgICAgIGxldCBzZWxmID0gdGhpcztcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47ICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gbm9kZVBhdGguY29uY2F0KCk7XG4gICAgICAgICAgICAgICAgY3VycmVudFBhdGgucHVzaChhbmNob3IpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9ICc6JyArIGFuY2hvcjsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleGVzID0gZXhpc3RpbmdSb3cuc3ViSW5kZXhlc1tvYmpLZXldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5ID0gc3ViT2JqW2tleV07XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwocm93S2V5KSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcywgY3VycmVudFBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKCcuJyl9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtzZWxmLm1ldGEubmFtZX1cIiBzaG91bGQgYmUgYSBsaXN0LmAsIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gWyBzdWJPYmogXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcylcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbignLicpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7c2VsZi5tZXRhLm5hbWV9XCIgZG9lcyBub3QgZXhpc3QuYCwgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3N1Yk9iamVjdCBub3QgZXhpc3QsIGp1c3QgZmlsbGVkIHdpdGggbnVsbCBieSBqb2luaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gWyBzdWJPYmplY3QgXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXhcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTsgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSAnQScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlIFxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG5vZGVQYXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHsgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSBzdWJPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocmVzdWx0LCBub2RlUGF0aCwgc3ViT2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpOyAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3RbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdCwgXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSlcbiAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIGxldCByYXcgPSB7fSwgYXNzb2NzID0ge307XG4gICAgICAgIFxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aCgnOicpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2NzW2suc3Vic3RyKDEpXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIFsgcmF3LCBhc3NvY3MgXTsgICAgICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MsIGJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcbiAgICAgICAgXG4gICAgICAgIGlmICghYmVmb3JlRW50aXR5Q3JlYXRlKSB7XG4gICAgICAgICAgICBrZXlWYWx1ZSA9IGNvbnRleHQucmV0dXJuW3RoaXMubWV0YS5rZXlGaWVsZF07XG5cbiAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcGVuZGluZ0Fzc29jcyA9IHt9O1xuICAgICAgICBsZXQgZmluaXNoZWQgPSB7fTtcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSB8fCAoYXNzb2NNZXRhLnR5cGUgIT09ICdyZWZlcnNUbycgJiYgYXNzb2NNZXRhLnR5cGUgIT09ICdiZWxvbmdzVG8nKSkge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIGl0ZW0gPT4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSAmJiBhc3NvY01ldGEuZmllbGQpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0geyAuLi5kYXRhLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBjcmVhdGVkID0gYXdhaXQgYXNzb2NNb2RlbC5jcmVhdGVfKGRhdGEsIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIFsgZmluaXNoZWQsIHBlbmRpbmdBc3NvY3MgXTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5pdGVtLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsOyJdfQ==
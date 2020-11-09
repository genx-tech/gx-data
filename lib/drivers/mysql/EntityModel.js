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

const EntityModel = require("../../EntityModel");

const {
  ApplicationError,
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
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? { ...context.options.$retrieveDeleted,
        $query: context.options.$query
      } : {
        $query: context.options.$query
      };

      if (context.options.$physicalDeletion) {
        retrieveOptions.$includeDeleted = true;
      }

      context.return = context.existing = await this.findOne_(retrieveOptions, context.connOptions);
    }

    return true;
  }

  static async _internalBeforeDeleteMany_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? { ...context.options.$retrieveDeleted,
        $query: context.options.$query
      } : {
        $query: context.options.$query
      };

      if (context.options.$physicalDeletion) {
        retrieveOptions.$includeDeleted = true;
      }

      context.return = context.existing = await this.findAll_(retrieveOptions, context.connOptions);
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
        assoc = this._translateSchemaNameToDb(assoc);
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
          assocs = {},
          refs = {};
    const meta = this.meta.associations;

    _.forOwn(data, (v, k) => {
      if (k[0] === ":") {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if (isNew && (assocMeta.type === "refersTo" || assocMeta.type === "belongsTo") && anchor in data) {
          throw new ValidationError(`Association data ":${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`);
        }

        assocs[anchor] = v;
      } else if (k[0] === "@") {
        const anchor = k.substr(1);
        const assocMeta = meta[anchor];

        if (!assocMeta) {
          throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
        }

        if (assocMeta.type !== "refersTo" && assocMeta.type !== "belongsTo") {
          throw new ValidationError(`Association type "${assocMeta.type}" cannot be used for update by reference.`, {
            entity: this.meta.name,
            data
          });
        }

        if (isNew && anchor in data) {
          throw new ValidationError(`Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`);
        }

        const assocAnchor = ":" + anchor;

        if (assocAnchor in data) {
          throw new ValidationError(`Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with association data "${assocAnchor}".`);
        }

        if (v == null) {
          raw[anchor] = null;
        } else {
          refs[anchor] = v;
        }
      } else {
        raw[k] = v;
      }
    });

    return [raw, assocs, refs];
  }

  static async _populateReferences_(context, references) {
    const meta = this.meta.associations;
    await eachAsync_(references, async (refQuery, anchor) => {
      const assocMeta = meta[anchor];
      const ReferencedEntity = this.db.model(assocMeta.entity);

      if (!!assocMeta.list) {
        throw new Error("Assertion failed: !assocMeta.list");
      }

      let created = await ReferencedEntity.findOne_(refQuery, context.connOptions);

      if (!created) {
        throw new ReferencedNotExistError(`Referenced entity "${ReferencedEntity.meta.name}" with ${JSON.stringify(refQuery)} not exist.`);
      }

      context.raw[anchor] = created[assocMeta.field];
    });
  }

  static async _createAssocs_(context, assocs, beforeEntityCreate) {
    const meta = this.meta.associations;
    let keyValue;

    if (!beforeEntityCreate) {
      keyValue = context.return[this.meta.keyField];

      if (_.isNil(keyValue)) {
        if (context.result.affectedRows === 0) {
          const query = this.getUniqueKeyValuePairsFrom(context.return);
          context.return = await this.findOne_({
            $query: query
          }, context.connOptions);
        }

        keyValue = context.return[this.meta.keyField];

        if (_.isNil(keyValue)) {
          throw new ApplicationError("Missing required primary key field value. Entity: " + this.meta.name, {
            data: context.return,
            associations: assocs
          });
        }
      }
    }

    const pendingAssocs = {};
    const finished = {};

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables"]);

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

    if (beforeEntityCreate) {
      _.forOwn(finished, (refFieldValue, localField) => {
        context.raw[localField] = refFieldValue;
      });
    }

    return pendingAssocs;
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

    const passOnOptions = _.pick(context.options, ["$skipModifiers", "$migration", "$variables"]);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwicmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlQWN0dWFsVXBkYXRlZCIsIiRyZXRyaWV2ZU5vdFVwZGF0ZSIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiJHBoeXNpY2FsRGVsZXRpb24iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJhbGlhcyIsImpvaW5UeXBlIiwib3V0cHV0Iiwia2V5Iiwib24iLCJkYXRhc2V0IiwiYnVpbGRRdWVyeSIsIm1vZGVsIiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsInNjaGVtYU5hbWUiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm5lc3RlZEtleUdldHRlciIsIm1hcFZhbHVlcyIsImNoYWluIiwibWFpbkluZGV4Iiwic2VsZiIsImNvbCIsInRhYmxlIiwicG9zIiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsIm5vZGVQYXRoIiwiZWFjaCIsInNxbCIsImxpc3QiLCJjdXJyZW50UGF0aCIsImNvbmNhdCIsInB1c2giLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5VmFsdWUiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJ0YWJsZVRlbXBsYXRlIiwicmVkdWNlIiwicm93IiwiaSIsInRhYmxlQ2FjaGUiLCJidWNrZXQiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwicmVmRmllbGRWYWx1ZSIsImxvY2FsRmllbGQiLCJfdXBkYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eVVwZGF0ZSIsImZvclNpbmdsZVJlY29yZCIsImN1cnJlbnRLZXlWYWx1ZSIsImFzc29jS2V5cyIsInJlY29yZCIsImFzc29jUmVjb3Jkc1RvUmVtb3ZlIiwibGVuZ3RoIiwiJG5vdEluIiwiZGVsZXRlTWFueV8iLCJkZXN0RW50aXR5SWQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTU0sV0FBVyxHQUFHTCxPQUFPLENBQUMsbUJBQUQsQ0FBM0I7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUEsdUJBQXBCO0FBQTZDQyxFQUFBQSxjQUE3QztBQUE2REMsRUFBQUEsZUFBN0Q7QUFBOEVDLEVBQUFBO0FBQTlFLElBQWtHVixPQUFPLENBQUMsb0JBQUQsQ0FBL0c7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVZLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCYixPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTWMsc0JBQXNCLEdBQUlDLE1BQUQsSUFBYSxNQUFNQSxNQUFsRDs7QUFLQSxNQUFNQyxnQkFBTixTQUErQlgsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1ksZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMs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QVgsQ0FDSCxFQUFFLEdBQUcySSxJQUFMO0FBQVcsV0FBQ00sU0FBUyxDQUFDNUssS0FBWCxHQUFtQnFNO0FBQTlCLFNBREcsRUFFSFYsYUFGRyxFQUdIeEosT0FBTyxDQUFDTSxXQUhMLENBQVA7QUFLSDs7QUFFRCxZQUFNLElBQUkzQixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUdILEtBdEhlLENBQWhCO0FBd0hBLFdBQU8ySyxhQUFQO0FBQ0g7O0FBeC9Cc0M7O0FBMi9CM0NvQixNQUFNLENBQUNDLE9BQVAsR0FBaUJwTixnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyItXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZShcIi4uLy4uL0VudGl0eU1vZGVsXCIpO1xuY29uc3QgeyBBcHBsaWNhdGlvbkVycm9yLCBSZWZlcmVuY2VkTm90RXhpc3RFcnJvciwgRHVwbGljYXRlRXJyb3IsIFZhbGlkYXRpb25FcnJvciwgSW52YWxpZEFyZ3VtZW50IH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvRXJyb3JzXCIpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKFwiLi4vLi4vdHlwZXNcIik7XG5jb25zdCB7IGdldFZhbHVlRnJvbSwgbWFwRmlsdGVyIH0gPSByZXF1aXJlKFwiLi4vLi4vdXRpbHMvbGFuZ1wiKTtcblxuY29uc3QgZGVmYXVsdE5lc3RlZEtleUdldHRlciA9IChhbmNob3IpID0+ICgnOicgKyBhbmNob3IpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHtcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmpcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoXG4gICAgICAgICAgICBlbnRpdHlPYmosXG4gICAgICAgICAgICBrZXlQYXRoXG4gICAgICAgICAgICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgICAgICAgICAgIC5tYXAoKHApID0+IFwiOlwiICsgcClcbiAgICAgICAgICAgICAgICAuam9pbihcIi5cIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSBcIk5PV1wiKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KFwiTk9XKClcIik7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydDogXCIgKyBuYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZVxuICAgICAqIEBwYXJhbSB7Kn0gaW5mb1xuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImRhdGV0aW1lXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5EQVRFVElNRS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJhcnJheVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiBcIiArIGVycm9yLm1lc3NhZ2UsIFxuICAgICAgICAgICAgICAgICAgICBlcnJvci5pbmZvXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSBcIkVSX0RVUF9FTlRSWVwiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IER1cGxpY2F0ZUVycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gLCBlcnJvci5pbmZvKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSBcIkVSX05PX1JFRkVSRU5DRURfUk9XXzJcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBSZWZlcmVuY2VkTm90RXhpc3RFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgXCJUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiBzdXBlci52YWx1ZU9mS2V5KGVudGl0eSkgfSxcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgICAgICAgIC4uLl8ub21pdChjb250ZXh0Lm9wdGlvbnMsIFtcIiRyZXRyaWV2ZVVwZGF0ZWRcIiwgXCIkYnlwYXNzRW5zdXJlVW5pcXVlXCJdKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBvcHRpb25zLiRleGlzdGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gb3B0aW9ucy4kcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29udGV4dC5xdWVyeUtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKCdDYW5ub3QgZXh0cmFjdCB1bmlxdWUga2V5cyBmcm9tIGlucHV0IGRhdGEuJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZClcbiAgICAgICAgICAgICAgICA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXG4gICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGlmIChjb250ZXh0LnJlc3VsdC5hZmZlY3RlZFJvd3MgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3QgPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG5cbiAgICAgICAgaWYgKCFyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlQWN0dWFsVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGUgJiYgY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVOb3RVcGRhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20ob3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBvcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRPbmVfKFxuICAgICAgICAgICAgICAgIHsgLi4uY29uZGl0aW9uLCAkaW5jbHVkZURlbGV0ZWQ6IG9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgLi4ucmV0cmlldmVPcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBhZnRlclVwZGF0ZU1hbnkgUmVzdWx0U2V0SGVhZGVyIHtcbiAgICAgICAgICAgICAqIGZpZWxkQ291bnQ6IDAsXG4gICAgICAgICAgICAgKiBhZmZlY3RlZFJvd3M6IDEsXG4gICAgICAgICAgICAgKiBpbnNlcnRJZDogMCxcbiAgICAgICAgICAgICAqIGluZm86ICdSb3dzIG1hdGNoZWQ6IDEgIENoYW5nZWQ6IDEgIFdhcm5pbmdzOiAwJyxcbiAgICAgICAgICAgICAqIHNlcnZlclN0YXR1czogMyxcbiAgICAgICAgICAgICAqIHdhcm5pbmdTdGF0dXM6IDAsXG4gICAgICAgICAgICAgKiBjaGFuZ2VkUm93czogMSB9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gb3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgICAgIC4uLnJldHJpZXZlT3B0aW9ucywgICAgICAgXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IG9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyB7IC4uLmNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfVxuICAgICAgICAgICAgICAgIDogeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgfSAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpXG4gICAgICAgICAgICAgICAgPyB7IC4uLmNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfVxuICAgICAgICAgICAgICAgIDogeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgfSAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0XG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBmaW5kT3B0aW9uc1xuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykge1xuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpO1xuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LFxuICAgICAgICAgICAgY291bnRlciA9IDAsXG4gICAgICAgICAgICBjYWNoZSA9IHt9O1xuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSwgbmVzdGVkS2V5R2V0dGVyKSB7XG4gICAgICAgIG5lc3RlZEtleUdldHRlciA9PSBudWxsICYmIChuZXN0ZWRLZXlHZXR0ZXIgPSBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyKTsgICAgICAgIFxuICAgICAgICBhbGlhc01hcCA9IF8ubWFwVmFsdWVzKGFsaWFzTWFwLCBjaGFpbiA9PiBjaGFpbi5tYXAoYW5jaG9yID0+IG5lc3RlZEtleUdldHRlcihhbmNob3IpKSk7XG5cbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9O1xuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgY29sdW1ucyA9IGNvbHVtbnMubWFwKGNvbCA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIlwiKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcG9zID0gY29sLm5hbWUuaW5kZXhPZignJCcpO1xuICAgICAgICAgICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZTogY29sLm5hbWUuc3Vic3RyKDAsIHBvcyksXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZS5zdWJzdHIocG9zKzEpXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHRhYmxlOiAnQScsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB0YWJsZTogY29sLnRhYmxlLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KTtcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcywgY3VycmVudFBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN0cnVjdHVyZSBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgc2hvdWxkIGJlIGEgbGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmosXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcyk7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgZG9lcyBub3QgZXhpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdID0gc3ViSW5kZXg7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldO1xuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqZWN0XTtcblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKlxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy93aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWQgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IC8qZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy9yb3dPYmplY3Rbb2JqS2V5XSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XSA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4LFxuICAgICAgICAgICAgICAgICAgICB9IDoge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIFtjb2wudGFibGUsIGNvbC5uYW1lXSwgbnVsbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7IC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwgcm93T2JqZWN0KTtcblxuICAgICAgICAgICAgXy5mb3JPd24odGFibGVDYWNoZSwgKG9iaiwgdGFibGUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFt0YWJsZV07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9LFxuICAgICAgICAgICAgcmVmcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09IFwiOlwiKSB7XG4gICAgICAgICAgICAgICAgLy9jYXNjYWRlIHVwZGF0ZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgKGFzc29jTWV0YS50eXBlID09PSBcInJlZmVyc1RvXCIgfHwgYXNzb2NNZXRhLnR5cGUgPT09IFwiYmVsb25nc1RvXCIpICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gZGF0YSBcIjoke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa1swXSA9PT0gXCJAXCIpIHtcbiAgICAgICAgICAgICAgICAvL3VwZGF0ZSBieSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gdHlwZSBcIiR7YXNzb2NNZXRhLnR5cGV9XCIgY2Fubm90IGJlIHVzZWQgZm9yIHVwZGF0ZSBieSByZWZlcmVuY2UuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NBbmNob3IgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NBbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGFzc29jaWF0aW9uIGRhdGEgXCIke2Fzc29jQW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodiA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhd1thbmNob3JdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWZzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3MsIHJlZnNdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18ocmVmZXJlbmNlcywgYXN5bmMgKHJlZlF1ZXJ5LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGNvbnN0IFJlZmVyZW5jZWRFbnRpdHkgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6ICFhc3NvY01ldGEubGlzdDtcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBSZWZlcmVuY2VkRW50aXR5LmZpbmRPbmVfKHJlZlF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKGBSZWZlcmVuY2VkIGVudGl0eSBcIiR7UmVmZXJlbmNlZEVudGl0eS5tZXRhLm5hbWV9XCIgd2l0aCAke0pTT04uc3RyaW5naWZ5KHJlZlF1ZXJ5KX0gbm90IGV4aXN0LmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBxdWVyeSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5yZXR1cm4sXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jc1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG4gICAgICAgIGNvbnN0IGZpbmlzaGVkID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5VXBkYXRlLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgbGV0IGN1cnJlbnRLZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgY3VycmVudEtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgICAgICBpZiAoXy5pc05pbChjdXJyZW50S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgLy8gc2hvdWxkIGhhdmUgaW4gdXBkYXRpbmdcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihkYXRhLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTsgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oYXNzb2NSZWNvcmRzVG9SZW1vdmUsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+IGl0ZW1bYXNzb2NNZXRhLmtleV0gIT0gbnVsbCA/XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk6XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUb1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5leGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwgeyBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5SWQgPSBjb250ZXh0LmV4aXN0aW5nW2FuY2hvcl07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsICYmICEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnlcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkLCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9ub3RoaW5nIHRvIGRvIGZvciBudWxsIGRlc3QgZW50aXR5IGlkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidXBkYXRlIGFzc29jaWF0ZWQgZGF0YSBmb3IgbXVsdGlwbGUgcmVjb3JkcyBub3QgaW1wbGVtZW50ZWRcIik7XG5cbiAgICAgICAgICAgIC8vcmV0dXJuIGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5kYXRhLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7XG4iXX0=
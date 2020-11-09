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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kcml2ZXJzL215c3FsL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIlV0aWwiLCJyZXF1aXJlIiwiXyIsImdldFZhbHVlQnlQYXRoIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRW50aXR5TW9kZWwiLCJBcHBsaWNhdGlvbkVycm9yIiwiUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IiLCJEdXBsaWNhdGVFcnJvciIsIlZhbGlkYXRpb25FcnJvciIsIkludmFsaWRBcmd1bWVudCIsIlR5cGVzIiwiZ2V0VmFsdWVGcm9tIiwibWFwRmlsdGVyIiwiZGVmYXVsdE5lc3RlZEtleUdldHRlciIsImFuY2hvciIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJ2YWx1ZSIsImluZm8iLCJ0eXBlIiwiREFURVRJTUUiLCJzZXJpYWxpemUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2IiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImVuc3VyZVRyYW5zYWN0aW9uXyIsImVudGl0eSIsImZpbmRPbmVfIiwiJHF1ZXJ5Iiwib3B0aW9ucyIsImNvbm5PcHRpb25zIiwicmV0IiwiJHJldHJpZXZlRXhpc3RpbmciLCJyYXdPcHRpb25zIiwiJGV4aXN0aW5nIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5Iiwib21pdCIsIiRyZXRyaWV2ZUNyZWF0ZWQiLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCIkcmV0cmlldmVEYlJlc3VsdCIsInJlc3VsdCIsImFmZmVjdGVkUm93cyIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJpc0VtcHR5IiwiaW5zZXJ0SWQiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwicmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlQWN0dWFsVXBkYXRlZCIsIiRyZXRyaWV2ZU5vdFVwZGF0ZSIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiZmluZEFsbF8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVfIiwiJHBoeXNpY2FsRGVsZXRpb24iLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJzY2hlbWFOYW1lIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsInN1YkFzc29jcyIsImN1cnJlbnREYiIsImluZGV4T2YiLCJlbnRpdHlOYW1lIiwiYXBwIiwicmVmRGIiLCJkYXRhYmFzZSIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicm93cyIsImNvbHVtbnMiLCJhbGlhc01hcCIsImhpZXJhcmNoeSIsIm5lc3RlZEtleUdldHRlciIsIm1hcFZhbHVlcyIsImNoYWluIiwibWFpbkluZGV4Iiwic2VsZiIsImNvbCIsInRhYmxlIiwicG9zIiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsIm5vZGVQYXRoIiwiZWFjaCIsInNxbCIsImxpc3QiLCJjdXJyZW50UGF0aCIsImNvbmNhdCIsInB1c2giLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5VmFsdWUiLCJpc05pbCIsImV4aXN0aW5nU3ViUm93Iiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJ0YWJsZVRlbXBsYXRlIiwicmVkdWNlIiwicm93IiwiaSIsInRhYmxlQ2FjaGUiLCJidWNrZXQiLCJmb3JPd24iLCJvYmoiLCJyb3dLZXkiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJpc05ldyIsImFzc29jcyIsInJlZnMiLCJ2IiwiayIsImFzc29jTWV0YSIsImFzc29jQW5jaG9yIiwiX3BvcHVsYXRlUmVmZXJlbmNlc18iLCJyZWZlcmVuY2VzIiwicmVmUXVlcnkiLCJSZWZlcmVuY2VkRW50aXR5IiwiY3JlYXRlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJfY3JlYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eUNyZWF0ZSIsImtleVZhbHVlIiwicXVlcnkiLCJwZW5kaW5nQXNzb2NzIiwiZmluaXNoZWQiLCJwYXNzT25PcHRpb25zIiwicGljayIsImFzc29jTW9kZWwiLCJjYXN0QXJyYXkiLCJpdGVtIiwicmVmRmllbGRWYWx1ZSIsImxvY2FsRmllbGQiLCJfdXBkYXRlQXNzb2NzXyIsImJlZm9yZUVudGl0eVVwZGF0ZSIsImZvclNpbmdsZVJlY29yZCIsImN1cnJlbnRLZXlWYWx1ZSIsImFzc29jS2V5cyIsInJlY29yZCIsImFzc29jUmVjb3Jkc1RvUmVtb3ZlIiwibGVuZ3RoIiwiJG5vdEluIiwiZGVsZXRlTWFueV8iLCJkZXN0RW50aXR5SWQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsQ0FBQyxZQUFEOztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBQ0EsTUFBTU0sV0FBVyxHQUFHTCxPQUFPLENBQUMsbUJBQUQsQ0FBM0I7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUEsdUJBQXBCO0FBQTZDQyxFQUFBQSxjQUE3QztBQUE2REMsRUFBQUEsZUFBN0Q7QUFBOEVDLEVBQUFBO0FBQTlFLElBQWtHVixPQUFPLENBQUMsb0JBQUQsQ0FBL0c7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVZLEVBQUFBLFlBQUY7QUFBZ0JDLEVBQUFBO0FBQWhCLElBQThCYixPQUFPLENBQUMsa0JBQUQsQ0FBM0M7O0FBRUEsTUFBTWMsc0JBQXNCLEdBQUlDLE1BQUQsSUFBYSxNQUFNQSxNQUFsRDs7QUFLQSxNQUFNQyxnQkFBTixTQUErQlgsV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV1ksZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMs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SixFQUFxQjtBQUNqQixlQUFPUCxVQUFVLENBQUNsSyxPQUFYLENBQ0gsRUFBRSxHQUFHMkksSUFBTDtBQUFXLFdBQUNNLFNBQVMsQ0FBQzVLLEtBQVgsR0FBbUJxTTtBQUE5QixTQURHLEVBRUhWLGFBRkcsRUFHSHhKLE9BQU8sQ0FBQ00sV0FITCxDQUFQO0FBS0g7O0FBRUQsWUFBTSxJQUFJM0IsS0FBSixDQUFVLDZEQUFWLENBQU47QUFHSCxLQXRIZSxDQUFoQjtBQXdIQSxXQUFPMkssYUFBUDtBQUNIOztBQXgvQnNDOztBQTIvQjNDb0IsTUFBTSxDQUFDQyxPQUFQLEdBQWlCcE4sZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLVwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoXCIuLi8uLi9FbnRpdHlNb2RlbFwiKTtcbmNvbnN0IHsgQXBwbGljYXRpb25FcnJvciwgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IsIER1cGxpY2F0ZUVycm9yLCBWYWxpZGF0aW9uRXJyb3IsIEludmFsaWRBcmd1bWVudCB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL0Vycm9yc1wiKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZShcIi4uLy4uL3R5cGVzXCIpO1xuY29uc3QgeyBnZXRWYWx1ZUZyb20sIG1hcEZpbHRlciB9ID0gcmVxdWlyZShcIi4uLy4uL3V0aWxzL2xhbmdcIik7XG5cbmNvbnN0IGRlZmF1bHROZXN0ZWRLZXlHZXR0ZXIgPSAoYW5jaG9yKSA9PiAoJzonICsgYW5jaG9yKTtcblxuLyoqXG4gKiBNeVNRTCBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKi9cbmNsYXNzIE15U1FMRW50aXR5TW9kZWwgZXh0ZW5kcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqXG4gICAgICogW3NwZWNpZmljXSBDaGVjayBpZiB0aGlzIGVudGl0eSBoYXMgYXV0byBpbmNyZW1lbnQgZmVhdHVyZS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKFxuICAgICAgICAgICAgZW50aXR5T2JqLFxuICAgICAgICAgICAga2V5UGF0aFxuICAgICAgICAgICAgICAgIC5zcGxpdChcIi5cIilcbiAgICAgICAgICAgICAgICAubWFwKChwKSA9PiBcIjpcIiArIHApXG4gICAgICAgICAgICAgICAgLmpvaW4oXCIuXCIpXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlblxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gXCJOT1dcIikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnJhdyhcIk5PVygpXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnQ6IFwiICsgbmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWVcbiAgICAgKiBAcGFyYW0geyp9IGluZm9cbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gXCJkYXRldGltZVwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuREFURVRJTUUuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09IFwiYXJyYXlcIiAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogXCIgKyBlcnJvci5tZXNzYWdlLCBcbiAgICAgICAgICAgICAgICAgICAgZXJyb3IuaW5mb1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9EVVBfRU5UUllcIikge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBEdXBsaWNhdGVFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCwgZXJyb3IuaW5mbyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gXCJFUl9OT19SRUZFUkVOQ0VEX1JPV18yXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUmVmZXJlbmNlZE5vdEV4aXN0RXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6IFwiICsgZXJyb3IubWVzc2FnZSwgXG4gICAgICAgICAgICAgICAgICAgIGVycm9yLmluZm9cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09IFwiRVJfRFVQX0VOVFJZXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRHVwbGljYXRlRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmAsIGVycm9yLmluZm8pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgICAgICAgLi4uY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogc3VwZXIudmFsdWVPZktleShlbnRpdHkpIH0sXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHksXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHtcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbXCIkcmV0cmlldmVVcGRhdGVkXCIsIFwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZVwiXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAvL2luc2VydCBpZ25vcmVkXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbnRleHQucXVlcnlLZXkpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb250ZXh0LnF1ZXJ5S2V5KSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcignQ2Fubm90IGV4dHJhY3QgdW5pcXVlIGtleXMgZnJvbSBpbnB1dCBkYXRhLicsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgPyBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZFxuICAgICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQubGF0ZXN0ID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmV0cmlldmVVcGRhdGVkID0gb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuXG4gICAgICAgIGlmICghcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVBY3R1YWxVcGRhdGVkICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA+IDApIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZVVwZGF0ZWQgPSBvcHRpb25zLiRyZXRyaWV2ZUFjdHVhbFVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlICYmIGNvbnRleHQucmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlVXBkYXRlZCA9IG9wdGlvbnMuJHJldHJpZXZlTm90VXBkYXRlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKG9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyhcbiAgICAgICAgICAgICAgICB7IC4uLmNvbmRpdGlvbiwgJGluY2x1ZGVEZWxldGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsIC4uLnJldHJpZXZlT3B0aW9ucyB9LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IG9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IG9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyhcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICRxdWVyeTogb3B0aW9ucy4kcXVlcnksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICRpbmNsdWRlRGVsZXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLFxuICAgICAgICAgICAgICAgICAgICAuLi5yZXRyaWV2ZU9wdGlvbnMsICAgICAgIFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBvcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKVxuICAgICAgICAgICAgICAgID8geyAuLi5jb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCwgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH1cbiAgICAgICAgICAgICAgICA6IHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJGluY2x1ZGVEZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oXG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHRcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnNcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTtcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSxcbiAgICAgICAgICAgIGNvdW50ZXIgPSAwLFxuICAgICAgICAgICAgY2FjaGUgPSB7fTtcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaCgoYXNzb2MpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgdGhpcy5kYi5zY2hlbWFOYW1lKTtcblxuICAgICAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jLmFsaWFzO1xuICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgYWxpYXMgPSBcIjpqb2luXCIgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICBqb2luVHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldFxuICAgICAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmRiLmNvbm5lY3Rvci5idWlsZFF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MubW9kZWwuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICpcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZihcIi5cIik7XG4gICAgICAgIGxldCByZXN1bHQ7XG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7XG4gICAgICAgICAgICAvL2RpcmVjdCBhc3NvY2lhdGlvblxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnQoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zICsgMSk7XG5cbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudChgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi5lbnRpdHkuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbywgdGhpcy5kYikgfTtcblxuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZS5zdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBiYXNlTm9kZS5zdWJBc3NvY3MgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArIFwiLlwiICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZihcIi5cIikgPiAwKSB7XG4gICAgICAgICAgICBsZXQgW3NjaGVtYU5hbWUsIGVudGl0eU5hbWVdID0gYXNzb2MuZW50aXR5LnNwbGl0KFwiLlwiLCAyKTtcblxuICAgICAgICAgICAgbGV0IGFwcCA9IHRoaXMuZGIuYXBwO1xuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgXCIuXCIgKyBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSByZWZEYi5tb2RlbChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFhc3NvYy5tb2RlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKGBGYWlsZWQgbG9hZCB0aGUgZW50aXR5IG1vZGVsIFwiJHtzY2hlbWFOYW1lfS4ke2VudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2MuZW50aXR5KTtcblxuICAgICAgICAgICAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50RGIgIT09IHRoaXMuZGIpIHtcbiAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHkgPSB0aGlzLmRiLmNvbm5lY3Rvci5kYXRhYmFzZSArIFwiLlwiICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSwgbmVzdGVkS2V5R2V0dGVyKSB7XG4gICAgICAgIG5lc3RlZEtleUdldHRlciA9PSBudWxsICYmIChuZXN0ZWRLZXlHZXR0ZXIgPSBkZWZhdWx0TmVzdGVkS2V5R2V0dGVyKTsgICAgICAgIFxuICAgICAgICBhbGlhc01hcCA9IF8ubWFwVmFsdWVzKGFsaWFzTWFwLCBjaGFpbiA9PiBjaGFpbi5tYXAoYW5jaG9yID0+IG5lc3RlZEtleUdldHRlcihhbmNob3IpKSk7XG5cbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9O1xuICAgICAgICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgICAgICAgY29sdW1ucyA9IGNvbHVtbnMubWFwKGNvbCA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIlwiKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcG9zID0gY29sLm5hbWUuaW5kZXhPZignJCcpO1xuICAgICAgICAgICAgICAgIGlmIChwb3MgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZTogY29sLm5hbWUuc3Vic3RyKDAsIHBvcyksXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjb2wubmFtZS5zdWJzdHIocG9zKzEpXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHRhYmxlOiAnQScsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB0YWJsZTogY29sLnRhYmxlLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbC5uYW1lXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KTtcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMsIG5vZGVQYXRoKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSBub2RlUGF0aC5jb25jYXQoKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aC5wdXNoKGFuY2hvcik7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iaiA9IHJvd09iamVjdFtvYmpLZXldO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFzdWJPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hc3NvY2lhdGVkIGVudGl0eSBub3QgaW4gcmVzdWx0IHNldCwgcHJvYmFibHkgd2hlbiBjdXN0b20gcHJvamVjdGlvbiBpcyB1c2VkXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5VmFsdWUgPSBzdWJPYmpba2V5XTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChyb3dLZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgcm93S2V5VmFsdWUgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0ucHVzaChzdWJPYmopO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleVZhbHVlXTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdTdWJSb3cpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcywgY3VycmVudFBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgVGhlIHN0cnVjdHVyZSBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgc2hvdWxkIGJlIGEgbGlzdC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFtzdWJPYmpdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmosXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcyk7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbihcIi5cIil9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5tZXRhLm5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XCIgZG9lcyBub3QgZXhpc3QuYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXNbcm93S2V5VmFsdWVdID0gc3ViSW5kZXg7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBpbmRleGVzID0ge307XG5cbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHNxbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBrZXk7XG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gbmVzdGVkS2V5R2V0dGVyKGFuY2hvcik7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldO1xuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0OiBzdWJPYmplY3QsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChsaXN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2Fzc29jaWF0ZWQgZW50aXR5IG5vdCBpbiByZXN1bHQgc2V0LCBwcm9iYWJseSB3aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbc3ViT2JqZWN0XTtcblxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKlxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy93aGVuIGN1c3RvbSBwcm9qZWN0aW9uIGlzIHVzZWQgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IC8qZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy9yb3dPYmplY3Rbb2JqS2V5XSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSBzdWJPYmplY3Rba2V5XSA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4LFxuICAgICAgICAgICAgICAgICAgICB9IDoge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG4gICAgICAgIFxuICAgICAgICBjb25zdCB0YWJsZVRlbXBsYXRlID0gY29sdW1ucy5yZWR1Y2UoKHJlc3VsdCwgY29sKSA9PiB7XG4gICAgICAgICAgICBpZiAoY29sLnRhYmxlICE9PSAnQScpIHtcbiAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIFtjb2wudGFibGUsIGNvbC5uYW1lXSwgbnVsbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG5cbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSBcIkFcIikge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZSAhPSBudWxsKSB7IC8vIGF2b2lkIGEgb2JqZWN0IHdpdGggYWxsIG51bGwgdmFsdWUgZXhpc3RzXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSB7IC4uLnRhYmxlVGVtcGxhdGVbY29sLnRhYmxlXSwgW2NvbC5uYW1lXTogdmFsdWUgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwgcm93T2JqZWN0KTtcblxuICAgICAgICAgICAgXy5mb3JPd24odGFibGVDYWNoZSwgKG9iaiwgdGFibGUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFt0YWJsZV07ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJvd09iamVjdCwgbm9kZVBhdGgsIG9iaik7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFtzZWxmLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHtcbiAgICAgICAgICAgICAgICByb3dPYmplY3QsXG4gICAgICAgICAgICAgICAgc3ViSW5kZXhlczogYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgaGllcmFyY2h5KSxcbiAgICAgICAgICAgIH07ICBcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhLCBpc05ldykge1xuICAgICAgICBjb25zdCByYXcgPSB7fSxcbiAgICAgICAgICAgIGFzc29jcyA9IHt9LFxuICAgICAgICAgICAgcmVmcyA9IHt9O1xuICAgICAgICBjb25zdCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcblxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09IFwiOlwiKSB7XG4gICAgICAgICAgICAgICAgLy9jYXNjYWRlIHVwZGF0ZVxuICAgICAgICAgICAgICAgIGNvbnN0IGFuY2hvciA9IGsuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNOZXcgJiYgKGFzc29jTWV0YS50eXBlID09PSBcInJlZmVyc1RvXCIgfHwgYXNzb2NNZXRhLnR5cGUgPT09IFwiYmVsb25nc1RvXCIpICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gZGF0YSBcIjoke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGlucHV0IHZhbHVlIG9mIGZpZWxkIFwiJHthbmNob3J9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jc1thbmNob3JdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa1swXSA9PT0gXCJAXCIpIHtcbiAgICAgICAgICAgICAgICAvL3VwZGF0ZSBieSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBjb25zdCBhbmNob3IgPSBrLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgVW5rbm93biBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS50eXBlICE9PSBcInJlZmVyc1RvXCIgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwiYmVsb25nc1RvXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgQXNzb2NpYXRpb24gdHlwZSBcIiR7YXNzb2NNZXRhLnR5cGV9XCIgY2Fubm90IGJlIHVzZWQgZm9yIHVwZGF0ZSBieSByZWZlcmVuY2UuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzTmV3ICYmIGFuY2hvciBpbiBkYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgQXNzb2NpYXRpb24gcmVmZXJlbmNlIFwiQCR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgY29uZmxpY3RzIHdpdGggaW5wdXQgdmFsdWUgb2YgZmllbGQgXCIke2FuY2hvcn1cIi5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzb2NBbmNob3IgPSBcIjpcIiArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2NBbmNob3IgaW4gZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEFzc29jaWF0aW9uIHJlZmVyZW5jZSBcIkAke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGNvbmZsaWN0cyB3aXRoIGFzc29jaWF0aW9uIGRhdGEgXCIke2Fzc29jQW5jaG9yfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodiA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhd1thbmNob3JdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWZzW2FuY2hvcl0gPSB2O1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbcmF3LCBhc3NvY3MsIHJlZnNdO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfcG9wdWxhdGVSZWZlcmVuY2VzXyhjb250ZXh0LCByZWZlcmVuY2VzKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18ocmVmZXJlbmNlcywgYXN5bmMgKHJlZlF1ZXJ5LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGNvbnN0IFJlZmVyZW5jZWRFbnRpdHkgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6ICFhc3NvY01ldGEubGlzdDtcblxuICAgICAgICAgICAgbGV0IGNyZWF0ZWQgPSBhd2FpdCBSZWZlcmVuY2VkRW50aXR5LmZpbmRPbmVfKHJlZlF1ZXJ5LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJlZmVyZW5jZWROb3RFeGlzdEVycm9yKGBSZWZlcmVuY2VkIGVudGl0eSBcIiR7UmVmZXJlbmNlZEVudGl0eS5tZXRhLm5hbWV9XCIgd2l0aCAke0pTT04uc3RyaW5naWZ5KHJlZlF1ZXJ5KX0gbm90IGV4aXN0LmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJhd1thbmNob3JdID0gY3JlYXRlZFthc3NvY01ldGEuZmllbGRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzLCBiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG4gICAgICAgIGxldCBrZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eUNyZWF0ZSkge1xuICAgICAgICAgICAga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udGV4dC5yZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaW5zZXJ0IGlnbm9yZWRcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBxdWVyeSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogY29udGV4dC5yZXR1cm4sXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbnM6IGFzc29jc1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG4gICAgICAgIGNvbnN0IGZpbmlzaGVkID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIChpdGVtKSA9PlxuICAgICAgICAgICAgICAgICAgICBhc3NvY01vZGVsLmNyZWF0ZV8oeyAuLi5pdGVtLCBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSwgcGFzc09uT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFiZWZvcmVFbnRpdHlDcmVhdGUgJiYgYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNNYW55IG9yIGhhc09uZVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IC4uLmRhdGEsIFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY3JlYXRlZCA9IGF3YWl0IGFzc29jTW9kZWwuY3JlYXRlXyhkYXRhLCBwYXNzT25PcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgZmluaXNoZWRbYW5jaG9yXSA9IGJlZm9yZUVudGl0eUNyZWF0ZSA/IGNyZWF0ZWRbYXNzb2NNZXRhLmZpZWxkXSA6IGNyZWF0ZWRbYXNzb2NNZXRhLmtleV07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChiZWZvcmVFbnRpdHlDcmVhdGUpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGZpbmlzaGVkLCAocmVmRmllbGRWYWx1ZSwgbG9jYWxGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3W2xvY2FsRmllbGRdID0gcmVmRmllbGRWYWx1ZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcywgYmVmb3JlRW50aXR5VXBkYXRlLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHRoaXMubWV0YS5hc3NvY2lhdGlvbnM7XG5cbiAgICAgICAgbGV0IGN1cnJlbnRLZXlWYWx1ZTtcblxuICAgICAgICBpZiAoIWJlZm9yZUVudGl0eVVwZGF0ZSkge1xuICAgICAgICAgICAgY3VycmVudEtleVZhbHVlID0gZ2V0VmFsdWVGcm9tKFtjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LCBjb250ZXh0LnJldHVybl0sIHRoaXMubWV0YS5rZXlGaWVsZCk7XG4gICAgICAgICAgICBpZiAoXy5pc05pbChjdXJyZW50S2V5VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgLy8gc2hvdWxkIGhhdmUgaW4gdXBkYXRpbmdcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIk1pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogXCIgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwZW5kaW5nQXNzb2NzID0ge307XG5cbiAgICAgICAgLy90b2RvOiBkb3VibGUgY2hlY2sgdG8gZW5zdXJlIGluY2x1ZGluZyBhbGwgcmVxdWlyZWQgb3B0aW9uc1xuICAgICAgICBjb25zdCBwYXNzT25PcHRpb25zID0gXy5waWNrKGNvbnRleHQub3B0aW9ucywgW1wiJHNraXBNb2RpZmllcnNcIiwgXCIkbWlncmF0aW9uXCIsIFwiJHZhcmlhYmxlc1wiXSk7XG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUgJiYgYXNzb2NNZXRhLnR5cGUgIT09IFwicmVmZXJzVG9cIiAmJiBhc3NvY01ldGEudHlwZSAhPT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgIHBlbmRpbmdBc3NvY3NbYW5jaG9yXSA9IGRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhLmZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYE1pc3NpbmcgXCJmaWVsZFwiIHByb3BlcnR5IGluIHRoZSBtZXRhZGF0YSBvZiBhc3NvY2lhdGlvbiBcIiR7YW5jaG9yfVwiIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jS2V5cyA9IG1hcEZpbHRlcihkYXRhLCByZWNvcmQgPT4gcmVjb3JkW2Fzc29jTWV0YS5rZXldICE9IG51bGwsIHJlY29yZCA9PiByZWNvcmRbYXNzb2NNZXRhLmtleV0pOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NvY1JlY29yZHNUb1JlbW92ZSA9IHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0tleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NvY1JlY29yZHNUb1JlbW92ZVthc3NvY01ldGEua2V5XSA9IHsgJG5vdEluOiBhc3NvY0tleXMgfTsgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGF3YWl0IGFzc29jTW9kZWwuZGVsZXRlTWFueV8oYXNzb2NSZWNvcmRzVG9SZW1vdmUsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVhY2hBc3luY18oZGF0YSwgKGl0ZW0pID0+IGl0ZW1bYXNzb2NNZXRhLmtleV0gIT0gbnVsbCA/XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwudXBkYXRlT25lXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uXy5vbWl0KGl0ZW0sIFthc3NvY01ldGEua2V5XSksIFthc3NvY01ldGEuZmllbGRdOiBjdXJyZW50S2V5VmFsdWUgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgJHF1ZXJ5OiB7IFthc3NvY01ldGEua2V5XTogaXRlbVthc3NvY01ldGEua2V5XSB9LCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk6XG4gICAgICAgICAgICAgICAgICAgIGFzc29jTW9kZWwuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uaXRlbSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFzc09uT3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIHR5cGUgb2YgYXNzb2NpYXRlZCBlbnRpdHkgKCR7YXNzb2NNZXRhLmVudGl0eX0pIGRhdGEgdHJpZ2dlcmVkIGZyb20gXCIke3RoaXMubWV0YS5uYW1lfVwiIGVudGl0eS4gU2luZ3VsYXIgdmFsdWUgZXhwZWN0ZWQgKCR7YW5jaG9yfSksIGJ1dCBhbiBhcnJheSBpcyBnaXZlbiBpbnN0ZWFkLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBUaGUgYXNzb2NpYXRlZCBmaWVsZCBvZiByZWxhdGlvbiBcIiR7YW5jaG9yfVwiIGRvZXMgbm90IGV4aXN0IGluIHRoZSBlbnRpdHkgbWV0YSBkYXRhLmBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2Nvbm5lY3RlZCBieVxuICAgICAgICAgICAgICAgIGRhdGEgPSB7IFthc3NvY01ldGEuYXNzb2NdOiBkYXRhIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChiZWZvcmVFbnRpdHlVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGRhdGEpKSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICAvL3JlZmVyc1RvIG9yIGJlbG9uZ3NUb1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RW50aXR5SWQgPSBnZXRWYWx1ZUZyb20oW2NvbnRleHQuZXhpc3RpbmcsIGNvbnRleHQub3B0aW9ucy4kcXVlcnksIGNvbnRleHQucmF3XSwgYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5SWQgPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb250ZXh0LmV4aXN0aW5nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEFwcGxpY2F0aW9uRXJyb3IoXCJFeGlzdGluZyBkb2VzIG5vdCBjb250YWluIHRoZSByZWZlcmVuY2VkIGVudGl0eSBpZC5cIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nOiBjb250ZXh0LmV4aXN0aW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBjb250ZXh0LnJhdyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oY29udGV4dC5vcHRpb25zLiRxdWVyeSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5leGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcihgU3BlY2lmaWVkIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBub3QgZm91bmQuYCwgeyBxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5SWQgPSBjb250ZXh0LmV4aXN0aW5nW2FuY2hvcl07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCA9PSBudWxsICYmICEoYW5jaG9yIGluIGNvbnRleHQuZXhpc3RpbmcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQXBwbGljYXRpb25FcnJvcihcIkV4aXN0aW5nIGRvZXMgbm90IGNvbnRhaW4gdGhlIHJlZmVyZW5jZWQgZW50aXR5IGlkLlwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3Rpbmc6IGNvbnRleHQuZXhpc3RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnlcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHlJZCkgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLnVwZGF0ZU9uZV8oXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBbYXNzb2NNZXRhLmZpZWxkXTogZGVzdEVudGl0eUlkLCAuLi5wYXNzT25PcHRpb25zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9ub3RoaW5nIHRvIGRvIGZvciBudWxsIGRlc3QgZW50aXR5IGlkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBhc3NvY01vZGVsLmRlbGV0ZU1hbnlfKHsgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhc3NvY01vZGVsLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgICAgIHsgLi4uZGF0YSwgW2Fzc29jTWV0YS5maWVsZF06IGN1cnJlbnRLZXlWYWx1ZSB9LFxuICAgICAgICAgICAgICAgICAgICBwYXNzT25PcHRpb25zLFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidXBkYXRlIGFzc29jaWF0ZWQgZGF0YSBmb3IgbXVsdGlwbGUgcmVjb3JkcyBub3QgaW1wbGVtZW50ZWRcIik7XG5cbiAgICAgICAgICAgIC8vcmV0dXJuIGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5kYXRhLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBlbmRpbmdBc3NvY3M7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7XG4iXX0=
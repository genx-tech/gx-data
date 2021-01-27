-"use strict";

const Util = require("rk-utils");
const { _, getValueByPath, setValueByPath, eachAsync_ } = Util;
const EntityModel = require("../../EntityModel");
const { ApplicationError, ReferencedNotExistError, DuplicateError, ValidationError, InvalidArgument } = require("../../utils/Errors");
const Types = require("../../types");
const { getValueFrom, mapFilter } = require("../../utils/lang");

const defaultNestedKeyGetter = (anchor) => (':' + anchor);

/**
 * MySQL entity model class.
 */
class MySQLEntityModel extends EntityModel {
    /**
     * [specific] Check if this entity has auto increment feature.
     */
    static get hasAutoIncrement() {
        let autoId = this.meta.features.autoId;
        return autoId && this.meta.fields[autoId.field].autoIncrementId;
    }

    /**
     * [override]
     * @param {*} entityObj
     * @param {*} keyPath
     */
    static getNestedObject(entityObj, keyPath) {
        return getValueByPath(
            entityObj,
            keyPath
                .split(".")
                .map((p) => ":" + p)
                .join(".")
        );
    }

    /**
     * [override] Serialize value into database acceptable format.
     * @param {object} name - Name of the symbol token
     */
    static _translateSymbolToken(name) {
        if (name === "NOW") {
            return this.db.connector.raw("NOW()");
        }

        throw new Error("not support: " + name);
    }

    /**
     * [override]
     * @param {*} value
     * @param {*} info
     */
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
                throw new ReferencedNotExistError(
                    "The new entity is referencing to an unexisting entity. Detail: " + error.message, 
                    error.info
                );
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
                throw new ReferencedNotExistError(
                    "The entity to be updated is referencing to an unexisting entity. Detail: " + error.message, 
                    error.info
                );
            } else if (errorCode === "ER_DUP_ENTRY") {
                throw new DuplicateError(error.message + ` while updating an existing "${this.meta.name}".`, error.info);
            }

            throw error;
        }
    }

    static async _doReplaceOne_(context) {
        await this.ensureTransaction_(context);

        let entity = await this.findOne_({ $query: context.options.$query }, context.connOptions);

        let ret, options;

        if (entity) {
            if (context.options.$retrieveExisting) {
                context.rawOptions.$existing = entity;
            }

            options = {
                ...context.options,
                $query: { [this.meta.keyField]: super.valueOfKey(entity) },
                $existing: entity,
            };

            ret = await this.updateOne_(context.raw, options, context.connOptions);
        } else {
            options = {
                ..._.omit(context.options, ["$retrieveUpdated", "$bypassEnsureUnique"]),
                $retrieveCreated: context.options.$retrieveUpdated,
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

    /**
     * Post create processing.
     * @param {*} context
     * @property {object} [context.options] - Create options
     * @property {bool} [options.$retrieveCreated] - Retrieve the newly created record from db.
     */
    static async _internalAfterCreate_(context) {
        if (context.options.$retrieveDbResult) {
            context.rawOptions.$result = context.result;
        }

        if (context.options.$retrieveCreated) {
            if (this.hasAutoIncrement) {
                if (context.result.affectedRows === 0) {
                    //insert ignored
                    context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);

                    if (_.isEmpty(context.queryKey)) {
                        throw new ApplicationError('Cannot extract unique keys from input data.', {
                            entity: this.meta.name
                        })
                    }
                } else {
                    let { insertId } = context.result;
                    context.queryKey = { [this.meta.features.autoId.field]: insertId };
                }                
            } else {
                context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);

                if (_.isEmpty(context.queryKey)) {
                    throw new ApplicationError('Cannot extract unique keys from input data.', {
                        entity: this.meta.name
                    })
                }
            }

            let retrieveOptions = _.isPlainObject(context.options.$retrieveCreated)
                ? context.options.$retrieveCreated
                : {};
            context.return = await this.findOne_({ ...retrieveOptions, $query: context.queryKey }, context.connOptions);
        } else {
            if (this.hasAutoIncrement) {
                if (context.result.affectedRows === 0) {
                    context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
                } else {
                    let { insertId } = context.result;
                    context.queryKey = { [this.meta.features.autoId.field]: insertId };
                }

                context.return = context.latest = { ...context.return, ...context.queryKey };
            }
        }
    }

    static _internalBeforeUpdate_(context) {
        return true;
    }

    static _internalBeforeUpdateMany_(context) {
        return true;
    }

    /**
     * Post update processing.
     * @param {*} context
     * @property {object} [context.options] - Update options
     * @property {bool} [context.options.$retrieveUpdated] - Retrieve the newly updated record from db.
     */
    static async _internalAfterUpdate_(context) {
        const options = context.options;

        if (options.$retrieveDbResult) {
            context.rawOptions.$result = context.result || {
                affectedRows: 0,
                changedRows: 0
            };
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
            let condition = { $query: this.getUniqueKeyValuePairsFrom(options.$query) };
            if (options.$bypassEnsureUnique) {
                condition.$bypassEnsureUnique = options.$bypassEnsureUnique;
            }

            let retrieveOptions = {};

            if (_.isPlainObject(retrieveUpdated)) {
                retrieveOptions = retrieveUpdated;
            } else if (options.$relationships) {
                retrieveOptions.$relationships = options.$relationships;
            }

            context.return = await this.findOne_(
                { ...condition, $includeDeleted: options.$retrieveDeleted, ...retrieveOptions },
                context.connOptions
            );

            if (context.return) {
                context.queryKey = this.getUniqueKeyValuePairsFrom(context.return);
            } else {
                context.queryKey = condition.$query;
            }
        }
    }

    /**
     * Post update processing.
     * @param {*} context
     * @param {object} [options] - Update options
     * @property {bool} [options.$retrieveUpdated] - Retrieve the newly updated record from db.
     */
    static async _internalAfterUpdateMany_(context) {
        const options = context.options;

        if (options.$retrieveDbResult) {
            context.rawOptions.$result = context.result || {
                affectedRows: 0,
                changedRows: 0
            };

            /**
             * afterUpdateMany ResultSetHeader {
             * fieldCount: 0,
             * affectedRows: 1,
             * insertId: 0,
             * info: 'Rows matched: 1  Changed: 1  Warnings: 0',
             * serverStatus: 3,
             * warningStatus: 0,
             * changedRows: 1 }
             */
        }

        if (options.$retrieveUpdated) {
            let retrieveOptions = {};

            if (_.isPlainObject(options.$retrieveUpdated)) {
                retrieveOptions = options.$retrieveUpdated;
            } else if (options.$relationships) {
                retrieveOptions.$relationships = options.$relationships;
            }

            context.return = await this.findAll_(
                {
                    $query: options.$query,                                 
                    $includeDeleted: options.$retrieveDeleted,
                    ...retrieveOptions,       
                },
                context.connOptions
            );
        }

        context.queryKey = options.$query;
    }

    /**
     * Before deleting an entity.
     * @param {*} context
     * @property {object} [context.options] - Delete options
     * @property {bool} [context.options.$retrieveDeleted] - Retrieve the recently deleted record from db.
     */
    static async _internalBeforeDelete_(context) {
        if (context.options.$retrieveDeleted) {
            await this.ensureTransaction_(context);

            let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted)
                ? { ...context.options.$retrieveDeleted, $query: context.options.$query }
                : { $query: context.options.$query };

            if (context.options.$physicalDeletion) {
                retrieveOptions.$includeDeleted = true;
            }    

            context.return = context.existing = await this.findOne_(
                retrieveOptions,
                context.connOptions
            );
        }

        return true;
    }

    static async _internalBeforeDeleteMany_(context) {
        if (context.options.$retrieveDeleted) {
            await this.ensureTransaction_(context);

            let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted)
                ? { ...context.options.$retrieveDeleted, $query: context.options.$query }
                : { $query: context.options.$query };

            if (context.options.$physicalDeletion) {
                retrieveOptions.$includeDeleted = true;
            }    

            context.return = context.existing = await this.findAll_(
                retrieveOptions,
                context.connOptions
            );
        }

        return true;
    }

    /**
     * Post delete processing.
     * @param {*} context
     */
    static _internalAfterDelete_(context) {
        if (context.options.$retrieveDbResult) {
            context.rawOptions.$result = context.result;
        }
    }

    /**
     * Post delete processing.
     * @param {*} context
     */
    static _internalAfterDeleteMany_(context) {
        if (context.options.$retrieveDbResult) {
            context.rawOptions.$result = context.result;
        }
    }

    /**
     *
     * @param {*} findOptions
     */
    static _prepareAssociations(findOptions) {
        const [ normalAssocs, customAssocs ] = _.partition(findOptions.$association, assoc => typeof assoc === 'string');

        let associations =  _.uniq(normalAssocs).sort().concat(customAssocs);
        let assocTable = {},
            counter = 0,
            cache = {};

        associations.forEach((assoc) => {
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
                    ...(assoc.dataset
                        ? this.db.connector.buildQuery(
                              assoc.entity,
                              assoc.model._prepareQueries({ ...assoc.dataset, $variables: findOptions.$variables })
                          )
                        : {}),
                };
            } else {
                this._loadAssocIntoTable(assocTable, cache, assoc);
            }
        });

        return assocTable;
    }

    /**
     *
     * @param {*} assocTable - Hierarchy with subAssocs
     * @param {*} cache - Dotted path as key
     * @param {*} assoc - Dotted path
     */
    static _loadAssocIntoTable(assocTable, cache, assoc) {
        if (cache[assoc]) return cache[assoc];

        let lastPos = assoc.lastIndexOf(".");
        let result;

        if (lastPos === -1) {
            //direct association
            let assocInfo = { ...this.meta.associations[assoc] };
            if (_.isEmpty(assocInfo)) {
                throw new InvalidArgument(`Entity "${this.meta.name}" does not have the association "${assoc}".`);
            }

            result = cache[assoc] = assocTable[assoc] = { ...this._translateSchemaNameToDb(assocInfo) };
        } else {
            let base = assoc.substr(0, lastPos);
            let last = assoc.substr(lastPos + 1);

            let baseNode = cache[base];
            if (!baseNode) {
                baseNode = this._loadAssocIntoTable(assocTable, cache, base);
            }

            let entity = baseNode.model || this.db.model(baseNode.entity);
            let assocInfo = { ...entity.meta.associations[last] };
            if (_.isEmpty(assocInfo)) {
                throw new InvalidArgument(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
            }

            result = { ...entity._translateSchemaNameToDb(assocInfo, this.db) };

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
                throw new ApplicationError(
                    `The referenced schema "${schemaName}" does not have db model in the same application.`
                );
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
                        name: col.name.substr(pos+1)
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
            return _.each(associations, ({ sql, key, list, subAssocs }, anchor) => {
                if (sql) return;

                let currentPath = nodePath.concat();
                currentPath.push(anchor);

                let objKey = nestedKeyGetter(anchor);
                let subObj = rowObject[objKey];

                if (!subObj) {                    
                    //associated entity not in result set, probably when custom projection is used
                    return;
                }

                let subIndexes = existingRow.subIndexes[objKey];

                // joined an empty record
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
                        throw new ApplicationError(
                            `The structure of association "${currentPath.join(".")}" with [key=${key}] of entity "${
                                self.meta.name
                            }" should be a list.`,
                            { existingRow, rowObject }
                        );
                    }

                    if (existingRow.rowObject[objKey]) {
                        existingRow.rowObject[objKey].push(subObj);
                    } else {
                        existingRow.rowObject[objKey] = [subObj];
                    }

                    let subIndex = {
                        rowObject: subObj,
                    };

                    if (subAssocs) {
                        subIndex.subIndexes = buildSubIndexes(subObj, subAssocs);                        
                    }

                    if (!subIndexes) {
                        throw new ApplicationError(
                            `The subIndexes of association "${currentPath.join(".")}" with [key=${key}] of entity "${
                                self.meta.name
                            }" does not exist.`,
                            { existingRow, rowObject }
                        );
                    }

                    subIndexes[rowKeyValue] = subIndex;
                }
            });
        }

        function buildSubIndexes(rowObject, associations) {
            let indexes = {};

            _.each(associations, ({ sql, key, list, subAssocs }, anchor) => {
                if (sql) {
                    return;
                }

                assert: key;

                let objKey = nestedKeyGetter(anchor);
                let subObject = rowObject[objKey];
                let subIndex = {
                    rowObject: subObject,
                };

                if (list) {
                    if (!subObject) {
                        //associated entity not in result set, probably when custom projection is used
                        rowObject[objKey] = [];
                        return;
                    }                    

                    rowObject[objKey] = [subObject];

                    //many to *
                    if (_.isNil(subObject[key])) {     
                        //when custom projection is used              
                        subObject = null;
                    } 
                } 

                if (subObject) {
                    if (subAssocs) {
                        subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
                    }

                    indexes[objKey] = subObject[key] ? {
                        [subObject[key]]: subIndex,
                    } : {};
                }
            });

            return indexes;
        }

        let arrayOfObjs = [];        
        
        const tableTemplate = columns.reduce((result, col) => {
            if (col.table !== 'A') {
                let bucket = result[col.table];
                if (bucket) {
                    bucket[col.name] = null;
                } else {
                    result[col.table] = { [col.name]: null };
                }
            }

            return result;
        }, {});

        //process each row
        rows.forEach((row) => {
            let tableCache = {}; // from alias to child prop of rowObject

            // hash-style data row
            let rowObject = row.reduce((result, value, colIdx) => {
                let col = columns[colIdx];

                if (col.table === "A") {
                    result[col.name] = value;
                } else if (value != null) { // avoid a object with all null value exists
                    let bucket = tableCache[col.table];
                    if (bucket) {
                        //already nested inside
                        bucket[col.name] = value;
                    } else {
                        tableCache[col.table] = { ...tableTemplate[col.table], [col.name]: value };                            
                    }
                } 

                return result;
            }, {});             

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
                subIndexes: buildSubIndexes(rowObject, hierarchy),
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
                //cascade update
                const anchor = k.substr(1);
                const assocMeta = meta[anchor];
                if (!assocMeta) {
                    throw new ValidationError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
                }

                if (isNew && (assocMeta.type === "refersTo" || assocMeta.type === "belongsTo") && anchor in data) {
                    throw new ValidationError(
                        `Association data ":${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`
                    );
                }

                assocs[anchor] = v;
            } else if (k[0] === "@") {
                //update by reference
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
                    throw new ValidationError(
                        `Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with input value of field "${anchor}".`
                    );
                }

                const assocAnchor = ":" + anchor;
                if (assocAnchor in data) {
                    throw new ValidationError(
                        `Association reference "@${anchor}" of entity "${this.meta.name}" conflicts with association data "${assocAnchor}".`
                    );
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

            assert: !assocMeta.list;

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
                    //insert ignored

                    const query = this.getUniqueKeyValuePairsFrom(context.return);
                    context.return = await this.findOne_({ $query: query }, context.connOptions);
                    if (!context.return) {
                        throw new ApplicationError("The parent entity is duplicated on unique keys different from the pair of keys used to query", {
                            query,
                            data: context.latest
                        })
                    }
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

        //todo: double check to ensure including all required options
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
                    throw new ApplicationError(
                        `Missing "field" property in the metadata of association "${anchor}" of entity "${this.meta.name}".`
                    );
                }

                return eachAsync_(data, (item) =>
                    assocModel.create_({ ...item, [assocMeta.field]: keyValue }, passOnOptions, context.connOptions)
                );
            } else if (!_.isPlainObject(data)) {
                if (Array.isArray(data)) {
                    throw new ApplicationError(
                        `Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`
                    );
                }

                if (!assocMeta.assoc) {
                    throw new ApplicationError(
                        `The associated field of relation "${anchor}" does not exist in the entity meta data.`
                    );
                }

                data = { [assocMeta.assoc]: data };
            }

            if (!beforeEntityCreate && assocMeta.field) {
                //hasMany or hasOne
                data = { ...data, [assocMeta.field]: keyValue };
            }

            passOnOptions.$retrieveDbResult = true;
            let created = await assocModel.create_(data, passOnOptions, context.connOptions);
            if (passOnOptions.$result.affectedRows === 0) {
                //insert ignored

                const assocQuery = assocModel.getUniqueKeyValuePairsFrom(data);
                created = await assocModel.findOne_({ $query: assocQuery }, context.connOptions);
                if (!created) {
                    throw new ApplicationError("The assoicated entity is duplicated on unique keys different from the pair of keys used to query", {
                        query: assocQuery,
                        data
                    })
                }
            }

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
                // should have in updating
                throw new ApplicationError("Missing required primary key field value. Entity: " + this.meta.name);
            }
        }

        const pendingAssocs = {};

        //todo: double check to ensure including all required options
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
                    throw new ApplicationError(
                        `Missing "field" property in the metadata of association "${anchor}" of entity "${this.meta.name}".`
                    );
                }

                const assocKeys = mapFilter(data, record => record[assocMeta.key] != null, record => record[assocMeta.key]);                
                const assocRecordsToRemove = { [assocMeta.field]: currentKeyValue };
                if (assocKeys.length > 0) {
                    assocRecordsToRemove[assocMeta.key] = { $notIn: assocKeys };  
                }

                await assocModel.deleteMany_(assocRecordsToRemove, context.connOptions);

                return eachAsync_(data, (item) => item[assocMeta.key] != null ?
                    assocModel.updateOne_(
                        { ..._.omit(item, [assocMeta.key]), [assocMeta.field]: currentKeyValue },
                        { $query: { [assocMeta.key]: item[assocMeta.key] }, ...passOnOptions },
                        context.connOptions
                    ):
                    assocModel.create_(
                        { ...item, [assocMeta.field]: currentKeyValue },
                        passOnOptions,
                        context.connOptions
                    )
                );
            } else if (!_.isPlainObject(data)) {
                if (Array.isArray(data)) {
                    throw new ApplicationError(
                        `Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`
                    );
                }

                if (!assocMeta.assoc) {
                    throw new ApplicationError(
                        `The associated field of relation "${anchor}" does not exist in the entity meta data.`
                    );
                }

                //connected by
                data = { [assocMeta.assoc]: data };
            }

            if (beforeEntityUpdate) {
                if (_.isEmpty(data)) return;

                //refersTo or belongsTo
                let destEntityId = getValueFrom([context.existing, context.options.$query, context.raw], anchor);

                if (destEntityId == null) {
                    if (_.isEmpty(context.existing)) {
                        context.existing = await this.findOne_(context.options.$query, context.connOptions);
                        if (!context.existing) {
                            throw new ValidationError(`Specified "${this.meta.name}" not found.`, { query: context.options.$query });
                        }
                        destEntityId = context.existing[anchor];
                    }

                    if (destEntityId == null) {
                        if (!(anchor in context.existing)) {
                            throw new ApplicationError("Existing entity record does not contain the referenced entity id.", {
                                anchor,
                                data,
                                existing: context.existing,
                                query: context.options.$query,
                                raw: context.raw,
                            });
                        }

                        //to create the associated, existing is null

                        passOnOptions.$retrieveDbResult = true;
                        let created = await assocModel.create_(data, passOnOptions, context.connOptions);

                        if (passOnOptions.$result.affectedRows === 0) {
                            //insert ignored

                            const assocQuery = assocModel.getUniqueKeyValuePairsFrom(data);
                            created = await assocModel.findOne_({ $query: assocQuery }, context.connOptions);
                            if (!created) {
                                throw new ApplicationError("The assoicated entity is duplicated on unique keys different from the pair of keys used to query", {
                                    query: assocQuery,
                                    data
                                })
                            }
                        }

                        context.raw[anchor] = created[assocMeta.field];    
                        return;
                    } 
                }

                if (destEntityId) {                    
                    return assocModel.updateOne_(
                        data,
                        { [assocMeta.field]: destEntityId, ...passOnOptions },
                        context.connOptions
                    );
                }

                //nothing to do for null dest entity id
                return;
            }

            await assocModel.deleteMany_({ [assocMeta.field]: currentKeyValue }, context.connOptions);

            if (forSingleRecord) {
                return assocModel.create_(
                    { ...data, [assocMeta.field]: currentKeyValue },
                    passOnOptions,
                    context.connOptions
                );
            }

            throw new Error("update associated data for multiple records not implemented");

            //return assocModel.replaceOne_({ ...data, ...(assocMeta.field ? { [assocMeta.field]: keyValue } : {}) }, null, context.connOptions);
        });

        return pendingAssocs;
    }
}

module.exports = MySQLEntityModel;

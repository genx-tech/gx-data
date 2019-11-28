const { _, waitUntil_ } = require('rk-utils');
const { tryRequire } = require('../../utils/lib');
const mongodb = tryRequire('mongodb');
const { MongoClient, GridFSBucket } = mongodb;
const Connector = require('../../Connector');
const Generators = require('../../Generators');

const UpdateOpsField = [ '$currentDate', '$inc', '$min', '$max', '$mul', '$rename', '$set', '$setOnInsert', '$unset' ];
const UpdateOpsArray = [ '$addToSet', '$pop', '$pull', '$push', '$pullAll' ];
const UpdateOps = UpdateOpsField.concat(UpdateOpsArray);

/**
 * Mongodb data storage connector.
 * @class
 * @extends Connector
 */
class MongodbConnector extends Connector {
    /**          
     * @param {string} name 
     * @param {object} options 
     * @property {boolean} [options.usePreparedStatement] - 
     */
    constructor(connectionString, options) {        
        super('mongodb', connectionString, options);    
        
        this.lockerField = this.options.lockerField || '__lock__';
    }

    findAll_ = this.find_;

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {
        if (this.client && this.client.isConnected()) {
            await this.client.close();
            this.log('verbose', `mongodb: successfully disconnected from "${this.getConnectionStringWithoutCredential()}".`);                      
        }

        delete this.client;
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<Db>}
     */
    async connect_(options) {
        if (!this.client || !this.client.isConnected()) {
            let client = new MongoClient(this.connectionString, {useNewUrlParser: true});
            this.client = await client.connect(); 
            this.log('verbose', `mongodb: successfully connected to "${this.getConnectionStringWithoutCredential()}".`);                      
        }       

        return this.client.db(this.database);
    }
    
    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(conn) {
    }

    async ping_() {  
        return this.execute_(db => {
            return db.listCollections(null, { nameOnly: true }).toArray();
        });  
    }

    async execute_(dbExecutor) {
        let db;
    
        try {
            db = await this.connect_();

            return await dbExecutor(db);
        } catch(err) {            
            throw err;
        } finally {
            db && await this.disconnect_(db);
        }
    }

    /**
     * @param {object} [options] - Optional settings.
     * @property {string} [options.bucketName='fs'] - The 'files' and 'chunks' collections will be prefixed with the bucket name followed by a dot.
     * @property {number} [options.chunkSizeBytes] - Number of bytes stored in each chunk. Defaults to 255KB
     * @property {object} [options.writeConcern]
     * @property {object} [options.readPreference]
     */
    async createGridFSBucket_(options) {
        let db = await this.connect_();

        return new GridFSBucket(db, options);
    }

    /**
     * Create a new entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async insertOne_(model, data, options) {
        return this.onCollection_(model, (coll) => coll.insertOne(data, { bypassDocumentValidation: true, ...options }));
    }

    /**
     * Create an array of new entity.
     * @param {string} model 
     * @param {array} data 
     * @param {*} options 
     */
    async insertMany_(model, data, options) {
        return this.onCollection_(model, (coll) => coll.insertMany(data, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    async insertOneIfNotExist_(model, data, options) {
        try {
            return await this.insertOne_(model, data, options)
        } catch (error) {
            if (error.code === 11000) {
                return false;
            }

            throw error;
        }
    }

    /**
     * Replace (insert or update for exsisting) an entity and return original record.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async findOneAndReplace_(model, data, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOneAndReplace(condition, data, options));
    }

    /**
     * Find a document and update it in one atomic operation. Requires a write lock for the duration of the operation.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async findOneAndUpdate_(model, data, condition, options) {     
        return this.onCollection_(model, (coll) => coll.findOneAndUpdate(condition, this._translateUpdate(data), options));
    }

    async findOneAndDelete_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOneAndDelete(condition, options));
    }

    async findOne_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOne(condition, options));
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async updateOne_(model, data, condition, options) { 
        //todo: spin to wait for non __lock__ 

        return this.onCollection_(model, (coll) => coll.updateOne(condition, this._translateUpdate(data), options));
    }

    async updateOneAndReturn_(model, data, condition, options) {     
        let ret = await this.findOneAndUpdate_(model, data, condition, { ...options, upsert: false, returnOriginal: false });
        return ret && ret.value;
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async upsertOne_(model, data, condition, options, retry) { 
        //walk around mongodb failed to setOnInsert with _id

        return this.onCollection_(model, async (coll) => {

            let current, locked = false;

            try {
                do {
                    current = await coll.findOneAndUpdate(condition, { $set: { [this.lockerField]: true } });
                } while (current.value && current.value[this.lockerField]);

                if (current.value) {
                    locked = true;
                    
                    return await coll.updateOne({ _id: current.value._id }, { $set: _.omit(data, [ '_id' ]), $unset: { [this.lockerField]: "" } }, { bypassDocumentValidation: true, ...options });    
                } 

                try { 
                    return await coll.insertOne(data, { bypassDocumentValidation: true, ...options });
                } catch (error2) {                    
                    if (!retry && error2.message.startsWith('E11000 duplicate key error')) {
                        return this.upsertOne_(model, data, condition, options, true);
                    }

                    throw error2;
                }

            } catch (error) {
                
                if (locked) {
                    await coll.updateOne({ _id: current.value._id }, { $unset: { [this.lockerField]: "" } });    
                }

                throw error;
            }
        });        
    }

    /**
     * Update many entities.
     * @param {string} model 
     * @param {object} data - Array of record with _id
     * @param {*} options 
     */
    async upsertMany_(model, data, uniqueKeys, options) { 
        let ops = data.map(record => {
            let { _id, ...updateData } = record;

            let updateOp = {
                $set: updateData
            };

            if (_id) {
                updateOp.$setOnInsert = { _id };
            }

            return {
                updateOne: { filter: { ..._.pick(record, uniqueKeys) }, update: updateOp, upsert: true }
            };
        });

        return this.onCollection_(model, (coll) => coll.bulkWrite(ops, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    async updateManyAndReturn_(model, data, condition, options) {        
        let lockerId = Generators.shortid();

        return this.onCollection_(model, async (coll) => {
            //1.update and set locker
            let ret = await coll.updateMany(
                { ...condition, [this.lockerField]: { $exists: false } }, // for all non-locked
                { $set: { ...data, [this.lockerField]: lockerId } }, // lock it 
                { ...options, upsert: false } );
            
            try {
                //2.return all locked records
                return await coll.find({ [this.lockerField]: lockerId }).toArray(); // return all locked
            } finally {    
                //3.remove lockers
                if (ret.result.nModified > 0) { // unlock
                    await coll.updateMany({ [this.lockerField]: lockerId }, { $unset: { [this.lockerField]: "" } }, { upsert: false });    
                }
            }
        });         
    }

    /**
     * Insert many entities if not exist.
     * @param {*} model 
     * @param {*} data 
     * @param {*} uniqueKeys 
     * @param {*} options 
     */
    async insertManyIfNotExist_(model, data, uniqueKeys, options) {
        let ops = data.map(record => ({
            updateOne: { filter: { ..._.pick(record, uniqueKeys) }, update: { $setOnInsert: record }, upsert: true }
        }));

        return this.onCollection_(model, (coll) => coll.bulkWrite(ops, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    /**
     * Update multiple documents.
     * @param {string} model 
     * @param {*} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async updateMany_(model, data, condition, options) { 
        return this.onCollection_(model, (coll) => coll.updateMany(condition, this._translateUpdate(data), options));
    }

    /**
     * Replace an existing entity or create a new one.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async replaceOne_(model, data, condition, options) {  
        return this.onCollection_(model, (coll) => coll.replaceOne(condition, data, options));
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async deleteOne_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.deleteOne(condition, options));
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async deleteMany_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.deleteMany(condition, options));
    }

    /**
     * Perform select operation.
     * @param {*} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async find_(model, condition, options) {
        return this.onCollection_(model, async coll => {
            let queryOptions = {...options};
            let query = {};

            if (condition) {
                let { $projection, $orderBy, $offset, $limit, $query, ...others } = condition;

                if ($projection) {
                    queryOptions.projection = $projection;                
                }

                if ($orderBy) {
                    queryOptions.sort = $orderBy;                
                }

                if ($offset) {
                    queryOptions.skip = $offset;                
                }

                if ($limit) {
                    queryOptions.limit = $limit;                
                }

                Object.assign(query, _.pickBy(others, (v,k) => k[0] !== '$'));

                if ($query) {
                    Object.assign(query, $query);
                } 
            }

            let result = await coll.find(query, queryOptions).toArray();

            if (condition && condition.$totalCount) {
                let totalCount = await coll.find(query).count();
                return [ result, totalCount ];
            }

            return result;
        });
    }   

    async aggregate_(model, pipeline, options) {
        return this.onCollection_(model, (coll) => coll.aggregate(pipeline, options));
    }

    async onCollection_(model, executor) {
        return this.execute_(db => executor(db.collection(model)));
    }

    _translateUpdate(update) {
        let ops = _.pick(update, UpdateOps);
        let others = _.omit(update, UpdateOps);

        if (ops.$set) {
            ops.$set = { ...ops.$set, ...others };
        } else if (!_.isEmpty(others)) {
            ops.$set = others;
        }

        return ops;
    }
}

MongodbConnector.driverLib = mongodb;

module.exports = MongodbConnector;
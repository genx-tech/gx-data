"use strict";

require("source-map-support/register");
const {
  _
} = require('@genx/july');
const {
  tryRequire
} = require('@genx/sys');
const mongodb = tryRequire('mongodb');
const {
  MongoClient,
  GridFSBucket,
  ObjectID
} = mongodb;
const Connector = require('../../Connector');
const Generators = require('../../Generators');
const {
  InvalidArgument,
  DatabaseError
} = require('../../utils/Errors');
const UpdateOpsField = ['$currentDate', '$inc', '$min', '$max', '$mul', '$rename', '$set', '$setOnInsert', '$unset'];
const UpdateOpsArray = ['$addToSet', '$pop', '$pull', '$push', '$pullAll'];
const UpdateOps = UpdateOpsField.concat(UpdateOpsArray);
class MongodbConnector extends Connector {
  constructor(connectionString, options) {
    super('mongodb', connectionString, options);
    this.updatedCount = context => context.result.modifiedCount;
    this.deletedCount = context => context.result.deletedCount;
    this.toObjectID = str => ObjectID(str);
    this.lockerField = this.options.lockerField || '__lock__';
    this.findAll_ = this.find_;
  }
  ensureInsertOne(opReturn) {
    if (opReturn.result.ok !== 1 || opReturn.result.n !== 1) {
      throw new DatabaseError('Mongodb "insertOne" operation failed');
    }
    return opReturn.insertedId;
  }
  ensureUpdateOne(opReturn, enforceUpdated) {
    if (opReturn.result.ok !== 1 || enforceUpdated && opReturn.result.nModified !== 1) {
      throw new DatabaseError('Mongodb "updateOne" operation failed');
    }
  }
  async end_() {
    if (this.client) {
      await this.client.close();
      this.log('verbose', `mongodb: successfully disconnected from "${this.getConnectionStringWithoutCredential()}".`);
    }
    delete this.client;
  }
  async connect_(options) {
    if (!this.client) {
      const client = new MongoClient(this.connectionString, {
        useNewUrlParser: true
      });
      this.client = await client.connect();
      this.log('verbose', `mongodb: successfully connected to "${this.getConnectionStringWithoutCredential()}".`);
    }
    return this.client.db(this.database);
  }
  async disconnect_(conn) {}
  async ping_() {
    return this.execute_(db => {
      return db.listCollections(null, {
        nameOnly: true
      }).toArray();
    });
  }
  async execute_(dbExecutor) {
    let db;
    try {
      db = await this.connect_();
      return await dbExecutor(db);
    } finally {
      db && (await this.disconnect_(db));
    }
  }
  async createGridFSBucket_(options) {
    const db = await this.connect_();
    return new GridFSBucket(db, options);
  }
  async insertOne_(model, data, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'insertOne: ' + JSON.stringify({
        model,
        data,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.insertOne(data, options));
  }
  async insertMany_(model, data, options) {
    options = {
      ordered: false,
      ...options
    };
    if (this.options.logStatement) {
      this.log('verbose', 'insertMany: ' + JSON.stringify({
        model,
        count: data.length,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.insertMany(data, options));
  }
  async insertOneIfNotExist_(model, data, options) {
    try {
      return await this.insertOne_(model, data, options);
    } catch (error) {
      if (error.code === 11000) {
        return false;
      }
      throw error;
    }
  }
  async updateOne_(model, data, condition, options) {
    data = this._translateUpdate(data);
    if (this.options.logStatement) {
      this.log('verbose', 'updateOne: ' + JSON.stringify({
        model,
        data,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.updateOne(condition, data, options));
  }
  async updateOneAndReturn_(model, data, condition, options) {
    const ret = await this.findOneAndUpdate_(model, data, condition, {
      ...options,
      upsert: false,
      returnOriginal: false
    });
    return ret && ret.value;
  }
  async upsertOne_(model, data, condition, options, dataOnInsert) {
    const trans = this._translateUpdate(data);
    const {
      _id,
      ...others
    } = trans.$set || {};
    if (!_.isNil(_id)) {
      trans.$set = others;
      trans.$setOnInsert = {
        _id
      };
    }
    if (!_.isEmpty(dataOnInsert)) {
      trans.$setOnInsert = {
        ...trans.$setOnInsert,
        ...dataOnInsert
      };
    }
    options = {
      ...options,
      upsert: true
    };
    if (this.options.logStatement) {
      this.log('verbose', 'upsertOne: ' + JSON.stringify({
        model,
        data: trans,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.updateOne(condition, trans, options));
  }
  async upsertOneAndReturn_(model, data, condition, options, dataOnInsert) {
    const trans = this._translateUpdate(data);
    const {
      _id,
      ...others
    } = trans.$set || {};
    if (!_.isNil(_id)) {
      trans.$set = others;
      trans.$setOnInsert = {
        _id
      };
    }
    if (!_.isEmpty(dataOnInsert)) {
      trans.$setOnInsert = {
        ...trans.$setOnInsert,
        ...dataOnInsert
      };
    }
    options = {
      ...options,
      upsert: true,
      returnOriginal: false
    };
    if (this.options.logStatement) {
      this.log('verbose', 'upsertOne: ' + JSON.stringify({
        model,
        data: trans,
        condition,
        options
      }));
    }
    const ret = await this.onCollection_(model, coll => coll.findOneAndUpdate(condition, trans, options));
    return ret && ret.value;
  }
  async upsertMany_(model, data, uniqueKeys, options, dataOnInsert) {
    const ops = data.map(record => {
      const {
        _id,
        ...updateData
      } = record;
      const updateOp = this._translateUpdate(updateData);
      if (_id) {
        updateOp.$setOnInsert = {
          _id,
          ...dataOnInsert
        };
      } else if (!_.isEmpty(dataOnInsert)) {
        updateOp.$setOnInsert = dataOnInsert;
      }
      return {
        updateOne: {
          filter: {
            ..._.pick(record, uniqueKeys)
          },
          update: updateOp,
          upsert: true
        }
      };
    });
    options = {
      ordered: false,
      ...options
    };
    if (this.options.logStatement) {
      this.log('verbose', 'bulkWrite: ' + JSON.stringify({
        model,
        count: ops.length,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.bulkWrite(ops, options));
  }
  async updateManyAndReturn_(model, data, condition, options) {
    const lockerId = Generators.shortid();
    if (this.options.logStatement) {
      this.log('verbose', 'updateMany+find+updateMany: ' + JSON.stringify({
        model,
        count: data.length,
        condition,
        options
      }));
    }
    return this.onCollection_(model, async coll => {
      const ret = await coll.updateMany({
        ...condition,
        [this.lockerField]: {
          $exists: false
        }
      }, {
        $set: {
          ...data,
          [this.lockerField]: lockerId
        }
      }, {
        ...options,
        upsert: false
      });
      try {
        return await coll.find({
          [this.lockerField]: lockerId
        }, {
          projection: {
            [this.lockerField]: 0
          }
        }).toArray();
      } finally {
        if (ret.result.nModified > 0) {
          await coll.updateMany({
            [this.lockerField]: lockerId
          }, {
            $unset: {
              [this.lockerField]: ''
            }
          }, {
            upsert: false
          });
        }
      }
    });
  }
  async insertManyIfNotExist_(model, data, uniqueKeys, options) {
    console.log('buggy: tofix');
    const ops = data.map(record => ({
      updateOne: {
        filter: {
          ..._.pick(record, uniqueKeys)
        },
        update: {
          $setOnInsert: record
        },
        upsert: true
      }
    }));
    return this.onCollection_(model, coll => coll.bulkWrite(ops, {
      ordered: false,
      ...options
    }));
  }
  async updateMany_(model, data, condition, options) {
    data = this._translateUpdate(data);
    if (this.options.logStatement) {
      this.log('verbose', 'updateMany: ' + JSON.stringify({
        model,
        count: data.length,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.updateMany(condition, data, options));
  }
  async replaceOne_(model, data, condition, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'replaceOne: ' + JSON.stringify({
        model,
        data,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.replaceOne(condition, data, options));
  }
  async deleteOne_(model, condition, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'deleteOne: ' + JSON.stringify({
        model,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.deleteOne(condition, options));
  }
  async deleteMany_(model, condition, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'deleteMany: ' + JSON.stringify({
        model,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.deleteMany(condition, options));
  }
  async findOneAndReplace_(model, data, condition, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'findOneAndReplace: ' + JSON.stringify({
        model,
        data,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.findOneAndReplace(condition, data, options));
  }
  async findOneAndUpdate_(model, data, condition, options) {
    data = this._translateUpdate(data);
    if (this.options.logStatement) {
      this.log('verbose', 'findOneAndUpdate: ' + JSON.stringify({
        model,
        data,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.findOneAndUpdate(condition, data, options));
  }
  async findOneAndDelete_(model, condition, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'findOneAndDelete: ' + JSON.stringify({
        model,
        condition,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.findOneAndDelete(condition, options));
  }
  async findOne_(model, condition, options) {
    const queryOptions = {
      ...options
    };
    let query;
    if (!_.isEmpty(condition)) {
      const {
        $projection,
        $query,
        ...others
      } = condition;
      if ($projection) {
        queryOptions.projection = $projection;
      }
      query = {
        ...others,
        ...$query
      };
    } else {
      throw new InvalidArgument('findOne requires non-empty query condition.');
    }
    if (this.options.logStatement) {
      this.log('verbose', 'findOne: ' + JSON.stringify({
        model,
        condition: query,
        options: queryOptions
      }));
    }
    return this.onCollection_(model, coll => coll.findOne(query, queryOptions));
  }
  async find_(model, condition, options) {
    const queryOptions = {
      ...options
    };
    let query, requireTotalCount;
    if (!_.isEmpty(condition)) {
      const {
        $projection,
        $totalCount,
        $orderBy,
        $offset,
        $limit,
        $query,
        ...others
      } = condition;
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
      query = {
        ...others,
        ...$query
      };
      requireTotalCount = $totalCount;
    } else {
      query = {};
      requireTotalCount = false;
    }
    if (this.options.logStatement) {
      this.log('verbose', 'find: ' + JSON.stringify({
        model,
        condition: query,
        options: queryOptions
      }));
    }
    return this.onCollection_(model, async coll => {
      const result = await coll.find(query, queryOptions).toArray();
      if (requireTotalCount) {
        const totalCount = await coll.find(query).count();
        return [result, totalCount];
      }
      return result;
    });
  }
  async aggregate_(model, pipeline, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'aggregate: ' + JSON.stringify({
        model,
        pipeline,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.aggregate(pipeline, options).toArray());
  }
  async distinct_(model, field, query, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'distinct: ' + JSON.stringify({
        model,
        field,
        query,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.distinct(field, query, options));
  }
  async count_(model, query, options) {
    if (this.options.logStatement) {
      this.log('verbose', 'count: ' + JSON.stringify({
        model,
        query,
        options
      }));
    }
    return this.onCollection_(model, coll => coll.countDocuments(query, options));
  }
  async onCollection_(model, executor) {
    return this.execute_(db => executor(db.collection(model)));
  }
  _translateUpdate(update) {
    const ops = _.pick(update, UpdateOps);
    const others = _.omit(update, UpdateOps);
    if (ops.$set) {
      ops.$set = {
        ...ops.$set,
        ...others
      };
    } else if (!_.isEmpty(others)) {
      ops.$set = others;
    }
    return ops;
  }
}
MongodbConnector.driverLib = mongodb;
module.exports = MongodbConnector;
//# sourceMappingURL=Connector.js.map
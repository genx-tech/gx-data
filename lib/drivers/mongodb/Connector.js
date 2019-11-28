"use strict";

const {
  _,
  waitUntil_
} = require('rk-utils');

const {
  tryRequire
} = require('../../utils/lib');

const mongodb = tryRequire('mongodb');
const {
  MongoClient,
  GridFSBucket
} = mongodb;

const Connector = require('../../Connector');

const Generators = require('../../Generators');

const UpdateOpsField = ['$currentDate', '$inc', '$min', '$max', '$mul', '$rename', '$set', '$setOnInsert', '$unset'];
const UpdateOpsArray = ['$addToSet', '$pop', '$pull', '$push', '$pullAll'];
const UpdateOps = UpdateOpsField.concat(UpdateOpsArray);

class MongodbConnector extends Connector {
  constructor(connectionString, options) {
    super('mongodb', connectionString, options);
    this.findAll_ = this.find_;
    this.lockerField = this.options.lockerField || '__lock__';
  }

  async end_() {
    if (this.client && this.client.isConnected()) {
      await this.client.close();
      this.log('verbose', `mongodb: successfully disconnected from "${this.getConnectionStringWithoutCredential()}".`);
    }

    delete this.client;
  }

  async connect_(options) {
    if (!this.client || !this.client.isConnected()) {
      let client = new MongoClient(this.connectionString, {
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
    } catch (err) {
      throw err;
    } finally {
      db && (await this.disconnect_(db));
    }
  }

  async createGridFSBucket_(options) {
    let db = await this.connect_();
    return new GridFSBucket(db, options);
  }

  async insertOne_(model, data, options) {
    return this.onCollection_(model, coll => coll.insertOne(data, {
      bypassDocumentValidation: true,
      ...options
    }));
  }

  async insertMany_(model, data, options) {
    return this.onCollection_(model, coll => coll.insertMany(data, {
      bypassDocumentValidation: true,
      ordered: false,
      ...options
    }));
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

  async findOneAndReplace_(model, data, condition, options) {
    return this.onCollection_(model, coll => coll.findOneAndReplace(condition, data, options));
  }

  async findOneAndUpdate_(model, data, condition, options) {
    return this.onCollection_(model, coll => coll.findOneAndUpdate(condition, this._translateUpdate(data), options));
  }

  async findOneAndDelete_(model, condition, options) {
    return this.onCollection_(model, coll => coll.findOneAndDelete(condition, options));
  }

  async findOne_(model, condition, options) {
    return this.onCollection_(model, coll => coll.findOne(condition, options));
  }

  async updateOne_(model, data, condition, options) {
    return this.onCollection_(model, coll => coll.updateOne(condition, this._translateUpdate(data), options));
  }

  async updateOneAndReturn_(model, data, condition, options) {
    let ret = await this.findOneAndUpdate_(model, data, condition, { ...options,
      upsert: false,
      returnOriginal: false
    });
    return ret && ret.value;
  }

  async upsertOne_(model, data, condition, options) {
    let trans = this._translateUpdate(data);

    let {
      _id,
      ...others
    } = trans.$set;

    if (!_.isNil(_id)) {
      trans.$set = others;
      trans.$setOnInsert = {
        _id
      };
    }

    return this.onCollection_(model, coll => coll.updateOne(condition, trans, { ...options,
      upsert: true
    }));
  }

  async upsertMany_(model, data, uniqueKeys, options) {
    let ops = data.map(record => {
      let {
        _id,
        ...updateData
      } = record;
      let updateOp = {
        $set: updateData
      };

      if (_id) {
        updateOp.$setOnInsert = {
          _id
        };
      }

      return {
        updateOne: {
          filter: { ..._.pick(record, uniqueKeys)
          },
          update: updateOp,
          upsert: true
        }
      };
    });
    return this.onCollection_(model, coll => coll.bulkWrite(ops, {
      bypassDocumentValidation: true,
      ordered: false,
      ...options
    }));
  }

  async updateManyAndReturn_(model, data, condition, options) {
    let lockerId = Generators.shortid();
    return this.onCollection_(model, async coll => {
      let ret = await coll.updateMany({ ...condition,
        [this.lockerField]: {
          $exists: false
        }
      }, {
        $set: { ...data,
          [this.lockerField]: lockerId
        }
      }, { ...options,
        upsert: false
      });

      try {
        return await coll.find({
          [this.lockerField]: lockerId
        }).toArray();
      } finally {
        if (ret.result.nModified > 0) {
          await coll.updateMany({
            [this.lockerField]: lockerId
          }, {
            $unset: {
              [this.lockerField]: ""
            }
          }, {
            upsert: false
          });
        }
      }
    });
  }

  async insertManyIfNotExist_(model, data, uniqueKeys, options) {
    let ops = data.map(record => ({
      updateOne: {
        filter: { ..._.pick(record, uniqueKeys)
        },
        update: {
          $setOnInsert: record
        },
        upsert: true
      }
    }));
    return this.onCollection_(model, coll => coll.bulkWrite(ops, {
      bypassDocumentValidation: true,
      ordered: false,
      ...options
    }));
  }

  async updateMany_(model, data, condition, options) {
    return this.onCollection_(model, coll => coll.updateMany(condition, this._translateUpdate(data), options));
  }

  async replaceOne_(model, data, condition, options) {
    return this.onCollection_(model, coll => coll.replaceOne(condition, data, options));
  }

  async deleteOne_(model, condition, options) {
    return this.onCollection_(model, coll => coll.deleteOne(condition, options));
  }

  async deleteMany_(model, condition, options) {
    return this.onCollection_(model, coll => coll.deleteMany(condition, options));
  }

  async find_(model, condition, options) {
    return this.onCollection_(model, async coll => {
      let queryOptions = { ...options
      };
      let query = {};

      if (condition) {
        let {
          $projection,
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

        Object.assign(query, _.pickBy(others, (v, k) => k[0] !== '$'));

        if ($query) {
          Object.assign(query, $query);
        }
      }

      let result = await coll.find(query, queryOptions).toArray();

      if (condition && condition.$totalCount) {
        let totalCount = await coll.find(query).count();
        return [result, totalCount];
      }

      return result;
    });
  }

  async aggregate_(model, pipeline, options) {
    return this.onCollection_(model, coll => coll.aggregate(pipeline, options));
  }

  async onCollection_(model, executor) {
    return this.execute_(db => executor(db.collection(model)));
  }

  _translateUpdate(update) {
    let ops = _.pick(update, UpdateOps);

    let others = _.omit(update, UpdateOps);

    if (ops.$set) {
      ops.$set = { ...ops.$set,
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
'use strict';

const winston = require('winston');
const Connector = require('../Connector');
const Generators = require('../../../Generators');

const TEST_DB = 'oolong-unit-test';

describe('unit:connector:mongodb', function () {    
    let logger = winston.createLogger({
        "level": "verbose",
        "transports": [
            new winston.transports.Console({                            
                "format": winston.format.combine(winston.format.colorize(), winston.format.simple())
            })
        ]
    });

    let connector;    

    before(async function () {
        connector = new Connector(`mongodb://root:root@localhost/${TEST_DB}?authSource=admin&useUnifiedTopology=1`, { logger });        
    });

    after(async function () {        
        await connector.end_();
    });

    describe('basic', function () {
        it('ping', async function () {
            let alive = await connector.ping_();
            alive.should.be.ok();
        });
    });

    describe('crud', function () {
        it('upsert one', async function () {
            await connector.onCollection_('test_crud', collection => collection.createIndexes([ { key: { key: 1, tag: 1 }, unique: true }]));

            let retDel = await connector.deleteMany_('test_crud', {                
                tag: 'upsertOne'
            });

            retDel.result.ok.should.be.exactly(1);

            let empty = await connector.findAll_('test_crud', {                
                tag: 'upsertOne'
            });

            empty.length.should.be.exactly(0);

            let id1 = Generators.shortid();

            let ret = await connector.upsertOne_('test_crud', {
                _id: id1,
                key: 10,
                tag: 'upsertOne'
            }, { key: 10, tag: 'upsertOne' });

            ret.result.ok.should.be.exactly(1);

            let oneRecord = await connector.findAll_('test_crud', {                
                tag: 'upsertOne'
            });

            oneRecord.length.should.be.exactly(1);
            oneRecord[0]._id.should.be.equal(id1);

            await connector.upsertOne_('test_crud', {
                _id: Generators.shortid(),
                key: 20,
                tag: 'upsertOne'
            }, { key: 10, tag: 'upsertOne' });

            oneRecord = await connector.findAll_('test_crud', {                
                tag: 'upsertOne'
            });

            oneRecord.length.should.be.exactly(1);
            oneRecord[0]._id.should.be.equal(id1);
            oneRecord[0].key.should.be.exactly(20);            

            let id2 = Generators.shortid();

            await connector.upsertOne_('test_crud', {
                _id: id2,
                key: 10,
                tag: 'upsertOne'
            }, { key: 20, tag: 'upsertOne' });

            let multiRecords = await connector.findAll_('test_crud', {                
                tag: 'upsertOne'
            });  
            
            multiRecords.length.should.be.exactly(1);
            multiRecords[0]._id.should.be.equal(id1);
        });

        it('upsert many', async function () {
            let retDel = await connector.deleteMany_('test_crud', {                
                tag: 'upsertMany'
            });

            retDel.result.ok.should.be.exactly(1);

            let empty = await connector.findAll_('test_crud', {                
                tag: 'upsertMany'
            });

            empty.length.should.be.exactly(0);

            let id1 = Generators.shortid();

            let ret = await connector.insertOne_('test_crud', {
                _id: id1,
                key: 10,
                tag: 'upsertMany'
            });

            ret.result.ok.should.be.exactly(1);

            let id2 = Generators.shortid(), id3 = Generators.shortid();

            await connector.upsertMany_('test_crud', [{
                _id: id1,
                key: 20,
                tag: 'upsertMany'
            }, {
                _id: id2,
                key: 30,
                tag: 'upsertMany'
            }, {
                _id: id3,
                key: 40,
                tag: 'upsertMany'
            }], [ '_id' ]);

            let item = await connector.findOne_('test_crud', { _id: id1 });
            item.key.should.be.exactly(20);

            let allUpdated = await connector.findAll_('test_crud', {                
                tag: 'upsertMany'
            });

            allUpdated.length.should.be.exactly(3);

            await connector.insertManyIfNotExist_('test_crud', [{
                _id: Generators.shortid(),
                key: 20,
                tag: 'upsertMany'
            }, {
                _id: Generators.shortid(),
                key: 30,
                tag: 'upsertMany'
            }, {
                _id: Generators.shortid(),
                key: 50,
                tag: 'upsertMany'
            }], [ 'key' ]);

            let partialUpdated = await connector.findAll_('test_crud', {                
                tag: 'upsertMany'
            });

            partialUpdated.length.should.be.exactly(4);

            partialUpdated[0]._id.should.be.equal(id1);
            partialUpdated[1]._id.should.be.equal(id2);
            partialUpdated[2]._id.should.be.equal(id3);
        });

        it('find', async function () {

            let retDel = await connector.deleteMany_('test_crud', {                
                tag: 'insertMany'
            });

            retDel.result.ok.should.be.exactly(1);

            await connector.insertMany_('test_crud', [{
                key: 10,
                tag: 'insertMany'
            }, {
                key: 20,
                tag: 'insertMany'
            }, {
                key: 30,
                tag: 'insertMany'
            }, {
                key: 40,
                tag: 'insertMany'
            }]);

            let [ result, totalCount ] = await connector.findAll_('test_crud', { tag: 'insertMany', $totalCount: true, $limit: 2 });
            result.length.should.be.exactly(2);
            totalCount.should.be.exactly(4);
        });
    });
});
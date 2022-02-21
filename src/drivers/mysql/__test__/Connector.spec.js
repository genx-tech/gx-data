'use strict';

const winston = require('winston');
const Connector = require('../Connector');

const TEST_DB = 'oolong-unit-test';

describe('unit:connector:mysql', function () {    
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
        connector = new Connector(`mysql://root:root@localhost/${TEST_DB}`, { logger, logStatement: true });

        await connector.execute_('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET ?? COLLATE ??', 
            [ TEST_DB, 'utf8mb4', 'utf8mb4_0900_ai_ci' ], { createDatabase: true });

        await connector.execute_('CREATE TABLE IF NOT EXISTS ?? (a INT NOT NULL PRIMARY KEY, b INT) ENGINE = InnoDB', 
            [ 't' ]);

        await connector.execute_('CREATE TABLE IF NOT EXISTS ?? (a INT NOT NULL PRIMARY KEY, b INT) ENGINE = InnoDB', 
            [ 't2' ]);    

        await connector.execute_('CREATE TABLE IF NOT EXISTS ?? (a INT NOT NULL PRIMARY KEY, b INT, c INT, UNIQUE KEY (`b`)) ENGINE = InnoDB', 
            [ 't3' ]);        

        await connector.execute_('TRUNCATE TABLE ??',  [ 't' ]);    
    });

    after(async function () {
        await connector.execute_('DROP DATABASE IF EXISTS ??', [ TEST_DB ]);
        await connector.end_();
    });

    describe('basic', function () {
        it('ping', async function () {
            let alive = await connector.ping_();
            alive.should.be.ok();
        });
    });

    describe('crud', function () {
        it('insert', async function () {
            let result = await connector.create_('t', { a: 1, b: 2 });
            connector.getNumOfAffectedRows(result).should.be.exactly(1);
        });

        it('insert duplicate', async function () {
            (async () => connector.create_('t', { a: 1, b: 2 }))().should.be.rejectedWith("Duplicate entry '1' for key 'PRIMARY'");
        });

        it('update', async function() {
            let result = await connector.update_('t', { b: 1 }, { a: 1 });
            connector.getNumOfAffectedRows(result).should.be.exactly(1);
        });

        it('find', async function() {
            let result = await connector.find_('t', { $query: { a: 1 } });
            result.length.should.be.exactly(1);            
            result[0].b.should.be.exactly(1);
        });

        it('find with count', async function() {
            let result = await connector.find_('t', { $projection: { type: 'function', name: 'count', args: [ 'a' ], alias: 'count' }, $query: { a: 1 } });
            result.length.should.be.exactly(1);            
            result[0].count.should.be.exactly(1);
        });

        it('find order by', async function() {
            let result = await connector.create_('t', { a: 3, b: 2 });
            result = await connector.create_('t', { a: 2, b: 3 });

            result = await connector.find_('t', { $projection: '*', $orderBy: { a: true } });
            result.length.should.be.exactly(3);            
            result[0].a.should.be.exactly(1);
            result[1].a.should.be.exactly(2);
            result[2].a.should.be.exactly(3);

            result = await connector.find_('t', { $projection: '*', $orderBy: { b: false } });
            result.length.should.be.exactly(3);            
            result[0].b.should.be.exactly(3);
            result[1].b.should.be.exactly(2);
            result[2].b.should.be.exactly(1);
        });

        it('find limit', async function() {
            let result = await connector.find_('t', { $projection: '*', $limit: 1, $offset: 0 });
            result.length.should.be.exactly(1);

            result = await connector.find_('t', { $projection: '*', $orderBy: { b: false }, $limit: 1, $offset: 1 });
            result.length.should.be.exactly(1);            
            result[0].b.should.be.exactly(2);
        });

        it('delete', async function() {
            let result = await connector.delete_('t', { a: 1 });
            connector.getNumOfAffectedRows(result).should.be.exactly(1);

            result = await connector.find_('t', { $projection: { type: 'function', name: 'count', args: [ 'a' ], alias: 'count' }, $query: { a: 1 } });
            result.length.should.be.exactly(1);            
            result[0].count.should.be.exactly(0);
        });

        it('upsertMany', async function() {
            let result = await connector.insertOne_('t3', { a: 1, b: 10, c: 100 });
            connector.getNumOfAffectedRows(result).should.be.exactly(1);

            result = await connector.insertOne_('t3', { a: 2, b: 20, c: 200 });
            connector.getNumOfAffectedRows(result).should.be.exactly(1);

            await connector.upsertMany_('t3', ['a', 'b', 'c'], [[2, 30, 300], [3, 10, 300]], { c: 400 });

            const rows = await connector.find_('t3', {});
            rows.should.be.eql([ { a: 1, b: 10, c: 400 }, { a: 2, b: 20, c: 400 } ]);

            await connector.upsertMany_('t3', ['a', 'b', 'c'], [[4, 40, 300], [5, 50, 300]], { c: 400 });
            const rows2 = await connector.find_('t3', { $query: { a: { $gt: 3 } } });
            rows2[0].c.should.be.exactly(300);
            rows2[1].c.should.be.exactly(300);
        });
    });

    describe('transaction', function () {
        it('commit', async function () {
            let conn = await connector.beginTransaction_();

            let result1 = await connector.create_('t', { 
                a: 20, b: 13 
            }, { connection: conn });

            result1.affectedRows.should.be.exactly(1);
            
            let result2 = await connector.create_('t2', { 
                a: 2, b: 1
            }, { connection: conn });

            result2.affectedRows.should.be.exactly(1);

            let result3 = await connector.update_('t2', { 
                b: 20
            }, { a: 2 }, null, { connection: conn });

            result3.affectedRows.should.be.exactly(1);

            let result4 = await connector.find_('t2', { $query: { a: 2 } }, { connection: conn });
            await connector.commit_(conn);

            console.log(result4);

            result4[0].b.should.be.exactly(20);
            
            let result5 = await connector.find_('t', { $query: { a: 20 } });
            console.log(result5);
            result5[0].b.should.be.exactly(13);

            await connector.delete_('t', { a: 20 });
            await connector.delete_('t2', { a: 2 });
        });

        it('rollback', async function () {
            let conn = await connector.beginTransaction_();

            await connector.create_('t', { 
                a: 20, b: 13 
            }, { connection: conn });
            
            await connector.create_('t2', { 
                a: 2, b: 1
            }, { connection: conn });

            await connector.update_('t2', { 
                b: 20
            }, { a: 2 }, null, { connection: conn });      
            
            await connector.rollback_(conn);

            let result4 = await connector.find_('t2', { $query : { a: 2 } });            
            result4.length.should.be.exactly(0);

            let result5 = await connector.find_('t', { $query: { a: 20 } });
            result5.length.should.be.exactly(0);
        });
    });
});
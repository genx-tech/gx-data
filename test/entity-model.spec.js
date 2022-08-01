'use strict';

const testSuite = require('@genx/test');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname);

testSuite(
    function (suite) {
        suite.testCase('test', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');
                    await db.createDbIfNotExist_(true);
                    
                    const TestEntity = db.model('TestEntity');
                    const a = await TestEntity.create_({
                        category: 'Category 1',
                        code: 'test',
                        name: 'Test',
                        numValue: 10.5,
                        ':unit': {
                            code: 'kg',
                            name: 'Kilogram'
                        }
                    });

                    should.exist(a);
                    a.category.should.be.exactly('Category 1');

                    const executedCount1 = db.connector.executedCount;

                    const b = await TestEntity.ensureFields_(a, ['name', 'numValue']);
                    const executedCount2 = db.connector.executedCount;

                    b.should.be.eql(a);
                    executedCount1.should.be.exactly(executedCount2);

                    const c = await TestEntity.ensureFields_(a, ['name', 'unit.name']);

                    const executedCount3 = db.connector.executedCount;
                    executedCount3.should.be.exactly(executedCount1+1);

                    c.should.have.keys(':unit');
                    c[":unit"].name.should.be.exactly('Kilogram');   
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: "./conf",
                    /*
                    logger: {
                        level: 'verbose',
                    },
                    verbose: true*/
                }
            );
        });
    },
    { verbose: true }
);

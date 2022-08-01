'use strict';

const testSuite = require('@genx/test');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname);

testSuite(
    function (suite) {
        suite.testCase('getConnectionStringWithoutCredential', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');
                    await db.createDbIfNotExist_(true);
                    
                    const connStr = db.connector.getConnectionStringWithoutCredential();
                    connStr.should.be.exactly('mysql://localhost/gx-data-test');

                    const connStr2 = 'mysql://user:pass@localhost/gx-data-test?multiple=1';
                    const connStr2Actual = db.connector.getConnectionStringWithoutCredential(connStr2);
                    
                    connStr2Actual.should.be.exactly('mysql://localhost/gx-data-test?multiple=1');
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: "./conf",
                    logger: {
                        level: 'verbose',
                    }
                }
            );
        });
    },
    { verbose: true }
);

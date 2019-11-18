'use strict';

const winston = require('winston');
const Connector = require('../Connector');

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
        connector = new Connector(`mongodb://root:root@localhost/${TEST_DB}?authSource=admin`, { logger });        
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
        
    });
});
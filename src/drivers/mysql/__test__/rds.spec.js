'use strict';

const Connector = require('../Connector');
const assert = require('assert');

describe('unit:connector:mysql', function () {
    it('Use connection string', async () => {
        const connector = new Connector(`mysql://root:root@localhost/mysql`, {
            logStatement: true,
        });
        const result = await connector.execute_('SELECT * FROM db');
        assert.ok(result.length > 0);
        await connector.end_();
    });

    it('Use connection obj', async () => {
        const connector = new Connector(
            {
                host: 'localhost',
                user: 'root',
                password: 'root',
                database: 'mysql',
                port: 3306
            }
            ,
            {
                logStatement: true,
            }
        );
        const result = await connector.execute_('SELECT * FROM db');
        assert.ok(result.length > 0);
        await connector.end_();
    });


});
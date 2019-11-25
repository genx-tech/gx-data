'use strict';

const path = require('path');
const parseCsvFile = require('../parseCsvFile');

const csvFile = path.resolve(__dirname, '../../../test/files/australia.csv');

describe.only('unit:parseCsvFile', function () {    
    it('parse csv', async function () {
        let result = await parseCsvFile(csvFile);
        console.log(result);
    });
});
'use strict';

const hyperid = require('../hyperid');
const uniqid = require('../uniqid');
const uuid = require('../uuid');

describe('unit:generators:auto', function () {        
    describe('hyperid', function () {
        it('length', async function () {
            let id = hyperid({ type: 'text' });
            
            console.log(id);
        });
    });

    describe('uniqid', function () {
        it('length', async function () {
            let id = uniqid({ type: 'text' });
            
            console.log(id);
        });
    });

    describe('uuid', function () {
        it('length', async function () {
            let id = uuid({ type: 'text' });
            
            console.log(id);
        });
    });
});
'use strict';

const hyperid = require('../../../../lib/runtime/auto/hyperid');
const uniqid = require('../../../../lib/runtime/auto/uniqid');
const uuid = require('../../../../lib/runtime/auto/uuid');

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
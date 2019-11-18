'use strict';

const Types = require('..');

describe('unit:types:general', function () {    

    describe('index', function () {
        it('types has all upper-case type info', function () {
            Types.should.have.keys('ARRAY', 'BINARY', 'BOOLEAN', 'ENUM', 'DATETIME', 'INTEGER', 'NUMBER', 'OBJECT', 'TEXT');
        });

        it('types has all lower-case type info', function () {
            Types.should.have.keys('array', 'binary', 'boolean', 'enum', 'datetime', 'integer', 'number', 'object', 'text');
        });

        it('types has builtin', function () {
            Types.should.have.keys('Builtin');
        });
    });
});
'use strict';

const Types = require('..');

describe('unit:types:object', function () {    
    let obj = {
        'intKey': 100,
        'strKey': 'string',
        'arrayKey': [
            {
                key1: 'value1',
                key2: '0'
            },
            {
                key1: 'value2',
                key2: '1'
            }
        ],
        'objKey': {
            'objKey2': {
                intKey: 1,
                boolKey: 'true'
            }
        }
    };

    let schema = {
        'intKey': { type: 'integer' },
        'intKey2': { type: 'integer', optional: true, 'default': 200 },
        'strKey': { type: 'text' },
        'arrayKey': { type: 'array', 'elementSchema': {
            key1: { type: 'text' },
            key2: { type: 'boolean' },
        } },
        'objKey': {
            type: 'object',
            schema: {
                'objKey2': {
                    type: 'object',
                    schema: {
                        intKey: { type: 'integer' },
                        boolKey: { type: 'boolean' }
                    }
                }
            }
        }
    };

    it('validate object by schema', function () {        
        let sanitized = Types.OBJECT.sanitize(obj, { schema });
        let expected = {
            intKey: 100,
            intKey2: 200,
            strKey: 'string',
            arrayKey: [ { key1: 'value1', key2: false }, { key1: 'value2', key2: true } ],
            objKey: { objKey2: { intKey: 1, boolKey: true } }
        };
        
        sanitized.should.be.eql(expected);
    });

    it('validate object with error - string to integer', function () {        
        let schemaErr = {
            'strKey': { type: 'integer' }            
        };

        (() => Types.OBJECT.sanitize(obj, { schema: schemaErr })).should.throw('Invalid integer value')
    });

    it('validate object with error - missing required', function () {        
        let schemaErr = {
            'intKey2': { type: 'integer' }          
        };

        (() => Types.OBJECT.sanitize(obj, { schema: schemaErr })).should.throw('Missing required property "intKey2"')
    });

    it('validate object with error - missing required 2', function () {        
        let schemaErr = {
            'objKey': {
                type: 'object',
                schema: {
                    'objKey2': {
                        type: 'object',
                        schema: {
                            nonExistKey: { type: 'integer' }
                        }
                    }
                }
            }          
        };

        (() => Types.OBJECT.sanitize(obj, { schema: schemaErr })).should.throw('Missing required property "objKey.objKey2.nonExistKey"')
    });

    it('validate object with error - missing required 3', function () {        
        let schemaErr = {
            'arrayKey': {
                type: 'array',
                elementSchema: {
                    key3: { type: 'text' }
                }
            }          
        };

        (() => Types.OBJECT.sanitize(obj, { schema: schemaErr })).should.throw('Missing required property "arrayKey[0].key3"');
    });
});
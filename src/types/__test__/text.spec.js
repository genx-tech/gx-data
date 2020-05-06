'use strict';

const Types = require('..');
const { _ } = require('rk-utils');

describe('unit:types:text', function () {       

    it('basic', function () {   
        const fixtures = [
            [ 'abc', 'abc' ],
            [ ' abc', 'abc' ],
            [ 'abc ', 'abc' ],
            [ ' abc  ', 'abc' ],
            [ null, null ],
            [ undefined, undefined ]           
        ];

        fixtures.forEach(([ input, expected ]) => {
            let sanitized = Types.TEXT.sanitize(input, { type: 'text' }); 
            if (typeof sanitized === 'undefined') {
                (typeof expected).should.be.exactly('undefined');
            } else if (_.isNull(expected)) {
                _.isNull(sanitized).should.be.ok();
            } else {
                sanitized.should.be.equal(expected);
            } 
        });
    });

    it('no trim', function () {   
        const fixtures = [
            [ 'abc', 'abc' ],
            [ ' abc', ' abc' ],
            [ 'abc ', 'abc ' ],
            [ ' abc  ', ' abc  ' ],
            [ null, null ],
            [ undefined, undefined ]           
        ];

        fixtures.forEach(([ input, expected ]) => {
            let sanitized = Types.TEXT.sanitize(input, { type: 'text', noTrim: true }); 
            if (typeof sanitized === 'undefined') {
                (typeof expected).should.be.exactly('undefined');
            } else if (_.isNull(expected)) {
                _.isNull(sanitized).should.be.ok();
            } else {
                sanitized.should.be.equal(expected);
            } 
        });
    });

    it('maxLength', function () {   
        const fixtures = [
            [ 'abc', 4, 'abc' ],
            [ 'abc', 3, 'abc' ],
            [ 'abc', 2, null ]
        ];

        fixtures.forEach(([ input, maxLength, expected ]) => {            
            if (_.isNull(expected)) {
                should.throws(() => Types.TEXT.sanitize(input, { type: 'text', maxLength }), /exceeds/)
            } else {
                Types.TEXT.sanitize(input, { type: 'text', maxLength }).should.be.equal(expected);
            } 
        });
    });

    it('fixedLength', function () {   
        const fixtures = [
            [ 'abc', 4, null ],
            [ 'abc', 3, 'abc' ],
            [ 'abc', 2, null ]
        ];

        fixtures.forEach(([ input, fixedLength, expected ]) => {            
            if (_.isNull(expected)) {
                should.throws(() => Types.TEXT.sanitize(input, { type: 'text', fixedLength }), /not correct/)
            } else {
                Types.TEXT.sanitize(input, { type: 'text', fixedLength }).should.be.equal(expected);
            } 
        });
    });
});
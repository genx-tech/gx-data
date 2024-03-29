'use strict';

const normalizePhone = require('../normalizePhone');

let cases = [
    [' (07) 4155 5000', '+61', '+61741555000'],
    [' (07)4155 5000', '+61', '+61741555000'],
    ['(07)41555000', '+61', '+61741555000'],
    [' (07)-4155 5000', '+61', '+61741555000'],
    ['07-41555000', '+61', '+61741555000'],
    ['0415 699 121', '+61', '+61415699121'],
    ['0415699 121', '+61', '+61415699121'],    
    ['0415 699121', '+61', '+61415699121'],        
    ['0415699121', '+61', '+61415699121'],        
    ['0061415699121', '+61', '+61415699121'],        
    ['00610415699121', '+61', '+610415699121'],        
    ['+610415699121', '+61', '+610415699121'],        
    ['+61415699121', '+61', '+61415699121'],        
    ['0061(04)15699121', '+61', '+61415699121'],        
    ['+61 (04) 1569 9121', '+61', '+61415699121'],        
    ['+61(4)15699121', '+61', '+61415699121'],
    ['+61 (02) 9666 1488', '+61', '+61296661488'],

    ['(09)00311212', '+886', '+886900311212'],
    [' (09)00311212', '+886', '+886900311212'],
    [' (09)00 311 212', '+886', '+886900311212'],
    ['(09)00 311 212', '+886', '+886900311212'],
    ['0900-311-212', '+886', '+886900311212'],
    ['0900311212', '+886', '+886900311212'],
    ['0900 311 212', '+886', '+886900311212'],
    ['(+886)900 311 212', '+886', '+886900311212'],
    ['+886900311212', '+886', '+886900311212'],
    ['+886 900 311 212', '+886', '+886900311212'],
    ['+886 (09)00 311 212', '+886', '+886900311212'],
    ['+886(09)00311212', '+886', '+886900311212'],
    ['+886(9)00311212', '+886', '+886900311212'],
];

describe('unit:processors:normalizePhone', function () {      
    cases.forEach(item => {
        it(item[0], function () {
            let r = normalizePhone(item[0], item[1]);
            r.should.be.equal(item[2]);
        });
    });
});
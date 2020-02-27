"use strict";

const validator = require('validator');
const { _ } = require('rk-utils');

exports.toBoolean = (value) => typeof value === 'boolean' ? value : validator.toBoolean(value, true);

exports.toText = (value) => value && (typeof value !== 'string' ? value.toString() : value).trim();

exports.toInt = (value, radix) => _.isInteger(value) ? value : parseInt(value, radix); 

exports.toFloat = (value) => _.isFinite(value) ? value : validator.toFloat(value); 

exports.jsonToBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");       

exports.base64ToJson = (base64) => JSON.parse(Buffer.from(base64, 'base64').toString('ascii'));

exports.textToDate = require('date-fns/parse');

exports.toKvTableByProp = (arrayOfObjects, property) => arrayOfObjects.reduce((table, obj) => {
    table[obj[property]] = obj;
    return table;
}, {});

const remapKeys = (arrayOfObjects, mapping) => {
    if (Array.isArray(arrayOfObjects)) return _.map(arrayOfObjects, obj => remapKeys(obj, mapping));

    let newObj = {};
     _.forOwn(arrayOfObjects, (v, k) => {
        let nk = mapping[k];
        if (!nk) {  
            newObj[k] = v;
        } else if (Array.isArray(nk)) {
            newObj[nk[0]] = remapKeys(v, nk[1]);
        } else {
            newObj[nk] = v;
        }
    });

    return newObj;
};

exports.remapKeys = remapKeys;
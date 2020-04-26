"use strict";

const validator = require("validator");
const { _ } = require("rk-utils");

exports.toBoolean = (value) => (typeof value === "boolean" ? value : validator.toBoolean(value, true));

exports.toText = (value, noTrim) => {
    if (value) {
        value = typeof value !== "string" ? value.toString() : value;
        return noTrim ? value : value.trim();
    }

    return value;
};

exports.toInt = (value, radix) => (_.isInteger(value) ? value : parseInt(value, radix));

exports.toFloat = (value) => (_.isFinite(value) ? value : validator.toFloat(value));

exports.jsonToBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

exports.base64ToJson = (base64) => JSON.parse(Buffer.from(base64, "base64").toString("ascii"));

exports.textToDate = require("date-fns/parse");

exports.toKVPairs = (arrayOfObjects, property, transformer) => {
    const keyGetter = (typeof property === 'function') ? property : obj => obj[property];

    return arrayOfObjects.reduce((table, obj) => {
        table[keyGetter(obj)] = transformer ? transformer(obj) : obj;
        return table;
    }, {});
};

/**
 * Remap the keys of object elements in an array, like projection.
 * @param {*} arrayOfObjects
 * @param {*} mapping - key to newKey or key to array[ newKey, valueMap ] for next level mapping
 * @param {boolean} keepUnmapped - If true, will keep those not in mapping as its original key, otherwise filter out
 */
const mapKeysDeep = (arrayOfObjects, mapping, keepUnmapped) => {
    if (Array.isArray(arrayOfObjects)) return _.map(arrayOfObjects, (obj) => mapKeysDeep(obj, mapping));

    if (typeof mapping === 'string') return { [mapping]: arrayOfObjects };

    let newObj = {};
    _.forOwn(arrayOfObjects, (v, k) => {
        if (k in mapping) {
            let nk = mapping[k];
            if (Array.isArray(nk)) {
                newObj[nk[0]] = { ...newObj[nk[0]], ...mapKeysDeep(v, nk[1]) };
            } else {
                newObj[nk] = v;
            }
        } else {
            if (keepUnmapped) {
                newObj[k] = v;
            }
        }
    });

    return newObj;
};

exports.mapKeysDeep = mapKeysDeep;

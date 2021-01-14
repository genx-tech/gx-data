"use strict";

const validator = require("validator");
const { _ } = require("rk-utils");
const remap = require('./utils/remap');

exports.toBoolean = (value) => (typeof value === "boolean" ? value : validator.toBoolean(value.toString(), true));

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

exports.toKVPairs = (arrayOfObjects, property, transformer) => {
    const keyGetter = typeof property === "function" ? property : (obj) => obj[property];

    return arrayOfObjects.reduce((table, obj) => {
        table[keyGetter(obj)] = transformer ? transformer(obj) : obj;
        return table;
    }, {});
};

exports.toSet = (arrayOfObjects, property) => {
    if (!arrayOfObjects) return new Set();

    const valueGetter = typeof property === "function" ? property : (obj) => obj[property];
    const result  = new Set();

    arrayOfObjects.forEach(obj => result.add(valueGetter(obj)));

    return result;
}

const mapArraysDeep = (arrayOfObjects, mapping, keepUnmapped) =>
    _.map(arrayOfObjects, (obj) => remap(obj, mapping, keepUnmapped));

exports.mapKeysDeep = remap;
exports.mapArraysDeep = mapArraysDeep;

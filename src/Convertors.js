"use strict";

const validator = require('validator');

exports.toBoolean = (value) => typeof value === 'boolean' ? value : validator.toBoolean(value, true);

exports.toText = (value) => ((typeof raw !== 'string') ? value.toString() : value).trim();
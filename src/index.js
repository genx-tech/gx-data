"use strict";

const Types = require('./types'); 
const Activators = require('./Activators');
const Connector = require('./Connector');
const Convertors = require('./Convertors');
const Generators = require('./Generators');
const Processors = require('./Processors');
const Validators = require('./Validators');
const Errors = require('./utils/Errors');

module.exports = { 
    Types, 
    Errors, 
    Activators, 
    Connector,
    Convertors,   
    Generators,
    Processors, 
    Validators,
    Utils: { 
        Lang: require('./utils/lang'), 
        Bulk: require('./utils/Bulk'), 
        parseCsvFile:require('./utils/parseCsvFile'), 
        download: require('./utils/download') 
    },
    getEntityModelOfDriver: driver => require('./drivers/' + driver + '/EntityModel')
};
"use strict";

const { tryRequire } = require('../utils/lib');

let flInstance, instance;

module.exports = function (info, i18n, options) {
    const hyperid = tryRequire('hyperid');

    if (info && info.fixedLength) {
        if (!flInstance) {
            flInstance = hyperid({ urlSafe: true, fixedLength: true });
        }
        
        return flInstance();
    }
    
    if (!instance) {
        instance = hyperid();
    }
    
    return instance();
}
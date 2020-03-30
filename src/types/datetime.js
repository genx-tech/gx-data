"use strict";

const _ = require('rk-utils')._;
const { DateTime } = require('luxon');
const any = require('./any');

module.exports = {
    name: 'datetime',

    typeObject: DateTime,

    alias: [ 'date', 'time', 'timestamp' ],

    sanitize: (value, info, i18n) => {   
        if (value instanceof Date) return value;

        let type = typeof value;
        
        if (type === 'string' && info.fromFormat) {
            return i18n ? i18n.datetime.fromISO(value, info.fromFormat) : DateTime.fromFormat(value, info.fromFormat, {setZone: true});
        } 
        
        if (type === 'number') {
            return i18n ? i18n.datetime.fromMillis(value) : DateTime.fromMillis(value);
        } 
        
        return value;
    },

    defaultValue: 0,

    generate: (info, i18n) => i18n ? i18n.now() : DateTime.local(),

    serialize: value => {
        if (value.toISO) {
            return value.toISO({ includeOffset: false }); 
        }

        return value;
    },

    qualifiers: any.qualifiers.concat([
        'timezone',
        'dateOnly',
        'timeOnly',
        'fromFormat'
    ])
};
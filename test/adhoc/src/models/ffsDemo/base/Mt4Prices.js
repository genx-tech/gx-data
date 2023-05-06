const { _ } = require('@genx/july');
const { 
    Types,
    Activators,
    Validators, 
    Processors, 
    Generators, 
    Errors: { ValidationError, DatabaseError }, 
    Utils: { Lang: { isNothing } } 
} = require('@genx/data');
 

module.exports = (Base) => {    
    const Mt4PricesSpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            return context;
        }
    };
    
    Mt4PricesSpec.meta = {
        "schemaName": "ffsDemo",
        "name": "mt4Prices",
        "keyField": "symbol",
        "fields": {
            "symbol": {
                "type": "text",
                "code": "SYMBOL",
                "fixedLength": 16,
                "comment": "Mt 4 Prices Symbol",
                "displayName": "Symbol"
            },
            "time": {
                "type": "datetime",
                "code": "TIME",
                "comment": "Mt 4 Prices Time",
                "displayName": "Time"
            },
            "bid": {
                "type": "number",
                "code": "BID",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Prices Bid",
                "displayName": "Bid"
            },
            "ask": {
                "type": "number",
                "code": "ASK",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Prices Ask",
                "displayName": "Ask"
            },
            "low": {
                "type": "number",
                "code": "LOW",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Prices Low",
                "displayName": "Low"
            },
            "high": {
                "type": "number",
                "code": "HIGH",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Prices High",
                "displayName": "High"
            },
            "direction": {
                "type": "integer",
                "code": "DIRECTION",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Prices Direction",
                "displayName": "Direction"
            },
            "digits": {
                "type": "integer",
                "code": "DIGITS",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Prices Digits",
                "displayName": "Digits"
            },
            "spread": {
                "type": "integer",
                "code": "SPREAD",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Prices Spread",
                "displayName": "Spread"
            },
            "modifyTime": {
                "type": "datetime",
                "code": "MODIFY_TIME",
                "comment": "Mt 4 Prices Modify Time",
                "displayName": "Modify Time"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "symbol"
            ]
        ]
    };

    return Object.assign(Mt4PricesSpec, {});
};
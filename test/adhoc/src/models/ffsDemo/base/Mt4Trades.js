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
    const Mt4TradesSpec = class extends Base {    
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
    
    Mt4TradesSpec.meta = {
        "schemaName": "ffsDemo",
        "name": "mt4Trades",
        "keyField": "ticket",
        "fields": {
            "ticket": {
                "type": "integer",
                "code": "TICKET",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Ticket",
                "displayName": "Ticket"
            },
            "login": {
                "type": "integer",
                "code": "LOGIN",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Login",
                "displayName": "Login"
            },
            "symbol": {
                "type": "text",
                "code": "SYMBOL",
                "fixedLength": 16,
                "comment": "Mt 4 Trades Symbol",
                "displayName": "Symbol"
            },
            "digits": {
                "type": "integer",
                "code": "DIGITS",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Digits",
                "displayName": "Digits"
            },
            "cmd": {
                "type": "integer",
                "code": "CMD",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Cmd",
                "displayName": "Cmd"
            },
            "volume": {
                "type": "integer",
                "code": "VOLUME",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Volume",
                "displayName": "Volume"
            },
            "openTime": {
                "type": "datetime",
                "code": "OPEN_TIME",
                "comment": "Mt 4 Trades Open Time",
                "displayName": "Open Time"
            },
            "openPrice": {
                "type": "number",
                "code": "OPEN_PRICE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Open Price",
                "displayName": "Open Price"
            },
            "sl": {
                "type": "number",
                "code": "SL",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Sl",
                "displayName": "Sl"
            },
            "tp": {
                "type": "number",
                "code": "TP",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Tp",
                "displayName": "Tp"
            },
            "closeTime": {
                "type": "datetime",
                "code": "CLOSE_TIME",
                "comment": "Mt 4 Trades Close Time",
                "displayName": "Close Time"
            },
            "expiration": {
                "type": "datetime",
                "code": "EXPIRATION",
                "comment": "Mt 4 Trades Expiration",
                "displayName": "Expiration"
            },
            "reason": {
                "type": "integer",
                "code": "REASON",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Trades Reason",
                "displayName": "Reason"
            },
            "convRate1": {
                "type": "number",
                "code": "CONV_RATE1",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Conv Rate 1",
                "displayName": "Conv Rate 1"
            },
            "convRate2": {
                "type": "number",
                "code": "CONV_RATE2",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Conv Rate 2",
                "displayName": "Conv Rate 2"
            },
            "commission": {
                "type": "number",
                "code": "COMMISSION",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Commission",
                "displayName": "Commission"
            },
            "commissionAgent": {
                "type": "number",
                "code": "COMMISSION_AGENT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Commission Agent",
                "displayName": "Commission Agent"
            },
            "swaps": {
                "type": "number",
                "code": "SWAPS",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Swaps",
                "displayName": "Swaps"
            },
            "closePrice": {
                "type": "number",
                "code": "CLOSE_PRICE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Close Price",
                "displayName": "Close Price"
            },
            "profit": {
                "type": "number",
                "code": "PROFIT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Profit",
                "displayName": "Profit"
            },
            "taxes": {
                "type": "number",
                "code": "TAXES",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Taxes",
                "displayName": "Taxes"
            },
            "comment": {
                "type": "text",
                "code": "COMMENT",
                "fixedLength": 32,
                "comment": "Mt 4 Trades Comment",
                "displayName": "Comment"
            },
            "internalId": {
                "type": "integer",
                "code": "INTERNAL_ID",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Internal Id",
                "displayName": "Internal Id"
            },
            "marginRate": {
                "type": "number",
                "code": "MARGIN_RATE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Trades Margin Rate",
                "displayName": "Margin Rate"
            },
            "timestamp": {
                "type": "integer",
                "code": "TIMESTAMP",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Trades Timestamp",
                "displayName": "Timestamp"
            },
            "magic": {
                "type": "integer",
                "code": "MAGIC",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Trades Magic",
                "displayName": "Magic"
            },
            "gwVolume": {
                "type": "integer",
                "code": "GW_VOLUME",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Trades Gw Volume",
                "displayName": "Gw Volume"
            },
            "gwOpenPrice": {
                "type": "integer",
                "code": "GW_OPEN_PRICE",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Trades Gw Open Price",
                "displayName": "Gw Open Price"
            },
            "gwClosePrice": {
                "type": "integer",
                "code": "GW_CLOSE_PRICE",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Trades Gw Close Price",
                "displayName": "Gw Close Price"
            },
            "modifyTime": {
                "type": "datetime",
                "code": "MODIFY_TIME",
                "comment": "Mt 4 Trades Modify Time",
                "displayName": "Modify Time"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "ticket"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "login"
                ]
            },
            {
                "fields": [
                    "cmd"
                ]
            },
            {
                "fields": [
                    "openTime"
                ]
            },
            {
                "fields": [
                    "closeTime"
                ]
            },
            {
                "fields": [
                    "timestamp"
                ]
            }
        ]
    };

    return Object.assign(Mt4TradesSpec, {});
};
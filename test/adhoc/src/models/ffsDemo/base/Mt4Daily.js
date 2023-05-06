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
    const Mt4DailySpec = class extends Base {    
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
    
    Mt4DailySpec.meta = {
        "schemaName": "ffsDemo",
        "name": "mt4Daily",
        "keyField": [
            "login",
            "time"
        ],
        "fields": {
            "login": {
                "type": "integer",
                "code": "LOGIN",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Daily Login",
                "displayName": "Login"
            },
            "time": {
                "type": "datetime",
                "code": "TIME",
                "comment": "Mt 4 Daily Time",
                "displayName": "Time"
            },
            "group": {
                "type": "text",
                "code": "GROUP",
                "fixedLength": 16,
                "comment": "Mt 4 Daily Group",
                "displayName": "Group"
            },
            "bank": {
                "type": "text",
                "code": "BANK",
                "fixedLength": 64,
                "comment": "Mt 4 Daily Bank",
                "displayName": "Bank"
            },
            "balancePrev": {
                "type": "number",
                "code": "BALANCE_PREV",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Balance Prev",
                "displayName": "Balance Prev"
            },
            "balance": {
                "type": "number",
                "code": "BALANCE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Balance",
                "displayName": "Balance"
            },
            "deposit": {
                "type": "number",
                "code": "DEPOSIT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Deposit",
                "displayName": "Deposit"
            },
            "credit": {
                "type": "number",
                "code": "CREDIT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Credit",
                "displayName": "Credit"
            },
            "profitClosed": {
                "type": "number",
                "code": "PROFIT_CLOSED",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Profit Closed",
                "displayName": "Profit Closed"
            },
            "profit": {
                "type": "number",
                "code": "PROFIT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Profit",
                "displayName": "Profit"
            },
            "equity": {
                "type": "number",
                "code": "EQUITY",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Equity",
                "displayName": "Equity"
            },
            "margin": {
                "type": "number",
                "code": "MARGIN",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Margin",
                "displayName": "Margin"
            },
            "marginFree": {
                "type": "number",
                "code": "MARGIN_FREE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Daily Margin Free",
                "displayName": "Margin Free"
            },
            "modifyTime": {
                "type": "datetime",
                "code": "MODIFY_TIME",
                "comment": "Mt 4 Daily Modify Time",
                "displayName": "Modify Time"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "login",
                "time"
            ]
        ]
    };

    return Object.assign(Mt4DailySpec, {});
};
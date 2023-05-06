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
    const Mt4UsersSpec = class extends Base {    
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
    
    Mt4UsersSpec.meta = {
        "schemaName": "ffsDemo",
        "name": "mt4Users",
        "keyField": "login",
        "code": "mt4_users",
        "fields": {
            "login": {
                "type": "integer",
                "code": "LOGIN",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Login",
                "displayName": "Login"
            },
            "group": {
                "type": "text",
                "code": "GROUP",
                "fixedLength": 16,
                "comment": "Mt 4 Users Group",
                "displayName": "Group"
            },
            "enable": {
                "type": "integer",
                "code": "ENABLE",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Enable",
                "displayName": "Enable"
            },
            "enableChangePass": {
                "type": "integer",
                "code": "ENABLE_CHANGE_PASS",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Enable Change Pass",
                "displayName": "Enable Change Pass"
            },
            "enableReadonly": {
                "type": "integer",
                "code": "ENABLE_READONLY",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Enable Readonly",
                "displayName": "Enable Readonly"
            },
            "enableOtp": {
                "type": "integer",
                "code": "ENABLE_OTP",
                "digits": 10,
                "bytes": 4,
                "default": "0",
                "comment": "Mt 4 Users Enable Otp",
                "displayName": "Enable Otp"
            },
            "passwordPhone": {
                "type": "text",
                "code": "PASSWORD_PHONE",
                "fixedLength": 32,
                "comment": "Mt 4 Users Password Phone",
                "displayName": "Password Phone"
            },
            "name": {
                "type": "text",
                "code": "NAME",
                "fixedLength": 128,
                "comment": "Mt 4 Users Name",
                "displayName": "Name"
            },
            "country": {
                "type": "text",
                "code": "COUNTRY",
                "fixedLength": 32,
                "comment": "Mt 4 Users Country",
                "displayName": "Country"
            },
            "city": {
                "type": "text",
                "code": "CITY",
                "fixedLength": 32,
                "comment": "Mt 4 Users City",
                "displayName": "City"
            },
            "state": {
                "type": "text",
                "code": "STATE",
                "fixedLength": 32,
                "comment": "Mt 4 Users State",
                "displayName": "State"
            },
            "zipcode": {
                "type": "text",
                "code": "ZIPCODE",
                "fixedLength": 16,
                "comment": "Mt 4 Users Zipcode",
                "displayName": "Zipcode"
            },
            "address": {
                "type": "text",
                "code": "ADDRESS",
                "fixedLength": 128,
                "comment": "Mt 4 Users Address",
                "displayName": "Address"
            },
            "leadSource": {
                "type": "text",
                "code": "LEAD_SOURCE",
                "fixedLength": 32,
                "comment": "Mt 4 Users Lead Source",
                "displayName": "Lead Source"
            },
            "phone": {
                "type": "text",
                "code": "PHONE",
                "fixedLength": 32,
                "comment": "Mt 4 Users Phone",
                "displayName": "Phone"
            },
            "email": {
                "type": "text",
                "code": "EMAIL",
                "fixedLength": 48,
                "comment": "Mt 4 Users Email",
                "displayName": "Email"
            },
            "comment": {
                "type": "text",
                "code": "COMMENT",
                "fixedLength": 64,
                "comment": "Mt 4 Users Comment",
                "displayName": "Comment"
            },
            "id": {
                "type": "text",
                "code": "ID",
                "fixedLength": 32,
                "comment": "Mt 4 Users Id",
                "displayName": "Id"
            },
            "status": {
                "type": "text",
                "code": "STATUS",
                "fixedLength": 16,
                "comment": "Mt 4 Users Status",
                "displayName": "Status"
            },
            "regdate": {
                "type": "datetime",
                "code": "REGDATE",
                "comment": "Mt 4 Users Regdate",
                "displayName": "Regdate"
            },
            "lastdate": {
                "type": "datetime",
                "code": "LASTDATE",
                "comment": "Mt 4 Users Lastdate",
                "displayName": "Lastdate"
            },
            "leverage": {
                "type": "integer",
                "code": "LEVERAGE",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Leverage",
                "displayName": "Leverage"
            },
            "agentAccount": {
                "type": "integer",
                "code": "AGENT_ACCOUNT",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Agent Account",
                "displayName": "Agent Account"
            },
            "timestamp": {
                "type": "integer",
                "code": "TIMESTAMP",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Timestamp",
                "displayName": "Timestamp"
            },
            "balance": {
                "type": "number",
                "code": "BALANCE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Balance",
                "displayName": "Balance"
            },
            "prevmonthbalance": {
                "type": "number",
                "code": "PREVMONTHBALANCE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Prevmonthbalance",
                "displayName": "Prevmonthbalance"
            },
            "prevbalance": {
                "type": "number",
                "code": "PREVBALANCE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Prevbalance",
                "displayName": "Prevbalance"
            },
            "credit": {
                "type": "number",
                "code": "CREDIT",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Credit",
                "displayName": "Credit"
            },
            "interestrate": {
                "type": "number",
                "code": "INTERESTRATE",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Interestrate",
                "displayName": "Interestrate"
            },
            "taxes": {
                "type": "number",
                "code": "TAXES",
                "bytes": 8,
                "totalDigits": 22,
                "comment": "Mt 4 Users Taxes",
                "displayName": "Taxes"
            },
            "sendReports": {
                "type": "integer",
                "code": "SEND_REPORTS",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users Send Reports",
                "displayName": "Send Reports"
            },
            "mqid": {
                "type": "integer",
                "code": "MQID",
                "digits": 10,
                "bytes": 4,
                "unsigned": true,
                "default": "0",
                "comment": "Mt 4 Users Mqid",
                "displayName": "Mqid"
            },
            "userColor": {
                "type": "integer",
                "code": "USER_COLOR",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Users User Color",
                "displayName": "User Color"
            },
            "equity": {
                "type": "number",
                "code": "EQUITY",
                "bytes": 8,
                "totalDigits": 22,
                "default": "0",
                "comment": "Mt 4 Users Equity",
                "displayName": "Equity"
            },
            "margin": {
                "type": "number",
                "code": "MARGIN",
                "bytes": 8,
                "totalDigits": 22,
                "default": "0",
                "comment": "Mt 4 Users Margin",
                "displayName": "Margin"
            },
            "marginLevel": {
                "type": "number",
                "code": "MARGIN_LEVEL",
                "bytes": 8,
                "totalDigits": 22,
                "default": "0",
                "comment": "Mt 4 Users Margin Level",
                "displayName": "Margin Level"
            },
            "marginFree": {
                "type": "number",
                "code": "MARGIN_FREE",
                "bytes": 8,
                "totalDigits": 22,
                "default": "0",
                "comment": "Mt 4 Users Margin Free",
                "displayName": "Margin Free"
            },
            "currency": {
                "type": "text",
                "code": "CURRENCY",
                "fixedLength": 16,
                "comment": "Mt 4 Users Currency",
                "displayName": "Currency"
            },
            "apiData": {
                "type": "binary",
                "code": "API_DATA",
                "maxLength": 65535,
                "optional": true,
                "comment": "Mt 4 Users Api Data",
                "displayName": "Api Data"
            },
            "modifyTime": {
                "type": "datetime",
                "code": "MODIFY_TIME",
                "comment": "Mt 4 Users Modify Time",
                "displayName": "Modify Time"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "login"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "timestamp"
                ]
            }
        ]
    };

    return Object.assign(Mt4UsersSpec, {});
};
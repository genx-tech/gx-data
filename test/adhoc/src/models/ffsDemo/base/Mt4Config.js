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
    const Mt4ConfigSpec = class extends Base {    
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
    
    Mt4ConfigSpec.meta = {
        "schemaName": "ffsDemo",
        "name": "mt4Config",
        "keyField": "config",
        "fields": {
            "config": {
                "type": "integer",
                "code": "CONFIG",
                "digits": 10,
                "bytes": 4,
                "comment": "Mt 4 Config",
                "displayName": "Config"
            },
            "valueInt": {
                "type": "integer",
                "code": "VALUE_INT",
                "digits": 10,
                "bytes": 4,
                "optional": true,
                "comment": "Mt 4 Config Value Int",
                "displayName": "Value Int"
            },
            "valueStr": {
                "type": "text",
                "code": "VALUE_STR",
                "fixedLength": 255,
                "optional": true,
                "comment": "Mt 4 Config Value Str",
                "displayName": "Value Str"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "config"
            ]
        ]
    };

    return Object.assign(Mt4ConfigSpec, {});
};
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
    const PersonTitleSpec = class extends Base {    
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
    
    PersonTitleSpec.meta = {
        "schemaName": "test",
        "name": "personTitle",
        "keyField": "code",
        "fields": {
            "code": {
                "type": "text",
                "maxLength": 100,
                "displayName": "Code"
            },
            "name": {
                "type": "text",
                "maxLength": 200,
                "displayName": "Name"
            },
            "male": {
                "type": "boolean",
                "displayName": "Male"
            },
            "female": {
                "type": "boolean",
                "displayName": "Female"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "code"
            ]
        ]
    };

    return Object.assign(PersonTitleSpec, {});
};
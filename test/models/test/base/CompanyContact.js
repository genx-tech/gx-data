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
    const CompanyContactSpec = class extends Base {    
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
    
    CompanyContactSpec.meta = {
        "schemaName": "test",
        "name": "companyContact",
        "keyField": "id",
        "fields": {
            "id": {
                "type": "integer",
                "auto": true,
                "writeOnce": true,
                "displayName": "Id",
                "autoIncrementId": true,
                "createByDb": true
            },
            "main": {
                "type": "boolean",
                "default": false,
                "displayName": "Main"
            },
            "company": {
                "type": "integer",
                "displayName": "Company"
            },
            "person": {
                "type": "integer",
                "displayName": "Person"
            }
        },
        "features": {
            "autoId": {
                "field": "id"
            }
        },
        "uniqueKeys": [
            [
                "id"
            ],
            [
                "company",
                "person"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "company",
                    "person"
                ],
                "unique": true
            }
        ],
        "associations": {
            "company": {
                "type": "belongsTo",
                "entity": "company",
                "key": "id",
                "field": "id",
                "on": {
                    "company": {
                        "oorType": "ColumnReference",
                        "name": "company.id"
                    }
                }
            },
            "person": {
                "type": "refersTo",
                "entity": "person",
                "key": "id",
                "field": "id",
                "on": {
                    "person": {
                        "oorType": "ColumnReference",
                        "name": "person.id"
                    }
                }
            }
        },
        "fieldDependencies": {
            "id": [
                {
                    "reference": "id",
                    "writeProtect": true
                }
            ]
        }
    };

    return Object.assign(CompanyContactSpec, {});
};
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
    const CompanyRoleSpec = class extends Base {    
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
    
    CompanyRoleSpec.meta = {
        "schemaName": "test",
        "name": "companyRole",
        "keyField": "code",
        "fields": {
            "code": {
                "type": "text",
                "maxLength": 64,
                "emptyAsNull": true,
                "subClass": [
                    "idString"
                ],
                "displayName": "Code"
            },
            "name": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Name"
            },
            "indexOrder": {
                "type": "integer",
                "default": 0,
                "displayName": "Index Order"
            },
            "desc": {
                "type": "text",
                "optional": true,
                "emptyAsNull": true,
                "subClass": [
                    "desc"
                ],
                "displayName": "Desc"
            },
            "isSystem": {
                "type": "boolean",
                "optional": true,
                "displayName": "Is System"
            },
            "isActive": {
                "type": "boolean",
                "default": true,
                "displayName": "Is Active"
            },
            "isDeleted": {
                "type": "boolean",
                "default": false,
                "readOnly": true,
                "displayName": "Is Deleted"
            },
            "deletedAt": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "writeOnce": true,
                "auto": true,
                "displayName": "Deleted At"
            }
        },
        "features": {
            "logicalDeletion": {
                "field": "isDeleted",
                "value": true,
                "timestampField": "deletedAt"
            }
        },
        "uniqueKeys": [
            [
                "code"
            ],
            [
                "name"
            ]
        ],
        "baseClasses": [
            "dictionaryByCode"
        ],
        "indexes": [
            {
                "fields": [
                    "name"
                ],
                "unique": true
            }
        ],
        "fieldDependencies": {
            "deletedAt": [
                {
                    "reference": "deletedAt",
                    "writeProtect": true
                }
            ]
        }
    };

    return Object.assign(CompanyRoleSpec, {});
};
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
    const PersonSpec = class extends Base {    
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
    
    PersonSpec.meta = {
        "schemaName": "test",
        "name": "person",
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
            "firstName": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "First Name"
            },
            "middleName": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Middle Name"
            },
            "lastName": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Last Name"
            },
            "legalName": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Legal Name"
            },
            "dob": {
                "type": "datetime",
                "optional": true,
                "comment": "Date of birth",
                "displayName": "Dob"
            },
            "maritalStatus": {
                "type": "enum",
                "values": [
                    "single",
                    "married",
                    "divorced",
                    "widowed",
                    "de facto"
                ],
                "optional": true,
                "subClass": [
                    "maritalStatus"
                ],
                "displayName": "Marital Status"
            },
            "gender": {
                "type": "enum",
                "values": [
                    "male",
                    "female",
                    "non-disclosure"
                ],
                "optional": true,
                "subClass": [
                    "genderType"
                ],
                "displayName": "Gender"
            },
            "residencyStatus": {
                "type": "enum",
                "values": [
                    "citizen",
                    "pr",
                    "overseas"
                ],
                "optional": true,
                "subClass": [
                    "residencyStatus"
                ],
                "displayName": "Residency Status"
            },
            "createdAt": {
                "type": "datetime",
                "auto": true,
                "readOnly": true,
                "writeOnce": true,
                "displayName": "Created At",
                "isCreateTimestamp": true,
                "createByDb": true
            },
            "updatedAt": {
                "type": "datetime",
                "readOnly": true,
                "forceUpdate": true,
                "optional": true,
                "displayName": "Updated At",
                "isUpdateTimestamp": true,
                "updateByDb": true
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
            },
            "title": {
                "type": "text",
                "maxLength": 100,
                "displayName": "Title",
                "optional": true,
                "emptyAsNull": true
            },
            "contact": {
                "type": "integer",
                "displayName": "Contact",
                "optional": true
            }
        },
        "features": {
            "autoId": {
                "field": "id"
            },
            "createTimestamp": {
                "field": "createdAt"
            },
            "updateTimestamp": {
                "field": "updatedAt"
            },
            "logicalDeletion": {
                "field": "isDeleted",
                "value": true,
                "timestampField": "deletedAt"
            }
        },
        "uniqueKeys": [
            [
                "id"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "lastName"
                ]
            },
            {
                "fields": [
                    "legalName"
                ]
            }
        ],
        "associations": {
            "title": {
                "type": "refersTo",
                "entity": "personTitle",
                "key": "code",
                "field": "code",
                "on": {
                    "title": {
                        "oorType": "ColumnReference",
                        "name": "title.code"
                    }
                }
            },
            "contact": {
                "type": "refersTo",
                "entity": "contact",
                "key": "id",
                "field": "id",
                "on": {
                    "contact": {
                        "oorType": "ColumnReference",
                        "name": "contact.id"
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
            ],
            "createdAt": [
                {
                    "reference": "createdAt",
                    "writeProtect": true
                }
            ],
            "deletedAt": [
                {
                    "reference": "deletedAt",
                    "writeProtect": true
                }
            ]
        }
    };

    return Object.assign(PersonSpec, {});
};
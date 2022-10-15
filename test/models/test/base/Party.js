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
    const PartySpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            if ((isNothing(latest['preferredName']) || this.meta.fields['preferredName'].forceUpdate) && (!isUpdating || this._dependencyChanged('preferredName', context))) {
                //Activating "preferredName"
                let activated = await Activators.populate(this, context, 'company.name');
                if (typeof activated !== 'undefined') {
                    latest['preferredName'] = activated;
                }
            }
            if (!isNothing(latest['website']) && !latest['website'].oorType) {
                //Validating "website"
                if (!Validators.isURL(latest['website'], { require_tld: false })) {
                    throw new ValidationError('Invalid "website".', {
                        entity: this.meta.name,
                        field: 'website',
                        value: latest['website']
                    });
                }
            }
            if (!isNothing(latest['logo']) && !latest['logo'].oorType) {
                //Validating "logo"
                if (!Validators.isURL(latest['logo'], { require_tld: false })) {
                    throw new ValidationError('Invalid "logo".', {
                        entity: this.meta.name,
                        field: 'logo',
                        value: latest['logo']
                    });
                }
            }
            if (!isNothing(latest['avatar']) && !latest['avatar'].oorType) {
                //Validating "avatar"
                if (!Validators.isURL(latest['avatar'], { require_tld: false })) {
                    throw new ValidationError('Invalid "avatar".', {
                        entity: this.meta.name,
                        field: 'avatar',
                        value: latest['avatar']
                    });
                }
            }
            return context;
        }
    };
    
    PartySpec.meta = {
        "schemaName": "test",
        "name": "party",
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
            "preferredName": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "subClass": [
                    "name"
                ],
                "hasActivator": true,
                "displayName": "Preferred Name"
            },
            "website": {
                "type": "text",
                "maxLength": 750,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "url"
                ],
                "displayName": "Website"
            },
            "logo": {
                "type": "text",
                "maxLength": 750,
                "emptyAsNull": true,
                "optional": true,
                "comment": "Rectange logo",
                "subClass": [
                    "url"
                ],
                "displayName": "Logo"
            },
            "avatar": {
                "type": "text",
                "maxLength": 750,
                "emptyAsNull": true,
                "optional": true,
                "comment": "Square logo",
                "subClass": [
                    "url"
                ],
                "displayName": "Avatar"
            },
            "about": {
                "type": "text",
                "optional": true,
                "emptyAsNull": true,
                "subClass": [
                    "desc"
                ],
                "displayName": "About"
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
            "type": {
                "type": "text",
                "maxLength": 64,
                "emptyAsNull": true,
                "subClass": [
                    "idString"
                ],
                "displayName": "Type"
            },
            "company": {
                "type": "integer",
                "displayName": "Company",
                "optional": true
            },
            "person": {
                "type": "integer",
                "displayName": "Person",
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
        "associations": {
            "type": {
                "type": "refersTo",
                "entity": "partyType",
                "key": "code",
                "field": "code",
                "on": {
                    "type": {
                        "oorType": "ColumnReference",
                        "name": "type.code"
                    }
                }
            },
            "company": {
                "type": "refersTo",
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

    return Object.assign(PartySpec, {});
};
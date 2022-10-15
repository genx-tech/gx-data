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
    const CompanySpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
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
            if (!isNothing(latest['email']) && !latest['email'].oorType) {
                //Validating "email"
                if (!Validators.isEmail(latest['email'])) {
                    throw new ValidationError('Invalid "email".', {
                        entity: this.meta.name,
                        field: 'email',
                        value: latest['email']
                    });
                }
            }
            if (!isNothing(latest['phone']) && !latest['phone'].oorType) {
                //Processing "phone"
                latest['phone'] = Processors.normalizePhone(latest['phone'], '+886');
            }
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                //Processing "mobile"
                latest['mobile'] = Processors.normalizePhone(latest['mobile'], '+886');
            }
            if (!isNothing(latest['fax']) && !latest['fax'].oorType) {
                //Processing "fax"
                latest['fax'] = Processors.normalizePhone(latest['fax'], '+886');
            }
            if (!isNothing(latest['abn']) && !latest['abn'].oorType) {
                //Processing "abn"
                latest['abn'] = Processors.removeSpace(latest['abn']);
            }
            if (!isNothing(latest['acn']) && !latest['acn'].oorType) {
                //Processing "acn"
                latest['acn'] = Processors.removeSpace(latest['acn']);
            }
            if (!isNothing(latest['phone']) && !latest['phone'].oorType) {
                //Validating "phone"
                if (!Validators.isPhone(latest['phone'])) {
                    throw new ValidationError('Invalid "phone".', {
                        entity: this.meta.name,
                        field: 'phone',
                        value: latest['phone']
                    });
                }
            }
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                //Validating "mobile"
                if (!Validators.isMobilePhone(latest['mobile'])) {
                    throw new ValidationError('Invalid "mobile".', {
                        entity: this.meta.name,
                        field: 'mobile',
                        value: latest['mobile']
                    });
                }
            }
            if (!isNothing(latest['fax']) && !latest['fax'].oorType) {
                //Validating "fax"
                if (!Validators.isPhone(latest['fax'])) {
                    throw new ValidationError('Invalid "fax".', {
                        entity: this.meta.name,
                        field: 'fax',
                        value: latest['fax']
                    });
                }
            }
            if (!isNothing(latest['abn']) && !latest['abn'].oorType) {
                //Validating "abn"
                if (!Validators.isNumeric(latest['abn'])) {
                    throw new ValidationError('Invalid "abn".', {
                        entity: this.meta.name,
                        field: 'abn',
                        value: latest['abn']
                    });
                }
            }
            if (!isNothing(latest['acn']) && !latest['acn'].oorType) {
                //Validating "acn"
                if (!Validators.isNumeric(latest['acn'])) {
                    throw new ValidationError('Invalid "acn".', {
                        entity: this.meta.name,
                        field: 'acn',
                        value: latest['acn']
                    });
                }
            }
            return context;
        }
    };
    
    CompanySpec.meta = {
        "schemaName": "test",
        "name": "company",
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
            "name": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Name"
            },
            "logo": {
                "type": "text",
                "maxLength": 750,
                "emptyAsNull": true,
                "optional": true,
                "comment": "Rectangle",
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
                "comment": "Square",
                "subClass": [
                    "url"
                ],
                "displayName": "Avatar"
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
            "about": {
                "type": "text",
                "optional": true,
                "emptyAsNull": true,
                "subClass": [
                    "desc"
                ],
                "displayName": "About"
            },
            "registrationNo": {
                "type": "text",
                "maxLength": 60,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "shortName"
                ],
                "displayName": "Registration No"
            },
            "email": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "email"
                ],
                "displayName": "Email"
            },
            "phone": {
                "type": "text",
                "maxLength": 20,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "phone"
                ],
                "displayName": "Phone"
            },
            "mobile": {
                "type": "text",
                "maxLength": 20,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "mobile"
                ],
                "displayName": "Mobile"
            },
            "fax": {
                "type": "text",
                "maxLength": 20,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "phone"
                ],
                "displayName": "Fax"
            },
            "abn": {
                "type": "text",
                "fixedLength": 11,
                "optional": true,
                "comment": "Australia Business Number",
                "subClass": [
                    "abn"
                ],
                "displayName": "Abn"
            },
            "acn": {
                "type": "text",
                "fixedLength": 9,
                "optional": true,
                "comment": "Australia Company Number",
                "subClass": [
                    "acn"
                ],
                "displayName": "Acn"
            },
            "taxIdNumber": {
                "type": "text",
                "maxLength": 60,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "shortName"
                ],
                "displayName": "Tax Id Number"
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
            "role": {
                "type": "text",
                "maxLength": 64,
                "emptyAsNull": true,
                "subClass": [
                    "idString"
                ],
                "displayName": "Role"
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
                    "name"
                ]
            },
            {
                "fields": [
                    "registrationNo"
                ]
            }
        ],
        "associations": {
            "role": {
                "type": "refersTo",
                "entity": "companyRole",
                "key": "code",
                "field": "code",
                "on": {
                    "role": {
                        "oorType": "ColumnReference",
                        "name": "role.code"
                    }
                }
            },
            "contacts": {
                "entity": "companyContact",
                "key": "id",
                "on": {
                    "id": {
                        "oorType": "ColumnReference",
                        "name": "contacts.company"
                    }
                },
                "field": "company",
                "list": true
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

    return Object.assign(CompanySpec, {});
};
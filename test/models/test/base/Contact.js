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
    const ContactSpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                //Processing "mobile"
                latest['mobile'] = Processors.normalizePhone(latest['mobile'], '+886');
            }
            if (!isNothing(latest['phone']) && !latest['phone'].oorType) {
                //Processing "phone"
                latest['phone'] = Processors.normalizePhone(latest['phone'], '+886');
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
            return context;
        }
    };
    
    ContactSpec.meta = {
        "schemaName": "test",
        "name": "contact",
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
            "email": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "optional": true,
                "subClass": [
                    "email"
                ],
                "displayName": "Email"
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
            ]
        ],
        "fieldDependencies": {
            "id": [
                {
                    "reference": "id",
                    "writeProtect": true
                }
            ]
        }
    };

    return Object.assign(ContactSpec, {});
};
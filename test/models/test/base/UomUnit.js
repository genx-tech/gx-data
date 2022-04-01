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
    const UomUnitSpec = class extends Base {    
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

        static async createTableIfNotExist_() {
            await this.db.connector.execute_(
                'CREATE TABLE IF NOT EXISTS ?? (\
                `code` VARCHAR(64) NOT NULL DEFAULT "",\
                `name` VARCHAR(200) NOT NULL DEFAULT "",\
                `indexOrder` INT NOT NULL DEFAULT 0,\
                `desc` TEXT NULL,\
                `isSystem` TINYINT(1) NULL,\
                `isActive` TINYINT(1) NOT NULL DEFAULT 1,\
                `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,\
                `deletedAt` DATETIME NULL,\
                PRIMARY KEY (`code`),\
                UNIQUE KEY (`name`)\
            ) ENGINE = InnoDB',
                [this.meta.name]
            );
        }
    };
    
    UomUnitSpec.meta = {
        "schemaName": "ihom",
        "name": "uomUnit",
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
        },
        "fromPackage": "commons",
        "packagePath": "../gem-commons"
    };

    return Object.assign(UomUnitSpec, {});
};
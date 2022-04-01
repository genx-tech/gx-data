const { _ } = require('@genx/july');
const {
    Types,
    Activators,
    Validators,
    Processors,
    Generators,
    Errors: { ValidationError, DatabaseError },
    Utils: {
        Lang: { isNothing },
    },
} = require('@genx/data');

module.exports = (Base) => {
    const TestEntitySpec = class extends Base {
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let { raw, latest, existing, i18n } = context;
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
            `dataType` ENUM("text", "integer", "number", "boolean", "csv", "object", "datetime") NULL,\
            `values` TEXT NULL,\
            `formatter` ENUM("datetime", "currency", "dateOnly", "timeOnly", "bytes", "number", "percent") NULL,\
            `category` VARCHAR(200) NOT NULL DEFAULT "",\
            `text` TEXT NULL,\
            `intValue` INT NULL,\
            `numValue` FLOAT NULL,\
            `object` TEXT NULL,\
            `flag` TINYINT(1) NULL,\
            `timestamp` DATETIME NULL,\
            `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,\
            `deletedAt` DATETIME NULL,\
            `unit` VARCHAR(64) NULL,\
            PRIMARY KEY (`code`),\
            UNIQUE KEY (`name`)\
            ) ENGINE = InnoDB',
                [this.meta.name]
            );
        }
    };

    TestEntitySpec.meta = {
        schemaName: 'test',
        name: 'testEntity',
        keyField: 'code',
        fields: {
            code: {
                type: 'text',
                maxLength: 64,
                emptyAsNull: true,
                subClass: ['idString'],
                displayName: 'Code',
            },
            name: {
                type: 'text',
                maxLength: 200,
                emptyAsNull: true,
                subClass: ['name'],
                displayName: 'Name',
            },
            indexOrder: {
                type: 'integer',
                default: 0,
                displayName: 'Index Order',
            },
            desc: {
                type: 'text',
                optional: true,
                emptyAsNull: true,
                subClass: ['desc'],
                displayName: 'Desc',
            },
            isSystem: {
                type: 'boolean',
                optional: true,
                displayName: 'Is System',
            },
            isActive: {
                type: 'boolean',
                default: true,
                displayName: 'Is Active',
            },
            dataType: {
                type: 'enum',
                values: [
                    'text',
                    'integer',
                    'number',
                    'boolean',
                    'csv',
                    'object',
                    'datetime',
                ],
                optional: true,
                subClass: ['dataType'],
                displayName: 'Data Type',
            },
            values: {
                type: 'array',
                optional: true,
                displayName: 'Values',
            },
            formatter: {
                type: 'enum',
                values: [
                    'datetime',
                    'currency',
                    'dateOnly',
                    'timeOnly',
                    'bytes',
                    'number',
                    'percent',
                ],
                optional: true,
                subClass: ['formatterType'],
                displayName: 'Formatter',
            },
            category: {
                type: 'text',
                maxLength: 200,
                emptyAsNull: true,
                subClass: ['name'],
                displayName: 'Category',
            },
            text: {
                type: 'text',
                optional: true,
                displayName: 'Text',
            },
            intValue: {
                type: 'integer',
                optional: true,
                displayName: 'Int Value',
            },
            numValue: {
                type: 'number',
                optional: true,
                displayName: 'Num Value',
            },
            object: {
                type: 'object',
                optional: true,
                displayName: 'Object',
            },
            flag: {
                type: 'boolean',
                optional: true,
                displayName: 'Flag',
            },
            timestamp: {
                type: 'datetime',
                optional: true,
                displayName: 'Timestamp',
            },
            isDeleted: {
                type: 'boolean',
                default: false,
                readOnly: true,
                displayName: 'Is Deleted',
            },
            deletedAt: {
                type: 'datetime',
                readOnly: true,
                optional: true,
                writeOnce: true,
                auto: true,
                displayName: 'Deleted At',
            },
            unit: {
                type: 'text',
                maxLength: 64,
                emptyAsNull: true,
                subClass: ['idString'],
                displayName: 'Unit',
                optional: true,
            },
        },
        features: {
            logicalDeletion: {
                field: 'isDeleted',
                value: true,
                timestampField: 'deletedAt',
            },
        },
        uniqueKeys: [['code'], ['name']],
        indexes: [
            {
                fields: ['name'],
                unique: true,
            },
        ],
        associations: {
            unit: {
                type: 'refersTo',
                entity: 'uomUnit',
                key: 'code',
                field: 'code',
                on: {
                    unit: {
                        oorType: 'ColumnReference',
                        name: 'unit.code',
                    },
                },
            },
        },
        fieldDependencies: {
            deletedAt: [
                {
                    reference: 'deletedAt',
                    writeProtect: true,
                },
            ],
        },
    };

    return Object.assign(TestEntitySpec, {});
};

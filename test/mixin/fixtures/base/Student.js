module.exports = (Base) => {    
    const StudentSpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            return context;
        }
    };
    
    StudentSpec.meta = {
        "schemaName": "test",
        "name": "student",
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
            "age": {
                "type": "integer",
                "displayName": "age"
            },
            "sex": {
                "type": "boolean",
                "displayName": "sex"
            },
            "name": {
                "type": "text",
                "maxLength": 200,
                "emptyAsNull": true,
                "displayName": "name"
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
        ]
    };

    return Object.assign(StudentSpec, {});
};
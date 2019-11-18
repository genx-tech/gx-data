const { _, pascalCase } = require('rk-utils');

const { Connector, getEntityModelOfDriver, Errors: { BusinessError } } = require('@k-suite/oolong');
const BaseEntityModel = getEntityModelOfDriver('{{ driver }}');

class {{ className }} {
    constructor(connection, options) {     
        if (typeof connection === 'string') {
            this.connector = Connector.createConnector('{{ driver }}', connection, options);
            this._connectorOwner = true;
        } else {  
            assert: connection.driver && connection.connectionString;
            
            this.connector = connection;
            this.i18n = options;
        }

        this._modelCache = {};
    }

    model(entityName) {        
        if (this._modelCache[entityName]) return this._modelCache[entityName];

        let modelClassName = pascalCase(entityName);
        if (this._modelCache[modelClassName]) return this._modelCache[modelClassName];

        let entitySpecMixin;

        try {
            entitySpecMixin = require(`./{{ schemaName }}/${modelClassName}`);        
        } catch (error) {
            if (error.code === 'MODULE_NOT_FOUND') {
                throw new BusinessError(`Failed to load "${modelClassName}" entity. Reason: ${error.message}`);
            }

            throw error;
        }

        let modelClass = entitySpecMixin(this, BaseEntityModel);

        this._modelCache[entityName] = modelClass;
        if (modelClassName !== entityName) {
            this._modelCache[modelClassName] = modelClass;
        }
        
        return modelClass;
    }

    entitiesOfType(baseEntityName) {
        return _.filter(this.constructor.entities, entityName => {
            let Model = this.model(entityName);
            return Model.baseClasses && Model.baseClasses.indexOf(baseEntityName) > -1;
        });
    }

    async close_() {
        if (this._connectorOwner) {
            await this.connector.end_();
            delete this._connectorOwner;
        }

        delete this._modelCache;
        delete this.connector;
        delete this.app;
    }

    async doTransaction_(transaction_, errorHandler) {
        let connection;

        try {
            connection = await this.connector.beginTransaction_();
            let ret = await transaction_(connection);
            await this.connector.commit_(connection);
            return ret;
        } catch(error) {
            if (connection) {
                await this.connector.rollback_(connection);
            }

            if (errorHandler) {
                return errorHandler(error);
            }

            throw error;
        }
    }
}

{{ className }}.driver = '{{ driver }}';
{{ className }}.schemaName = '{{ schemaName }}';
{{ className }}.entities = {{ entities|safe }};

module.exports = {{ className }};
const { _, pascalCase } = require('rk-utils');

class DbModel {
    constructor(app, connector, i18n) {     
        this.app = app;
        this.connector = connector;
        this.i18n = i18n;

        this._modelCache = {};
    }

    get driver() {
        return this.connector.driver;
    }

    model(entityName) {        
        if (this._modelCache[entityName]) return this._modelCache[entityName];

        let modelClassName = pascalCase(entityName);
        if (this._modelCache[modelClassName]) return this._modelCache[modelClassName];

        let entitySpecMixin = this.loadModel(modelClassName);
        const BaseEntityModel = require(`./drivers/${this.driver}/EntityModel`); 
        const modelClass = entitySpecMixin(this, BaseEntityModel);

        this._modelCache[entityName] = modelClass;
        if (modelClassName !== entityName) {
            this._modelCache[modelClassName] = modelClass;
        }
        
        return modelClass;
    }

    entitiesOfType(baseEntityName) {
        return _.filter(this.entities, entityName => {
            let Model = this.model(entityName);
            return Model.baseClasses && Model.baseClasses.indexOf(baseEntityName) > -1;
        });
    }

    async close_() {
        delete this._modelCache;
        delete this.connector;
        delete this.app;
    }
}

module.exports = DbModel;
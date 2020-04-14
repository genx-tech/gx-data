const { _, pascalCase, sleep_ } = require('rk-utils');
const { DatabaseError } = require('./utils/Errors');

const retryFailed = error => [ false, error ];
const retryOK = (result) => [ true, result ];

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

        let entityCustomClassFactory = this.loadCustomModel(modelClassName); 
        let entityClassFactory = this.loadModel(modelClassName);
        
        let BaseEntityModel = require(`./drivers/${this.driver}/EntityModel`); 
        if (entityCustomClassFactory) {
            BaseEntityModel = entityCustomClassFactory(BaseEntityModel);
        }

        const modelClass = entityClassFactory(BaseEntityModel);
        modelClass.db = this;

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

    async retry_(transactionName, transaction, maxRetry, interval) {
        let i = 0;
        if (maxRetry == null) maxRetry = 3;

        while (i++ < maxRetry) {
            const [ finished, result ] = await transaction(retryOK, retryFailed);

            if (finished) {
                return result;
            }

            if (i === maxRetry) {
                throw new DatabaseError(`Unable to complete expected transaction after retried ${maxRetry} times.`, result);
            }

            this.app.logException('warn', result, `Unable to complete "${transactionName}" and will try ${maxRetry-i} more times after ${interval||0} ms.`);

            if (interval != null) {
                await sleep_(interval);
            }
        }        
    }

    async close_() {
        delete this._modelCache;
        delete this.connector;
        delete this.app;
    }
}

module.exports = DbModel;
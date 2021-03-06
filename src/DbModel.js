const { _, pascalCase, sleep_ } = require("rk-utils");

const retryFailed = (error) => [false, error];
const retryOK = (result) => [true, result];

const directReturn = (a) => a;

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

    /**
     * Get entity model class by entity name.
     * @param {*} entityName 
     */
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

        if (modelClass.__init) {
            modelClass.__init();
        }
 
        this._modelCache[entityName] = modelClass;
        if (modelClassName !== entityName) {
            this._modelCache[modelClassName] = modelClass;
        }

        return modelClass;
    }

    entitiesOfType(baseEntityName) {
        return _.filter(this.entities, (entityName) => {
            let Model = this.model(entityName);
            return Model.baseClasses && Model.baseClasses.indexOf(baseEntityName) > -1;
        });
    }

    /**
     * Run an action and automatically retry when failed. 
     * @param {*} transactionName 
     * @param {*} action_ 
     * @param {*} connOptions 
     * @param {*} maxRetry 
     * @param {*} interval 
     * @param {*} onRetry_ 
     */
    async retry_(transactionName, action_, connOptions, maxRetry, interval, onRetry_) {
        //retry will be ignored, if the transaction is a part of another transaction
        if (connOptions && connOptions.connection) {
            return action_(directReturn, directReturn);
        }

        let i = 0;
        if (maxRetry == null) maxRetry = 2;

        while (i++ < maxRetry) {
            const [finished, result] = await action_(retryOK, retryFailed);

            if (finished) {
                return result;
            }

            if (i === maxRetry) {
                throw result;
            }

            this.app.logException(
                "warn",
                result,
                `Unable to complete "${transactionName}" and will try ${maxRetry - i} more times after ${
                    interval || 0
                } ms.`
            );

            if (interval != null) {
                await sleep_(interval);
            }

            if (onRetry_) {
                await onRetry_();
            }
        }
    }

    /**
     * Run an action as transaction and automatically retry when failed. 
     * @param {*} transactionName 
     * @param {*} action_ 
     * @param {*} connOptions 
     * @param {*} maxRetry 
     * @param {*} interval 
     * @param {*} onRetry_ 
     */
    async safeRetry_(transactionName, action_, connOptions, maxRetry, interval, onRetry_) {
        return this.retry_(
            transactionName,
            (ok, failed) => this.doTransaction_(async (connOpts) => ok(await action_(connOpts)), failed, connOptions),
            connOptions,
            maxRetry,
            interval,
            onRetry_
        );
    }

    async close_() {
        delete this._modelCache;
        delete this.connector;
        delete this.app;
    }
}

module.exports = DbModel;

"use strict";

require("source-map-support/register");

const {
  _,
  naming,
  sleep_
} = require('@genx/july');

const {
  fs
} = require('@genx/sys');

const {
  InvalidArgument
} = require('@genx/error');

const retryFailed = error => [false, error];

const retryOK = result => [true, result];

const directReturn = a => a;

class DbModel {
  constructor(app, connector, i18n) {
    this.ownerApp = app;
    this.app = app;
    this.connector = connector;
    this.i18n = i18n;
    this._modelCache = {};
  }

  get driver() {
    return this.connector.driver;
  }

  model(entityName) {
    if (!entityName) {
      throw new InvalidArgument('Entity name is required.');
    }

    if (this._modelCache[entityName]) return this._modelCache[entityName];
    const modelClassName = naming.pascalCase(entityName);
    if (this._modelCache[modelClassName]) return this._modelCache[modelClassName];
    const entityCustomClassFactory = this.loadCustomModel(modelClassName);
    const entityClassFactory = this.loadModel(modelClassName);

    let modelClass = require(`./drivers/${this.driver}/EntityModel`);

    modelClass = entityClassFactory(modelClass);

    if (modelClass.meta.packagePath) {
      const entityClassFromPackage = this.loadPackageModel(modelClass.meta.packagePath, modelClassName);

      if (entityClassFromPackage) {
        modelClass = entityClassFromPackage(modelClass);
      }
    }

    if (entityCustomClassFactory) {
      modelClass = entityCustomClassFactory(modelClass);
    }

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

  loadPackageModel(packagePath, modelClassName) {
    const customModelPath = this.ownerApp.toAbsolutePath(packagePath, process.env.NODE_RT && process.env.NODE_RT === 'babel' ? 'src' : 'lib', 'models', `${modelClassName}.js`);
    return fs.existsSync(customModelPath) && require(customModelPath);
  }

  entitiesOfType(baseEntityName) {
    return _.filter(this.entities, entityName => {
      const Model = this.model(entityName);
      return Model.baseClasses && Model.baseClasses.indexOf(baseEntityName) > -1;
    });
  }

  async retry_(transactionName, action_, connOptions, maxRetry, interval, onRetry_) {
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

      this.app.logException('warn', result, `Unable to complete "${transactionName}" and will try ${maxRetry - i} more times after ${interval || 0} ms.`);

      if (interval != null) {
        await sleep_(interval);
      }

      if (onRetry_) {
        await onRetry_();
      }
    }
  }

  async safeRetry_(transactionName, action_, connOptions, maxRetry, interval, onRetry_) {
    return this.retry_(transactionName, (ok, failed) => this.doTransaction_(async connOpts => ok(await action_(connOpts)), failed, connOptions), connOptions, maxRetry, interval, onRetry_);
  }

  async close_() {
    delete this._modelCache;
    delete this.connector;
    delete this.app;
    delete this.ownerApp;
  }

}

module.exports = DbModel;
//# sourceMappingURL=DbModel.js.map
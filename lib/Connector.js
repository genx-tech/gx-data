"use strict";

require("source-map-support/register");
const {
  URL
} = require('url');
const {
  _
} = require('@genx/july');
const {
  SupportedDrivers
} = require('./utils/lang');
class Connector {
  static createConnector(driver, connectionString, options) {
    if (SupportedDrivers.indexOf(driver) === -1) {
      throw new Error(`Unsupported connector driver: "${driver}"!`);
    }
    if (!connectionString) {
      throw new Error(`Missing required connection string`);
    }
    const ConnectorClass = require(`./drivers/${driver}/Connector`);
    return new ConnectorClass(connectionString, options);
  }
  constructor(driver, connectionString, options) {
    this.driver = driver;
    this.connectionString = connectionString;
    this.options = options || {};
    this.relational = false;
  }
  makeNewConnectionString(components) {
    const url = new URL(this.connectionString);
    if ('username' in components) {
      url.username = components.username;
    }
    if ('password' in components) {
      url.password = components.password;
    }
    if ('database' in components) {
      url.pathname = '/' + components.database;
    }
    if ('options' in components) {
      const options = components.options;
      _.forOwn(options, (value, key) => {
        url.searchParams.set(key, typeof value === 'boolean' ? value ? 1 : 0 : value);
      });
    }
    return url.href;
  }
  getConnectionStringWithoutCredential(connStr) {
    const url = new URL(connStr || this.connectionString);
    url.username = '';
    url.password = '';
    return url.href;
  }
  get database() {
    if (!this._database) {
      this._database = new URL(this.connectionString).pathname.substring(1);
    }
    return this._database;
  }
  get driverLib() {
    return this.constructor.driverLib;
  }
  log(...args) {
    if (this.options.logger) {
      this.options.logger.log(...args);
    }
  }
}
module.exports = Connector;
//# sourceMappingURL=Connector.js.map
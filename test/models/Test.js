const path = require('path');
const { fs } = require('@genx/sys');

const { DbModel } = require('@genx/data');
const { eachAsync_ } = require('@genx/july/lib/commonjs/collection');

class Test extends DbModel {
    constructor(app, connector, i18n) {
        super(app, connector, i18n);

        this.schemaName = 'test';
        this.entities = ['testEntity', 'uomUnit'];
    }

    require(moduleRelativePath) {
        return require(path.resolve(
            __dirname,
            this.schemaName,
            moduleRelativePath
        ));
    }

    loadCustomModel(modelClassName) {
        const customModelPath = path.resolve(
            __dirname,
            `./${this.schemaName}/${modelClassName}.js`
        );
        return fs.existsSync(customModelPath) && require(customModelPath);
    }

    loadModel(modelClassName) {
        return require(`./${this.schemaName}/base/${modelClassName}.js`);
    }

    async doTransaction_(transaction, errorHandler, connOptions) {
        if (connOptions && connOptions.connection) {
            return transaction(connOptions);
        }

        let connection;

        try {
            connection = await this.connector.beginTransaction_();
            const ret = await transaction({ ...connOptions, connection });
            await this.connector.commit_(connection);
            return ret;
        } catch (error) {
            if (connection) {
                await this.connector.rollback_(connection);
            }

            if (errorHandler) {
                return errorHandler(error);
            }

            throw error;
        }
    }

    async createDbIfNotExist_(truncate) {
        await this.connector.execute_(
            'CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET ?? COLLATE ??',
            [this.connector.database, 'utf8mb4', 'utf8mb4_general_ci'],
            { createDatabase: true }
        );

        await eachAsync_(this.entities, async (entity) => {
            const Entity = this.model(entity);

            await Entity.createTableIfNotExist_();

            if (truncate) {
                await this.connector.execute_('TRUNCATE TABLE ??', [entity]);
            }
        });
    }
}

module.exports = Test;

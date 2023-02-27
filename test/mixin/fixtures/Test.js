const DbModel = require('../../../src/DbModel');
const path = require('path');
const { fs } = require('@genx/sys');

class Test extends DbModel{
    constructor(app, connector, i18n) {     
        super(app, connector, i18n);
        
        this.schemaName = 'test';
        this.entities = ["student"];        
    }

    loadCustomModel(modelClassName) { 
        const customModelPath = path.resolve(__dirname, `./models/${modelClassName}.js`);           
        return fs.existsSync(customModelPath) && require(customModelPath);
    }

    loadModel(modelClassName) {            
        return require(`./base/${modelClassName}.js`);
    }    
}

module.exports = Test;
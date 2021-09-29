const path = require('path');
const { _ } = require('@genx/july');
const { fs } = require('@genx/sys');

const basePath = path.resolve(__dirname, 'auto');

const generators = fs.readdirSync(basePath);
const G = {};

generators.forEach((file) => {
    const f = path.join(basePath, file);
    if (fs.statSync(f).isFile() && _.endsWith(file, '.js')) {
        const g = path.basename(file, '.js');
        G[g] = require(f);
    }
});

module.exports = G;

const path = require('path');
const { _ } = require('@genx/july');
const { fs } = require('@genx/sys');

const basePath = path.resolve(__dirname, 'auto');

let generators = fs.readdirSync(basePath);
let G = {};

generators.forEach((file) => {
    let f = path.join(basePath, file);
    if (fs.statSync(f).isFile() && _.endsWith(file, '.js')) {
        let g = path.basename(file, '.js');
        G[g] = require(f);
    }
});

module.exports = G;

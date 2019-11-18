"use strict";

const path = require('path');
const Util = require('rk-utils');

const basePath = path.resolve(__dirname, 'auto');

let generators = Util.fs.readdirSync(basePath);
let G = {};

generators.forEach(file => {
    let f = path.join(basePath, file);
    if (Util.fs.statSync(f).isFile() && Util._.endsWith(file, '.js')) {
        let g = path.basename(file, '.js');
        G[g] = require(f);
    }
});

module.exports = G;
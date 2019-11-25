const path = require('path');
const { fs, Promise } = require('rk-utils');
const { tryRequire } = require('./lib');

module.exports = async (url, targetFile) => {
    const request = tryRequire('superagent');

    const dirName = path.dirname(targetFile);

    await fs.ensureDir(dirName);

    const stream = fs.createWriteStream(targetFile);

    await new Promise((resolve, reject) => {
        stream.on('close', () => {
            resolve();
        });

        stream.on('error', (err) => {
            reject(err);
        });

        request.get(url).pipe(stream);    
    });
};
    
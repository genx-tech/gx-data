const { fs, Promise } = require('rk-utils');
const { tryRequire } = require('./lib');

module.exports = async (csvFile, options, transformer) => {
    const parse = tryRequire('csv-parse');

    const output = []

    const readStream = fs.createReadStream(csvFile);
    const parser = parse({
        columns: true,
        ...options
    });

    const read = transformer ? () => {
        let record;
        while (record = parser.read()) {
            output.push(transformer(record));
        }
    } : () => {
        let record;
        while (record = parser.read()) {
            output.push(record);
        }
    };

    return new Promise((resolve, reject) => {
        parser.on('readable', read);

        // Catch any error
        parser.on('error', err => {
            reject(err);
        });

        // When we are done, test that the parsed output matched what expected
        parser.on('end', () => resolve(output));

        readStream.pipe(parser);
    });    
};
    
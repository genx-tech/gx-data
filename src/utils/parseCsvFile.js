const { fs, Promise } = require('rk-utils');
const { tryRequire } = require('./lib');

module.exports = async (csvFile, options, transformer) => {
    const parse = tryRequire('csv-parse');    

    const readStream = fs.createReadStream(csvFile);
    const parser = parse({
        columns: true,
        ...options
    });

    let transformSteam, output;

    if (transformer) {
        const transform = tryRequire('stream-transform');
        let line = 0;

        transformSteam = transform((data, callback) => {
            transformer(data, line++).then(result => callback(null, result)).catch(error => callback(error));
        });
    } else {
        output = [];
    }   

    return new Promise((resolve, reject) => {
        // Catch any error
        parser.on('error', reject); 

        if (!transformSteam) {
            parser.on('readable', () => {   
                let record;
                             
                while (record = parser.read()) {
                    output.push(record);
                }
            });
            
            // When we are done, test that the parsed output matched what expected
            parser.on('end', () => resolve(output));

            readStream.pipe(parser);
        } else {
            transformSteam.on('error', reject);
            transformSteam.on('finish', resolve);

            readStream.pipe(parser).pipe(transformSteam);
        }     
    });    
};
    
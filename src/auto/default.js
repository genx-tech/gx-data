const Types = require('../types');

function auto(info, i18n) {
    pre: {
        Types.Builtin.has(info.type),
            `Unknown primitive type: "${info.type}"."`;
        info.auto, `Not an automatically generated field "${info.name}".`;
    }

    if (info.generator) {
        let name, options;

        //customized generator
        if (typeof info.generator === 'string') {
            name = info.generator;
        } else if (Array.isArray(info.generator)) {
            assert: info.generator.length > 0;
            name = info.generator[0];

            if (info.generator.length > 1) {
                options = info.generator[1];
            }
        } else {
            name = info.generator.name;
            options = info.generator.options;
        }

        const G = require('../Generators');
        let gtor = G[name];
        return gtor(info, i18n, options);
    }

    let typeObjerct = Types[info.type];
    return typeObjerct.generate(info, i18n);
}

module.exports = auto;

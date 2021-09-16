const path = require('path');
const { _ } = require('@genx/july');
const { fs } = require('@genx/sys');

const basePath = path.resolve(__dirname);
const features = fs.readdirSync(basePath);

const featureRules = {};

features.forEach((file) => {
    let f = path.join(basePath, file);
    if (fs.statSync(f).isFile() && _.endsWith(file, '.js')) {
        let featureName = path.basename(file, '.js');
        if (featureName === 'index') return;

        let feature = require(f);

        _.forOwn(feature, (action, ruleName) => {
            let key = featureName + '.' + ruleName;

            assert: !(key in featureRules), key;
            featureRules[key] = action;
        });
    }
});

module.exports = {
    applyRules_: async (ruleName, entityModel, context) => {
        for (let featureName in entityModel.meta.features) {
            let key = featureName + '.' + ruleName;
            let action = featureRules[key];

            if (action) {
                let featureInfo = entityModel.meta.features[featureName];

                if (
                    context.options.$features &&
                    context.options.$features.hasOwnProperty(featureName)
                ) {
                    let customFeatureInfo =
                        context.options.$features[featureName];
                    if (!customFeatureInfo) {
                        continue;
                    }

                    featureInfo = { ...featureInfo, ...customFeatureInfo };
                }

                let asExpected = await action(
                    featureInfo,
                    entityModel,
                    context
                );
                if (!asExpected) return false;
            }
        }

        return true;
    },
};

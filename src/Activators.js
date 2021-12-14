const { _ } = require('@genx/july');
const { ApplicationError } = require('./utils/Errors');
const Generators = require('./Generators');

module.exports = {
    datetimeAdd: function (model, context, startTime, duration) {
        return startTime.plus(duration);
    },

    isEqual: function (model, context, value1, value2) {
        return value1 === value2;
    },

    triggerUpdate: function (model, context, value, condition) {
        return condition ? value : null;
    },

    defaultAs: function (model, context, value) {
        return value;
    },

    generator: function (model, context, name, ...infoI18nOpts) {
        return Generators[name](...infoI18nOpts);
    },

    concat: (model, context, sep = '', ...strs) => strs.join(sep),

    sum: (model, context, ...args) => args.reduce((sum, v) => (sum += v), 0),

    multiply: (model, context, multiplier, multiplicand) =>
        multiplier * multiplicand,

    populate: async (model, context, assoc, options) => {
        const parts = assoc.split('.');

        const selectedField = parts.pop();
        const remoteAssoc = parts.join('.');
        const localAssoc = parts.shift();
        let interAssoc;

        if (parts.length > 0) {
            interAssoc = parts.join('.');
        }

        if (!(localAssoc in context.latest)) {
            return undefined;
        }

        const assocValue = context.latest[localAssoc];
        if (_.isNil(assocValue)) {
            throw new ApplicationError(
                `The value of referenced association "${localAssoc}" of entity "${model.meta.name}" should not be null.`
            );
        }

        const assocMeta = model.meta.associations[localAssoc];
        if (!assocMeta) {
            throw new ApplicationError(
                `"${localAssoc}" is not an association field of entity "${model.meta.name}".`
            );
        }

        if (assocMeta.list) {
            throw new ApplicationError(
                `"${localAssoc}" entity "${model.meta.name}" is a list-style association which is not supported by the built-in populate Activators.`
            );
        }

        // local cache in context, shared by other fields if any
        let remoteEntity = context.populated && context.populated[remoteAssoc];
        if (!remoteEntity) {
            if (options && options.useCache) {
                remoteEntity = (
                    await model.db
                        .model(assocMeta.entity)
                        .cached_(
                            assocMeta.key,
                            interAssoc ? [interAssoc] : null,
                            context.connOptions
                        )
                )[assocValue];
            } else {
                const findOptions = { $query: { [assocMeta.key]: assocValue } };

                if (interAssoc) {
                    findOptions.$associations = [interAssoc];
                }

                await model.ensureTransaction_(context);

                remoteEntity = await model.db
                    .model(assocMeta.entity)
                    .findOne_(findOptions, context.connOptions);
            }

            if (!remoteEntity) {
                throw new ApplicationError(
                    `Unable to find the "${assocMeta.entity}" with [${assocMeta.key}=${assocValue}]. Entity: ${model.meta.name}`
                );
            }

            context.populated || (context.populated = {});
            context.populated[localAssoc] = remoteEntity;

            let currentAssoc = localAssoc;
            while (parts.length > 0) {
                const nextAssoc = parts.shift();
                remoteEntity = remoteEntity[':' + nextAssoc];
                if (Array.isArray(remoteEntity)) {
                    throw new Error('Remote entity should not be an array.');
                }

                currentAssoc = currentAssoc + '.' + nextAssoc;
                context.populated[currentAssoc] = remoteEntity;
            }
        }

        if (!(selectedField in remoteEntity)) {
            throw new ApplicationError(
                `"${selectedField}" is not a field of remote association "${remoteAssoc}" of entity "${model.meta.name}".`
            );
        }

        return remoteEntity[selectedField];
    },
};

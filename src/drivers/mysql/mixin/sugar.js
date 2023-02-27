'use strict';
const assert = require('assert');
const Lang = require('../../../utils/lang');

async function baseQuery(model, name, column, alias, findOptions, connOptions) {
    const projection = {
        type: 'function',
        name,
        args: [column || '*'],
        alias: alias || name.toLowerCase()
    }

    if (findOptions) {
        if (findOptions.$projection) {
            findOptions.$projection.push(projection);
        } else {
            findOptions.$projection = [projection];
        }
    } else {
        findOptions = {
            $projection: [projection]
        }
    }

    const data = await model.findAll_(findOptions, connOptions);
    return data[0];
}

async function baseUpdate(model, method, column, value, updateOptions, connOptions) {
    assert(column, 'Column name is required.');
    assert(((typeof value) === 'number' && !Number.isNaN(value)), 'Value must be number.');

    value = value || 1;

    const data = {};
    data[column] = method === 'increment' ? Lang.$inc(column, value) : Lang.$dec(column, value);
    return await model.updateOne_(data, updateOptions, connOptions);
}

module.exports = {
    async count_(column, alias, findOptions, connOptions) {
        return baseQuery(this, 'COUNT', column, alias, findOptions, connOptions);
    },
    async max_(column, alias, findOptions, connOptions) {
        assert(column, 'Column name is required.');

        return baseQuery(this, 'MAX', column, alias, findOptions, connOptions);
    },
    async min_(column, alias, findOptions, connOptions) {
        assert(column, 'Column name is required.');

        return baseQuery(this, 'MIN', column, alias, findOptions, connOptions);
    },
    async sum_(column, alias, findOptions, connOptions) {
        assert(column, 'Column name is required.');

        return baseQuery(this, 'SUM', column, alias, findOptions, connOptions);
    },
    async increment_(column, value, updateOptions, connOptions) {
        return baseUpdate(this, 'increment', column, value, updateOptions, connOptions);
    },
    async decrement_(column, value, updateOptions, connOptions) {
        return baseUpdate(this, 'decrement', column, value, updateOptions, connOptions);
    },
    async findOrCreate_(data, findOptions, connOptions) {
        // eslint-disable-next-line valid-typeof
        assert(!(Array.isArray ? Array.isArray(data) : ((typeof data) === '[object Array]')), 'Data can not be array.');
        assert((data !== null) && ((typeof data) === 'object') && Object.keys(data).length, 'Data can not be empty.');

        // eslint-disable-next-line valid-typeof
        assert(!(Array.isArray ? Array.isArray(findOptions) : ((typeof findOptions) === '[object Array]')), 'FindOptions can not be array.');
        assert((findOptions !== null) && ((typeof findOptions) === 'object') && Object.keys(findOptions).length, 'FindOptions can not be empty.');

        assert((findOptions.$query !== null) && ((typeof findOptions.$query) === 'object') && Object.keys(findOptions.$query).length, 'FindOptions $query can not be empty.');

        Object.keys(findOptions.$query).forEach(key => {
            if (!data[key]) {
                data[key] = findOptions.$query[key]
            }
        });

        let result = await this.findOne_(findOptions, connOptions);
        if (result) {
            return { created: false, result };
        } else {
            result = await this.create_(data, null, connOptions);
            return { created: true, result };
        }
    }
}
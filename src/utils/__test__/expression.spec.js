const JES = require('../expression');

describe.only('unit:utils:expression', function () {    
    it('equal', function () {
        let obj = {
            key1: 2000,
            key2: 'ok',
            key3: {
                key1: 20,
                key2: 'ok'
            },
            key4: null,
            key5: false,
            key6: true
        };

        JES.has(obj, {
            key1: 2000,
            key2: 'ok',
            key3: {
                key1: 20,
                key2: 'ok'
            },
            key4: null,
            key5: false,
            key6: true
        }).should.be.eql([true]);

        let result = JES.has(obj, {
            key1: 2001
        });
        result[0].should.not.be.ok();
        result[1].should.be.match(/ should be 2001/);

        result = JES.has(obj, {
            key2: 'ng'
        });
        result[0].should.not.be.ok();
        result[1].should.be.match(/ should be "ng"/);
    });

    it('mixed', function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,

            key2: 'ok',
            key21: 'ok',
            key22: 'ok',
            key23: 'ok',

            key3: {
                key1: 20,
                key2: 'ok'
            },
            key4: null,
            key5: false,
            key6: true
        };

        JES.has(obj, {
            key1: { $gt: 1000 },
            key11: { $gte: 2000 },
            key12: { $lt: 3000 },
            key13: { $lte: 2000 },

            key2: { $eq: 'ok' },
            key21: { $neq: 'ng' },

            key22: { $in: [ 'ok', 'ng' ] },
            key23: { $nin: [ 'ng1', 'ng2' ] },

            key4: { $exists: false }
        }).should.be.eql([true]);
    });
});
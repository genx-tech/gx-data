const JES = require("../jes");

describe("unit:utils:expression", function () {
    it("equal", function () {
        let obj = {
            key1: 2000,
            key2: "ok",
            key3: {
                key1: 20,
                key2: "ok",
            },
            key4: null,
            key5: false,
            key6: true,
        };

        JES.match(obj, {
            key1: 2000,
            key2: "ok",
            key3: {
                key1: 20,
                key2: "ok",
            },
            key4: null,
            key5: false,
            key6: true,
        }).should.be.eql([true]);

        let result = JES.match(obj, {
            key1: 2001,
        });
        result[0].should.not.be.ok();
        result[1].should.be.match(/ should be 2001/);

        result = JES.match(obj, {
            key2: "ng",
        });
        result[0].should.not.be.ok();
        result[1].should.be.match(/ should be "ng"/);
    });

    it("mixed", function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,

            key2: "ok",
            key21: "ok",
            key22: "ok",
            key23: "ok",

            key3: {
                key1: 20,
                key2: "ok",
            },
            key4: null,
            key5: false,
            key6: true,
        };

        JES.match(obj, {
            key1: { $gt: 1000 },
            key11: { $gte: 2000 },
            key12: { $lt: 3000 },
            key13: { $lte: 2000 },

            key2: { $eq: "ok" },
            key21: { $neq: "ng" },

            key22: { $in: ["ok", "ng"] },
            key23: { $nin: ["ng1", "ng2"] },

            key4: { $exists: false },
        }).should.be.eql([true]);
    });

    it("jes", function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,

            key2: "ok",
            key21: "ok",
            key22: "ok",
            key23: "ok",

            key3: {
                key1: 20,
                key2: "ok",
            },
            key4: null,
            key5: false,
            key6: true,
        };

        const jeso = new JES(obj);
        jeso.match({
            key1: { $gt: 1000 },
            key11: { $gte: 2000 },
            key12: { $lt: 3000 },
            key13: { $lte: 2000 },
        })
            .match({
                key2: { $eq: "ok" },
                key21: { $neq: "ng" },

                key22: { $in: ["ok", "ng"] },
                key23: { $nin: ["ng1", "ng2"] },

                key4: { $exists: false },
                key2: { $is: "string" },
            })
            .match({
                key3: {
                    key1: 20,
                    key2: {
                        $neq: "ng",
                    },
                },
            });

        should.throws(() => {
            jeso.match({
                key1: { $gt: 3000 },
            });
        }, /"key1" should be greater than 3000/);

        should.throws(() => {
            jeso.match({
                key1: { $lt: 1000 },
            });
        }, /"key1" should be less than 1000/);

        should.throws(() => {
            jeso.match({
                key1: { $in: [100, 200] },
            });
        }, 'ValidationError: "key1" should be one of [100,200].');

        should.throws(() => {
            jeso.match({
                key1: { $nin: [1000, 2000] },
            });
        }, 'ValidationError: "key1" should not be any one of [1000,2000].');

        should.throws(() => {
            jeso.match({
                key99: { $exist: true },
            });
        }, 'ValidationError: "key99" should not be NULL.');

        should.throws(() => {
            jeso.match({
                key1: { $exist: false },
            });
        }, 'ValidationError: "key1" should be NULL.');

        should.throws(() => {
            jeso.match({
                key1: { $is: "string" },
            });
        }, 'ValidationError: The type of "key1" should be "string".');

        should.throws(() => {
            jeso.match({
                key3: { key2: "ng" },
            });
        }, 'ValidationError: "key3.key2" should be "ng".');
    });

    it("any", function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,
        };

        let jeso = new JES(obj);

        jeso.match({
            $any: [{ key1: 3000 }, { key11: 2000 }],
        });

        should.throws(() => {
            jeso.match({
                $any: [{ key1: 3000 }, { key11: 3000 }],
            });
        }, 'ValidationError: The value should match any of these rules: [{"key1":3000},{"key11":3000}].');
    });

    it("matchWithQuery", function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,
        };

        let jeso = new JES(obj);

        jeso.match({
            $$size: 4,
            key1: {
                $$type: 'integer'
            }
        });

        jeso.match({
            "|>$$add": [
                200,
                {
                    key1: 2200,
                    key11: 2200,
                    key12: 2200,
                    key13: 2200,
                },
            ],
        });

        should.throws(() => {
            jeso.match({
                "|>$$add": [200, obj],
            });
        }, 'ValidationError: The query "_.each(->add(?)).key1" should be 2000, but 2200 given.');

        should.throws(() => {
            jeso.match({
                $$keys: {
                    $$size: {
                        $neq: 4,
                    },
                },
            });
        }, 'ValidationError: The query "keys().size()" should not be 4, but 4 given.');
    });

    it("eval", function () {
        let obj = {
            key1: 2000,
            key11: 2000,
            key12: 2000,
            key13: 2000,
        };

        let jeso = new JES(obj);

        const pipelined = jeso.evaluate([
            {
                "|>$add": 100,
            },
            {
                "|>$subtract": 200,
            },
            "$sum",
        ]);

        pipelined.should.be.exactly(7600);
        jeso.value.should.be.eql(obj);

        jeso.update({
            key1: {
                $add: 100,
            },
            key11: {
                $subtract: 100,
            },
            key12: {
                $multiply: 100,
            },
            key13: {
                $divide: 100,
            },
        }).value.should.be.eql({
            key1: 2100,
            key11: 1900,
            key12: 200000,
            key13: 20,
        });

        jeso.update([
            "$sum",
            {
                $add: 1,
            },
        ]).value.should.be.exactly(204021);
    });

    it.only("eval array", function () {
        let obj = {
            keep: "keep",
            items: [
                { name: "Jack", score: 60 },
                { name: "Bob", score: 40 },
                { name: "Jane", score: 80 },
                { name: "Peter", score: 100 },
            ],
            ignored: 'ingored',
            exlcluded: 'exlcluded'
        };

        let jeso = new JES(obj);

        const pipelined = jeso.evaluate({
            keep: true, 
            excluded: false,      
            newItem: { $set: "new" },      
            highestScore: [
                "$$CURRENT.items",                
                {
                    $sortBy: "score",
                },
                "$reverse",
                {
                    "$nth": 0,
                },
                {
                    "$of": "score"
                }
            ],
        });

        console.log(pipelined);

        should.exist(pipelined.keep);
        should.exist(pipelined.newItem);
        should.exist(pipelined.highestScore);
        should.not.exist(pipelined.exlcluded);
        should.not.exist(pipelined.items);
        should.not.exist(pipelined.ignored);

        pipelined.newItem.should.be.exactly("new");
        pipelined.highestScore.should.be.exactly(100);
    });

    it("transform collection", function () {
        let array = [
            { user: 100, agency: 1, ":user": { email: "email1", other: "any" }, ":agency": { name: 'agency1', other: 'any' } },
            { user: 101, agency: 1, ":user": { email: "email2", other: "any" }, ":agency": { name: 'agency1', other: 'any' } },
            { user: 102, agency: 1, ":user": { email: "email3", other: "any" }, ":agency": { name: 'agency1', other: 'any' } },
            { user: 103, agency: 2, ":user": { email: "email4", other: "any" }, ":agency": { name: 'agency2', other: 'any' } },
            { user: 104, agency: 2, ":user": { email: "email5", other: "any" }, ":agency": { name: 'agency2', other: 'any' } },
        ];

        let transformed = JES.evaluate(array, {
            '|>$apply': {
                user: [ '$$CURRENT.:user', { $pick: [ 'email' ] } ],
                agency: [ '$$CURRENT.:agency', { $pick: [ 'name' ] } ]
            }
        });

        transformed.should.be.eql([
            { user: { email: 'email1' }, agency: { name: 'agency1' } },
            { user: { email: 'email2' }, agency: { name: 'agency1' } },
            { user: { email: 'email3' }, agency: { name: 'agency1' } },
            { user: { email: 'email4' }, agency: { name: 'agency2' } },
            { user: { email: 'email5' }, agency: { name: 'agency2' } }
          ]);
    });
});

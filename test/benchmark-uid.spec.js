"use strict";

const testSuite = require("@genx/test");
const Generators = require("../src/Generators");

testSuite(
    function (suite) {      
        suite.testCase("uid generators", async function () {
            const testees = {
                'hyperid': (data) => Generators.hyperid(),
                'shortid': (data) => Generators.shortid(),
                'uniqid': (data) => Generators.uniqid(),
                'uuid': (data) => Generators.uuid(),
                'nanoid': (data) => Generators.nanoid(),
            };

            const data = [];

            await suite.benchmark_(testees, data);
        });
    },
    { verbose: true }
);

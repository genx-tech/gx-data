"use strict";

const Types = require("..");
const { _ } = require("rk-utils");

describe("unit:types:integer", function () {
    const fixtures = [
        [10, 10],
        ["10", 10],
        [" 10", 10],
        [ '10 ', 10 ],
        [ ' 10  ', 10 ],
        [ 10.0, 10 ],
        [ null, null ],
        [ undefined, undefined ]  
    ];

    fixtures.forEach(([input, expected], i) => {
        it("basic" + i, function () {
            console.log(input, expected);
            let sanitized = Types.INTEGER.sanitize(input, { type: "integer" });
            if (typeof sanitized === "undefined") {
                (typeof expected).should.be.exactly("undefined");
            } else if (expected == null) {
                (sanitized == null).should.be.ok();
            } else {
                sanitized.should.be.equal(expected);
            }
        });
    });
});

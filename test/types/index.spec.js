'use strict';
const should = require('should');

const { Types, Validators, Convertors } = require('../../src');


describe("Types", function () {

    describe('customize validator and convertor', () => {

        it('should be work fine for boolean', () => {
            const schema = {
                schema: {
                    a: { validator: (value) => Validators.isBoolean(value) }
                }
            }

            const obj = {
                a: 'true'
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql(obj);

        });

        it('should be work fine when custom validator failed ', () => {
            const schema = {
                schema: {
                    a: { validator: (value) => Validators.isBoolean(value) }
                }
            }

            const obj = {
                a: 'aaa'
            }

            try {
                Types.OBJECT.sanitize(obj, schema).should.be.eql(obj);
            } catch (error) {
                error.message.should.be.eql(`Invalid "a" value`);
            }

        });

        it('should be work fine for boolean with convertor', () => {
            const schema = {
                schema: {
                    a: { validator: (value) => Validators.isBoolean(value), convertor: (value) => Convertors.toBoolean(value) }
                }
            }

            const obj = {
                a: 'true'
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql({ a: true });

        });

        it('should be work fine sanitize obj ', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'object', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text', optional: true },
                                d: { type: 'text', optional: true }
                            }
                        }
                    }
                }
            }

            const obj = {
                a: 'test',
                b: {
                    c: '1',
                    d: '1'
                }
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql(obj);

        });

        it('should be work fine sanitize obj with array ', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'array', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text', optional: true },
                                d: { type: 'text', optional: true }
                            }
                        }
                    }
                }
            }

            const obj = {
                a: 'test',
                b: [
                    {
                        c: '1',
                        d: '1'
                    }
                ]
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql(obj);

        });

        it('should be work fine sanitize obj with validator and convertor ', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'object', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text', optional: true },
                                d: { type: 'text', optional: true },
                                e: { validator: (value) => Validators.isInt(value), convertor: (value) => Convertors.toInt(value) }
                            }
                        }
                    }
                }
            }

            const obj = {
                a: 'test',
                b: {
                    c: '1',
                    d: '2',
                    e: '3'
                }
            }

            const except = {
                a: 'test',
                b: {
                    c: '1',
                    d: '2',
                    e: 3
                }
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql(except);

        });

        it('should be work fine sanitize obj has array with validator and convertor ', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'array', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text', optional: true },
                                d: { type: 'text', optional: true },
                                e: { validator: (value) => Validators.isInt(value), convertor: (value) => Convertors.toInt(value) }
                            }
                        }
                    }
                }
            }

            const obj = {
                a: 'test',
                b: [
                    {
                        c: '1',
                        d: '2',
                        e: '3'
                    }
                ]
            }

            const except = {
                a: 'test',
                b: [{
                    c: '1',
                    d: '2',
                    e: 3
                }]
            }

            Types.OBJECT.sanitize(obj, schema).should.be.eql(except);
        });

    })

    describe('required', () => {
        it('should be ok when missing outside field', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: { type: 'text' }
                }
            }

            const obj = { b: 1 }

            try {
                Types.OBJECT.sanitize(obj, schema);
            } catch (error) {
                error.message.should.be.eql(`Missing required property "a"`);
            }
        })

        it('should be ok when missing object filed', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'object', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text' }
                            }
                        }
                    }
                }
            }

            const obj = { a: 1, b: {} }

            try {
                Types.OBJECT.sanitize(obj, schema);
            } catch (error) {
                error.message.should.be.eql(`Missing required property "b.c"`);
            }
        })

        it('should be ok when missing array filed', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'array', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text' }
                            }
                        }
                    }
                }
            }

            const obj = { a: 1, b: {} }

            try {
                Types.OBJECT.sanitize(obj, schema);
            } catch (error) {
                error.message.should.be.eql(`Invalid array value`);
            }
        })

        it('should be ok when missing object filed and user validator and convertor', () => {
            const schema = {
                schema: {
                    a: { type: 'text' },
                    b: {
                        type: 'object', elementSchema: {
                            type: 'object',
                            schema: {
                                c: { type: 'text' },
                                d: { validator: (value) => Validators.isInt(value), convertor: (value) => Convertors.toInt(value) }
                            }
                        }
                    }
                }
            }

            const obj = { a: 1, b: { c: 1 } }

            try {
                Types.OBJECT.sanitize(obj, schema);
            } catch (error) {
                error.message.should.be.eql(`Missing required property "b.d"`);
            }
        })
    });

});

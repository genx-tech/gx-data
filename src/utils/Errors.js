"use strict";

const { Errors: { InvalidArgument, ApplicationError, ExposableError } } = require('@genx/app');
const HttpCode = require('http-status-codes');

class ValidationError extends ExposableError {
    constructor(message, info) {
        super(message, info, HttpCode.BAD_REQUEST, 'E_INVALID_DATA');
    }
} 

class DatabaseError extends ApplicationError {
    constructor(message, info) {
        super(message, info, 'E_DATABASE');
    }
}

exports.InvalidArgument = InvalidArgument;
exports.ValidationError = ValidationError;
exports.DatabaseError = DatabaseError;
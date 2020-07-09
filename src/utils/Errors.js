"use strict";

const { Errors: { InvalidArgument, ExposableError, ApplicationError } } = require('@genx/app');
const HttpCode = require('http-status-codes');

class ValidationError extends ExposableError {
    constructor(message, info) {
        super(message, info, HttpCode.BAD_REQUEST, 'E_INVALID_DATA');
    }
}

class ReferencedNotExistError extends ExposableError {
    constructor(message, info) {
        super(message, info, HttpCode.BAD_REQUEST, 'E_REFERENCED_NOT_EXIST');
    }
}

class DuplicateError extends ExposableError {
    constructor(message, info) {
        super(message, info, HttpCode.BAD_REQUEST, 'E_DUPLICATE');
    }
}

class DatabaseError extends ApplicationError {
    constructor(message, info) {
        super(message, info, HttpCode.INTERNAL_SERVER_ERROR, 'E_DATABASE');
    }
}

exports.InvalidArgument = InvalidArgument;
exports.ValidationError = ValidationError;
exports.ReferencedNotExistError = ReferencedNotExistError;
exports.DuplicateError = DuplicateError;
exports.DatabaseError = DatabaseError;
exports.ApplicationError = ApplicationError;
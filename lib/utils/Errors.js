"use strict";

const {
  Errors: {
    RequestError,
    ApplicationError
  },
  Helpers: {
    withErrorCode
  }
} = require('@genx/app');

exports.RequestError = RequestError;
exports.ApplicationError = ApplicationError;
exports.ValidationError = withErrorCode(RequestError, 'E_INVALID_DATA');
exports.DatabaseError = withErrorCode(ApplicationError, 'E_DATABASE');
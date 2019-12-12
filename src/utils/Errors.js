"use strict";

const { Errors: { InvalidArgument, GeneralError, ApplicationError }, Helpers: { withProps, withArgFill } } = require('@genx/app');

exports.InvalidArgument = InvalidArgument;
exports.ApplicationError = ApplicationError;
exports.ValidationError = withArgFill(withProps(GeneralError, { expose: true }), 2, 'E_INVALID_DATA');
exports.DatabaseError = withArgFill(ApplicationError, 2, 'E_DATABASE');
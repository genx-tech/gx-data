"use strict";

require("source-map-support/register");

const any = require('./any');

const {
  ValidationError
} = require('../utils/Errors');

module.exports = {
  name: 'enum',
  sanitize: (value, info) => {
    if (value == null) return null;
    let raw = value;
    value = (typeof value !== 'string' ? value.toString() : value).trim();

    if (info.values && info.values.indexOf(value) === -1) {
      throw new ValidationError('Invalid enum value', {
        value: raw,
        field: info
      });
    }

    return value;
  },
  defaultValue: 0,
  generate: info => info.values && info.values.length > 0 && info.values[0],
  serialize: value => value,
  qualifiers: any.qualifiers.concat(['values'])
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy90eXBlcy9lbnVtLmpzIl0sIm5hbWVzIjpbImFueSIsInJlcXVpcmUiLCJWYWxpZGF0aW9uRXJyb3IiLCJtb2R1bGUiLCJleHBvcnRzIiwibmFtZSIsInNhbml0aXplIiwidmFsdWUiLCJpbmZvIiwicmF3IiwidG9TdHJpbmciLCJ0cmltIiwidmFsdWVzIiwiaW5kZXhPZiIsImZpZWxkIiwiZGVmYXVsdFZhbHVlIiwiZ2VuZXJhdGUiLCJsZW5ndGgiLCJzZXJpYWxpemUiLCJxdWFsaWZpZXJzIiwiY29uY2F0Il0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLEdBQUcsR0FBR0MsT0FBTyxDQUFDLE9BQUQsQ0FBbkI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQXNCRCxPQUFPLENBQUMsaUJBQUQsQ0FBbkM7O0FBRUFFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjtBQUNiQyxFQUFBQSxJQUFJLEVBQUUsTUFETztBQUdiQyxFQUFBQSxRQUFRLEVBQUUsQ0FBQ0MsS0FBRCxFQUFRQyxJQUFSLEtBQWlCO0FBQ3ZCLFFBQUlELEtBQUssSUFBSSxJQUFiLEVBQW1CLE9BQU8sSUFBUDtBQUVuQixRQUFJRSxHQUFHLEdBQUdGLEtBQVY7QUFDQUEsSUFBQUEsS0FBSyxHQUFHLENBQUMsT0FBT0EsS0FBUCxLQUFpQixRQUFqQixHQUE0QkEsS0FBSyxDQUFDRyxRQUFOLEVBQTVCLEdBQStDSCxLQUFoRCxFQUF1REksSUFBdkQsRUFBUjs7QUFFQSxRQUFJSCxJQUFJLENBQUNJLE1BQUwsSUFBZUosSUFBSSxDQUFDSSxNQUFMLENBQVlDLE9BQVosQ0FBb0JOLEtBQXBCLE1BQStCLENBQUMsQ0FBbkQsRUFBc0Q7QUFDbEQsWUFBTSxJQUFJTCxlQUFKLENBQW9CLG9CQUFwQixFQUEwQztBQUFFSyxRQUFBQSxLQUFLLEVBQUVFLEdBQVQ7QUFBY0ssUUFBQUEsS0FBSyxFQUFFTjtBQUFyQixPQUExQyxDQUFOO0FBQ0g7O0FBRUQsV0FBT0QsS0FBUDtBQUNILEdBZFk7QUFnQmJRLEVBQUFBLFlBQVksRUFBRSxDQWhCRDtBQWtCYkMsRUFBQUEsUUFBUSxFQUFHUixJQUFELElBQVVBLElBQUksQ0FBQ0ksTUFBTCxJQUFlSixJQUFJLENBQUNJLE1BQUwsQ0FBWUssTUFBWixHQUFxQixDQUFwQyxJQUF5Q1QsSUFBSSxDQUFDSSxNQUFMLENBQVksQ0FBWixDQWxCaEQ7QUFvQmJNLEVBQUFBLFNBQVMsRUFBRVgsS0FBSyxJQUFJQSxLQXBCUDtBQXNCYlksRUFBQUEsVUFBVSxFQUFFbkIsR0FBRyxDQUFDbUIsVUFBSixDQUFlQyxNQUFmLENBQXNCLENBQzlCLFFBRDhCLENBQXRCO0FBdEJDLENBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IGFueSA9IHJlcXVpcmUoJy4vYW55Jyk7XG5jb25zdCB7IFZhbGlkYXRpb25FcnJvciB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvRXJyb3JzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIG5hbWU6ICdlbnVtJywgICAgXG5cbiAgICBzYW5pdGl6ZTogKHZhbHVlLCBpbmZvKSA9PiB7XG4gICAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBsZXQgcmF3ID0gdmFsdWU7XG4gICAgICAgIHZhbHVlID0gKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgPyB2YWx1ZS50b1N0cmluZygpIDogdmFsdWUpLnRyaW0oKTtcblxuICAgICAgICBpZiAoaW5mby52YWx1ZXMgJiYgaW5mby52YWx1ZXMuaW5kZXhPZih2YWx1ZSkgPT09IC0xKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKCdJbnZhbGlkIGVudW0gdmFsdWUnLCB7IHZhbHVlOiByYXcsIGZpZWxkOiBpbmZvIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBkZWZhdWx0VmFsdWU6IDAsXG5cbiAgICBnZW5lcmF0ZTogKGluZm8pID0+IGluZm8udmFsdWVzICYmIGluZm8udmFsdWVzLmxlbmd0aCA+IDAgJiYgaW5mby52YWx1ZXNbMF0sXG5cbiAgICBzZXJpYWxpemU6IHZhbHVlID0+IHZhbHVlLFxuXG4gICAgcXVhbGlmaWVyczogYW55LnF1YWxpZmllcnMuY29uY2F0KFtcbiAgICAgICAgJ3ZhbHVlcydcbiAgICBdKVxufTsiXX0=
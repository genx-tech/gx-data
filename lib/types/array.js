"use strict";

require("source-map-support/register");

const {
  _,
  quote
} = require('rk-utils');

const {
  isNothing
} = require('../utils/lang');

const any = require('./any');

const {
  ValidationError
} = require('../utils/Errors');

function sanitize(value, info, i18n, prefix) {
  if (value == null) return null;
  let raw = value;

  if (typeof value === 'string') {
    if (info.csv) {
      return value;
    } else {
      let trimmed = value.trim();

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        value = sanitize(JSON.parse(trimmed), info, i18n, prefix);
      }
    }
  }

  if (Array.isArray(value)) {
    if (info.elementSchema) {
      const Validators = require('../Validators');

      return value.map((a, i) => Validators.validateAny(a, info.elementSchema, i18n, prefix + `[${i}]`));
    }

    return value;
  }

  throw new ValidationError('Invalid array value', {
    value: raw,
    field: info
  });
}

module.exports = {
  name: 'array',
  alias: ['list'],
  sanitize: sanitize,
  defaultValue: [],
  generate: (info, i18n) => [],
  serialize: value => isNothing(value) ? null : JSON.stringify(value),
  qualifiers: any.qualifiers.concat(['csv', 'of', 'elementSchema']),
  toCsv: (data, separator = ',') => data.map(elem => {
    elem = elem.toString();
    return elem.indexOf(separator) != -1 ? quote(elem, '"') : elem;
  }).join(separator)
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy90eXBlcy9hcnJheS5qcyJdLCJuYW1lcyI6WyJfIiwicXVvdGUiLCJyZXF1aXJlIiwiaXNOb3RoaW5nIiwiYW55IiwiVmFsaWRhdGlvbkVycm9yIiwic2FuaXRpemUiLCJ2YWx1ZSIsImluZm8iLCJpMThuIiwicHJlZml4IiwicmF3IiwiY3N2IiwidHJpbW1lZCIsInRyaW0iLCJzdGFydHNXaXRoIiwiZW5kc1dpdGgiLCJKU09OIiwicGFyc2UiLCJBcnJheSIsImlzQXJyYXkiLCJlbGVtZW50U2NoZW1hIiwiVmFsaWRhdG9ycyIsIm1hcCIsImEiLCJpIiwidmFsaWRhdGVBbnkiLCJmaWVsZCIsIm1vZHVsZSIsImV4cG9ydHMiLCJuYW1lIiwiYWxpYXMiLCJkZWZhdWx0VmFsdWUiLCJnZW5lcmF0ZSIsInNlcmlhbGl6ZSIsInN0cmluZ2lmeSIsInF1YWxpZmllcnMiLCJjb25jYXQiLCJ0b0NzdiIsImRhdGEiLCJzZXBhcmF0b3IiLCJlbGVtIiwidG9TdHJpbmciLCJpbmRleE9mIiwiam9pbiJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFBTCxJQUFlQyxPQUFPLENBQUMsVUFBRCxDQUE1Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBZ0JELE9BQU8sQ0FBQyxlQUFELENBQTdCOztBQUNBLE1BQU1FLEdBQUcsR0FBR0YsT0FBTyxDQUFDLE9BQUQsQ0FBbkI7O0FBQ0EsTUFBTTtBQUFFRyxFQUFBQTtBQUFGLElBQXNCSCxPQUFPLENBQUMsaUJBQUQsQ0FBbkM7O0FBRUEsU0FBU0ksUUFBVCxDQUFrQkMsS0FBbEIsRUFBeUJDLElBQXpCLEVBQStCQyxJQUEvQixFQUFxQ0MsTUFBckMsRUFBNkM7QUFDekMsTUFBSUgsS0FBSyxJQUFJLElBQWIsRUFBbUIsT0FBTyxJQUFQO0FBRW5CLE1BQUlJLEdBQUcsR0FBR0osS0FBVjs7QUFFQSxNQUFJLE9BQU9BLEtBQVAsS0FBaUIsUUFBckIsRUFBK0I7QUFDM0IsUUFBSUMsSUFBSSxDQUFDSSxHQUFULEVBQWM7QUFDVixhQUFPTCxLQUFQO0FBQ0gsS0FGRCxNQUVPO0FBQ0gsVUFBSU0sT0FBTyxHQUFHTixLQUFLLENBQUNPLElBQU4sRUFBZDs7QUFDQSxVQUFJRCxPQUFPLENBQUNFLFVBQVIsQ0FBbUIsR0FBbkIsS0FBMkJGLE9BQU8sQ0FBQ0csUUFBUixDQUFpQixHQUFqQixDQUEvQixFQUFzRDtBQUNsRFQsUUFBQUEsS0FBSyxHQUFHRCxRQUFRLENBQUNXLElBQUksQ0FBQ0MsS0FBTCxDQUFXTCxPQUFYLENBQUQsRUFBc0JMLElBQXRCLEVBQTRCQyxJQUE1QixFQUFrQ0MsTUFBbEMsQ0FBaEI7QUFDSDtBQUNKO0FBQ0o7O0FBRUQsTUFBSVMsS0FBSyxDQUFDQyxPQUFOLENBQWNiLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixRQUFJQyxJQUFJLENBQUNhLGFBQVQsRUFBd0I7QUFDcEIsWUFBTUMsVUFBVSxHQUFHcEIsT0FBTyxDQUFDLGVBQUQsQ0FBMUI7O0FBQ0EsYUFBT0ssS0FBSyxDQUFDZ0IsR0FBTixDQUFVLENBQUNDLENBQUQsRUFBSUMsQ0FBSixLQUFVSCxVQUFVLENBQUNJLFdBQVgsQ0FBdUJGLENBQXZCLEVBQTBCaEIsSUFBSSxDQUFDYSxhQUEvQixFQUE4Q1osSUFBOUMsRUFBb0RDLE1BQU0sR0FBSSxJQUFHZSxDQUFFLEdBQW5FLENBQXBCLENBQVA7QUFDSDs7QUFFRCxXQUFPbEIsS0FBUDtBQUNIOztBQUVELFFBQU0sSUFBSUYsZUFBSixDQUFvQixxQkFBcEIsRUFBMkM7QUFBRUUsSUFBQUEsS0FBSyxFQUFFSSxHQUFUO0FBQWNnQixJQUFBQSxLQUFLLEVBQUVuQjtBQUFyQixHQUEzQyxDQUFOO0FBQ0g7O0FBRURvQixNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYkMsRUFBQUEsSUFBSSxFQUFFLE9BRE87QUFHYkMsRUFBQUEsS0FBSyxFQUFFLENBQUUsTUFBRixDQUhNO0FBS2J6QixFQUFBQSxRQUFRLEVBQUVBLFFBTEc7QUFPYjBCLEVBQUFBLFlBQVksRUFBRSxFQVBEO0FBU2JDLEVBQUFBLFFBQVEsRUFBRSxDQUFDekIsSUFBRCxFQUFPQyxJQUFQLEtBQWlCLEVBVGQ7QUFZYnlCLEVBQUFBLFNBQVMsRUFBRzNCLEtBQUQsSUFBV0osU0FBUyxDQUFDSSxLQUFELENBQVQsR0FBbUIsSUFBbkIsR0FBMkJVLElBQUksQ0FBQ2tCLFNBQUwsQ0FBZTVCLEtBQWYsQ0FacEM7QUFjYjZCLEVBQUFBLFVBQVUsRUFBRWhDLEdBQUcsQ0FBQ2dDLFVBQUosQ0FBZUMsTUFBZixDQUFzQixDQUM5QixLQUQ4QixFQUU5QixJQUY4QixFQUc5QixlQUg4QixDQUF0QixDQWRDO0FBb0JiQyxFQUFBQSxLQUFLLEVBQUUsQ0FBQ0MsSUFBRCxFQUFPQyxTQUFTLEdBQUcsR0FBbkIsS0FBMkJELElBQUksQ0FBQ2hCLEdBQUwsQ0FDOUJrQixJQUFJLElBQUk7QUFBRUEsSUFBQUEsSUFBSSxHQUFHQSxJQUFJLENBQUNDLFFBQUwsRUFBUDtBQUF3QixXQUFPRCxJQUFJLENBQUNFLE9BQUwsQ0FBYUgsU0FBYixLQUEyQixDQUFDLENBQTVCLEdBQWdDdkMsS0FBSyxDQUFDd0MsSUFBRCxFQUFPLEdBQVAsQ0FBckMsR0FBbURBLElBQTFEO0FBQWlFLEdBRHJFLEVBRTVCRyxJQUY0QixDQUV2QkosU0FGdUI7QUFwQnJCLENBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IHsgXywgcXVvdGUgfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgYW55ID0gcmVxdWlyZSgnLi9hbnknKTtcbmNvbnN0IHsgVmFsaWRhdGlvbkVycm9yIH0gPSByZXF1aXJlKCcuLi91dGlscy9FcnJvcnMnKTtcblxuZnVuY3Rpb24gc2FuaXRpemUodmFsdWUsIGluZm8sIGkxOG4sIHByZWZpeCkge1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICAgIGxldCByYXcgPSB2YWx1ZTtcblxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHRyaW1tZWQgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKCdbJykgJiYgdHJpbW1lZC5lbmRzV2l0aCgnXScpKSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBzYW5pdGl6ZShKU09OLnBhcnNlKHRyaW1tZWQpLCBpbmZvLCBpMThuLCBwcmVmaXgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIGlmIChpbmZvLmVsZW1lbnRTY2hlbWEpIHtcbiAgICAgICAgICAgIGNvbnN0IFZhbGlkYXRvcnMgPSByZXF1aXJlKCcuLi9WYWxpZGF0b3JzJyk7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUubWFwKChhLCBpKSA9PiBWYWxpZGF0b3JzLnZhbGlkYXRlQW55KGEsIGluZm8uZWxlbWVudFNjaGVtYSwgaTE4biwgcHJlZml4ICsgYFske2l9XWApKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgdGhyb3cgbmV3IFZhbGlkYXRpb25FcnJvcignSW52YWxpZCBhcnJheSB2YWx1ZScsIHsgdmFsdWU6IHJhdywgZmllbGQ6IGluZm8gfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIG5hbWU6ICdhcnJheScsXG5cbiAgICBhbGlhczogWyAnbGlzdCcgXSxcblxuICAgIHNhbml0aXplOiBzYW5pdGl6ZSxcblxuICAgIGRlZmF1bHRWYWx1ZTogW10sXG5cbiAgICBnZW5lcmF0ZTogKGluZm8sIGkxOG4pID0+IChbXSksXG5cbiAgICAvL3doZW4gaXQncyBjc3YsIHNob3VsZCBjYWxsIHRvQ3N2IGluIGRyaXZlciBzcGVjaWZpYyBFbnRpdHlNb2RlbFxuICAgIHNlcmlhbGl6ZTogKHZhbHVlKSA9PiBpc05vdGhpbmcodmFsdWUpID8gbnVsbCA6ICBKU09OLnN0cmluZ2lmeSh2YWx1ZSksXG5cbiAgICBxdWFsaWZpZXJzOiBhbnkucXVhbGlmaWVycy5jb25jYXQoW1xuICAgICAgICAnY3N2JyxcbiAgICAgICAgJ29mJyxcbiAgICAgICAgJ2VsZW1lbnRTY2hlbWEnXG4gICAgXSksXG5cbiAgICB0b0NzdjogKGRhdGEsIHNlcGFyYXRvciA9ICcsJykgPT4gZGF0YS5tYXAoXG4gICAgICAgIGVsZW0gPT4geyBlbGVtID0gZWxlbS50b1N0cmluZygpOyByZXR1cm4gZWxlbS5pbmRleE9mKHNlcGFyYXRvcikgIT0gLTEgPyBxdW90ZShlbGVtLCAnXCInKSA6IGVsZW07IH1cbiAgICAgICAgKS5qb2luKHNlcGFyYXRvcilcbn07Il19
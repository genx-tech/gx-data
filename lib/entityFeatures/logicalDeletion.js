"use strict";

require("source-map-support/register");

const Rules = require('../enum/Rules');

const {
  mergeCondition
} = require('../utils/lang');

const Generators = require('../Generators');

const {
  _
} = require("rk-utils");

module.exports = {
  [Rules.RULE_BEFORE_FIND]: (feature, entityModel, context) => {
    let findOptions = context.options;

    if (!findOptions.$includeDeleted) {
      findOptions.$query = mergeCondition(findOptions.$query, {
        [feature.field]: {
          $ne: feature.value
        }
      });
    }

    return true;
  },
  [Rules.RULE_BEFORE_DELETE]: async (feature, entityModel, context) => {
    let options = context.options;

    if (!options.$physicalDeletion) {
      let {
        field,
        value,
        timestampField
      } = feature;
      let updateTo = {
        [field]: value
      };

      if (timestampField) {
        updateTo[timestampField] = Generators.default(entityModel.meta.fields[timestampField], context.i18n);
      }

      const updateOpts = {
        $query: options.$query,
        $retrieveUpdated: options.$retrieveDeleted,
        $bypassReadOnly: new Set([field, timestampField]),
        ..._.pick(options, ['$retrieveDeleted', '$retrieveDbResult'])
      };
      context.return = await entityModel._update_(updateTo, updateOpts, context.connOptions, context.forSingleRecord);

      if (options.$retrieveDbResult) {
        context.rawOptions.$result = updateOpts.$result;
      }

      return false;
    }

    return true;
  }
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9lbnRpdHlGZWF0dXJlcy9sb2dpY2FsRGVsZXRpb24uanMiXSwibmFtZXMiOlsiUnVsZXMiLCJyZXF1aXJlIiwibWVyZ2VDb25kaXRpb24iLCJHZW5lcmF0b3JzIiwiXyIsIm1vZHVsZSIsImV4cG9ydHMiLCJSVUxFX0JFRk9SRV9GSU5EIiwiZmVhdHVyZSIsImVudGl0eU1vZGVsIiwiY29udGV4dCIsImZpbmRPcHRpb25zIiwib3B0aW9ucyIsIiRpbmNsdWRlRGVsZXRlZCIsIiRxdWVyeSIsImZpZWxkIiwiJG5lIiwidmFsdWUiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCIkcGh5c2ljYWxEZWxldGlvbiIsInRpbWVzdGFtcEZpZWxkIiwidXBkYXRlVG8iLCJkZWZhdWx0IiwibWV0YSIsImZpZWxkcyIsImkxOG4iLCJ1cGRhdGVPcHRzIiwiJHJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCIkYnlwYXNzUmVhZE9ubHkiLCJTZXQiLCJwaWNrIiwicmV0dXJuIiwiX3VwZGF0ZV8iLCJjb25uT3B0aW9ucyIsImZvclNpbmdsZVJlY29yZCIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmF3T3B0aW9ucyIsIiRyZXN1bHQiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsS0FBSyxHQUFHQyxPQUFPLENBQUMsZUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBcUJELE9BQU8sQ0FBQyxlQUFELENBQWxDOztBQUNBLE1BQU1FLFVBQVUsR0FBR0YsT0FBTyxDQUFDLGVBQUQsQ0FBMUI7O0FBQ0EsTUFBTTtBQUFFRyxFQUFBQTtBQUFGLElBQVFILE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQU9BSSxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYixHQUFDTixLQUFLLENBQUNPLGdCQUFQLEdBQTBCLENBQUNDLE9BQUQsRUFBVUMsV0FBVixFQUF1QkMsT0FBdkIsS0FBbUM7QUFDekQsUUFBSUMsV0FBVyxHQUFHRCxPQUFPLENBQUNFLE9BQTFCOztBQUNBLFFBQUksQ0FBQ0QsV0FBVyxDQUFDRSxlQUFqQixFQUFrQztBQUM5QkYsTUFBQUEsV0FBVyxDQUFDRyxNQUFaLEdBQXFCWixjQUFjLENBQUNTLFdBQVcsQ0FBQ0csTUFBYixFQUFxQjtBQUFFLFNBQUNOLE9BQU8sQ0FBQ08sS0FBVCxHQUFpQjtBQUFFQyxVQUFBQSxHQUFHLEVBQUVSLE9BQU8sQ0FBQ1M7QUFBZjtBQUFuQixPQUFyQixDQUFuQztBQUNIOztBQUVELFdBQU8sSUFBUDtBQUNILEdBUlk7QUFTYixHQUFDakIsS0FBSyxDQUFDa0Isa0JBQVAsR0FBNEIsT0FBT1YsT0FBUCxFQUFnQkMsV0FBaEIsRUFBNkJDLE9BQTdCLEtBQXlDO0FBQ2pFLFFBQUlFLE9BQU8sR0FBR0YsT0FBTyxDQUFDRSxPQUF0Qjs7QUFDQSxRQUFJLENBQUNBLE9BQU8sQ0FBQ08saUJBQWIsRUFBZ0M7QUFDNUIsVUFBSTtBQUFFSixRQUFBQSxLQUFGO0FBQVNFLFFBQUFBLEtBQVQ7QUFBZ0JHLFFBQUFBO0FBQWhCLFVBQW1DWixPQUF2QztBQUNBLFVBQUlhLFFBQVEsR0FBRztBQUNYLFNBQUNOLEtBQUQsR0FBU0U7QUFERSxPQUFmOztBQUlBLFVBQUlHLGNBQUosRUFBb0I7QUFDaEJDLFFBQUFBLFFBQVEsQ0FBQ0QsY0FBRCxDQUFSLEdBQTJCakIsVUFBVSxDQUFDbUIsT0FBWCxDQUFtQmIsV0FBVyxDQUFDYyxJQUFaLENBQWlCQyxNQUFqQixDQUF3QkosY0FBeEIsQ0FBbkIsRUFBNERWLE9BQU8sQ0FBQ2UsSUFBcEUsQ0FBM0I7QUFDSDs7QUFFRCxZQUFNQyxVQUFVLEdBQUc7QUFDZlosUUFBQUEsTUFBTSxFQUFFRixPQUFPLENBQUNFLE1BREQ7QUFFZmEsUUFBQUEsZ0JBQWdCLEVBQUVmLE9BQU8sQ0FBQ2dCLGdCQUZYO0FBR2ZDLFFBQUFBLGVBQWUsRUFBRSxJQUFJQyxHQUFKLENBQVEsQ0FBQ2YsS0FBRCxFQUFRSyxjQUFSLENBQVIsQ0FIRjtBQUlmLFdBQUdoQixDQUFDLENBQUMyQixJQUFGLENBQU9uQixPQUFQLEVBQWdCLENBQUUsa0JBQUYsRUFBc0IsbUJBQXRCLENBQWhCO0FBSlksT0FBbkI7QUFPQUYsTUFBQUEsT0FBTyxDQUFDc0IsTUFBUixHQUFpQixNQUFNdkIsV0FBVyxDQUFDd0IsUUFBWixDQUFxQlosUUFBckIsRUFBK0JLLFVBQS9CLEVBQTJDaEIsT0FBTyxDQUFDd0IsV0FBbkQsRUFBZ0V4QixPQUFPLENBQUN5QixlQUF4RSxDQUF2Qjs7QUFFQSxVQUFJdkIsT0FBTyxDQUFDd0IsaUJBQVosRUFBK0I7QUFDM0IxQixRQUFBQSxPQUFPLENBQUMyQixVQUFSLENBQW1CQyxPQUFuQixHQUE2QlosVUFBVSxDQUFDWSxPQUF4QztBQUNIOztBQUVELGFBQU8sS0FBUDtBQUNIOztBQUVELFdBQU8sSUFBUDtBQUNIO0FBdENZLENBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuY29uc3QgeyBtZXJnZUNvbmRpdGlvbiB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4uL0dlbmVyYXRvcnMnKTtcbmNvbnN0IHsgXyB9ID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuXG4vKipcbiAqIEEgcnVsZSBzcGVjaWZpZXMgdGhlIGVudGl0eSB3aWxsIG5vdCBiZSBkZWxldGVkIHBoeXNpY2FsbHkuXG4gKiBAbW9kdWxlIEVudGl0eUZlYXR1cmVSdW50aW1lX0xvZ2ljYWxEZWxldGlvblxuICovXG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIFtSdWxlcy5SVUxFX0JFRk9SRV9GSU5EXTogKGZlYXR1cmUsIGVudGl0eU1vZGVsLCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGxldCBmaW5kT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcbiAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRxdWVyeSA9IG1lcmdlQ29uZGl0aW9uKGZpbmRPcHRpb25zLiRxdWVyeSwgeyBbZmVhdHVyZS5maWVsZF06IHsgJG5lOiBmZWF0dXJlLnZhbHVlIH0gfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIFtSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEVdOiBhc3luYyAoZmVhdHVyZSwgZW50aXR5TW9kZWwsIGNvbnRleHQpID0+IHtcbiAgICAgICAgbGV0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG4gICAgICAgIGlmICghb3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgbGV0IHsgZmllbGQsIHZhbHVlLCB0aW1lc3RhbXBGaWVsZCB9ID0gZmVhdHVyZTtcbiAgICAgICAgICAgIGxldCB1cGRhdGVUbyA9IHtcbiAgICAgICAgICAgICAgICBbZmllbGRdOiB2YWx1ZVxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKHRpbWVzdGFtcEZpZWxkKSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlVG9bdGltZXN0YW1wRmllbGRdID0gR2VuZXJhdG9ycy5kZWZhdWx0KGVudGl0eU1vZGVsLm1ldGEuZmllbGRzW3RpbWVzdGFtcEZpZWxkXSwgY29udGV4dC5pMThuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgdXBkYXRlT3B0cyA9IHsgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiBvcHRpb25zLiRxdWVyeSwgXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlVXBkYXRlZDogb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkLCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAkYnlwYXNzUmVhZE9ubHk6IG5ldyBTZXQoW2ZpZWxkLCB0aW1lc3RhbXBGaWVsZF0pLFxuICAgICAgICAgICAgICAgIC4uLl8ucGljayhvcHRpb25zLCBbICckcmV0cmlldmVEZWxldGVkJywgJyRyZXRyaWV2ZURiUmVzdWx0JyBdKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IGVudGl0eU1vZGVsLl91cGRhdGVfKHVwZGF0ZVRvLCB1cGRhdGVPcHRzLCBjb250ZXh0LmNvbm5PcHRpb25zLCBjb250ZXh0LmZvclNpbmdsZVJlY29yZCk7XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSB1cGRhdGVPcHRzLiRyZXN1bHQ7ICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG59OyJdfQ==
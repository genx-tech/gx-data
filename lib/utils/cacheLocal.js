"use strict";

require("source-map-support/register");

exports.cacheLocal = (bag, key, fetcher) => {
  const cachedObject = bag[key];

  if (!cachedObject) {
    return bag[key] = fetcher();
  }

  return cachedObject;
};

exports.cacheLocal_ = async (bag, key, fetcher_) => {
  const cachedObject = bag[key];

  if (!cachedObject) {
    return bag[key] = await fetcher_();
  }

  return cachedObject;
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9jYWNoZUxvY2FsLmpzIl0sIm5hbWVzIjpbImV4cG9ydHMiLCJjYWNoZUxvY2FsIiwiYmFnIiwia2V5IiwiZmV0Y2hlciIsImNhY2hlZE9iamVjdCIsImNhY2hlTG9jYWxfIiwiZmV0Y2hlcl8iXSwibWFwcGluZ3MiOiI7Ozs7QUFBQUEsT0FBTyxDQUFDQyxVQUFSLEdBQXFCLENBQUNDLEdBQUQsRUFBTUMsR0FBTixFQUFXQyxPQUFYLEtBQXVCO0FBQ3hDLFFBQU1DLFlBQVksR0FBR0gsR0FBRyxDQUFDQyxHQUFELENBQXhCOztBQUNBLE1BQUksQ0FBQ0UsWUFBTCxFQUFtQjtBQUNmLFdBQVFILEdBQUcsQ0FBQ0MsR0FBRCxDQUFILEdBQVdDLE9BQU8sRUFBMUI7QUFDSDs7QUFFRCxTQUFPQyxZQUFQO0FBQ0gsQ0FQRDs7QUFTQUwsT0FBTyxDQUFDTSxXQUFSLEdBQXNCLE9BQU9KLEdBQVAsRUFBWUMsR0FBWixFQUFpQkksUUFBakIsS0FBOEI7QUFDaEQsUUFBTUYsWUFBWSxHQUFHSCxHQUFHLENBQUNDLEdBQUQsQ0FBeEI7O0FBQ0EsTUFBSSxDQUFDRSxZQUFMLEVBQW1CO0FBQ2YsV0FBUUgsR0FBRyxDQUFDQyxHQUFELENBQUgsR0FBVyxNQUFNSSxRQUFRLEVBQWpDO0FBQ0g7O0FBRUQsU0FBT0YsWUFBUDtBQUNILENBUEQiLCJzb3VyY2VzQ29udGVudCI6WyJleHBvcnRzLmNhY2hlTG9jYWwgPSAoYmFnLCBrZXksIGZldGNoZXIpID0+IHtcbiAgICBjb25zdCBjYWNoZWRPYmplY3QgPSBiYWdba2V5XTtcbiAgICBpZiAoIWNhY2hlZE9iamVjdCkge1xuICAgICAgICByZXR1cm4gKGJhZ1trZXldID0gZmV0Y2hlcigpKTtcbiAgICB9XG5cbiAgICByZXR1cm4gY2FjaGVkT2JqZWN0O1xufTtcblxuZXhwb3J0cy5jYWNoZUxvY2FsXyA9IGFzeW5jIChiYWcsIGtleSwgZmV0Y2hlcl8pID0+IHtcbiAgICBjb25zdCBjYWNoZWRPYmplY3QgPSBiYWdba2V5XTtcbiAgICBpZiAoIWNhY2hlZE9iamVjdCkge1xuICAgICAgICByZXR1cm4gKGJhZ1trZXldID0gYXdhaXQgZmV0Y2hlcl8oKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNhY2hlZE9iamVjdDtcbn07Il19
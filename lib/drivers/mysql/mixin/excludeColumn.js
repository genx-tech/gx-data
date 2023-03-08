'use strict';

require("source-map-support/register");
const {
  _
} = require('@genx/july');
function formatExcludeArray(excludes) {
  const projectionObj = {
    $default: []
  };
  excludes.forEach(x => {
    if (x.includes('.')) {
      const items = x.split('.');
      const col = items.pop();
      const assKey = items.join('.');
      if (projectionObj[assKey]) {
        projectionObj[assKey].push(col);
      } else {
        projectionObj[assKey] = [col];
      }
    } else {
      projectionObj.$default.push(x);
    }
  });
  return projectionObj;
}
function getModelFields(EF, meta, associations) {
  const modelName = meta.associations[associations[0]].entity;
  if (associations.length === 1) {
    const fields = EF.db.model(modelName).meta.fields;
    return Object.keys(fields);
  }
  meta = EF.db.model(modelName).meta;
  getModelFields(EF, meta, associations.shift());
}
module.exports = {
  excludeColumn: function (EF, meta, findOptions) {
    if (findOptions) {
      const {
        $projection,
        $association
      } = findOptions;
      if ($projection && $projection.$exclude && typeof $projection.$exclude === 'object' && Array.isArray($projection.$exclude)) {
        if (!$association) {
          findOptions.$projection = _.difference(Object.keys(meta.fields), $projection.$exclude);
        } else {
          if (Array.isArray($association)) {
            const excludeObj = formatExcludeArray($projection.$exclude);
            const projectionColumns = [];
            $association.forEach(item => {
              const columnArray = excludeObj[item];
              if (!columnArray) {
                projectionColumns.push(`${item}.*`);
              } else {
                if (!columnArray.includes('*')) {
                  projectionColumns.push(..._.difference(getModelFields(EF, meta, item.split('.')), columnArray).map(x => `${item}.${x}`));
                }
              }
            });
            projectionColumns.push(..._.difference(Object.keys(meta.fields), excludeObj.$default));
            findOptions.$projection = projectionColumns;
          }
        }
      }
    }
  }
};
//# sourceMappingURL=excludeColumn.js.map
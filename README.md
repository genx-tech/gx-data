# Entity Model

Updated on 27/08/2020

## Static members

* db - instance of the @genx/data/DbModel class
    * app - The owner app (instance of @genx/app/ServiceContainer) 
    * connector - The driver-specific db connector
    * driver - Getter for the dbms name, e.g. mysql or mongodb
    * i18n - Internationalization
    * model(name) - Getter for entity model
    * entitiesOfType(subClass) - Get an array of entities with one of the subClasses as specified
    * async retry_(closure(ok, failed), [times], [interval]) - Try several times (default: 3) to do a transaction in case rollbacked due to competition
    * async doTransaction_(closure({connection}), errorHandler(error)) - Wrap a transaction block  

```
  // Model usage
  
  // inside a entity model
  let User = this.db.model('User');
  
  // inside a controll or anywhere the app instance is applicable
  let User = app.db('dbName').model('User');
  
  // call CRUD
  await User.create_(...);
  
  
  // Transaction
  return this.db.doTransaction_(async (connOpts) => {
      
      let ret = await this.sendToGroup_(senderId, group.id, msg, connOpts);
      await this.sendToGroup_(senderId, group.peer, msg, connOpts);

      return ret;
  });     
  
  
  // Retry and transaction combination usage
  
  return this.db.retry_('transaction name for logging', async (ok, failed) => {
      return this.db.doTransaction_(async (connOpts) => {
          //...operations need to compute
          // result set
          
          return ok(result);
      }, failed);
  });
```

* meta - Metadata about the enttiy
    * name 
    * keyField
    * schemaName
    * fields
    * features
    * uniqueKeys
    * indexes
    * associations
    * fieldDependencies

* i18n - I18n object


## Customize entity model

Write a mixer for customizing a entity model

```
module.exports = Base => class extends Base {
    static async getStreetTypes_() {
        const streetTypes = require('../../data/streetTypes.json');
        return streetTypes;            
    }
};
```

### Triggers for the mixer

* beforeCreate_
* beforeUpdate_
* beforeUpdateMany_
* beforeDelete_
* beforeDeleteMany_

* afterCreate_
* afterUpdate_
* afterUpdateMany_
* afterDelete_
* afterDeleteMany_

## CRUD operations (static method members)

* async findOne_(findOptions, connOptions) 
* async findAll_(findOptions, connOptions) 
* async create_(data, createOptions, connOptions) 
* async updateOne_(data, updateOptions, connOptions) 
* async updateMany_(data, updateOptions, connOptions) 
* async replaceOne_(data, updateOptions, connOptions) 
* async deleteOne_(deleteOptions, connOptions) 
* async deleteMany_(deleteOptions, connOptions) 
* async cached_(key, associations, connOptions)

## Operation options

* $projection
```
$projection: [ { type: 'function', name: 'MAX', alias: 'max', args: ['order'] } ],

$projection: [this.db.connector.queryCount()],

$projection: [
    '*',            
    'bookableResources.type',
    {
        alias: 'bookableResources.count',
        type: 'function', 
        name: 'COUNT',
        prefix: 'DISTINCT',
        args: [ 'bookableResources.id' ]
    }
],  

```
* $association - No trailing (s).
* $relationships - Transformed from raw $association, used by the EntityModel internally 
* $query - Query condition
* $variables - Variables to interpolate into query condition, will be passed on to associated operation
* $features - Custom feature options override
* $orderBy - Order by condition, map of column to ascend?
* $groupBy - Group by condition
```
const numDeals = await this.findAll_({
    $projection: ["status", this.db.connector.queryCount(null, "status")],
    $query: {
        agent: agentId,
        $or_0: this.db.connector.nullOrIs("fellOver", false),
    },
    $groupBy: "status",
});
```
* $offset
* $limit
* $totalCount - Returns total record count when used with $limit, should provide the distinct field name 
* $includeDeleted - {boolean}, for find only, include logical deleted records
* $skipOrm - {boolean}
* $objectMapper - {string} Object mapper , flat or hiarachy (not used yet)
* $custom - User defined operation control data, used by user program only and will be passed on to associated operation
* $retrieveCreated - {findOptions|boolean}
* $retrieveUpdated - {findOptions|boolean}
* $retrieveActualUpdated - {findOptions|boolean}, for updateOne_ only, retrieve only when the row is actually updated
* $retrieveNotUpdate - {findOptions|boolean}, for updateOne_ only, retrieve only when the row is not actually updated
* $retrieveDeleted - {findOptions|boolean}
* $retrieveExisting
* $retrieveDbResult - return the original db result through options.$result
* $bypassReadOnly - Internal option, cannot be set by user
* $physicalDeletion - {boolean}
* $existing
* $requireSplitColumns - {boolean}, for udpate only, will be auto set while input has function or expression
* $bypassEnsureUnique
* $toDictionary
* $migration - {boolean}, set by migration program, will be passed on to associated operation
* $upsert - {boolean|object}, for create_ only, insert or update on duplicate, pass object if insert extra data
* $nestedKeyGetter - a getter function to transform the key of nested object, default as ':'+anchor for mysql
* $skipUpdateTracking - Skip update tracking, to be replaced by $skipFeatures
* $skipModifiers - Skip field modifiers, usually set upon importing backup data which are exported from db and already been processed by modifiers before


## Connector options
* insertIgnore - {boolean}, for create only
* connection - for transactions, reused the transactional session

-----




## operation context [for @genx/data dev only]

There are predefined context properties which can be accessed in an entity operation as listed below.

* operation - 'create/retrieve/update/delete'
* raw - Raw input data. 
* latest - Validated and sanitized data.
* existing - Existing data from database.
* i18n - I18n object.
* connector - Existing connector for chained operation.
* result - Operation result.
* return - Data to return, if retrieveCreated or retrieveUpdated or retrieveDeleted is true, return will be the just create/updated/deleted data.
* entities - Access other entity models in the same schema
* schemas - Access other schema models in the same application
* state - Current request state

## operation helper [for @genx/data dev only]

* queryFunction
* queryBinExpr
* queryColumn

## operation execution sequence [for @genx/data dev only]

1. prepare query & context
2. sub-class before hooks
3. wrap in transaction-safe closure
4. pre-process data
5. features before hooks
6. driver-specific pre-process
7. execute the operation
8. driver-specific post-process
9. store query key 
10. features after hooks
11. end transaction-safe closure
12. sub-class after hooks

## known issues

* retrieveUpdated - The previous query maybe affected by parrallel updating
* retrieveDeleted - The deleted returned may differ from actual deletion (when data changes between find and delete)

## change logs since Apr 2020

1. Add -1 for descent sorting for mysql connector, and now both false and -1 for ORDER BY DESC.



# Entity Model

Updated on 16/02/2022

## Static members

-   db - instance of the @genx/data/DbModel class
    -   app - The owner app (instance of @genx/app/ServiceContainer)
    -   connector - The driver-specific db connector
    -   driver - Getter for the dbms name, e.g. mysql or mongodb
    -   i18n - Internationalization
    -   model(name) - Getter for entity model
    -   entitiesOfType(subClass) - Get an array of entities with one of the subClasses as specified
    -   async retry_(closure(ok, failed), [times], [interval]) - Try several times (default: 3) to do a transaction in case rollbacked due to competition
    -   async doTransaction_(closure({connection}), errorHandler(error)) - Wrap a transaction block

```javascript
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

  // Use SQL expression

```

-   meta - Metadata about the enttiy

    -   name
    -   keyField
    -   schemaName
    -   fields
    -   features
    -   uniqueKeys
    -   indexes
    -   associations
    -   fieldDependencies

-   i18n - I18n object

## Customize entity model

Write a mixer for customizing a entity model

```javascript
module.exports = Base => class extends Base {
    static async getStreetTypes_() {
        const streetTypes = require('../../data/streetTypes.json');
        return streetTypes;
    }
};
```

### Triggers 

-   beforeCreate_
-   beforeUpdate_
-   beforeUpdateMany_
-   beforeDelete_
-   beforeDeleteMany_

-   afterCreate_
-   afterUpdate_
-   afterUpdateMany_
-   afterDelete_
-   afterDeleteMany_

## CRUD operations (static method members)

-   async findOne_(findOptions, connOptions)

-   async findAll_(findOptions, connOptions)

-   async create_(data, createOptions, connOptions)

-   async updateOne_(data, updateOptions, connOptions)

-   async updateMany_(data, updateOptions, connOptions)

-   async replaceOne_(data, updateOptions, connOptions)

-   async deleteOne_(deleteOptions, connOptions)

-   async deleteMany_(deleteOptions, connOptions)

-   async cached_(key, associations, connOptions)

-   async retryCreateOnDuplicate_(dataGenerator_, maxRery, createOptions, connOptions)
    - Regenerate creation data and try again if duplicate record exists

-   async ensureFields_(entityObject, fields)
    - Ensure the entity object containing required fields, if not, it will automatically fetched from db and return.

## Helper methods

-   fieldSchema(fieldName, options), returns the field schema for input validation, options can be used to override the default auto generated schema
    - $addEnumValues, for enum values to add some fake value which not accepted by db but can be consumed by business logic, e.g. all, none
    - $orAsArray, accept an array of the specified type

```javascript
    // returns a schema object which can be used by @genx/data Types sanitizer
    Message.fieldSchema('type', { optional: true, default: 'info' });
```    

-   inputSchema(inputSetName, options), returns an input schema object 

-   assocFrom(extraArray, fields), returns a unique array combine the extraArray and the associations inferred from fields

-   getUniqueKeyValuePairsFrom(data)

-   getUniqueKeyFieldsFrom(data)

## Operation options

-   $projection

```javascript
$projection: [ { type: 'function', name: 'MAX', alias: 'max', args: ['order'] } ],

$projection: [ this.db.connector.queryCount() ],

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

-   $association - No trailing (s).

```javascript
// use an associated name inferred by foreign key
const association = [ 'person' ];

// use an explicit joining between two entities without connection by foreign key
{
    "$query": {
        "ownerUser.mobile": "+61412345673"
    },
    "$bypassEnsureUnique": true,
    "$association": [
        {
            "entity": "user",
            "alias": "ownerUser",
            "output": true,
            "on": {
                "id": {
                    "oorType": "ColumnReference",
                    "name": "ownerUser.person"
                }
            }
        }
    ]
}

// complex usage with dynamic result selected
const association = [
    "listing.prices",
    "address",
    "propertyTypes",
    {
        "entity": "resource",
        "alias": "resource",
        "output": true,
        "on": {
            "listing.resourceGroup": {
                "oorType": "ColumnReference",
                "name": "resource.group"
            }
        },
        "dataset": {
            $query: {
                "mediaTag": "LOGO"
            }
        }
    }
];
```

-   $relationships - Transformed from raw $association, used by the EntityModel internally
-   $query - Query condition

    * Non-KV-Pair query
```javascript
// See Lang helper for more details
$query = Lang.$func('FIND_IN_SET', category, Lang.$col('categories'));

// Complex usage 1
$query = { // `status` = 'published' AND FIND_IN_SET(category, `categories`)
    $and: [
        {
            status: 'published'
        },
        Lang.$func('FIND_IN_SET', category, Lang.$col('categories'));
    ]
}

// Complex usage 2
$query = { // `status` = 'published' OR FIND_IN_SET(category, `categories`)
    $or: [
        {
            status: 'published'
        },
        Lang.$func('FIND_IN_SET', category, Lang.$col('categories'));
    ]
}
```

-   $variables - Variables to interpolate into query condition, will be passed on to associated operation
-   $features - Custom feature options override
-   $orderBy - Order by condition, map of column to ascend?
-   $groupBy - Group by condition

```javascript
const numDeals = await this.findAll_({
    $projection: ["status", this.db.connector.queryCount(null, "status")],
    $query: {
        agent: agentId,
        $or_0: this.db.connector.nullOrIs("fellOver", false),
    },
    $groupBy: "status",
});

```

-   $offset
-   $limit
-   $totalCount - Returns total record count when used with $limit, should provide the distinct field name

    - Used without association or with reference association which only joins record, just use $totalCount: true
    ```javascript
        const { totalItems /* integer */, items /* array */ } = await findAll_({
            '$query': { template: 1 },
            '$association': [ 'template' ],
            '$orderBy': { createdAt: false },
            '$totalCount': true,
            '$limit': 5,
            '$offset': 0    
        });
    ```

    - Used without association which may joins multiple records, should specify a unqiue field for preventing from counting duplicate records brought by joining, **otherwise the returned totalItems may include duplicate records**
    ```javascript
        const { totalItems /* integer */, items /* array */ } = await findAll_({
            '$query': { template: 1 },
            '$association': [ 'tags.tag', 'template' ],
            '$orderBy': { createdAt: false },
            '$totalCount': 'id',
            '$limit': 5,
            '$offset': 0    
        });
    ```

-   $includeDeleted - {boolean}, for find only, include logical deleted records
-   $skipOrm - {boolean}
-   $objectMapper - {string} Object mapper , flat or hiarachy (not used yet)
-   $custom - User defined operation control data, used by user program only and will be passed on to associated operation
-   $retrieveCreated - {findOptions|boolean}
-   $retrieveUpdated - {findOptions|boolean}
-   $retrieveActualUpdated - {findOptions|boolean}, for updateOne_ only, retrieve only when the row is actually updated
-   $retrieveNotUpdate - {findOptions|boolean}, for updateOne_ only, retrieve only when the row is not actually updated
-   $retrieveDeleted - {findOptions|boolean}
-   $retrieveExisting
-   $retrieveDbResult - return the original db result through options.$result
-   $bypassReadOnly - Internal option, cannot be set by user
-   $physicalDeletion - {boolean}
-   $existing
-   $requireSplitColumns - {boolean}, for udpate only, will be auto set while input has function or expression
-   $bypassEnsureUnique
-   $toDictionary
-   $migration - {boolean}, set by migration program, will be passed on to associated operation
-   $upsert - {boolean|object}, for create_ only, insert or update on duplicate, pass object if insert extra data
-   $nestedKeyGetter - a getter function to transform the key of nested object, default as ':'+anchor for mysql
-   $skipFeatures - an array of features to skip
-   $skipModifiers - Skip field modifiers, usually set upon importing backup data which are exported from db and already been processed by modifiers before
-   $transformer - Transform results before returning

```javascript
$transformer: {
    user: [ '$$CURRENT.:user', { $pick: [ 'email' ] } ],
    agency: [ '$$CURRENT.:agency', { $pick: [ 'name' ] } ]
}
```

-   $dryRun - for create only, just do the preparation check and skip the actual db creation call
-   $key - specify the primary key field of and main query table for complex SQL situation, e.g. pagination


## Complex usage

### Using functions in projection

```javascript
{
    $projection: [
        News.meta.keyField,
        {
            type: 'function',
            name: 'ROW_NUMBER',
            alias: 'row_num',
            args: [], // ROW_NUMBER()
            over: {
                $partitionBy: 'reference',
                $orderBy: News.meta.keyField,
            }, // ROW_NUMBER() OVER(PARTITION BY `reference` ORDER BY id)
        },
    ]
}
```

### Using function as the value of a field to update

```javascript
const updated = await this.updateOne_({ // data to update
    score: Lang.$expr(Lang.$col('score'), '+', scoreDelta) // `score` = `score` + scoreDelta
}, { 
    $query: { // where
        id: opportunity.id 
    }, 
    $retrieveUpdated: true // select the updated record after update finished
}, connOpts);
```

### Using expressions in query

```javascript
const queryObj = {
    $query: {
        status: 'published',
        $and: [ // `reference` IS NOT NULL AND (TRIM(`reference`) != '')
            {
                reference: { $exist: true }
            },
            Lang.$expr(Lang.$func('TRIM', Lang.$col('reference')), '!=', '')
        ]
    },
    $orderBy: {
        createdAt: false
    }
};
```

## Connector options

-   insertIgnore - {boolean}, for create only
-   connection - for transactions, reused the transactional session
-   returnUpdated - return the exact updated rows id [supplement for retrieveUpdated]

### Connector

-   aggregate_ - [new feature] aggregation by pipeline of stages

MySQLConnector

```
const result = await connector.aggregate_('t3' /* table name of starting query */, [
    { // stage 0, select from t3
        $projection: [
            'c',
            {
                type: 'function',
                name: 'COUNT',
                alias: 'count',
                args: ['c'],
            },
        ],
        $groupBy: 'c',
    },
    { // stage 1, select from stage 0
        $projection: [
            'c',
            'count',
            {
                type: 'function',
                name: 'SUM',
                alias: 'cumulative',
                args: ['count'],
                over: {
                    $orderBy: 'c',
                },
            },
        ],
    },
]);
```

--- 

## operation context [for @genx/data dev only]

There are predefined context properties which can be accessed in an entity operation as listed below.

-   operation - 'create/retrieve/update/delete'
-   raw - Raw input data.
-   latest - Validated and sanitized data.
-   existing - Existing data from database.
-   i18n - I18n object.
-   connector - Existing connector for chained operation.
-   result - Operation result.
-   return - Data to return, if retrieveCreated or retrieveUpdated or retrieveDeleted is true, return will be the just create/updated/deleted data.
-   entities - Access other entity models in the same schema
-   schemas - Access other schema models in the same application
-   state - Current request state

## cascade creation / update

```
await EntityA.create_({
    key: 'value',
    ":children": [
        { childKey: 'keyValue1', ... },
        { childKey: 'keyValue2', ... }
    ],
    ":entityB": {
        key1: 'value1',
        key2: 'value2'
    },
    "@entityC:" {
        unikey: "a entity C id"
    }
});

//1. the above call will create a record of entity B
//2. then get the the id of entity C with a group of unique keys (1 or more field pairs) of entity C
//3. then create a record of entity A with a reference to the id of newly created entity B and the id of entity C fetched at step 2
//4. then create a list of children of entity A with a reference to entity A stored in each child records
```

## operation helper [for @genx/data dev only]

-   queryFunction
-   queryBinExpr
-   queryColumn

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

# Types
## Sanitize Object
#### Example
```
const schema = {
    a: { type: 'text' },
    b: {
        type: 'array', elementSchema: {
        type: 'object',
        schema: {
            c: { type: 'text', optional: true },
            d: { type: 'text', optional: true },
            e: { validator:()=>{},convertor:()=>{}}
            }
        }
    }
}
```

## known issues

-   hierachy projection - The key field of each layer of the hierachy structure is required for deep populating the target object
-   retrieveCreated - The query for newly created maybe affected by parrallel updating
-   retrieveUpdated - The previous query maybe affected by parrallel updating
-   retrieveDeleted - The deleted returned may differ from actual deletion (when data changes between find and delete)

## change logs since Apr 2020

1. Add -1 for descent sorting for mysql connector, and now both false and -1 for ORDER BY DESC.
2. Support custom validator and convertor to object sanitize.
3. Add more runtime operator for database
4. Add non-kv-pair query support
5. Fix bugs
6. [15 Oct 2022] Fix incorrect number of records returned, when using limit, offset and counting on multiple joining

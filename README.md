# @k-suite/oolong

## Get Started

### Get a Model Class

#### 1. From another model class 

```
let User = this.db.model('User');
```

#### 2. From appModule 

```
let app = ctx.appModule;
let User = app.model('schemaName.User');
let User = app.db('schemaName').model('User');
```

------

### CRUD

#### Query

```
// Model class: User
// Say, profile belongs to user, a user may has many profile and tagged as "profiles" in the schema 
let user = await User.findOne_(userId); // return only the user's info
let user = await User.findOne_({ $association: [ 'profiles' ], id: userId }); // return the user and all profiles placed at user[":profiles"], all keys not starts with "$" will be merged into $query 
let users = await User.findAll_({ $association: [ 'profiles' ], $query: { ... } });

```
#### Create

```
let user = {
    username: 'guest',
    ':profiles': [ 
        {   
            source: 'facebook',
            firstName: 'Tom',
            lastName: 'Ham',            
        }   
    ]
};

await User.create_(user);
// 1. insert profile
// 2. insert user

```

#### Update

```
//if password depends an existing field in the db, e.g. passwordSalt to produce a salted hash
let user = {
    id: 23131233,
    password: 'iefjeifj'
};

await User.update_({ ...dataToUpdate }, { $query: { ...conditionWithUniqueKey }, ...otherOptions });
// 1. begin transaction
// 2. select latest user by id
// 3. apply modification
// 4. update
// 5. commit

await User.updateMany_({ ...dataToUpdate }, { $query: { ...condition }, ...otherOptions });
```

#### Delete

```
User.deleteOne_({ ...conditionWithUniqueKey });
or
User.deleteOne_({ $query: { ...conditionWithUniqueKey }, ...otherOptions });

User.deleteMany_({ ...dataToUpdate }, { $query: { ...condition }, ...otherOptions });
// if logical deletion, call updateAll
// if not, delete all

```

------

### Condition Rules

#### operator

* $eq or $equal
* $ne or $neq or $notEqual
* $> or $gt or $greaterThan
* $>= or $gte or $greaterThanOrEqual
* $< or $lt or $lessThan
* $<= or $lte or $lessThanOrEqual
* $in
* $nin or $notIn

------

## Entity Model

### static members

* db
    * connector - Getter
    * createNewConnector - Create a new connector, usually used for transaction
* meta - Metadata about the enttiy
    * knowledge 
        * dependsOnExisting
* i18n - I18n object

### operation context

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

### opertion helper

queryFunction
queryBinExpr
queryColumn

### operation options

* connector - Transaction connector.
* $projection
* $association
* $relationships
* $query - Query condition
* $variables - Variables to interpolate into query condition
* $features - Custom feature options override
* $orderBy - Order by condition, map of column to ascend?
* $groupBy - Group by condition
* $offset
* $limit
* $totalCount - Returns total record count when used with $limit
* $includeDeleted - {boolean}
* $skipOrm - {boolean}
* $custom - User defined operation control data
* $retrieveCreated
* $retrieveUpdated
* $retrieveDeleted
* $retrieveExisting
* $retrieveDbResult
* $bypassReadOnly
* $physicalDeletion - {boolean}
* $existing
* $requireSplitColumns
* $bypassEnsureUnique
* $toDictionary
* $migration - {boolean}
* [OUT] $result - Filled by db operation raw result, when $retrieveDbResult is set

# @genx/data Connectors

## MySQL Connector

### Comparison Operators

-   $exist(s)
    -   { $exist: true }: IS NOT NULL
    -   { $exist: false }: IS NULL

-   $eq, $equal: ==

-   $ne, $neq, $notEqual: !=

-   $>, $gt, $greaterThan: >

-   $>=, $gte, $greaterThanOrEqual: >=

-   $<, $lt, $lessThan: <

-   $<=>, $lte, $lessThanOrEqual: <=

-   $in: IN

-   $nin, $notIn: NOT IN

-   $start(s)With: LIKE '%...'

-   $end(s)With: LIKE '...%'

-   $like(s): LIKE '%...%'

-   $has: FIND_IN_SET

### Logical Operator

-   $and, $all: AND

    PS: can also be a key starting with $and_, e.g. $and_1, $and_for_special_user

-   $or, $any: OR

    PS: can also be a key starting with $or_, e.g. $or_1, $or_for_special_user

-   $not: NOT

### Expression Operator

-   $expr
    PS: can also be a key starting with $expr_
    ```
    const { Utils: { Lang } } = require("@genx/data");
    //..
    { 
        $expr_exclude_logo: Lang.$expr(Lang.$col('listing.resourceGroup.resources.url'), '<>', Lang.$col('logo')) 
    }
    ```

### Rules

-   Condition object
    -   Defaultly, k-v pairs condition in an object will be joined with "AND"
    ```
    {
        "field1": "value1", "field2": "value2"
    }
    =>
    `field1` == "value1" AND `field2` == "value2"
    ```

    -   Unless the object is the value of $or, or a key starting with prefix $or_, it will then be joined with "OR"
    ```
    {
        $or: { "field1": "value1", "field2": "value2" }
    }
    =>
    `field1` == "value1" OR `field2` == "value2"
    ```

-   Condition array
    -   Defaultly, conditions array will be joined with "OR"
    ```
    [{
        "field1": "value1", "field2": "value2"
    }, {
        "field1": "value3"
    }]
    =>
    (`field1` == "value1" AND `field2` == "value2") OR (`field1` == "value3")
    ```

    -   Unless the object is the value of $and, or a key starting with prefix $and_, it will then be joined with "AND"
    ```
    { $and: [ { "field1": "value1" }, { "field2": "value2" } ] }
    =>
    `field1` == "value1" AND `field2` == "value2"
    ```

    


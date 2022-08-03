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

-   $and: AND
-   $or: OR
-   $not: NOT
    


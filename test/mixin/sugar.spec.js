/* eslint-disable no-undef */
const assert = require('assert');

const MysqlConnection = require('../../src/drivers/mysql/Connector');
const Test = require('./fixtures/Test')


let connection = null;
let db = null;
let Student = null;

before(async () => {
    connection = new MysqlConnection('mysql://root:root@localhost/test');
    db = new Test({}, connection);

    await db.connector.execute_(`DROP TABLE IF EXISTS student;`)
    await db.connector.execute_(`
    CREATE TABLE student (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(200) NOT NULL DEFAULT "",
        sex TINYINT(1) NOT NULL,
        age INT NOT NULL,
        PRIMARY KEY (id)
      );  
    `)

    await db.connector.insertMany_('student', ['name', 'age', 'sex'], [
        ['tome', 20, 1],
        ['jerry', 30, 1],
        ['lily', 26, 0],
    ]);

    Student = db.model('student');
});

after(async ()=>{
    await db.connector.execute_(`DROP TABLE IF EXISTS student;`)
});

describe('Sugar test', async () => {
    it('COUNT', async () => {
        let result = await Student.count_();
        assert(result.count === 3);

        result = await Student.count_(null, 'totalCount');
        assert(result.totalCount === 3);

        result = await Student.count_(null, 'totalCount', { $query: { age: { $gte: 25 } } });
        assert(result.totalCount === 2);
    });

    it('MAX', async () => {
        let result = await Student.max_('age');
        assert(result.max === 30);

        result = await Student.max_('age', null, { $query: { age: { $lt: 30 } } });
        assert(result.max === 26);

        result = await Student.max_('age', 'maxAge', { $query: { age: { $lt: 30 } } });
        assert(result.maxAge === 26);

    });

    it('MIN', async () => {
        let result = await Student.min_('age');
        assert(result.min === 20);

        result = await Student.min_('age', null, { $query: { age: { $gt: 25 } } });
        assert(result.min === 26);
    });

    it('SUM', async () => {
        let result = await Student.sum_('age');
        assert(result.sum == 76);

        result = await Student.sum_('age', null, { $query: { age: { $gt: 25 } } });

        assert(result.sum == 56);
    });

    it('Increment and decrement', async () => {
        let result = await Student.increment_('age', 1, { $query: { id: 1 }, $retrieveUpdated: true });
        assert(result.age == 21);

        result = await Student.increment_('age', 5, { $query: { id: 1 }, $retrieveUpdated: true });
        assert(result.age == 26);

        result = await Student.decrement_('age', 5, { $query: { id: 1 }, $retrieveUpdated: true });
        assert(result.age == 21);

    });

    it('findOrCreate', async () => {
        let result = await Student.findOrCreate_({ name: 'tiger', age: 30, sex: 1 }, { $query: { id: 1 } });
        assert(!result.created);

        result = await Student.findOrCreate_({ name: 'tiger', age: 30, sex: 1 }, { $query: { id: 4 } });
        assert(result.created);
        assert(result.result.name === 'tiger');
    });

});
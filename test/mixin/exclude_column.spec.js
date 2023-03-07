/* eslint-disable no-undef */
const assert = require('assert');
const { _ } = require('@genx/july');

const MysqlConnection = require('../../src/drivers/mysql/Connector');
const Test = require('./fixtures/Test')


let connection = null;
let db = null;
let Student = null;

before(async () => {
    connection = new MysqlConnection('mysql://root:root@localhost/test');
    db = new Test({
        settings: {
            geml: {
                modelPath: 'fixtures'
            }
        }
    }, connection);

    await db.connector.execute_(`DROP TABLE IF EXISTS student;`)
    await db.connector.execute_(`
    CREATE TABLE student (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(200) NOT NULL DEFAULT "",
        sex TINYINT(1) NOT NULL,
        age INT NOT NULL,
        family INT NOT NULL,
        PRIMARY KEY (id)
      );  
    `)

    await db.connector.execute_(`DROP TABLE IF EXISTS family;`)
    await db.connector.execute_(`
    CREATE TABLE family (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(200) NOT NULL DEFAULT "",
        age INT NOT NULL,
        PRIMARY KEY (id)
      );  
    `)

    await db.connector.insertMany_('family', ['name', 'age'], [
        ['tome_father', 20],
        ['jerry_mother', 30],
        ['lily_father', 26],
    ]);

    await db.connector.insertMany_('student', ['name', 'age', 'sex', 'family'], [
        ['tome', 20, 1, 1],
        ['jerry', 30, 1, 2],
        ['lily', 26, 0, 3],
    ]);

    Student = db.model('student');
});

after(async () => {
    await db.connector.execute_(`DROP TABLE IF EXISTS student;`)
});

describe('Exclude colum', async () => {
    it('findAll', async () => {
        let result = await Student.findAll_({
            $projection: {
                $exclude: ['age']
            }
        });
        assert(_.every(result, (x) => !x.age));

        result = await Student.findAll_({
            $projection: {
                $exclude: ['age']
            },
            $association: ['family']
        });
        assert(_.every(result, (x) => !x.age));

        result = await Student.findAll_({
            $projection: {
                $exclude: ['age', 'family.name']
            },
            $association: ['family']
        });
        assert(_.every(result, (x) => !x.age));
        assert(_.every(result, (x) => _.every(x[':family'], y => !y.name)));
    });

    it('findOne', async () => {
        let result = await Student.findOne_({
            $query:{
                id:1
            },
            $projection: {
                $exclude: ['age']
            }
        });
        assert(!result.age);

        result = await Student.findOne_({
            $query:{
                id:1
            },
            $projection: {
                $exclude: ['age']
            },
            $association: ['family']
        });
        assert(!result.age);

        result = await Student.findOne_({
            $query:{
                id:1
            },
            $projection: {
                $exclude: ['age', 'family.name']
            },
            $association: ['family']
        });
        assert(!result.age);
        assert(!result[':family'].name);

        result = await Student.findOne_({
            $query:{
                id:1
            },
            $projection: {
                $exclude: ['age', 'family.*']
            },
            $association: ['family']
        });
        assert(!result[':family']);
    });
});
'use strict';

const testSuite = require('@genx/test');
const path = require('path');
const { cmd, fs } = require('@genx/sys');
const { eachAsync_, _ } = require('@genx/july');

const SCRIPT_DIR = path.resolve(__dirname);

testSuite(
    function (suite) {
        suite.testCase('model-ensureFields_', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');

                    const Party = db.model('Party');
                    const a = await Party.create_({
                        'website': 'https://www.google.com',
                        'about': 'Google',
                        ':type': {
                            code: 'SUP',
                            name: 'Supplier',
                        },
                        ':company': {
                            'name': 'Google LCC',
                            'role': 'purchaser',
                            ':contacts': [
                                {
                                    ':person': {
                                        firstName: 'Name1',
                                        lastName: 'Last1',
                                    },
                                },
                                {
                                    ':person': {
                                        firstName: 'Name2',
                                        lastName: 'Last2',
                                    },
                                },
                            ],
                        },
                    });

                    should.exist(a);
                    a.website.should.be.exactly('https://www.google.com');

                    const executedCount1 = db.connector.executedCount;

                    const b = await Party.ensureFields_(a, [
                        'website',
                        'about',
                    ]);
                    const executedCount2 = db.connector.executedCount;

                    b.should.be.eql(a);
                    executedCount1.should.be.exactly(executedCount2);

                    const c = await Party.ensureFields_({ id: a.id }, [
                        'website',
                        'about',
                        ':type.name',
                        ':company.:role.name',
                    ]);

                    const executedCount3 = db.connector.executedCount;
                    executedCount3.should.be.exactly(executedCount1 + 1);

                    c.should.have.keys(':type');
                    c[':type'].name.should.be.exactly('Supplier');
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: './conf',
                    logger: {
                        level: 'verbose',
                    },
                    verbose: true,
                }
            );
        });

        suite.testCase('query-with totalcount', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');
                    const Party = db.model('Party');

                    await eachAsync_(_.range(0, 10), async (id) => {
                        await Party.create_({
                            'website': `https://www.google.com/${id}`,
                            'about': `Google ${id}`,
                            'type': 'SUP',
                            ':company': {
                                'name': `Google LCC ${id}`,
                                'role': 'party',
                                ':contacts': [
                                    {
                                        ':person': {
                                            firstName: 'Name1',
                                            lastName: 'Last1',
                                        },
                                    },
                                    {
                                        ':person': {
                                            firstName: 'Name2',
                                            lastName: 'Last2',
                                        },
                                    },
                                    {
                                        ':person': {
                                            firstName: 'Name2',
                                            lastName: 'Last2',
                                        },
                                    },
                                ],
                            },
                        });
                    });

                    const { totalItems, items } = await Party.findAll_({
                        $query: {
                            'company.role': 'party',
                        },
                        $association: ['company', 'company.contacts.person'],
                        $totalCount: true,
                        $limit: 5,
                    });

                    totalItems.should.be.exactly(10);
                    items.length.should.be.exactly(5);

                    const { totalItems: totalItems2, items: items2 } =
                        await Party.findAll_({
                            $query: {},
                            $totalCount: true,
                            $limit: 5,
                        });

                    totalItems2.should.be.exactly(11);
                    items2.length.should.be.exactly(5);
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: './conf',
                    logger: {
                        level: 'verbose',
                    },
                    verbose: true,
                }
            );
        });

        suite.testCase('query-without totalcount', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');
                    const Party = db.model('Party');

                    const items11 = await Party.findAll_({ $query: {} });

                    items11.length.should.be.exactly(11);

                    const items10 = await Party.findAll_({
                        $query: {
                            'company.role': 'party',
                        },
                        $association: ['company', 'company.contacts.person'],
                    });

                    items10.length.should.be.exactly(10);

                    const items5 = await Party.findAll_({
                        $query: {
                            'company.role': 'party',
                        },
                        $association: ['company', 'company.contacts.person'],
                        $limit: 5,
                    });

                    items5.length.should.be.exactly(5);
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: './conf',
                    logger: {
                        level: 'verbose',
                    },
                    verbose: true,
                }
            );
        });

        suite.testCase('query-sub-association', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');
                    const Party = db.model('Party');

                    const items11 = await Party.findAll_({ $query: {} });

                    items11.length.should.be.exactly(11);

                    const items10 = await Party.findAll_({
                        $query: {
                            'company.role': 'party',
                            'company.contacts.person.firstName': 'Name2',
                        },
                        $association: [
                            'company',
                            'company.role',
                            'company.contacts',
                            'company.contacts.person',
                        ],
                    });

                    items10.length.should.be.exactly(10);
                },
                {
                    workingPath: SCRIPT_DIR,
                    configPath: './conf',
                    logger: {
                        level: 'verbose',
                    },
                    verbose: true,
                }
            );
        });

        suite.testCase(
            'query-with limit, group by and order by',
            async function () {
                await suite.startWorker_(
                    async (app) => {
                        const db = app.db('test');
                        const Party = db.model('Party');
                        const PartyType = db.model('PartyType');

                        await Party.deleteMany_({ $deleteAll: true, $physicalDeletion: true });

                        const types = [
                            {
                                code: 'SUP2',
                                name: 'Supplier2',
                            },
                            {
                                code: 'CLT',
                                name: 'Client',
                            },
                            {
                                code: 'DES',
                                name: 'Designer',
                            },
                        ];

                        await eachAsync_(types, async (type) => {
                            await PartyType.create_(type, null, {
                                insertIgnore: true,
                            });
                        });

                        await eachAsync_(_.range(0, 10), async (id) => {
                            await Party.create_({
                                'website': `https://www.google.com/${id}`,
                                'about': `Google ${id}`,
                                'type': types[id % 3].code,
                                ':company': {
                                    'name': `Google LCC ${id}`,
                                    'role': 'party',
                                    ':contacts': [
                                        {
                                            ':person': {
                                                firstName: 'Name1',
                                                lastName: 'Last1',
                                            },
                                        },
                                        {
                                            ':person': {
                                                firstName: 'Name2',
                                                lastName: 'Last2',
                                            },
                                        },
                                        {
                                            ':person': {
                                                firstName: 'Name2',
                                                lastName: 'Last2',
                                            },
                                        },
                                    ],
                                },
                            });
                        });

                        const result = await Party.findAll_({
                            $projection: [
                                'type',
                                db.connector.$call('COUNT', 'total', ['*']),                                
                            ],
                            $query: {
                                'company.role': 'party',
                            },
                            $association: ['company'],
                            $groupBy: ['type'],
                            $orderBy: { total: -1 },
                            $limit: 5,
                            $skipOrm: true,
                        });

                        result.should.be.eql([ [ 'SUP2', 4 ], [ 'CLT', 3 ], [ 'DES', 3 ] ]);
                    },
                    {
                        workingPath: SCRIPT_DIR,
                        configPath: './conf',
                        logger: {
                            level: 'verbose',
                        },
                        verbose: true,
                    }
                );
            },
            //{ only: true }
        );
    },
    {
        verbose: true,
        before: async () => {
            await fs.remove(path.join(SCRIPT_DIR, 'testScripts'));
            await fs.remove(path.join(SCRIPT_DIR, 'testModels'));

            await cmd.runLive_('genx-eml', [
                'build',
                '-c',
                './test/conf/test.default.json',
            ]);
            await cmd.runLive_('genx-eml', [
                'migrate',
                '-c',
                './test/conf/test.default.json',
                '-r',
            ]);
        },
    }
);

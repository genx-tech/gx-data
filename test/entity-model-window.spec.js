'use strict';

const testSuite = require('@genx/test');
const path = require('path');
const { cmd, fs } = require('@genx/sys');
const { eachAsync_, _ } = require('@genx/july');
const { Generators } = require('@genx/data');

const SCRIPT_DIR = path.resolve(__dirname);

testSuite(
    function (suite) {
        suite.testCase('model-windowQuery', async function () {
            await suite.startWorker_(
                async (app) => {
                    const db = app.db('test');

                    const data = {
                        11111111: [
                            {
                                title: 'News A',
                                content: 'News A content',
                                locale: 'en-US',
                            },
                            {
                                title: '新闻 A',
                                content: '新闻 A content',
                                locale: 'zh-CN',
                            },
                            {
                                title: '新聞 A',
                                content: '新聞 A content',
                                locale: 'zh-TW',
                            },
                        ],
                        2222222: [
                            {
                                title: '新闻 B',
                                content: '新闻 A content',
                                locale: 'zh-CN',
                            },
                            {
                                title: 'News B',
                                content: 'News A content',
                                locale: 'en-US',
                            },
                        ],
                        33333333: [
                            {
                                title: '新闻 C',
                                content: '新闻 C content',
                                locale: 'zh-CN',
                            },
                        ],
                        44444444: [
                            {
                                title: '新闻 C',
                                content: '新闻 C content',
                                locale: 'zh-CN',
                            },
                            {
                                title: '新聞 A',
                                content: '新聞 A content',
                                locale: 'zh-TW',
                            },
                        ],
                    };

                    const News = db.model('News');

                    await eachAsync_(data, async (newsArray, ref) => {
                        await eachAsync_(newsArray, async (news) => {
                            await News.create_({
                                reference: ref,
                                ...news,
                            });
                        });
                    });

                    const allNews = await News.findAll_({});
                    allNews.length.should.be.exactly(8);

                    const allNewsRef = await News.findAll_({
                        $projection: ['reference'],
                        $groupBy: 'reference',
                    });
                    allNewsRef.length.should.be.exactly(4);

                    const newsGroupWithFirstItem = await News.findAll_({
                        $projection: ['*'],
                        $query: {},
                        $association: [
                            {                                
                                type: 'INNER JOIN',
                                entity: News.meta.name,
                                dataset: {
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
                                            },
                                        },
                                    ],
                                },
                                key: News.meta.keyField,
                                alias: 'groupFilter_',
                                on: {
                                    [News.meta.keyField]: {
                                        oorType: 'ColumnReference',
                                        name: `groupFilter_.${News.meta.keyField}`,
                                    },
                                    '::row_num': 1,
                                },
                                output: true,
                            },
                        ],
                    });

                    //console.log(newsGroupWithFirstItem);

                    newsGroupWithFirstItem.length.should.be.exactly(4);
                    _.omit(newsGroupWithFirstItem[0], ['id']).should.be.eql({
                        reference: '11111111',
                        title: 'News A',
                        content: 'News A content',
                        locale: 'en-US',
                    });

                    _.omit(newsGroupWithFirstItem[1], ['id']).should.be.eql({
                        reference: '2222222',
                        title: '新闻 B',
                        content: '新闻 A content',
                        locale: 'zh-CN',
                    });

                    _.omit(newsGroupWithFirstItem[2], ['id']).should.be.eql({
                        reference: '33333333',
                        title: '新闻 C',
                        content: '新闻 C content',
                        locale: 'zh-CN',
                    });

                    _.omit(newsGroupWithFirstItem[3], ['id']).should.be.eql({
                        reference: '44444444',
                        title: '新闻 C',
                        content: '新闻 C content',
                        locale: 'zh-CN',
                    });
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
    },
    {
        verbose: true,
        only: true,
        before: async () => {
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
        after: async () => {
            await fs.remove(path.join(SCRIPT_DIR, 'scripts'));
            await fs.remove(path.join(SCRIPT_DIR, 'models'));
        },
    }
);

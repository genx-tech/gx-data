const { unflattenObject, _, eachAsync_ } = require('@genx/july');

module.exports = {
    writeTemplate_: async (templateFile, reverseMapping) => {
        const Excel = require('exceljs');
        let workbook = new Excel.Workbook();

        const sheet = workbook.addWorksheet('Template');
        sheet.addRow(Object.keys(reverseMapping));

        await workbook.xlsx.writeFile(templateFile);
    },

    load_: async (db, mainEntity, dataFile, reverseMapping, payloadFunctor) => {
        const Excel = require('exceljs');
        let workbook = new Excel.Workbook();
        await workbook.xlsx.readFile(dataFile);

        let data = [];

        workbook.eachSheet((worksheet) => {
            let colKeys;

            worksheet.eachRow(function (row, rowNumber) {
                if (!colKeys) {
                    colKeys = _.drop(row.values).map(
                        (key) => reverseMapping[key]
                    );
                } else {
                    const record = _.fromPairs(
                        _.zip(colKeys, _.drop(row.values))
                    );

                    if (!_.isEmpty(record)) {
                        data.push({
                            rowNumber,
                            record: unflattenObject(record),
                        });
                    }
                }
            });
        });

        const errors = [];
        const rowsResult = [];

        const Entity = db.model(mainEntity);
        const processed = [];
        await eachAsync_(data, async ({ rowNumber, record }) => {
            try {
                record = await payloadFunctor(Entity, record);
                processed.push({ rowNumber, record });
                await Entity.create_(record, { $dryRun: true });
            } catch (error) {
                errors.push({
                    rowNumber,
                    error: error.message,
                });
            }
        });

        if (errors.length > 0) {
            return { errors };
        }

        await eachAsync_(processed, async ({ rowNumber, record }) => {
            try {
                const result = await Entity.create_(record);
                rowsResult.push({
                    rowNumber,
                    [Entity.meta.key]: result[Entity.meta.key],
                });
            } catch (error) {
                errors.push({
                    rowNumber,
                    error: error.message,
                });
            }
        });

        return { result: rowsResult, errors };
    },
};

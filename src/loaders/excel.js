const { unflattenObject, _, eachAsync_ } = require('@genx/july');

module.exports = {
    writeTemplate_: async (templateFile, columnsMeta, config) => {
        const keys = Object.keys(columnsMeta);

        const Excel = require('exceljs');
        let workbook = new Excel.Workbook();

        const sheet = workbook.addWorksheet('Template');

        // add header
        sheet.addRow(keys);
        const rowPlaceHolders = new Array(keys.length);

        const templatedRows = config.rows || 50;

        for (let j = 0; j < templatedRows; j++) {
            // add en empty rows
            sheet.addRow(rowPlaceHolders);

            for (let i = 1; i <= keys.length; i++) {
                const colKey = keys[i - 1];
                const metadata = columnsMeta[colKey];
                const cell = sheet.getCell(j + 2, i);

                if (metadata) {
                    if (metadata.type === 'enum') {
                        cell.dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`"${metadata.values.join(',')}"`],
                        };
                    } else if (metadata.type === 'currency') {
                        cell.alignment = { horizontal: 'right' };
                        if (config.currencyFormat) {
                            cell.numFmt = config.currencyFormat;
                        }
                    }
                }
            }
        }

        sheet.addRow(rowPlaceHolders);

        for (let i = 1; i <= keys.length; i++) {
            const cell = sheet.getCell(templatedRows + 2, i);
            cell.border = { top: { style: 'thin' } };
        }

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

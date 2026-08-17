/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';

async function encodeWorkbook(configure: (workbook: ExcelJS.Workbook) => void): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	configure(workbook);
	const bytes = await workbook.xlsx.writeBuffer();
	return Buffer.from(bytes).toString('base64');
}

suite('ParadisSpreadsheetService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loads and shares the heavy runtime only when parsing starts', async () => {
		let runtimeLoads = 0;
		const service = new ParadisSpreadsheetService(async () => {
			runtimeLoads++;
			return { ExcelJS, JSZip };
		});
		const workbook = await encodeWorkbook(() => undefined);

		strictEqual(runtimeLoads, 0);
		await Promise.all([service.parseWorkbook(workbook), service.parseWorkbook(workbook)]);

		strictEqual(runtimeLoads, 1);
	});

	test('rejects bytes that are not an xlsx archive', async () => {
		const service = new ParadisSpreadsheetService();
		const malformed = Buffer.from('not an xlsx workbook').toString('base64');

		await rejects(service.parseWorkbook(malformed));
	});

	test('returns no sheets for a valid workbook with no worksheets', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(() => undefined);

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets, []);
	});

	test('preserves worksheet order, names, and values across multiple sheets', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const first = book.addWorksheet('First');
			first.getCell('A1').value = 'alpha';
			const second = book.addWorksheet('Second');
			second.getCell('A1').value = 42;
			book.addWorksheet('Blank');
		});

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets.map(sheet => sheet.name), ['First', 'Second', 'Blank']);
		strictEqual(result.sheets[0].rows[0].cells[0].value, 'alpha');
		strictEqual(result.sheets[1].rows[0].cells[0].value, '42');
		strictEqual(result.sheets[2].rows[0].cells[0].value, '');
	});

	test('returns at most 2000 rows and marks a larger worksheet as truncated', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Large');
			for (let row = 1; row <= 2001; row++) {
				sheet.getCell(row, 1).value = `row-${row}`;
			}
		});

		const result = await service.parseWorkbook(workbook);
		const sheet = result.sheets[0];

		strictEqual(sheet.rows.length, 2000);
		strictEqual(sheet.truncated, true);
		strictEqual(sheet.rows[0].excelRow, 1);
		strictEqual(sheet.rows[1999].excelRow, 2000);
		strictEqual(sheet.rows[1999].cells[0].value, 'row-2000');
	});

	test('keeps data validation on otherwise empty cells as a sparse range', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Input');
			sheet.pageSetup.printArea = 'A1:A1';
			const validation: ExcelJS.DataValidation = {
				type: 'list',
				formulae: ['"A,B"'],
				showInputMessage: true,
				prompt: 'Select a value',
			};
			for (let row = 3; row <= 20; row++) {
				sheet.getCell(row, 3).dataValidation = validation;
			}
		});

		const result = await service.parseWorkbook(workbook);
		const sheet = result.sheets[0];

		strictEqual(sheet.minCol, 1);
		strictEqual(sheet.rows.length, 1);
		deepStrictEqual(sheet.dataValidations, [{
			range: { minR: 3, maxR: 20, minC: 3, maxC: 3 },
			validation: {
				type: 'list',
				formulae: ['"A,B"'],
				allowBlank: false,
				showInputMessage: true,
				prompt: 'Select a value',
				showErrorMessage: false,
				errorStyle: 'stop',
			},
		}]);
	});
});

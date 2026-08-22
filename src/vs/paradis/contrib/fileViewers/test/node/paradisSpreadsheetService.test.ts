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
import { ParadisSpreadsheetService, applyTint, formatDateFallback, resolveIndexedColor } from '../../node/paradisSpreadsheetService.js';

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

	test('rejects encrypted (CFB) workbooks with a descriptive message', async () => {
		const service = new ParadisSpreadsheetService(async () => ({ ExcelJS, JSZip }));
		// OLE2/CFB 標準シグネチャ(D0 CF 11 E0) + 適当な続き。zip ではないため exceljs も読めない。
		const encrypted = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(16)]).toString('base64');

		await rejects(service.parseWorkbook(encrypted), /パスワードで保護/);
	});

	suite('applyTint (OOXML HLS formula)', () => {
		test('keeps the color unchanged for tint 0 (exact round-trip)', () => {
			strictEqual(applyTint('#2E75B6', 0), '#2E75B6');
			strictEqual(applyTint('#FFFFFF', 0), '#FFFFFF');
		});

		test('darkens with negative tint while preserving hue/saturation', () => {
			// 黒へ向かう RGB 線形補間と異なり、HLS 輝度式では彩度が保たれる(純赤の50%減光 → Excel の暗赤)。
			strictEqual(applyTint('#FF0000', -0.5), '#800000');
		});

		test('lightens with positive tint like Excel theme tints', () => {
			// Excel「アクセント1 淡色60%」相当(2E75B6 + tint 0.6)。彩度を保ったまま淡色化する。
			strictEqual(applyTint('#2E75B6', 0.6), '#A5C8E8');
		});
	});

	suite('resolveIndexedColor', () => {
		test('resolves legacy palette entries', () => {
			strictEqual(resolveIndexedColor(0), '#000000');
			strictEqual(resolveIndexedColor(1), '#FFFFFF');
			strictEqual(resolveIndexedColor(10), '#FF0000');
			strictEqual(resolveIndexedColor(43), '#FFFF99');
			strictEqual(resolveIndexedColor(51), '#FFCC00');
			strictEqual(resolveIndexedColor(55), '#969696');
		});

		test('maps system colors and rejects out-of-range indices', () => {
			strictEqual(resolveIndexedColor(64), '#000000');
			strictEqual(resolveIndexedColor(65), '#FFFFFF');
			strictEqual(resolveIndexedColor(66), null);
			strictEqual(resolveIndexedColor(-1), null);
		});
	});

	suite('formatDateFallback', () => {
		test('renders a locale-independent date and omits zero time', () => {
			strictEqual(formatDateFallback(new Date(2026, 1, 3)), '2026-02-03');
			strictEqual(formatDateFallback(new Date(2026, 11, 31)), '2026-12-31');
		});

		test('appends time only when present', () => {
			strictEqual(formatDateFallback(new Date(2026, 1, 3, 4, 5, 6)), '2026-02-03 04:05:06');
			strictEqual(formatDateFallback(new Date(2026, 1, 3, 0, 0, 0)), '2026-02-03');
		});
	});

	test('centers boolean cells under general alignment like Excel does', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Booleans');
			sheet.getCell('A1').value = true;
			sheet.getCell('A2').value = false;
			sheet.getCell('A3').value = 'text';
			sheet.getCell('A4').value = 42;
		});

		const result = await service.parseWorkbook(workbook);
		const rows = result.sheets[0].rows;

		strictEqual(rows[0].cells[0].style.textAlign, 'center');
		strictEqual(rows[1].cells[0].style.textAlign, 'center');
		strictEqual(rows[2].cells[0].style.textAlign, undefined);
		strictEqual(rows[3].cells[0].style.textAlign, 'right');
	});
});

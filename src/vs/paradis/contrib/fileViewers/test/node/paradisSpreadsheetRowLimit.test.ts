/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, notStrictEqual, strictEqual } from 'assert';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import { limitWorkbookRowsForExcelJs } from '../../node/spreadsheet/paradisSpreadsheetRowLimit.js';

const MAX_ROWS = 2000;
const thin = { style: 'thin' as const, color: { argb: 'FF333333' } };

async function workbook(configure: (sheet: ExcelJS.Worksheet, book: ExcelJS.Workbook) => void): Promise<Buffer> {
	const book = new ExcelJS.Workbook();
	configure(book.addWorksheet('Data'), book);
	return Buffer.from(await book.xlsx.writeBuffer());
}

/** Replaces one part of a package (for shapes exceljs does not write). */
async function withPart(bytes: Buffer, name: string, edit: (xml: string) => string): Promise<Buffer> {
	const zip = await JSZip.loadAsync(bytes);
	zip.file(name, edit(await zip.file(name)!.async('string')));
	return zip.generateAsync({ type: 'nodebuffer' });
}

function fillRows(sheet: ExcelJS.Worksheet, from: number, to: number, columns: number): void {
	for (let row = from; row <= to; row++) {
		for (let column = 1; column <= columns; column++) {
			const cell = sheet.getCell(row, column);
			cell.value = column === 1 ? row : `r${row}c${column}`;
			cell.border = { top: thin, bottom: thin };
		}
	}
}

/** The projection with and without the row limit, and whether the limit changed the package. */
async function compare(bytes: Buffer): Promise<{ readonly same: boolean; readonly limited: boolean }> {
	const withLimit = new ParadisSpreadsheetService(undefined, 0);
	const withoutLimit = new ParadisSpreadsheetService(undefined, false);
	const [left, right] = await Promise.all([withLimit.parseWorkbookBytes(bytes), withoutLimit.parseWorkbookBytes(bytes)]);
	const limited = await limitWorkbookRowsForExcelJs(bytes, MAX_ROWS, JSZip, 0);
	return { same: JSON.stringify(left) === JSON.stringify(right), limited: limited !== bytes };
}

suite('limitWorkbookRowsForExcelJs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the same rows for merges across the limit, sparse rows, wider rows below, shared formulas, conditional formats, validations and hyperlinks', async function () {
		this.timeout(120_000);
		const cases: Record<string, Buffer> = {
			mergeAcrossLimit: await workbook(sheet => {
				fillRows(sheet, 1, 2600, 3);
				sheet.mergeCells('A1999:B2010');
				sheet.getCell('A2010').border = { bottom: { style: 'thick', color: { argb: 'FFFF0000' } } };
				sheet.getCell('A2011').border = { top: { style: 'double', color: { argb: 'FF0000FF' } } };
			}),
			sparseRows: await workbook(sheet => {
				fillRows(sheet, 1, 10, 3);
				fillRows(sheet, 1500, 1500, 3);
				fillRows(sheet, 2001, 2001, 3);
				sheet.getCell('B2001').border = { top: { style: 'medium' } };
				fillRows(sheet, 3000, 3000, 3);
				sheet.getRow(2600).height = 40;
				sheet.getRow(2700).hidden = true;
			}),
			widerAndLeftRowsBelow: await workbook(sheet => {
				for (let row = 1; row <= 2400; row++) {
					sheet.getCell(row, 2).value = row;
					sheet.getCell(row, 3).value = `c${row}`;
				}
				sheet.getCell('A2300').value = 'left';
				sheet.getCell('H2350').value = 'right';
			}),
			sharedFormulas: await workbook(sheet => {
				fillRows(sheet, 1, 2500, 2);
				sheet.getCell('C1').value = { formula: 'A1*2', result: 2, shareType: 'shared', ref: 'C1:C2500' } as ExcelJS.CellFormulaValue;
				for (let row = 2; row <= 2500; row++) {
					sheet.getCell(`C${row}`).value = { sharedFormula: 'C1', result: row * 2 } as ExcelJS.CellSharedFormulaValue;
				}
			}),
			conditionalFormatsAndValidations: await workbook(sheet => {
				fillRows(sheet, 1, 2500, 2);
				sheet.addConditionalFormatting({ ref: 'A1:A2500', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['1990'], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } }] });
				sheet.addConditionalFormatting({ ref: 'A1:A2500', rules: [{ type: 'colorScale', priority: 2, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: 'FF63BE7B' }] }] });
				sheet.getCell('B1990').dataValidation = { type: 'list', allowBlank: true, formulae: ['"a,b"'] };
				sheet.getCell('B2400').dataValidation = { type: 'list', allowBlank: true, formulae: ['"c,d"'] };
			}),
			hyperlinksBelow: await workbook(sheet => {
				fillRows(sheet, 1, 2300, 2);
				sheet.getCell('J2200').value = { text: 'link', hyperlink: 'https://example.invalid/' };
			}),
			dataStartsLower: await workbook(sheet => {
				fillRows(sheet, 500, 4000, 3);
			}),
			rowsWithoutValueBelow: await workbook(sheet => {
				fillRows(sheet, 1, 1500, 3);
				for (let row = 1501; row <= 3000; row++) {
					sheet.getCell(row, 2).border = { left: thin };
				}
			}),
			multipleSheets: await workbook((sheet, book) => {
				fillRows(sheet, 1, 2200, 2);
				fillRows(book.addWorksheet('Small'), 1, 30, 4);
			}),
		};
		const actual: Record<string, { readonly same: boolean; readonly limited: boolean }> = {};
		for (const [name, bytes] of Object.entries(cases)) {
			actual[name] = await compare(bytes);
		}
		deepStrictEqual(actual, {
			mergeAcrossLimit: { same: true, limited: true },
			sparseRows: { same: true, limited: true },
			widerAndLeftRowsBelow: { same: true, limited: true },
			sharedFormulas: { same: true, limited: true },
			conditionalFormatsAndValidations: { same: true, limited: true },
			hyperlinksBelow: { same: true, limited: true },
			dataStartsLower: { same: true, limited: true },
			// Nothing below has a value, but the rows below the limit still go (only the empty cells).
			rowsWithoutValueBelow: { same: true, limited: true },
			multipleSheets: { same: true, limited: true },
		});
	});

	test('reads the whole workbook when the shown rows cannot be kept the same', async function () {
		this.timeout(60_000);
		const printArea = await workbook(sheet => {
			fillRows(sheet, 1, 2200, 2);
			sheet.pageSetup.printArea = 'A1:B2200';
		});
		// A shared formula child in the shown rows whose parent is not kept.
		const orphan = await withPart(await workbook(sheet => fillRows(sheet, 1, 2200, 2)), 'xl/worksheets/sheet1.xml',
			xml => xml.replace(/<c r="B10"([^>]*)>/, '<c r="B10"$1><f t="shared" si="7"/>'));
		const rowWithoutNumber = await withPart(await workbook(sheet => fillRows(sheet, 1, 2200, 2)), 'xl/worksheets/sheet1.xml',
			xml => xml.replace('<row r="2100"', '<row'));
		const small = await workbook(sheet => fillRows(sheet, 1, 2200, 2));
		strictEqual(await limitWorkbookRowsForExcelJs(printArea, MAX_ROWS, JSZip, 0), printArea);
		strictEqual(await limitWorkbookRowsForExcelJs(orphan, MAX_ROWS, JSZip, 0), orphan);
		strictEqual(await limitWorkbookRowsForExcelJs(rowWithoutNumber, MAX_ROWS, JSZip, 0), rowWithoutNumber);
		// Below the size floor nothing changes.
		strictEqual(await limitWorkbookRowsForExcelJs(small, MAX_ROWS, JSZip), small);
		notStrictEqual(await limitWorkbookRowsForExcelJs(small, MAX_ROWS, JSZip, 0), small);
	});
});

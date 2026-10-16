/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisCellData, IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { packParadisWorkbookStyles, unpackParadisWorkbookStyles, type IParadisPackedWorkbookData } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';

/** Invented workbook: repeated styles, the same properties in another order, a merged cell and a theme. */
function workbook(): IParadisWorkbookData {
	const bold = (): IParadisCellData['style'] => ({ fontWeight: 'bold', color: '#000000' });
	return {
		sheets: [
			{
				name: 'One', columnCount: 3, columnWidths: [64, 64, 64], truncated: false, minCol: 1,
				rows: [
					{ excelRow: 1, height: 20, cells: [{ value: 'a', style: bold(), colSpan: 2 }, { value: '', style: {}, hidden: true }, { value: 'b', style: bold() }] },
					{ excelRow: 2, height: 20, cells: [{ value: 'c', style: { color: '#000000', fontWeight: 'bold' } }, { value: 'd', style: { textAlign: 'right' } }, { value: '', style: {} }] },
				],
			},
			{ name: 'Two', columnCount: 1, columnWidths: [64], truncated: false, minCol: 1, rows: [{ excelRow: 1, height: 20, cells: [{ value: 'e', style: bold() }] }] },
		],
		themeColors: { accent1: '#4472C4' },
	};
}

suite('ParadisSpreadsheetStyleTable', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes each style once and gives the same workbook back', () => {
		const original = workbook();
		const packed = packParadisWorkbookStyles(original);
		const unpacked = unpackParadisWorkbookStyles(packed);
		deepStrictEqual({
			styles: packed.cellStyles,
			indexes: packed.sheets.map(sheet => sheet.rows.map(row => row.cells.map(cell => cell.style))),
			sameJson: JSON.stringify(unpacked) === JSON.stringify(original),
			shared: unpacked.sheets[0].rows[0].cells[0].style === unpacked.sheets[1].rows[0].cells[0].style,
		}, {
			styles: [{ fontWeight: 'bold', color: '#000000' }, {}, { color: '#000000', fontWeight: 'bold' }, { textAlign: 'right' }],
			indexes: [[[0, 1, 0], [2, 3, 1]], [[0]]],
			sameJson: true,
			shared: true,
		});
	});

	test('leaves a workbook that was not packed as it is, and empties styles the table does not have', () => {
		const plain = workbook();
		const broken: IParadisPackedWorkbookData = { sheets: [{ name: 'One', columnCount: 1, columnWidths: [64], truncated: false, minCol: 1, rows: [{ excelRow: 1, height: 20, cells: [{ value: 'x', style: 7 }, { value: 'y', style: 0.5 }] }] }], cellStyles: [] };
		deepStrictEqual({
			plain: unpackParadisWorkbookStyles(plain) === plain,
			broken: unpackParadisWorkbookStyles(broken).sheets[0].rows[0].cells.map(cell => cell.style),
		}, { plain: true, broken: [{}, {}] });
	});
});

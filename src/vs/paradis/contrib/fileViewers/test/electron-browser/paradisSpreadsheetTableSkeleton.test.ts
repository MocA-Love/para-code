/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildParadisSheetTableSkeleton } from '../../electron-browser/paradisSpreadsheetRender.js';

suite('ParadisSpreadsheetTableSkeleton', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the columns, the column letters from the first used column, and a row head before the cells of each row', () => {
		// 差分の片側のように、相手側にしか無い行（excelRow が無い）は行番号を空にする。
		const rows = [{ excelRow: 3, height: 20, cells: ['a', 'b'] }, { excelRow: undefined, height: 18, cells: ['', 'c'] }];
		const { table, headCells, rowEls } = buildParadisSheetTableSkeleton({
			columnWidths: [40, 0], columnCount: 2, minCol: 4, grid: false, naturalWidth: 120, rows,
			rowLabel: row => row.excelRow !== undefined ? String(row.excelRow) : '',
			appendCells: (tr, row) => row.cells.forEach(value => { append(tr, $('td')).textContent = value; }),
		});
		deepStrictEqual({
			className: table.className,
			width: table.style.width,
			columns: Array.from(table.querySelectorAll('col'), col => col.style.width),
			heads: headCells.map(cell => cell.textContent),
			rows: rowEls.map(tr => [tr.style.height, ...Array.from(tr.children, cell => cell.textContent)]),
		}, {
			className: 'paradis-spreadsheet-table',
			width: '120px',
			columns: ['44px', '40px', ''],
			heads: ['D', 'E'],
			rows: [['20px', '3', 'a', 'b'], ['18px', '', '', 'c']],
		});
	});
});

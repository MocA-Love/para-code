/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { PARADIS_ROW_NUM_COL_WIDTH } from '../../electron-browser/paradisSpreadsheetRender.js';
import { computeFrozenPaneBoxes, resolveFrozenPaneExtent, trimFrozenPaneClone } from '../../electron-browser/paradisSpreadsheetEditor.js';

function sheet(overrides: Partial<IParadisSheetData>): IParadisSheetData {
	return {
		name: 'Sheet1',
		rows: [],
		columnCount: 0,
		columnWidths: [],
		truncated: false,
		minCol: 1,
		...overrides,
	};
}

function rowsFrom(excelRows: readonly number[], height: number): IParadisSheetData['rows'] {
	return excelRows.map(excelRow => ({ excelRow, cells: [], height }));
}

/** colSpan 付きのセルを持つ最小の表を組み立てる。 */
function tableWith(rows: readonly (readonly number[])[]): HTMLElement {
	const table = mainWindow.document.createElement('table');
	const tbody = mainWindow.document.createElement('tbody');
	table.appendChild(tbody);
	for (const spans of rows) {
		const tr = mainWindow.document.createElement('tr');
		// 先頭は行番号セル。固定枠側では常に落とされる。
		tr.appendChild(mainWindow.document.createElement('td'));
		for (const span of spans) {
			const td = mainWindow.document.createElement('td');
			td.colSpan = span;
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	return table;
}

suite('ParadisSpreadsheetFrozenPane', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports no extent when the sheet has no frozen pane', () => {
		deepStrictEqual(
			resolveFrozenPaneExtent(sheet({ rows: rowsFrom([1, 2, 3], 20), columnWidths: [50, 60] })),
			{ rowCount: 0, colCount: 0, height: 0, width: 0 },
		);
	});

	test('counts rendered rows and columns covered by the frozen split', () => {
		deepStrictEqual(
			resolveFrozenPaneExtent(sheet({
				rows: rowsFrom([1, 2, 3, 4], 20),
				columnWidths: [50, 60, 70],
				freezePane: { rows: 2, cols: 2 },
			})),
			{ rowCount: 2, colCount: 2, height: 40, width: 110 },
		);
	});

	test('sums the real heights of hidden-row gaps instead of the row ordinal', () => {
		// 非表示行があると excelRow は連番にならない。3 行目までの固定は描画済み 2 行だけを含む。
		deepStrictEqual(
			resolveFrozenPaneExtent(sheet({
				rows: [
					{ excelRow: 1, cells: [], height: 10 },
					{ excelRow: 3, cells: [], height: 30 },
					{ excelRow: 4, cells: [], height: 40 },
				],
				columnWidths: [],
				freezePane: { rows: 3, cols: 0 },
			})),
			{ rowCount: 2, colCount: 0, height: 40, width: 0 },
		);
	});

	test('drops the split entirely when the used range starts past it', () => {
		// 使用範囲が D 列(4)始まりのシートで 2 列固定を指定しても、固定対象は描画範囲の外にある。
		deepStrictEqual(
			resolveFrozenPaneExtent(sheet({
				rows: rowsFrom([10, 11], 20),
				columnWidths: [50, 60],
				minCol: 4,
				freezePane: { rows: 3, cols: 2 },
			})),
			{ rowCount: 0, colCount: 0, height: 0, width: 0 },
		);
	});

	test('trims cloned rows beyond the frozen row count', () => {
		const table = tableWith([[1], [1], [1]]);
		trimFrozenPaneClone(table, 2, undefined);
		strictEqual(table.querySelectorAll('tbody > tr').length, 2);
	});

	test('trims cloned columns while honouring colspan and keeping the row head', () => {
		const table = tableWith([[1, 1, 1, 1]]);
		trimFrozenPaneClone(table, undefined, 2);
		// 行番号セル + 固定 2 列。
		strictEqual(table.querySelectorAll('tbody > tr > td').length, 3);

		const merged = tableWith([[3, 1, 1]]);
		trimFrozenPaneClone(merged, undefined, 2);
		// 先頭セルが 3 列分を占めるので、それだけで固定幅を満たし後続は落ちる。
		strictEqual(merged.querySelectorAll('tbody > tr > td').length, 2);
	});

	test('keeps every row and column when no limit is given', () => {
		const table = tableWith([[1, 1], [1, 1]]);
		trimFrozenPaneClone(table, undefined, undefined);
		strictEqual(table.querySelectorAll('tbody > tr').length, 2);
		strictEqual(table.querySelectorAll('tbody > tr > td').length, 6);
	});

	test('starts every pane at the header strip so the scroll transforms line up', () => {
		// 3枚とも inner の translate は本体の表と同じ式なので、箱の起点も本体と同じ headHeight で揃う。
		// 固定列の起点を headHeight + frozenHeight にすると中身が frozenHeight ぶん下へずれる。
		deepStrictEqual(
			computeFrozenPaneBoxes({ headHeight: 20, frozenHeight: 60, frozenWidth: 120, scale: 1 }),
			{
				rows: { top: 20, left: PARADIS_ROW_NUM_COL_WIDTH, height: 60 },
				cols: { top: 20, left: PARADIS_ROW_NUM_COL_WIDTH, width: 120 },
				corner: { top: 20, left: PARADIS_ROW_NUM_COL_WIDTH, width: 120, height: 60 },
			},
		);
	});

	test('scales every pane edge by the current zoom', () => {
		deepStrictEqual(
			computeFrozenPaneBoxes({ headHeight: 20, frozenHeight: 60, frozenWidth: 120, scale: 0.5 }),
			{
				rows: { top: 10, left: Math.round(PARADIS_ROW_NUM_COL_WIDTH * 0.5), height: 30 },
				cols: { top: 10, left: Math.round(PARADIS_ROW_NUM_COL_WIDTH * 0.5), width: 60 },
				corner: { top: 10, left: Math.round(PARADIS_ROW_NUM_COL_WIDTH * 0.5), width: 60, height: 30 },
			},
		);
	});
});

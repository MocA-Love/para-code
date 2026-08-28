/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisRowData, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { buildSheetTableDom } from '../../electron-browser/paradisSpreadsheetRender.js';

function rows(count: number, columns: number, firstExcelRow = 1): IParadisRowData[] {
	return Array.from({ length: count }, (_, index) => ({
		excelRow: firstExcelRow + index,
		height: 20,
		cells: Array.from({ length: columns }, () => ({ value: 'x', style: {} })),
	}));
}

function sheet(overrides: Partial<IParadisSheetData>): IParadisSheetData {
	return {
		name: 'Sheet1',
		rows: rows(4, 2),
		columnCount: 2,
		columnWidths: [60, 60],
		truncated: false,
		minCol: 1,
		...overrides,
	};
}

/** 行ごとに、データセルへ付いたテーブル関連クラスを取り出す。 */
function tableClasses(table: HTMLElement): string[][] {
	const bodies = (table as HTMLTableElement).tBodies;
	const result: string[][] = [];
	for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
		for (const row of Array.from(bodies[bodyIndex].rows)) {
			// 先頭は行番号セルなので落とす。
			const cells = Array.from(row.cells).slice(1);
			result.push(cells.map(cell => Array.from(cell.classList)
				.filter(name => name.startsWith('paradis-spreadsheet-table-'))
				.sort()
				.join(' ')));
		}
	}
	return result;
}

function filterMarkerCount(table: HTMLElement): number {
	let count = 0;
	const walk = (element: Element): void => {
		for (const child of Array.from(element.children)) {
			if (child.classList.contains('paradis-spreadsheet-filter-marker')) {
				count++;
			}
			walk(child);
		}
	};
	walk(table);
	return count;
}

suite('ParadisSpreadsheetTableRender', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks the header, striped data rows, and the totals row of a table', () => {
		const { table } = buildSheetTableDom(sheet({
			tables: [{
				name: 'T1',
				range: { minR: 1, maxR: 4, minC: 1, maxC: 2 },
				headerRow: true,
				totalsRow: true,
				showRowStripes: true,
				showColumnStripes: false,
				showFirstColumn: false,
				showLastColumn: false,
			}],
		}));

		// 見出し行 → データ2行 → 集計行。縞は ECMA-376 の firstRowStripe に合わせ
		// データの先頭行から始まる。
		deepStrictEqual(tableClasses(table), [
			['paradis-spreadsheet-table-header', 'paradis-spreadsheet-table-header'],
			['paradis-spreadsheet-table-stripe', 'paradis-spreadsheet-table-stripe'],
			['', ''],
			['paradis-spreadsheet-table-totals', 'paradis-spreadsheet-table-totals'],
		]);
	});

	test('emphasises the first and last column when the table asks for it', () => {
		const { table } = buildSheetTableDom(sheet({
			rows: rows(2, 2),
			tables: [{
				name: 'T1',
				range: { minR: 1, maxR: 2, minC: 1, maxC: 2 },
				headerRow: false,
				totalsRow: false,
				showRowStripes: false,
				showColumnStripes: false,
				showFirstColumn: true,
				showLastColumn: true,
			}],
		}));

		deepStrictEqual(tableClasses(table), [
			['paradis-spreadsheet-table-emphasis', 'paradis-spreadsheet-table-emphasis'],
			['paradis-spreadsheet-table-emphasis', 'paradis-spreadsheet-table-emphasis'],
		]);
	});

	test('leaves every cell untouched when the sheet has no table', () => {
		const { table } = buildSheetTableDom(sheet({ rows: rows(2, 2) }));

		deepStrictEqual(tableClasses(table), [['', ''], ['', '']]);
		strictEqual(filterMarkerCount(table), 0);
	});

	test('puts a filter marker only on the first row of a filter range', () => {
		const { table } = buildSheetTableDom(sheet({
			rows: rows(3, 2),
			filterRanges: [{ minR: 1, maxR: 3, minC: 1, maxC: 2 }],
		}));

		strictEqual(filterMarkerCount(table), 2);
	});

	test('honours the sheet column offset when matching a filter range', () => {
		// 使用範囲が D 列(4)始まりのシート。範囲は D 列だけなので記号は1つ。
		const { table } = buildSheetTableDom(sheet({
			rows: rows(2, 2),
			minCol: 4,
			filterRanges: [{ minR: 1, maxR: 2, minC: 4, maxC: 4 }],
		}));

		strictEqual(filterMarkerCount(table), 1);
	});
});

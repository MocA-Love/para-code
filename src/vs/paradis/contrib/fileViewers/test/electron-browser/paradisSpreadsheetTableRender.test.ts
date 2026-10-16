/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisRowData, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { buildSheetTableDom, buildShownNoteOverlay, PARADIS_ROW_NUM_COL_WIDTH } from '../../electron-browser/paradisSpreadsheetRender.js';

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

	test('marks cells that carry a note or a threaded comment', () => {
		const { table } = buildSheetTableDom(sheet({
			comments: [
				{ ref: 'A1', row: 0, column: 0, kind: 'note', entries: [{ author: '', text: 'n' }] },
				{ ref: 'B2', row: 1, column: 1, kind: 'thread', entries: [{ author: '', text: 't' }] },
			],
		}));
		const marked = Array.from(table.querySelectorAll<HTMLElement>('[data-paradis-comment-ref]')).map(cell => [cell.dataset.paradisCommentRef, cell.classList.contains('paradis-spreadsheet-comment-note'), cell.classList.contains('paradis-spreadsheet-comment-thread')]);
		deepStrictEqual(marked, [['A1', true, false], ['B2', false, true]]);
	});

	test('draws only the notes set to show, at their saved box, with a leader line to the top right of their cell', () => {
		const px = (value: number) => value * 9525;
		const rowY = new Map([[1, 20], [2, 40], [3, 60], [4, 80], [5, 100]]);
		const overlay = buildShownNoteOverlay([
			{ ref: 'A1', row: 0, column: 0, kind: 'note', entries: [{ author: '', text: 'hidden' }] },
			{ ref: 'B2', row: 1, column: 1, kind: 'note', entries: [{ author: 'Sample', text: 'Sample:\nfirst' }], shown: { from: { c: 2, co: px(5), r: 0, ro: px(4) }, to: { c: 4, co: 0, r: 3, ro: 0 } } },
			{ ref: 'C4', row: 3, column: 2, kind: 'note', entries: [{ author: '', text: 'second' }], shown: { from: { c: 0, co: px(10), r: 0, ro: 0 }, ext: { cx: px(50), cy: px(30) }, fill: '#ccffcc' } },
			{ ref: 'D1', row: 0, column: 3, kind: 'thread', entries: [{ author: '', text: 'thread' }] },
		], rowY, [60, 60, 60, 60], 1, document)!;
		const left = PARADIS_ROW_NUM_COL_WIDTH;
		deepStrictEqual({
			notes: Array.from(overlay.querySelectorAll<HTMLElement>('.paradis-spreadsheet-note')).map(note => [note.style.left, note.style.top, note.style.width, note.style.height, note.style.minHeight, note.style.backgroundColor, note.innerHTML]),
			lines: Array.from(overlay.querySelectorAll('line')).map(line => ['x1', 'y1', 'x2', 'y2'].map(name => Number(line.getAttribute(name)))),
			heads: overlay.querySelectorAll('polygon').length,
			none: buildShownNoteOverlay([{ ref: 'A1', row: 0, column: 0, kind: 'note', entries: [{ author: '', text: 'hidden' }] }], rowY, [60], 1, document),
		}, {
			notes: [
				[`${left + 125}px`, '24px', '115px', '56px', '56px', '', '<b>Sample:</b>\nfirst'],
				[`${left + 10}px`, '20px', '50px', '30px', '30px', 'rgb(204, 255, 204)', 'second'],
			],
			// B2: from the box's top left (8px down) to the right edge of B at row 2. C4: from the right of the box, left of the cell.
			lines: [[left + 125, 32, left + 120, 40], [left + 60, 28, left + 180, 80]],
			heads: 2,
			none: undefined,
		});
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCellData, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { buildDiffSheets } from '../../electron-browser/paradisSpreadsheetDiff.js';

function cell(value: string): IParadisCellData {
	return { value, style: {} };
}

function sheet(name: string, rows: readonly (readonly string[])[]): IParadisSheetData {
	return {
		name,
		rows: rows.map((values, index) => ({ excelRow: index + 1, height: 20, cells: values.map(cell) })),
		columnCount: rows[0]?.length ?? 0,
		columnWidths: (rows[0] ?? []).map(() => 80),
		truncated: false,
		minCol: 1,
	};
}

suite('paradisSpreadsheetDiff row alignment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps an inserted top row as a single added row instead of shifting everything', () => {
		const original = sheet('S', [['header'], ['a'], ['b']]);
		const modified = sheet('S', [['header'], ['NEW'], ['a'], ['b']]);

		const [diff] = buildDiffSheets([original], [modified]);

		// ゴースト込みで左右の行数は常に一致する。
		strictEqual(diff.originalRows.length, diff.modifiedRows.length);
		strictEqual(diff.originalRows.length, 4);

		// 挿入行: modified側だけ added、original側はゴースト(excelRow 無し)。
		const addedCells = diff.modifiedRows[1].cells;
		ok(addedCells.every(c => c.diffStatus === 'added'), 'inserted row must be marked added');
		strictEqual(diff.originalRows[1].excelRow, undefined);
		ok(diff.originalRows[1].cells.every(c => !c.diffStatus), 'ghost side carries no marks');

		// 挿入より後ろの行はペアリングされ、偽の modified にならない。
		for (const i of [2, 3]) {
			ok(diff.originalRows[i].cells.every(c => !c.diffStatus), `original row ${i} must be unmarked`);
			ok(diff.modifiedRows[i].cells.every(c => !c.diffStatus), `modified row ${i} must be unmarked`);
			strictEqual(diff.originalRows[i].excelRow, i); // excelRow 1始まり(0行目がheader=1)
		}
	});

	test('keeps a deleted middle row as a single removed row with a ghost on the other side', () => {
		const original = sheet('S', [['a'], ['b'], ['c']]);
		const modified = sheet('S', [['a'], ['c']]);

		const [diff] = buildDiffSheets([original], [modified]);

		strictEqual(diff.originalRows.length, diff.modifiedRows.length);
		strictEqual(diff.originalRows.length, 3);
		ok(diff.originalRows[1].cells.every(c => c.diffStatus === 'removed'));
		strictEqual(diff.modifiedRows[1].excelRow, undefined);
		ok(diff.modifiedRows[1].cells.every(c => !c.diffStatus));
		ok(diff.originalRows[2].cells.every(c => !c.diffStatus));
		// 絶対行番号は「その版のファイルでの物理行」。削除後の c は新版では2行目。
		strictEqual(diff.modifiedRows[2].excelRow, 2);
	});

	test('mirrors the counterpart height on ghost rows so both panes stay aligned', () => {
		const original = sheet('S', [['a']]);
		const modified: IParadisSheetData = {
			...sheet('S', [['x'], ['a']]),
			rows: [
				{ excelRow: 1, height: 55, cells: [cell('x')] },
				{ excelRow: 2, height: 20, cells: [cell('a')] },
			],
		};

		const [diff] = buildDiffSheets([original], [modified]);

		strictEqual(diff.originalRows[0].height, 55, 'ghost borrows the inserted row height');
		strictEqual(diff.modifiedRows[0].height, 55);
	});

	test('unchanged sheets produce no ghosts and no marks', () => {
		const original = sheet('S', [['a'], ['b']]);
		const [diff] = buildDiffSheets([original], [sheet('S', [['a'], ['b']])]);

		strictEqual(diff.originalRows.length, 2);
		strictEqual(diff.modifiedRows.length, 2);
		for (const row of [...diff.originalRows, ...diff.modifiedRows]) {
			ok(row.cells.every(c => !c.diffStatus));
		}
		deepStrictEqual(diff.originalRows.map(r => r.excelRow), [1, 2]);
	});
});

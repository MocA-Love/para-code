/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
/* eslint-disable local/code-no-unexternalized-strings */

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCellData, IParadisRenderShape, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { buildShapeDiffOverlay } from '../../electron-browser/paradisSpreadsheetRender.js';
import { buildDiffSheets, buildShapeDiff, formatDiffDetails } from '../../electron-browser/paradisSpreadsheetDiff.js';

function cell(value: string, style: IParadisCellData['style'] = {}, extra: Partial<IParadisCellData> = {}): IParadisCellData {
	return { value, style, ...extra };
}

function sheet(cells: readonly IParadisCellData[], shapes?: readonly IParadisRenderShape[]): IParadisSheetData {
	return {
		name: 'Sheet1',
		rows: [{ excelRow: 1, height: 20, cells }],
		columnCount: cells.length,
		columnWidths: cells.map(() => 80),
		truncated: false,
		minCol: 1,
		...(shapes ? { shapes } : {}),
	};
}

function lineShape(extra: Partial<IParadisRenderShape> = {}): IParadisRenderShape {
	return {
		type: 'line',
		flipV: false,
		flipH: false,
		from: { c: 0, co: 0, r: 0, ro: 0 },
		to: { c: 1, co: 0, r: 1, ro: 0 },
		outlineWidth: 1,
		outlineColor: '#000000',
		dash: 'solid',
		name: 'Connector 1',
		...extra,
	};
}

suite('paradisSpreadsheetDiff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks style-only cell changes and records hover details', () => {
		const original = sheet([
			cell('Total', { fontFamily: "'Calibri', sans-serif", fontSize: '11pt', textAlign: 'left' }),
		]);
		const modified = sheet([
			cell('Total', { fontFamily: "'Arial', sans-serif", fontSize: '12pt', textAlign: 'right' }),
		]);

		const [diff] = buildDiffSheets([original], [modified]);
		const originalCell = diff.originalRows[0].cells[0];
		const modifiedCell = diff.modifiedRows[0].cells[0];

		strictEqual(originalCell.diffStatus, 'modified');
		strictEqual(modifiedCell.diffStatus, 'modified');
		strictEqual(modifiedCell.diffSegments, undefined);
		deepStrictEqual(modifiedCell.diffDetails?.map(d => [d.label, d.original, d.modified]), [
			['Font', "'Calibri', sans-serif", "'Arial', sans-serif"],
			['Font size', '11pt', '12pt'],
			['Horizontal alignment', 'left', 'right'],
		]);
	});

	test('records value and cell metadata changes for hover details', () => {
		const original = sheet([
			cell('{{name}}', {}, { wrapText: false, colSpan: 1 }),
		]);
		const modified = sheet([
			cell('Alice', {}, { wrapText: true, colSpan: 2 }),
		]);

		const [diff] = buildDiffSheets([original], [modified]);
		const details = diff.modifiedRows[0].cells[0].diffDetails;

		deepStrictEqual(details?.map(d => [d.label, d.original, d.modified]), [
			['Value', '{{name}}', 'Alice'],
			['Merged columns', '1', '2'],
			['Wrap text', 'false', 'true'],
		]);
		strictEqual(formatDiffDetails(details ?? []), 'Value: {{name}} -> Alice\nMerged columns: 1 -> 2\nWrap text: false -> true');
	});

	test('describes shape style changes', () => {
		const originalShape = lineShape();
		const modifiedShape = lineShape({ outlineColor: '#ff0000', outlineWidth: 2, dash: 'dash' });

		const diff = buildShapeDiff([originalShape], [modifiedShape]);

		strictEqual(diff.modifiedRenders[0].status, 'changed');
		deepStrictEqual(diff.modifiedRenders[0].diffDetails?.map(d => [d.label, d.original, d.modified]), [
			['Object outline color', '#000000', '#ff0000'],
			['Object outline width', '1', '2'],
			['Object dash', 'solid', 'dash'],
		]);
	});

	test('adds hover title nodes to changed shape overlay elements', () => {
		const doc = document.implementation.createHTMLDocument('spreadsheet diff');
		const overlay = buildShapeDiffOverlay(
			[{ shape: lineShape(), status: 'changed', diffTitle: 'Object outline color: #000000 -> #ff0000' }],
			'modified',
			new Map([[1, 0], [2, 20]]),
			[80, 80],
			1,
			doc
		);

		const title = overlay?.querySelector('title');
		ok(title);
		strictEqual(title.textContent, 'Object outline color: #000000 -> #ff0000');
	});
});

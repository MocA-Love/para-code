/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
/* eslint-disable local/code-no-unexternalized-strings */

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCellData, IParadisRenderShape, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { buildShapeDiffOverlay } from '../../electron-browser/paradisSpreadsheetRender.js';
import { buildDiffSheets, buildShapeDiff } from '../../electron-browser/paradisSpreadsheetDiff.js';
import { formatDiffDetails } from '../../electron-browser/paradisSpreadsheetDiffPresentation.js';

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
		deepStrictEqual(modifiedCell.diffDetails?.map(d => [d.kind, d.original, d.modified]), [
			['fontFamily', "'Calibri', sans-serif", "'Arial', sans-serif"],
			['fontSize', '11pt', '12pt'],
			['textAlign', 'left', 'right'],
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

		deepStrictEqual(details?.map(d => [d.kind, d.original, d.modified]), [
			['value', '{{name}}', 'Alice'],
			['mergedColumns', '1', '2'],
			['wrapText', 'false', 'true'],
		]);
		strictEqual(formatDiffDetails(details ?? []), 'Value: {{name}} → Alice\nMerged Columns: 1 → 2\nWrap Text: false → true');
	});

	test('bounds long cell values before creating hover content', () => {
		const original = sheet([cell('A'.repeat(10_000))]);
		const modified = sheet([cell('B'.repeat(10_000))]);

		const [diff] = buildDiffSheets([original], [modified]);
		const details = diff.modifiedRows[0].cells[0].diffDetails ?? [];
		const title = formatDiffDetails(details);

		ok((details[0].original?.length ?? 0) <= 512);
		ok((details[0].modified?.length ?? 0) <= 512);
		ok(title.length <= 4_096);
	});

	test('serializes rich text within the detail limit', () => {
		const original = sheet([cell('', {}, { richText: [{ text: 'A'.repeat(10_000), style: {} }] })]);
		const modified = sheet([cell('', {}, { richText: [{ text: 'B'.repeat(10_000), style: {} }] })]);

		const [diff] = buildDiffSheets([original], [modified]);
		const detail = diff.modifiedRows[0].cells[0].diffDetails?.find(item => item.kind === 'richText');

		ok((detail?.original?.length ?? 0) <= 512);
		ok((detail?.modified?.length ?? 0) <= 512);
	});

	test('bounds added and removed shape names before creating hover content', () => {
		const longName = 'Shape'.repeat(2_000);
		const added = buildShapeDiff([], [lineShape({ name: longName })]);
		const removed = buildShapeDiff([lineShape({ name: longName })], []);

		ok((added.modifiedRenders[0].diffDetails?.[0].modified?.length ?? 0) <= 512);
		ok((removed.originalRenders[0].diffDetails?.[0].original?.length ?? 0) <= 512);
	});

	test('describes shape style changes', () => {
		const originalShape = lineShape();
		const modifiedShape = lineShape({ outlineColor: '#ff0000', outlineWidth: 2, dash: 'dash' });

		const diff = buildShapeDiff([originalShape], [modifiedShape]);

		strictEqual(diff.modifiedRenders[0].status, 'changed');
		deepStrictEqual(diff.modifiedRenders[0].diffDetails?.map(d => [d.kind, d.original, d.modified]), [
			['objectOutlineColor', '#000000', '#ff0000'],
			['objectOutlineWidth', '1', '2'],
			['objectDash', 'solid', 'dash'],
		]);
	});

	test('includes geometry and style details when both change', () => {
		const originalShape = lineShape();
		const modifiedShape = lineShape({
			from: { c: 1, co: 0, r: 0, ro: 0 },
			outlineColor: '#ff0000',
		});

		const diff = buildShapeDiff([originalShape], [modifiedShape]);

		strictEqual(diff.modifiedRenders[0].status, 'moved');
		deepStrictEqual(diff.modifiedRenders[0].diffDetails?.map(detail => detail.kind), ['objectStart', 'objectOutlineColor']);
	});

	test('detects shape flip changes', () => {
		const originalShape = lineShape();
		const modifiedShape = lineShape({ flipV: true });

		const diff = buildShapeDiff([originalShape], [modifiedShape]);

		strictEqual(diff.modifiedRenders[0].status, 'moved');
		deepStrictEqual(diff.modifiedRenders[0].diffDetails?.map(detail => detail.kind), ['objectFlipVertical']);
	});

	test('summarizes image data without exposing the data URI', () => {
		const originalShape = lineShape({ type: 'image', href: `data:image/png;base64,${'A'.repeat(10_000)}` });
		const modifiedShape = lineShape({ type: 'image', href: `data:image/png;base64,${'B'.repeat(10_000)}` });

		const diff = buildShapeDiff([originalShape], [modifiedShape]);
		const details = diff.modifiedRenders[0].diffDetails ?? [];
		const title = formatDiffDetails(details);

		strictEqual(title.includes('base64'), false);
		strictEqual(title.includes('AAAA'), false);
		ok(title.length < 1_000);
	});

	test('adds hover title nodes to changed shape overlay elements', () => {
		const doc = document.implementation.createHTMLDocument('spreadsheet diff');
		const overlay = buildShapeDiffOverlay(
			[{ shape: lineShape(), status: 'changed', diffDetails: [{ kind: 'objectOutlineColor', original: '#000000', modified: '#ff0000' }] }],
			'modified',
			new Map([[1, 0], [2, 20]]),
			[80, 80],
			1,
			doc
		);

		const title = overlay?.querySelector('title');
		ok(title);
		strictEqual(title.textContent, 'Object Outline Color: #000000 → #ff0000');
	});
});

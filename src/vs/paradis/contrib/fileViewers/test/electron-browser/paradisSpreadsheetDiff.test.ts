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
import { buildDataValidationDiff, buildDiffSheets, buildPageBreakDiff, buildShapeDiff } from '../../electron-browser/paradisSpreadsheetDiff.js';
import { IParadisPageLayout } from '../../common/paradisSpreadsheetPageLayout.js';
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

	test('propagates the truncation flag when either side is truncated', () => {
		const original = sheet([cell('a')]);
		const modifiedTruncated: IParadisSheetData = { ...sheet([cell('b')]), truncated: true };

		const [diff] = buildDiffSheets([original], [modifiedTruncated]);
		ok(diff.truncated, 'truncation on the modified side must surface in the diff sheet');

		const originalTruncated: IParadisSheetData = { ...sheet([cell('a')]), truncated: true };
		const [diff2] = buildDiffSheets([originalTruncated], [sheet([cell('a')])]);
		ok(diff2.truncated, 'truncation on the original side must surface too');

		const [diff3] = buildDiffSheets([sheet([cell('a')])], [sheet([cell('a')])]);
		strictEqual(diff3.truncated, undefined);
	});

	test('marks added sheets and their rows as truncated when needed', () => {
		const added: IParadisSheetData = { ...sheet([cell('new')]), name: 'NewSheet', truncated: true };
		const [diff] = buildDiffSheets([], [added]);

		strictEqual(diff.sheetStatus, 'added');
		ok(diff.truncated);
	});

	test('marks removed sheets as truncated when the original was truncated', () => {
		const removed: IParadisSheetData = { ...sheet([cell('old')]), name: 'GoneSheet', truncated: true };
		const [diff] = buildDiffSheets([removed], []);

		strictEqual(diff.sheetStatus, 'removed');
		ok(diff.truncated);
	});

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
		strictEqual(formatDiffDetails(details ?? []), '値: {{name}} → Alice\n結合列: 1 → 2\n折り返して全体を表示: false → true');
	});

	test('marks changed, removed, and added data validation rules', () => {
		const listRule = { type: 'list' as const, formulae: ['"A,B"'], allowBlank: false };
		const original = sheet([
			cell('A', {}, { dataValidation: listRule }),
			cell('10', {}, { dataValidation: { type: 'whole', formulae: ['0', '100'], operator: 'between' } }),
			cell('Region'),
		]);
		const modified = sheet([
			cell('A', {}, { dataValidation: { ...listRule, formulae: ['"A,B,C"'] } }),
			cell('10'),
			cell('Region', {}, { dataValidation: { type: 'list', formulae: ['=Master!$A$2:$A$48'], allowBlank: true } }),
		]);

		const [diff] = buildDiffSheets([original], [modified]);
		deepStrictEqual(
			diff.modifiedRows[0].cells.map(item => ({
				status: item.diffStatus,
				validationDetail: item.diffDetails?.some(detail => detail.kind === 'dataValidation') ?? false,
			})),
			[
				{ status: 'modified', validationDetail: true },
				{ status: 'modified', validationDetail: true },
				{ status: 'modified', validationDetail: true },
			],
		);
	});

	test('aligns cells by their absolute columns before comparing data validation', () => {
		const rule = { type: 'list' as const, formulae: ['"A,B"'] };
		const original = { ...sheet([cell('left'), cell(''), cell('', {}, { dataValidation: rule })]), minCol: 1 };
		const modified = { ...sheet([cell('', {}, { dataValidation: rule })]), minCol: 3 };

		const [diff] = buildDiffSheets([original], [modified]);

		strictEqual(diff.originalMinCol, 1);
		strictEqual(diff.modifiedMinCol, 1);
		strictEqual(diff.originalRows[0].cells[2].diffDetails, undefined);
		strictEqual(diff.modifiedRows[0].cells[2].diffDetails, undefined);
	});

	test('compares sparse data validation outside the rendered cell rectangle', () => {
		const originalRule = { type: 'list' as const, formulae: ['"A,B"'] };
		const modifiedRule = { type: 'list' as const, formulae: ['"A,B,C"'] };

		deepStrictEqual(buildDataValidationDiff(
			[{ range: { minR: 10, maxR: 20, minC: 16_384, maxC: 16_384 }, validation: originalRule }],
			[
				{ range: { minR: 10, maxR: 20, minC: 16_384, maxC: 16_384 }, validation: modifiedRule },
				{ range: { minR: 3, maxR: 3, minC: 3, maxC: 3 }, validation: originalRule },
			],
		), [
			{ address: 'XFD10:XFD20', range: { minR: 10, maxR: 20, minC: 16_384, maxC: 16_384 }, status: 'modified', original: originalRule, modified: modifiedRule },
			{ address: 'C3', range: { minR: 3, maxR: 3, minC: 3, maxC: 3 }, status: 'added', modified: originalRule },
		]);
	});

	test('does not report a change when an equivalent validation range is split', () => {
		const rule = { type: 'list' as const, formulae: ['"A,B"'], allowBlank: false };

		deepStrictEqual(buildDataValidationDiff(
			[{ range: { minR: 1, maxR: 10, minC: 1, maxC: 1 }, validation: rule }],
			[
				{ range: { minR: 1, maxR: 5, minC: 1, maxC: 1 }, validation: { ...rule } },
				{ range: { minR: 6, maxR: 10, minC: 1, maxC: 1 }, validation: { ...rule } },
			],
		), []);

		deepStrictEqual(buildDataValidationDiff(
			[{ range: { minR: 1, maxR: 2, minC: 1, maxC: 4 }, validation: rule }],
			[
				{ range: { minR: 1, maxR: 1, minC: 1, maxC: 2 }, validation: rule },
				{ range: { minR: 1, maxR: 1, minC: 3, maxC: 4 }, validation: rule },
				{ range: { minR: 2, maxR: 2, minC: 1, maxC: 4 }, validation: rule },
			],
		), []);
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

	test('compares the text, text format, fill, and geometry of shapes', () => {
		const text = (value: string, bold = false) => ({ paragraphs: [{ runs: [{ text: value, ...(bold ? { bold: true } : {}) }] }], insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap: true });
		const box = (extra: Partial<IParadisRenderShape>) => lineShape({ type: 'rect', name: 'Box 1', geometry: 'rect', text: text('pending'), ...extra });
		const changed = buildShapeDiff([box({})], [box({ text: text('approved'), fill: '#E2F0D9', geometry: 'roundRect' })]);
		const formatOnly = buildShapeDiff([box({})], [box({ text: text('pending', true) })]);
		deepStrictEqual({
			status: changed.modifiedRenders[0].status,
			details: changed.modifiedRenders[0].diffDetails?.map(detail => [detail.kind, detail.original, detail.modified]),
			formatOnly: formatOnly.modifiedRenders[0].diffDetails?.map(detail => detail.kind),
			unchanged: buildShapeDiff([box({})], [box({})]).modifiedRenders[0].status,
		}, {
			status: 'changed',
			details: [['objectText', 'pending', 'approved'], ['objectFill', undefined, '#E2F0D9'], ['objectGeometry', 'rect', 'roundRect']],
			formatOnly: ['objectTextFormat'],
			unchanged: 'unchanged',
		});
	});

	test('keeps which characters carry which format, and shows where a long text starts to differ', () => {
		const runs = (...parts: [string, boolean][]) => ({ paragraphs: [{ runs: parts.map(([text, bold]) => ({ text, ...(bold ? { bold: true } : {}) })) }], insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap: true });
		const box = (text: IParadisRenderShape['text']) => lineShape({ type: 'rect', name: 'Box 1', geometry: 'rect', text });
		const swapped = buildShapeDiff([box(runs(['AB', true], ['CD', false]))], [box(runs(['AB', false], ['CD', true]))]).modifiedRenders[0].diffDetails ?? [];
		const merged = buildShapeDiff([box(runs(['AB', true], ['CD', true]))], [box(runs(['ABCD', true]))]).modifiedRenders[0].status;
		const head = 'x'.repeat(600);
		const long = buildShapeDiff([box(runs([`${head}old tail`, false]))], [box(runs([`${head}new tail`, false]))]).modifiedRenders[0].diffDetails?.find(detail => detail.kind === 'objectText');
		deepStrictEqual({
			swapped: swapped.map(detail => [detail.kind, detail.original, detail.modified]),
			merged,
			long: [long?.original?.startsWith('…') && long.original.includes('old tail'), long?.modified?.startsWith('…') && long.modified.includes('new tail'), (long?.original?.length ?? 0) <= 512],
		}, {
			swapped: [['objectTextFormat', '2: bold / 2: default | top left', '2: default / 2: bold | top left']],
			merged: 'unchanged',
			long: [true, true, true],
		});
	});

	test('pairs shapes that share a name by id, then by position, without losing either', () => {
		const named = (extra: Partial<IParadisRenderShape>) => lineShape({ name: 'Arrow', ...extra });
		const lower = { from: { c: 0, co: 0, r: 5, ro: 0 }, to: { c: 1, co: 0, r: 6, ro: 0 } };
		const byId = buildShapeDiff([named({ shapeId: '1' }), named({ shapeId: '2', ...lower })], [named({ shapeId: '2', ...lower, outlineColor: '#FF0000' }), named({ shapeId: '1' })]);
		const byPosition = buildShapeDiff([named({}), named(lower)], [named({ ...lower, outlineColor: '#FF0000' }), named({})]);
		const extra = buildShapeDiff([named({})], [named({}), named(lower)]);
		// Copied shapes can share an id as well as a name: the pair that also keeps its position comes first.
		const sharedId = buildShapeDiff([named({ shapeId: '5' }), named({ shapeId: '5', ...lower })], [named({ shapeId: '5', ...lower }), named({ shapeId: '5', outlineColor: '#FF0000' })]);
		const many = Array.from({ length: 2_000 }, (_, index) => named({ shapeId: String(index), from: { c: 0, co: 0, r: index, ro: 0 }, to: { c: 1, co: 0, r: index + 1, ro: 0 } }));
		const manyChanges = buildShapeDiff(many, [...many].reverse()).changes.length;
		const summary = (diff: ReturnType<typeof buildShapeDiff>) => ({
			original: diff.originalRenders.map(render => render.status),
			modified: diff.modifiedRenders.map(render => render.status),
			changes: diff.changes.map(change => [change.key, change.status]),
		});
		deepStrictEqual([summary(byId), summary(byPosition), summary(extra), summary(sharedId), manyChanges], [
			{ original: ['unchanged', 'changed'], modified: ['changed', 'unchanged'], changes: [['Arrow#2', 'changed']] },
			{ original: ['unchanged', 'changed'], modified: ['changed', 'unchanged'], changes: [['Arrow#2', 'changed']] },
			{ original: ['unchanged'], modified: ['unchanged', 'added'], changes: [['Arrow#2', 'added']] },
			{ original: ['changed', 'unchanged'], modified: ['unchanged', 'changed'], changes: [['Arrow', 'changed']] },
			0,
		]);
	});

	test('compares adjust values by guide name and leaves out the preset defaults', () => {
		const shape = (geometry: string, adjust?: Record<string, number>) => lineShape({ type: 'rect', name: 'Box 1', geometry, ...(adjust ? { adjust } : {}) });
		const details = (before: IParadisRenderShape, after: IParadisRenderShape) => buildShapeDiff([before], [after]).modifiedRenders[0].diffDetails?.map(detail => [detail.kind, detail.original, detail.modified]);
		deepStrictEqual({
			explicitDefault: details(shape('roundRect'), shape('roundRect', { adj: 16667 })),
			reordered: details(shape('downArrow', { adj2: 30000, adj1: 40000 }), shape('downArrow', { adj1: 40000, adj2: 30000 })),
			changed: details(shape('roundRect'), shape('roundRect', { adj: 20000 })),
			aliasDefault: details(shape('upArrow'), shape('upArrow', { adj1: 50000, adj2: 50000 })),
		}, {
			explicitDefault: undefined,
			reordered: undefined,
			changed: [['objectGeometry', 'roundRect', 'roundRect (adj=20000)']],
			aliasDefault: undefined,
		});
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
		strictEqual(title.textContent, '枠線の色: #000000 → #ff0000');
	});
	// ── 改ページ(ページ区切り)の差分 ──

	/** 行ごとに 1 セルだけ値を持つシートを作る。改ページの対応付けは「区切りの直後の行の中身」を見る。 */
	function pageSheet(values: readonly string[], breaks: { rows?: readonly number[]; cols?: readonly number[] } = {}): IParadisSheetData {
		const lastRow = values.length;
		const layout: IParadisPageLayout = {
			rowBands: [{ from: 1, to: lastRow, manual: false, size: 100 }],
			colBands: [{ from: 1, to: 2, manual: false, size: 100 }],
			autoRowBreaks: [],
			autoColBreaks: [],
			pageNumbers: [[1]],
			pageCount: 1,
			effectiveScale: 1,
			usableWidth: 500,
			usableHeight: 700,
		};
		return {
			name: 'Sheet1',
			rows: values.map((value, i) => ({ excelRow: i + 1, height: 20, cells: [cell(value)] })),
			columnCount: 1,
			columnWidths: [80],
			truncated: false,
			minCol: 1,
			...(breaks.rows ? { rowBreaks: breaks.rows } : {}),
			...(breaks.cols ? { colBreaks: breaks.cols } : {}),
			pageLayout: layout,
		};
	}

	test('同じ位置の改ページは、中身の手掛かりが無くても変更として報告しない', () => {
		// 列方向は区切りの直後の中身を手掛かりにできないので、位置一致だけが頼りになる。
		const original = pageSheet(['a', 'b', 'c', 'd'], { rows: [2], cols: [1] });
		const modified = pageSheet(['a', 'b', 'c', 'd'], { rows: [2], cols: [1] });
		const diff = buildPageBreakDiff(original, modified);
		deepStrictEqual(
			{
				changes: diff.changes.length,
				rowStatus: diff.modifiedRowLines.map(l => l.status),
				colStatus: diff.modifiedColLines.map(l => l.status),
			},
			{ changes: 0, rowStatus: ['unchanged'], colStatus: ['unchanged'] },
		);
	});

	test('行が増えて改ページの行番号がずれても、区切りの直後が同じ内容なら変更としない', () => {
		const original = pageSheet(['a', 'b', 'c', 'd'], { rows: [2] });
		const modified = pageSheet(['a', 'x', 'b', 'c', 'd'], { rows: [3] });
		const diff = buildPageBreakDiff(original, modified);
		deepStrictEqual(
			{ changes: diff.changes.length, status: diff.modifiedRowLines.map(l => l.status) },
			{ changes: 0, status: ['unchanged'] },
		);
	});

	test('改ページの追加と削除を見分ける', () => {
		const original = pageSheet(['a', 'b', 'c', 'd'], { rows: [1] });
		const modified = pageSheet(['a', 'b', 'c', 'd'], { rows: [1, 3] });
		const diff = buildPageBreakDiff(original, modified);
		deepStrictEqual(
			{
				statuses: diff.changes.map(c => c.status),
				indices: diff.changes.map(c => c.modifiedIndex ?? c.originalIndex),
				lines: diff.modifiedRowLines.map(l => `${l.index}:${l.status}`),
			},
			{ statuses: ['added'], indices: [3], lines: ['1:unchanged', '3:added'] },
		);
	});

	test('区切りが動いたときは移動として報告し、両側に印を付ける', () => {
		const original = pageSheet(['a', 'b', 'c', 'd'], { rows: [1] });
		const modified = pageSheet(['a', 'b', 'c', 'd'], { rows: [3] });
		const diff = buildPageBreakDiff(original, modified);
		deepStrictEqual(
			{
				statuses: diff.changes.map(c => c.status),
				from: diff.originalRowLines.map(l => l.status),
				to: diff.modifiedRowLines.map(l => l.status),
			},
			{ statuses: ['moved'], from: ['movedFrom'], to: ['movedTo'] },
		);
	});

	test('印刷対象範囲の外に取り残された改ページは扱わない', () => {
		// ページ割りは 4 行目までしか敷き詰めていないので、10 行目の下の区切りは Excel でも見えない。
		const original = pageSheet(['a', 'b', 'c', 'd'], { rows: [10] });
		const modified = pageSheet(['a', 'b', 'c', 'd'], { rows: [10] });
		const diff = buildPageBreakDiff(original, modified);
		deepStrictEqual(
			{ changes: diff.changes.length, lines: diff.modifiedRowLines.length },
			{ changes: 0, lines: 0 },
		);
	});

	test('片側のシートが無いときは何も描かない', () => {
		const diff = buildPageBreakDiff(pageSheet(['a'], { rows: [1] }), undefined);
		deepStrictEqual(
			{ changes: diff.changes.length, lines: diff.originalRowLines.length, labels: diff.originalLabels.length },
			{ changes: 0, lines: 0, labels: 0 },
		);
	});
});

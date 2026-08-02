/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPageLayoutInput,
	IParadisPageSetup,
	computePageLayout,
	pageRectangles,
	paperSizeToPt,
	parsePageSetup,
	parsePrintTitleRows,
} from '../../common/paradisSpreadsheetPageLayout.js';

/** A4 縦・余白なし・等倍。1 ページに載る高さは 841.89pt(=297mm)、幅は 595.28pt。 */
function setup(overrides: Partial<IParadisPageSetup> = {}): IParadisPageSetup {
	return {
		paperWidth: 595.28,
		paperHeight: 841.89,
		marginLeft: 0,
		marginRight: 0,
		marginTop: 0,
		marginBottom: 0,
		scale: 1,
		hasSavedScale: false,
		fitToPage: false,
		fitToWidth: 1,
		fitToHeight: 1,
		pageOrder: 'downThenOver',
		landscape: false,
		paperName: 'A4',
		...overrides,
	};
}

function input(overrides: Partial<IParadisPageLayoutInput> = {}): IParadisPageLayoutInput {
	return {
		setup: setup(),
		minRow: 1,
		rowHeights: [],
		minCol: 1,
		colWidths: [],
		manualRowBreaks: [],
		manualColBreaks: [],
		...overrides,
	};
}

/** 区切り位置の比較用に、区間を "from-to(手動|自動)" の一覧へ畳む。 */
function bandsOf(layout: ReturnType<typeof computePageLayout>, axis: 'row' | 'column' = 'row'): string[] {
	const bands = axis === 'row' ? layout.rowBands : layout.colBands;
	return bands.map(b => `${b.from}-${b.to}(${b.manual ? '手動' : '自動'})`);
}

suite('Paradis Spreadsheet Page Layout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('用紙に収まる分だけ行を詰めて自動改ページを入れる', () => {
		// 100pt の行が 10 行。1 ページに 8 行(800pt)まで載り、9 行目から次のページ。
		const layout = computePageLayout(input({ rowHeights: new Array(10).fill(100), colWidths: [100] }));
		deepStrictEqual(
			{ bands: bandsOf(layout), auto: layout.autoRowBreaks, pages: layout.pageCount },
			{ bands: ['1-8(自動)', '9-10(自動)'], auto: [8], pages: 2 },
		);
	});

	test('手動改ページはそこで必ず切り、自動改ページとしては報告しない', () => {
		const layout = computePageLayout(input({ rowHeights: new Array(10).fill(100), colWidths: [100], manualRowBreaks: [3] }));
		deepStrictEqual(
			{ bands: bandsOf(layout), auto: layout.autoRowBreaks },
			{ bands: ['1-3(手動)', '4-10(自動)'], auto: [] },
		);
	});

	test('1 行だけで用紙を超えてもその行だけで 1 ページにする(無限に切らない)', () => {
		const layout = computePageLayout(input({ rowHeights: [2000, 100], colWidths: [100] }));
		deepStrictEqual(bandsOf(layout), ['1-1(自動)', '2-2(自動)']);
	});

	test('行も列も無いシートはページ 0 として扱う', () => {
		const layout = computePageLayout(input());
		deepStrictEqual(
			{ rows: layout.rowBands.length, cols: layout.colBands.length, pages: layout.pageCount, auto: layout.autoRowBreaks },
			{ rows: 0, cols: 0, pages: 0, auto: [] },
		);
	});

	test('ページ番号は既定で「上から下、次に右」の順に振る', () => {
		const layout = computePageLayout(input({
			rowHeights: new Array(10).fill(100),
			colWidths: new Array(10).fill(100),
		}));
		deepStrictEqual(
			{ numbers: layout.pageNumbers, rects: pageRectangles(layout).map(r => `P${r.page}:r${r.fromRow}-${r.toRow},c${r.fromCol}-${r.toCol}`) },
			{
				numbers: [[1, 3], [2, 4]],
				rects: ['P1:r1-8,c1-5', 'P3:r1-8,c6-10', 'P2:r9-10,c1-5', 'P4:r9-10,c6-10'],
			},
		);
	});

	test('pageOrder=overThenDown ではページ番号が横向きに進む', () => {
		const layout = computePageLayout(input({
			setup: setup({ pageOrder: 'overThenDown' }),
			rowHeights: new Array(10).fill(100),
			colWidths: new Array(10).fill(100),
		}));
		deepStrictEqual(layout.pageNumbers, [[1, 2], [3, 4]]);
	});

	test('印刷タイトルの繰り返し行は 2 ページ目以降の高さを削る', () => {
		// 先頭 2 行(合計 200pt)を毎ページ繰り返すので、2 ページ目以降は 6 行しか載らない。
		const layout = computePageLayout(input({
			setup: setup({ repeatRowsFrom: 1, repeatRowsTo: 2 }),
			rowHeights: new Array(20).fill(100),
			colWidths: [100],
		}));
		deepStrictEqual(bandsOf(layout), ['1-8(自動)', '9-14(自動)', '15-20(自動)']);
	});

	test('印刷タイトルの指定が範囲の外でも落ちない', () => {
		const layout = computePageLayout(input({
			setup: setup({ repeatRowsFrom: 900, repeatRowsTo: 999 }),
			rowHeights: new Array(10).fill(100),
			colWidths: [100],
		}));
		deepStrictEqual(bandsOf(layout), ['1-8(自動)', '9-10(自動)']);
	});

	test('「n ページに収める」は縮小率を計算し、拡大はしない', () => {
		// 高さ 1683.78pt(=2 ページ分)を 1 ページに収めるので 50%。
		const fit = computePageLayout(input({
			setup: setup({ fitToPage: true, fitToWidth: 0, fitToHeight: 1 }),
			rowHeights: new Array(2).fill(841.89),
			colWidths: [100],
		}));
		// 収まっている場合は 100% のまま(拡大しない)。
		const small = computePageLayout(input({
			setup: setup({ fitToPage: true, fitToWidth: 0, fitToHeight: 1 }),
			rowHeights: [100],
			colWidths: [100],
		}));
		deepStrictEqual(
			{ fit: Math.round(fit.effectiveScale * 100), fitPages: fit.pageCount, small: small.effectiveScale },
			{ fit: 50, fitPages: 1, small: 1 },
		);
	});

	test('保存された倍率と計算値は小さい方を採る', () => {
		// 保存値 90% / 計算値 50% → 50%(「収める」を後から付けたブックでも縮小が効く)。
		const computed = computePageLayout(input({
			setup: setup({ fitToPage: true, fitToWidth: 0, fitToHeight: 1, scale: 0.9, hasSavedScale: true }),
			rowHeights: new Array(2).fill(841.89),
			colWidths: [100],
		}));
		// 保存値 40% / 計算値 50% → 40%(Excel が書き戻した実効倍率を尊重する)。
		const saved = computePageLayout(input({
			setup: setup({ fitToPage: true, fitToWidth: 0, fitToHeight: 1, scale: 0.4, hasSavedScale: true }),
			rowHeights: new Array(2).fill(841.89),
			colWidths: [100],
		}));
		deepStrictEqual(
			[Math.round(computed.effectiveScale * 100), Math.round(saved.effectiveScale * 100)],
			[50, 40],
		);
	});

	test('「収める」の指定が 0(=指定なし)でも 0 除算にならない', () => {
		const layout = computePageLayout(input({
			setup: setup({ fitToPage: true, fitToWidth: 0, fitToHeight: 0 }),
			rowHeights: new Array(10).fill(100),
			colWidths: [100],
		}));
		strictEqual(layout.effectiveScale, 1);
	});

	test('用紙設定を XML から読む(向きで縦横を入れ替え、余白は inch から pt へ)', () => {
		const parsed = parsePageSetup(
			'<worksheet><pageMargins left="1" right="0.5" top="0.25" bottom="0.25"/>'
			+ '<pageSetup paperSize="8" orientation="landscape" scale="80"/></worksheet>'
		);
		deepStrictEqual(
			{
				paper: [Math.round(parsed.paperWidth), Math.round(parsed.paperHeight)],
				margins: [parsed.marginLeft, parsed.marginRight],
				scale: parsed.scale,
				saved: parsed.hasSavedScale,
				landscape: parsed.landscape,
				name: parsed.paperName,
			},
			{ paper: [1191, 842], margins: [72, 36], scale: 0.8, saved: true, landscape: true, name: 'A3' },
		);
	});

	test('ユーザー設定ビューの用紙設定ではなく本体の用紙設定を読む', () => {
		const parsed = parsePageSetup(
			'<worksheet><customSheetViews><customSheetView><pageMargins left="9" right="9" top="9" bottom="9"/>'
			+ '<pageSetup paperSize="1" orientation="landscape" scale="10"/></customSheetView></customSheetViews>'
			+ '<pageMargins left="1" right="1" top="1" bottom="1"/>'
			+ '<pageSetup paperSize="9" orientation="portrait" scale="70"/></worksheet>'
		);
		deepStrictEqual(
			{ name: parsed.paperName, landscape: parsed.landscape, scale: parsed.scale, marginLeft: parsed.marginLeft },
			{ name: 'A4', landscape: false, scale: 0.7, marginLeft: 72 },
		);
	});

	test('用紙設定が無いシートは A4 縦・Excel 既定余白として扱う', () => {
		const parsed = parsePageSetup('<worksheet><sheetData/></worksheet>');
		deepStrictEqual(
			{ name: parsed.paperName, landscape: parsed.landscape, scale: parsed.scale, saved: parsed.hasSavedScale, fit: parsed.fitToPage },
			{ name: 'A4', landscape: false, scale: 1, saved: false, fit: false },
		);
	});

	test('未知の用紙コードは A4 とみなす', () => {
		deepStrictEqual(
			[paperSizeToPt(9).name, paperSizeToPt(66).name, paperSizeToPt(999).name, paperSizeToPt(undefined).name],
			['A4', 'A2', 'A4', 'A4'],
		);
	});

	test('印刷タイトル(繰り返す行)をシートごとに読む', () => {
		const xml = '<workbook><definedNames>'
			+ '<definedName name="_xlnm.Print_Titles" localSheetId="0">Sheet1!$1:$3</definedName>'
			+ '<definedName name="_xlnm.Print_Titles" localSheetId="1">Sheet2!$A:$B</definedName>'
			+ '</definedNames></workbook>';
		deepStrictEqual(
			[parsePrintTitleRows(xml, 0), parsePrintTitleRows(xml, 1), parsePrintTitleRows(xml, 2)],
			[{ from: 1, to: 3 }, undefined, undefined],
		);
	});
});

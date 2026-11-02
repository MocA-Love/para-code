/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisCellData, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import { ParadisSpreadsheetGridRenderer } from '../../browser/spreadsheet/paradisSpreadsheetGridRenderer.js';
import { collapseBorders, createVirtualGridIndex, createVirtualGridViewport, legacyGridTile, measureVirtualGridContentRows, relayoutVirtualGrid, virtualGridCopyText, virtualGridLayoutFrame, virtualGridRowTops } from '../../electron-browser/paradisSpreadsheetEditor.js';
import { applyOverflow, buildPageBreakOverlay, buildShapeOverlay, buildSheetTableDom, buildShownNoteOverlay, describeSheetPageBreaks } from '../../electron-browser/paradisSpreadsheetRender.js';

const empty: IParadisCellData = { value: '', style: {} };
const text = (value: string, style: Record<string, string> = {}): IParadisCellData => ({ value, style });

/**
 * B 列から始まり、4 行目が隠れた（excelRow が飛ぶ）シート。1 行目に右へはみ出す長い文字と右寄せの左へはみ出す文字、
 * 2〜3 行目に 2×2 の結合、1 行 1 列を固定する。
 */
function sheet(): IParadisSheetData {
	const merged: IParadisCellData = { value: '結合', style: {}, rowSpan: 2, colSpan: 2 };
	const covered: IParadisCellData = { value: '', style: {}, hidden: true };
	return {
		name: 'Parity',
		minCol: 2,
		columnCount: 5,
		columnWidths: [60, 60, 60, 60, 60],
		truncated: false,
		freezePane: { rows: 1, cols: 1 },
		rows: [
			{ excelRow: 1, height: 20, cells: [text('とても長い文字が右へはみ出す'), empty, empty, empty, text('右寄せで左へ', { textAlign: 'right' })] },
			{ excelRow: 2, height: 20, cells: [text('a'), merged, covered, empty, empty] },
			{ excelRow: 3, height: 20, cells: [text('b'), covered, covered, empty, empty] },
			{ excelRow: 5, height: 24, cells: [text('c'), empty, empty, empty, text('d')] },
		],
	};
}

/** 本番の CSS を読み込む（見た目の比較は CSS 込みで行う）。 */
function loadStylesheet(relative: string): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = new URL(relative, import.meta.url).href;
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`failed to load ${relative}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

suite('paradisSpreadsheet virtual grid parity with the table', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let stylesheets: HTMLLinkElement[] = [];
	suiteSetup(async () => {
		stylesheets = await Promise.all([
			loadStylesheet('../../electron-browser/media/paradisSpreadsheet.css'),
			loadStylesheet('../../browser/spreadsheet/media/paradisSpreadsheetGrid.css'),
		]);
	});
	suiteTeardown(() => {
		for (const link of stylesheets) {
			link.remove();
		}
	});

	test('draws the same headers, frozen panes, overflow and merges as the table', async () => {
		const data = sheet();
		const doc = mainWindow.document;

		// 今の描き方（DOM の表）
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		applyOverflow(dom.overflowCells);
		// 列幅を超えて広げたものだけ（収まる文字は広げない）
		const tableOverflow = dom.overflowCells.filter(item => item.span.style.width).map(item => [item.span.textContent, item.span.style.width, item.span.style.left, item.span.style.right]);
		const mergedTd = [...dom.table.querySelectorAll('td')].find(cell => cell.textContent === '結合')!.getBoundingClientRect();
		const tableResult = {
			columnHeaders: dom.headCells.map(cell => cell.textContent),
			rowHeaders: dom.dataRows.map(row => row.tr.firstElementChild?.textContent),
			overflow: tableOverflow,
		};

		// 仮想グリッド
		const gridHost = doc.body.appendChild(doc.createElement('div'));
		gridHost.style.width = '600px';
		gridHost.style.height = '200px';
		gridHost.style.overflow = 'auto';
		gridHost.style.position = 'relative';
		gridHost.classList.add('paradis-spreadsheet-virtual-excel');
		const viewport = createVirtualGridViewport(data, 17, 'parity', measureVirtualGridContentRows(gridHost, data));
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true, measureCell: () => ({ width: 1, height: 1 }) }));
		const plan = await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 200 });
		const cells = [...gridHost.querySelectorAll<HTMLElement>('.paradis-spreadsheet-virtual-cell')];
		const byClass = (className: string) => cells.filter(cell => cell.classList.contains(className)).sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row) || Number(a.dataset.column) - Number(b.dataset.column)).map(cell => cell.textContent);
		const gridOverflow = [...gridHost.querySelectorAll<HTMLElement>('.paradis-spreadsheet-overflow')]
			.filter(span => span.style.width)
			.map(span => [span.textContent, span.style.width, span.style.left, span.style.right]);
		const mergedCell = cells.find(cell => cell.textContent === '結合');
		const mergedRect = mergedCell?.getBoundingClientRect();
		const gridResult = {
			columnHeaders: byClass('paradis-spreadsheet-virtual-colhead'),
			rowHeaders: byClass('paradis-spreadsheet-virtual-rowhead'),
			overflow: gridOverflow,
		};

		// 結合の起点（データの 2 行目・2 列目）より下・右から始まる範囲のタイルにも、起点が入る
		const shifted = legacyGridTile(data, { id: 1, generation: 1, revision: 'parity', pane: 'body', range: [3, 3, 5, 6] }, index);
		tableHost.remove();
		gridHost.remove();

		deepStrictEqual({
			table: tableResult,
			grid: gridResult,
			frozen: plan.panes.map(pane => [pane.kind, pane.range[0] < 2 && pane.range[2] >= 2 ? 'covers frozen rows' : pane.range]).filter(([kind]) => kind === 'corner'),
			// 結合の大きさは DOM の表の td と比べる（境目の罫線の 1px の差まで）
			merged: mergedCell && mergedRect ? [Math.abs(mergedRect.width - mergedTd.width) <= 1, Math.abs(mergedRect.height - mergedTd.height) <= 1, mergedCell.getAttribute('aria-rowspan'), mergedCell.getAttribute('aria-colspan')] : undefined,
			shiftedTileHasAnchor: shifted.cells.some(cell => cell.text === '結合' && cell.row === 2 && cell.column === 2),
		}, {
			table: {
				columnHeaders: ['B', 'C', 'D', 'E', 'F'],
				rowHeaders: ['1', '2', '3', '5'],
				overflow: [['とても長い文字が右へはみ出す', '239px', '0px', ''], ['右寄せで左へ', '239px', '', '0px']],
			},
			grid: {
				columnHeaders: ['B', 'C', 'D', 'E', 'F'],
				rowHeaders: ['1', '2', '3', '5'],
				overflow: [['とても長い文字が右へはみ出す', '239px', '0px', ''], ['右寄せで左へ', '239px', '', '0px']],
			},
			frozen: [['corner', 'covers frozen rows']],
			merged: [true, true, '2', '2'],
			shiftedTileHasAnchor: true,
		});
	});

	test('scales the cells with their text and keeps the logical position across a zoom change', async () => {
		const data = sheet();
		const doc = mainWindow.document;
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '200px';
		host.style.height = '60px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const index = createVirtualGridIndex(data);
		const first = createVirtualGridViewport(data, 17, 'zoom');
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, first, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true, measureCell: () => ({ width: 1, height: 1 }), zoom: 2 }));
		await renderer.render({ scrollTop: 30, scrollLeft: 40, width: 100, height: 30 });
		const sizer = host.querySelector<HTMLElement>('.paradis-spreadsheet-virtual-sizer');
		const atTwo = { zoom: sizer?.style.zoom, containerScroll: [host.scrollTop, host.scrollLeft], frame: [renderer.frame.scrollTop, renderer.frame.scrollLeft] };
		// 描き直し（倍率を変える）では、見ていたセルの位置を新しい viewport で取り直す（エディタと同じ手順）
		const anchor = first.logicalAnchor(renderer.frame);
		const second = createVirtualGridViewport(data, 17, 'zoom');
		const restored = second.remeasure({}, anchor);
		host.remove();
		deepStrictEqual({ atTwo, restored }, {
			atTwo: { zoom: '2', containerScroll: [60, 80], frame: [30, 40] },
			restored: { scrollTop: 30, scrollLeft: 40 },
		});
	});

	test('keeps frozen panes in place after scrolling, stops overflow at the frozen edge, and sizes diagonals and layout by the zoom', async () => {
		const data = sheet();
		const doc = mainWindow.document;
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '200px';
		host.style.height = '80px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const index = createVirtualGridIndex(data);
		const viewport = createVirtualGridViewport(data, 17, 'frozen');
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, viewport, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true }));
		await renderer.render({ scrollTop: 30, scrollLeft: 70, width: 200, height: 80 });
		const hostRect = host.getBoundingClientRect();
		const find = (row: number, column: number) => host.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${row}"][data-column="${column}"]`)!;
		// 列記号 B（固定列）と行番号 1（固定行）は、スクロールしても入れ物の左上に残る
		const corner = find(0, 0).getBoundingClientRect();
		const frozenColumnHeader = find(0, 1).getBoundingClientRect();
		const frozenRowHeader = find(1, 0).getBoundingClientRect();
		const frozen = [Math.round(corner.left - hostRect.left), Math.round(corner.top - hostRect.top), Math.round(frozenColumnHeader.top - hostRect.top), Math.round(frozenRowHeader.left - hostRect.left)];

		// 固定列（データの 1 列目）の長い文字は、固定枠のタイルでは境目より右へはみ出さない
		const leftTile = legacyGridTile(data, { id: 1, generation: 1, revision: 'frozen', pane: 'corner', range: [0, 0, 2, 2] }, index);
		const bodyTile = legacyGridTile(data, { id: 2, generation: 1, revision: 'frozen', pane: 'top', range: [0, 2, 2, 6] }, index);
		const frozenSource = leftTile.cells.find(cell => cell.text.startsWith('とても長い'));
		const bodySource = bodyTile.cells.find(cell => cell.text.startsWith('とても長い'));
		host.remove();

		// 倍率 0.5 の斜線は、倍率を掛ける前のセルの大きさで描く
		const diagonalHost = doc.body.appendChild(doc.createElement('div'));
		diagonalHost.style.width = '300px';
		diagonalHost.style.height = '100px';
		diagonalHost.style.overflow = 'auto';
		diagonalHost.style.position = 'relative';
		diagonalHost.classList.add('paradis-spreadsheet-virtual-excel');
		const diagonalData: IParadisSheetData = { ...sheet(), freezePane: undefined, rows: [{ excelRow: 1, height: 40, cells: [{ value: '', style: {}, diagonal: { up: false, down: true, style: 'thin', color: '#000000' } }, empty, empty, empty, empty] }] };
		const diagonalIndex = createVirtualGridIndex(diagonalData);
		const diagonalRenderer = store.add(new ParadisSpreadsheetGridRenderer(diagonalHost, createVirtualGridViewport(diagonalData, 17, 'diagonal'), { getViewport: async request => legacyGridTile(diagonalData, request, diagonalIndex), copyFocusedCell: true, zoom: 0.5 }));
		await diagonalRenderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 200 });
		const svg = diagonalHost.querySelector('svg.paradis-spreadsheet-diagonal');
		const diagonal = svg ? [svg.getAttribute('width'), svg.getAttribute('height')] : undefined;
		diagonalHost.remove();

		deepStrictEqual({
			frozen,
			frozenOverflow: frozenSource?.overflow ? [frozenSource.overflow.rightRoom, frozenSource.overflow.toColumn] : 'none',
			bodyOverflow: bodySource?.overflow ? [bodySource.overflow.rightRoom, bodySource.overflow.toColumn] : 'none',
			diagonal,
			// エディタの大きさが変わったとき（layout）の frame は、入れ物の大きさを倍率で割る
			layout: virtualGridLayoutFrame({ scrollTop: 10, scrollLeft: 20, width: 1, height: 1 }, 400, 300, 0.5),
		}, {
			frozen: [0, 0, 0, 0],
			frozenOverflow: 'none',
			bodyOverflow: [180, 5],
			diagonal: ['60', '40'],
			layout: { scrollTop: 10, scrollLeft: 20, width: 800, height: 600 },
		});
	});

	test('draws the same table styles, filter marker, data bar, vertical position, single borders and wrapped row height as the table', async () => {
		const border = '1px solid rgb(0, 0, 0)';
		const longText = '折り返す長い文字です。折り返す長い文字です。折り返す長い文字です。';
		const data: IParadisSheetData = {
			name: 'Styles', minCol: 1, columnCount: 3, columnWidths: [80, 80, 80], truncated: false,
			tables: [{ name: 'T', range: { minR: 1, minC: 1, maxR: 3, maxC: 2 }, headerRow: true, totalsRow: false, showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false }],
			filterRanges: [{ minR: 1, minC: 1, maxR: 3, maxC: 2 }],
			rows: [
				{ excelRow: 1, height: 20, cells: [text('見出し', { borderBottom: border }), text('列'), text('上', { verticalAlign: 'top' })] },
				{ excelRow: 2, height: 20, cells: [text('1', { borderTop: border, backgroundImage: 'linear-gradient(to right, rgb(99, 142, 198) 50%, transparent 50%)' }), text('2'), { value: longText, style: {}, wrapText: true }] },
				{ excelRow: 3, height: 20, cells: [text('3'), text('4'), text('中', { verticalAlign: 'middle' })] },
			],
		};
		const doc = mainWindow.document;
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const td = (row: number, column: number) => dom.dataRows[row].tr.children[column + 1] as HTMLElement;
		const roles = (element: HTMLElement) => ['paradis-spreadsheet-table-header', 'paradis-spreadsheet-table-stripe'].filter(name => element.classList.contains(name));
		const tableRowHeight = dom.dataRows[1].tr.getBoundingClientRect().height;
		const tableResult = {
			roles: [roles(td(0, 0)), roles(td(1, 0)), roles(td(2, 0))],
			filter: [td(0, 0).querySelector('.paradis-spreadsheet-filter-marker') !== null, td(1, 0).querySelector('.paradis-spreadsheet-filter-marker') !== null],
			dataBar: td(1, 0).style.backgroundImage !== '',
			valign: [td(0, 2).style.verticalAlign, td(2, 2).style.verticalAlign],
		};

		const gridHost = doc.body.appendChild(doc.createElement('div'));
		gridHost.style.width = '600px';
		gridHost.style.height = '300px';
		gridHost.style.overflow = 'auto';
		gridHost.style.position = 'relative';
		gridHost.classList.add('paradis-spreadsheet-virtual-excel');
		const viewport = createVirtualGridViewport(data, 17, 'styles', measureVirtualGridContentRows(gridHost, data));
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true, measureCell: () => ({ width: 1, height: 1 }) }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 300 });
		const cell = (row: number, column: number) => gridHost.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${row + 1}"][data-column="${column + 1}"]`)!;
		const gridResult = {
			roles: [roles(cell(0, 0)), roles(cell(1, 0)), roles(cell(2, 0))],
			filter: [cell(0, 0).classList.contains('paradis-spreadsheet-virtual-filter'), cell(1, 0).classList.contains('paradis-spreadsheet-virtual-filter')],
			dataBar: cell(1, 0).style.backgroundImage !== '',
			valign: [cell(0, 2).classList.contains('paradis-spreadsheet-virtual-valign-top') ? 'top' : '', cell(2, 2).classList.contains('paradis-spreadsheet-virtual-valign-middle') ? 'middle' : ''],
		};
		// 罫線は 1 本: 上のセルの下の辺だけが描き、下のセルの上の辺は描かない
		const borders = { upperBottom: cell(0, 0).style.borderBottom, lowerTop: cell(1, 0).style.borderTop };
		const wrappedRow = viewport.cellBounds(2, 3).height;
		// 文字を選んでいないコピーは、フォーカスのあるセルの値になる
		await renderer.revealCell(2, 1);
		const copied: string[] = [];
		const copy = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true });
		gridHost.dispatchEvent(copy);
		copied.push(copy.clipboardData?.getData('text/plain') ?? '');
		tableHost.remove();
		gridHost.remove();

		deepStrictEqual({
			table: tableResult,
			grid: gridResult,
			borders,
			wrappedRowGrows: wrappedRow > 20 && Math.abs(wrappedRow - tableRowHeight) <= 2,
			copied,
		}, {
			table: { roles: [['paradis-spreadsheet-table-header'], ['paradis-spreadsheet-table-stripe'], []], filter: [true, false], dataBar: true, valign: ['top', 'middle'] },
			grid: { roles: [['paradis-spreadsheet-table-header'], ['paradis-spreadsheet-table-stripe'], []], filter: [true, false], dataBar: true, valign: ['top', 'middle'] },
			borders: { upperBottom: border, lowerTop: '' },
			wrappedRowGrows: true,
			copied: ['1'],
		});
	});

	test('measures rows only when shown, grows rows with only vertical text, keeps frozen tiles to frozen columns, and relayouts by the zoom', async () => {
		const doc = mainWindow.document;
		const data = sheet();
		// 画面に出ていない入れ物では測れない（0 で伸ばさずに覚えると、出た後も低いままになる）
		const detached = doc.createElement('div');
		const notShown = measureVirtualGridContentRows(detached, data);
		// 縦書きのセルだけの行も、文字に合わせて伸びる
		const shown = doc.body.appendChild(doc.createElement('div'));
		const vertical: IParadisSheetData = { ...data, freezePane: undefined, rows: [{ excelRow: 1, height: 20, cells: [{ value: '縦書きの長い文字', style: {}, verticalText: true }, empty, empty, empty, empty] }] };
		const verticalRow = measureVirtualGridContentRows(shown, vertical)?.get(0) ?? 0;
		shown.remove();
		// 固定列の枠のタイルは、スクロールする列の右寄せのセル（左へはみ出す）を拾わない
		const index = createVirtualGridIndex(data);
		const leftTile = legacyGridTile(data, { id: 1, generation: 1, revision: 'r', pane: 'left', range: [1, 0, 5, 2] }, index);
		const bodyTile = legacyGridTile(data, { id: 2, generation: 1, revision: 'r', pane: 'body', range: [1, 2, 5, 4] }, index);
		// layout() の本体: 倍率 0.5 で、入れ物の大きさを倍率で割った frame で描き直す
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '300px';
		host.style.height = '100px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, createVirtualGridViewport(data, 17, 'layout'), { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true, zoom: 0.5 }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 1, height: 1 });
		await relayoutVirtualGrid(renderer, host, { width: 999, height: 999 });
		const frame = renderer.frame;
		host.remove();

		deepStrictEqual({
			notShown,
			verticalGrows: verticalRow > 20,
			leftTileTakesScrollingSource: leftTile.cells.some(cell => cell.text === '右寄せで左へ'),
			bodyTileTakesIt: bodyTile.cells.some(cell => cell.text === '右寄せで左へ'),
			frame: [frame.width, frame.height],
		}, {
			notShown: undefined,
			verticalGrows: true,
			leftTileTakesScrollingSource: false,
			bodyTileTakesIt: true,
			frame: [600, 200],
		});
	});

	test('puts shapes, page breaks and page numbers at the same row positions as the table, inside the zoomed grid', async () => {
		const doc = mainWindow.document;
		const data: IParadisSheetData = {
			...sheet(),
			freezePane: undefined,
			rowBreaks: [2],
			colBreaks: [3],
			printArea: { minR: 1, minC: 2, maxR: 5, maxC: 5 },
			rows: [
				{ excelRow: 1, height: 20, cells: [text('abc'), text('123'), empty, empty, empty] },
				{ excelRow: 2, height: 20, cells: [text('和文の行'), empty, empty, empty, empty] },
				{ excelRow: 3, height: 30, cells: [text('x'), empty, empty, empty, empty] },
				{ excelRow: 5, height: 20, cells: [empty, empty, empty, empty, empty] },
			],
		};
		// 今の描き方: 行の位置は tr を測る（エディタの _placeGeometryOverlays と同じ）
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const tableTops = new Map<number, number>();
		for (const { excelRow, tr } of dom.dataRows) {
			tableTops.set(excelRow, tr.offsetTop);
		}
		const lastRow = dom.dataRows.at(-1)!;
		tableTops.set(lastRow.excelRow + 1, lastRow.tr.offsetTop + lastRow.tr.offsetHeight);
		const headerHeight = dom.thead.getBoundingClientRect().height;
		tableHost.remove();

		// 仮想グリッド: 行の位置は viewport から取る
		const gridHost = doc.body.appendChild(doc.createElement('div'));
		gridHost.style.width = '600px';
		gridHost.style.height = '300px';
		gridHost.style.overflow = 'auto';
		gridHost.style.position = 'relative';
		const viewport = createVirtualGridViewport(data, headerHeight, 'overlays', measureVirtualGridContentRows(gridHost, data));
		const gridTops = virtualGridRowTops(data, viewport);
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), zoom: 0.5 }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 1200, height: 600 });
		const { rowLines, colLines, labels } = describeSheetPageBreaks(data);
		const overlay = buildPageBreakOverlay(rowLines, colLines, data.printArea, labels, gridTops, data.columnWidths, data.minCol, doc);
		renderer.addDecorations(overlay.labels ? [overlay.labels] : [], overlay.lines ? [overlay.lines] : []);
		const sizer = gridHost.querySelector('.paradis-spreadsheet-virtual-sizer');
		const placed = { linesInZoomedGrid: !!overlay.lines && !!sizer?.contains(overlay.lines), linesInFront: overlay.lines?.style.zIndex };
		gridHost.remove();

		deepStrictEqual({
			// 英数字だけの行・和文の行・高さを指定した行のどれも、表の行と同じ位置（1px 以内）
			sameRowTops: [...tableTops].map(([row, top]) => [row, Math.abs((gridTops.get(row) ?? -100) - top) <= 1]),
			placed,
		}, {
			sameRowTops: [[1, true], [2, true], [3, true], [5, true], [6, true]],
			placed: { linesInZoomedGrid: true, linesInFront: '3' },
		});
	});

	test('aligns cells by computed style, resolves conflicting borders like border-collapse, and copies the clicked cell', async () => {
		const thin = '1px solid rgb(0, 0, 0)';
		const thick = '3px solid rgb(255, 0, 0)';
		const dashed = '1px dashed rgb(0, 0, 255)';
		const merged: IParadisCellData = { value: 'M', style: {}, rowSpan: 1, colSpan: 2 };
		const covered: IParadisCellData = { value: '', style: {}, hidden: true };
		const data: IParadisSheetData = {
			name: 'Borders', minCol: 1, columnCount: 5, columnWidths: [80, 0, 80, 80, 80], truncated: false,
			rows: [
				// A の右は細線、隣（幅 0 の隠れた列を挟んだ C）の左は太線 → 太線が勝つ。D と E は種類だけ違う → 実線が勝つ
				{ excelRow: 1, height: 20, cells: [text('top', { verticalAlign: 'top', borderRight: thin }), empty, text('', { borderLeft: thick }), text('', { borderRight: dashed }), text('', { borderLeft: thin })] },
				{ excelRow: 2, height: 20, cells: [text('middle', { verticalAlign: 'middle' }), empty, merged, covered, text('bottom')] },
				// 結合（C〜D）の下: D の上にだけ罫線がある → 結合の下の辺に出る
				{ excelRow: 3, height: 20, cells: [empty, empty, empty, text('', { borderTop: thick }), empty] },
			],
		};
		const doc = mainWindow.document;
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '600px';
		host.style.height = '200px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, createVirtualGridViewport(data, 17, 'borders'), { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 200 });
		const cell = (row: number, column: number) => host.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${row + 1}"][data-column="${column + 1}"]`)!;
		const justify = (row: number, column: number) => mainWindow.getComputedStyle(cell(row, column)).justifyContent;
		const copyAfterClicking = (element: HTMLElement) => {
			element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true, bubbles: true });
			element.dispatchEvent(event);
			return [event.defaultPrevented, event.clipboardData?.getData('text/plain') ?? ''];
		};
		const result = {
			valign: [justify(0, 0), justify(1, 0), justify(1, 4)],
			borders: {
				aRight: cell(0, 0).style.borderRight,
				cLeft: cell(0, 2).style.borderLeft,
				dRight: cell(0, 3).style.borderRight,
				mergedBottom: cell(1, 2).style.borderBottom,
			},
			copy: {
				clickedCell: copyAfterClicking(cell(1, 0)),
				header: copyAfterClicking(host.querySelector<HTMLElement>('.paradis-spreadsheet-virtual-colhead')!),
				emptyCell: copyAfterClicking(cell(2, 0)),
			},
		};
		host.remove();
		deepStrictEqual({
			...result,
			collapse: [
				collapseBorders([thin, thick]),
				collapseBorders([thick, thin]),
				collapseBorders([dashed, thin]),
				collapseBorders([thin, '1px solid rgb(0, 128, 0)']),
				collapseBorders(['none', thin]),
				collapseBorders([thick, '1px hidden rgb(0, 0, 0)']),
				collapseBorders([undefined, undefined]),
			],
		}, {
			valign: ['flex-start', 'center', 'flex-end'],
			borders: { aRight: thick, cLeft: '', dRight: thin, mergedBottom: thick },
			copy: { clickedCell: [true, 'middle'], header: [false, ''], emptyCell: [false, ''] },
			collapse: [thick, thick, thin, thin, thin, '1px hidden rgb(0, 0, 0)', undefined],
		});
	});

	test('leaves the CSV viewer as it was: no Excel vertical alignment and no copy of the focused cell', async () => {
		const doc = mainWindow.document;
		const data = sheet();
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '400px';
		host.style.height = '100px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		const index = createVirtualGridIndex(data);
		// CSV のビューアと同じく、Excel の入れ物のクラスも copyFocusedCell も付けない
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, createVirtualGridViewport(data, 17, 'csv'), { getViewport: async request => legacyGridTile(data, request, index) }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 400, height: 100 });
		const cell = host.querySelector<HTMLElement>('.paradis-spreadsheet-virtual-cell[data-row="2"][data-column="1"]')!;
		cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const copy = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true, bubbles: true });
		cell.dispatchEvent(copy);
		const display = mainWindow.getComputedStyle(cell).display;
		host.remove();
		deepStrictEqual({ display, copyIntercepted: copy.defaultPrevented }, { display: 'block', copyIntercepted: false });
	});

	test('grows the last row of a vertically merged wrapped cell like the table', async () => {
		const doc = mainWindow.document;
		const longText = '縦に結合した折り返しの長い文字です。'.repeat(6);
		const data: IParadisSheetData = {
			name: 'VerticalMerge', minCol: 1, columnCount: 2, columnWidths: [80, 80], truncated: false,
			rows: [
				{ excelRow: 1, height: 20, cells: [{ value: longText, style: {}, wrapText: true, rowSpan: 2 }, text('a')] },
				{ excelRow: 2, height: 20, cells: [{ value: '', style: {}, hidden: true }, text('b')] },
				{ excelRow: 3, height: 20, cells: [text('c'), text('d')] },
			],
		};
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const mergedTd = [...dom.table.querySelectorAll('td')].find(cell => cell.textContent === longText)!.getBoundingClientRect().height;
		tableHost.remove();
		const gridHost = doc.body.appendChild(doc.createElement('div'));
		gridHost.classList.add('paradis-spreadsheet-virtual-excel');
		const viewport = createVirtualGridViewport(data, 17, 'vertical-merge', measureVirtualGridContentRows(gridHost, data));
		gridHost.remove();
		const merged = viewport.cellBounds(1, 1, 2, 1).height;
		deepStrictEqual({ grows: merged > 40, sameAsTable: Math.abs(merged - mergedTd) <= 2 }, { grows: true, sameAsTable: true });
	});

	test('matches the table row by row: heights for Latin, CJK, bold and large text, and aria row and column numbers', async () => {
		const doc = mainWindow.document;
		const data: IParadisSheetData = {
			name: 'Rows', minCol: 3, columnCount: 4, columnWidths: [70, 70, 70, 70], truncated: false,
			rows: [
				{ excelRow: 1, height: 20, cells: [text('abc'), text('123'), empty, empty] },
				{ excelRow: 2, height: 20, cells: [text('和文だけ'), empty, empty, empty] },
				{ excelRow: 4, height: 20, cells: [text('Bold', { fontWeight: '700' }), text('Mixed 和'), empty, empty] },
				{ excelRow: 5, height: 20, cells: [text('Large', { fontSize: '18pt' }), empty, empty, empty] },
				{ excelRow: 7, height: 34, cells: [text('tall row'), empty, empty, empty] },
				{ excelRow: 8, height: 20, cells: [empty, empty, empty, text('last')] },
			],
		};
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const tableRows = dom.dataRows.map(({ excelRow, tr }) => ({ excelRow, height: tr.getBoundingClientRect().height, rowNumber: (tr as HTMLTableRowElement).rowIndex + 1 }));
		const tableLast = dom.dataRows.at(-1)!.tr.children[4] as HTMLTableCellElement;
		const table = { rowCount: dom.table.rows.length, columnCount: dom.headCells.length + 1, lastColumnNumber: tableLast.cellIndex + 1, headerHeight: dom.thead.getBoundingClientRect().height };
		tableHost.remove();

		const gridHost = doc.body.appendChild(doc.createElement('div'));
		gridHost.style.width = '600px';
		gridHost.style.height = '400px';
		gridHost.style.overflow = 'auto';
		gridHost.style.position = 'relative';
		gridHost.classList.add('paradis-spreadsheet-virtual-excel');
		const viewport = createVirtualGridViewport(data, table.headerHeight, 'rows', measureVirtualGridContentRows(gridHost, data));
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 400 });
		const firstCells = data.rows.map((_row, rowIndex) => gridHost.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${rowIndex + 1}"][data-column="1"]`));
		const last = gridHost.querySelector<HTMLElement>('.paradis-spreadsheet-virtual-cell[data-row="6"][data-column="4"]');
		const grid = {
			rowCount: Number(gridHost.getAttribute('aria-rowcount')),
			columnCount: Number(gridHost.getAttribute('aria-colcount')),
			lastColumnNumber: Number(last?.getAttribute('aria-colindex')),
		};
		gridHost.remove();

		deepStrictEqual({
			rows: tableRows.map((row, rowIndex) => ({
				excelRow: row.excelRow,
				sameHeight: Math.abs(viewport.cellBounds(rowIndex + 1, 1).height - row.height) <= 1,
				sameRowNumber: Number(firstCells[rowIndex]?.getAttribute('aria-rowindex')) === row.rowNumber,
			})),
			counts: { rowCount: grid.rowCount === table.rowCount, columnCount: grid.columnCount === table.columnCount, lastColumnNumber: grid.lastColumnNumber === table.lastColumnNumber },
		}, {
			rows: data.rows.map(row => ({ excelRow: row.excelRow, sameHeight: true, sameRowNumber: true })),
			counts: { rowCount: true, columnCount: true, lastColumnNumber: true },
		});
	});

	test('copies a selected range as the table does: tabs between cells, new lines between rows, merged values once, no frozen copies', async () => {
		const doc = mainWindow.document;
		const merged: IParadisCellData = { value: '結合', style: {}, colSpan: 2 };
		const covered: IParadisCellData = { value: '', style: {}, hidden: true };
		const data: IParadisSheetData = {
			name: 'Copy', minCol: 1, columnCount: 4, columnWidths: [60, 60, 0, 60], truncated: false,
			freezePane: { rows: 1, cols: 1 },
			rows: [
				{ excelRow: 1, height: 20, cells: [text('a1'), text('b1'), text('hidden'), text('d1')] },
				{ excelRow: 2, height: 20, cells: [text('a2'), merged, covered, text('d2')] },
				{ excelRow: 4, height: 20, cells: [text('a4'), empty, text('c4'), text('d4')] },
			],
		};
		// 今の描き方: 1 行の中で範囲を選んだときのブラウザの文字
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		// テストのページは文字を選べない設定なので、エディタと同じく選べるようにする
		tableHost.style.userSelect = 'text';
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const tds = (rowIndex: number) => [...dom.dataRows[rowIndex].tr.children].slice(1) as HTMLElement[];
		const selectInTable = (from: HTMLElement, to: HTMLElement) => {
			const range = doc.createRange();
			range.setStartBefore(from.firstChild ?? from);
			range.setEndAfter(to.lastChild ?? to);
			const selection = mainWindow.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			const value = selection.toString();
			selection.removeAllRanges();
			return value;
		};
		const tableRow = selectInTable(tds(0)[0], tds(0)[3]);
		const tableMergedRow = selectInTable(tds(1)[0], tds(1)[1]);
		tableHost.remove();

		// 仮想グリッド: ドラッグ・Shift+クリック・Shift+矢印で選んでコピー
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '400px';
		host.style.height = '200px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, createVirtualGridViewport(data, 17, 'copy'), {
			getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true, copyRange: range => virtualGridCopyText(data, range),
		}));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 400, height: 200 });
		// 固定枠（1 行 1 列）の複製があっても、同じセルは 1 つとして数える
		const cell = (row: number, column: number) => host.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${row + 1}"][data-column="${column + 1}"]`)!;
		const copy = () => {
			const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true, bubbles: true });
			host.dispatchEvent(event);
			return event.clipboardData?.getData('text/plain') ?? '';
		};
		const press = (target: HTMLElement, init: MouseEventInit) => target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...init }));
		// ドラッグで 1 行目の A〜D
		press(cell(0, 0), {});
		cell(0, 3).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
		doc.dispatchEvent(new MouseEvent('mouseup'));
		const dragged = copy();
		const selectedCount = host.querySelectorAll('.paradis-spreadsheet-virtual-selected').length;
		// Shift+クリックで 2 行目の A から結合（B〜C）まで
		press(cell(1, 0), {});
		press(cell(1, 1), { shiftKey: true });
		const shiftClicked = copy();
		// Shift+矢印で A1 から 3 行ぶん下へ
		press(cell(0, 0), {});
		host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
		host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
		const shiftArrows = copy();
		host.remove();

		deepStrictEqual({ dragged, shiftClicked, shiftArrows, selectedCount: selectedCount > 1 }, {
			dragged: tableRow,
			shiftClicked: tableMergedRow,
			shiftArrows: 'a1\na2\na4',
			selectedCount: true,
		});
		// 表のコピーでは、幅 0 の隠れた列は空の欄になる
		deepStrictEqual([tableRow, tableMergedRow], ['a1\tb1\t\td1', 'a2\t結合']);
	});

	test('places shapes and shown notes where the table does, moves them with the content under frozen panes, and centers search reveals', async () => {
		const doc = mainWindow.document;
		const base = sheet();
		const data: IParadisSheetData = {
			...base,
			columnWidths: [60, 60, 60, 60, 60],
			rows: [...base.rows, ...Array.from({ length: 30 }, (_unused, index) => ({ excelRow: 10 + index, height: 20, cells: [text(`r${index}`), empty, empty, empty, empty] }))],
			shapes: [{ type: 'line', flipV: false, flipH: false, from: { c: 1, co: 0, r: 1, ro: 0 }, to: { c: 3, co: 0, r: 3, ro: 0 }, outlineColor: '#ff0000', outlineWidth: 2, dash: 'solid' }],
			comments: [{ ref: 'D2', row: 1, column: 2, kind: 'note', entries: [{ author: 'A', text: 'メモ' }], shown: { from: { c: 3, co: 0, r: 0, ro: 0 }, to: { c: 4, co: 0, r: 2, ro: 0 } } }],
		};
		const firstDrawn = (overlay: Element | undefined) => overlay?.querySelector('line, path, rect, polyline, div') ?? overlay;
		const offsetFrom = (element: Element | null | undefined, origin: Element) => {
			const rect = element!.getBoundingClientRect();
			const at = origin.getBoundingClientRect();
			return [Math.round(rect.left - at.left), Math.round(rect.top - at.top)];
		};
		// 今の描き方: 行の位置は tr を測る（エディタの _placeGeometryOverlays と同じ）
		const tableHost = doc.body.appendChild(doc.createElement('div'));
		tableHost.style.position = 'relative';
		const dom = buildSheetTableDom(data);
		tableHost.appendChild(dom.table);
		const tableTops = new Map(dom.dataRows.map(({ excelRow, tr }) => [excelRow, tr.offsetTop] as const));
		const lastRow = dom.dataRows.at(-1)!;
		tableTops.set(lastRow.excelRow + 1, lastRow.tr.offsetTop + lastRow.tr.offsetHeight);
		const tableShape = buildShapeOverlay(data.shapes!, tableTops, data.columnWidths, data.minCol, doc)!;
		const tableNote = buildShownNoteOverlay(data.comments!, tableTops, data.columnWidths, data.minCol, doc)!;
		tableHost.append(tableShape, tableNote);
		const table = { shape: offsetFrom(firstDrawn(tableShape), dom.table), note: offsetFrom(firstDrawn(tableNote), dom.table) };
		const headerHeight = dom.thead.getBoundingClientRect().height;
		tableHost.remove();

		// 仮想グリッド: 行の位置は viewport から取る。固定枠（1 行 1 列）がある
		const host = doc.body.appendChild(doc.createElement('div'));
		host.style.width = '300px';
		host.style.height = '150px';
		host.style.overflow = 'auto';
		host.style.position = 'relative';
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const viewport = createVirtualGridViewport(data, headerHeight, 'shapes', measureVirtualGridContentRows(host, data));
		const tops = virtualGridRowTops(data, viewport);
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, viewport, { getViewport: async request => legacyGridTile(data, request, index), copyFocusedCell: true }));
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 150 });
		const gridShape = buildShapeOverlay(data.shapes!, tops, data.columnWidths, data.minCol, doc)!;
		const gridNote = buildShownNoteOverlay(data.comments!, tops, data.columnWidths, data.minCol, doc)!;
		renderer.addDecorations([], [gridShape, gridNote]);
		const sizer = host.querySelector('.paradis-spreadsheet-virtual-sizer')!;
		const grid = { shape: offsetFrom(firstDrawn(gridShape), sizer), note: offsetFrom(firstDrawn(gridNote), sizer) };
		// スクロールすると、重ね描きは中身と一緒に動く（固定枠には残らない）
		const before = offsetFrom(firstDrawn(gridShape), host);
		await renderer.render({ scrollTop: 40, scrollLeft: 50, width: 300, height: 150 });
		const after = offsetFrom(firstDrawn(gridShape), host);
		// 検索で移るときは、セルを本体の枠（固定枠を除いた部分）の中央に出す
		await renderer.revealCell(25, 3, true);
		const target = viewport.cellBounds(25, 3);
		const frame = renderer.frame;
		const frozen = viewport.cellBounds(2, 2);
		const bodyHeight = frame.height - frozen.top;
		const centeredRow = Math.abs(target.top - frozen.top - frame.scrollTop + target.height / 2 - bodyHeight / 2) <= 1;
		host.remove();

		// 縦に結合した折り返しは、図形・用紙設定のあるシート（判定で仮想グリッドに移るシート）でも同じに伸びる
		const mergeSheet: IParadisSheetData = {
			name: 'M', minCol: 1, columnCount: 2, columnWidths: [80, 80], truncated: false,
			rows: [
				{ excelRow: 1, height: 20, cells: [{ value: '縦に結合した折り返しの長い文字です。'.repeat(6), style: {}, wrapText: true, rowSpan: 2 }, text('a')] },
				{ excelRow: 2, height: 20, cells: [{ value: '', style: {}, hidden: true }, text('b')] },
			],
		};
		const probe = doc.body.appendChild(doc.createElement('div'));
		probe.classList.add('paradis-spreadsheet-virtual-excel');
		const plain = [...(measureVirtualGridContentRows(probe, mergeSheet) ?? new Map())];
		const withShapes = [...(measureVirtualGridContentRows(probe, { ...mergeSheet, shapes: data.shapes, printArea: { minR: 1, minC: 1, maxR: 2, maxC: 2 }, rowBreaks: [1] }) ?? new Map())];
		probe.remove();

		deepStrictEqual({
			shape: grid.shape.map((value, axis) => Math.abs(value - table.shape[axis]) <= 1),
			note: grid.note.map((value, axis) => Math.abs(value - table.note[axis]) <= 1),
			movedWithContent: [before[0] - after[0], before[1] - after[1]],
			centeredRow,
			mergeGrowsTheSame: plain.length > 0 && JSON.stringify(plain) === JSON.stringify(withShapes),
		}, {
			shape: [true, true],
			note: [true, true],
			movedWithContent: [50, 40],
			centeredRow: true,
			mergeGrowsTheSame: true,
		});
	});
});


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
import { createVirtualGridIndex, createVirtualGridViewport, legacyGridTile, measureVirtualGridContentRows, virtualGridLayoutFrame } from '../../electron-browser/paradisSpreadsheetEditor.js';
import { applyOverflow, buildSheetTableDom } from '../../electron-browser/paradisSpreadsheetRender.js';

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
		const viewport = createVirtualGridViewport(data, 17, 'parity', measureVirtualGridContentRows(gridHost, data));
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), measureCell: () => ({ width: 1, height: 1 }) }));
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
		const index = createVirtualGridIndex(data);
		const first = createVirtualGridViewport(data, 17, 'zoom');
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, first, { getViewport: async request => legacyGridTile(data, request, index), measureCell: () => ({ width: 1, height: 1 }), zoom: 2 }));
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
		const index = createVirtualGridIndex(data);
		const viewport = createVirtualGridViewport(data, 17, 'frozen');
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(host, viewport, { getViewport: async request => legacyGridTile(data, request, index) }));
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
		const diagonalData: IParadisSheetData = { ...sheet(), freezePane: undefined, rows: [{ excelRow: 1, height: 40, cells: [{ value: '', style: {}, diagonal: { up: false, down: true, style: 'thin', color: '#000000' } }, empty, empty, empty, empty] }] };
		const diagonalIndex = createVirtualGridIndex(diagonalData);
		const diagonalRenderer = store.add(new ParadisSpreadsheetGridRenderer(diagonalHost, createVirtualGridViewport(diagonalData, 17, 'diagonal'), { getViewport: async request => legacyGridTile(diagonalData, request, diagonalIndex), zoom: 0.5 }));
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
		const viewport = createVirtualGridViewport(data, 17, 'styles', measureVirtualGridContentRows(gridHost, data));
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), measureCell: () => ({ width: 1, height: 1 }) }));
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
});

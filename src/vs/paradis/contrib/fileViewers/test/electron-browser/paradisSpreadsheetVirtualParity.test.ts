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
import { createVirtualGridIndex, createVirtualGridViewport, legacyGridTile } from '../../electron-browser/paradisSpreadsheetEditor.js';
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

suite('paradisSpreadsheet virtual grid parity with the table', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

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
		const viewport = createVirtualGridViewport(data, 17, 'parity');
		const index = createVirtualGridIndex(data);
		const renderer = store.add(new ParadisSpreadsheetGridRenderer(gridHost, viewport, { getViewport: async request => legacyGridTile(data, request, index), measureCell: () => ({ width: 1, height: 1 }) }));
		const plan = await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 600, height: 200 });
		const cells = [...gridHost.querySelectorAll<HTMLElement>('.paradis-spreadsheet-virtual-cell')];
		const byClass = (className: string) => cells.filter(cell => cell.classList.contains(className)).sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row) || Number(a.dataset.column) - Number(b.dataset.column)).map(cell => cell.textContent);
		const gridOverflow = [...gridHost.querySelectorAll<HTMLElement>('.paradis-spreadsheet-overflow')]
			.filter(span => span.style.width)
			.map(span => [span.textContent, span.style.width, span.style.left, span.style.right]);
		const mergedCell = cells.find(cell => cell.textContent === '結合');
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
			merged: mergedCell ? [mergedCell.style.width, mergedCell.style.height, mergedCell.getAttribute('aria-rowspan'), mergedCell.getAttribute('aria-colspan')] : undefined,
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
			merged: ['120px', '40px', '2', '2'],
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
});

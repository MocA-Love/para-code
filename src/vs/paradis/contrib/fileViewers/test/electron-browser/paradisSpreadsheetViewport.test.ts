/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisCellData, IParadisSheetData } from '../../common/paradisSpreadsheet.js';
import type { ParadisSpreadsheetSheetAlignment } from '../../common/spreadsheet/paradisSpreadsheetSemanticDiff.js';
import {
	mapSpreadsheetLogicalAnchor,
	ParadisSpreadsheetViewport,
	type ParadisSpreadsheetTileRequest,
} from '../../browser/spreadsheet/paradisSpreadsheetViewport.js';
import {
	ParadisSpreadsheetGridRenderer,
	type ParadisSpreadsheetGridCell,
	type ParadisSpreadsheetGridTile,
} from '../../browser/spreadsheet/paradisSpreadsheetGridRenderer.js';
import { scaleSpreadsheetLogicalOffset } from '../../electron-browser/paradisSpreadsheetDiffEditor.js';
import { shouldVirtualizeSpreadsheetSheet } from '../../electron-browser/paradisSpreadsheetEditor.js';

function cellsForRequest(request: ParadisSpreadsheetTileRequest, cellFor: (row: number, column: number) => ParadisSpreadsheetGridCell = (row, column) => ({ row, column, text: `${row}:${column}` })): ParadisSpreadsheetGridCell[] {
	const cells: ParadisSpreadsheetGridCell[] = [];
	for (let row = request.range[0]; row < request.range[2]; row++) {
		for (let column = request.range[1]; column < request.range[3]; column++) {
			cells.push(cellFor(row, column));
		}
	}
	return cells;
}

function tileForRequest(request: ParadisSpreadsheetTileRequest, cellFor?: (row: number, column: number) => ParadisSpreadsheetGridCell): ParadisSpreadsheetGridTile {
	return { revision: request.revision, range: request.range, cells: cellsForRequest(request, cellFor) };
}

function largeProjection(cell: IParadisCellData = { value: '', style: {} }, overrides: Partial<IParadisSheetData> = {}): IParadisSheetData {
	return {
		name: 'Data',
		rows: Array.from({ length: 101 }, (_unused, index) => ({ excelRow: index + 1, height: 20, cells: Array.from({ length: 100 }, () => cell) })),
		columnCount: 100,
		columnWidths: Array.from({ length: 100 }, () => 80),
		truncated: false,
		minCol: 1,
		...overrides,
	};
}

suite('paradisSpreadsheetViewport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('bounds a 100,000-row by 16,384-column sheet to four panes and 10,000 live cells', () => {
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 100_000,
			columnCount: 16_384,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			rowMetrics: [{ index: 5_000, hidden: true }, { index: 5_001, collapsed: true }],
			columnMetrics: [{ index: 10_000, hidden: true }],
			frozenRows: 2,
			frozenColumns: 1,
			overscan: 120,
			maxLiveCells: 10_000,
			revision: 'revision-1',
		});

		const plan = viewport.plan({ scrollTop: 99_960, scrollLeft: 799_920, width: 1_000, height: 600 });

		deepStrictEqual(plan.panes.map(pane => pane.kind), ['corner', 'top', 'left', 'body']);
		ok(plan.liveCellCount <= 10_000);
		strictEqual(viewport.cellBounds(5_000, 10).height, 0);
		strictEqual(viewport.cellBounds(5_001, 10).height, 0);
		strictEqual(viewport.cellBounds(10, 10_000).width, 0);
		ok(plan.panes.every(pane => pane.tiles.every(tile => tile.range[2] <= 100_000 && tile.range[3] <= 16_384)));
	});

	test('preserves the logical anchor through row, column, resize, and font remeasurement', () => {
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 1_000,
			columnCount: 1_000,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			frozenRows: 1,
			frozenColumns: 1,
			revision: 'revision-1',
		});
		const frame = { scrollTop: 987, scrollLeft: 1_234, width: 800, height: 500 };
		const anchor = viewport.logicalAnchor(frame);

		const restored = viewport.remeasure({
			rows: [{ index: anchor.row, size: 47 }],
			columns: [{ index: anchor.column, size: 131 }],
		}, anchor);
		const after = viewport.logicalAnchor({ ...frame, ...restored });

		deepStrictEqual(after, anchor);
		strictEqual(viewport.measurementRevision, 1);
	});

	test('moves keyboard focus by logical visible cells and exposes spreadsheet edges', () => {
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 100,
			columnCount: 16_384,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			rowMetrics: [{ index: 3, hidden: true }, { index: 4, collapsed: true }],
			columnMetrics: [{ index: 2, hidden: true }],
			revision: 'revision-1',
		});

		deepStrictEqual(viewport.moveFocus({ row: 2, column: 1 }, 'ArrowDown'), { row: 5, column: 1 });
		deepStrictEqual(viewport.moveFocus({ row: 2, column: 1 }, 'ArrowRight'), { row: 2, column: 3 });
		deepStrictEqual(viewport.moveFocus({ row: 10, column: 10 }, 'Home', { ctrlKey: true }), { row: 0, column: 0 });
		deepStrictEqual(viewport.moveFocus({ row: 10, column: 10 }, 'End', { ctrlKey: true }), { row: 99, column: 16_383 });

		const hiddenOrigin = new ParadisSpreadsheetViewport({
			rowCount: 4,
			columnCount: 4,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			rowMetrics: [{ index: 0, hidden: true }],
			columnMetrics: [{ index: 0, collapsed: true }],
			revision: 'revision-1',
		});
		deepStrictEqual(hiddenOrigin.moveFocus({ row: 1, column: 1 }, 'ArrowUp'), { row: 1, column: 1 });
		deepStrictEqual(hiddenOrigin.moveFocus({ row: 1, column: 1 }, 'ArrowLeft'), { row: 1, column: 1 });
	});

	test('rejects stale, superseded, wrong-revision, and wrong-range tiles', () => {
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 100, columnCount: 100, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		const firstPlan = viewport.plan({ scrollTop: 0, scrollLeft: 0, width: 300, height: 200 });
		const tile = firstPlan.panes.find(pane => pane.kind === 'body')!.tiles[0];
		const first = viewport.beginTileRequest(tile);
		const second = viewport.beginTileRequest(tile);

		strictEqual(viewport.acceptsTile(first, { revision: first.revision, range: first.range }), false);
		strictEqual(viewport.acceptsTile(second, { revision: 'revision-old', range: second.range }), false);
		strictEqual(viewport.acceptsTile(second, { revision: second.revision, range: [0, 0, 1, 1] }), false);
		strictEqual(viewport.acceptsTile(second, { revision: second.revision, range: second.range }), true);
		viewport.setRevision('revision-2');
		strictEqual(viewport.acceptsTile(second, { revision: second.revision, range: second.range }), false);
	});

	test('maps Diff scroll anchors through Task 5 logical row and column alignment', () => {
		const alignment: ParadisSpreadsheetSheetAlignment = {
			originalName: 'Data', modifiedName: 'Data', matchedBy: 'name', certainty: 'exact',
			grid: {
				rows: [
					{ original: 10, modified: 12, status: 'moved', certainty: 'exact' },
					{ original: 11, modified: 13, status: 'aligned', certainty: 'exact' },
				],
				columns: [{ original: 5, modified: 7, status: 'moved', certainty: 'exact' }],
			},
		};

		deepStrictEqual(mapSpreadsheetLogicalAnchor({ row: 10, column: 5, rowOffset: 7, columnOffset: 9 }, alignment, 'original'), {
			row: 12, column: 7, rowOffset: 7, columnOffset: 9,
		});
		deepStrictEqual(mapSpreadsheetLogicalAnchor({ row: 13, column: 7, rowOffset: 2, columnOffset: 3 }, alignment, 'modified'), {
			row: 11, column: 5, rowOffset: 2, columnOffset: 3,
		});
		strictEqual(scaleSpreadsheetLogicalOffset(80, 100, 20), 16);
		strictEqual(scaleSpreadsheetLogicalOffset(120, 100, 20), 20);
	});

	test('keeps only shrink-to-fit and rich text on the existing renderer', () => {
		const shape = {
			type: 'line' as const, flipV: false, flipH: false,
			from: { c: 0, co: 0, r: 0, ro: 0 }, to: { c: 1, co: 0, r: 1, ro: 0 },
			outlineColor: '#000000', outlineWidth: 1, dash: 'solid' as const,
		};
		deepStrictEqual({
			plain: shouldVirtualizeSpreadsheetSheet(largeProjection()),
			small: shouldVirtualizeSpreadsheetSheet({ ...largeProjection(), rows: largeProjection().rows.slice(0, 10) }),
			richText: shouldVirtualizeSpreadsheetSheet(largeProjection({ value: 'rich', style: {}, richText: [{ text: 'rich', style: { fontWeight: 'bold' } }] })),
			shrinkToFit: shouldVirtualizeSpreadsheetSheet(largeProjection({ value: 'shrink', style: {}, shrinkToFit: true })),
			// 仮想グリッドも同じに描けるようになったもの
			noGridLines: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, { showGridLines: false })),
			shapes: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, { shapes: [shape] })),
			pageBreaks: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, { rowBreaks: [10], colBreaks: [5] })),
			printArea: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, { printArea: { minR: 1, minC: 1, maxR: 80, maxC: 20 } })),
			// xlsx のほぼ全シートに付く用紙設定
			pageLayout: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, {
				pageLayout: {
					rowBands: [{ from: 1, to: 50, manual: false, size: 750 }, { from: 51, to: 101, manual: false, size: 765 }],
					colBands: [{ from: 1, to: 100, manual: false, size: 4800 }],
					autoRowBreaks: [50], autoColBreaks: [], pageNumbers: [[1], [2]], pageCount: 2, effectiveScale: 1, usableWidth: 500, usableHeight: 700,
				},
			})),
			shownNote: shouldVirtualizeSpreadsheetSheet(largeProjection(undefined, {
				comments: [{ ref: 'A1', row: 0, column: 0, kind: 'note', entries: [], shown: { from: { c: 1, co: 0, r: 0, ro: 0 }, to: { c: 3, co: 0, r: 4, ro: 0 } } }],
			})),
		}, {
			plain: true, small: false, richText: false, shrinkToFit: false,
			noGridLines: true, shapes: true, pageBreaks: true, printArea: true, pageLayout: true, shownNote: true,
		});
	});
});

suite('paradisSpreadsheetGridRenderer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reveals a logical cell through measured viewport geometry', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet logical reveal');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 100,
			columnCount: 50,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			rowMetrics: [{ index: 30, size: 47 }],
			columnMetrics: [{ index: 20, size: 131 }],
			revision: 'revision-1',
		});
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, { getViewport: async request => tileForRequest(request) });
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 200 });

		await (renderer as unknown as { revealCell(row: number, column: number): Promise<void> }).revealCell(30, 20);

		const bounds = viewport.cellBounds(30, 20);
		strictEqual(renderer.frame.scrollTop, bounds.top + bounds.height - 200);
		strictEqual(renderer.frame.scrollLeft, bounds.left + bounds.width - 300);
		strictEqual(container.getAttribute('aria-activedescendant')?.includes('-30-20'), true);
		renderer.dispose();
	});

	test('groups the cells of each row across panes, keeps one tab stop and marks the focused cell and its headers', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet rows');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 3,
			columnCount: 3,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			frozenRows: 1,
			frozenColumns: 1,
			revision: 'revision-1',
		});
		const header = (row: number, column: number): ParadisSpreadsheetGridCell['header'] => row === 0 ? 'column' : column === 0 ? 'row' : undefined;
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request, (row, column) => ({ row, column, text: `${row}:${column}`, header: header(row, column), sort: row === 0 && column === 2 ? 'descending' : undefined })),
			copyFocusedCell: true,
		});
		renderer.setFocusedCell(1, 2);
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 100 });

		const owned = (id: string) => container.querySelector(`[id="${id}"]`)?.textContent;
		const rows = Array.from(container.querySelectorAll('[role="row"]'), row => `${row.getAttribute('aria-rowindex')}|${(row.getAttribute('aria-owns') ?? '').split(' ').map(owned).join(',')}`);
		const marked = (name: string) => Array.from(container.querySelectorAll(`.${name}`), cell => cell.textContent).sort();
		deepStrictEqual({
			rows,
			tabStops: Array.from(container.querySelectorAll<HTMLElement>('.paradis-spreadsheet-virtual-cell'), cell => cell.getAttribute('tabindex')).filter(index => index !== null),
			active: marked('paradis-spreadsheet-virtual-active'),
			headers: marked('paradis-spreadsheet-virtual-header-active'),
			activeDescendant: owned(container.getAttribute('aria-activedescendant')!),
			sort: Array.from(container.querySelectorAll('[aria-sort]'), cell => `${cell.textContent}|${cell.getAttribute('aria-sort')}`),
		}, {
			rows: ['1|0:0,0:1,0:2', '2|1:0,1:1,1:2', '3|2:0,2:1,2:2'],
			tabStops: [],
			active: ['1:2'],
			headers: ['0:2', '1:0'],
			activeDescendant: '1:2',
			sort: ['0:2|descending'],
		});
		renderer.dispose();
	});

	test('marks a focused header cell itself and does not darken the headers or the corner', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet header focus');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 3,
			columnCount: 3,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			frozenRows: 1,
			frozenColumns: 1,
			revision: 'revision-1',
		});
		const header = (row: number, column: number): ParadisSpreadsheetGridCell['header'] => row === 0 ? 'column' : column === 0 ? 'row' : undefined;
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request, (row, column) => ({ row, column, text: `${row}:${column}`, header: header(row, column) })),
			copyFocusedCell: true,
		});
		const marked = (name: string) => Array.from(container.querySelectorAll(`.${name}`), cell => cell.textContent).sort();
		renderer.setFocusedCell(2, 0);
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 100 });

		deepStrictEqual({ active: marked('paradis-spreadsheet-virtual-active'), headers: marked('paradis-spreadsheet-virtual-header-active') }, { active: ['2:0'], headers: [] });
		renderer.dispose();
	});

	test('renders reusable four-pane gridcells with bounded live DOM', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet virtual grid');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 100_000,
			columnCount: 16_384,
			defaultRowHeight: 20,
			defaultColumnWidth: 80,
			frozenRows: 2,
			frozenColumns: 1,
			maxLiveCells: 10_000,
			revision: 'revision-1',
		});
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request),
		});

		await renderer.render({ scrollTop: 50_000, scrollLeft: 70_000, width: 900, height: 500 });
		const firstCell = container.querySelector('[role="gridcell"]');
		await renderer.render({ scrollTop: 50_020, scrollLeft: 70_080, width: 900, height: 500 });

		deepStrictEqual(Array.from(container.querySelectorAll('.paradis-spreadsheet-virtual-pane'), pane => pane.getAttribute('data-pane')), ['corner', 'top', 'left', 'body']);
		strictEqual(Number.parseFloat((container.querySelector('[data-pane="body"]') as HTMLElement).style.width), viewport.totalWidth);
		strictEqual(Number.parseFloat((container.querySelector('[data-pane="body"]') as HTMLElement).style.height), viewport.totalHeight);
		ok(renderer.liveCellCount <= 10_000);
		ok(container.querySelector('[role="gridcell"]'));
		strictEqual(container.querySelector('[data-pane="corner"] [data-row="0"][data-column="0"]'), firstCell, 'overlapping cells are reused instead of replacing the pane tree');
		strictEqual(container.getAttribute('role'), 'grid');
		strictEqual(container.getAttribute('aria-rowcount'), '100000');
		strictEqual(container.getAttribute('aria-colcount'), '16384');
		renderer.dispose();
	});

	test('prunes before viewport replacement and reuses detached cell nodes without exceeding the live cap', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet cell pool');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: 1_000,
			columnCount: 1_000,
			defaultRowHeight: 10,
			defaultColumnWidth: 10,
			maxLiveCells: 50,
			overscan: 0,
			revision: 'revision-1',
		});
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, { getViewport: async request => tileForRequest(request) });
		let maximumLiveNodes = 0;
		for (const pane of Array.from(container.querySelectorAll('.paradis-spreadsheet-virtual-pane')) as HTMLElement[]) {
			const appendChild = pane.appendChild.bind(pane);
			pane.appendChild = node => {
				const result = appendChild(node);
				maximumLiveNodes = Math.max(maximumLiveNodes, container.querySelectorAll('[role="gridcell"]').length);
				return result;
			};
		}

		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 100, height: 100 });
		const firstGeneration = new Set(container.querySelectorAll('[role="gridcell"]'));
		await renderer.render({ scrollTop: 5_000, scrollLeft: 5_000, width: 100, height: 100 });
		const secondGeneration = new Set(container.querySelectorAll('[role="gridcell"]'));

		ok(maximumLiveNodes <= 50, `live DOM peaked at ${maximumLiveNodes}`);
		ok([...secondGeneration].some(node => firstGeneration.has(node)), 'non-overlapping viewport cells reuse the detached pool');
		strictEqual(renderer.liveCellCount, secondGeneration.size);
		renderer.dispose();
	});

	test('derives base and conditional diagonals once from current measured bounds', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet diagonal geometry');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 20, columnCount: 20, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		let measureCount = 0;
		let measured = { width: 83, height: 27 };
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request, (row, column) => row === 0 && column === 0 ? {
				row,
				column,
				text: '<img src=x onerror=alert(1)>',
				baseDiagonal: { up: true, down: false, style: '2px solid', color: '#123456' },
				conditionalDiagonal: { up: false, down: true, style: '1px dashed', color: '#abcdef' },
			} : { row, column, text: '' }),
			measureCell: () => {
				measureCount++;
				return measured;
			},
		});

		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 200 });
		const base = container.querySelector('.paradis-spreadsheet-diagonal-base line');
		const conditional = container.querySelector('.paradis-spreadsheet-diagonal-conditional line');

		strictEqual(measureCount, 1);
		deepStrictEqual([base?.getAttribute('x1'), base?.getAttribute('y1'), base?.getAttribute('x2'), base?.getAttribute('y2')], ['0', '27', '83', '0']);
		deepStrictEqual([conditional?.getAttribute('x1'), conditional?.getAttribute('y1'), conditional?.getAttribute('x2'), conditional?.getAttribute('y2')], ['0', '0', '83', '27']);
		strictEqual(container.querySelector('img,script'), null);
		strictEqual(container.querySelector('[role="gridcell"]')?.textContent, '<img src=x onerror=alert(1)>');

		measured = { width: 131, height: 41 };
		await renderer.remeasure({ rows: [{ index: 0, size: 41 }], columns: [{ index: 0, size: 131 }] });
		const resizedBase = container.querySelector('.paradis-spreadsheet-diagonal-base line');
		deepStrictEqual([resizedBase?.getAttribute('x1'), resizedBase?.getAttribute('y1'), resizedBase?.getAttribute('x2'), resizedBase?.getAttribute('y2')], ['0', '41', '131', '0']);
		strictEqual(measureCount, 2);
		renderer.dispose();
	});

	test('remeasures after resize and fonts-ready while retaining the logical anchor', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet remeasure');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 1_000, columnCount: 1_000, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		let resize: (() => void) | undefined;
		let resolveFonts: (() => void) | undefined;
		let size = 20;
		const fontsReady = new Promise<void>(resolve => resolveFonts = resolve);
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request),
			measureAxes: () => ({ rows: [{ index: 20, size }] }),
			observeResize: callback => {
				resize = callback;
				return { dispose() { resize = undefined; } };
			},
			fontsReady,
		});
		await renderer.render({ scrollTop: 410, scrollLeft: 800, width: 500, height: 300 });
		const anchor = viewport.logicalAnchor(renderer.frame);

		size = 35;
		resize!();
		await renderer.whenIdle();
		resolveFonts!();
		await fontsReady;
		await renderer.whenIdle();

		deepStrictEqual(viewport.logicalAnchor(renderer.frame), anchor);
		strictEqual(viewport.measurementRevision, 2);
		renderer.dispose();
	});

	test('delays safe media and drops it when the tile generation becomes stale', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet delayed media');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 10, columnCount: 10, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		const scheduled: (() => void)[] = [];
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request, (row, column) => ({ row, column, text: '', media: row === 0 && column === 0 ? { source: 'blob:trusted-preview', altText: 'Preview' } : undefined })),
			scheduleMedia: callback => {
				scheduled.push(callback);
				return { dispose() { /* the stale-generation fence is authoritative */ } };
			},
		});

		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 200, height: 100 });
		strictEqual(container.querySelector('img'), null);
		await renderer.render({ scrollTop: 100, scrollLeft: 100, width: 200, height: 100 });
		scheduled[0]();
		strictEqual(container.querySelector('img[src="blob:trusted-preview"]'), null);
		renderer.dispose();
	});

	test('draws once per frame however many scroll events arrive', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet coalesced scroll');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 100, columnCount: 100, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		const frames: (() => void)[] = [];
		let tiles = 0;
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => {
				tiles++;
				return tileForRequest(request);
			},
			scheduleFrame: callback => {
				frames.push(callback);
				return { dispose() { /* fired by the test */ } };
			},
		});
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 200, height: 100 });
		const tilesPerRender = tiles;
		for (let index = 0; index < 5; index++) {
			container.dispatchEvent(new mainWindow.Event('scroll'));
		}
		const queuedFrames = frames.length;
		frames.shift()!();
		await renderer.whenIdle();

		deepStrictEqual({ queuedFrames, renders: tiles / tilesPerRender }, { queuedFrames: 1, renders: 2 });
		renderer.dispose();
	});

	test('leaves cells whose content and place are unchanged alone and rewrites the ones that changed', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet unchanged cells');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 4, columnCount: 4, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		let changed = '';
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => tileForRequest(request, (row, column) => ({ row, column, text: row === 1 && column === 1 ? `1:1${changed}` : `${row}:${column}`, classNames: ['probe'] })),
		});
		const frame = { scrollTop: 0, scrollLeft: 0, width: 400, height: 100 };
		await renderer.render(frame);
		const cell = (row: number, column: number) => container.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!;
		cell(0, 0).style.opacity = '0.5';
		cell(1, 1).style.opacity = '0.5';
		changed = '!';
		await renderer.render(frame);

		deepStrictEqual(
			{ unchanged: cell(0, 0).style.opacity, changed: cell(1, 1).style.opacity, text: cell(1, 1).textContent },
			{ unchanged: '0.5', changed: '', text: '1:1!' },
		);
		renderer.dispose();
	});

	test('recovers queued rendering after a viewport tile is rejected', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet rejected tile');
		const container = document.createElement('div');
		const viewport = new ParadisSpreadsheetViewport({ rowCount: 100, columnCount: 100, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'revision-1' });
		let rejectTiles = true;
		const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
			getViewport: async request => {
				if (rejectTiles) {
					throw new Error('tile unavailable');
				}
				return tileForRequest(request);
			},
		});

		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 200, height: 100 });
		rejectTiles = false;
		container.scrollTop = 200;
		container.dispatchEvent(new mainWindow.Event('scroll'));
		await renderer.whenIdle();

		ok(renderer.liveCellCount > 0);
		renderer.dispose();
	});
});

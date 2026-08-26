/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisSpreadsheetAxisAlignmentEntry } from '../../common/spreadsheet/paradisSpreadsheetGridAlign.js';
import type { ParadisSpreadsheetSheetAlignment } from '../../common/spreadsheet/paradisSpreadsheetSemanticDiff.js';

const MAXIMUM_AXIS_ENTRIES = 1_048_576;
const DEFAULT_MAXIMUM_LIVE_CELLS = 10_000;
const MAXIMUM_LIVE_CELLS = 10_000;
const DEFAULT_TILE_ROWS = 32;
const DEFAULT_TILE_COLUMNS = 32;
const alignmentIndexes = new WeakMap<object, SpreadsheetAxisAlignmentIndex>();

export type ParadisSpreadsheetPaneKind = 'corner' | 'top' | 'left' | 'body';
export type ParadisSpreadsheetVirtualRange = readonly [rowStart: number, columnStart: number, rowEnd: number, columnEnd: number];

export interface ParadisSpreadsheetAxisMetric {
	readonly index: number;
	readonly size?: number;
	readonly hidden?: boolean;
	readonly collapsed?: boolean;
}

export interface ParadisSpreadsheetViewportOptions {
	readonly rowCount: number;
	readonly columnCount: number;
	readonly defaultRowHeight: number;
	readonly defaultColumnWidth: number;
	readonly rowMetrics?: readonly ParadisSpreadsheetAxisMetric[];
	readonly columnMetrics?: readonly ParadisSpreadsheetAxisMetric[];
	readonly frozenRows?: number;
	readonly frozenColumns?: number;
	readonly overscan?: number;
	readonly maxLiveCells?: number;
	readonly tileRows?: number;
	readonly tileColumns?: number;
	readonly revision: string;
}

export interface ParadisSpreadsheetViewportFrame {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly width: number;
	readonly height: number;
}

export interface ParadisSpreadsheetLogicalAnchor {
	readonly row: number;
	readonly column: number;
	readonly rowOffset: number;
	readonly columnOffset: number;
}

export interface ParadisSpreadsheetVirtualTile {
	readonly pane: ParadisSpreadsheetPaneKind;
	readonly range: ParadisSpreadsheetVirtualRange;
	readonly generation: number;
}

export interface ParadisSpreadsheetPanePlan {
	readonly kind: ParadisSpreadsheetPaneKind;
	readonly range: ParadisSpreadsheetVirtualRange;
	readonly tiles: readonly ParadisSpreadsheetVirtualTile[];
}

export interface ParadisSpreadsheetViewportPlan {
	readonly generation: number;
	readonly revision: string;
	readonly measurementRevision: number;
	readonly totalWidth: number;
	readonly totalHeight: number;
	readonly frozenWidth: number;
	readonly frozenHeight: number;
	readonly anchor: ParadisSpreadsheetLogicalAnchor;
	readonly panes: readonly ParadisSpreadsheetPanePlan[];
	readonly liveCellCount: number;
}

export interface ParadisSpreadsheetAxisRemeasurement {
	readonly rows?: readonly ParadisSpreadsheetAxisMetric[];
	readonly columns?: readonly ParadisSpreadsheetAxisMetric[];
}

export interface ParadisSpreadsheetTileRequest {
	readonly id: number;
	readonly generation: number;
	readonly revision: string;
	readonly pane: ParadisSpreadsheetPaneKind;
	readonly range: ParadisSpreadsheetVirtualRange;
}

export interface ParadisSpreadsheetTileIdentity {
	readonly revision: string;
	readonly range: ParadisSpreadsheetVirtualRange;
}

export type ParadisSpreadsheetNavigationKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';

interface SpreadsheetAxisAlignmentIndex {
	readonly original: ReadonlyMap<number, number>;
	readonly modified: ReadonlyMap<number, number>;
	readonly originalCoordinates: readonly number[];
	readonly modifiedCoordinates: readonly number[];
}

class SpreadsheetAxisLayout {
	private readonly sizes: Float64Array;
	private readonly prefix: Float64Array;

	constructor(
		readonly count: number,
		private readonly defaultSize: number,
		metrics: readonly ParadisSpreadsheetAxisMetric[] = [],
	) {
		assertCount(count);
		assertSize(defaultSize);
		this.sizes = new Float64Array(count);
		this.sizes.fill(defaultSize);
		this.prefix = new Float64Array(count + 1);
		this.applyMetrics(metrics);
	}

	get total(): number {
		return this.prefix[this.count];
	}

	getSize(index: number): number {
		return index >= 0 && index < this.count ? this.sizes[index] : 0;
	}

	offset(index: number): number {
		return this.prefix[clampInteger(index, 0, this.count)];
	}

	applyMetrics(metrics: readonly ParadisSpreadsheetAxisMetric[]): void {
		for (const metric of metrics) {
			if (!Number.isSafeInteger(metric.index) || metric.index < 0 || metric.index >= this.count) {
				throw new RangeError('Spreadsheet axis metric index is outside the sheet.');
			}
			const size = metric.hidden || metric.collapsed ? 0 : metric.size ?? this.defaultSize;
			assertSize(size);
			this.sizes[metric.index] = size;
		}
		this.rebuildPrefix();
	}

	indexAt(offset: number): number {
		if (this.count === 0) {
			return 0;
		}
		const target = clampFinite(offset, 0, this.total);
		let low = 0;
		let high = this.count;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.prefix[middle + 1] <= target) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return this.visibleAtOrAfter(Math.min(low, this.count - 1));
	}

	range(startOffset: number, endOffset: number, minimumIndex: number, overscan: number): readonly [number, number] {
		if (this.count === 0 || minimumIndex >= this.count || endOffset <= startOffset) {
			return [Math.min(minimumIndex, this.count), Math.min(minimumIndex, this.count)];
		}
		const start = Math.max(this.offset(minimumIndex), startOffset - overscan);
		const end = Math.min(this.total, endOffset + overscan);
		const first = Math.max(minimumIndex, this.indexAt(start));
		if (first >= this.count) {
			return [this.count, this.count];
		}
		let low = first + 1;
		let high = this.count;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.prefix[middle] < end) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return [first, Math.max(first + 1, low)];
	}

	visibleAtOrAfter(index: number): number {
		for (let candidate = Math.max(0, index); candidate < this.count; candidate++) {
			if (this.sizes[candidate] > 0) {
				return candidate;
			}
		}
		return this.visibleAtOrBefore(this.count - 1);
	}

	visibleAtOrBefore(index: number): number {
		for (let candidate = Math.min(index, this.count - 1); candidate >= 0; candidate--) {
			if (this.sizes[candidate] > 0) {
				return candidate;
			}
		}
		for (let candidate = 0; candidate < this.count; candidate++) {
			if (this.sizes[candidate] > 0) {
				return candidate;
			}
		}
		return 0;
	}

	private rebuildPrefix(): void {
		this.prefix[0] = 0;
		for (let index = 0; index < this.count; index++) {
			this.prefix[index + 1] = this.prefix[index] + this.sizes[index];
		}
	}
}

/** Computes bounded, generation-fenced two-dimensional spreadsheet tiles. */
export class ParadisSpreadsheetViewport {
	private readonly rows: SpreadsheetAxisLayout;
	private readonly columns: SpreadsheetAxisLayout;
	private readonly frozenRows: number;
	private readonly frozenColumns: number;
	private readonly overscan: number;
	private readonly maxLiveCells: number;
	private readonly tileRows: number;
	private readonly tileColumns: number;
	private requestSequence = 0;
	private readonly activeRequests = new Map<string, number>();
	private _generation = 0;
	private _measurementRevision = 0;
	private _revision: string;

	constructor(options: ParadisSpreadsheetViewportOptions) {
		this.rows = new SpreadsheetAxisLayout(options.rowCount, options.defaultRowHeight, options.rowMetrics);
		this.columns = new SpreadsheetAxisLayout(options.columnCount, options.defaultColumnWidth, options.columnMetrics);
		this.frozenRows = clampInteger(options.frozenRows ?? 0, 0, options.rowCount);
		this.frozenColumns = clampInteger(options.frozenColumns ?? 0, 0, options.columnCount);
		this.overscan = clampFinite(options.overscan ?? 160, 0, 10_000);
		this.maxLiveCells = clampInteger(options.maxLiveCells ?? DEFAULT_MAXIMUM_LIVE_CELLS, 1, MAXIMUM_LIVE_CELLS);
		this.tileRows = clampInteger(options.tileRows ?? DEFAULT_TILE_ROWS, 1, 256);
		this.tileColumns = clampInteger(options.tileColumns ?? DEFAULT_TILE_COLUMNS, 1, 256);
		this._revision = assertRevision(options.revision);
	}

	get rowCount(): number { return this.rows.count; }
	get columnCount(): number { return this.columns.count; }
	get totalHeight(): number { return this.rows.total; }
	get totalWidth(): number { return this.columns.total; }
	get generation(): number { return this._generation; }
	get measurementRevision(): number { return this._measurementRevision; }
	get revision(): string { return this._revision; }

	setRevision(revision: string): void {
		const owned = assertRevision(revision);
		if (owned === this._revision) {
			return;
		}
		this._revision = owned;
		this.invalidate();
	}

	plan(frame: ParadisSpreadsheetViewportFrame): ParadisSpreadsheetViewportPlan {
		const normalized = normalizeFrame(frame, this.totalWidth, this.totalHeight);
		const generation = this.invalidate();
		const frozenHeight = this.rows.offset(this.frozenRows);
		const frozenWidth = this.columns.offset(this.frozenColumns);
		const bodyRows = this.rows.range(normalized.scrollTop + frozenHeight, normalized.scrollTop + normalized.height, this.frozenRows, this.overscan);
		const bodyColumns = this.columns.range(normalized.scrollLeft + frozenWidth, normalized.scrollLeft + normalized.width, this.frozenColumns, this.overscan);
		const candidates: readonly [ParadisSpreadsheetPaneKind, readonly [number, number], readonly [number, number]][] = [
			['corner', [0, this.frozenRows], [0, this.frozenColumns]],
			['top', [0, this.frozenRows], bodyColumns],
			['left', bodyRows, [0, this.frozenColumns]],
			['body', bodyRows, bodyColumns],
		];
		let remaining = this.maxLiveCells;
		const panes: ParadisSpreadsheetPanePlan[] = [];
		let liveCellCount = 0;
		for (const [kind, rowRange, columnRange] of candidates) {
			const range = limitRange(rowRange, columnRange, remaining);
			const count = rangeArea(range);
			remaining -= count;
			liveCellCount += count;
			panes.push({ kind, range, tiles: this.tiles(kind, range, generation) });
		}
		return {
			generation,
			revision: this._revision,
			measurementRevision: this._measurementRevision,
			totalWidth: this.totalWidth,
			totalHeight: this.totalHeight,
			frozenWidth,
			frozenHeight,
			anchor: this.logicalAnchor(normalized),
			panes,
			liveCellCount,
		};
	}

	logicalAnchor(frame: ParadisSpreadsheetViewportFrame): ParadisSpreadsheetLogicalAnchor {
		const normalized = normalizeFrame(frame, this.totalWidth, this.totalHeight);
		const frozenHeight = this.rows.offset(this.frozenRows);
		const frozenWidth = this.columns.offset(this.frozenColumns);
		const row = this.rows.visibleAtOrAfter(Math.max(this.frozenRows, this.rows.indexAt(normalized.scrollTop + frozenHeight)));
		const column = this.columns.visibleAtOrAfter(Math.max(this.frozenColumns, this.columns.indexAt(normalized.scrollLeft + frozenWidth)));
		return {
			row,
			column,
			rowOffset: Math.max(0, normalized.scrollTop + frozenHeight - this.rows.offset(row)),
			columnOffset: Math.max(0, normalized.scrollLeft + frozenWidth - this.columns.offset(column)),
		};
	}

	remeasure(metrics: ParadisSpreadsheetAxisRemeasurement, anchor: ParadisSpreadsheetLogicalAnchor): Pick<ParadisSpreadsheetViewportFrame, 'scrollTop' | 'scrollLeft'> {
		this.rows.applyMetrics(metrics.rows ?? []);
		this.columns.applyMetrics(metrics.columns ?? []);
		this._measurementRevision++;
		this.invalidate();
		const row = this.rows.visibleAtOrAfter(clampInteger(anchor.row, 0, Math.max(0, this.rowCount - 1)));
		const column = this.columns.visibleAtOrAfter(clampInteger(anchor.column, 0, Math.max(0, this.columnCount - 1)));
		return {
			scrollTop: clampFinite(this.rows.offset(row) + Math.min(anchor.rowOffset, this.rows.getSize(row)) - this.rows.offset(this.frozenRows), 0, this.totalHeight),
			scrollLeft: clampFinite(this.columns.offset(column) + Math.min(anchor.columnOffset, this.columns.getSize(column)) - this.columns.offset(this.frozenColumns), 0, this.totalWidth),
		};
	}

	cellBounds(row: number, column: number, rowSpan = 1, columnSpan = 1): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
		const rowEnd = Math.min(this.rowCount, row + clampInteger(rowSpan, 1, this.rowCount));
		const columnEnd = Math.min(this.columnCount, column + clampInteger(columnSpan, 1, this.columnCount));
		return {
			left: this.columns.offset(column),
			top: this.rows.offset(row),
			width: this.columns.offset(columnEnd) - this.columns.offset(column),
			height: this.rows.offset(rowEnd) - this.rows.offset(row),
		};
	}

	moveFocus(
		focus: { readonly row: number; readonly column: number },
		key: ParadisSpreadsheetNavigationKey,
		modifiers: { readonly ctrlKey?: boolean } = {},
	): { readonly row: number; readonly column: number } {
		let row = clampInteger(focus.row, 0, Math.max(0, this.rowCount - 1));
		let column = clampInteger(focus.column, 0, Math.max(0, this.columnCount - 1));
		if (modifiers.ctrlKey && key === 'Home') {
			return { row: this.rows.visibleAtOrAfter(0), column: this.columns.visibleAtOrAfter(0) };
		}
		if (modifiers.ctrlKey && key === 'End') {
			return { row: this.rows.visibleAtOrBefore(this.rowCount - 1), column: this.columns.visibleAtOrBefore(this.columnCount - 1) };
		}
		switch (key) {
			case 'ArrowUp': row = this.rows.visibleAtOrBefore(row - 1); break;
			case 'ArrowDown': row = this.rows.visibleAtOrAfter(row + 1); break;
			case 'ArrowLeft': column = this.columns.visibleAtOrBefore(column - 1); break;
			case 'ArrowRight': column = this.columns.visibleAtOrAfter(column + 1); break;
			case 'Home': column = this.columns.visibleAtOrAfter(0); break;
			case 'End': column = this.columns.visibleAtOrBefore(this.columnCount - 1); break;
			case 'PageUp': row = this.rows.visibleAtOrBefore(row - 20); break;
			case 'PageDown': row = this.rows.visibleAtOrAfter(row + 20); break;
		}
		return { row, column };
	}

	beginTileRequest(tile: ParadisSpreadsheetVirtualTile): ParadisSpreadsheetTileRequest {
		const id = ++this.requestSequence;
		const request = { id, generation: tile.generation, revision: this._revision, pane: tile.pane, range: tile.range } as const;
		this.activeRequests.set(tileKey(request), id);
		return request;
	}

	acceptsTile(request: ParadisSpreadsheetTileRequest, tile: ParadisSpreadsheetTileIdentity): boolean {
		return request.generation === this._generation
			&& request.revision === this._revision
			&& tile.revision === request.revision
			&& equalRange(tile.range, request.range)
			&& this.activeRequests.get(tileKey(request)) === request.id;
	}

	private invalidate(): number {
		this._generation++;
		this.activeRequests.clear();
		return this._generation;
	}

	private tiles(pane: ParadisSpreadsheetPaneKind, range: ParadisSpreadsheetVirtualRange, generation: number): readonly ParadisSpreadsheetVirtualTile[] {
		const tiles: ParadisSpreadsheetVirtualTile[] = [];
		for (let row = range[0]; row < range[2]; row += this.tileRows) {
			for (let column = range[1]; column < range[3]; column += this.tileColumns) {
				tiles.push({ pane, generation, range: [row, column, Math.min(range[2], row + this.tileRows), Math.min(range[3], column + this.tileColumns)] });
			}
		}
		return tiles;
	}
}

/** Maps a scroll anchor by Task 5 logical correspondences; geometry never participates. */
export function mapSpreadsheetLogicalAnchor(
	anchor: ParadisSpreadsheetLogicalAnchor,
	alignment: ParadisSpreadsheetSheetAlignment | undefined,
	from: 'original' | 'modified',
): ParadisSpreadsheetLogicalAnchor {
	if (!alignment?.grid) {
		return { ...anchor };
	}
	return {
		row: mapAxisCoordinate(anchor.row, alignment.grid.rows, from),
		column: mapAxisCoordinate(anchor.column, alignment.grid.columns, from),
		rowOffset: anchor.rowOffset,
		columnOffset: anchor.columnOffset,
	};
}

function mapAxisCoordinate(value: number, entries: readonly ParadisSpreadsheetAxisAlignmentEntry[], from: 'original' | 'modified'): number {
	const index = alignmentIndex(entries);
	const mapping = index[from];
	const exact = mapping.get(value);
	if (exact !== undefined) {
		return exact;
	}
	const coordinates = from === 'original' ? index.originalCoordinates : index.modifiedCoordinates;
	const nearest = nearestCoordinate(coordinates, value);
	const mapped = nearest === undefined ? undefined : mapping.get(nearest);
	if (nearest === undefined || mapped === undefined) {
		return value;
	}
	return Math.max(0, mapped + value - nearest);
}

function alignmentIndex(entries: readonly ParadisSpreadsheetAxisAlignmentEntry[]): SpreadsheetAxisAlignmentIndex {
	const cached = alignmentIndexes.get(entries);
	if (cached) {
		return cached;
	}
	const original = new Map<number, number>();
	const modified = new Map<number, number>();
	for (const entry of entries) {
		if (entry.original !== undefined && entry.modified !== undefined) {
			original.set(entry.original, entry.modified);
			modified.set(entry.modified, entry.original);
		}
	}
	const result = {
		original,
		modified,
		originalCoordinates: [...original.keys()].sort((left, right) => left - right),
		modifiedCoordinates: [...modified.keys()].sort((left, right) => left - right),
	};
	alignmentIndexes.set(entries, result);
	return result;
}

function nearestCoordinate(values: readonly number[], target: number): number | undefined {
	if (values.length === 0) {
		return undefined;
	}
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	const after = values[Math.min(low, values.length - 1)];
	const before = values[Math.max(0, low - 1)];
	return Math.abs(before - target) <= Math.abs(after - target) ? before : after;
}

function assertCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_AXIS_ENTRIES) {
		throw new RangeError('Spreadsheet axis count is outside the supported range.');
	}
}

function assertSize(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
		throw new RangeError('Spreadsheet axis size is outside the supported range.');
	}
}

function assertRevision(value: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
		throw new TypeError('Spreadsheet revision must be a bounded string.');
	}
	return value;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, Number.isSafeInteger(value) ? value : minimum));
}

function clampFinite(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function normalizeFrame(frame: ParadisSpreadsheetViewportFrame, totalWidth: number, totalHeight: number): ParadisSpreadsheetViewportFrame {
	return {
		scrollTop: clampFinite(frame.scrollTop, 0, totalHeight),
		scrollLeft: clampFinite(frame.scrollLeft, 0, totalWidth),
		width: clampFinite(frame.width, 0, totalWidth),
		height: clampFinite(frame.height, 0, totalHeight),
	};
}

function limitRange(rowRange: readonly [number, number], columnRange: readonly [number, number], maximumCells: number): ParadisSpreadsheetVirtualRange {
	const rowLength = Math.max(0, rowRange[1] - rowRange[0]);
	const columnLength = Math.max(0, columnRange[1] - columnRange[0]);
	if (rowLength === 0 || columnLength === 0 || maximumCells <= 0) {
		return [rowRange[0], columnRange[0], rowRange[0], columnRange[0]];
	}
	const columns = Math.min(columnLength, maximumCells);
	const rows = Math.min(rowLength, Math.max(1, Math.floor(maximumCells / columns)));
	return [rowRange[0], columnRange[0], rowRange[0] + rows, columnRange[0] + columns];
}

function rangeArea(range: ParadisSpreadsheetVirtualRange): number {
	return Math.max(0, range[2] - range[0]) * Math.max(0, range[3] - range[1]);
}

function tileKey(tile: Pick<ParadisSpreadsheetTileRequest, 'pane' | 'range'>): string {
	return `${tile.pane}:${tile.range.join(':')}`;
}

function equalRange(left: ParadisSpreadsheetVirtualRange, right: ParadisSpreadsheetVirtualRange): boolean {
	return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

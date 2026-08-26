/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import {
	ParadisSpreadsheetViewport,
	type ParadisSpreadsheetAxisRemeasurement,
	type ParadisSpreadsheetNavigationKey,
	type ParadisSpreadsheetPaneKind,
	type ParadisSpreadsheetTileRequest,
	type ParadisSpreadsheetViewportFrame,
	type ParadisSpreadsheetViewportPlan,
	type ParadisSpreadsheetVirtualRange,
} from './paradisSpreadsheetViewport.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const safeStyleProperties = new Set([
	'backgroundColor', 'borderBottom', 'borderLeft', 'borderRight', 'borderTop', 'color', 'fontFamily', 'fontSize',
	'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop',
	'textAlign', 'textDecoration', 'verticalAlign', 'whiteSpace', 'wordBreak', 'writingMode',
]);
const paneKinds: readonly ParadisSpreadsheetPaneKind[] = ['corner', 'top', 'left', 'body'];
const MAXIMUM_CELL_POOL_SIZE = 10_000;

export interface ParadisSpreadsheetGridDiagonal {
	readonly up: boolean;
	readonly down: boolean;
	readonly style: string;
	readonly color: string;
}

export interface ParadisSpreadsheetGridMedia {
	/** Renderer-approved non-SVG image URL. Raw external URLs and markup are rejected. */
	readonly source: string;
	readonly altText?: string;
}

export interface ParadisSpreadsheetGridCell {
	readonly row: number;
	readonly column: number;
	readonly text: string;
	readonly style?: Readonly<Record<string, string>>;
	readonly classNames?: readonly string[];
	readonly rowSpan?: number;
	readonly columnSpan?: number;
	readonly baseDiagonal?: ParadisSpreadsheetGridDiagonal;
	readonly conditionalDiagonal?: ParadisSpreadsheetGridDiagonal;
	readonly media?: ParadisSpreadsheetGridMedia;
}

export interface ParadisSpreadsheetGridTile {
	readonly revision: string;
	readonly range: ParadisSpreadsheetVirtualRange;
	readonly cells: readonly ParadisSpreadsheetGridCell[];
}

export interface ParadisSpreadsheetCellBounds {
	readonly width: number;
	readonly height: number;
}

export interface ParadisSpreadsheetGridRendererOptions {
	readonly getViewport: (request: ParadisSpreadsheetTileRequest) => Promise<ParadisSpreadsheetGridTile>;
	readonly measureCell?: (cell: HTMLElement) => ParadisSpreadsheetCellBounds;
	readonly measureAxes?: () => ParadisSpreadsheetAxisRemeasurement;
	readonly observeResize?: (callback: () => void) => IDisposable;
	readonly fontsReady?: Promise<unknown>;
	readonly scheduleMedia?: (callback: () => void) => IDisposable;
}

interface RenderedCell {
	readonly element: HTMLElement;
	pane: ParadisSpreadsheetPaneKind;
}

/** Reusable, safe DOM renderer over generation-fenced viewport tiles. */
export class ParadisSpreadsheetGridRenderer extends Disposable {
	private readonly document: Document;
	private readonly sizer: HTMLElement;
	private readonly panes = new Map<ParadisSpreadsheetPaneKind, HTMLElement>();
	private readonly cells = new Map<string, RenderedCell>();
	private readonly cellPool: HTMLElement[] = [];
	private readonly mediaSchedules = new Map<string, IDisposable>();
	private readonly options: ParadisSpreadsheetGridRendererOptions;
	private readonly scrollListener: () => void;
	private readonly keyListener: (event: KeyboardEvent) => void;
	private resizeObserver: IDisposable | undefined;
	private disposed = false;
	private rendering = false;
	private idle: Promise<void> = Promise.resolve();
	private _frame: ParadisSpreadsheetViewportFrame = { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 };
	private focused = { row: 0, column: 0 };

	constructor(
		private readonly container: HTMLElement,
		private readonly viewport: ParadisSpreadsheetViewport,
		options: ParadisSpreadsheetGridRendererOptions,
	) {
		super();
		this.options = options;
		this.document = container.ownerDocument;
		container.classList.add('paradis-spreadsheet-virtual-grid');
		container.setAttribute('role', 'grid');
		container.setAttribute('aria-rowcount', String(viewport.rowCount));
		container.setAttribute('aria-colcount', String(viewport.columnCount));
		container.tabIndex = 0;
		this.sizer = this.document.createElement('div');
		this.sizer.className = 'paradis-spreadsheet-virtual-sizer';
		container.appendChild(this.sizer);
		for (const kind of paneKinds) {
			const pane = this.document.createElement('div');
			pane.className = `paradis-spreadsheet-virtual-pane paradis-spreadsheet-virtual-pane-${kind}`;
			pane.dataset.pane = kind;
			this.sizer.appendChild(pane);
			this.panes.set(kind, pane);
		}
		this.scrollListener = () => {
			if (!this.rendering) {
				this.queueRender();
			}
		};
		this.keyListener = event => this.onKeyDown(event);
		container.addEventListener('scroll', this.scrollListener, { passive: true });
		container.addEventListener('keydown', this.keyListener);
		this.attachRemeasureTriggers();
	}

	get liveCellCount(): number { return this.cells.size; }
	get frame(): ParadisSpreadsheetViewportFrame { return { ...this._frame }; }

	async render(frame: ParadisSpreadsheetViewportFrame): Promise<ParadisSpreadsheetViewportPlan> {
		if (this.disposed) {
			throw new Error('Spreadsheet grid renderer is disposed.');
		}
		this._frame = normalizeRendererFrame(frame);
		this.rendering = true;
		try {
			this.container.scrollTop = this._frame.scrollTop;
			this.container.scrollLeft = this._frame.scrollLeft;
			return await this.renderCurrent();
		} finally {
			this.rendering = false;
		}
	}

	async remeasure(metrics: ParadisSpreadsheetAxisRemeasurement = this.options.measureAxes?.() ?? {}): Promise<void> {
		if (this.disposed) {
			return;
		}
		const anchor = this.viewport.logicalAnchor(this._frame);
		const restored = this.viewport.remeasure(metrics, anchor);
		this._frame = { ...this._frame, ...restored };
		this.rendering = true;
		try {
			this.container.scrollTop = restored.scrollTop;
			this.container.scrollLeft = restored.scrollLeft;
			await this.renderCurrent();
		} finally {
			this.rendering = false;
		}
	}

	whenIdle(): Promise<void> {
		return this.idle;
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.container.removeEventListener('scroll', this.scrollListener);
		this.container.removeEventListener('keydown', this.keyListener);
		this.resizeObserver?.dispose();
		for (const schedule of this.mediaSchedules.values()) {
			schedule.dispose();
		}
		this.mediaSchedules.clear();
		this.cells.clear();
		this.cellPool.length = 0;
		this.container.replaceChildren();
		super.dispose();
	}

	private async renderCurrent(): Promise<ParadisSpreadsheetViewportPlan> {
		const plan = this.viewport.plan(this._frame);
		this.sizer.style.width = `${plan.totalWidth}px`;
		this.sizer.style.height = `${plan.totalHeight}px`;
		this.updatePaneTransforms(plan);
		const plannedCells = new Set<string>();
		for (const pane of plan.panes) {
			for (let row = pane.range[0]; row < pane.range[2]; row++) {
				for (let column = pane.range[1]; column < pane.range[3]; column++) {
					plannedCells.add(cellKey(pane.kind, row, column));
				}
			}
		}
		this.pruneCells(plannedCells);
		const activeCells = new Set<string>();
		const requests = plan.panes.flatMap(pane => pane.tiles.map(tile => this.viewport.beginTileRequest(tile)));
		await Promise.all(requests.map(async request => {
			let tile: ParadisSpreadsheetGridTile;
			try {
				tile = await this.options.getViewport(request);
			} catch {
				// A rejected tile is local to this generation. Later scroll/resize work must remain runnable.
				return;
			}
			if (this.disposed || !this.viewport.acceptsTile(request, tile)) {
				return;
			}
			for (const cell of tile.cells) {
				if (!cellInRange(cell, request.range)) {
					continue;
				}
				const bounds = this.viewport.cellBounds(cell.row, cell.column, cell.rowSpan, cell.columnSpan);
				if (bounds.width <= 0 || bounds.height <= 0) {
					continue;
				}
				const key = cellKey(request.pane, cell.row, cell.column);
				activeCells.add(key);
				this.renderCell(key, request.pane, cell, plan.generation);
			}
		}));
		if (this.disposed || plan.generation !== this.viewport.generation) {
			return plan;
		}
		this.pruneCells(activeCells);
		this.updateFocusedCell();
		return plan;
	}

	private renderCell(key: string, paneKind: ParadisSpreadsheetPaneKind, cell: ParadisSpreadsheetGridCell, generation: number): void {
		const pane = this.panes.get(paneKind)!;
		let rendered = this.cells.get(key);
		if (!rendered) {
			const element = this.cellPool.pop() ?? this.document.createElement('div');
			element.setAttribute('role', 'gridcell');
			rendered = { element, pane: paneKind };
			this.cells.set(key, rendered);
			pane.appendChild(element);
		} else if (rendered.pane !== paneKind) {
			rendered.pane = paneKind;
			pane.appendChild(rendered.element);
		}
		const element = rendered.element;
		this.mediaSchedules.get(key)?.dispose();
		this.mediaSchedules.delete(key);
		element.className = 'paradis-spreadsheet-virtual-cell';
		for (const className of (cell.classNames ?? []).slice(0, 32)) {
			if (/^[a-zA-Z][\w-]{0,63}$/.test(className)) {
				element.classList.add(className);
			}
		}
		element.removeAttribute('style');
		const bounds = this.viewport.cellBounds(cell.row, cell.column, cell.rowSpan, cell.columnSpan);
		element.style.left = `${bounds.left}px`;
		element.style.top = `${bounds.top}px`;
		element.style.width = `${bounds.width}px`;
		element.style.height = `${bounds.height}px`;
		applySafeStyle(element, cell.style);
		element.setAttribute('aria-rowindex', String(cell.row + 1));
		element.setAttribute('aria-colindex', String(cell.column + 1));
		if (cell.rowSpan && cell.rowSpan > 1) {
			element.setAttribute('aria-rowspan', String(cell.rowSpan));
		} else {
			element.removeAttribute('aria-rowspan');
		}
		if (cell.columnSpan && cell.columnSpan > 1) {
			element.setAttribute('aria-colspan', String(cell.columnSpan));
		} else {
			element.removeAttribute('aria-colspan');
		}
		element.dataset.row = String(cell.row);
		element.dataset.column = String(cell.column);
		element.textContent = boundedText(cell.text);
		if (cell.baseDiagonal || cell.conditionalDiagonal) {
			// One layout read supplies both layers. Scroll/freeze/overscan coordinates never enter diagonal geometry.
			const measured = this.measureCell(element);
			if (measured.width > 0 && measured.height > 0) {
				if (cell.baseDiagonal) {
					this.appendDiagonal(element, cell.baseDiagonal, measured, 'base');
				}
				if (cell.conditionalDiagonal) {
					this.appendDiagonal(element, cell.conditionalDiagonal, measured, 'conditional');
				}
			}
		}
		if (cell.media && isSafeMediaSource(cell.media.source)) {
			const schedule = (this.options.scheduleMedia ?? (callback => defaultScheduleMedia(this.document, callback)))(() => {
				if (this.disposed || generation !== this.viewport.generation || this.cells.get(key)?.element !== element) {
					return;
				}
				const image = this.document.createElement('img');
				image.className = 'paradis-spreadsheet-virtual-media';
				image.alt = boundedText(cell.media?.altText ?? '');
				image.loading = 'lazy';
				image.decoding = 'async';
				image.src = cell.media!.source;
				element.appendChild(image);
				void image.decode?.().catch(() => undefined);
			});
			this.mediaSchedules.set(key, schedule);
		}
	}

	private measureCell(element: HTMLElement): ParadisSpreadsheetCellBounds {
		if (this.options.measureCell) {
			return sanitizeBounds(this.options.measureCell(element));
		}
		const bounds = element.getBoundingClientRect();
		return sanitizeBounds(bounds);
	}

	private appendDiagonal(element: HTMLElement, diagonal: ParadisSpreadsheetGridDiagonal, bounds: ParadisSpreadsheetCellBounds, layer: 'base' | 'conditional'): void {
		const svg = this.document.createElementNS(SVG_NAMESPACE, 'svg');
		svg.setAttribute('class', `paradis-spreadsheet-diagonal paradis-spreadsheet-diagonal-${layer}`);
		svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
		svg.setAttribute('width', String(bounds.width));
		svg.setAttribute('height', String(bounds.height));
		svg.style.width = `${bounds.width}px`;
		svg.style.height = `${bounds.height}px`;
		const appendLine = (x1: number, y1: number, x2: number, y2: number): void => {
			const line = this.document.createElementNS(SVG_NAMESPACE, 'line');
			line.setAttribute('x1', String(x1));
			line.setAttribute('y1', String(y1));
			line.setAttribute('x2', String(x2));
			line.setAttribute('y2', String(y2));
			line.setAttribute('stroke', safeColor(diagonal.color));
			line.setAttribute('stroke-width', String(strokeWidth(diagonal.style)));
			line.setAttribute('vector-effect', 'non-scaling-stroke');
			if (/dashed|dotted/i.test(diagonal.style)) {
				line.setAttribute('stroke-dasharray', /dotted/i.test(diagonal.style) ? '1,2' : '5,3');
			}
			svg.appendChild(line);
		};
		if (diagonal.down) {
			appendLine(0, 0, bounds.width, bounds.height);
		}
		if (diagonal.up) {
			appendLine(0, bounds.height, bounds.width, 0);
		}
		element.appendChild(svg);
	}

	private updatePaneTransforms(plan: ParadisSpreadsheetViewportPlan): void {
		const x = this._frame.scrollLeft;
		const y = this._frame.scrollTop;
		this.panes.get('corner')!.style.transform = `translate(${x}px, ${y}px)`;
		this.panes.get('top')!.style.transform = `translateY(${y}px)`;
		this.panes.get('left')!.style.transform = `translateX(${x}px)`;
		this.panes.get('body')!.style.transform = '';
		this.panes.get('body')!.style.width = `${plan.totalWidth}px`;
		this.panes.get('body')!.style.height = `${plan.totalHeight}px`;
		this.panes.get('top')!.style.width = `${plan.totalWidth}px`;
		this.panes.get('left')!.style.height = `${plan.totalHeight}px`;
		this.panes.get('corner')!.style.width = `${plan.frozenWidth}px`;
		this.panes.get('corner')!.style.height = `${plan.frozenHeight}px`;
		this.panes.get('top')!.style.height = `${plan.frozenHeight}px`;
		this.panes.get('left')!.style.width = `${plan.frozenWidth}px`;
	}

	private pruneCells(retain: ReadonlySet<string>): void {
		for (const [key, rendered] of this.cells) {
			if (retain.has(key)) {
				continue;
			}
			this.mediaSchedules.get(key)?.dispose();
			this.mediaSchedules.delete(key);
			rendered.element.remove();
			rendered.element.removeAttribute('id');
			this.cells.delete(key);
			if (this.cellPool.length < MAXIMUM_CELL_POOL_SIZE) {
				this.cellPool.push(rendered.element);
			}
		}
	}

	private attachRemeasureTriggers(): void {
		if (this.options.observeResize) {
			this.resizeObserver = this.options.observeResize(() => this.queueRemeasure());
		} else {
			const ResizeObserverConstructor = this.document.defaultView?.ResizeObserver;
			if (ResizeObserverConstructor) {
				const observer = new ResizeObserverConstructor(() => this.queueRemeasure());
				observer.observe(this.container);
				this.resizeObserver = { dispose: () => observer.disconnect() };
			}
		}
		const fontsReady = this.options.fontsReady ?? this.document.fonts?.ready;
		fontsReady?.then(() => this.queueRemeasure(), () => undefined);
	}

	private queueRender(): void {
		this._frame = {
			scrollTop: this.container.scrollTop,
			scrollLeft: this.container.scrollLeft,
			width: this.container.clientWidth || this._frame.width,
			height: this.container.clientHeight || this._frame.height,
		};
		this.idle = this.idle.then(async () => {
			if (!this.disposed) {
				await this.render(this._frame);
			}
		});
	}

	private queueRemeasure(): void {
		this.idle = this.idle.then(async () => {
			if (!this.disposed) {
				await this.remeasure();
			}
		});
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (!isNavigationKey(event.key)) {
			return;
		}
		event.preventDefault();
		this.focused = this.viewport.moveFocus(this.focused, event.key, { ctrlKey: event.ctrlKey || event.metaKey });
		this.scrollFocusedCellIntoView();
		this.queueRender();
	}

	private scrollFocusedCellIntoView(): void {
		const bounds = this.viewport.cellBounds(this.focused.row, this.focused.column);
		let scrollTop = this._frame.scrollTop;
		let scrollLeft = this._frame.scrollLeft;
		if (bounds.top < scrollTop) {
			scrollTop = bounds.top;
		} else if (bounds.top + bounds.height > scrollTop + this._frame.height) {
			scrollTop = bounds.top + bounds.height - this._frame.height;
		}
		if (bounds.left < scrollLeft) {
			scrollLeft = bounds.left;
		} else if (bounds.left + bounds.width > scrollLeft + this._frame.width) {
			scrollLeft = bounds.left + bounds.width - this._frame.width;
		}
		this.container.scrollTop = Math.max(0, scrollTop);
		this.container.scrollLeft = Math.max(0, scrollLeft);
	}

	private updateFocusedCell(): void {
		for (const rendered of this.cells.values()) {
			const selected = Number(rendered.element.dataset.row) === this.focused.row && Number(rendered.element.dataset.column) === this.focused.column;
			rendered.element.tabIndex = selected ? 0 : -1;
			if (selected) {
				this.container.setAttribute('aria-activedescendant', ensureCellId(rendered.element, this.focused.row, this.focused.column));
			}
		}
	}
}

function normalizeRendererFrame(frame: ParadisSpreadsheetViewportFrame): ParadisSpreadsheetViewportFrame {
	return {
		scrollTop: finiteNonNegative(frame.scrollTop),
		scrollLeft: finiteNonNegative(frame.scrollLeft),
		width: finiteNonNegative(frame.width),
		height: finiteNonNegative(frame.height),
	};
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function cellInRange(cell: ParadisSpreadsheetGridCell, range: ParadisSpreadsheetVirtualRange): boolean {
	return Number.isSafeInteger(cell.row) && Number.isSafeInteger(cell.column)
		&& cell.row >= range[0] && cell.row < range[2] && cell.column >= range[1] && cell.column < range[3];
}

function cellKey(pane: ParadisSpreadsheetPaneKind, row: number, column: number): string {
	return `${pane}:${row}:${column}`;
}

function boundedText(value: string): string {
	return typeof value === 'string' ? value.slice(0, 32_768) : '';
}

function applySafeStyle(element: HTMLElement, style: Readonly<Record<string, string>> | undefined): void {
	if (!style) {
		return;
	}
	const target = element.style as unknown as Record<string, string>;
	for (const [property, value] of Object.entries(style)) {
		if (safeStyleProperties.has(property) && typeof value === 'string' && value.length <= 1_024 && !/(?:url\s*\(|expression\s*\(|javascript:)/i.test(value)) {
			target[property] = value;
		}
	}
}

function sanitizeBounds(value: ParadisSpreadsheetCellBounds): ParadisSpreadsheetCellBounds {
	return { width: finiteNonNegative(value.width), height: finiteNonNegative(value.height) };
}

function safeColor(value: string): string {
	return /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]{1,32})$/i.test(value) ? value : 'currentColor';
}

function strokeWidth(style: string): number {
	const match = /^(\d+(?:\.\d+)?)px\b/.exec(style);
	return match ? Math.min(16, Math.max(0.5, Number(match[1]))) : 1;
}

function isSafeMediaSource(source: string): boolean {
	return /^(?:blob:|vscode-file:|vscode-remote-resource:)/.test(source)
		|| /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(source);
}

function defaultScheduleMedia(document: Document, callback: () => void): IDisposable {
	const targetWindow = document.defaultView;
	if (targetWindow) {
		const handle = targetWindow.requestAnimationFrame(callback);
		return { dispose: () => targetWindow.cancelAnimationFrame(handle) };
	}
	const handle = setTimeout(callback, 0);
	return { dispose: () => clearTimeout(handle) };
}

function isNavigationKey(key: string): key is ParadisSpreadsheetNavigationKey {
	return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
		|| key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
}

function ensureCellId(element: HTMLElement, row: number, column: number): string {
	if (!element.id) {
		element.id = `paradis-spreadsheet-cell-${row}-${column}`;
	}
	return element.id;
}

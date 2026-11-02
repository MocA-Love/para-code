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
	/** 行番号・列記号の見出しのセル。コピーの対象にせず、aria では見出しとして読ませる。 */
	readonly header?: 'row' | 'column';
	/** 空いた隣のセルへ文字をはみ出させる（DOM の表の `applyOverflow` と同じ決まり）。幅は倍率を掛ける前の寸法。 */
	readonly overflow?: ParadisSpreadsheetGridOverflow;
}

export interface ParadisSpreadsheetGridOverflow {
	readonly toward: 'left' | 'right' | 'center';
	readonly leftRoom: number;
	readonly rightRoom: number;
	readonly valign: string;
	/** はみ出しうる列の範囲 [始まり, 終わり)。範囲の外にある元のセルを、その範囲を描くときにも残すために使う。 */
	readonly fromColumn: number;
	readonly toColumn: number;
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
	/**
	 * 表示の倍率。中身（文字・余白・罫線）ごと CSS の zoom で拡大縮小し、座標は倍率を掛ける前の寸法のまま扱う
	 * （DOM の表が `transform: scale` で全体を縮めるのと同じ見え方にするため）。既定は 1。
	 */
	readonly zoom?: number;
	/**
	 * クリックしたセルにフォーカスを移し、文字を選ばずにコピーしたらそのセルの値をコピーする（Excel のビューア）。
	 * CSV のビューアは自分の選択範囲でコピーするので使わない。既定は false。
	 */
	readonly copyFocusedCell?: boolean;
}

interface RenderedCell {
	readonly element: HTMLElement;
	pane: ParadisSpreadsheetPaneKind;
	/** 描いている行・列の範囲 [行, 列, 行の終わり, 列の終わり)（結合とはみ出しを含む）。 */
	extent: ParadisSpreadsheetVirtualRange;
}

interface PendingOverflow {
	readonly element: HTMLElement;
	readonly span: HTMLElement;
	readonly overflow: ParadisSpreadsheetGridOverflow;
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
	private readonly copyListener: (event: ClipboardEvent) => void;
	private readonly pointerListener: (event: MouseEvent) => void;
	/** 描くときに切った（とても長い）セルの元の文字。コピーでは切らずに渡す。 */
	private readonly fullTexts = new Map<string, string>();
	private resizeObserver: IDisposable | undefined;
	private disposed = false;
	private rendering = false;
	private idle: Promise<void> = Promise.resolve();
	private _frame: ParadisSpreadsheetViewportFrame = { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 };
	private focused = { row: 0, column: 0 };
	private readonly zoom: number;
	private pendingOverflow: PendingOverflow[] = [];

	constructor(
		private readonly container: HTMLElement,
		private readonly viewport: ParadisSpreadsheetViewport,
		options: ParadisSpreadsheetGridRendererOptions,
	) {
		super();
		this.options = options;
		this.zoom = Number.isFinite(options.zoom) && options.zoom! > 0 ? options.zoom! : 1;
		this.document = container.ownerDocument;
		container.classList.add('paradis-spreadsheet-virtual-grid');
		container.setAttribute('role', 'grid');
		container.setAttribute('aria-rowcount', String(viewport.rowCount));
		container.setAttribute('aria-colcount', String(viewport.columnCount));
		container.tabIndex = 0;
		this.sizer = this.document.createElement('div');
		this.sizer.className = 'paradis-spreadsheet-virtual-sizer';
		if (this.zoom !== 1) {
			this.sizer.style.zoom = String(this.zoom);
		}
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
		this.copyListener = event => this.onCopy(event);
		this.pointerListener = event => this.onPointerDown(event);
		container.addEventListener('scroll', this.scrollListener, { passive: true });
		container.addEventListener('keydown', this.keyListener);
		if (options.copyFocusedCell) {
			container.addEventListener('copy', this.copyListener);
			container.addEventListener('mousedown', this.pointerListener);
		}
		this.attachRemeasureTriggers();
	}

	get liveCellCount(): number { return this.cells.size; }
	/** 表示の倍率。`render` に渡す frame は倍率を掛ける前の寸法（入れ物の clientWidth などは倍率で割って渡す）。 */
	get zoomFactor(): number { return this.zoom; }
	/** フォーカスのあるセル（描き直しの後に戻すため）。 */
	get focusedCell(): { readonly row: number; readonly column: number } { return { ...this.focused }; }
	/** フォーカスのあるセルを決める（次の描画で反映する）。 */
	setFocusedCell(row: number, column: number): void {
		if (Number.isSafeInteger(row) && Number.isSafeInteger(column)) {
			this.focused = { row, column };
		}
	}
	get frame(): ParadisSpreadsheetViewportFrame { return { ...this._frame }; }

	async render(frame: ParadisSpreadsheetViewportFrame): Promise<ParadisSpreadsheetViewportPlan> {
		if (this.disposed) {
			throw new Error('Spreadsheet grid renderer is disposed.');
		}
		this._frame = normalizeRendererFrame(frame);
		this.rendering = true;
		try {
			// スクロール位置は入れ物に大きさを付けてから書く（先に書くと、前の大きさで切り詰められる）
			return await this.renderCurrent(true);
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
			await this.renderCurrent(true);
		} finally {
			this.rendering = false;
		}
	}

	async revealCell(row: number, column: number): Promise<void> {
		if (this.disposed) {
			return;
		}
		const reveal = this.viewport.revealCell(this._frame, row, column);
		this.focused = { row: reveal.row, column: reveal.column };
		await this.render({ ...this._frame, scrollTop: reveal.scrollTop, scrollLeft: reveal.scrollLeft });
	}

	/**
	 * 本体の枠（スクロールする側）に、セルと同じ座標の飾り（図形・改ページ線・ページ番号など）を重ねる。
	 * `background` はセルより奥（ページ番号の透かし）、`foreground` はセルより手前に置く。座標は倍率を掛ける前のもので、
	 * 入れ物の zoom で一緒に拡大縮小する。グリッドを捨てると一緒に外れる。
	 */
	addDecorations(background: readonly (HTMLElement | SVGElement)[], foreground: readonly (HTMLElement | SVGElement)[]): void {
		const body = this.panes.get('body')!;
		for (const element of background) {
			element.style.zIndex = '0';
			body.insertBefore(element, body.firstChild);
		}
		for (const element of foreground) {
			// セルは描き直すたびに後ろへ足されるので、手前に出すには重なりの順を指定する
			element.style.zIndex = '3';
			body.appendChild(element);
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
		this.container.removeEventListener('copy', this.copyListener);
		this.container.removeEventListener('mousedown', this.pointerListener);
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

	private async renderCurrent(applyScroll = false): Promise<ParadisSpreadsheetViewportPlan> {
		const plan = this.viewport.plan(this._frame);
		this.sizer.style.width = `${plan.totalWidth}px`;
		this.sizer.style.height = `${plan.totalHeight}px`;
		if (applyScroll) {
			this.container.scrollTop = this._frame.scrollTop * this.zoom;
			this.container.scrollLeft = this._frame.scrollLeft * this.zoom;
		}
		this.updatePaneTransforms(plan);
		const plannedCells = new Set<string>();
		for (const pane of plan.panes) {
			for (let row = pane.range[0]; row < pane.range[2]; row++) {
				for (let column = pane.range[1]; column < pane.range[3]; column++) {
					plannedCells.add(cellKey(pane.kind, row, column));
				}
			}
		}
		// 起点が範囲の外にある結合・はみ出しのセルは、範囲に掛かっていれば残す（外すと描き直すたびに作り直しになる）
		for (const [key, rendered] of this.cells) {
			if (plan.panes.some(pane => pane.kind === rendered.pane && rangesIntersect(rendered.extent, pane.range))) {
				plannedCells.add(key);
			}
		}
		this.pruneCells(plannedCells);
		this.pendingOverflow = [];
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
				if (!rangesIntersect(cellExtent(cell), request.range)) {
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
		this.applyOverflow();
		this.updateFocusedCell();
		return plan;
	}

	private renderCell(key: string, paneKind: ParadisSpreadsheetPaneKind, cell: ParadisSpreadsheetGridCell, generation: number): void {
		const pane = this.panes.get(paneKind)!;
		let rendered = this.cells.get(key);
		if (!rendered) {
			const element = this.cellPool.pop() ?? this.document.createElement('div');
			rendered = { element, pane: paneKind, extent: cellExtent(cell) };
			this.cells.set(key, rendered);
			pane.appendChild(element);
		} else if (rendered.pane !== paneKind) {
			rendered.pane = paneKind;
			pane.appendChild(rendered.element);
		}
		rendered.extent = cellExtent(cell);
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
		element.setAttribute('role', cell.header === 'column' ? 'columnheader' : cell.header === 'row' ? 'rowheader' : 'gridcell');
		if (cell.header) {
			element.dataset.header = cell.header;
		} else {
			delete element.dataset.header;
		}
		element.textContent = boundedText(cell.text);
		if (typeof cell.text === 'string' && cell.text.length > MAXIMUM_CELL_TEXT) {
			this.fullTexts.set(key, cell.text);
		} else {
			this.fullTexts.delete(key);
		}
		if (cell.overflow && (cell.overflow.leftRoom > 0 || cell.overflow.rightRoom > 0)) {
			// 文字を span に包んでおき、全部の描画の後でまとめて測る（DOM の表の `createOverflowSpan` と同じ形）
			const span = this.document.createElement('span');
			span.className = 'paradis-spreadsheet-overflow';
			span.textContent = element.textContent;
			element.textContent = '';
			element.appendChild(span);
			this.pendingOverflow.push({ element, span, overflow: cell.overflow });
		}
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

	/**
	 * 列幅を超える文字を隣の空いたセルへ広げる。DOM の表の `applyOverflow` と同じく、まず全部を測ってから書く。
	 * セルは絶対配置のままにし、隣のセルより前に出す（DOM の表では位置を指定したセルが手前に描かれる）。
	 */
	private applyOverflow(): void {
		const pending = this.pendingOverflow.filter(item => item.element.isConnected && item.element.contains(item.span));
		this.pendingOverflow = [];
		const measures = pending.map(item => ({ item, need: item.element.scrollWidth, avail: item.element.clientWidth }));
		for (const { item: { element, span, overflow }, need, avail } of measures) {
			if (avail <= 0 || need <= avail) {
				continue;
			}
			const extraRight = overflow.toward === 'left' ? 0 : overflow.rightRoom;
			const extraLeft = overflow.toward === 'right' ? 0 : overflow.leftRoom;
			if (extraRight <= 0 && extraLeft <= 0) {
				continue;
			}
			element.style.overflow = 'visible';
			element.style.zIndex = '1';
			span.style.position = 'absolute';
			span.style.top = '0';
			span.style.bottom = '0';
			span.style.display = 'flex';
			span.style.alignItems = overflow.valign === 'top' ? 'flex-start' : overflow.valign === 'middle' ? 'center' : 'flex-end';
			span.style.whiteSpace = 'nowrap';
			span.style.overflow = 'hidden';
			span.style.pointerEvents = 'none';
			span.style.boxSizing = 'border-box';
			span.style.padding = '0 3px';
			if (overflow.toward === 'right') {
				span.style.left = '0';
				span.style.width = `${avail + extraRight}px`;
				span.style.justifyContent = 'flex-start';
			} else if (overflow.toward === 'left') {
				span.style.right = '0';
				span.style.width = `${avail + extraLeft}px`;
				span.style.justifyContent = 'flex-end';
			} else {
				span.style.left = `${-extraLeft}px`;
				span.style.width = `${avail + extraLeft + extraRight}px`;
				span.style.justifyContent = 'center';
			}
		}
	}

	private measureCell(element: HTMLElement): ParadisSpreadsheetCellBounds {
		if (this.options.measureCell) {
			return sanitizeBounds(this.options.measureCell(element));
		}
		// 画面上の寸法は zoom を掛けた後なので、中の座標（斜線の svg）に使うときは倍率で割る
		const bounds = element.getBoundingClientRect();
		return sanitizeBounds({ width: bounds.width / this.zoom, height: bounds.height / this.zoom });
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
			this.fullTexts.delete(key);
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
			scrollTop: this.container.scrollTop / this.zoom,
			scrollLeft: this.container.scrollLeft / this.zoom,
			width: this.container.clientWidth ? this.container.clientWidth / this.zoom : this._frame.width,
			height: this.container.clientHeight ? this.container.clientHeight / this.zoom : this._frame.height,
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

	/**
	 * 文字を選んでいないときのコピーは、フォーカスのあるセルの値をコピーする。セルは絶対配置の箱で、
	 * 画面の外の行は描いていないので、選ばずにコピーしても何も入らなかった。選んでいるときはブラウザに任せる。
	 */
	private onCopy(event: ClipboardEvent): void {
		const selection = this.document.getSelection();
		if (selection && !selection.isCollapsed && selection.toString().length > 0) {
			return;
		}
		const entry = [...this.cells].find(([, rendered]) => Number(rendered.element.dataset.row) === this.focused.row && Number(rendered.element.dataset.column) === this.focused.column);
		// 見出し・空のセルではコピーを横取りしない（手元のクリップボードを空で上書きしない）
		if (!entry || entry[1].element.dataset.header || !event.clipboardData) {
			return;
		}
		const value = this.fullTexts.get(entry[0]) ?? entry[1].element.textContent ?? '';
		if (!value) {
			return;
		}
		event.clipboardData.setData('text/plain', value);
		event.preventDefault();
	}

	/** クリックしたセルにフォーカスを移す（キーの移動とコピーの起点になる）。 */
	private onPointerDown(event: MouseEvent): void {
		const target = event.target as Element | null;
		const element = target?.closest?.('.paradis-spreadsheet-virtual-cell') as HTMLElement | null | undefined;
		if (!element || !this.container.contains(element)) {
			return;
		}
		const row = Number(element.dataset.row);
		const column = Number(element.dataset.column);
		if (Number.isSafeInteger(row) && Number.isSafeInteger(column)) {
			this.focused = { row, column };
			this.updateFocusedCell();
		}
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
		this.container.scrollTop = Math.max(0, scrollTop) * this.zoom;
		this.container.scrollLeft = Math.max(0, scrollLeft) * this.zoom;
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

/** セルが描く範囲（結合とはみ出しを含む）。行・列が整数でなければ空の範囲。 */
function cellExtent(cell: ParadisSpreadsheetGridCell): ParadisSpreadsheetVirtualRange {
	if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column)) {
		return [0, 0, 0, 0];
	}
	const rowEnd = cell.row + Math.max(1, Math.trunc(cell.rowSpan ?? 1));
	let from = cell.column;
	let to = cell.column + Math.max(1, Math.trunc(cell.columnSpan ?? 1));
	if (cell.overflow && Number.isSafeInteger(cell.overflow.fromColumn) && Number.isSafeInteger(cell.overflow.toColumn)) {
		from = Math.min(from, cell.overflow.fromColumn);
		to = Math.max(to, cell.overflow.toColumn);
	}
	return [cell.row, from, rowEnd, to];
}

function rangesIntersect(a: ParadisSpreadsheetVirtualRange, b: ParadisSpreadsheetVirtualRange): boolean {
	return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function cellKey(pane: ParadisSpreadsheetPaneKind, row: number, column: number): string {
	return `${pane}:${row}:${column}`;
}

/** データバーの linear-gradient だけ（url・関数の入れ子・画像は通さない）。 */
function isSafeGradient(value: string): boolean {
	return value.length <= 1_024 && /^linear-gradient\([#%(),.\s\w-]*\)$/i.test(value) && !/url\s*\(|expression\s*\(|javascript:|image|element\s*\(/i.test(value);
}

const MAXIMUM_CELL_TEXT = 32_768;

function boundedText(value: string): string {
	return typeof value === 'string' ? value.slice(0, MAXIMUM_CELL_TEXT) : '';
}

function applySafeStyle(element: HTMLElement, style: Readonly<Record<string, string>> | undefined): void {
	if (!style) {
		return;
	}
	const target = element.style as unknown as Record<string, string>;
	for (const [property, value] of Object.entries(style)) {
		if (safeStyleProperties.has(property) && typeof value === 'string' && value.length <= 1_024 && !/(?:url\s*\(|expression\s*\(|javascript:)/i.test(value)) {
			target[property] = value;
		} else if (property === 'backgroundImage' && typeof value === 'string' && isSafeGradient(value)) {
			// 条件付き書式のデータバー（DOM の表と同じ linear-gradient だけを通す）
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
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
/** グリッドごとのセルの id の接頭辞（同じ文書に 2 つのグリッドがある差分の画面で id がぶつからないように）。 */
let nextGridId = 0;

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
	/** 列の見出しで並べ替えている向き（aria-sort）。 */
	readonly sort?: 'ascending' | 'descending';
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
	 * スクロール・キー操作の後の描き直しを次のフレームまで待たせる口。同じフレームの間に何度呼ばれても描くのは 1 回。
	 * 既定は requestAnimationFrame（window の無い文書では setTimeout）。
	 */
	readonly scheduleFrame?: (callback: () => void) => IDisposable;
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
	/**
	 * 選んだ範囲（`copyFocusedCell` のとき、ドラッグ・Shift+クリック・Shift+矢印で選ぶ）をコピーする文字を返す。
	 * 画面の外の行は描いていないので、DOM ではなく元のデータから作る（Excel のビューア）。無ければフォーカスのセルの文字。
	 */
	readonly copyRange?: (range: ParadisSpreadsheetVirtualRange) => string;
}

interface RenderedCell {
	readonly element: HTMLElement;
	pane: ParadisSpreadsheetPaneKind;
	/** 描いている行・列の範囲 [行, 列, 行の終わり, 列の終わり)（結合とはみ出しを含む）。 */
	extent: ParadisSpreadsheetVirtualRange;
	/** 最後に描いた中身と位置。次の描画で同じなら書き直さない。 */
	cell?: ParadisSpreadsheetGridCell;
	bounds?: CellBox;
}

interface CellBox {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

interface PendingOverflow {
	readonly element: HTMLElement;
	readonly span: HTMLElement;
	readonly overflow: ParadisSpreadsheetGridOverflow;
	/** はみ出しを当て終えたら `rendered.cell` に記録する中身（当てる前に記録すると、次の描画で同じ中身として飛ばされる）。 */
	readonly rendered: RenderedCell;
	readonly cell: ParadisSpreadsheetGridCell;
}

/** Reusable, safe DOM renderer over generation-fenced viewport tiles. */
export class ParadisSpreadsheetGridRenderer extends Disposable {
	private readonly document: Document;
	private readonly sizer: HTMLElement;
	private readonly panes = new Map<ParadisSpreadsheetPaneKind, HTMLElement>();
	/**
	 * 読み上げ用の行（role="row"）の入れ物。1 つの行のセルは枠（行番号の列・固定の行と列・本体）に分かれて置かれるので、
	 * 行の要素は箱を作らない入れ物にまとめて置き、aria-owns でその行のセルを束ねる（セルの位置は変えない）。
	 */
	private readonly rowsElement: HTMLElement;
	private readonly rowElements = new Map<number, HTMLElement>();
	/** 描いているセルの組が変わったか（変わらない描き直し・キー操作では行を組み直さない）。 */
	private rowsDirty = false;
	private readonly idPrefix = `paradis-spreadsheet-grid${nextGridId++}`;
	private readonly cells = new Map<string, RenderedCell>();
	private readonly cellPool: HTMLElement[] = [];
	private readonly mediaSchedules = new Map<string, IDisposable>();
	private readonly options: ParadisSpreadsheetGridRendererOptions;
	private readonly scrollListener: () => void;
	private readonly keyListener: (event: KeyboardEvent) => void;
	private readonly copyListener: (event: ClipboardEvent) => void;
	private readonly pointerListener: (event: MouseEvent) => void;
	private readonly pointerMoveListener: (event: MouseEvent) => void;
	private readonly pointerUpListener: () => void;
	private readonly focusInListener: () => void;
	private readonly focusOutListener: (event: FocusEvent) => void;
	/** 範囲の選択の起点（フォーカスのセルとの間が選んだ範囲）と、ドラッグ中か。 */
	private selectionAnchor = { row: 0, column: 0 };
	/**
	 * ドラッグの状態。始めたセルの中に留まっている間は 'text'（ブラウザの文字の選択のまま）、
	 * ほかのセルへ出たら 'range'（セルの範囲の選択）。
	 */
	private dragging: 'none' | 'text' | 'range' = 'none';
	private dragStart = { row: 0, column: 0 };
	/** 範囲を選んでいる間の、最後のポインタの位置（端に近づいたら自動でスクロールするため）。 */
	private lastPointer: { readonly x: number; readonly y: number } | undefined;
	private autoScrollTimer: number | undefined;
	/** 描くときに切った（とても長い）セルの元の文字。コピーでは切らずに渡す。 */
	private readonly fullTexts = new Map<string, string>();
	private resizeObserver: IDisposable | undefined;
	private disposed = false;
	private rendering = false;
	private idle: Promise<void> = Promise.resolve();
	/** 次のフレームの描き直しを予約済みか。予約中のスクロール・キー操作は、その 1 回にまとめる。 */
	private frameQueued = false;
	private frameSchedule: IDisposable | undefined;
	private releaseFrame: (() => void) | undefined;
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
		this.rowsElement = this.document.createElement('div');
		this.rowsElement.className = 'paradis-spreadsheet-virtual-rows';
		container.appendChild(this.rowsElement);
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
		this.pointerMoveListener = event => this.onPointerMove(event);
		this.pointerUpListener = () => this.endDrag();
		// フォーカスがグリッドの外にあるときは、選んだセルの印を点線にする（:focus の規則は書かず、クラスで示す）
		this.focusInListener = () => container.classList.add('paradis-spreadsheet-virtual-focused');
		this.focusOutListener = event => {
			if (!container.contains(event.relatedTarget as Node | null)) {
				container.classList.remove('paradis-spreadsheet-virtual-focused');
			}
		};
		container.addEventListener('focusin', this.focusInListener);
		container.addEventListener('focusout', this.focusOutListener);
		// 倍率やシートを替えて作り直したときは、フォーカスがすでに入れ物にある
		container.classList.toggle('paradis-spreadsheet-virtual-focused', container.contains(this.document.activeElement));
		container.addEventListener('scroll', this.scrollListener, { passive: true });
		container.addEventListener('keydown', this.keyListener);
		if (options.copyFocusedCell) {
			container.addEventListener('copy', this.copyListener);
			container.addEventListener('mousedown', this.pointerListener);
			// 枠の外へ出ても範囲を広げられるよう、動きと離したことは document で受ける
			this.document.addEventListener('mousemove', this.pointerMoveListener);
			this.document.addEventListener('mouseup', this.pointerUpListener);
			container.setAttribute('aria-multiselectable', 'true');
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
			// 書体や寸法が変わると、同じ中身でもはみ出しや斜線の測り直しが要るので全部書き直す
			await this.renderCurrent(true, true);
		} finally {
			this.rendering = false;
		}
	}

	/**
	 * セルを画面に出す。`center` のときは画面の中央に出す（検索で移るときの DOM の表の `scrollIntoView` の中央寄せと同じ）。
	 */
	async revealCell(row: number, column: number, center = false): Promise<void> {
		if (this.disposed) {
			return;
		}
		const reveal = this.viewport.revealCell(this._frame, row, column);
		this.focused = { row: reveal.row, column: reveal.column };
		this.selectionAnchor = this.focused;
		let { scrollTop, scrollLeft } = reveal;
		if (center) {
			const plan = this.viewport.plan(this._frame);
			const bounds = this.viewport.cellBounds(reveal.row, reveal.column);
			scrollTop = Math.max(0, bounds.top - plan.frozenHeight - Math.max(0, this._frame.height - plan.frozenHeight - bounds.height) / 2);
			scrollLeft = Math.max(0, bounds.left - plan.frozenWidth - Math.max(0, this._frame.width - plan.frozenWidth - bounds.width) / 2);
		}
		await this.render({ ...this._frame, scrollTop, scrollLeft });
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
		this.container.removeEventListener('focusin', this.focusInListener);
		this.container.removeEventListener('focusout', this.focusOutListener);
		this.container.removeEventListener('copy', this.copyListener);
		this.container.removeEventListener('mousedown', this.pointerListener);
		this.document.removeEventListener('mousemove', this.pointerMoveListener);
		this.document.removeEventListener('mouseup', this.pointerUpListener);
		this.stopAutoScroll();
		this.frameSchedule?.dispose();
		this.frameSchedule = undefined;
		// 予約していた描き直しを待つ whenIdle を止めたままにしない（続きは disposed を見て何もしない）
		this.releaseFrame?.();
		this.resizeObserver?.dispose();
		for (const schedule of this.mediaSchedules.values()) {
			schedule.dispose();
		}
		this.mediaSchedules.clear();
		this.cells.clear();
		this.rowElements.clear();
		this.cellPool.length = 0;
		this.container.replaceChildren();
		super.dispose();
	}

	private async renderCurrent(applyScroll = false, force = false): Promise<ParadisSpreadsheetViewportPlan> {
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
				this.renderCell(key, request.pane, cell, plan.generation, bounds, force);
			}
		}));
		if (this.disposed || plan.generation !== this.viewport.generation) {
			return plan;
		}
		this.pruneCells(activeCells);
		this.applyOverflow();
		this.updateRows();
		this.updateFocusedCell();
		return plan;
	}

	private renderCell(key: string, paneKind: ParadisSpreadsheetPaneKind, cell: ParadisSpreadsheetGridCell, generation: number, bounds: CellBox, force: boolean): void {
		const pane = this.panes.get(paneKind)!;
		let rendered = this.cells.get(key);
		// 前に描いたときと中身・位置・枠が同じセルは、書き直しても同じになるので触らない（スクロールのたびに見えている
		// 全セルの class・style・文字を設定し直さない）。画像は世代ごとに遅れて足すので、画像のあるセルは毎回描く
		if (!force && rendered && rendered.pane === paneKind && !cell.media && rendered.cell && sameBox(rendered.bounds, bounds) && equals(rendered.cell, cell)) {
			return;
		}
		if (!rendered) {
			const element = this.cellPool.pop() ?? this.document.createElement('div');
			rendered = { element, pane: paneKind, extent: cellExtent(cell) };
			this.cells.set(key, rendered);
			pane.appendChild(element);
			this.rowsDirty = true;
		} else if (rendered.pane !== paneKind) {
			rendered.pane = paneKind;
			pane.appendChild(rendered.element);
			this.rowsDirty = true;
		}
		rendered.extent = cellExtent(cell);
		rendered.cell = cell;
		rendered.bounds = bounds;
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
		// 枠をまたぐ結合のセルは 2 つの枠に描くので、id には枠も入れる
		element.id = `${this.idPrefix}-${paneKind}-${cell.row}-${cell.column}`;
		element.setAttribute('role', cell.header === 'column' ? 'columnheader' : cell.header === 'row' ? 'rowheader' : 'gridcell');
		if (cell.header) {
			element.dataset.header = cell.header;
		} else {
			delete element.dataset.header;
		}
		if (cell.header === 'column' && (cell.sort === 'ascending' || cell.sort === 'descending')) {
			element.setAttribute('aria-sort', cell.sort);
		} else {
			element.removeAttribute('aria-sort');
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
			// はみ出しを当てるまでは描き終えていない。世代が進んで当てずに終わっても、次の描画で書き直させる。
			rendered.cell = undefined;
			this.pendingOverflow.push({ element, span, overflow: cell.overflow, rendered, cell });
		}
		if (cell.baseDiagonal || cell.conditionalDiagonal) {
			// One layout read supplies both layers. Scroll/freeze/overscan coordinates never enter diagonal geometry.
			const measured = this.measureCell(element, bounds);
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
			const schedule = (this.options.scheduleMedia ?? (callback => defaultScheduleFrame(this.document, callback)))(() => {
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
		for (const { item: { element, span, overflow, rendered, cell }, need, avail } of measures) {
			if (rendered.element === element) {
				rendered.cell = cell;
			}
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

	private measureCell(element: HTMLElement, bounds: CellBox): ParadisSpreadsheetCellBounds {
		if (this.options.measureCell) {
			return sanitizeBounds(this.options.measureCell(element));
		}
		// セルは box-sizing: border-box で、幅と高さは viewport の寸法（倍率を掛ける前）をそのまま当てている。
		// 書き込みの途中で getBoundingClientRect を読んでレイアウトを起こさないよう、当てた寸法を使う
		return sanitizeBounds({ width: bounds.width, height: bounds.height });
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
			this.rowsDirty = true;
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

	/**
	 * スクロール・キー操作の後の描き直しを次のフレームで 1 回だけ行う。予約中に何度呼ばれても増やさず、
	 * 描く位置（入れ物のスクロールと大きさ）は描く直前に読む。
	 */
	private queueRender(): void {
		if (this.frameQueued) {
			return;
		}
		this.frameQueued = true;
		const frame = new Promise<void>(resolve => {
			this.releaseFrame = resolve;
			const schedule = this.options.scheduleFrame ?? (callback => defaultScheduleFrame(this.document, callback));
			this.frameSchedule = schedule(() => {
				this.frameQueued = false;
				this.frameSchedule = undefined;
				this.releaseFrame = undefined;
				resolve();
			});
		});
		this.idle = this.idle.then(() => frame).then(async () => {
			if (this.disposed) {
				return;
			}
			this._frame = {
				scrollTop: this.container.scrollTop / this.zoom,
				scrollLeft: this.container.scrollLeft / this.zoom,
				width: this.container.clientWidth ? this.container.clientWidth / this.zoom : this._frame.width,
				height: this.container.clientHeight ? this.container.clientHeight / this.zoom : this._frame.height,
			};
			await this.render(this._frame);
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
		if (!event.shiftKey) {
			// Shift を押していなければ範囲は移した先の 1 つのセル（押していれば起点を残して広げる）
			this.selectionAnchor = this.focused;
		}
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
		if (!event.clipboardData) {
			return;
		}
		let value: string;
		if (this.options.copyRange) {
			// 選んだ範囲（1 つのセルだけのときはそのセル）を、元のデータから行はタブ・行末は改行でつなぐ
			value = this.options.copyRange(this.selectionRange);
		} else {
			const entry = [...this.cells].find(([, rendered]) => Number(rendered.element.dataset.row) === this.focused.row && Number(rendered.element.dataset.column) === this.focused.column);
			// 見出しのセルではコピーを横取りしない
			if (!entry || entry[1].element.dataset.header) {
				return;
			}
			value = this.fullTexts.get(entry[0]) ?? entry[1].element.textContent ?? '';
		}
		// 空のときは横取りしない（手元のクリップボードを空で上書きしない）
		if (!value) {
			return;
		}
		event.clipboardData.setData('text/plain', value);
		event.preventDefault();
	}

	/** 選んだ範囲 [行, 列, 行の終わり, 列の終わり)。 */
	get selectionRange(): ParadisSpreadsheetVirtualRange {
		return [
			Math.min(this.selectionAnchor.row, this.focused.row), Math.min(this.selectionAnchor.column, this.focused.column),
			Math.max(this.selectionAnchor.row, this.focused.row) + 1, Math.max(this.selectionAnchor.column, this.focused.column) + 1,
		];
	}

	private cellAt(event: MouseEvent, includeHeaders = false): { readonly row: number; readonly column: number } | undefined {
		const target = event.target as Element | null;
		const element = target?.closest?.('.paradis-spreadsheet-virtual-cell') as HTMLElement | null | undefined;
		if (!element || !this.container.contains(element) || (element.dataset.header && !includeHeaders)) {
			return undefined;
		}
		const row = Number(element.dataset.row);
		const column = Number(element.dataset.column);
		return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { row, column } : undefined;
	}

	/** クリックしたセルにフォーカスを移す。Shift なら起点を残して範囲を広げ、押したまま動かすと範囲を選ぶ。 */
	private onPointerDown(event: MouseEvent): void {
		// 見出しをクリックしたときは、そこにフォーカスを移すだけ（表と同じく、その後のコピーでは何も入らない）
		const cell = event.button === 0 ? this.cellAt(event, true) : undefined;
		if (!cell) {
			return;
		}
		this.endDrag();
		const header = !!(event.target as Element).closest?.('.paradis-spreadsheet-virtual-cell')?.getAttribute('data-header');
		this.focused = cell;
		if (!event.shiftKey || header) {
			this.selectionAnchor = cell;
		}
		// 押した直後はブラウザの文字の選択のまま（セルの中の一部を選べる・ダブルクリックで語を選べる）。
		// Shift+クリックは範囲を広げる操作なので、はじめから範囲の選択にする
		this.dragging = header ? 'none' : event.shiftKey ? 'range' : 'text';
		this.dragStart = cell;
		if (this.dragging === 'range') {
			this.beginRangeSelection();
		}
		this.updateFocusedCell();
	}

	private onPointerMove(event: MouseEvent): void {
		if (this.dragging === 'none') {
			return;
		}
		if ((event.buttons & 1) === 0) {
			this.endDrag();
			return;
		}
		this.lastPointer = { x: event.clientX, y: event.clientY };
		const cell = this.cellAt(event) ?? this.cellNearPointer();
		if (this.dragging === 'text') {
			// 始めたセルの中ならブラウザの文字の選択に任せる。ほかのセルへ出たら範囲の選択に切り替える
			if (!cell || (cell.row === this.dragStart.row && cell.column === this.dragStart.column)) {
				return;
			}
			this.beginRangeSelection();
		}
		if (cell && (cell.row !== this.focused.row || cell.column !== this.focused.column)) {
			this.focused = cell;
			this.updateFocusedCell();
		}
	}

	private beginRangeSelection(): void {
		this.dragging = 'range';
		// 文字の選択は外し、範囲の選択の間だけ文字を選べないようにする（セルの間をなぞって文字が選ばれないように）
		this.document.getSelection()?.removeAllRanges();
		this.container.classList.add('paradis-spreadsheet-virtual-range-selecting');
		this.stopAutoScroll();
		this.autoScrollTimer = this.document.defaultView?.setInterval(() => this.autoScroll(), AUTO_SCROLL_INTERVAL_MS);
	}

	private endDrag(): void {
		this.dragging = 'none';
		this.lastPointer = undefined;
		this.container.classList.remove('paradis-spreadsheet-virtual-range-selecting');
		this.stopAutoScroll();
	}

	private stopAutoScroll(): void {
		if (this.autoScrollTimer !== undefined) {
			this.document.defaultView?.clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = undefined;
		}
	}

	/** 範囲を選んでいる間、ポインタが本体の端に近い・外にあるときは、その向きへスクロールして範囲を広げる。 */
	private autoScroll(): void {
		const pointer = this.lastPointer;
		if (this.dragging !== 'range' || !pointer || this.disposed) {
			return;
		}
		const rect = this.container.getBoundingClientRect();
		const step = (position: number, start: number, end: number) => position < start + AUTO_SCROLL_EDGE ? -Math.min(AUTO_SCROLL_MAX_STEP, start + AUTO_SCROLL_EDGE - position)
			: position > end - AUTO_SCROLL_EDGE ? Math.min(AUTO_SCROLL_MAX_STEP, position - (end - AUTO_SCROLL_EDGE)) : 0;
		const dy = step(pointer.y, rect.top, rect.bottom);
		const dx = step(pointer.x, rect.left, rect.right);
		if (!dx && !dy) {
			return;
		}
		this.container.scrollTop += dy;
		this.container.scrollLeft += dx;
		const cell = this.cellNearPointer();
		if (cell && (cell.row !== this.focused.row || cell.column !== this.focused.column)) {
			this.focused = cell;
		}
		this.queueRender();
	}

	/** ポインタの位置を本体の枠の中に収めたところにあるセル（枠の外へ出たときに、端のセルまで範囲を広げるため）。 */
	private cellNearPointer(): { readonly row: number; readonly column: number } | undefined {
		const pointer = this.lastPointer;
		if (!pointer) {
			return undefined;
		}
		// スクロールバーの上ではセルが見つからないので、中身の見えている部分（client の大きさ）に収める
		const rect = this.container.getBoundingClientRect();
		const x = Math.min(Math.max(pointer.x, rect.left + this.container.clientLeft + 1), rect.left + this.container.clientLeft + this.container.clientWidth - 2);
		const y = Math.min(Math.max(pointer.y, rect.top + this.container.clientTop + 1), rect.top + this.container.clientTop + this.container.clientHeight - 2);
		const element = this.document.elementFromPoint(x, y)?.closest('.paradis-spreadsheet-virtual-cell') as HTMLElement | null | undefined;
		if (!element || !this.container.contains(element) || element.dataset.header) {
			return undefined;
		}
		const row = Number(element.dataset.row);
		const column = Number(element.dataset.column);
		return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { row, column } : undefined;
	}

	/** 選んでいる範囲（起点とフォーカス）。作り直したグリッドで戻すため。 */
	get selection(): { readonly anchor: { readonly row: number; readonly column: number }; readonly focused: { readonly row: number; readonly column: number } } {
		return { anchor: { ...this.selectionAnchor }, focused: { ...this.focused } };
	}

	setSelection(anchor: { readonly row: number; readonly column: number }, focused: { readonly row: number; readonly column: number }): void {
		if ([anchor.row, anchor.column, focused.row, focused.column].every(Number.isSafeInteger)) {
			this.selectionAnchor = { row: anchor.row, column: anchor.column };
			this.focused = { row: focused.row, column: focused.column };
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
		const [rowStart, columnStart, rowEnd, columnEnd] = this.selectionRange;
		// 1 つのセルだけのときは表と同じく塗らない（表でもクリックしただけでは選択の色が付かない）
		const multiple = rowEnd - rowStart > 1 || columnEnd - columnStart > 1;
		for (const rendered of this.cells.values()) {
			const cellRow = Number(rendered.element.dataset.row);
			const cellColumn = Number(rendered.element.dataset.column);
			const header = rendered.element.dataset.header;
			const inRange = multiple && !header
				&& cellRow >= rowStart && cellRow < rowEnd && cellColumn >= columnStart && cellColumn < columnEnd;
			rendered.element.classList.toggle('paradis-spreadsheet-virtual-selected', inRange);
			if (this.options.copyFocusedCell && !header) {
				rendered.element.setAttribute('aria-selected', String(inRange || (cellRow === this.focused.row && cellColumn === this.focused.column)));
			}
			const selected = cellRow === this.focused.row && cellColumn === this.focused.column;
			// フォーカスは入れ物に残し（aria-activedescendant でセルを指す）、Tab の止まる所は入れ物の 1 つだけにする
			rendered.element.tabIndex = -1;
			// キーボードで動かしたセルの印と、その列記号・行番号を濃くする印（見た目は Excel のビューアの CSS だけが付ける）
			rendered.element.classList.toggle('paradis-spreadsheet-virtual-active', selected && !header);
			rendered.element.classList.toggle('paradis-spreadsheet-virtual-header-active', header === 'column' ? cellColumn === this.focused.column : header === 'row' && cellRow === this.focused.row);
			if (selected) {
				this.container.setAttribute('aria-activedescendant', rendered.element.id);
			}
		}
	}

	/**
	 * 描いているセルを行ごとにまとめ、行の要素（role="row"、aria-rowindex）の aria-owns に列の順で並べる。
	 * 行の要素は行の順に並べ、描いていない行の要素は外す。
	 */
	private updateRows(): void {
		if (!this.rowsDirty) {
			return;
		}
		this.rowsDirty = false;
		const byRow = new Map<number, { readonly column: number; readonly id: string }[]>();
		for (const rendered of this.cells.values()) {
			const row = Number(rendered.element.dataset.row);
			const column = Number(rendered.element.dataset.column);
			if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || !rendered.element.id) {
				continue;
			}
			let cells = byRow.get(row);
			if (!cells) {
				cells = [];
				byRow.set(row, cells);
			}
			cells.push({ column, id: rendered.element.id });
		}
		for (const [row, element] of this.rowElements) {
			if (!byRow.has(row)) {
				element.remove();
				this.rowElements.delete(row);
			}
		}
		const rows = [...byRow.keys()].sort((a, b) => a - b);
		let reorder = false;
		for (const row of rows) {
			let element = this.rowElements.get(row);
			if (!element) {
				element = this.document.createElement('div');
				element.className = 'paradis-spreadsheet-virtual-row';
				element.setAttribute('role', 'row');
				element.setAttribute('aria-rowindex', String(row + 1));
				this.rowElements.set(row, element);
				reorder = true;
			}
			const owns = byRow.get(row)!.sort((a, b) => a.column - b.column).map(cell => cell.id).join(' ');
			if (element.getAttribute('aria-owns') !== owns) {
				element.setAttribute('aria-owns', owns);
			}
		}
		if (reorder) {
			this.rowsElement.replaceChildren(...rows.map(row => this.rowElements.get(row)!));
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
/** 範囲を選んでいる間の自動スクロール: 端からこの距離に入ったら、この間隔で最大この量ずつ動かす。 */
const AUTO_SCROLL_EDGE = 24;
const AUTO_SCROLL_INTERVAL_MS = 50;
const AUTO_SCROLL_MAX_STEP = 40;

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

function defaultScheduleFrame(document: Document, callback: () => void): IDisposable {
	const targetWindow = document.defaultView;
	if (targetWindow) {
		const handle = targetWindow.requestAnimationFrame(callback);
		return { dispose: () => targetWindow.cancelAnimationFrame(handle) };
	}
	const handle = setTimeout(callback, 0);
	return { dispose: () => clearTimeout(handle) };
}

function sameBox(previous: CellBox | undefined, next: CellBox): boolean {
	return !!previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height;
}

function isNavigationKey(key: string): key is ParadisSpreadsheetNavigationKey {
	return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
		|| key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
}

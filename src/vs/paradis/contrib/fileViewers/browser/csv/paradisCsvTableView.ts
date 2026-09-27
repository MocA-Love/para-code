/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV を表で見せる部品（読み取り専用）。Excel ビューアの仮想化グリッド（ParadisSpreadsheetViewport +
// ParadisSpreadsheetGridRenderer）をそのまま使い、見えている範囲のセルだけを DOM にする。
//
// グリッド上の座標: 行 0 = CSV の見出し行（上に固定）、行 r >= 1 = データ行の表示順で r 番目。
//                  列 0 = 行番号（左に固定）、列 c >= 1 = CSV の c-1 列目。
// 並べ替えは表示順の配列（order）を差し替えるだけで、本文や索引には手を入れない。
// 選択・検索の一致・並べ替えの印は、タイルを返すときに付けるクラス名で表す（描き直しで反映）。

import * as dom from '../../../../../base/browser/dom.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import type { ParadisOfficeSearchResult } from '../../common/paradisOfficeProtocol.js';
import { PARADIS_OFFICE_SEARCH_PAGE_SIZE, type ParadisOfficeSearchPage } from '../../common/paradisOfficeSearch.js';
import {
	estimateParadisCsvColumnWidth,
	formatParadisCsvAsTsv,
	isParadisCsvNumeric,
	searchParadisCsv,
	sortParadisCsvRows,
	type ParadisCsvDocument,
	type ParadisCsvMatch,
	type ParadisCsvSearchResult,
	type ParadisCsvSortDirection,
} from '../../common/csv/paradisCsv.js';
import { applyParadisOfficeGridMetadata } from '../paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget, type ParadisOfficeFindSearchProvider } from '../paradisOfficeFindWidget.js';
import { ParadisSpreadsheetGridRenderer, type ParadisSpreadsheetGridCell, type ParadisSpreadsheetGridTile } from '../spreadsheet/paradisSpreadsheetGridRenderer.js';
import { ParadisSpreadsheetViewport, type ParadisSpreadsheetTileRequest } from '../spreadsheet/paradisSpreadsheetViewport.js';

import '../spreadsheet/media/paradisSpreadsheetGrid.css';
import './media/paradisCsvViewer.css';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 24;
const MINIMUM_COLUMN_WIDTH = 32;
const MAXIMUM_COLUMN_WIDTH = 2_000;
const RESIZE_HANDLE_WIDTH = 5;
const WIDTH_SAMPLE_RECORDS = 200;
const SORT_INDICATOR_WIDTH = 14;
/** 1 回のコピーで扱うセル数の上限。超える分は先頭の行だけにする。 */
const MAXIMUM_COPY_CELLS = 2_000_000;
/** 1 回のコピーで作る文字列の長さの上限（クリップボードへ送る量を抑える）。 */
const MAXIMUM_COPY_CHARACTERS = 16 * 1024 * 1024;
const MAXIMUM_PREVIEW_CONTEXT = 30;

interface CellPosition {
	readonly row: number;
	readonly column: number;
}

interface CsvSelection {
	readonly anchor: CellPosition;
	readonly active: CellPosition;
	/** 行番号から選んだ（行全体を選択している）。 */
	readonly wholeRows: boolean;
}

interface SelectionRect {
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;
}

export interface ParadisCsvSortState {
	readonly column: number;
	readonly direction: ParadisCsvSortDirection;
	/** 並べ替えの計算中。 */
	readonly pending: boolean;
}

export interface ParadisCsvTableViewOptions {
	/** 選択範囲のコピー先。 */
	readonly writeClipboard: (text: string) => Promise<void>;
	/** ユーザーへ短い知らせを出す（コピーを打ち切ったとき等）。 */
	readonly notify: (message: string) => void;
	/** 並べ替えの状態が変わった（フッターの表示を更新する）。 */
	readonly onDidChangeState: () => void;
}

/** CSV の表示部品。{@link setDocument} で中身を差し替え、{@link layout} で大きさを伝える。 */
export class ParadisCsvTableView extends Disposable {

	readonly element: HTMLElement;
	private readonly _host: HTMLElement;
	private readonly _renderer = this._register(new MutableDisposable<ParadisSpreadsheetGridRenderer>());
	private readonly _findWidget: ParadisOfficeFindWidget;
	private readonly _dragStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _sortRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _pendingResize = this._register(new MutableDisposable());

	private _viewport: ParadisSpreadsheetViewport | undefined;
	private _document: ParadisCsvDocument | undefined;
	private _generation = 0;
	private _order: Uint32Array | undefined;
	private _sort: ParadisCsvSortState | undefined;
	/** CSV の列ごとの幅（px）。ユーザーが変えた幅は再読込でも保つ。 */
	private _columnWidths: number[] = [];
	private readonly _userColumnWidths = new Map<number, number>();
	private _rowNumberWidth = 48;
	private _selection: CsvSelection = { anchor: { row: 1, column: 1 }, active: { row: 1, column: 1 }, wholeRows: false };
	private _search: { readonly key: string; readonly document: ParadisCsvDocument; readonly order: Uint32Array | undefined; readonly result: ParadisCsvSearchResult } | undefined;
	private _matchKeys = new Set<number>();
	private _currentMatchKey: number | undefined;
	private _findWasVisible = false;

	constructor(parent: HTMLElement, private readonly _options: ParadisCsvTableViewOptions) {
		super();
		this.element = dom.append(parent, dom.$('.paradis-csv-table'));
		this._host = dom.append(this.element, dom.$('.paradis-csv-grid'));
		this._findWidget = this._register(new ParadisOfficeFindWidget(this.element, {
			search: this._searchProvider,
			onNavigate: result => this._navigateToMatch(result),
		}));

		// キー操作は描画部品（矢印キーでフォーカスを動かす）より先に受け取り、選択として扱う。
		this._register(dom.addDisposableListener(this._host, dom.EventType.KEY_DOWN, e => this._onKeyDown(e), true));
		this._register(dom.addDisposableListener(this._host, dom.EventType.MOUSE_DOWN, e => this._onMouseDown(e)));
		this._register(dom.addDisposableListener(this._host, dom.EventType.MOUSE_MOVE, e => this._onHoverMove(e)));
		this._register(dom.addDisposableListener(this._host, dom.EventType.MOUSE_LEAVE, () => this._host.classList.remove('paradis-csv-resize-cursor')));
		// 検索ウィジェットを閉じたら一致の色を消す（閉じた合図は公開されていないので、操作のたびに見比べる）。
		const syncFindVisibility = () => {
			const visible = this._findWidget.isVisible();
			if (visible !== this._findWasVisible) {
				this._findWasVisible = visible;
				this._rerender();
			}
		};
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_UP, syncFindVisibility));
		this._register(dom.addDisposableListener(this.element, dom.EventType.CLICK, syncFindVisibility));
	}

	get document(): ParadisCsvDocument | undefined {
		return this._document;
	}

	get sortState(): ParadisCsvSortState | undefined {
		return this._sort;
	}

	/**
	 * 表示する文書を差し替える。`preserveView` のときは（同じファイルの再読込）スクロール位置・選択・
	 * 並べ替え・変更した列幅を引き継ぐ。
	 */
	setDocument(document: ParadisCsvDocument | undefined, preserveView: boolean): void {
		if (this._store.isDisposed) {
			return;
		}
		this._generation++;
		// 列幅のドラッグ中に中身が変わったら、古い列番号で幅を当てないよう打ち切る。
		this._dragStore.clear();
		this._pendingResize.clear();
		this._sortRequest.value?.cancel();
		this._sortRequest.clear();
		this._search = undefined;
		this._matchKeys = new Set();
		this._currentMatchKey = undefined;
		const previousFrame = preserveView ? this._renderer.value?.frame : undefined;
		const previousSort = preserveView ? this._sort : undefined;
		this._renderer.clear();
		this._viewport = undefined;
		this._document = document;
		this._order = undefined;
		this._sort = undefined;
		if (!preserveView) {
			this._userColumnWidths.clear();
			this._selection = { anchor: { row: 1, column: 1 }, active: { row: 1, column: 1 }, wholeRows: false };
		}
		this._findWidget.setSearchProvider(document ? this._searchProvider : undefined);
		if (!document || document.recordCount === 0) {
			this._options.onDidChangeState();
			return;
		}

		this._selection = this._clampSelection(this._selection);
		this._columnWidths = this._measureColumnWidths(document);
		this._rowNumberWidth = Math.max(40, String(document.dataRowCount).length * 8 + 18);
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: document.recordCount,
			columnCount: document.columnCount + 1,
			defaultRowHeight: ROW_HEIGHT,
			defaultColumnWidth: 80,
			rowMetrics: [{ index: 0, size: HEADER_HEIGHT }],
			columnMetrics: [{ index: 0, size: this._rowNumberWidth }, ...this._columnWidths.map((size, index) => ({ index: index + 1, size }))],
			frozenRows: 1,
			frozenColumns: 1,
			revision: `csv:${this._generation}`,
		});
		this._viewport = viewport;
		const renderer = new ParadisSpreadsheetGridRenderer(this._host, viewport, {
			getViewport: async request => this._tile(request),
			fontsReady: dom.getWindow(this._host).document.fonts.ready,
		});
		applyParadisOfficeGridMetadata(this._host, localize('paradis.csv.gridLabel', "CSV の表"), document.recordCount, document.columnCount + 1);
		this._renderer.value = renderer;
		renderer.render({
			scrollTop: previousFrame?.scrollTop ?? 0,
			scrollLeft: previousFrame?.scrollLeft ?? 0,
			width: Math.max(1, this._host.clientWidth),
			height: Math.max(1, this._host.clientHeight),
		}).catch(onUnexpectedError);
		if (previousSort && previousSort.column < document.columnCount) {
			this._applySort({ column: previousSort.column, direction: previousSort.direction, pending: true });
		} else if (preserveView) {
			this._findWidget.refresh();
		}
		this._options.onDidChangeState();
	}

	override dispose(): void {
		// MutableDisposable は CancellationTokenSource を取り消さずに捨てるので、先に取り消して並べ替えを止める。
		this._sortRequest.value?.cancel();
		super.dispose();
	}

	/** 表示領域の大きさが変わった。 */
	layout(): void {
		const renderer = this._renderer.value;
		if (!renderer) {
			return;
		}
		renderer.render({
			...renderer.frame,
			width: Math.max(1, this._host.clientWidth),
			height: Math.max(1, this._host.clientHeight),
		}).catch(onUnexpectedError);
	}

	focus(): void {
		this._host.focus();
	}

	/** 列 `column`（CSV の列番号）の見出し。見出しが空なら列番号で表す。 */
	columnName(column: number): string {
		const name = this._document?.getField(0, column).trim();
		return name ? name : localize('paradis.csv.columnNumber', "{0} 列目", column + 1);
	}

	// --- タイル -----------------------------------------------------------------------------

	private _tile(request: ParadisSpreadsheetTileRequest): ParadisSpreadsheetGridTile {
		const document = this._document;
		const cells: ParadisSpreadsheetGridCell[] = [];
		if (!document) {
			return { revision: request.revision, range: request.range, cells };
		}
		const rect = this._selectionRect();
		const active = this._selection.active;
		const findVisible = this._findWidget.isVisible();
		const [rowStart, columnStart, rowEnd, columnEnd] = request.range;
		for (let row = rowStart; row < rowEnd; row++) {
			const fields = document.getRecord(this._recordForRow(row));
			const rowSelected = row >= rect.top && row <= rect.bottom;
			for (let column = columnStart; column < columnEnd; column++) {
				const classNames: string[] = [];
				let text: string;
				if (column === 0) {
					text = row === 0 ? '' : String(row);
					classNames.push(row === 0 ? 'paradis-csv-corner' : 'paradis-csv-rownum');
					if (row > 0 && rowSelected) {
						classNames.push('paradis-csv-rownum-selected');
					}
				} else {
					text = fields[column - 1] ?? '';
					const columnSelected = column >= rect.left && column <= rect.right;
					if (row === 0) {
						classNames.push('paradis-csv-header');
						if (this._sort?.column === column - 1) {
							classNames.push(this._sort.direction === 'asc' ? 'paradis-csv-sorted-asc' : 'paradis-csv-sorted-desc');
						}
						if (columnSelected) {
							classNames.push('paradis-csv-header-selected');
						}
					} else if (isParadisCsvNumeric(text)) {
						classNames.push('paradis-csv-number');
					}
					if (rowSelected && columnSelected) {
						classNames.push('paradis-csv-selected');
					}
					if (row === active.row && column === active.column) {
						classNames.push('paradis-csv-active');
					}
					if (findVisible && this._matchKeys.size > 0) {
						const key = this._cellKey(row, column);
						if (this._matchKeys.has(key)) {
							classNames.push(key === this._currentMatchKey ? 'paradis-csv-match-current' : 'paradis-csv-match');
						}
					}
				}
				cells.push({ row, column, text, classNames });
			}
		}
		return { revision: request.revision, range: request.range, cells };
	}

	/** グリッドの行から CSV のレコード番号へ（並べ替えを反映する）。 */
	private _recordForRow(row: number): number {
		if (row <= 0) {
			return 0;
		}
		return 1 + (this._order ? this._order[row - 1] : row - 1);
	}

	private _cellKey(row: number, column: number): number {
		return row * ((this._document?.columnCount ?? 0) + 1) + column;
	}

	private _rerender(): void {
		const renderer = this._renderer.value;
		if (renderer) {
			renderer.render(renderer.frame).catch(onUnexpectedError);
		}
	}

	/** 見出しと、先頭および全体から均等に拾った行で列の初期幅を決める（ユーザーが変えた幅は優先）。 */
	private _measureColumnWidths(document: ParadisCsvDocument): number[] {
		const samples: string[][] = Array.from({ length: document.columnCount }, () => []);
		const records = new Set<number>();
		const leading = Math.min(document.recordCount, WIDTH_SAMPLE_RECORDS / 2);
		for (let record = 1; record < leading; record++) {
			records.add(record);
		}
		const step = Math.max(1, Math.floor(document.recordCount / (WIDTH_SAMPLE_RECORDS / 2)));
		for (let record = leading; record < document.recordCount; record += step) {
			records.add(record);
		}
		for (const record of records) {
			const fields = document.getRecord(record);
			for (let column = 0; column < document.columnCount; column++) {
				samples[column].push(fields[column] ?? '');
			}
		}
		return samples.map((values, column) => this._userColumnWidths.get(column) ?? Math.max(
			estimateParadisCsvColumnWidth(values),
			// 見出しは並べ替えの印の分だけ広く取る。
			estimateParadisCsvColumnWidth([document.getField(0, column)], 7, 18 + SORT_INDICATOR_WIDTH),
		));
	}

	// --- 選択 -------------------------------------------------------------------------------

	private get _lastRow(): number {
		return Math.max(0, (this._document?.recordCount ?? 1) - 1);
	}

	private get _lastColumn(): number {
		return Math.max(1, this._document?.columnCount ?? 1);
	}

	private _clampPosition(position: CellPosition): CellPosition {
		return {
			row: Math.max(0, Math.min(this._lastRow, position.row)),
			column: Math.max(1, Math.min(this._lastColumn, position.column)),
		};
	}

	private _clampSelection(selection: CsvSelection): CsvSelection {
		return { anchor: this._clampPosition(selection.anchor), active: this._clampPosition(selection.active), wholeRows: selection.wholeRows };
	}

	private _selectionRect(): SelectionRect {
		const { anchor, active, wholeRows } = this._selection;
		return {
			top: Math.min(anchor.row, active.row),
			bottom: Math.max(anchor.row, active.row),
			left: wholeRows ? 1 : Math.min(anchor.column, active.column),
			right: wholeRows ? this._lastColumn : Math.max(anchor.column, active.column),
		};
	}

	private _setSelection(selection: CsvSelection, reveal: boolean): void {
		this._selection = this._clampSelection(selection);
		if (reveal) {
			this._reveal(this._selection.active);
		} else {
			this._rerender();
		}
	}

	/** セルが固定の見出し行・行番号の陰に隠れないようにスクロールしてから描く。 */
	private _reveal(position: CellPosition): void {
		const renderer = this._renderer.value;
		const viewport = this._viewport;
		if (!renderer || !viewport) {
			return;
		}
		const frame = renderer.frame;
		const bounds = viewport.cellBounds(position.row, position.column);
		const frozen = viewport.cellBounds(0, 0);
		let scrollTop = frame.scrollTop;
		let scrollLeft = frame.scrollLeft;
		if (position.row > 0) {
			if (bounds.top < scrollTop + frozen.height) {
				scrollTop = bounds.top - frozen.height;
			} else if (bounds.top + bounds.height > scrollTop + frame.height) {
				scrollTop = bounds.top + bounds.height - frame.height;
			}
		}
		if (position.column > 0) {
			if (bounds.left < scrollLeft + frozen.width) {
				scrollLeft = bounds.left - frozen.width;
			} else if (bounds.left + bounds.width > scrollLeft + frame.width) {
				scrollLeft = Math.min(bounds.left - frozen.width, bounds.left + bounds.width - frame.width);
			}
		}
		renderer.render({ ...frame, scrollTop: Math.max(0, scrollTop), scrollLeft: Math.max(0, scrollLeft) }).catch(onUnexpectedError);
	}

	private _selectAll(): void {
		this._setSelection({ anchor: { row: 0, column: 1 }, active: { row: this._lastRow, column: this._lastColumn }, wholeRows: false }, false);
	}

	private _onKeyDown(event: KeyboardEvent): void {
		if (!this._document || !this._renderer.value) {
			return;
		}
		const primary = isMacintosh ? event.metaKey : event.ctrlKey;
		const key = event.key;
		if (primary && !event.altKey && !event.shiftKey && (key === 'c' || key === 'C')) {
			this._consume(event);
			this._copySelection().catch(onUnexpectedError);
			return;
		}
		if (primary && !event.altKey && !event.shiftKey && (key === 'a' || key === 'A')) {
			this._consume(event);
			this._selectAll();
			return;
		}
		// Alt 付き（macOS の Cmd+Alt+←/→ でのエディタ切替、Windows の Alt+← の戻る）と、Ctrl/Cmd+PageUp/PageDown
		// （タブ切替）はワークベンチのショートカットに任せる。
		if (event.altKey || (primary && (key === 'PageUp' || key === 'PageDown'))) {
			return;
		}
		const next = this._navigate(key, primary);
		if (!next) {
			return;
		}
		this._consume(event);
		const vertical = key === 'ArrowUp' || key === 'ArrowDown' || key === 'PageUp' || key === 'PageDown';
		if (event.shiftKey) {
			const wholeRows = this._selection.wholeRows && vertical;
			this._setSelection({ anchor: this._selection.anchor, active: wholeRows ? { row: next.row, column: this._lastColumn } : next, wholeRows }, true);
		} else {
			this._setSelection({ anchor: next, active: next, wholeRows: false }, true);
		}
	}

	private _navigate(key: string, jump: boolean): CellPosition | undefined {
		const { row, column } = this._selection.active;
		const frame = this._renderer.value?.frame;
		const page = Math.max(1, Math.floor(((frame?.height ?? ROW_HEIGHT * 10) - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
		switch (key) {
			case 'ArrowUp': return { row: jump ? 0 : row - 1, column };
			case 'ArrowDown': return { row: jump ? this._lastRow : row + 1, column };
			case 'ArrowLeft': return this._clampPosition({ row, column: jump ? 1 : column - 1 });
			case 'ArrowRight': return this._clampPosition({ row, column: jump ? this._lastColumn : column + 1 });
			case 'PageUp': return this._clampPosition({ row: row - page, column });
			case 'PageDown': return this._clampPosition({ row: row + page, column });
			case 'Home': return this._clampPosition(jump ? { row: 0, column: 1 } : { row, column: 1 });
			case 'End': return this._clampPosition(jump ? { row: this._lastRow, column: this._lastColumn } : { row, column: this._lastColumn });
			default: return undefined;
		}
	}

	private _consume(event: Event): void {
		event.preventDefault();
		event.stopPropagation();
	}

	private async _copySelection(): Promise<void> {
		const document = this._document;
		if (!document) {
			return;
		}
		const rect = this._selectionRect();
		const width = rect.right - rect.left + 1;
		const maximumRows = Math.max(1, Math.floor(MAXIMUM_COPY_CELLS / width));
		const bottom = Math.min(rect.bottom, rect.top + maximumRows - 1);
		const rows: string[][] = [];
		let characters = 0;
		for (let row = rect.top; row <= bottom && characters <= MAXIMUM_COPY_CHARACTERS; row++) {
			const fields = document.parseRecord(this._recordForRow(row));
			const values: string[] = [];
			for (let column = rect.left; column <= rect.right; column++) {
				const value = fields[column - 1] ?? '';
				characters += value.length + 1;
				values.push(value);
			}
			rows.push(values);
		}
		await this._options.writeClipboard(formatParadisCsvAsTsv(rows));
		if (rect.top + rows.length - 1 < rect.bottom) {
			this._options.notify(localize('paradis.csv.copyTruncated', "選択範囲が大きいため、先頭の {0} 行だけをコピーしました。", rows.length));
		}
	}

	// --- マウス -----------------------------------------------------------------------------

	private _cellFromTarget(target: EventTarget | null): { readonly position: CellPosition; readonly element: HTMLElement } | undefined {
		if (!dom.isHTMLElement(target)) {
			return undefined;
		}
		const element = target.closest<HTMLElement>('.paradis-spreadsheet-virtual-cell');
		if (!element || !this._host.contains(element)) {
			return undefined;
		}
		const row = Number(element.dataset.row);
		const column = Number(element.dataset.column);
		return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { position: { row, column }, element } : undefined;
	}

	/** 見出しセルの左右の端にポインタがあれば、幅を変える対象の列（グリッドの列）を返す。 */
	private _resizeTarget(event: MouseEvent, cell: { readonly position: CellPosition; readonly element: HTMLElement }): number | undefined {
		if (cell.position.row !== 0) {
			return undefined;
		}
		const rect = cell.element.getBoundingClientRect();
		const x = event.clientX;
		if (x < rect.left || x > rect.right) {
			return undefined;
		}
		if (cell.position.column >= 1 && x >= rect.right - RESIZE_HANDLE_WIDTH) {
			return cell.position.column;
		}
		if (cell.position.column >= 2 && x <= rect.left + 2) {
			return cell.position.column - 1;
		}
		return undefined;
	}

	private _onHoverMove(event: MouseEvent): void {
		if (this._dragStore.value) {
			return;
		}
		const cell = this._cellFromTarget(event.target);
		this._host.classList.toggle('paradis-csv-resize-cursor', !!cell && this._resizeTarget(event, cell) !== undefined);
	}

	private _onMouseDown(event: MouseEvent): void {
		if (event.button !== 0 || !this._document) {
			return;
		}
		const cell = this._cellFromTarget(event.target);
		if (!cell) {
			return;
		}
		// セル（tabIndex=-1）へフォーカスが移らないようにし、キー操作はグリッド自身で受ける。
		event.preventDefault();
		this._host.focus();
		const resizeColumn = this._resizeTarget(event, cell);
		if (resizeColumn !== undefined) {
			this._startResize(event, resizeColumn);
			return;
		}
		const { row, column } = cell.position;
		if (row === 0 && column === 0) {
			this._selectAll();
			return;
		}
		if (row === 0) {
			// 見出しを押すと並べ替える（昇順 → 降順 → 元の順）。
			this._setSelection({ anchor: { row: 0, column }, active: { row: 0, column }, wholeRows: false }, false);
			this._toggleSort(column - 1);
			return;
		}
		if (column === 0) {
			const anchor = event.shiftKey && this._selection.wholeRows ? this._selection.anchor : { row, column: 1 };
			this._setSelection({ anchor, active: { row, column: this._lastColumn }, wholeRows: true }, false);
			this._startSelectionDrag(true);
			return;
		}
		const anchor = event.shiftKey ? this._selection.anchor : cell.position;
		this._setSelection({ anchor, active: cell.position, wholeRows: false }, false);
		this._startSelectionDrag(false);
	}

	private _startSelectionDrag(wholeRows: boolean): void {
		const store = new DisposableStore();
		this._dragStore.value = store;
		const targetWindow = dom.getWindow(this._host);
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_MOVE, event => {
			const cell = this._cellFromTarget(event.target);
			if (!cell) {
				return;
			}
			const { row, column } = cell.position;
			const active = wholeRows ? { row: Math.max(1, row), column: this._lastColumn } : { row, column: Math.max(1, column) };
			if (active.row !== this._selection.active.row || active.column !== this._selection.active.column) {
				this._setSelection({ anchor: this._selection.anchor, active, wholeRows }, false);
			}
		}));
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_UP, () => this._dragStore.clear()));
	}

	private _startResize(event: MouseEvent, gridColumn: number): void {
		const viewport = this._viewport;
		if (!viewport) {
			return;
		}
		const store = new DisposableStore();
		this._dragStore.value = store;
		const targetWindow = dom.getWindow(this._host);
		const startX = event.clientX;
		const startWidth = viewport.cellBounds(0, gridColumn).width;
		let pendingWidth = startWidth;
		this._host.classList.add('paradis-csv-resize-cursor');
		store.add(toDisposable(() => this._host.classList.remove('paradis-csv-resize-cursor')));
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_MOVE, moveEvent => {
			pendingWidth = Math.max(MINIMUM_COLUMN_WIDTH, Math.min(MAXIMUM_COLUMN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX)));
			if (!this._pendingResize.value) {
				this._pendingResize.value = dom.scheduleAtNextAnimationFrame(targetWindow, () => {
					this._pendingResize.clear();
					this._resizeColumn(gridColumn, pendingWidth);
				});
			}
		}));
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_UP, () => {
			this._pendingResize.clear();
			this._resizeColumn(gridColumn, pendingWidth);
			this._dragStore.clear();
		}));
	}

	private _resizeColumn(gridColumn: number, width: number): void {
		const renderer = this._renderer.value;
		if (!renderer || gridColumn < 1) {
			return;
		}
		this._userColumnWidths.set(gridColumn - 1, width);
		this._columnWidths[gridColumn - 1] = width;
		renderer.remeasure({ columns: [{ index: gridColumn, size: width }] }).catch(onUnexpectedError);
	}

	// --- 並べ替え ---------------------------------------------------------------------------

	private _toggleSort(column: number): void {
		const current = this._sort;
		const next: ParadisCsvSortState | undefined = !current || current.column !== column
			? { column, direction: 'asc', pending: true }
			: current.direction === 'asc' ? { column, direction: 'desc', pending: true } : undefined;
		this._applySort(next);
	}

	private _applySort(next: ParadisCsvSortState | undefined): void {
		this._sortRequest.value?.cancel();
		const document = this._document;
		const generation = this._generation;
		this._sort = next;
		if (!next || !document) {
			this._sortRequest.clear();
			this._order = undefined;
			this._afterOrderChanged();
			return;
		}
		const request = new CancellationTokenSource();
		this._sortRequest.value = request;
		this._options.onDidChangeState();
		sortParadisCsvRows(document, next.column, next.direction, () => timeout(0), request.token).then(order => {
			if (request.token.isCancellationRequested || generation !== this._generation) {
				return;
			}
			this._order = order;
			this._sort = { ...next, pending: false };
			this._afterOrderChanged();
		}, error => {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
		});
	}

	private _afterOrderChanged(): void {
		// 検索結果は表示順の行で持っているので、並びが変わったら探し直してもらう。
		this._search = undefined;
		this._matchKeys = new Set();
		this._currentMatchKey = undefined;
		this._findWidget.setSearchProvider(this._searchProvider);
		this._findWidget.refresh();
		this._rerender();
		this._options.onDidChangeState();
	}

	// --- 検索 -------------------------------------------------------------------------------

	private readonly _searchProvider: ParadisOfficeFindSearchProvider = async (query, cursor, token) => {
		const document = this._document;
		if (!document) {
			return { results: [], total: 0, capped: false };
		}
		const key = `${query.matchCase ? 1 : 0}:${query.text}`;
		let search = this._search;
		if (!cursor || !search || search.key !== key || search.document !== document || search.order !== this._order) {
			const order = this._order;
			const result = await searchParadisCsv(document, order, query.text, query.matchCase, () => timeout(0), token);
			if (token.isCancellationRequested || document !== this._document) {
				return { results: [], total: 0, capped: false };
			}
			search = { key, document, order, result };
			this._search = search;
			this._matchKeys = new Set(result.matches.map(match => this._cellKey(match.row, match.column + 1)));
			this._currentMatchKey = undefined;
			this._findWasVisible = this._findWidget.isVisible();
			this._rerender();
		}
		return this._searchPage(search.result, cursor);
	};

	private _searchPage(result: ParadisCsvSearchResult, cursor: string | undefined): ParadisOfficeSearchPage {
		const offset = cursor ? Number(cursor) : 0;
		const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
		const end = Math.min(result.matches.length, start + PARADIS_OFFICE_SEARCH_PAGE_SIZE);
		return {
			results: result.matches.slice(start, end).map(match => this._toSearchResult(match)),
			nextCursor: end < result.matches.length ? String(end) : undefined,
			total: result.matches.length,
			capped: result.capped,
		};
	}

	private _toSearchResult(match: ParadisCsvMatch): ParadisOfficeSearchResult {
		// 巨大なセル（閉じない引用符など）でも前後だけを切り出してから整形する。
		const length = match.length;
		const clean = (text: string) => text.replace(/[\r\n\t]/g, ' ');
		const value = match.value;
		const locator = `${match.row}:${match.column}`;
		return {
			id: locator,
			locator,
			preview: {
				before: clean(value.slice(Math.max(0, match.offset - MAXIMUM_PREVIEW_CONTEXT), match.offset)),
				match: clean(value.slice(match.offset, match.offset + Math.min(length, 200))),
				after: clean(value.slice(match.offset + length, match.offset + length + MAXIMUM_PREVIEW_CONTEXT)),
			},
			locationBadge: {
				kind: 'sheet',
				label: match.row === 0
					? localize('paradis.csv.matchInHeader', "見出し・{0}", this.columnName(match.column))
					: localize('paradis.csv.matchInRow', "{0} 行目・{1}", match.row, this.columnName(match.column)),
			},
		};
	}

	private _navigateToMatch(result: ParadisOfficeSearchResult): void {
		const [row, column] = result.locator.split(':').map(Number);
		if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column)) {
			return;
		}
		const position = { row, column: column + 1 };
		this._currentMatchKey = this._cellKey(position.row, position.column);
		this._findWasVisible = this._findWidget.isVisible();
		this._setSelection({ anchor: position, active: position, wholeRows: false }, true);
	}
}


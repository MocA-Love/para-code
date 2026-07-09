/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel差分ビューアの EditorPane(Superset の SpreadsheetDiffViewer.tsx 移植)。旧版(original)と新版(modified)を
// 個別パースしてセル単位で比較し、左右2テーブルで表示する。変更セルは色分け(緑=追加/赤=削除/青=変更)し、
// 変更セルには文字レベル差分をインライン表示。左右スクロール同期、上部に「N changes」+ Prev/Next ナビ。

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_SPREADSHEET_DIFF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { IParadisOverflowItem, PARADIS_ROW_NUM_COL_WIDTH, appendDiagonalOverlay, applyBaseCellStyle, applyOverflow, buildShapeDiffOverlay, computeOverflowRoom, computeShapeBBox, createOverflowSpan, overflowToward, setCellContent } from './paradisSpreadsheetRender.js';
import { IParadisRenderShape } from '../common/paradisSpreadsheet.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetDiffInput } from './paradisSpreadsheetInput.js';
import { IParadisDiffCell, IParadisDiffDetail, IParadisDiffRow, IParadisDiffSheet, IParadisShapeDiff, IParadisShapeRender, buildDiffSheets, buildShapeDiff, getDiffRowIndices } from './paradisSpreadsheetDiff.js';
import { formatDiffDetails } from './paradisSpreadsheetDiffPresentation.js';
import { appendIconButton, appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

interface IDiffLocation {
	readonly sheetIndex: number;
	/** スクロール対象の差分行インデックス。 */
	readonly rowIndex: number;
	/** 図形の変更なら、ハイライト対象の図形と表示側。 */
	readonly shape?: { readonly render: IParadisRenderShape; readonly side: 'original' | 'modified' };
}

/** ペインの自然座標(zoom 適用前)での行位置測定結果。図形/ハイライトの配置に使う。 */
interface IPaneMetrics {
	/** Excel 行番号(1始まり)→ 行上端Y(自然px)。図形の位置合わせ用。 */
	readonly rowY: Map<number, number>;
	/** 表示行インデックス → 行上端Y(自然px)。 */
	readonly rowTops: number[];
	/** 表示行インデックス → 行高(自然px)。 */
	readonly rowHeights: number[];
}

function emptyMetrics(): IPaneMetrics {
	return { rowY: new Map(), rowTops: [], rowHeights: [] };
}

export class ParadisSpreadsheetDiffEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_DIFF_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _navPositionEl: HTMLElement | undefined;
	private _percentBtn: HTMLButtonElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _tabsEl: HTMLElement | undefined;
	private _leftScroll: HTMLElement | undefined;
	private _rightScroll: HTMLElement | undefined;
	private _leftContent: HTMLElement | undefined;
	private _rightContent: HTMLElement | undefined;
	private _leftSizer: HTMLElement | undefined;
	private _rightSizer: HTMLElement | undefined;
	private _leftContentHeight = 0;
	private _rightContentHeight = 0;
	private _leftRows: HTMLElement[] = [];
	private _rightRows: HTMLElement[] = [];
	private _leftRowMeta: { excelRow: number; tr: HTMLElement }[] = [];
	private _rightRowMeta: { excelRow: number; tr: HTMLElement }[] = [];
	private _leftTable: HTMLElement | undefined;
	private _rightTable: HTMLElement | undefined;
	private _leftShapeOverlay: SVGElement | undefined;
	private _rightShapeOverlay: SVGElement | undefined;
	private _leftHighlight: HTMLElement | undefined;
	private _rightHighlight: HTMLElement | undefined;
	private _leftMetrics: IPaneMetrics = emptyMetrics();
	private _rightMetrics: IPaneMetrics = emptyMetrics();
	// フォント反映等の再フローで行高が変わると図形の固定Y座標が古くなるため、再測定・再配置のトリガを張る。
	private _replaceToken: object = {};
	// 通常ビューアと同じく自然幅で表・図形を描画し、ペインごとに CSS zoom で一括拡縮する
	// (列幅を事前縮小すると図形の EMU オフセットとズレるため。zoom はレイアウトごと拡縮しスクロールも整合)。
	private _columnWidths: readonly number[] = [];
	private _naturalTableWidth = 0;
	private _scale = 1;
	private _userAdjusted = false;
	private _openAppEl: HTMLElement | undefined;
	private _syncing = false;
	private readonly _headerDisposables = this._register(new DisposableStore());

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _diffDetailsByCell = new WeakMap<HTMLElement, readonly IParadisDiffDetail[]>();
	// タブ描画は _renderTabs のたびに DOM とリスナーを作り直すため、描画単位の専用 store で管理する。
	private readonly _tabsDisposables = this._register(new MutableDisposable<DisposableStore>());
	// _navigate の rAF ハンドルは連打で蓄積しないよう都度差し替える。
	private readonly _navigateRaf = this._register(new MutableDisposable());
	// スクロール同期の抑止フラグは echo イベントに頼らず次フレームで解除する(代入が no-op でも立ちっぱなしにしない)。
	private readonly _syncScrollReset = this._register(new MutableDisposable());
	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _diffSheets: IParadisDiffSheet[] = [];
	private _shapeDiffs: IParadisShapeDiff[] = [];
	private _diffLocations: IDiffLocation[] = [];
	private _activeSheetIndex = 0;
	private _currentDiffIdx = 0;
	// watcher 由来の _load が並行実行され応答が逆順到着しても、最新ロードの結果だけを表示するための世代トークン。
	private _loadGeneration = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super(PARADIS_SPREADSHEET_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet-diff'));

		const toolbar = dom.append(this._root, $('.paradis-spreadsheet-diff-toolbar'));
		this._countEl = dom.append(toolbar, $('span.paradis-spreadsheet-diff-count'));
		const right = dom.append(toolbar, $('.paradis-spreadsheet-diff-toolbar-right'));

		// ズーム −/%/＋（通常ビューアと同じ。左右ペインに同倍率を適用する）。
		const zoom = dom.append(right, $('.paradis-spreadsheet-diff-zoom'));
		appendIconButton(zoom, Codicon.zoomOut, localize('paradis.spreadsheet.zoomOut', "Zoom Out"), this._headerDisposables, () => this._zoom(1 / 1.2));
		this._percentBtn = dom.append(zoom, $('button.paradis-spreadsheet-percent')) as HTMLButtonElement;
		this._percentBtn.title = localize('paradis.spreadsheet.resetZoom', "Reset Zoom");
		this._register(dom.addDisposableListener(this._percentBtn, dom.EventType.CLICK, () => this._resetZoom()));
		appendIconButton(zoom, Codicon.zoomIn, localize('paradis.spreadsheet.zoomIn', "Zoom In"), this._headerDisposables, () => this._zoom(1.2));

		const nav = dom.append(right, $('.paradis-spreadsheet-diff-nav'));
		const prevBtn = dom.append(nav, $('button.paradis-spreadsheet-diff-navbtn')) as HTMLButtonElement;
		prevBtn.textContent = localize('paradis.spreadsheet.prev', "Prev");
		this._navPositionEl = dom.append(nav, $('span.paradis-spreadsheet-diff-navpos'));
		const nextBtn = dom.append(nav, $('button.paradis-spreadsheet-diff-navbtn')) as HTMLButtonElement;
		nextBtn.textContent = localize('paradis.spreadsheet.next', "Next");
		this._register(dom.addDisposableListener(prevBtn, dom.EventType.CLICK, () => this._navigate(-1)));
		this._register(dom.addDisposableListener(nextBtn, dom.EventType.CLICK, () => this._navigate(1)));
		this._openAppEl = dom.append(nav, $('.paradis-spreadsheet-openapp'));

		this._bodyEl = dom.append(this._root, $('.paradis-spreadsheet-diff-body'));
		this._tabsEl = dom.append(this._root, $('.paradis-spreadsheet-tabs'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const diffInput = input as ParadisSpreadsheetDiffInput;
		this._originalResource = diffInput.originalResource;
		this._modifiedResource = diffInput.modifiedResource;
		this._activeSheetIndex = 0;
		this._currentDiffIdx = 0;
		this._userAdjusted = false;
		this._scale = 1;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			appendOpenInAppButton(this._openAppEl, this._modifiedResource, this._nativeHostService, store);
		}

		// 新版がワーキングコピー(file:)の場合はディスク更新で自動再描画する。
		if (this._modifiedResource.scheme === Schemas.file || this._modifiedResource.scheme === Schemas.vscodeRemote) {
			try {
				const watcher = this._fileService.createWatcher(this._modifiedResource, { recursive: false, excludes: [] });
				store.add(watcher);
				store.add(watcher.onDidChange(e => {
					if (this._modifiedResource && e.contains(this._modifiedResource)) {
						void this._load(CancellationToken.None);
					}
				}));
			} catch {
				// watcher 生成失敗は致命的ではない。
			}
		}

		await this._load(token);
	}

	private async _load(token: CancellationToken): Promise<void> {
		const original = this._originalResource;
		const modified = this._modifiedResource;
		if (!original || !modified) {
			return;
		}
		const generation = ++this._loadGeneration;
		this._renderMessage(localize('paradis.spreadsheet.loadingDiff', "Loading diff..."));
		try {
			const [origWb, modWb] = await Promise.all([
				parseSpreadsheetResource(this._fileService, this._sharedProcessService, original).catch(() => ({ sheets: [] })),
				parseSpreadsheetResource(this._fileService, this._sharedProcessService, modified).catch(() => ({ sheets: [] })),
			]);
			// 応答の逆順到着で古い結果が新しい結果を上書きしないよう、最新ロードでなければ破棄する。
			if (generation !== this._loadGeneration || token.isCancellationRequested || !isEqual(this._modifiedResource, modified)) {
				return;
			}
			this._diffSheets = buildDiffSheets(origWb.sheets, modWb.sheets);
			this._shapeDiffs = this._diffSheets.map(s => buildShapeDiff(s.originalShapes, s.modifiedShapes));
			this._diffLocations = this._diffSheets.flatMap((sheet, sheetIndex) => this._buildSheetLocations(sheet, sheetIndex));
			if (this._activeSheetIndex >= this._diffSheets.length) {
				this._activeSheetIndex = 0;
			}
			this._renderSheet();
			this._renderTabs();
			this._updateNav();
		} catch (err) {
			if (!token.isCancellationRequested) {
				this._renderMessage(localize('paradis.spreadsheet.errorDiff', "Failed to open spreadsheet diff: {0}", err instanceof Error ? err.message : String(err)));
			}
		}
	}

	/** 1シート分の変更位置(セル行 + 図形)を行位置順にまとめて返す。 */
	private _buildSheetLocations(sheet: IParadisDiffSheet, sheetIndex: number): IDiffLocation[] {
		const locs: IDiffLocation[] = [];
		for (const rowIndex of getDiffRowIndices(sheet)) {
			locs.push({ sheetIndex, rowIndex });
		}
		const maxRows = Math.max(sheet.originalRows.length, sheet.modifiedRows.length);
		const rowIndexByExcel = new Map<number, number>();
		for (let i = 0; i < maxRows; i++) {
			const er = sheet.modifiedRows[i]?.excelRow ?? sheet.originalRows[i]?.excelRow;
			if (er !== undefined && !rowIndexByExcel.has(er)) {
				rowIndexByExcel.set(er, i);
			}
		}
		for (const change of this._shapeDiffs[sheetIndex].changes) {
			const rowIndex = rowIndexByExcel.get(change.anchorRow) ?? Math.max(0, Math.min(change.anchorRow - 1, maxRows - 1));
			locs.push({ sheetIndex, rowIndex, shape: { render: change.shape, side: change.side } });
		}
		locs.sort((a, b) => a.rowIndex - b.rowIndex);
		return locs;
	}

	private _renderMessage(message: string): void {
		if (!this._bodyEl) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(this._bodyEl);
		const msg = dom.append(this._bodyEl, $('.paradis-spreadsheet-message'));
		msg.textContent = message;
	}

	private _renderSheet(): void {
		if (!this._bodyEl) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(this._bodyEl);

		const sheet = this._diffSheets[this._activeSheetIndex];
		if (!sheet) {
			this._renderMessage(localize('paradis.spreadsheet.noChanges', "No changes found"));
			return;
		}

		// 自然幅で描画し、フィット/ズームは CSS zoom で一括拡縮する。
		this._columnWidths = sheet.columnWidths;
		this._naturalTableWidth = PARADIS_ROW_NUM_COL_WIDTH + sheet.columnWidths.reduce((s, w) => s + w, 0);

		const left = this._buildDiffPane(sheet.originalRows, localize('paradis.spreadsheet.original', "Original"));
		this._leftScroll = left.pane;
		this._leftContent = left.content;
		this._leftSizer = left.sizer;
		this._leftRows = left.rows;
		this._leftRowMeta = left.rowMeta;
		this._leftTable = left.table;
		this._leftHighlight = left.highlight;
		dom.append(this._bodyEl, left.pane);
		dom.append(this._bodyEl, $('.paradis-spreadsheet-diff-separator'));
		const right = this._buildDiffPane(sheet.modifiedRows, localize('paradis.spreadsheet.modified', "Modified (Working Copy)"));
		this._rightScroll = right.pane;
		this._rightContent = right.content;
		this._rightSizer = right.sizer;
		this._rightRows = right.rows;
		this._rightRowMeta = right.rowMeta;
		this._rightTable = right.table;
		this._rightHighlight = right.highlight;
		dom.append(this._bodyEl, right.pane);

		this._wireSyncScroll(this._leftScroll, this._rightScroll);
		this._wireSyncScroll(this._rightScroll, this._leftScroll);

		// レイアウト確定後に、はみ出し反映 → 測定 → 図形/ハイライト配置 → zoom を行う。
		// さらにフォント反映等の再フローで行高が変わっても位置が古くならないよう再配置トリガも張る。
		this._renderDisposables.add(dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl), () => {
			applyOverflow(left.overflowCells);
			applyOverflow(right.overflowCells);
			this._placeOverlays();
			this._setupReplaceTriggers();
		}));
	}

	/**
	 * 行位置を自然座標(zoom 適用前)で測り直し、図形オーバーレイとアクティブなハイライトを配置し直す。
	 * zoom を一時的に外して測定するため、同一 JS ターン内で復帰させ画面のちらつきを避ける。
	 * フォント反映等の再フロー後にも呼ばれる(idempotent)。
	 */
	private _placeOverlays(): void {
		const sheet = this._diffSheets[this._activeSheetIndex];
		if (!sheet || !this._leftContent || !this._rightContent) {
			return;
		}
		const shapeDiff = this._shapeDiffs[this._activeSheetIndex];
		// transform:scale は offsetTop/offsetHeight に影響しないため、測定は自然座標のまま行える。
		this._leftMetrics = this._measurePane(this._leftRows, this._leftRowMeta);
		this._rightMetrics = this._measurePane(this._rightRows, this._rightRowMeta);
		this._leftContentHeight = this._leftTable?.offsetHeight ?? 0;
		this._rightContentHeight = this._rightTable?.offsetHeight ?? 0;
		this._appendShapeOverlay('original', shapeDiff?.originalRenders, sheet.originalMinCol, this._leftMetrics.rowY);
		this._appendShapeOverlay('modified', shapeDiff?.modifiedRenders, sheet.modifiedMinCol, this._rightMetrics.rowY);
		this._applyScale();
		this._repositionHighlight();
	}

	/** フォント読み込み完了 + テーブルのサイズ変化(再フロー)で図形を配置し直すトリガを張る。 */
	private _setupReplaceTriggers(): void {
		if (!this._bodyEl) {
			return;
		}
		const targetWindow = dom.getWindow(this._bodyEl);
		const scheduler = new RunOnceScheduler(() => this._placeOverlays(), 80);
		this._renderDisposables.add(scheduler);
		const observer = new targetWindow.ResizeObserver(() => scheduler.schedule());
		if (this._leftTable) {
			observer.observe(this._leftTable);
		}
		if (this._rightTable) {
			observer.observe(this._rightTable);
		}
		this._renderDisposables.add(toDisposable(() => observer.disconnect()));
		const token = {};
		this._replaceToken = token;
		targetWindow.document.fonts.ready.then(() => {
			if (this._replaceToken === token) {
				scheduler.schedule();
			}
		}, () => { /* フォント待ち失敗は無視 */ });
	}

	/** ペインを組み立てる(測定・図形・スケールはまとめて呼び出し側の rAF で行う)。 */
	private _buildDiffPane(rows: readonly IParadisDiffRow[], label: string): { pane: HTMLElement; sizer: HTMLElement; content: HTMLElement; table: HTMLElement; rows: HTMLElement[]; highlight: HTMLElement; rowMeta: { excelRow: number; tr: HTMLElement }[]; overflowCells: IParadisOverflowItem[] } {
		const pane = $('.paradis-spreadsheet-diff-pane');
		const labelEl = dom.append(pane, $('.paradis-spreadsheet-diff-label'));
		labelEl.textContent = label;
		// sizer は縮尺後のフットプリントを確保してスクロール量を正す枠。content は transform:scale で拡縮する。
		// (CSS zoom はレイアウトごと丸めるため border-collapse の罫線が欠けるので使わない。transform はラスタ拡縮で罫線が連続する)
		const sizer = dom.append(pane, $('.paradis-spreadsheet-diff-sizer'));
		// テーブルとオーバーレイ/ハイライトを内包する位置基準(自然座標。transform:scale で一括拡縮)。
		const contentEl = dom.append(sizer, $('.paradis-spreadsheet-diff-content'));

		const columnWidths = this._columnWidths;
		const table = dom.append(contentEl, $('table.paradis-spreadsheet-table.grid')) as HTMLTableElement;
		table.style.width = `${this._naturalTableWidth}px`;

		const colgroup = dom.append(table, $('colgroup'));
		const rowNumCol = dom.append(colgroup, $('col')) as HTMLTableColElement;
		rowNumCol.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
		for (const w of columnWidths) {
			const col = dom.append(colgroup, $('col')) as HTMLTableColElement;
			if (w) {
				col.style.width = `${w}px`;
			}
		}

		const tbody = dom.append(table, $('tbody'));
		const rowEls: HTMLElement[] = [];
		const rowMeta: { excelRow: number; tr: HTMLElement }[] = [];
		const overflowCells: IParadisOverflowItem[] = [];
		rows.forEach((row, rowIdx) => {
			const tr = dom.append(tbody, $('tr')) as HTMLTableRowElement;
			rowEls.push(tr);
			if (row.excelRow !== undefined) {
				rowMeta.push({ excelRow: row.excelRow, tr });
			}
			tr.style.height = `${row.height}px`;
			const rowHead = dom.append(tr, $('td.paradis-spreadsheet-rowhead'));
			rowHead.textContent = String(rowIdx + 1);
			for (let ci = 0; ci < row.cells.length; ci++) {
				const cell = row.cells[ci];
				if (cell.hidden) {
					continue;
				}
				this._buildDiffCell(tr, cell, row.cells, ci, columnWidths, overflowCells);
			}
		});
		this._renderDisposables.add(dom.addDisposableListener(table, dom.EventType.MOUSE_OVER, event => {
			if (!dom.isHTMLElement(event.target)) {
				return;
			}
			const cell = dom.findParentWithClass(event.target, 'paradis-spreadsheet-diff-details', table);
			if (!cell || (dom.isHTMLElement(event.relatedTarget) && cell.contains(event.relatedTarget))) {
				return;
			}
			const details = this._diffDetailsByCell.get(cell);
			if (details) {
				this._hoverService.showDelayedHover({ target: cell, content: formatDiffDetails(details) }, { groupId: 'paradis-spreadsheet-diff-details' });
			}
		}));

		// 現在位置ハイライト用の要素(ナビ時に配置)。
		const highlight = dom.append(contentEl, $('.paradis-spreadsheet-diff-highlight'));

		return { pane, sizer, content: contentEl, table, rows: rowEls, highlight, rowMeta, overflowCells };
	}

	/** zoom 適用前の自然座標で行位置を測定する。 */
	private _measurePane(rowEls: readonly HTMLElement[], rowMeta: readonly { excelRow: number; tr: HTMLElement }[]): IPaneMetrics {
		const rowY = new Map<number, number>();
		for (const { excelRow, tr } of rowMeta) {
			rowY.set(excelRow, tr.offsetTop);
		}
		const last = rowMeta[rowMeta.length - 1];
		if (last) {
			rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
		}
		return { rowY, rowTops: rowEls.map(tr => tr.offsetTop), rowHeights: rowEls.map(tr => tr.offsetHeight) };
	}

	/** 図形を差分ステータス色で描画して content に重ねる(自然座標。zoom で一緒に拡縮される)。既存のオーバーレイは貼り替える。 */
	private _appendShapeOverlay(side: 'original' | 'modified', renders: readonly IParadisShapeRender[] | undefined, minCol: number | undefined, rowY: Map<number, number>): void {
		const content = side === 'original' ? this._leftContent : this._rightContent;
		const prev = side === 'original' ? this._leftShapeOverlay : this._rightShapeOverlay;
		if (prev) {
			prev.remove();
		}
		let overlay: SVGElement | undefined;
		if (content && renders && renders.length > 0 && minCol !== undefined) {
			overlay = buildShapeDiffOverlay(renders, side, rowY, this._columnWidths, minCol, content.ownerDocument);
			if (overlay) {
				content.appendChild(overlay);
			}
		}
		if (side === 'original') {
			this._leftShapeOverlay = overlay;
		} else {
			this._rightShapeOverlay = overlay;
		}
	}

	private _buildDiffCell(tr: HTMLElement, cell: IParadisDiffCell, cells: readonly IParadisDiffCell[], index: number, columnWidths: readonly number[], overflowSink: IParadisOverflowItem[]): void {
		const td = dom.append(tr, $('td')) as HTMLTableCellElement;
		if (cell.colSpan && cell.colSpan > 1) {
			td.colSpan = cell.colSpan;
		}
		if (cell.rowSpan && cell.rowSpan > 1) {
			td.rowSpan = cell.rowSpan;
		}
		applyBaseCellStyle(td, cell);
		if (cell.diffStatus) {
			td.classList.add(`diff-${cell.diffStatus}`);
		}
		if (cell.diffDetails?.length) {
			td.classList.add('paradis-spreadsheet-diff-details');
			this._diffDetailsByCell.set(td, cell.diffDetails);
		}
		if (cell.diffSegments && cell.diffSegments.length > 0) {
			for (const seg of cell.diffSegments) {
				const span = dom.append(td, $('span')) as HTMLElement;
				span.textContent = seg.text;
				if (seg.type === 'added') {
					span.classList.add('diff-seg-added');
				} else if (seg.type === 'removed') {
					span.classList.add('diff-seg-removed');
				}
			}
		} else {
			// 文字レベル差分の無いセルのみ、セルまたぎのはみ出し対象にする。
			const toward = overflowToward(cell);
			const room = toward !== 'none' ? computeOverflowRoom(cells, index, columnWidths) : undefined;
			if (toward !== 'none' && room && (room.left > 0 || room.right > 0)) {
				overflowSink.push({ td, span: createOverflowSpan(td, cell), toward, leftRoom: room.left, rightRoom: room.right, valign: (cell.style.verticalAlign as string) || 'bottom' });
			} else {
				setCellContent(td, cell);
			}
		}
		if (cell.diagonal) {
			appendDiagonalOverlay(td, cell.diagonal);
		}
	}

	private _zoom(factor: number): void {
		this._userAdjusted = true;
		this._scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._scale * factor));
		this._applyScale();
	}

	private _resetZoom(): void {
		this._userAdjusted = false;
		this._applyScale();
	}

	/** 各ペインの表がその半幅に収まる倍率(縮小のみ。1 を超えて拡大はしない)。 */
	private _computeFitScale(): number {
		const paneWidth = this._bodyEl ? Math.max(0, Math.floor(this._bodyEl.clientWidth / 2) - 1) : 0;
		return paneWidth > 0 && this._naturalTableWidth > paneWidth ? paneWidth / this._naturalTableWidth : 1;
	}

	/**
	 * 左右ペインの内容を同倍率で拡縮する。content を transform:scale で拡縮し(罫線がラスタ拡縮で連続する)、
	 * sizer を縮尺後サイズにしてスクロール量を整合させる。
	 */
	private _applyScale(): void {
		const target = this._userAdjusted ? this._scale : this._computeFitScale();
		if (!this._userAdjusted) {
			this._scale = target;
		}
		const apply = (content: HTMLElement | undefined, sizer: HTMLElement | undefined, contentHeight: number) => {
			if (content) {
				content.style.transform = target === 1 ? '' : `scale(${target})`;
				content.style.transformOrigin = 'top left';
			}
			if (sizer) {
				sizer.style.width = `${Math.round(this._naturalTableWidth * target)}px`;
				sizer.style.height = `${Math.round(contentHeight * target)}px`;
			}
		};
		apply(this._leftContent, this._leftSizer, this._leftContentHeight);
		apply(this._rightContent, this._rightSizer, this._rightContentHeight);
		if (this._percentBtn) {
			this._percentBtn.textContent = `${Math.round(target * 100)}%`;
		}
	}

	private _wireSyncScroll(from: HTMLElement, to: HTMLElement): void {
		this._renderDisposables.add(dom.addDisposableListener(from, dom.EventType.SCROLL, () => {
			if (this._syncing) {
				return;
			}
			this._syncing = true;
			// 代入が実値を変えない(既に同値/クランプ済み)場合は echo イベントが発火しないため、
			// フラグ解除を echo に頼らず次フレームで必ず行う(片側 truncated 等で同期が外れないように)。
			if (to.scrollTop !== from.scrollTop) {
				to.scrollTop = from.scrollTop;
			}
			if (to.scrollLeft !== from.scrollLeft) {
				to.scrollLeft = from.scrollLeft;
			}
			this._syncScrollReset.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(from), () => {
				this._syncing = false;
			});
		}));
	}

	private _renderTabs(): void {
		if (!this._tabsEl) {
			return;
		}
		dom.clearNode(this._tabsEl);
		// 旧タブのクリックリスナー(と切り離し済み DOM への参照)を解放してから描画し直す。
		const tabsStore = new DisposableStore();
		this._tabsDisposables.value = tabsStore;
		if (this._diffSheets.length <= 1) {
			this._tabsEl.style.display = 'none';
			return;
		}
		this._tabsEl.style.display = '';
		this._diffSheets.forEach((sheet, idx) => {
			const tab = dom.append(this._tabsEl!, $('button.paradis-spreadsheet-tab')) as HTMLButtonElement;
			tab.classList.toggle('active', idx === this._activeSheetIndex);
			// 通常ビューアと同じくタブ色帯・保護の鍵を出す。
			if (sheet.tabColor) {
				tab.style.borderBottomColor = sheet.tabColor;
				tab.style.borderBottomWidth = '3px';
				tab.style.borderBottomStyle = 'solid';
				if (idx === this._activeSheetIndex) {
					tab.style.color = sheet.tabColor;
				}
			}
			if (sheet.protectedSheet) {
				const lock = dom.append(tab, $(`span.paradis-spreadsheet-tab-lock${ThemeIcon.asCSSSelector(Codicon.lock)}`));
				lock.title = localize('paradis.spreadsheet.protected', "This sheet is protected");
			}
			let label = sheet.name;
			if (sheet.sheetStatus === 'added') {
				label += ' (+)';
			} else if (sheet.sheetStatus === 'removed') {
				label += ' (-)';
			}
			const labelEl = dom.append(tab, $('span'));
			labelEl.textContent = label;
			tabsStore.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				if (this._activeSheetIndex === idx) {
					return;
				}
				this._activeSheetIndex = idx;
				this._renderSheet();
				this._renderTabs();
			}));
		});
	}

	private _updateNav(): void {
		if (this._countEl) {
			this._countEl.textContent = this._diffLocations.length > 0
				? localize('paradis.spreadsheet.nChanges', "{0} changes", this._diffLocations.length)
				: localize('paradis.spreadsheet.noChangesShort', "No changes");
		}
		if (this._navPositionEl) {
			this._navPositionEl.textContent = this._diffLocations.length > 0
				? `${this._currentDiffIdx + 1} / ${this._diffLocations.length}`
				: '';
		}
	}

	private _navigate(delta: number): void {
		if (this._diffLocations.length === 0) {
			return;
		}
		let idx = this._currentDiffIdx + delta;
		if (idx < 0) {
			idx = this._diffLocations.length - 1;
		} else if (idx >= this._diffLocations.length) {
			idx = 0;
		}
		this._currentDiffIdx = idx;
		const location = this._diffLocations[idx];
		if (location.sheetIndex !== this._activeSheetIndex) {
			this._activeSheetIndex = location.sheetIndex;
			this._renderSheet();
			this._renderTabs();
		}
		this._updateNav();
		this._scrollToRow(location.rowIndex);
		// レイアウト確定後(図形の rowY 測定 rAF の後)に現在位置をハイライトする。
		// 連打で消化済みハンドルが蓄積しないよう、直前の rAF を差し替える。
		this._navigateRaf.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => this._highlightLocation(location));
	}

	private _scrollToRow(rowIndex: number): void {
		const scrollTo = (container: HTMLElement | undefined, rowEls: HTMLElement[]) => {
			const target = rowEls[rowIndex];
			if (!container || !target) {
				return;
			}
			const containerRect = container.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			container.scrollTop = container.scrollTop + targetRect.top - containerRect.top - containerRect.height / 2 + targetRect.height / 2;
		};
		scrollTo(this._leftScroll, this._leftRows);
		scrollTo(this._rightScroll, this._rightRows);
	}

	/** Prev/Next でフォーカス中の変更(セル行 or 図形)を強調表示する。 */
	private _highlightLocation(location: IDiffLocation, pulse: boolean = true): void {
		this._clearHighlight(this._leftHighlight);
		this._clearHighlight(this._rightHighlight);
		const sheet = this._diffSheets[this._activeSheetIndex];
		if (location.shape && sheet) {
			const side = location.shape.side;
			const el = side === 'original' ? this._leftHighlight : this._rightHighlight;
			const rowY = (side === 'original' ? this._leftMetrics : this._rightMetrics).rowY;
			const minCol = side === 'original' ? sheet.originalMinCol : sheet.modifiedMinCol;
			if (el && minCol !== undefined) {
				const b = computeShapeBBox(location.shape.render, rowY, this._columnWidths, minCol);
				this._showHighlight(el, b.x - 3, b.y - 3, b.w + 6, b.h + 6, pulse);
			}
			return;
		}
		// セル: 両ペインの該当行を帯で強調(自然座標。zoom 適用前に測定した値を使う)。
		this._highlightRow(this._leftHighlight, this._leftMetrics, location.rowIndex, pulse);
		this._highlightRow(this._rightHighlight, this._rightMetrics, location.rowIndex, pulse);
	}

	/** 再フロー後などに、表示中のハイライトだけをパルスなしで測り直して置き直す。 */
	private _repositionHighlight(): void {
		const shown = (this._leftHighlight?.style.display === 'block') || (this._rightHighlight?.style.display === 'block');
		if (shown && this._diffLocations.length > 0) {
			this._highlightLocation(this._diffLocations[this._currentDiffIdx], false);
		}
	}

	private _highlightRow(el: HTMLElement | undefined, metrics: IPaneMetrics, rowIndex: number, pulse: boolean): void {
		const top = metrics.rowTops[rowIndex];
		const height = metrics.rowHeights[rowIndex];
		if (!el || top === undefined || height === undefined) {
			return;
		}
		this._showHighlight(el, 0, top, Math.max(this._naturalTableWidth, PARADIS_ROW_NUM_COL_WIDTH), height, pulse);
	}

	private _showHighlight(el: HTMLElement, x: number, y: number, w: number, h: number, pulse: boolean): void {
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.style.width = `${w}px`;
		el.style.height = `${h}px`;
		el.style.display = 'block';
		if (pulse) {
			// パルスアニメーションを再トリガー(class を付け直してリフローを挟む)。
			el.classList.remove('pulse');
			void el.offsetWidth;
			el.classList.add('pulse');
		}
	}

	private _clearHighlight(el: HTMLElement | undefined): void {
		if (el) {
			el.style.display = 'none';
			el.classList.remove('pulse');
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._renderDisposables.clear();
		this._tabsDisposables.clear();
		this._navigateRaf.clear();
		this._syncScrollReset.clear();
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._diffSheets = [];
		this._shapeDiffs = [];
		this._diffLocations = [];
		this._leftScroll = undefined;
		this._rightScroll = undefined;
		this._leftContent = undefined;
		this._rightContent = undefined;
		this._leftSizer = undefined;
		this._rightSizer = undefined;
		this._leftContentHeight = 0;
		this._rightContentHeight = 0;
		this._leftRows = [];
		this._rightRows = [];
		this._leftRowMeta = [];
		this._rightRowMeta = [];
		this._leftTable = undefined;
		this._rightTable = undefined;
		this._leftShapeOverlay = undefined;
		this._rightShapeOverlay = undefined;
		this._replaceToken = {};
		this._leftHighlight = undefined;
		this._rightHighlight = undefined;
		this._leftMetrics = emptyMetrics();
		this._rightMetrics = emptyMetrics();
		this._columnWidths = [];
		this._naturalTableWidth = 0;
		if (this._bodyEl) {
			dom.clearNode(this._bodyEl);
		}
		if (this._tabsEl) {
			dom.clearNode(this._tabsEl);
		}
		super.clearInput();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
		// フィット(未手動操作)時はペイン幅の変化に追従して倍率を再計算する。
		if (!this._userAdjusted) {
			this._applyScale();
		}
	}
}

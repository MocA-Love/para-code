/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel(スプレッドシート)ビューアの EditorPane。xlsx を shared process でパースし、HTMLテーブルとして描画する。
// グリッド線・手動改ページ線・印刷範囲・図形/画像・shrinkToFit・tabColor/保護タブ・ズーム・既定アプリで開く に対応。
// シート下部タブで切替、コンテナ幅超過時は CSS transform:scale で全体縮小、ディスク更新で自動再描画(correlated watcher)。

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisSheetData, IParadisWorkbookData } from '../common/paradisSpreadsheet.js';
import { PARADIS_SPREADSHEET_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { IParadisOverflowItem, PARADIS_ROW_NUM_COL_WIDTH, applyOverflow, applyShrinkToFit, buildPageBreakOverlay, buildSheetTableDom, buildShapeOverlay } from './paradisSpreadsheetRender.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetInput } from './paradisSpreadsheetInput.js';
import { appendIconButton, appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

export class ParadisSpreadsheetEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _openAppEl: HTMLElement | undefined;
	private _percentBtn: HTMLButtonElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _tabsEl: HTMLElement | undefined;
	private _outerEl: HTMLElement | undefined;
	private _innerEl: HTMLElement | undefined;
	private _tableEl: HTMLElement | undefined;
	private _theadEl: HTMLElement | undefined;
	private _headCellEls: HTMLElement[] = [];
	// 列ラベル(A,B,C...)/行番号の固定ヘッダー帯。inner に transform:scale が掛かると position:sticky は
	// 効かない(transform が包含ブロックを作る)ため、スクロールしない兄弟要素として重ね、scroll に追従させる。
	private _colStripEl: HTMLElement | undefined;
	private _colStripInner: HTMLElement | undefined;
	private _rowStripEl: HTMLElement | undefined;
	private _rowStripInner: HTMLElement | undefined;
	private _cornerEl: HTMLElement | undefined;
	private _headHeight = 0;
	private _naturalTableWidth = 0;
	private _naturalTableHeight = 0;
	private _dataRowEls: { excelRow: number; tr: HTMLElement }[] = [];
	private _shrinkCells: { td: HTMLElement; span: HTMLElement }[] = [];
	private _overflowCells: IParadisOverflowItem[] = [];
	private _activeSheet: IParadisSheetData | undefined;
	private _shapeOverlay: SVGElement | undefined;
	private _pageBreakOverlay: SVGElement | undefined;
	// フォント反映等の再フローで行高が変わると図形/改ページ線の固定Y座標が古くなるため、再測定・再配置トリガを張る。
	private _replaceToken: object = {};

	private _scale = 1;
	private _userAdjusted = false;

	private readonly _headerDisposables = this._register(new DisposableStore());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _overlayRaf = this._register(new MutableDisposable());
	private readonly _overlayTriggers = this._register(new MutableDisposable<DisposableStore>());
	private _currentResource: URI | undefined;
	private _sheets: readonly IParadisSheetData[] = [];
	private _activeSheetIndex = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super(PARADIS_SPREADSHEET_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet'));

		const header = dom.append(this._root, $('.paradis-spreadsheet-header'));
		dom.append(header, $('.paradis-spreadsheet-header-left'));
		const right = dom.append(header, $('.paradis-spreadsheet-header-right'));

		// ズーム −/%/＋（HTMLビューアと同じUI）。
		appendIconButton(right, Codicon.zoomOut, localize('paradis.spreadsheet.zoomOut', "Zoom Out"), this._headerDisposables, () => this._zoom(1 / 1.2));
		this._percentBtn = dom.append(right, $('button.paradis-spreadsheet-percent')) as HTMLButtonElement;
		this._percentBtn.title = localize('paradis.spreadsheet.resetZoom', "Reset Zoom");
		this._register(dom.addDisposableListener(this._percentBtn, dom.EventType.CLICK, () => this._resetZoom()));
		appendIconButton(right, Codicon.zoomIn, localize('paradis.spreadsheet.zoomIn', "Zoom In"), this._headerDisposables, () => this._zoom(1.2));

		// 「既定のアプリで開く」ボタンは resource 依存なので入力ごとに作り直す。
		this._openAppEl = dom.append(right, $('.paradis-spreadsheet-openapp'));

		// bodywrap はスクロールしない位置基準。固定ヘッダー帯(列ラベル/行番号/角)を body(スクローラ)の
		// 兄弟として重ね、body の scroll イベントで transform だけ更新する。
		const bodyWrap = dom.append(this._root, $('.paradis-spreadsheet-bodywrap'));
		this._bodyEl = dom.append(bodyWrap, $('.paradis-spreadsheet-body'));
		this._colStripEl = dom.append(bodyWrap, $('.paradis-spreadsheet-colstrip'));
		this._colStripInner = dom.append(this._colStripEl, $('.paradis-spreadsheet-strip-inner'));
		this._rowStripEl = dom.append(bodyWrap, $('.paradis-spreadsheet-rowstrip'));
		this._rowStripInner = dom.append(this._rowStripEl, $('.paradis-spreadsheet-strip-inner'));
		this._cornerEl = dom.append(bodyWrap, $('.paradis-spreadsheet-stickycorner.paradis-spreadsheet-corner'));
		this._register(dom.addDisposableListener(this._bodyEl, dom.EventType.SCROLL, () => this._updateStickyStripTransforms()));

		this._tabsEl = dom.append(this._root, $('.paradis-spreadsheet-tabs'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisSpreadsheetInput).resource;
		this._currentResource = resource;
		this._activeSheetIndex = 0;
		this._userAdjusted = false;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			appendOpenInAppButton(this._openAppEl, resource, this._nativeHostService, store);
		}

		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource)) {
					void this._load(resource, CancellationToken.None);
				}
			}));
		} catch {
			// watcher 生成失敗は致命的ではない。
		}

		await this._load(resource, token);
	}

	private async _load(resource: URI, token: CancellationToken): Promise<void> {
		this._renderMessage(localize('paradis.spreadsheet.loading', "Loading spreadsheet..."));
		let workbook: IParadisWorkbookData;
		try {
			workbook = await parseSpreadsheetResource(this._fileService, this._sharedProcessService, resource);
		} catch (err) {
			if (!token.isCancellationRequested && isEqual(this._currentResource, resource)) {
				this._renderMessage(localize('paradis.spreadsheet.error', "Failed to open spreadsheet: {0}", err instanceof Error ? err.message : String(err)));
			}
			return;
		}
		if (token.isCancellationRequested || !isEqual(this._currentResource, resource)) {
			return;
		}
		this._sheets = workbook.sheets;
		if (this._activeSheetIndex >= this._sheets.length) {
			this._activeSheetIndex = 0;
		}
		this._renderSheet();
		this._renderTabs();
	}

	private _renderMessage(message: string): void {
		if (!this._bodyEl) {
			return;
		}
		dom.clearNode(this._bodyEl);
		this._setStickyStripsVisible(false);
		if (this._tabsEl) {
			dom.clearNode(this._tabsEl);
		}
		const msg = dom.append(this._bodyEl, $('.paradis-spreadsheet-message'));
		msg.textContent = message;
	}

	private _renderSheet(): void {
		if (!this._bodyEl) {
			return;
		}
		dom.clearNode(this._bodyEl);
		// 前のシートのヘッダー帯が残らないよう一旦隠す(行位置の実測後 _rebuildStickyStrips が再表示する)。
		this._setStickyStripsVisible(false);

		const sheet = this._sheets[this._activeSheetIndex];
		if (!sheet) {
			this._renderMessage(localize('paradis.spreadsheet.noSheets', "No sheets found"));
			return;
		}

		// 保存時ズームがあれば初期倍率に反映(以後の手動操作を優先)。
		if (!this._userAdjusted && sheet.zoomScale && sheet.zoomScale !== 100) {
			this._scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, sheet.zoomScale / 100));
			this._userAdjusted = true;
		}

		const outer = dom.append(this._bodyEl, $('.paradis-spreadsheet-outer'));
		this._outerEl = outer;
		const inner = dom.append(outer, $('.paradis-spreadsheet-inner'));
		this._innerEl = inner;
		this._activeSheet = sheet;

		const { table, naturalWidth } = this._buildSheetTable(sheet);
		this._tableEl = table;
		this._naturalTableWidth = naturalWidth;
		this._naturalTableHeight = 0; // レイアウト確定後(_placeGeometryOverlays)に実測する
		inner.style.width = `${naturalWidth}px`;
		dom.append(inner, table);

		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "Showing first 2,000 rows. The full file contains more rows.");
		}

		this._renderOverlays(sheet, inner);
		this._applyScale();
	}

	// 図形/改ページ/shrinkToFit は行の実描画位置が要るため、レイアウト確定後(rAF)にまとめて処理する。
	private _renderOverlays(sheet: IParadisSheetData, inner: HTMLElement): void {
		this._overlayRaf.clear();
		const shrinkCells = this._shrinkCells;
		const overflowCells = this._overflowCells;
		const handle = dom.scheduleAtNextAnimationFrame(dom.getWindow(inner), () => {
			// shrinkToFit(read→write 2パスは applyShrinkToFit 内)。
			if (shrinkCells.length > 0) {
				applyShrinkToFit(shrinkCells);
			}
			// セルまたぎのはみ出し(空セルへのオーバーフロー。read→write 2パスは applyOverflow 内)。
			if (overflowCells.length > 0) {
				applyOverflow(overflowCells);
			}
			this._placeGeometryOverlays();
			this._setupReplaceTriggers();
		});
		this._overlayRaf.value = handle;
	}

	/**
	 * 図形・改ページ線を行位置を測り直して配置し直す(idempotent)。
	 * transform:scale は offsetTop に影響しないため、測定は自然座標のまま。フォント反映等の再フロー後にも呼ばれる。
	 */
	private _placeGeometryOverlays(): void {
		const sheet = this._activeSheet;
		const inner = this._innerEl;
		if (!sheet || !inner) {
			return;
		}
		if (this._shapeOverlay) {
			this._shapeOverlay.remove();
			this._shapeOverlay = undefined;
		}
		if (this._pageBreakOverlay) {
			this._pageBreakOverlay.remove();
			this._pageBreakOverlay = undefined;
		}
		const rowY = new Map<number, number>();
		for (const { excelRow, tr } of this._dataRowEls) {
			rowY.set(excelRow, tr.offsetTop);
		}
		const last = this._dataRowEls[this._dataRowEls.length - 1];
		if (last) {
			rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
		}
		if (sheet.shapes && sheet.shapes.length > 0) {
			const overlay = buildShapeOverlay(sheet.shapes, rowY, sheet.columnWidths, sheet.minCol, inner.ownerDocument);
			if (overlay) {
				inner.appendChild(overlay);
				this._shapeOverlay = overlay;
			}
		}
		const breaks = buildPageBreakOverlay(sheet.rowBreaks, sheet.colBreaks, sheet.printArea, rowY, sheet.columnWidths, sheet.minCol, inner.ownerDocument);
		if (breaks) {
			inner.appendChild(breaks);
			this._pageBreakOverlay = breaks;
		}

		// 実レイアウトの測定値で固定ヘッダー帯とスクロール footprint(outer)を更新する。
		this._naturalTableHeight = this._tableEl?.offsetHeight ?? 0;
		this._rebuildStickyStrips();
		this._applyScale();
	}

	/**
	 * 固定ヘッダー帯(列ラベル/行番号)を実 DOM の測定値から作り直す。
	 * セル位置は colgroup の幅指定ではなく th/tr の実測(offsetLeft/offsetTop)を使い、
	 * border-collapse による端数ズレを避ける。倍率・スクロール追従は transform のみで行う。
	 */
	private _rebuildStickyStrips(): void {
		const colInner = this._colStripInner;
		const rowInner = this._rowStripInner;
		const thead = this._theadEl;
		if (!colInner || !rowInner || !thead || !this._tableEl) {
			return;
		}
		dom.clearNode(colInner);
		dom.clearNode(rowInner);
		this._headHeight = thead.offsetHeight;

		// 列ラベル(A,B,C...)。corner th は含まれない(角は固定の別要素)。
		for (const th of this._headCellEls) {
			const cell = dom.append(colInner, $('.paradis-spreadsheet-colhead.paradis-spreadsheet-strip-cell'));
			cell.style.left = `${th.offsetLeft - PARADIS_ROW_NUM_COL_WIDTH}px`;
			cell.style.top = '0';
			cell.style.width = `${th.offsetWidth}px`;
			cell.style.height = `${this._headHeight}px`;
			cell.textContent = th.textContent;
		}

		// 行番号。データ行の実測位置(thead 分を差し引いた自然座標)に合わせる。
		for (let i = 0; i < this._dataRowEls.length; i++) {
			const tr = this._dataRowEls[i].tr;
			const cell = dom.append(rowInner, $('.paradis-spreadsheet-rowhead.paradis-spreadsheet-strip-cell'));
			cell.style.left = '0';
			cell.style.top = `${tr.offsetTop - this._headHeight}px`;
			cell.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
			cell.style.height = `${tr.offsetHeight}px`;
			cell.textContent = String(i + 1);
		}

		this._setStickyStripsVisible(this._dataRowEls.length > 0);
	}

	private _setStickyStripsVisible(visible: boolean): void {
		const display = visible ? 'block' : 'none';
		if (this._colStripEl) {
			this._colStripEl.style.display = display;
		}
		if (this._rowStripEl) {
			this._rowStripEl.style.display = display;
		}
		if (this._cornerEl) {
			this._cornerEl.style.display = display;
		}
	}

	/** 固定ヘッダー帯の transform を現在のスクロール位置・倍率に合わせる(scroll イベントごとに呼ばれる軽量処理)。 */
	private _updateStickyStripTransforms(): void {
		if (!this._bodyEl) {
			return;
		}
		const scale = this._scale;
		if (this._colStripInner) {
			this._colStripInner.style.transform = `translateX(${-this._bodyEl.scrollLeft}px) scale(${scale})`;
		}
		if (this._rowStripInner) {
			this._rowStripInner.style.transform = `translateY(${-this._bodyEl.scrollTop}px) scale(${scale})`;
		}
	}

	/** フォント読み込み完了 + テーブルのサイズ変化(再フロー)で図形/改ページ線を配置し直すトリガを張る。 */
	private _setupReplaceTriggers(): void {
		if (!this._tableEl) {
			return;
		}
		const store = new DisposableStore();
		this._overlayTriggers.value = store;
		const targetWindow = dom.getWindow(this._tableEl);
		const scheduler = new RunOnceScheduler(() => this._placeGeometryOverlays(), 80);
		store.add(scheduler);
		const observer = new targetWindow.ResizeObserver(() => scheduler.schedule());
		observer.observe(this._tableEl);
		store.add(toDisposable(() => observer.disconnect()));
		const token = {};
		this._replaceToken = token;
		targetWindow.document.fonts.ready.then(() => {
			if (this._replaceToken === token) {
				scheduler.schedule();
			}
		}, () => { /* フォント待ち失敗は無視 */ });
	}

	private _buildSheetTable(sheet: IParadisSheetData): { table: HTMLTableElement; naturalWidth: number } {
		// 構築ロジックは buildSheetTableDom に共通化（モバイル向け静的HTML生成と共用）。
		const build = buildSheetTableDom(sheet);
		this._theadEl = build.thead;
		this._headCellEls = build.headCells;
		this._dataRowEls = build.dataRows;
		this._shrinkCells = build.shrinkCells;
		this._overflowCells = build.overflowCells;
		return { table: build.table, naturalWidth: build.naturalWidth };
	}

	private _renderTabs(): void {
		if (!this._tabsEl) {
			return;
		}
		dom.clearNode(this._tabsEl);
		if (this._sheets.length <= 1) {
			this._tabsEl.style.display = 'none';
			return;
		}
		this._tabsEl.style.display = '';
		this._sheets.forEach((sheet, idx) => {
			const tab = dom.append(this._tabsEl!, $('button.paradis-spreadsheet-tab')) as HTMLButtonElement;
			tab.classList.toggle('active', idx === this._activeSheetIndex);
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
			const label = dom.append(tab, $('span'));
			label.textContent = sheet.name;
			this._inputDisposables.value?.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				if (this._activeSheetIndex === idx) {
					return;
				}
				this._activeSheetIndex = idx;
				this._renderSheet();
				this._renderTabs();
			}));
		});
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

	private _computeFitScale(): number {
		const available = this._bodyEl?.clientWidth ?? 0;
		return available > 0 && this._naturalTableWidth > available ? available / this._naturalTableWidth : 1;
	}

	private _applyScale(): void {
		const target = this._userAdjusted ? this._scale : this._computeFitScale();
		if (!this._userAdjusted) {
			this._scale = target;
		}
		if (this._innerEl) {
			if (target !== 1) {
				this._innerEl.style.transform = `scale(${target})`;
				this._innerEl.style.transformOrigin = 'top left';
			} else {
				this._innerEl.style.transform = '';
			}
		}
		// outer を縮尺後サイズにして body のスクロール量を実表示に一致させる(差分ビューアの sizer と同方式。
		// これが無いと縮小時に見た目より大きな空白スクロール領域が残る)。高さはレイアウト実測後のみ設定する。
		if (this._outerEl) {
			this._outerEl.style.width = `${Math.round(this._naturalTableWidth * target)}px`;
			this._outerEl.style.height = this._naturalTableHeight > 0 ? `${Math.round(this._naturalTableHeight * target)}px` : '';
		}
		// 固定ヘッダー帯のコンテナ位置・サイズを倍率に合わせる。
		if (this._headHeight > 0) {
			const headH = Math.round(this._headHeight * target);
			const rowW = Math.round(PARADIS_ROW_NUM_COL_WIDTH * target);
			if (this._colStripEl) {
				this._colStripEl.style.left = `${rowW}px`;
				this._colStripEl.style.height = `${headH}px`;
			}
			if (this._rowStripEl) {
				this._rowStripEl.style.top = `${headH}px`;
				this._rowStripEl.style.width = `${rowW}px`;
			}
			if (this._cornerEl) {
				this._cornerEl.style.width = `${rowW}px`;
				this._cornerEl.style.height = `${headH}px`;
			}
		}
		this._updateStickyStripTransforms();
		if (this._percentBtn) {
			this._percentBtn.textContent = `${Math.round(target * 100)}%`;
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._overlayRaf.clear();
		this._overlayTriggers.clear();
		this._dataRowEls = [];
		this._shrinkCells = [];
		this._overflowCells = [];
		this._activeSheet = undefined;
		this._tableEl = undefined;
		this._theadEl = undefined;
		this._headCellEls = [];
		this._outerEl = undefined;
		this._setStickyStripsVisible(false);
		this._headHeight = 0;
		this._naturalTableHeight = 0;
		this._shapeOverlay = undefined;
		this._pageBreakOverlay = undefined;
		this._replaceToken = {};
		this._currentResource = undefined;
		this._sheets = [];
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
		this._applyScale();
	}
}

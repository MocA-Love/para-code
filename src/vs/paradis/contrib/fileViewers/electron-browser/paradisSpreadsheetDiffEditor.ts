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
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
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
import { PARADIS_SPREADSHEET_DIFF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { PARADIS_ROW_NUM_COL_WIDTH, appendDiagonalOverlay, applyBaseCellStyle, buildShapeDiffOverlay, computeShapeBBox, setCellContent } from './paradisSpreadsheetRender.js';
import { IParadisRenderShape } from '../common/paradisSpreadsheet.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetDiffInput } from './paradisSpreadsheetInput.js';
import { IParadisDiffCell, IParadisDiffRow, IParadisDiffSheet, IParadisShapeDiff, IParadisShapeRender, buildDiffSheets, buildShapeDiff, getDiffRowIndices } from './paradisSpreadsheetDiff.js';
import { appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;

interface IDiffLocation {
	readonly sheetIndex: number;
	/** スクロール対象の差分行インデックス。 */
	readonly rowIndex: number;
	/** 図形の変更なら、ハイライト対象の図形と表示側。 */
	readonly shape?: { readonly render: IParadisRenderShape; readonly side: 'original' | 'modified' };
}

export class ParadisSpreadsheetDiffEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_DIFF_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _navPositionEl: HTMLElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _tabsEl: HTMLElement | undefined;
	private _leftScroll: HTMLElement | undefined;
	private _rightScroll: HTMLElement | undefined;
	private _leftRows: HTMLElement[] = [];
	private _rightRows: HTMLElement[] = [];
	private _leftHighlight: HTMLElement | undefined;
	private _rightHighlight: HTMLElement | undefined;
	private _leftRowY = new Map<number, number>();
	private _rightRowY = new Map<number, number>();
	private _scaledWidths: number[] = [];
	private _openAppEl: HTMLElement | undefined;
	private _syncing = false;

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _diffSheets: IParadisDiffSheet[] = [];
	private _shapeDiffs: IParadisShapeDiff[] = [];
	private _diffLocations: IDiffLocation[] = [];
	private _activeSheetIndex = 0;
	private _currentDiffIdx = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super(PARADIS_SPREADSHEET_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet-diff'));

		const toolbar = dom.append(this._root, $('.paradis-spreadsheet-diff-toolbar'));
		this._countEl = dom.append(toolbar, $('span.paradis-spreadsheet-diff-count'));
		const nav = dom.append(toolbar, $('.paradis-spreadsheet-diff-nav'));
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
		this._renderMessage(localize('paradis.spreadsheet.loadingDiff', "Loading diff..."));
		try {
			const [origWb, modWb] = await Promise.all([
				parseSpreadsheetResource(this._fileService, this._sharedProcessService, original).catch(() => ({ sheets: [] })),
				parseSpreadsheetResource(this._fileService, this._sharedProcessService, modified).catch(() => ({ sheets: [] })),
			]);
			if (token.isCancellationRequested || !isEqual(this._modifiedResource, modified)) {
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

		const shapeDiff = this._shapeDiffs[this._activeSheetIndex];
		const available = Math.max(0, Math.floor(this._bodyEl.clientWidth / 2) - 1);
		this._scaledWidths = this._scaleWidths(sheet.columnWidths, available);

		const left = this._buildDiffPane(sheet.originalRows, localize('paradis.spreadsheet.original', "Original"), shapeDiff?.originalRenders, sheet.originalMinCol, 'original');
		this._leftScroll = left.pane;
		this._leftRows = left.rows;
		this._leftHighlight = left.highlight;
		dom.append(this._bodyEl, left.pane);
		dom.append(this._bodyEl, $('.paradis-spreadsheet-diff-separator'));
		const right = this._buildDiffPane(sheet.modifiedRows, localize('paradis.spreadsheet.modified', "Modified (Working Copy)"), shapeDiff?.modifiedRenders, sheet.modifiedMinCol, 'modified');
		this._rightScroll = right.pane;
		this._rightRows = right.rows;
		this._rightHighlight = right.highlight;
		dom.append(this._bodyEl, right.pane);

		this._wireSyncScroll(this._leftScroll, this._rightScroll);
		this._wireSyncScroll(this._rightScroll, this._leftScroll);
	}

	private _buildDiffPane(rows: readonly IParadisDiffRow[], label: string, shapeRenders: readonly IParadisShapeRender[] | undefined, minCol: number | undefined, side: 'original' | 'modified'): { pane: HTMLElement; rows: HTMLElement[]; highlight: HTMLElement } {
		const pane = $('.paradis-spreadsheet-diff-pane');
		const labelEl = dom.append(pane, $('.paradis-spreadsheet-diff-label'));
		labelEl.textContent = label;
		// テーブルとオーバーレイ/ハイライトを内包する位置基準(スクロールに追従させる)。
		const contentEl = dom.append(pane, $('.paradis-spreadsheet-diff-content'));

		const scaledWidths = this._scaledWidths;
		const table = dom.append(contentEl, $('table.paradis-spreadsheet-table.grid')) as HTMLTableElement;

		const colgroup = dom.append(table, $('colgroup'));
		const rowNumCol = dom.append(colgroup, $('col')) as HTMLTableColElement;
		rowNumCol.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
		for (const w of scaledWidths) {
			const col = dom.append(colgroup, $('col')) as HTMLTableColElement;
			if (w) {
				col.style.width = `${w}px`;
			}
		}

		const tbody = dom.append(table, $('tbody'));
		const rowEls: HTMLElement[] = [];
		const rowMeta: { excelRow: number; tr: HTMLElement }[] = [];
		rows.forEach((row, rowIdx) => {
			const tr = dom.append(tbody, $('tr')) as HTMLTableRowElement;
			rowEls.push(tr);
			if (row.excelRow !== undefined) {
				rowMeta.push({ excelRow: row.excelRow, tr });
			}
			tr.style.height = `${row.height}px`;
			const rowHead = dom.append(tr, $('td.paradis-spreadsheet-rowhead'));
			rowHead.textContent = String(rowIdx + 1);
			for (const cell of row.cells) {
				if (cell.hidden) {
					continue;
				}
				this._buildDiffCell(tr, cell);
			}
		});

		// 現在位置ハイライト用の要素(ナビ時に配置)。
		const highlight = dom.append(contentEl, $('.paradis-spreadsheet-diff-highlight'));

		// 図形は差分ステータス色で描画。レイアウト確定後に行位置を測定して SVG を重ねる。
		if (shapeRenders && shapeRenders.length > 0 && minCol !== undefined) {
			const handle = dom.scheduleAtNextAnimationFrame(dom.getWindow(pane), () => {
				const rowY = new Map<number, number>();
				for (const { excelRow, tr } of rowMeta) {
					rowY.set(excelRow, tr.offsetTop);
				}
				const last = rowMeta[rowMeta.length - 1];
				if (last) {
					rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
				}
				if (side === 'original') {
					this._leftRowY = rowY;
				} else {
					this._rightRowY = rowY;
				}
				const overlay = buildShapeDiffOverlay(shapeRenders, side, rowY, scaledWidths, minCol, contentEl.ownerDocument);
				if (overlay) {
					contentEl.appendChild(overlay);
				}
			});
			this._renderDisposables.add(handle);
		}

		return { pane, rows: rowEls, highlight };
	}

	private _buildDiffCell(tr: HTMLElement, cell: IParadisDiffCell): void {
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
			setCellContent(td, cell);
		}
		if (cell.diagonal) {
			appendDiagonalOverlay(td, cell.diagonal);
		}
	}

	private _scaleWidths(columnWidths: readonly number[], containerWidth: number): number[] {
		const widths = columnWidths.slice();
		if (!containerWidth) {
			return widths;
		}
		const total = PARADIS_ROW_NUM_COL_WIDTH + widths.reduce((s, w) => s + w, 0);
		if (total <= containerWidth) {
			return widths;
		}
		const available = containerWidth - PARADIS_ROW_NUM_COL_WIDTH;
		const colTotal = widths.reduce((s, w) => s + w, 0);
		if (colTotal <= 0) {
			return widths;
		}
		return widths.map(w => Math.floor((w / colTotal) * available));
	}

	private _wireSyncScroll(from: HTMLElement, to: HTMLElement): void {
		this._renderDisposables.add(dom.addDisposableListener(from, dom.EventType.SCROLL, () => {
			if (this._syncing) {
				this._syncing = false;
				return;
			}
			this._syncing = true;
			to.scrollTop = from.scrollTop;
			to.scrollLeft = from.scrollLeft;
		}));
	}

	private _renderTabs(): void {
		if (!this._tabsEl) {
			return;
		}
		dom.clearNode(this._tabsEl);
		if (this._diffSheets.length <= 1) {
			this._tabsEl.style.display = 'none';
			return;
		}
		this._tabsEl.style.display = '';
		this._diffSheets.forEach((sheet, idx) => {
			const tab = dom.append(this._tabsEl!, $('button.paradis-spreadsheet-tab')) as HTMLButtonElement;
			let label = sheet.name;
			if (sheet.sheetStatus === 'added') {
				label += ' (+)';
			} else if (sheet.sheetStatus === 'removed') {
				label += ' (-)';
			}
			tab.textContent = label;
			tab.classList.toggle('active', idx === this._activeSheetIndex);
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
		this._renderDisposables.add(dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => this._highlightLocation(location)));
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
	private _highlightLocation(location: IDiffLocation): void {
		this._clearHighlight(this._leftHighlight);
		this._clearHighlight(this._rightHighlight);
		const sheet = this._diffSheets[this._activeSheetIndex];
		if (location.shape && sheet) {
			const side = location.shape.side;
			const el = side === 'original' ? this._leftHighlight : this._rightHighlight;
			const rowY = side === 'original' ? this._leftRowY : this._rightRowY;
			const minCol = side === 'original' ? sheet.originalMinCol : sheet.modifiedMinCol;
			if (el && minCol !== undefined) {
				const b = computeShapeBBox(location.shape.render, rowY, this._scaledWidths, minCol);
				this._showHighlight(el, b.x - 3, b.y - 3, b.w + 6, b.h + 6);
			}
			return;
		}
		// セル: 両ペインの該当行を帯で強調。
		this._highlightRow(this._leftHighlight, this._leftRows[location.rowIndex]);
		this._highlightRow(this._rightHighlight, this._rightRows[location.rowIndex]);
	}

	private _highlightRow(el: HTMLElement | undefined, tr: HTMLElement | undefined): void {
		if (!el || !tr) {
			return;
		}
		this._showHighlight(el, 0, tr.offsetTop, Math.max(tr.offsetWidth, PARADIS_ROW_NUM_COL_WIDTH), tr.offsetHeight);
	}

	private _showHighlight(el: HTMLElement, x: number, y: number, w: number, h: number): void {
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.style.width = `${w}px`;
		el.style.height = `${h}px`;
		el.style.display = 'block';
		// パルスアニメーションを再トリガー(class を付け直してリフローを挟む)。
		el.classList.remove('pulse');
		void el.offsetWidth;
		el.classList.add('pulse');
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
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._diffSheets = [];
		this._shapeDiffs = [];
		this._diffLocations = [];
		this._leftScroll = undefined;
		this._rightScroll = undefined;
		this._leftRows = [];
		this._rightRows = [];
		this._leftHighlight = undefined;
		this._rightHighlight = undefined;
		this._leftRowY = new Map();
		this._rightRowY = new Map();
		this._scaledWidths = [];
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
	}
}

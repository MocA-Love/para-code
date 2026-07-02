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
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_SPREADSHEET_DIFF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { PARADIS_ROW_NUM_COL_WIDTH, appendDiagonalOverlay, applyBaseCellStyle, buildShapeOverlay, setCellContent } from './paradisSpreadsheetRender.js';
import { IParadisRenderShape } from '../common/paradisSpreadsheet.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetDiffInput } from './paradisSpreadsheetInput.js';
import { IParadisDiffCell, IParadisDiffRow, IParadisDiffSheet, buildDiffSheets, getDiffRowIndices } from './paradisSpreadsheetDiff.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;

interface IDiffLocation {
	readonly sheetIndex: number;
	readonly rowIndex: number;
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
	private _syncing = false;

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _diffSheets: IParadisDiffSheet[] = [];
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
			this._diffLocations = this._diffSheets.flatMap((sheet, sheetIndex) =>
				getDiffRowIndices(sheet).map(rowIndex => ({ sheetIndex, rowIndex })));
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

		const available = Math.max(0, Math.floor(this._bodyEl.clientWidth / 2) - 1);
		const left = this._buildDiffPane(sheet.originalRows, sheet.columnWidths, localize('paradis.spreadsheet.original', "Original"), available, sheet.originalShapes, sheet.originalMinCol);
		this._leftScroll = left.pane;
		this._leftRows = left.rows;
		dom.append(this._bodyEl, left.pane);
		dom.append(this._bodyEl, $('.paradis-spreadsheet-diff-separator'));
		const right = this._buildDiffPane(sheet.modifiedRows, sheet.columnWidths, localize('paradis.spreadsheet.modified', "Modified (Working Copy)"), available, sheet.modifiedShapes, sheet.modifiedMinCol);
		this._rightScroll = right.pane;
		this._rightRows = right.rows;
		dom.append(this._bodyEl, right.pane);

		this._wireSyncScroll(this._leftScroll, this._rightScroll);
		this._wireSyncScroll(this._rightScroll, this._leftScroll);
	}

	private _buildDiffPane(rows: readonly IParadisDiffRow[], columnWidths: readonly number[], label: string, containerWidth: number, shapes: readonly IParadisRenderShape[] | undefined, minCol: number | undefined): { pane: HTMLElement; rows: HTMLElement[] } {
		const pane = $('.paradis-spreadsheet-diff-pane');
		const labelEl = dom.append(pane, $('.paradis-spreadsheet-diff-label'));
		labelEl.textContent = label;

		const scaledWidths = this._scaleWidths(columnWidths, containerWidth);
		const table = dom.append(pane, $('table.paradis-spreadsheet-table')) as HTMLTableElement;

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

		// 図形(斜線コネクタ等)はレイアウト確定後に行位置を測定して SVG を重ねる。
		if (shapes && shapes.length > 0 && minCol !== undefined) {
			const handle = dom.scheduleAtNextAnimationFrame(dom.getWindow(pane), () => {
				const rowY = new Map<number, number>();
				for (const { excelRow, tr } of rowMeta) {
					rowY.set(excelRow, tr.offsetTop);
				}
				const last = rowMeta[rowMeta.length - 1];
				if (last) {
					rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
				}
				const overlay = buildShapeOverlay(shapes, rowY, scaledWidths, minCol, pane.ownerDocument);
				if (overlay) {
					pane.appendChild(overlay);
				}
			});
			this._renderDisposables.add(handle);
		}

		return { pane, rows: rowEls };
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

	override clearInput(): void {
		this._inputDisposables.clear();
		this._renderDisposables.clear();
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._diffSheets = [];
		this._diffLocations = [];
		this._leftScroll = undefined;
		this._rightScroll = undefined;
		this._leftRows = [];
		this._rightRows = [];
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

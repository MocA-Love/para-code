/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel(スプレッドシート)ビューアの EditorPane。xlsx を shared process でパースし、HTMLテーブルとして描画する。
// シート下部タブで切替、コンテナ幅超過時は CSS transform:scale で全体縮小、ディスク更新で自動再描画(correlated watcher)。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
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
import { IParadisSheetData, IParadisWorkbookData } from '../common/paradisSpreadsheet.js';
import { PARADIS_SPREADSHEET_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { PARADIS_ROW_NUM_COL_WIDTH, appendDiagonalOverlay, applyBaseCellStyle, buildShapeOverlay, getColumnLabel, setCellContent } from './paradisSpreadsheetRender.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetInput } from './paradisSpreadsheetInput.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;

export class ParadisSpreadsheetEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _tabsEl: HTMLElement | undefined;
	private _innerEl: HTMLElement | undefined;
	private _naturalTableWidth = 0;
	private _dataRowEls: { excelRow: number; tr: HTMLElement }[] = [];

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _shapeRaf = this._register(new MutableDisposable());
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
	) {
		super(PARADIS_SPREADSHEET_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet'));
		this._bodyEl = dom.append(this._root, $('.paradis-spreadsheet-body'));
		this._tabsEl = dom.append(this._root, $('.paradis-spreadsheet-tabs'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisSpreadsheetInput).resource;
		this._currentResource = resource;
		this._activeSheetIndex = 0;

		const store = new DisposableStore();
		this._inputDisposables.value = store;
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

		const sheet = this._sheets[this._activeSheetIndex];
		if (!sheet) {
			this._renderMessage(localize('paradis.spreadsheet.noSheets', "No sheets found"));
			return;
		}

		const outer = dom.append(this._bodyEl, $('.paradis-spreadsheet-outer'));
		const inner = dom.append(outer, $('.paradis-spreadsheet-inner'));
		this._innerEl = inner;

		const { table, naturalWidth } = this._buildSheetTable(sheet);
		this._naturalTableWidth = naturalWidth;
		inner.style.width = `${naturalWidth}px`;
		dom.append(inner, table);

		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "Showing first 2,000 rows. The full file contains more rows.");
		}

		this._renderShapes(sheet, inner);
		this._applyScale();
	}

	// 図形(斜線コネクタ等)は行の実描画位置が要るため、レイアウト確定後(rAF)に測定してSVGオーバーレイを重ねる。
	private _renderShapes(sheet: IParadisSheetData, inner: HTMLElement): void {
		this._shapeRaf.clear();
		if (!sheet.shapes || sheet.shapes.length === 0) {
			return;
		}
		const rows = this._dataRowEls;
		const shapes = sheet.shapes;
		const columnWidths = sheet.columnWidths;
		const minCol = sheet.minCol;
		const handle = dom.scheduleAtNextAnimationFrame(dom.getWindow(inner), () => {
			const rowY = new Map<number, number>();
			for (const { excelRow, tr } of rows) {
				rowY.set(excelRow, tr.offsetTop);
			}
			const last = rows[rows.length - 1];
			if (last) {
				rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
			}
			const overlay = buildShapeOverlay(shapes, rowY, columnWidths, minCol, inner.ownerDocument);
			if (overlay) {
				inner.appendChild(overlay);
			}
		});
		this._shapeRaf.value = handle;
	}

	private _buildSheetTable(sheet: IParadisSheetData): { table: HTMLTableElement; naturalWidth: number } {
		const table = $('table.paradis-spreadsheet-table') as HTMLTableElement;
		const naturalWidth = PARADIS_ROW_NUM_COL_WIDTH + sheet.columnWidths.reduce((sum, w) => sum + w, 0);
		table.style.width = `${naturalWidth}px`;

		const colgroup = dom.append(table, $('colgroup'));
		const rowNumCol = dom.append(colgroup, $('col')) as HTMLTableColElement;
		rowNumCol.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
		for (const w of sheet.columnWidths) {
			const col = dom.append(colgroup, $('col')) as HTMLTableColElement;
			if (w) {
				col.style.width = `${w}px`;
			}
		}

		const thead = dom.append(table, $('thead.paradis-spreadsheet-head'));
		const headRow = dom.append(thead, $('tr'));
		dom.append(headRow, $('th.paradis-spreadsheet-corner'));
		for (let i = 0; i < sheet.columnCount; i++) {
			const th = dom.append(headRow, $('th.paradis-spreadsheet-colhead'));
			th.textContent = getColumnLabel(i);
		}

		const tbody = dom.append(table, $('tbody'));
		this._dataRowEls = [];
		let displayRowNum = 0;
		for (const row of sheet.rows) {
			displayRowNum++;
			const tr = dom.append(tbody, $('tr')) as HTMLTableRowElement;
			tr.style.height = `${row.height}px`;
			this._dataRowEls.push({ excelRow: row.excelRow, tr });
			const rowHead = dom.append(tr, $('td.paradis-spreadsheet-rowhead'));
			rowHead.textContent = String(displayRowNum);
			for (const cell of row.cells) {
				if (cell.hidden) {
					continue;
				}
				const td = dom.append(tr, $('td')) as HTMLTableCellElement;
				if (cell.colSpan && cell.colSpan > 1) {
					td.colSpan = cell.colSpan;
				}
				if (cell.rowSpan && cell.rowSpan > 1) {
					td.rowSpan = cell.rowSpan;
				}
				applyBaseCellStyle(td, cell);
				setCellContent(td, cell);
				if (cell.diagonal) {
					appendDiagonalOverlay(td, cell.diagonal);
				}
			}
		}

		return { table, naturalWidth };
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
			tab.textContent = sheet.name;
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

	private _applyScale(): void {
		if (!this._innerEl || !this._bodyEl || this._naturalTableWidth <= 0) {
			return;
		}
		const available = this._bodyEl.clientWidth;
		const scale = available > 0 && this._naturalTableWidth > available ? available / this._naturalTableWidth : 1;
		if (scale < 1) {
			this._innerEl.style.transform = `scale(${scale})`;
			this._innerEl.style.transformOrigin = 'top left';
		} else {
			this._innerEl.style.transform = '';
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._shapeRaf.clear();
		this._dataRowEls = [];
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

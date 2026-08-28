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
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
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
import { pageRectangles } from '../common/paradisSpreadsheetPageLayout.js';
import { createParadisOfficeSearchPrintCallbacks, snapshotParadisOfficeRuntimeConfiguration, type ParadisOfficeConfigurationReader, type ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { createParadisOfficeSpreadsheetPrintModel, type ParadisOfficePrintLinePrimitive, type ParadisOfficeSpreadsheetPrintCell } from '../common/paradisOfficePrint.js';
import type { ParadisOfficeCompletenessManifest, ParadisOfficePlaceholder, ParadisOfficePrintModel, ParadisOfficeRenderCoverage, ParadisOfficeSearchResult, ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoveryState, type ParadisOfficeRecoveryEffect } from '../common/paradisOfficeRecovery.js';
import { PARADIS_SPREADSHEET_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { ParadisOfficeAccessibility, applyParadisOfficeGridMetadata, wireParadisOfficeTableGrid, wireParadisOfficeTabList, type ParadisOfficeTabEntry } from '../browser/paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import type { ParadisOfficeSearchPage } from '../common/paradisOfficeSearch.js';
import { IParadisOverflowItem, PARADIS_ROW_NUM_COL_WIDTH, applyOverflow, applyShrinkToFit, buildPageBreakOverlay, buildSheetTableDom, buildShapeOverlay, describeSheetPageBreaks } from './paradisSpreadsheetRender.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetInput } from './paradisSpreadsheetInput.js';
import { appendIconButton, appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';
import { ParadisSpreadsheetGridRenderer, type ParadisSpreadsheetGridTile } from './spreadsheet/paradisSpreadsheetGridRenderer.js';
import { ParadisSpreadsheetViewport, type ParadisSpreadsheetTileRequest } from './spreadsheet/paradisSpreadsheetViewport.js';
import { PARADIS_SPREADSHEET_CHANGE_CATEGORIES, ParadisSpreadsheetChangeInspector, ParadisSpreadsheetOpenGeneration, resolveParadisSpreadsheetNavigation, restoreParadisSpreadsheetViewState, type ParadisSpreadsheetViewState } from './spreadsheet/paradisSpreadsheetChangeInspector.js';
import { renderSpreadsheetDiagnosticsRibbon } from './spreadsheet/paradisSpreadsheetDiagnostics.js';
import { printParadisOfficeModelInBrowser, withParadisOfficePrintResult } from './paradisOfficePrintService.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const VIRTUAL_GRID_CELL_THRESHOLD = 10_000;
const LEGACY_SEARCH_RESULT_LIMIT = 200;
const LEGACY_PRINT_CELL_LIMIT = 10_000;
const INCOMPLETE_SPREADSHEET_MANIFEST: ParadisOfficeCompletenessManifest = Object.freeze({
	expectedParts: 1, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0,
	expectedSemanticUnits: 1, visitedSemanticUnits: 0, terminal: false,
});

interface IParadisSpreadsheetCommittedInput {
	readonly input: EditorInput;
	readonly options: IEditorOptions | undefined;
	readonly resource: URI;
	readonly workbook: IParadisWorkbookData | undefined;
	readonly sheets: readonly IParadisSheetData[];
	readonly activeSheetIndex: number;
	readonly scale: number;
	readonly userAdjusted: boolean;
	readonly runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	readonly viewState: ParadisSpreadsheetViewState;
}

export function isParadisSpreadsheetV1Enabled(configuration: ParadisOfficeRuntimeConfiguration): boolean {
	return configuration.engine !== 'legacy' && configuration.platformBackend && configuration.semanticSpreadsheet;
}

export function createParadisSpreadsheetSourceDescriptor(resource: URI, side?: 'original' | 'modified'): ParadisOfficeSourceDescriptor {
	const kind: ParadisOfficeSourceDescriptor['kind'] = resource.scheme === 'vscode-remote'
		? 'remote'
		: resource.scheme === 'git'
			? 'gitCommit'
			: resource.scheme === 'untitled'
				? 'untitled'
				: side === 'modified'
					? 'workingTree'
					: 'file';
	return { kind, uri: resource.toString(true), displayName: basename(resource), ...(side ? { side } : {}) };
}

function spreadsheetViewStateFromOptions(value: object | undefined, fallback: ParadisSpreadsheetViewState): ParadisSpreadsheetViewState {
	const nested = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'viewState')
		? (value as { readonly viewState?: unknown }).viewState
		: value;
	return restoreParadisSpreadsheetViewState(nested, fallback);
}

export function snapshotSpreadsheetRuntimeConfiguration(configurationService: IConfigurationService): ParadisOfficeRuntimeConfiguration {
	const reader: ParadisOfficeConfigurationReader = {
		getValue: <T>(key: string) => configurationService.getValue<T>(key),
		inspect: <T>(key: string) => configurationService.inspect<T>(key) as IConfigurationValue<T> | undefined,
	};
	return snapshotParadisOfficeRuntimeConfiguration(reader);
}

function spreadsheetColumnLabel(column: number): string {
	let value = column;
	let label = '';
	while (value > 0) {
		value--;
		label = String.fromCharCode(65 + value % 26) + label;
		value = Math.floor(value / 26);
	}
	return label;
}

/** Compatibility search adapter. The callback shape matches v1 search results and includes non-active sheets. */
export function searchLegacySpreadsheetWorkbook(workbook: IParadisWorkbookData, query: string, matchCase = false): readonly ParadisOfficeSearchResult[] {
	const normalizedQuery = query.normalize('NFC').trim();
	if (normalizedQuery.length === 0 || normalizedQuery.length > 4096) {
		return [];
	}
	const matcher = new RegExp(escapeRegExpCharacters(normalizedQuery), matchCase ? 'u' : 'iu');
	const results: ParadisOfficeSearchResult[] = [];
	for (let sheetIndex = 0; sheetIndex < workbook.sheets.length && results.length < LEGACY_SEARCH_RESULT_LIMIT; sheetIndex++) {
		const sheet = workbook.sheets[sheetIndex];
		for (let rowIndex = 0; rowIndex < sheet.rows.length && results.length < LEGACY_SEARCH_RESULT_LIMIT; rowIndex++) {
			const row = sheet.rows[rowIndex];
			for (let columnIndex = 0; columnIndex < row.cells.length && results.length < LEGACY_SEARCH_RESULT_LIMIT; columnIndex++) {
				const text = row.cells[columnIndex].value.normalize('NFC');
				const match = matcher.exec(text);
				if (!match) {
					continue;
				}
				const matchIndex = match.index;
				const matchLength = match[0].length;
				const address = `${spreadsheetColumnLabel(sheet.minCol + columnIndex)}${row.excelRow}`;
				const previewStart = Math.max(0, matchIndex - 40);
				const previewEnd = Math.min(text.length, matchIndex + matchLength + 40);
				results.push({
					id: `legacy-search:${sheetIndex}:${rowIndex}:${columnIndex}`,
					locator: `${sheet.name}!${address}`,
					preview: {
						before: text.slice(previewStart, matchIndex),
						match: text.slice(matchIndex, matchIndex + matchLength),
						after: text.slice(matchIndex + matchLength, previewEnd),
					},
					locationBadge: { kind: 'sheet', label: sheet.name },
					navigableAnchor: `cell:${sheet.name}:${address}`,
				});
			}
		}
	}
	return results;
}

/** Explicit bounded compatibility page used by the shared find widget until a semantic callback is present. */
export function createLegacySpreadsheetSearchPage(workbook: IParadisWorkbookData, query: string, matchCase = false): ParadisOfficeSearchPage {
	const results = searchLegacySpreadsheetWorkbook(workbook, query, matchCase);
	return Object.freeze({ results: Object.freeze([...results]), total: results.length, capped: results.length === LEGACY_SEARCH_RESULT_LIMIT });
}

/** Script-free, bounded fallback model used until a platform print callback is available for this source. */
export function createLegacySpreadsheetPrintModel(workbook: IParadisWorkbookData, title: string): ParadisOfficePrintModel {
	let remainingCells = LEGACY_PRINT_CELL_LIMIT;
	let truncated = false;
	const sheets = workbook.sheets.map((sheet, sheetIndex) => {
		const lineAnchors = new Map<string, ParadisOfficePrintLinePrimitive[]>();
		for (let shapeIndex = 0; shapeIndex < (sheet.shapes?.length ?? 0); shapeIndex++) {
			const shape = sheet.shapes![shapeIndex];
			if (shape.type !== 'line') {
				continue;
			}
			const key = `${shape.from.r + 1}:${shape.from.c + 1}`;
			const lines = lineAnchors.get(key) ?? [];
			lines.push({ kind: 'drawingLine', nodeId: `legacy:${sheetIndex}:drawing:${shapeIndex}`, ...(shape.name ? { label: shape.name } : {}) });
			lineAnchors.set(key, lines);
		}
		const cells: ParadisOfficeSpreadsheetPrintCell[] = [];
		for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex++) {
			for (let columnIndex = 0; columnIndex < sheet.rows[rowIndex].cells.length; columnIndex++) {
				if (remainingCells-- <= 0) {
					truncated = true;
					break;
				}
				const source = sheet.rows[rowIndex].cells[columnIndex];
				const row = sheet.rows[rowIndex].excelRow;
				const column = sheet.minCol + columnIndex;
				const lines: ParadisOfficePrintLinePrimitive[] = [...(lineAnchors.get(`${row}:${column}`) ?? [])];
				if (source.diagonal) {
					lines.push({
						kind: 'cellDiagonal',
						nodeId: `legacy:${sheetIndex}:cell:${row}:${column}:diagonal`,
						direction: source.diagonal.up && source.diagonal.down ? 'both' : source.diagonal.up ? 'topRightToBottomLeft' : 'topLeftToBottomRight',
					});
				}
				cells.push({
					nodeId: `legacy:${sheetIndex}:cell:${row}:${column}`,
					row,
					column,
					runs: [{ text: source.value }],
					...(lines.length ? { lines } : {}),
				});
			}
			if (remainingCells <= 0) {
				break;
			}
		}
		const placeholders: ParadisOfficePlaceholder[] = (sheet.shapes ?? []).map((shape, shapeIndex) => ({
			nodeId: `legacy:${sheetIndex}:drawing:${shapeIndex}`,
			feature: `drawing.${shape.type}`,
			reason: 'unsupported',
			title: shape.name ?? localize('paradis.spreadsheet.printDrawing', "図形"),
			detail: localize('paradis.spreadsheet.printDrawingFallback', "従来の表示方法のため、代替のコンテンツとして印刷されます。"),
		}));
		return {
			nodeId: `legacy:${sheetIndex}`,
			name: sheet.name,
			cells,
			...(sheet.printArea ? {
				printAreas: [{
					minRow: sheet.printArea.minR,
					minColumn: sheet.printArea.minC,
					maxRow: sheet.printArea.maxR,
					maxColumn: sheet.printArea.maxC,
				}]
			} : {}),
			...(sheet.pageLayout ? { pageRanges: pageRectangles(sheet.pageLayout).sort((first, second) => first.page - second.page).map(page => ({ minRow: page.fromRow, minColumn: page.fromCol, maxRow: page.toRow, maxColumn: page.toCol })) } : {}),
			placeholders,
		};
	});
	const model = createParadisOfficeSpreadsheetPrintModel({ title, sheets });
	const approximationWarnings = [...model.approximationWarnings, {
		code: 'spreadsheet.legacyPrintProjection',
		message: localize('paradis.spreadsheet.legacyPrintProjection', "従来の表示方法で開いているため、ページの区切りはおおよその位置になります。"),
	}];
	if (truncated) {
		approximationWarnings.push({
			code: 'spreadsheet.legacyPrintLimit',
			message: localize('paradis.spreadsheet.legacyPrintLimit', "互換表示の印刷プレビューは 10,000 セルまでです。"),
		});
	}
	return { ...model, approximationWarnings };
}

/** Keeps legacy-only visual features on the existing renderer until their bounded tile adapters exist. */
export function shouldVirtualizeSpreadsheetSheet(sheet: IParadisSheetData): boolean {
	if (sheet.rows.length * sheet.columnCount <= VIRTUAL_GRID_CELL_THRESHOLD
		|| sheet.showGridLines === false
		|| (sheet.shapes?.length ?? 0) > 0
		|| (sheet.rowBreaks?.length ?? 0) > 0
		|| (sheet.colBreaks?.length ?? 0) > 0
		|| sheet.printArea !== undefined
		|| sheet.pageLayout !== undefined) {
		return false;
	}
	for (const row of sheet.rows) {
		for (const cell of row.cells) {
			if (cell.shrinkToFit || (cell.richText?.length ?? 0) > 0) {
				return false;
			}
		}
	}
	return true;
}

function legacyGridTile(sheet: IParadisSheetData, request: ParadisSpreadsheetTileRequest): ParadisSpreadsheetGridTile {
	const cells: ParadisSpreadsheetGridTile['cells'][number][] = [];
	for (let rowIndex = request.range[0]; rowIndex < request.range[2]; rowIndex++) {
		const row = sheet.rows[rowIndex];
		if (!row) {
			continue;
		}
		for (let columnIndex = request.range[1]; columnIndex < request.range[3]; columnIndex++) {
			const cell = row.cells[columnIndex];
			if (!cell || cell.hidden) {
				continue;
			}
			cells.push({
				row: rowIndex,
				column: columnIndex,
				text: cell.value,
				style: cell.style,
				classNames: [
					...(cell.wrapText ? ['paradis-spreadsheet-virtual-cell-wrap'] : []),
					...(cell.verticalText ? ['paradis-spreadsheet-virtual-cell-vertical'] : []),
				],
				...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
				...(cell.colSpan ? { columnSpan: cell.colSpan } : {}),
				...(cell.diagonal ? { baseDiagonal: cell.diagonal } : {}),
			});
		}
	}
	return { revision: request.revision, range: request.range, cells };
}

/** 固定ヘッダー帯の計測と DOM 更新を 1 回ずつのフラグメント追加で行う。 */
export function rebuildSpreadsheetStickyStrips(
	colInner: HTMLElement,
	rowInner: HTMLElement,
	thead: HTMLElement,
	headCells: readonly HTMLElement[],
	dataRows: readonly { tr: HTMLElement; excelRow?: number }[],
): { headHeight: number; hasRows: boolean } {
	const headHeight = thead.offsetHeight;
	// 列ラベル(A,B,C...)。corner th は含まれない(角は固定の別要素)。
	const colMetrics = headCells.map(th => ({
		left: th.offsetLeft - PARADIS_ROW_NUM_COL_WIDTH,
		width: th.offsetWidth,
		label: th.textContent ?? '',
	}));
	// 行番号。データ行の実測位置(thead 分を差し引いた自然座標)に合わせる。
	// ラベルは Excel と同じ絶対行番号(excelRow)。非表示行があると通し番号とはズレる。
	const rowMetrics = dataRows.map(({ tr, excelRow }) => ({ top: tr.offsetTop - headHeight, height: tr.offsetHeight, label: String(excelRow ?? '') }));

	dom.clearNode(colInner);
	dom.clearNode(rowInner);

	const doc = colInner.ownerDocument;
	const colFragment = doc.createDocumentFragment();
	for (const metric of colMetrics) {
		const cell = $('.paradis-spreadsheet-colhead.paradis-spreadsheet-strip-cell');
		cell.style.left = `${metric.left}px`;
		cell.style.top = '0';
		cell.style.width = `${metric.width}px`;
		cell.style.height = `${headHeight}px`;
		cell.textContent = metric.label;
		colFragment.appendChild(cell);
	}
	colInner.appendChild(colFragment);

	const rowFragment = doc.createDocumentFragment();
	for (let i = 0; i < rowMetrics.length; i++) {
		const cell = $('.paradis-spreadsheet-rowhead.paradis-spreadsheet-strip-cell');
		cell.style.left = '0';
		cell.style.top = `${rowMetrics[i].top}px`;
		cell.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
		cell.style.height = `${rowMetrics[i].height}px`;
		cell.textContent = rowMetrics[i].label || String(i + 1);
		rowFragment.appendChild(cell);
	}
	rowInner.appendChild(rowFragment);

	return { headHeight, hasRows: dataRows.length > 0 };
}

/** 固定枠の対象範囲。Excel の xSplit/ySplit を「実際に描画されている行・列」の本数へ読み替える。 */
export interface IParadisFrozenPaneExtent {
	/** 先頭から固定する描画済み行の本数。 */
	readonly rowCount: number;
	/** 先頭から固定する描画済み列の本数。 */
	readonly colCount: number;
	/** 固定行の合計高さ(自然座標)。 */
	readonly height: number;
	/** 固定列の合計幅(自然座標)。 */
	readonly width: number;
}

/**
 * Excel の固定枠(行 N・列 M は「シート先頭からの本数」)を、描画済み行・列の本数へ変換する。
 * 使用範囲が途中の行・列から始まるシートでは、固定対象が描画範囲より上/左に外れることがある。
 */
export function resolveFrozenPaneExtent(sheet: IParadisSheetData): IParadisFrozenPaneExtent {
	const freeze = sheet.freezePane;
	if (!freeze) {
		return { rowCount: 0, colCount: 0, height: 0, width: 0 };
	}
	let rowCount = 0;
	let height = 0;
	for (const row of sheet.rows) {
		if (row.excelRow > freeze.rows) {
			break;
		}
		rowCount++;
		height += row.height;
	}
	let colCount = 0;
	let width = 0;
	for (let index = 0; index < sheet.columnWidths.length; index++) {
		if (sheet.minCol + index > freeze.cols) {
			break;
		}
		colCount++;
		width += sheet.columnWidths[index];
	}
	return { rowCount, colCount, height, width };
}

export interface IParadisFrozenPaneBox {
	readonly top: number;
	readonly left: number;
	readonly width?: number;
	readonly height?: number;
}

/**
 * 固定枠3枚の位置と大きさを求める。
 *
 * 重要: 固定行は `translateX(-scrollLeft)`、固定列は `translateY(-scrollTop)` だけを掛けて
 * 本体の表と座標を合わせる。したがって**どの枠も箱の起点は見出し帯の直下(headHeight)で揃える**。
 * 固定列の箱を `headHeight + frozenHeight` から始めると、内側の translate は据え置きなので
 * 中身が frozenHeight ぶん下へずれる(行・列を同時に固定したときに必ず起きる)。
 * 固定行と重なる上部は、より前面にある角の枠が覆う。
 */
export function computeFrozenPaneBoxes(input: {
	readonly headHeight: number;
	readonly frozenHeight: number;
	readonly frozenWidth: number;
	readonly scale: number;
}): { readonly rows: IParadisFrozenPaneBox; readonly cols: IParadisFrozenPaneBox; readonly corner: IParadisFrozenPaneBox } {
	const headH = Math.round(input.headHeight * input.scale);
	const rowW = Math.round(PARADIS_ROW_NUM_COL_WIDTH * input.scale);
	const frozenH = Math.round(input.frozenHeight * input.scale);
	const frozenW = Math.round(input.frozenWidth * input.scale);
	return {
		rows: { top: headH, left: rowW, height: frozenH },
		cols: { top: headH, left: rowW, width: frozenW },
		corner: { top: headH, left: rowW, width: frozenW, height: frozenH },
	};
}

/** 複製した表の子孫要素を、セレクタに依存せず全て辿る。 */
function frozenPaneDescendants(root: HTMLElement): HTMLElement[] {
	const found: HTMLElement[] = [];
	const walk = (element: Element): void => {
		for (const child of Array.from(element.children)) {
			if (dom.isHTMLElement(child)) {
				found.push(child);
			}
			walk(child);
		}
	};
	walk(root);
	return found;
}

/** 複製した表の tbody 行を、DOM API だけで順に取り出す(セレクタに依存しない)。 */
function frozenPaneBodyRows(table: HTMLElement): HTMLTableRowElement[] {
	const rows: HTMLTableRowElement[] = [];
	const bodies = (table as HTMLTableElement).tBodies;
	for (let bodyIndex = 0; bodyIndex < (bodies?.length ?? 0); bodyIndex++) {
		rows.push(...Array.from(bodies[bodyIndex].rows));
	}
	return rows;
}

/** 複製した表から、固定枠に不要な行・列を落として軽くする。 */
export function trimFrozenPaneClone(table: HTMLElement, rowCount: number | undefined, colCount: number | undefined): void {
	const bodyRows = frozenPaneBodyRows(table);
	if (rowCount !== undefined) {
		for (let index = rowCount; index < bodyRows.length; index++) {
			bodyRows[index].remove();
		}
	}
	if (colCount === undefined) {
		return;
	}
	// 行番号セル(先頭)は帯側が描くので固定枠側では残さず、データ列だけを colCount 本に切り詰める。
	for (const row of frozenPaneBodyRows(table)) {
		const cells = Array.from(row.children).slice(1);
		let spanned = 0;
		for (const cell of cells) {
			if (spanned >= colCount) {
				cell.remove();
				continue;
			}
			spanned += Math.max(1, Number((cell as HTMLTableCellElement).colSpan) || 1);
		}
	}
}

/** 診断リボンへ渡す coverage の上限。数万件の配列を作らずに件数だけを伝える。 */
const MAX_DIAGNOSTIC_COVERAGE_SAMPLES = 100_000;

export class ParadisSpreadsheetEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _diagnosticsEl: HTMLElement | undefined;
	private _inspectorPanel: HTMLElement | undefined;
	private _inspectorToggle: HTMLButtonElement | undefined;
	private _openAppEl: HTMLElement | undefined;
	private _percentBtn: HTMLButtonElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _virtualHostEl: HTMLElement | undefined;
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
	// ウィンドウ枠の固定(freeze pane)。ヘッダー帯と同じ理由で position:sticky が使えないため、
	// 固定したい行・列だけを複製した重ね要素をスクロールに追従させる。
	private _frozenRowsEl: HTMLElement | undefined;
	private _frozenRowsInner: HTMLElement | undefined;
	private _frozenColsEl: HTMLElement | undefined;
	private _frozenColsInner: HTMLElement | undefined;
	private _frozenCornerEl: HTMLElement | undefined;
	private _frozenCornerInner: HTMLElement | undefined;
	/** 固定領域の自然サイズ(倍率を掛ける前)。0 なら固定なし。 */
	private _frozenRowsHeight = 0;
	private _frozenColsWidth = 0;
	private _headHeight = 0;
	private _naturalTableWidth = 0;
	private _naturalTableHeight = 0;
	private _dataRowEls: { excelRow: number; tr: HTMLElement }[] = [];
	private _shrinkCells: { td: HTMLElement; span: HTMLElement }[] = [];
	private _overflowCells: IParadisOverflowItem[] = [];
	private _activeSheet: IParadisSheetData | undefined;
	private _shapeOverlay: SVGElement | undefined;
	private _pageBreakOverlay: SVGElement | undefined;
	private _pageLabelOverlay: SVGElement | undefined;
	// フォント反映等の再フローで行高が変わると図形/改ページ線の固定Y座標が古くなるため、再測定・再配置トリガを張る。
	private _replaceToken: object = {};

	private _scale = 1;
	private _userAdjusted = false;

	private readonly _headerDisposables = this._register(new DisposableStore());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	// タブ描画は _renderTabs のたびに DOM とリスナーを作り直すため、入力単位の store ではなく
	// 描画単位の専用 store で管理する(旧タブのリスナー/切り離し済み DOM を都度解放する)。
	private readonly _tabsDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _overlayRaf = this._register(new MutableDisposable());
	private readonly _overlayTriggers = this._register(new MutableDisposable<DisposableStore>());
	private readonly _virtualRenderer = this._register(new MutableDisposable<ParadisSpreadsheetGridRenderer>());
	private readonly _gridAccessibility = this._register(new MutableDisposable<IDisposable>());
	private readonly _changeInspector = this._register(new MutableDisposable<ParadisSpreadsheetChangeInspector>());
	private readonly _findWidget = this._register(new MutableDisposable<ParadisOfficeFindWidget>());
	private _accessibility: ParadisOfficeAccessibility | undefined;
	private _currentResource: URI | undefined;
	private _workbook: IParadisWorkbookData | undefined;
	private _sheets: readonly IParadisSheetData[] = [];
	private _activeSheetIndex = 0;
	private _runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	private readonly _inputGeneration = new ParadisSpreadsheetOpenGeneration();
	private _committedInput: IParadisSpreadsheetCommittedInput | undefined;
	private _recoveryState: IParadisOfficeRecoveryState = createParadisOfficeRecoveryState();
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
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(PARADIS_SPREADSHEET_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet'));
		this._root.style.position = 'relative';
		this._accessibility = this._register(new ParadisOfficeAccessibility(this._root, {
			label: localize('paradis.spreadsheet.viewer', "スプレッドシートビューアー"),
		}));
		this._findWidget.value = new ParadisOfficeFindWidget(this._root, {
			onNavigate: result => this._navigateToLogicalLocator(result.locator, result.navigableAnchor),
		});

		const header = dom.append(this._root, $('.paradis-spreadsheet-header'));
		header.setAttribute('role', 'toolbar');
		header.setAttribute('aria-label', localize('paradis.spreadsheet.toolbar', "スプレッドシートのツールバー"));
		const left = dom.append(header, $('.paradis-spreadsheet-header-left'));
		this._diagnosticsEl = dom.append(left, $('.paradis-spreadsheet-diagnostics-host'));
		const right = dom.append(header, $('.paradis-spreadsheet-header-right'));
		this._inspectorToggle = dom.append(right, $('button.paradis-spreadsheet-percent')) as HTMLButtonElement;
		this._inspectorToggle.type = 'button';
		this._inspectorToggle.textContent = localize('paradis.spreadsheet.inspector', "変更点");
		this._accessibility.labelButton(this._inspectorToggle, localize('paradis.spreadsheet.inspector', "変更点"));
		this._inspectorToggle.setAttribute('aria-expanded', 'false');
		this._inspectorToggle.style.display = 'none';
		this._headerDisposables.add(dom.addDisposableListener(this._inspectorToggle, dom.EventType.CLICK, () => {
			if (!this._inspectorPanel || !this._inspectorToggle) {
				return;
			}
			const visible = this._inspectorPanel.style.display === 'none';
			this._inspectorPanel.style.display = visible ? 'block' : 'none';
			this._inspectorToggle.setAttribute('aria-expanded', String(visible));
		}));

		this._inspectorPanel = dom.append(this._root, $('.paradis-spreadsheet-inspector-panel'));
		this._inspectorPanel.style.position = 'absolute';
		this._inspectorPanel.style.top = '34px';
		this._inspectorPanel.style.right = '8px';
		this._inspectorPanel.style.zIndex = '20';
		this._inspectorPanel.style.width = '360px';
		this._inspectorPanel.style.maxHeight = '70%';
		this._inspectorPanel.style.overflow = 'auto';
		this._inspectorPanel.style.background = 'var(--vscode-editorWidget-background)';
		this._inspectorPanel.style.display = 'none';

		// ズーム −/%/＋（HTMLビューアと同じUI）。
		const zoomOutLabel = localize('paradis.spreadsheet.zoomOut', "ズームアウト");
		this._accessibility.labelButton(appendIconButton(right, Codicon.zoomOut, zoomOutLabel, this._headerDisposables, () => this._zoom(1 / 1.2)), zoomOutLabel);
		this._percentBtn = dom.append(right, $('button.paradis-spreadsheet-percent')) as HTMLButtonElement;
		this._percentBtn.title = localize('paradis.spreadsheet.resetZoom', "ズームをリセット");
		this._accessibility.labelButton(this._percentBtn, localize('paradis.spreadsheet.resetZoom', "ズームをリセット"));
		this._register(dom.addDisposableListener(this._percentBtn, dom.EventType.CLICK, () => this._resetZoom()));
		const zoomInLabel = localize('paradis.spreadsheet.zoomIn', "ズームイン");
		this._accessibility.labelButton(appendIconButton(right, Codicon.zoomIn, zoomInLabel, this._headerDisposables, () => this._zoom(1.2)), zoomInLabel);

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
		// 固定枠は行帯・列帯より内側(角より下)に重ねる。複製した表を内部に持つ。
		this._frozenRowsEl = dom.append(bodyWrap, $('.paradis-spreadsheet-frozenrows'));
		this._frozenRowsInner = dom.append(this._frozenRowsEl, $('.paradis-spreadsheet-strip-inner'));
		this._frozenColsEl = dom.append(bodyWrap, $('.paradis-spreadsheet-frozencols'));
		this._frozenColsInner = dom.append(this._frozenColsEl, $('.paradis-spreadsheet-strip-inner'));
		this._frozenCornerEl = dom.append(bodyWrap, $('.paradis-spreadsheet-frozencorner'));
		this._frozenCornerInner = dom.append(this._frozenCornerEl, $('.paradis-spreadsheet-strip-inner'));
		this._register(dom.addDisposableListener(this._bodyEl, dom.EventType.SCROLL, () => this._updateStickyStripTransforms()));

		this._tabsEl = dom.append(this._root, $('.paradis-spreadsheet-tabs'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const inputGeneration = this._inputGeneration.begin();
		if (this._committedInput && this.input === this._committedInput.input && isEqual(this._currentResource, this._committedInput.resource)) {
			this._committedInput = this._captureCommittedInput(this._committedInput.input, this._committedInput.options);
		}
		const previous = this._committedInput;
		await super.setInput(input, options, context, token);
		if (!this._inputGeneration.isCurrent(inputGeneration)) {
			return;
		}

		const resource = (input as ParadisSpreadsheetInput).resource;
		this._runtimeConfiguration = snapshotSpreadsheetRuntimeConfiguration(this._configurationService);
		const fallbackViewState = this._currentSpreadsheetViewState();
		const requestedViewState = spreadsheetViewStateFromOptions(options?.viewState, fallbackViewState);
		this._currentResource = resource;
		this._activeSheetIndex = 0;
		this._scale = requestedViewState.zoom;
		this._userAdjusted = options?.viewState !== undefined;
		this._clearSemanticUi();
		this._configureInputResource(resource);
		this._recoveryState = beginParadisOfficeRecovery(this._recoveryState, {
			source: { mode: 'document', source: createParadisSpreadsheetSourceDescriptor(resource) },
			viewState: {
				zoom: requestedViewState.zoom,
				activeSheet: requestedViewState.activeSheet,
				categories: [...requestedViewState.categories],
				...(requestedViewState.selectedChangeId ? { selectedChangeId: requestedViewState.selectedChangeId } : {}),
			},
		}).state;

		const loaded = await this._load(resource, token, requestedViewState, this._recoveryState.generation);
		if (!this._inputGeneration.isCurrent(inputGeneration)) {
			return;
		}
		if (!loaded && token.isCancellationRequested && previous) {
			this._recoveryState = reduceParadisOfficeRecovery(this._recoveryState, { type: 'cancelled', generation: this._recoveryState.generation }).state;
			this._currentResource = previous.resource;
			this._workbook = previous.workbook;
			this._sheets = previous.sheets;
			this._activeSheetIndex = previous.activeSheetIndex;
			this._scale = previous.scale;
			this._userAdjusted = previous.userAdjusted;
			this._runtimeConfiguration = previous.runtimeConfiguration;
			this._configureInputResource(previous.resource);
			await super.setInput(previous.input, previous.options, context, CancellationToken.None);
			if (!this._inputGeneration.isCurrent(inputGeneration)) {
				return;
			}
			this._renderSheet();
			this._renderTabs();
			if (previous.workbook) {
				this._renderSemanticUi(previous.workbook, previous.viewState);
			}
			return;
		}
		if (!loaded && token.isCancellationRequested) {
			this._recoveryState = reduceParadisOfficeRecovery(this._recoveryState, { type: 'cancelled', generation: this._recoveryState.generation }).state;
			this.clearInput();
		} else if (loaded) {
			this._committedInput = this._captureCommittedInput(input, options);
		}
	}

	private _captureCommittedInput(input: EditorInput, options: IEditorOptions | undefined): IParadisSpreadsheetCommittedInput {
		return {
			input,
			options,
			resource: this._currentResource!,
			workbook: this._workbook,
			sheets: this._sheets,
			activeSheetIndex: this._activeSheetIndex,
			scale: this._scale,
			userAdjusted: this._userAdjusted,
			runtimeConfiguration: this._runtimeConfiguration,
			viewState: this._currentSpreadsheetViewState(),
		};
	}

	private _configureInputResource(resource: URI): void {
		const store = new DisposableStore();
		this._inputDisposables.value = store;
		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			appendOpenInAppButton(this._openAppEl, resource, this._nativeHostService, store);
			const button = this._openAppEl.firstElementChild as HTMLButtonElement | null;
			if (button) {
				this._accessibility?.labelButton(button, button.title);
			}
		}
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			const scheduler = store.add(new RunOnceScheduler(() => this._onWatchedResourceChanged(resource), 50));
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource)) {
					scheduler.schedule();
				}
			}));
		} catch {
			// watcher 生成失敗は致命的ではない。
		}
	}

	private _onWatchedResourceChanged(resource: URI): void {
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource, this._currentSpreadsheetViewState());
	}

	private _applyRecoveryEffects(effects: readonly ParadisOfficeRecoveryEffect[], resource: URI, viewState: ParadisSpreadsheetViewState): void {
		for (const effect of effects) {
			switch (effect.type) {
				case 'load':
					void this._load(resource, CancellationToken.None, viewState, effect.generation, true);
					break;
				case 'remount':
				case 'recreate':
					// Spreadsheet geometry, including diagonal borders, is remounted from the exact parsed snapshot.
					// Recovery never reparses or mutates the workbook merely to make a second rendering attempt.
					this._renderSheet();
					this._renderTabs();
					if (this._workbook) {
						this._renderSemanticUi(this._workbook, viewState);
					}
					this._finishRecoveryRender(effect.generation, resource, viewState);
					break;
				case 'showError':
					this._renderRecoveryError(resource);
					break;
				case 'restore':
					// The committed DOM was deliberately left mounted while the watcher read ran.
					break;
			}
		}
	}

	private _finishRecoveryRender(recoveryGeneration: number, resource: URI, viewState: ParadisSpreadsheetViewState): void {
		const hasExpectedRoot = this._sheets.length > 0 && (!!this._tableEl || !!this._virtualHostEl);
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'rendered', generation: recoveryGeneration, hasExpectedRoot });
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource, viewState);
	}

	private async _load(resource: URI, token: CancellationToken, viewState = this._currentSpreadsheetViewState(), recoveryGeneration = this._recoveryState.generation, preserveCommitted = false): Promise<boolean> {
		const generation = ++this._loadGeneration;
		if (!preserveCommitted) {
			this._clearSemanticUi();
			this._renderMessage(localize('paradis.spreadsheet.loading', "スプレッドシートを読み込み中..."));
		}
		let workbook: IParadisWorkbookData;
		try {
			workbook = await parseSpreadsheetResource(this._fileService, this._sharedProcessService, resource);
		} catch (err) {
			if (generation === this._loadGeneration && !token.isCancellationRequested && isEqual(this._currentResource, resource)) {
				const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'sourceUnavailable', generation: recoveryGeneration });
				this._recoveryState = transition.state;
				if (!preserveCommitted || transition.effects.length === 0) {
					this._renderMessage(localize('paradis.spreadsheet.error', "スプレッドシートを開けませんでした: {0}", err instanceof Error ? err.message : String(err)));
				}
			}
			return false;
		}
		// 応答の逆順到着で古い結果が新しい結果を上書きしないよう、最新ロードでなければ破棄する。
		if (generation !== this._loadGeneration || token.isCancellationRequested || !isEqual(this._currentResource, resource)) {
			return false;
		}
		this._workbook = workbook;
		this._sheets = workbook.sheets;
		const restoredSheet = this._sheets.findIndex(sheet => sheet.name === viewState.activeSheet);
		if (restoredSheet >= 0) {
			this._activeSheetIndex = restoredSheet;
		}
		if (this._activeSheetIndex >= this._sheets.length) {
			this._activeSheetIndex = 0;
		}
		this._renderSheet();
		this._renderTabs();
		this._renderSemanticUi(workbook, viewState);
		this._finishRecoveryRender(recoveryGeneration, resource, viewState);
		if (this._committedInput && isEqual(this._committedInput.resource, resource) && this.input === this._committedInput.input) {
			this._committedInput = this._captureCommittedInput(this._committedInput.input, this._committedInput.options);
		}
		return true;
	}

	private _currentSpreadsheetViewState(): ParadisSpreadsheetViewState {
		const inspectorState = this._changeInspector.value?.getViewState();
		return {
			zoom: this._scale,
			activeSheet: this._sheets[this._activeSheetIndex]?.name ?? inspectorState?.activeSheet ?? 'Sheet1',
			categories: inspectorState?.categories ?? PARADIS_SPREADSHEET_CHANGE_CATEGORIES,
			...(inspectorState?.selectedChangeId ? { selectedChangeId: inspectorState.selectedChangeId } : {}),
		};
	}

	private _clearSemanticUi(): void {
		this._changeInspector.clear();
		this._findWidget.value?.setSearchProvider(undefined, localize('paradis.spreadsheet.searchDisabledOrUnavailable', "この文書では検索を利用できません。"));
		if (this._diagnosticsEl) {
			dom.clearNode(this._diagnosticsEl);
		}
		if (this._inspectorPanel) {
			dom.clearNode(this._inspectorPanel);
			this._inspectorPanel.style.display = 'none';
		}
		if (this._inspectorToggle) {
			this._inspectorToggle.style.display = 'none';
			this._inspectorToggle.setAttribute('aria-expanded', 'false');
		}
	}

	private _renderSemanticUi(workbook: IParadisWorkbookData, restoredViewState?: ParadisSpreadsheetViewState): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration) {
			this._clearSemanticUi();
			return;
		}
		const v1Enabled = isParadisSpreadsheetV1Enabled(configuration);
		const callbacks = createParadisOfficeSearchPrintCallbacks(configuration, v1Enabled, {
			search: () => ({
				find: async (query: { readonly text: string; readonly matchCase: boolean }, cursor: string | undefined, token: CancellationToken) => {
					if (cursor || token.isCancellationRequested) {
						return Object.freeze({ results: Object.freeze([]), total: 0, capped: false });
					}
					return createLegacySpreadsheetSearchPage(workbook, query.text, query.matchCase);
				},
				inspect: async (query: string) => searchLegacySpreadsheetWorkbook(workbook, query),
			}),
			print: () => async () => {
				const model = createLegacySpreadsheetPrintModel(workbook, basename(this._currentResource ?? URI.file('spreadsheet.xlsx')));
				const result = await printParadisOfficeModelInBrowser(model, this.window);
				return withParadisOfficePrintResult(model, result);
			},
		});
		if (!v1Enabled) {
			this._clearSemanticUi();
			return;
		}
		const viewState = restoredViewState ?? this._currentSpreadsheetViewState();
		this._findWidget.value?.setSearchProvider(callbacks.search?.find, callbacks.search
			? localize('paradis.spreadsheet.searchUnavailableAdapter', "この形式では検索を利用できません。")
			: localize('paradis.spreadsheet.searchDisabled', "検索は設定で無効になっています。"));
		const placeholders: ParadisOfficePlaceholder[] = [];
		for (let sheetIndex = 0; sheetIndex < workbook.sheets.length; sheetIndex++) {
			const sheet = workbook.sheets[sheetIndex];
			for (let shapeIndex = 0; shapeIndex < (sheet.shapes?.length ?? 0); shapeIndex++) {
				const shape = sheet.shapes![shapeIndex];
				const name = shape.name ?? shape.shapeId ?? `${shape.type}-${shapeIndex + 1}`;
				placeholders.push({
					nodeId: `${sheet.name}!object:${name}`,
					feature: `drawing.${shape.type}`,
					reason: 'unsupported',
					title: shape.name ?? localize('paradis.spreadsheet.drawingObject', "図形"),
					detail: localize('paradis.spreadsheet.legacyDrawingDiagnostic', "従来の表示方法で表示しています。"),
				});
			}
		}
		// 診断は node 側で実際に OOXML を読んだ結果(到達度)に基づく。解析できなかった場合だけ、
		// 従来の表示方法で開いている旨を出す。
		const semantic = workbook.semanticDiagnostics;
		const truncated = workbook.sheets.some(sheet => sheet.truncated);
		const coverages: ParadisOfficeRenderCoverage[] = [
			...(semantic?.available
				? Array.from({ length: Math.min(semantic.parsedCells, MAX_DIAGNOSTIC_COVERAGE_SAMPLES) }, () => 'rendered' as const)
				: ['approximated' as const]),
			...placeholders.map(() => 'placeholder' as const),
		];
		if (truncated) {
			coverages.push('noAnchor');
		}
		if (this._diagnosticsEl) {
			const complete = semantic?.available === true && semantic.terminal
				&& semantic.parsedParts === semantic.expectedParts
				&& semantic.parsedSheets === semantic.expectedSheets
				&& semantic.parsedCells === semantic.expectedCells
				&& !truncated && placeholders.length === 0;
			renderSpreadsheetDiagnosticsRibbon(this._diagnosticsEl, {
				outcome: complete ? 'complete' : 'degraded',
				coverages,
				warnings: semantic?.available
					? (truncated
						? [{
							code: 'spreadsheet.truncatedRows',
							message: localize('paradis.spreadsheet.truncatedRows', "行数が多いため、先頭部分だけを表示しています。"),
						}]
						: [])
					: [{
						code: 'spreadsheet.legacyProjection',
						message: localize('paradis.spreadsheet.legacyProjection', "この形式では詳細な解析に対応していないため、従来の表示方法で開いています。"),
					}],
			});
		}
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		dom.clearNode(this._inspectorPanel);
		const inspector = new ParadisSpreadsheetChangeInspector(this._inspectorPanel, {
			...(callbacks.search ? { search: callbacks.search.inspect } : {}),
			...(callbacks.print ? { getPrintModel: callbacks.print } : {}),
			onNavigate: target => this._navigateToLogicalLocator(target.locator, target.anchor),
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(viewState);
		inspector.setComparison([], INCOMPLETE_SPREADSHEET_MANIFEST, 'degraded');
		inspector.setPlaceholders(placeholders);
	}

	private _navigateToLogicalLocator(locator: string, anchor?: string): void {
		const navigation = resolveParadisSpreadsheetNavigation(locator, anchor);
		if (!navigation) {
			return;
		}
		const sheetIndex = this._sheets.findIndex(sheet => sheet.name === navigation.sheetName);
		if (sheetIndex < 0) {
			return;
		}
		this._activeSheetIndex = sheetIndex;
		this._renderSheet();
		this._renderTabs();
		this._changeInspector.value?.setActiveSheet(navigation.sheetName);
		if (!navigation.cell || !this._bodyEl) {
			return;
		}
		const sheet = this._sheets[sheetIndex];
		const rowIndex = sheet.rows.findIndex(row => row.excelRow === navigation.cell!.row);
		const columnIndex = navigation.cell.column - sheet.minCol;
		if (rowIndex < 0 || columnIndex < 0 || columnIndex >= sheet.columnCount) {
			return;
		}
		const body = this._bodyEl;
		const scheduledNavigation = dom.scheduleAtNextAnimationFrame(dom.getWindow(body), () => {
			const virtualHost = this._virtualHostEl;
			if (virtualHost && this._virtualRenderer.value) {
				void this._virtualRenderer.value.revealCell(rowIndex, columnIndex);
				return;
			}
			const rowElement = this._dataRowEls.find(item => item.excelRow === navigation.cell!.row)?.tr as HTMLTableRowElement | undefined;
			const cell = rowElement?.cells[columnIndex + 1];
			cell?.scrollIntoView({ block: 'center', inline: 'center' });
		});
		this._inputDisposables.value?.add(scheduledNavigation);
	}

	private _renderMessage(message: string): void {
		if (!this._bodyEl) {
			return;
		}
		this._gridAccessibility.clear();
		dom.clearNode(this._bodyEl);
		this._setStickyStripsVisible(false);
		this._clearFrozenPanes();
		if (this._tabsEl) {
			dom.clearNode(this._tabsEl);
		}
		const msg = dom.append(this._bodyEl, $('.paradis-spreadsheet-message'));
		msg.textContent = message;
	}

	private _renderRecoveryError(resource: URI): void {
		this._renderMessage(localize('paradis.spreadsheet.blank', "シートの内容を表示できませんでした。"));
		if (!this._bodyEl) {
			return;
		}
		const actions = dom.append(this._bodyEl, $('.paradis-spreadsheet-recovery-actions'));
		const retry = dom.append(actions, $('button')) as HTMLButtonElement;
		retry.type = 'button';
		retry.textContent = localize('paradis.spreadsheet.retry', "再試行");
		this._inputDisposables.value?.add(dom.addDisposableListener(retry, dom.EventType.CLICK, () => {
			const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'retry' });
			this._recoveryState = transition.state;
			this._applyRecoveryEffects(transition.effects, resource, this._currentSpreadsheetViewState());
		}));
		if (resource.scheme === Schemas.file) {
			const open = dom.append(actions, $('button')) as HTMLButtonElement;
			open.type = 'button';
			open.textContent = localize('paradis.spreadsheet.openAfterBlank', "既定のアプリで開く");
			this._inputDisposables.value?.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
				void this._nativeHostService.openExternal(resource.toString(true));
			}));
		}
	}

	private _renderSheet(): void {
		if (!this._bodyEl) {
			return;
		}
		this._virtualRenderer.clear();
		this._gridAccessibility.clear();
		this._overlayRaf.clear();
		this._overlayTriggers.clear();
		this._replaceToken = {};
		this._tableEl = undefined;
		this._theadEl = undefined;
		this._headCellEls = [];
		this._dataRowEls = [];
		this._shrinkCells = [];
		this._overflowCells = [];
		this._innerEl = undefined;
		this._outerEl = undefined;
		this._shapeOverlay = undefined;
		this._pageBreakOverlay = undefined;
		this._pageLabelOverlay = undefined;
		dom.clearNode(this._bodyEl);
		this._bodyEl.classList.remove('virtualized');
		this._virtualHostEl = undefined;
		// 前のシートのヘッダー帯が残らないよう一旦隠す(行位置の実測後 _rebuildStickyStrips が再表示する)。
		this._setStickyStripsVisible(false);
		this._clearFrozenPanes();

		const sheet = this._sheets[this._activeSheetIndex];
		if (!sheet) {
			this._renderMessage(localize('paradis.spreadsheet.noSheets', "シートが見つかりません"));
			return;
		}

		// 保存時ズームがあれば初期倍率に反映(以後の手動操作を優先)。
		if (!this._userAdjusted && sheet.zoomScale && sheet.zoomScale !== 100) {
			this._scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, sheet.zoomScale / 100));
			this._userAdjusted = true;
		}
		this._activeSheet = sheet;
		this._naturalTableWidth = PARADIS_ROW_NUM_COL_WIDTH + sheet.columnWidths.reduce((sum, width) => sum + width, 0);
		if (this._runtimeConfiguration?.virtualizedSpreadsheet !== false && shouldVirtualizeSpreadsheetSheet(sheet)) {
			this._renderVirtualGrid(sheet);
			return;
		}

		const outer = dom.append(this._bodyEl, $('.paradis-spreadsheet-outer'));
		this._outerEl = outer;
		const inner = dom.append(outer, $('.paradis-spreadsheet-inner'));
		this._innerEl = inner;
		const { table, naturalWidth } = this._buildSheetTable(sheet);
		this._tableEl = table;
		this._naturalTableWidth = naturalWidth;
		this._naturalTableHeight = 0; // レイアウト確定後(_placeGeometryOverlays)に実測する
		inner.style.width = `${naturalWidth}px`;
		dom.append(inner, table);
		this._gridAccessibility.value = wireParadisOfficeTableGrid(table, {
			label: localize('paradis.spreadsheet.sheetGrid', "シート「{0}」", sheet.name),
			rowCount: Math.max(1, sheet.rows.length),
			columnCount: Math.max(1, sheet.columnCount),
			logicalCellColumns: sheet.rows.map(row => row.cells.flatMap((cell, column) => cell.hidden ? [] : [column])),
		});

		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "先頭2,000行のみ表示しています。ファイル全体にはさらに行があります。");
		}

		this._renderOverlays(sheet, inner);
		this._applyScale();
	}

	/** Large legacy projections use the same bounded tile callback shape as getViewport(handle, sheet, range). */
	private _renderVirtualGrid(sheet: IParadisSheetData): void {
		if (!this._bodyEl) {
			return;
		}
		this._setStickyStripsVisible(false);
		this._clearFrozenPanes();
		this._bodyEl.classList.add('virtualized');
		const host = dom.append(this._bodyEl, $('.paradis-spreadsheet-virtual-host'));
		this._virtualHostEl = host;
		const target = this._userAdjusted ? this._scale : this._computeFitScale();
		if (!this._userAdjusted) {
			this._scale = target;
		}
		const viewport = new ParadisSpreadsheetViewport({
			rowCount: Math.max(1, sheet.rows.length),
			columnCount: Math.max(1, sheet.columnCount),
			defaultRowHeight: 20 * target,
			defaultColumnWidth: 80 * target,
			rowMetrics: sheet.rows.map((row, index) => ({ index, size: row.height * target })),
			columnMetrics: sheet.columnWidths.map((width, index) => ({ index, size: width * target, hidden: width <= 0 })),
			maxLiveCells: VIRTUAL_GRID_CELL_THRESHOLD,
			revision: `${this._loadGeneration}:${this._activeSheetIndex}:${sheet.name}`,
		});
		const renderer = new ParadisSpreadsheetGridRenderer(host, viewport, {
			getViewport: async request => legacyGridTile(sheet, request),
			fontsReady: dom.getWindow(host).document.fonts.ready,
		});
		applyParadisOfficeGridMetadata(host, localize('paradis.spreadsheet.sheetGrid', "シート「{0}」", sheet.name), Math.max(1, sheet.rows.length), Math.max(1, sheet.columnCount));
		this._virtualRenderer.value = renderer;
		void renderer.render({
			scrollTop: 0,
			scrollLeft: 0,
			width: Math.max(1, this._bodyEl.clientWidth),
			height: Math.max(1, this._bodyEl.clientHeight),
		});
		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "先頭2,000行のみ表示しています。ファイル全体にはさらに行があります。");
		}
		if (this._percentBtn) {
			this._percentBtn.textContent = `${Math.round(target * 100)}%`;
		}
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
		if (this._pageLabelOverlay) {
			this._pageLabelOverlay.remove();
			this._pageLabelOverlay = undefined;
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
		const { rowLines, colLines, labels } = describeSheetPageBreaks(sheet);
		const breaks = buildPageBreakOverlay(rowLines, colLines, sheet.printArea, labels, rowY, sheet.columnWidths, sheet.minCol, inner.ownerDocument);
		if (breaks.lines) {
			inner.appendChild(breaks.lines);
			this._pageBreakOverlay = breaks.lines;
		}
		if (breaks.labels) {
			inner.appendChild(breaks.labels);
			this._pageLabelOverlay = breaks.labels;
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
	 *
	 * 測定(read)を全部先に済ませてから DOM を組む(write)。1行ずつ「作る→測る」を交互にすると、
	 * 要素を足すたびに表全体のレイアウトがやり直され、行数の多いシートでメインスレッドが数十秒止まる。
	 */
	private _rebuildStickyStrips(): void {
		const colInner = this._colStripInner;
		const rowInner = this._rowStripInner;
		const thead = this._theadEl;
		if (!colInner || !rowInner || !thead || !this._tableEl) {
			return;
		}
		const result = rebuildSpreadsheetStickyStrips(colInner, rowInner, thead, this._headCellEls, this._dataRowEls);
		this._headHeight = result.headHeight;
		this._setStickyStripsVisible(result.hasRows);
		this._rebuildFrozenPanes();
	}

	/**
	 * 固定枠(freeze pane)の重ね要素を組み直す。表を複製して不要な行・列を落とし、
	 * 帯と同じ要領でスクロールへ追従させる。仮想化表示では表そのものが無いため何もしない。
	 */
	private _rebuildFrozenPanes(): void {
		this._clearFrozenPanes();

		const sheet = this._activeSheet;
		const table = this._tableEl;
		if (!sheet?.freezePane || !table || this._virtualHostEl) {
			return;
		}
		const extent = resolveFrozenPaneExtent(sheet);
		if (extent.rowCount === 0 && extent.colCount === 0) {
			return;
		}
		// 高さはモデル値ではなく実測を使う。折り返しのある行は指定より高くなるため、
		// モデル値のままだとペインの下端が行の途中で切れる(帯と同じく offsetTop/offsetHeight で測る)。
		this._frozenRowsHeight = extent.rowCount > 0 ? this._measureFrozenRowsHeight(extent.rowCount, extent.height) : 0;
		this._frozenColsWidth = extent.colCount > 0 ? extent.width : 0;

		const mount = (inner: HTMLElement | undefined, rowCount: number | undefined, colCount: number | undefined): void => {
			if (!inner) {
				return;
			}
			const clone = table.cloneNode(true) as HTMLElement;
			clone.removeAttribute('id');
			// 複製は読み上げ・操作の対象にしない(本体の表と二重に読まれるのを防ぐ)。
			clone.setAttribute('aria-hidden', 'true');
			clone.setAttribute('role', 'presentation');
			// 複製に残った id は本体と重複し、タブストップは aria-hidden の内側に置けないので剥がす。
			// (選択中セルは tabindex=0 を持つ)
			for (const element of frozenPaneDescendants(clone)) {
				element.removeAttribute('id');
				element.removeAttribute('tabindex');
			}
			trimFrozenPaneClone(clone, rowCount, colCount);
			// 見出し行と行番号列は帯が描くので、複製側では負のオフセットで画面外へ送る。
			const shift = $('.paradis-spreadsheet-frozen-shift');
			shift.style.marginTop = `${-this._headHeight}px`;
			shift.style.marginLeft = `${-PARADIS_ROW_NUM_COL_WIDTH}px`;
			shift.style.width = `${this._naturalTableWidth}px`;
			dom.append(shift, clone);
			dom.append(inner, shift);
		};

		if (extent.rowCount > 0) {
			mount(this._frozenRowsInner, extent.rowCount, undefined);
		}
		if (extent.colCount > 0) {
			mount(this._frozenColsInner, undefined, extent.colCount);
		}
		if (extent.rowCount > 0 && extent.colCount > 0) {
			mount(this._frozenCornerInner, extent.rowCount, extent.colCount);
		}
		this._setFrozenPanesVisible(true);
		this._applyFrozenPaneGeometry();
	}

	/**
	 * 固定行の実際の高さを、描画済み行の実測位置から求める。まだ測れない場合はモデル値へ戻す。
	 * 行の実測は帯の再構築と同じく thead を差し引いた自然座標で行う。
	 */
	private _measureFrozenRowsHeight(rowCount: number, fallback: number): number {
		const last = this._dataRowEls[rowCount - 1]?.tr;
		if (!last) {
			return fallback;
		}
		const measured = last.offsetTop - this._headHeight + last.offsetHeight;
		return measured > 0 ? measured : fallback;
	}

	/** シート切替・破棄で固定枠の複製を捨てる(複製した表を残すと次のシートに重なる)。 */
	private _clearFrozenPanes(): void {
		this._frozenRowsHeight = 0;
		this._frozenColsWidth = 0;
		for (const inner of [this._frozenRowsInner, this._frozenColsInner, this._frozenCornerInner]) {
			if (inner) {
				dom.clearNode(inner);
			}
		}
		this._setFrozenPanesVisible(false);
	}

	private _setFrozenPanesVisible(visible: boolean): void {
		const rowsVisible = visible && this._frozenRowsHeight > 0;
		const colsVisible = visible && this._frozenColsWidth > 0;
		if (this._frozenRowsEl) {
			this._frozenRowsEl.style.display = rowsVisible ? 'block' : 'none';
		}
		if (this._frozenColsEl) {
			this._frozenColsEl.style.display = colsVisible ? 'block' : 'none';
		}
		if (this._frozenCornerEl) {
			this._frozenCornerEl.style.display = rowsVisible && colsVisible ? 'block' : 'none';
		}
	}

	/** 固定枠の位置・大きさを現在の倍率に合わせる(帯の直下・右側に置く)。 */
	private _applyFrozenPaneGeometry(): void {
		const boxes = computeFrozenPaneBoxes({
			headHeight: this._headHeight,
			frozenHeight: this._frozenRowsHeight,
			frozenWidth: this._frozenColsWidth,
			scale: this._scale,
		});
		for (const [element, box] of [
			[this._frozenRowsEl, boxes.rows],
			[this._frozenColsEl, boxes.cols],
			[this._frozenCornerEl, boxes.corner],
		] as const) {
			if (!element) {
				continue;
			}
			element.style.top = `${box.top}px`;
			element.style.left = `${box.left}px`;
			if (box.width !== undefined) {
				element.style.width = `${box.width}px`;
			}
			if (box.height !== undefined) {
				element.style.height = `${box.height}px`;
			}
		}
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
		// 固定行は横スクロールだけ、固定列は縦スクロールだけ追従する。角はどちらにも動かない。
		if (this._frozenRowsInner) {
			this._frozenRowsInner.style.transform = `translateX(${-this._bodyEl.scrollLeft}px) scale(${scale})`;
		}
		if (this._frozenColsInner) {
			this._frozenColsInner.style.transform = `translateY(${-this._bodyEl.scrollTop}px) scale(${scale})`;
		}
		if (this._frozenCornerInner) {
			this._frozenCornerInner.style.transform = `scale(${scale})`;
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
		// 旧タブのクリックリスナー(と切り離し済み DOM への参照)を解放してから描画し直す。
		const tabsStore = new DisposableStore();
		this._tabsDisposables.value = tabsStore;
		if (this._sheets.length <= 1) {
			this._tabsEl.style.display = 'none';
			return;
		}
		this._tabsEl.style.display = '';
		const accessibleTabs: ParadisOfficeTabEntry[] = [];
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
				lock.title = localize('paradis.spreadsheet.protected', "このシートは保護されています");
				lock.setAttribute('aria-hidden', 'true');
			}
			const label = dom.append(tab, $('span'));
			label.textContent = sheet.name;
			accessibleTabs.push({
				element: tab,
				label: sheet.protectedSheet
					? localize('paradis.spreadsheet.protectedSheetTab', "{0} シート、保護あり", sheet.name)
					: localize('paradis.spreadsheet.sheetTab', "{0} シート", sheet.name),
				selected: idx === this._activeSheetIndex,
			});
			tabsStore.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				if (this._activeSheetIndex === idx) {
					return;
				}
				this._activeSheetIndex = idx;
				this._renderSheet();
				this._renderTabs();
				this._changeInspector.value?.setActiveSheet(sheet.name);
			}));
		});
		tabsStore.add(wireParadisOfficeTabList(this._tabsEl, {
			label: localize('paradis.spreadsheet.sheetTabs', "シート一覧"),
			tabs: accessibleTabs,
		}));
	}

	private _zoom(factor: number): void {
		this._userAdjusted = true;
		this._scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._scale * factor));
		if (this._virtualRenderer.value) {
			this._renderSheet();
		} else {
			this._applyScale();
		}
		this._changeInspector.value?.setZoom(this._scale);
	}

	private _resetZoom(): void {
		this._userAdjusted = false;
		if (this._virtualRenderer.value) {
			this._renderSheet();
		} else {
			this._applyScale();
		}
		this._changeInspector.value?.setZoom(this._scale);
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
			this._applyFrozenPaneGeometry();
		}
		this._updateStickyStripTransforms();
		if (this._percentBtn) {
			this._percentBtn.textContent = `${Math.round(target * 100)}%`;
		}
	}

	override clearInput(): void {
		this._inputGeneration.invalidate();
		this._loadGeneration++;
		this._inputDisposables.clear();
		this._tabsDisposables.clear();
		this._overlayRaf.clear();
		this._overlayTriggers.clear();
		this._virtualRenderer.clear();
		this._clearSemanticUi();
		this._dataRowEls = [];
		this._shrinkCells = [];
		this._overflowCells = [];
		this._activeSheet = undefined;
		this._tableEl = undefined;
		this._theadEl = undefined;
		this._headCellEls = [];
		this._outerEl = undefined;
		this._virtualHostEl = undefined;
		this._setStickyStripsVisible(false);
		this._clearFrozenPanes();
		this._headHeight = 0;
		this._naturalTableHeight = 0;
		this._shapeOverlay = undefined;
		this._pageBreakOverlay = undefined;
		this._pageLabelOverlay = undefined;
		this._replaceToken = {};
		this._currentResource = undefined;
		this._workbook = undefined;
		this._sheets = [];
		this._runtimeConfiguration = undefined;
		this._committedInput = undefined;
		this._recoveryState = createParadisOfficeRecoveryState();
		if (this._bodyEl) {
			dom.clearNode(this._bodyEl);
		}
		if (this._tabsEl) {
			dom.clearNode(this._tabsEl);
		}
		super.clearInput();
	}

	override getViewState(): object | undefined {
		if (!this._currentResource) {
			return undefined;
		}
		return {
			source: createParadisSpreadsheetSourceDescriptor(this._currentResource),
			viewState: this._currentSpreadsheetViewState(),
		};
	}

	override layout(dimension: dom.Dimension): void {
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
		const virtualRenderer = this._virtualRenderer.value;
		if (virtualRenderer) {
			void virtualRenderer.render({
				...virtualRenderer.frame,
				width: Math.max(1, this._bodyEl?.clientWidth ?? dimension.width),
				height: Math.max(1, this._bodyEl?.clientHeight ?? dimension.height),
			});
		} else {
			this._applyScale();
		}
	}
}

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
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
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
import { IParadisCellComment, IParadisCellData, IParadisRenderShape, IParadisSemanticDiagnosticsSummary, IParadisSheetData, IParadisSpreadsheetMetafileImages, IParadisWorkbookData, unavailableParadisSpreadsheetSemanticDiagnostics } from '../common/paradisSpreadsheet.js';
import { pageRectangles } from '../common/paradisSpreadsheetPageLayout.js';
import { createParadisOfficeSearchPrintCallbacks, snapshotParadisOfficeRuntimeConfiguration, type ParadisOfficeConfigurationReader, type ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { createParadisOfficeSpreadsheetPrintModel, type ParadisOfficePrintLinePrimitive, type ParadisOfficeSpreadsheetPrintCell, type ParadisOfficeSpreadsheetPrintSheet } from '../common/paradisOfficePrint.js';
import type { ParadisOfficeCompletenessManifest, ParadisOfficePlaceholder, ParadisOfficePrintModel, ParadisOfficeRenderCoverage, ParadisOfficeSearchResult, ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoveryState, type ParadisOfficeRecoveryEffect } from '../common/paradisOfficeRecovery.js';
import { ParadisOfficeViewerProbe } from '../common/paradisOfficeProbe.js';
import { ParadisOfficeOpenCache } from '../common/paradisOfficeOpenCache.js';
import { IParadisViewerOpenTiming, startParadisViewerOpenTiming } from '../common/paradisViewerOpenTiming.js';
import type { ParadisOfficeDiagnosticEngine } from '../common/paradisOfficeDiagnostics.js';
import { PARADIS_SPREADSHEET_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { ParadisOfficeAccessibility, applyParadisOfficeGridMetadata, wireParadisOfficeTableGrid, wireParadisOfficeTabList, type ParadisOfficeTabEntry } from '../browser/paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import type { ParadisOfficeSearchPage } from '../common/paradisOfficeSearch.js';
import { IParadisOverflowItem, PARADIS_ROW_NUM_COL_WIDTH, applyOverflow, applyShrinkToFit, buildPageBreakOverlay, buildSheetTableDom, buildShapeOverlay, buildShownNoteOverlay, commentKindsByCell, commentMarkerClass, computeOverflowColumns, computeOverflowRoom, describeSheetPageBreaks, getColumnLabel, isFilterHeaderCell, overflowToward, tableCellRole } from './paradisSpreadsheetRender.js';
import { ParadisSpreadsheetBrokenImages } from './paradisSpreadsheetBrokenImages.js';
import { spreadsheetBrokenImagePlaceholders, spreadsheetUndrawnPlaceholders } from './paradisSpreadsheetDrawings.js';
import { createParadisSpreadsheetPrintDrawingBudget, paradisSpreadsheetPrintLayout, type IParadisSpreadsheetPrintLayout } from './paradisSpreadsheetPrintLayout.js';
import { applySpreadsheetMetafiles, collectSpreadsheetSemanticDiagnostics, convertSpreadsheetMetafiles, estimateParadisWorkbookBytes, hasPendingSpreadsheetMetafiles, isParadisSpreadsheetUnreportedError, openSpreadsheetResource, warmSpreadsheetParser, type IParadisSpreadsheetOpenCacheValue } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetInput } from './paradisSpreadsheetInput.js';
import { appendIconButton, appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarPanelToggle, appendParadisViewerToolbarPercent, appendParadisViewerToolbarSeparator, createParadisViewerToolbar } from '../browser/paradisViewerToolbar.js';
import { PARADIS_OFFICE_CHANGE_PANEL_CLASS, PARADIS_OFFICE_PANEL_SURFACE_CLASS } from './paradisOfficeInspectorParts.js';
import { appendParadisSpreadsheetSheetTab, styleParadisSpreadsheetSheetTabList } from './paradisSpreadsheetSheetTabs.js';
import { ParadisSpreadsheetGridRenderer, type ParadisSpreadsheetGridCell, type ParadisSpreadsheetGridTile } from '../browser/spreadsheet/paradisSpreadsheetGridRenderer.js';
import { ParadisSpreadsheetViewport, type ParadisSpreadsheetTileRequest, type ParadisSpreadsheetViewportFrame, type ParadisSpreadsheetVirtualRange } from '../browser/spreadsheet/paradisSpreadsheetViewport.js';
import { PARADIS_SPREADSHEET_CHANGE_CATEGORIES, ParadisSpreadsheetChangeInspector, ParadisSpreadsheetOpenGeneration, resolveParadisSpreadsheetNavigation, restoreParadisSpreadsheetViewState, type ParadisSpreadsheetViewState } from './spreadsheet/paradisSpreadsheetChangeInspector.js';
import { renderSpreadsheetDiagnosticsRibbon } from './spreadsheet/paradisSpreadsheetDiagnostics.js';
import { printParadisOfficeModelInBrowser, withParadisOfficePrintResult } from './paradisOfficePrintService.js';

import '../browser/spreadsheet/media/paradisSpreadsheetGrid.css';
import './media/paradisSpreadsheet.css';
import { IParadisViewerStateAction, PARADIS_VIEWER_LOADING_LABEL, PARADIS_VIEWER_OPEN_IN_APP_LABEL, PARADIS_VIEWER_RETRY_LABEL, ParadisViewerStateKind, renderParadisViewerState } from '../browser/paradisViewerState.js';

const $ = dom.$;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const VIRTUAL_GRID_CELL_THRESHOLD = 10_000;
const LEGACY_SEARCH_RESULT_LIMIT = 200;
const LEGACY_PRINT_CELL_LIMIT = 10_000;
/** shared process が混み合っていたときに、詳しい解析を頼み直すまでの間（回数はこの長さ）。 */
const SEMANTIC_BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
/**
 * 解析したブックを、ウィンドウにつき 1 つ覚えておく。タブを戻したとき・別のグループで同じブックを開いた
 * ときに、読み込みと解析を省く。解析結果は元のファイルの 20 倍ほどになるので、最近の 3 冊まで、見積もりで
 * 合計 192 MiB まで。Excel のタブがどれも何も表示しなくなって 10 分たったら全部手放す。
 */
const SPREADSHEET_OPEN_CACHE = new ParadisOfficeOpenCache<IParadisSpreadsheetOpenCacheValue>({ maxEntries: 3, maxBytes: 192 * 1024 * 1024, idleMs: 10 * 60 * 1000 });
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

/**
 * 表を描いた後に続けて頼む処理（詳しい解析・EMF と WMF の変換）の token を作り、`slot` に預ける。`slot` の中身が
 * 替わる（次の読み込み）・消える（別の入力・閉じる）と取り消す。`setInput` の token には繋がない: 本家の
 * editorPanes は開き終わったところで `setInput` の token を取り消すので、繋ぐと描いた直後に必ず取り消され、
 * 「詳しい解析を実行しています…」が残る。
 */
export function startSpreadsheetFollowUpRequest(slot: MutableDisposable<IDisposable>): CancellationToken {
	const request = new CancellationTokenSource();
	slot.value = toDisposable(() => request.dispose(true));
	return request.token;
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

/** シートと同じ寸法・書式・図形でページを組む印刷用のシート。描けなかった図形だけを代替表示に数える。 */
function layoutPrintSheet(sheet: IParadisSheetData, sheetIndex: number, printLayout: IParadisSpreadsheetPrintLayout, takeCell: () => boolean): ParadisOfficeSpreadsheetPrintSheet {
	const cells: ParadisOfficeSpreadsheetPrintCell[] = [];
	outer: for (const row of sheet.rows) {
		for (let columnIndex = 0; columnIndex < row.cells.length; columnIndex++) {
			const source = row.cells[columnIndex];
			if (source.hidden) {
				continue;
			}
			if (!takeCell()) {
				break outer;
			}
			const column = sheet.minCol + columnIndex;
			const css = printLayout.cellCss.get(`${row.excelRow}:${column}`);
			const runs = source.richText?.length ? source.richText.map(part => ({ text: part.text })) : [{ text: source.value }];
			cells.push({
				nodeId: `legacy:${sheetIndex}:cell:${row.excelRow}:${column}`,
				row: row.excelRow,
				column,
				runs,
				...(source.rowSpan && source.rowSpan > 1 ? { rowSpan: source.rowSpan } : {}),
				...(source.colSpan && source.colSpan > 1 ? { columnSpan: source.colSpan } : {}),
				...(css ? { css } : {}),
			});
		}
	}
	const setup = sheet.pageSetup;
	return {
		nodeId: `legacy:${sheetIndex}`,
		name: sheet.name,
		cells,
		...(sheet.printArea ? { printAreas: [{ minRow: sheet.printArea.minR, minColumn: sheet.printArea.minC, maxRow: sheet.printArea.maxR, maxColumn: sheet.printArea.maxC }] } : {}),
		...(sheet.pageLayout ? { pageRanges: pageRectangles(sheet.pageLayout).sort((first, second) => first.page - second.page).map(page => ({ minRow: page.fromRow, minColumn: page.fromCol, maxRow: page.toRow, maxColumn: page.toCol })) } : {}),
		...(setup ? { pageSetup: { widthPoints: setup.paperWidth, heightPoints: setup.paperHeight } } : {}),
		...(setup?.repeatRowsFrom !== undefined && setup.repeatRowsTo !== undefined ? { printTitles: { rows: { from: setup.repeatRowsFrom, to: setup.repeatRowsTo } } } : {}),
		// 枠の形で近似した図形は印刷のページに描いているので、代替表示には出さない。
		placeholders: spreadsheetUndrawnPlaceholders([sheet]).filter(placeholder => placeholder.feature !== 'drawing.geometry'),
		layout: printLayout.layout,
	};
}

/** Script-free, bounded fallback model used until a platform print callback is available for this source. */
export function createLegacySpreadsheetPrintModel(workbook: IParadisWorkbookData, title: string, doc?: Document): ParadisOfficePrintModel {
	let remainingCells = LEGACY_PRINT_CELL_LIMIT;
	let truncated = false;
	let omittedDrawings = 0;
	const drawingBudget = createParadisSpreadsheetPrintDrawingBudget();
	const sheets = workbook.sheets.map((sheet, sheetIndex): ParadisOfficeSpreadsheetPrintSheet => {
		// 文書が渡されたときは、ページをシートと同じ寸法・書式で組み、図形・画像・グラフを描く。
		const printLayout = doc ? paradisSpreadsheetPrintLayout(sheet, doc, drawingBudget) : undefined;
		if (printLayout) {
			omittedDrawings += printLayout.omittedDrawings;
			return layoutPrintSheet(sheet, sheetIndex, printLayout, () => {
				if (remainingCells-- <= 0) {
					truncated = true;
					return false;
				}
				return true;
			});
		}
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
	const model = createParadisOfficeSpreadsheetPrintModel({ title, sheets, ...(omittedDrawings ? { omittedDrawings } : {}) });
	const approximationWarnings = [...model.approximationWarnings];
	if (!doc) {
		approximationWarnings.push({
			code: 'spreadsheet.legacyPrintProjection',
			message: localize('paradis.spreadsheet.legacyPrintProjection', "従来の表示方法で開いているため、ページの区切りはおおよその位置になります。"),
		});
	}
	if (truncated) {
		approximationWarnings.push({
			code: 'spreadsheet.legacyPrintLimit',
			message: localize('paradis.spreadsheet.legacyPrintLimit', "互換表示の印刷プレビューは 10,000 セルまでです。"),
		});
	}
	return { ...model, approximationWarnings };
}

/**
 * 大きなシートを仮想グリッドで描くか。仮想グリッドは見出し・固定枠・はみ出し・結合・罫線・表の体裁・行の高さ・
 * 図形・「表示」のメモ・改ページ・印刷範囲・ページ番号を DOM の表と同じに描く。まだ描けない縮小表示（shrinkToFit）と
 * リッチテキストのあるシートだけは、今の描き方（DOM の表）に留める。
 */
export function shouldVirtualizeSpreadsheetSheet(sheet: IParadisSheetData): boolean {
	if (sheet.rows.length * sheet.columnCount <= VIRTUAL_GRID_CELL_THRESHOLD) {
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

/**
 * 仮想グリッドの行・列は、先頭に見出し（行番号の列と、列記号の行）を 1 つずつ足した番号で数える。
 * データの行・列の番号はこれを引いたもの。見出しは固定枠として描くので、スクロールしても残る。
 */
export const VIRTUAL_GRID_HEADER_ROWS = 1;
export const VIRTUAL_GRID_HEADER_COLUMNS = 1;

/** タイルを作るたびに数え直さない、シートごとの下ごしらえ。 */
export interface IParadisVirtualGridIndex {
	readonly comments: ReadonlyMap<string, IParadisCellComment>;
	/** 結合の起点（データの行・列の番号）。範囲の外にある起点も、範囲に掛かっていればタイルに入れる。 */
	readonly merges: readonly { readonly row: number; readonly column: number; readonly rowSpan: number; readonly columnSpan: number }[];
	/** 結合の起点を行ごとに並べたもの（タイルごとに全件を見ないため）と、いちばん縦に長い結合の行数。 */
	readonly mergesByRow: ReadonlyMap<number, readonly { readonly row: number; readonly column: number; readonly rowSpan: number; readonly columnSpan: number }[]>;
	readonly maxMergeRows: number;
	/** 固定した列の数（データの列）。固定枠のタイルのはみ出しは、この境目で切る。 */
	readonly frozenColumns: number;
}

export function createVirtualGridIndex(sheet: IParadisSheetData): IParadisVirtualGridIndex {
	const merges: { row: number; column: number; rowSpan: number; columnSpan: number }[] = [];
	sheet.rows.forEach((row, rowIndex) => row.cells.forEach((cell, columnIndex) => {
		if (!cell.hidden && ((cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1)) {
			merges.push({ row: rowIndex, column: columnIndex, rowSpan: cell.rowSpan ?? 1, columnSpan: cell.colSpan ?? 1 });
		}
	}));
	const mergesByRow = new Map<number, typeof merges>();
	let maxMergeRows = 1;
	for (const merge of merges) {
		mergesByRow.set(merge.row, [...(mergesByRow.get(merge.row) ?? []), merge]);
		maxMergeRows = Math.max(maxMergeRows, merge.rowSpan);
	}
	return { comments: commentKindsByCell(sheet), merges, mergesByRow, maxMergeRows, frozenColumns: resolveFrozenPaneExtent(sheet).colCount };
}

/**
 * 仮想グリッドのセルの罫線。読み込みは隣り合う辺の罫線を両方のセルに書く（DOM の表は border-collapse で 1 本にまとまる）。
 * 仮想グリッドのセルは別々の箱なので、そのままだと 2 本重なる。各セルは右と下の辺だけを描き、左と上の辺の罫線は
 * 左・上の隣が自分の右・下の罫線として描く（隣が自分の罫線を持っていればそちらを使う）。
 */
function virtualGridCellStyle(sheet: IParadisSheetData, rowIndex: number, columnIndex: number, cell: IParadisCellData): Readonly<Record<string, string>> {
	const style: Record<string, string> = { ...(cell.style as Record<string, string>) };
	const rowSpan = cell.rowSpan ?? 1;
	const columnSpan = cell.colSpan ?? 1;
	// 右の辺: 自分の右の罫線と、右隣（幅 0 の隠れた列は飛ばす）の左の罫線のうち、border-collapse で勝つ方。結合は全部の行で見る
	const rightColumn = nextVisibleColumn(sheet, columnIndex + columnSpan);
	if (rightColumn !== undefined) {
		const candidates: (string | undefined)[] = [style.borderRight];
		for (let row = rowIndex; row < rowIndex + rowSpan; row++) {
			const neighbour = sheet.rows[row]?.cells[rightColumn];
			if (neighbour && !neighbour.hidden) {
				candidates.push(neighbour.style.borderLeft as string | undefined);
			}
		}
		setBorder(style, 'borderRight', collapseBorders(candidates));
	}
	// 下の辺: 自分の下の罫線と、下の行の上の罫線のうち勝つ方。結合は全部の列で見る
	const belowRow = sheet.rows[rowIndex + rowSpan];
	if (belowRow) {
		const candidates: (string | undefined)[] = [style.borderBottom];
		for (let column = columnIndex; column < columnIndex + columnSpan; column++) {
			const neighbour = belowRow.cells[column];
			if (neighbour && !neighbour.hidden && (sheet.columnWidths[column] ?? 0) > 0) {
				candidates.push(neighbour.style.borderTop as string | undefined);
			}
		}
		setBorder(style, 'borderBottom', collapseBorders(candidates));
	}
	// 左と上の辺は、左・上の隣が自分の右・下として描く（左に見えている列が無い、先頭の行のときだけ自分で描く）
	if (previousVisibleColumn(sheet, columnIndex) !== undefined) {
		delete style.borderLeft;
	}
	if (rowIndex > 0) {
		delete style.borderTop;
	}
	return style;
}

function setBorder(style: Record<string, string>, side: 'borderRight' | 'borderBottom', value: string | undefined): void {
	if (value) {
		style[side] = value;
	} else {
		delete style[side];
	}
}

function nextVisibleColumn(sheet: IParadisSheetData, from: number): number | undefined {
	for (let column = from; column < sheet.columnWidths.length; column++) {
		if ((sheet.columnWidths[column] ?? 0) > 0) {
			return column;
		}
	}
	return undefined;
}

function previousVisibleColumn(sheet: IParadisSheetData, before: number): number | undefined {
	for (let column = before - 1; column >= 0; column--) {
		if ((sheet.columnWidths[column] ?? 0) > 0) {
			return column;
		}
	}
	return undefined;
}

/** border-collapse の勝ち方の順（CSS 2.1 17.6.2.1）。強い方が後ろ。 */
const BORDER_STYLE_ORDER = ['inset', 'groove', 'outset', 'ridge', 'dotted', 'dashed', 'solid', 'double'];

/**
 * ぶつかる罫線のうち、DOM の表（border-collapse）で勝つもの。hidden が最優先、none は負け、太い方、種類の強い方、
 * 同じなら先に並べたもの（左・上のセル）。
 */
export function collapseBorders(candidates: readonly (string | undefined)[]): string | undefined {
	let best: { readonly value: string; readonly width: number; readonly rank: number } | undefined;
	for (const value of candidates) {
		if (!value) {
			continue;
		}
		const parsed = parseBorder(value);
		if (parsed.style === 'hidden') {
			return value;
		}
		if (parsed.style === 'none' || parsed.width <= 0) {
			continue;
		}
		const rank = BORDER_STYLE_ORDER.indexOf(parsed.style);
		if (!best || parsed.width > best.width || (parsed.width === best.width && rank > best.rank)) {
			best = { value, width: parsed.width, rank };
		}
	}
	return best?.value;
}

function parseBorder(value: string): { readonly width: number; readonly style: string } {
	const tokens = value.trim().toLowerCase().split(/\s+(?![^(]*\))/);
	let width = 3;
	let style = 'none';
	for (const token of tokens) {
		const px = /^(?<number>\d+(?:\.\d+)?)px$/.exec(token);
		if (px?.groups) {
			width = Number(px.groups.number);
		} else if (token === 'thin' || token === 'medium' || token === 'thick') {
			width = token === 'thin' ? 1 : token === 'medium' ? 3 : 5;
		} else if (token === 'hidden' || token === 'none' || BORDER_STYLE_ORDER.includes(token)) {
			style = token;
		}
	}
	return { width, style };
}

/** データのセル 1 つを、仮想グリッドの番号のセルにする（はみ出しの決まりは DOM の表と同じ）。 */
function virtualGridCell(sheet: IParadisSheetData, index: IParadisVirtualGridIndex, rowIndex: number, columnIndex: number, columnLimit?: number): ParadisSpreadsheetGridCell | undefined {
	const row = sheet.rows[rowIndex];
	const cell = row?.cells[columnIndex];
	if (!row || !cell || cell.hidden) {
		return undefined;
	}
	const toward = overflowToward(cell);
	// 固定枠のタイルでは、固定の境目より右へははみ出さない（スクロールしても文字の端が固定枠に残らないように）
	const rowCells = columnLimit !== undefined ? row.cells.slice(0, columnLimit) : row.cells;
	const room = toward !== 'none' ? computeOverflowRoom(rowCells, columnIndex, sheet.columnWidths) : undefined;
	const columns = room && (room.left > 0 || room.right > 0) ? computeOverflowColumns(rowCells, columnIndex) : undefined;
	const column = columnIndex + VIRTUAL_GRID_HEADER_COLUMNS;
	const excelColumn = sheet.minCol + columnIndex;
	const role = tableCellRole(sheet, row.excelRow, excelColumn);
	const valign = cell.style.verticalAlign as string | undefined;
	return {
		row: rowIndex + VIRTUAL_GRID_HEADER_ROWS,
		column,
		text: cell.value,
		style: virtualGridCellStyle(sheet, rowIndex, columnIndex, cell),
		classNames: [
			...(cell.wrapText ? ['paradis-spreadsheet-virtual-cell-wrap'] : []),
			...(cell.verticalText ? ['paradis-spreadsheet-virtual-cell-vertical'] : []),
			// div では vertical-align が効かないので、縦位置はクラスで並べ方を変える（既定は Excel と同じ下寄せ）
			...(valign === 'top' ? ['paradis-spreadsheet-virtual-valign-top'] : valign === 'middle' ? ['paradis-spreadsheet-virtual-valign-middle'] : []),
			...commentClassFor(index.comments, row.excelRow, excelColumn),
			// テーブル/オートフィルタの体裁（DOM の表と同じクラス）
			...(role?.header ? ['paradis-spreadsheet-table-header'] : []),
			...(role?.totals ? ['paradis-spreadsheet-table-totals'] : []),
			...(role?.stripe ? ['paradis-spreadsheet-table-stripe'] : []),
			...(role?.emphasizedColumn ? ['paradis-spreadsheet-table-emphasis'] : []),
			...(isFilterHeaderCell(sheet.filterRanges, row.excelRow, excelColumn) ? ['paradis-spreadsheet-virtual-filter'] : []),
		],
		...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
		...(cell.colSpan ? { columnSpan: cell.colSpan } : {}),
		...(cell.diagonal ? { baseDiagonal: cell.diagonal } : {}),
		...(toward !== 'none' && room && columns ? {
			overflow: {
				toward, leftRoom: room.left, rightRoom: room.right, valign: (cell.style.verticalAlign as string) || 'bottom',
				fromColumn: column - (toward === 'right' ? 0 : columns.left), toColumn: column + 1 + (toward === 'left' ? 0 : columns.right),
			},
		} : {}),
	};
}

/**
 * 入れ物の大きさが変わったときの frame。frame は倍率を掛ける前の寸法なので、入れ物の大きさを倍率で割る
 * （割らないと、縮小したときに右と下が計画されず空白になる）。スクロール位置はそのまま。
 */
export function virtualGridLayoutFrame(frame: ParadisSpreadsheetViewportFrame, hostWidth: number, hostHeight: number, zoom: number): ParadisSpreadsheetViewportFrame {
	return { ...frame, width: Math.max(1, hostWidth / zoom), height: Math.max(1, hostHeight / zoom) };
}

/**
 * Excel の行番号 → 仮想グリッドの上での行の上端（最後の行の次の番号には下端を入れる）。DOM の表の `tr.offsetTop` と
 * 同じく、列記号の行の高さを含む。列の座標は DOM の表と同じく、行番号の列（`PARADIS_ROW_NUM_COL_WIDTH`、44px）の右から列幅を足して求まる。
 */
export function virtualGridRowTops(sheet: IParadisSheetData, viewport: ParadisSpreadsheetViewport): Map<number, number> {
	const tops = new Map<number, number>();
	sheet.rows.forEach((row, index) => tops.set(row.excelRow, viewport.cellBounds(index + VIRTUAL_GRID_HEADER_ROWS, 0).top));
	const last = sheet.rows.at(-1);
	if (last) {
		const bounds = viewport.cellBounds(sheet.rows.length - 1 + VIRTUAL_GRID_HEADER_ROWS, 0);
		tops.set(last.excelRow + 1, bounds.top + bounds.height);
	}
	return tops;
}

/**
 * 選んだ範囲（仮想グリッドの番号）をコピーする文字。DOM の表で範囲を選んでコピーしたときのブラウザの形に合わせ、
 * 行の中のセルはタブ、行の終わりは改行でつなぐ。結合は起点のセルに値があり、覆われたセルは表に td が無いので飛ばす。
 * 幅 0 の隠れた列は空の欄（表と同じ）。見出しの行・列は含めない。画面の外の行も含める（元のデータから作るので、固定枠の複製も混ざらない）。
 */
export function virtualGridCopyText(sheet: IParadisSheetData, range: ParadisSpreadsheetVirtualRange): string {
	const [rowStart, columnStart, rowEnd, columnEnd] = range;
	const dataRowStart = Math.max(rowStart, VIRTUAL_GRID_HEADER_ROWS) - VIRTUAL_GRID_HEADER_ROWS;
	const dataRowEnd = Math.min(sheet.rows.length, rowEnd - VIRTUAL_GRID_HEADER_ROWS);
	const dataColumnStart = Math.max(columnStart, VIRTUAL_GRID_HEADER_COLUMNS) - VIRTUAL_GRID_HEADER_COLUMNS;
	const dataColumnEnd = Math.min(sheet.columnCount, columnEnd - VIRTUAL_GRID_HEADER_COLUMNS);
	// 見出しのセルだけを選んでいるとき（見出しをクリックした後）は何もコピーしない
	if (rowStart < VIRTUAL_GRID_HEADER_ROWS && rowEnd <= VIRTUAL_GRID_HEADER_ROWS || columnStart < VIRTUAL_GRID_HEADER_COLUMNS && columnEnd <= VIRTUAL_GRID_HEADER_COLUMNS) {
		return '';
	}
	if (dataRowStart >= dataRowEnd || dataColumnStart >= dataColumnEnd) {
		return '';
	}
	const lines: string[] = [];
	for (let rowIndex = dataRowStart; rowIndex < dataRowEnd; rowIndex++) {
		const values: string[] = [];
		for (let columnIndex = dataColumnStart; columnIndex < dataColumnEnd; columnIndex++) {
			const cell = sheet.rows[rowIndex].cells[columnIndex];
			if (cell?.hidden) {
				continue;
			}
			// 幅 0 の隠れた列は、表でも文字が描かれないので空の欄になる
			values.push((sheet.columnWidths[columnIndex] ?? 0) > 0 ? cell?.value ?? '' : '');
		}
		lines.push(values.join('\t'));
	}
	return lines.join('\n');
}

/** エディタの大きさが変わったときに仮想グリッドを描き直す（`layout()` の本体）。入れ物が無ければエディタの大きさを使う。 */
export function relayoutVirtualGrid(renderer: ParadisSpreadsheetGridRenderer, host: HTMLElement | undefined, dimension: { readonly width: number; readonly height: number }): Promise<unknown> {
	return renderer.render(virtualGridLayoutFrame(renderer.frame, host?.clientWidth ?? dimension.width, host?.clientHeight ?? dimension.height, renderer.zoomFactor));
}

/**
 * 仮想グリッドの viewport。寸法は倍率を掛ける前のまま持つ（倍率は描画側が中身ごと掛ける）。
 * 先頭の 1 行・1 列は見出しで、シートの固定枠と一緒に固定する。
 */
export function createVirtualGridViewport(sheet: IParadisSheetData, headerHeight: number, revision: string, contentRowHeights: ReadonlyMap<number, number> = new Map()): ParadisSpreadsheetViewport {
	const frozen = resolveFrozenPaneExtent(sheet);
	return new ParadisSpreadsheetViewport({
		rowCount: Math.max(1, sheet.rows.length) + VIRTUAL_GRID_HEADER_ROWS,
		columnCount: Math.max(1, sheet.columnCount) + VIRTUAL_GRID_HEADER_COLUMNS,
		defaultRowHeight: 20,
		defaultColumnWidth: 80,
		// 行の高さは DOM の表と同じく最小の高さとして扱い、中身の文字が収まらなければ伸ばす
		rowMetrics: [{ index: 0, size: headerHeight }, ...sheet.rows.map((row, index) => ({ index: index + VIRTUAL_GRID_HEADER_ROWS, size: Math.max(row.height, contentRowHeights.get(index) ?? 0) }))],
		columnMetrics: [{ index: 0, size: PARADIS_ROW_NUM_COL_WIDTH }, ...sheet.columnWidths.map((width, index) => ({ index: index + VIRTUAL_GRID_HEADER_COLUMNS, size: width, hidden: width <= 0 }))],
		frozenRows: VIRTUAL_GRID_HEADER_ROWS + frozen.rowCount,
		frozenColumns: VIRTUAL_GRID_HEADER_COLUMNS + frozen.colCount,
		maxLiveCells: VIRTUAL_GRID_CELL_THRESHOLD,
		revision,
	});
}

function sameRowHeights(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [row, height] of a) {
		if (Math.abs((b.get(row) ?? -1) - height) > 0.5) {
			return false;
		}
	}
	return true;
}

/** シートごとの、中身の文字が収まる行の高さ（測れたものだけ）。 */
const VIRTUAL_GRID_CONTENT_ROWS = new WeakMap<IParadisSheetData, ReadonlyMap<number, number>>();

/** 折り返しのセルを一度に置いて測る数。 */
const WRAPPED_PROBE_BATCH = 500;

const ROW_PROBE_STYLES = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingBottom', 'paddingTop'] as const;
const WRAPPED_PROBE_STYLES = [...ROW_PROBE_STYLES, 'paddingLeft', 'paddingRight', 'whiteSpace', 'wordBreak'] as const;

/**
 * 中身の文字が収まる行の高さ（データの行の番号 → 高さ）。DOM の表の行は、指定の高さより文字が高ければ伸びる
 * （Excel の既定の 20px の行に 11pt の文字を置くと、表では 1 行がそれより高くなる）。仮想グリッドも同じにするため、
 * 文字の大きさ・書体ごとに 1 行の高さを一度だけ測り、行ごとにその最大を取る。折り返しのあるセルは、同じ幅・同じ文字の
 * 大きさの箱を置いて 1 つずつ測る（どちらも 1 回の配置でまとめて測る）。結合したセルは数えない。
 */
export function measureVirtualGridContentRows(host: HTMLElement, sheet: IParadisSheetData): ReadonlyMap<number, number> | undefined {
	// 画面に出ていない（大きさが無い）ときは測れない。0 のまま伸ばさずに使うと、出た後も低いままになるので、測れなかったと返す
	if (!host.isConnected || host.getClientRects().length === 0) {
		return undefined;
	}
	const doc = host.ownerDocument;
	const box = doc.createElement('div');
	box.style.position = 'absolute';
	box.style.visibility = 'hidden';
	box.style.left = '0';
	box.style.top = '0';
	const probes = new Map<string, HTMLElement>();
	const wrapped: { readonly rowIndex: number; readonly rowSpan: number; readonly element: HTMLElement }[] = [];
	const rowKeys: (readonly string[])[] = sheet.rows.map((row, rowIndex) => {
		const keys = new Set<string>();
		row.cells.forEach((cell, columnIndex) => {
			// 折り返しと縦書きのセルは、同じ幅の箱に置いて 1 つずつ測る（その行が折り返し・縦書きのセルだけでも伸びるように）
			if ((cell.wrapText || cell.verticalText) && !cell.hidden && cell.value) {
				let width = 0;
				for (let offset = 0; offset < (cell.colSpan ?? 1); offset++) {
					width += sheet.columnWidths[columnIndex + offset] ?? 0;
				}
				const element = doc.createElement('div');
				element.className = `paradis-spreadsheet-virtual-cell ${cell.verticalText ? 'paradis-spreadsheet-virtual-cell-vertical' : 'paradis-spreadsheet-virtual-cell-wrap'}`;
				element.style.position = 'static';
				element.style.width = `${width}px`;
				const wrapStyle = cell.style as Record<string, string | undefined>;
				for (const property of WRAPPED_PROBE_STYLES) {
					if (wrapStyle[property]) {
						(element.style as unknown as Record<string, string>)[property] = wrapStyle[property]!;
					}
				}
				element.textContent = cell.value;
				wrapped.push({ rowIndex, rowSpan: cell.rowSpan ?? 1, element });
			}
		});
		for (const cell of row.cells) {
			if (cell.hidden || !cell.value || (cell.rowSpan ?? 1) > 1 || cell.wrapText || cell.verticalText) {
				continue;
			}
			const style = cell.style as Record<string, string | undefined>;
			// 英数字だけの文字は、和文の書体に切り替わらないので 1 行が低い。見本の文字も揃える
			const cjk = /[^\u0000-\u007f]/.test(cell.value);
			const key = `${ROW_PROBE_STYLES.map(property => style[property] ?? '').join('|')}|${cjk ? 'cjk' : 'latin'}`;
			if (!probes.has(key)) {
				const element = doc.createElement('div');
				element.className = 'paradis-spreadsheet-virtual-cell';
				element.style.position = 'static';
				for (const property of ROW_PROBE_STYLES) {
					if (style[property]) {
						(element.style as unknown as Record<string, string>)[property] = style[property]!;
					}
				}
				element.textContent = cjk ? 'Ag\u6f22' : 'Ag';
				box.appendChild(element);
				probes.set(key, element);
			}
			keys.add(key);
		}
		return [...keys];
	});
	const heights = new Map<number, number>();
	if (!probes.size && !wrapped.length) {
		return heights;
	}
	host.appendChild(box);
	const probeHeights = new Map([...probes].map(([key, element]) => [key, element.getBoundingClientRect().height]));
	// 折り返しのセルは数が多いことがあるので、一度に全部を置かずに分けて測る
	const wrappedHeights: (readonly [number, number, number])[] = [];
	for (let start = 0; start < wrapped.length; start += WRAPPED_PROBE_BATCH) {
		const batch = wrapped.slice(start, start + WRAPPED_PROBE_BATCH);
		for (const { element } of batch) {
			box.appendChild(element);
		}
		for (const { rowIndex, rowSpan, element } of batch) {
			wrappedHeights.push([rowIndex, rowSpan, element.getBoundingClientRect().height]);
		}
		for (const { element } of batch) {
			element.remove();
		}
	}
	box.remove();
	rowKeys.forEach((keys, rowIndex) => {
		const height = Math.max(0, ...keys.map(key => probeHeights.get(key) ?? 0));
		if (height > 0) {
			heights.set(rowIndex, height);
		}
	});
	for (const [rowIndex, rowSpan, height] of wrappedHeights) {
		if (rowSpan <= 1) {
			heights.set(rowIndex, Math.max(heights.get(rowIndex) ?? 0, height));
		}
	}
	// 縦に結合した折り返し・縦書きは、結合した行の合計に収まらない分を最後の行に足す（DOM の表の伸び方と同じ）
	for (const [rowIndex, rowSpan, height] of wrappedHeights) {
		if (rowSpan <= 1) {
			continue;
		}
		const last = Math.min(sheet.rows.length - 1, rowIndex + rowSpan - 1);
		let total = 0;
		for (let row = rowIndex; row <= last; row++) {
			total += Math.max(sheet.rows[row].height, heights.get(row) ?? 0);
		}
		if (height > total) {
			heights.set(last, Math.max(sheet.rows[last].height, heights.get(last) ?? 0) + height - total);
		}
	}
	return heights;
}

/**
 * 列記号の行の高さ。DOM の表と同じ見出しのセルを一度だけ置いて測る（文字の大きさと余白は CSS が決める）。
 * 測れない（画面に出ていない）ときは DOM の表の見出しのおおよその高さ。
 */
export function measureVirtualGridHeaderHeight(host: HTMLElement): number {
	const doc = host.ownerDocument;
	const table = doc.createElement('table');
	table.className = 'paradis-spreadsheet-table';
	table.style.position = 'absolute';
	table.style.visibility = 'hidden';
	const th = doc.createElement('th');
	th.className = 'paradis-spreadsheet-colhead';
	th.textContent = 'A';
	table.appendChild(doc.createElement('thead')).appendChild(doc.createElement('tr')).appendChild(th);
	host.appendChild(table);
	const height = table.getBoundingClientRect().height;
	table.remove();
	return height > 0 ? height : 17;
}

/** 仮想グリッドの 1 タイル。見出し・結合の起点・範囲の外からはみ出してくる元のセルも入れる。 */
export function legacyGridTile(sheet: IParadisSheetData, request: ParadisSpreadsheetTileRequest, index: IParadisVirtualGridIndex = createVirtualGridIndex(sheet)): ParadisSpreadsheetGridTile {
	const cells: ParadisSpreadsheetGridCell[] = [];
	const [rowStart, columnStart, rowEnd, columnEnd] = request.range;
	if (rowStart < VIRTUAL_GRID_HEADER_ROWS) {
		if (columnStart < VIRTUAL_GRID_HEADER_COLUMNS) {
			cells.push({ row: 0, column: 0, text: '', header: 'column', classNames: ['paradis-spreadsheet-virtual-corner'] });
		}
		for (let column = Math.max(columnStart, VIRTUAL_GRID_HEADER_COLUMNS); column < columnEnd; column++) {
			// 使用範囲が D 列始まりのシートでは Excel も「D,E,F…」を表示するため、minCol を起点にする（DOM の表と同じ）
			cells.push({ row: 0, column, text: getColumnLabel(sheet.minCol - 1 + column - VIRTUAL_GRID_HEADER_COLUMNS), header: 'column', classNames: ['paradis-spreadsheet-virtual-colhead'] });
		}
	}
	const dataRowStart = Math.max(rowStart, VIRTUAL_GRID_HEADER_ROWS) - VIRTUAL_GRID_HEADER_ROWS;
	const dataRowEnd = Math.min(sheet.rows.length, rowEnd - VIRTUAL_GRID_HEADER_ROWS);
	if (columnStart < VIRTUAL_GRID_HEADER_COLUMNS) {
		for (let rowIndex = dataRowStart; rowIndex < dataRowEnd; rowIndex++) {
			// Excel の行番号は絶対番号（隠れた行があると飛ぶ）。DOM の表と同じ
			cells.push({ row: rowIndex + VIRTUAL_GRID_HEADER_ROWS, column: 0, text: String(sheet.rows[rowIndex].excelRow ?? rowIndex + 1), header: 'row', classNames: ['paradis-spreadsheet-virtual-rowhead'] });
		}
	}
	const dataColumnStart = Math.max(columnStart, VIRTUAL_GRID_HEADER_COLUMNS) - VIRTUAL_GRID_HEADER_COLUMNS;
	const dataColumnEnd = columnEnd - VIRTUAL_GRID_HEADER_COLUMNS;
	// 固定列の枠（left・corner）は固定列の中だけで完結させる
	const columnLimit = request.pane === 'left' || request.pane === 'corner' ? index.frozenColumns : undefined;
	if (dataColumnStart >= dataColumnEnd) {
		return { revision: request.revision, range: request.range, cells };
	}
	const seen = new Set<string>();
	const push = (rowIndex: number, columnIndex: number) => {
		const key = `${rowIndex}:${columnIndex}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		const cell = virtualGridCell(sheet, index, rowIndex, columnIndex, columnLimit);
		if (cell) {
			cells.push(cell);
		}
	};
	for (let rowIndex = dataRowStart; rowIndex < dataRowEnd; rowIndex++) {
		const row = sheet.rows[rowIndex];
		for (let columnIndex = dataColumnStart; columnIndex < dataColumnEnd; columnIndex++) {
			push(rowIndex, columnIndex);
		}
		// 範囲の左右の外から、空いたセルを伝ってはみ出してくる元のセル（最初の空でないセルが元になりうる）
		for (const [from, step] of [[dataColumnStart - 1, -1], [dataColumnEnd, 1]] as const) {
			for (let columnIndex = from; columnIndex >= 0 && columnIndex < Math.min(columnLimit ?? row.cells.length, row.cells.length); columnIndex += step) {
				const cell = row.cells[columnIndex];
				if (cell.hidden || cell.colSpan || cell.rowSpan || cell.value || cell.richText?.some(part => part.text.length > 0)) {
					const toward = overflowToward(cell);
					if (toward !== 'none' && (step < 0 ? toward !== 'left' : toward !== 'right')) {
						push(rowIndex, columnIndex);
					}
					break;
				}
			}
		}
	}
	// 起点が範囲の外にある結合（上や左に外れていても、範囲に掛かっていれば描く）
	for (let row = Math.max(0, dataRowStart - index.maxMergeRows + 1); row < dataRowEnd; row++) {
		for (const merge of index.mergesByRow.get(row) ?? []) {
			if (dataRowStart < merge.row + merge.rowSpan && merge.column < dataColumnEnd && dataColumnStart < merge.column + merge.columnSpan) {
				push(merge.row, merge.column);
			}
		}
	}
	return { revision: request.revision, range: request.range, cells };
}

function commentClassFor(comments: ReadonlyMap<string, IParadisCellComment>, excelRow: number, excelColumn: number): string[] {
	const comment = comments.get(`${excelRow}:${excelColumn}`);
	return comment ? [commentMarkerClass(comment.kind)] : [];
}

/** 印にマウスを乗せたときの簡単な表示。最初の投稿と、返信の数・解決済みだけを出す（本文は変更点パネル）。 */
export function spreadsheetCommentHoverText(comment: IParadisCellComment): string {
	const first = comment.entries[0];
	const body = first ? `${first.author ? `${first.author}: ` : ''}${first.text.length > 300 ? `${first.text.slice(0, 299)}…` : first.text}` : '';
	const replies = comment.entries.length - 1;
	return [
		body,
		replies > 0 ? localize('paradis.spreadsheet.commentReplies', "返信 {0} 件", replies) : '',
		comment.resolved ? localize('paradis.spreadsheet.commentResolved', "解決済み") : '',
	].filter(Boolean).join('\n');
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

/**
 * 固定枠に要る分だけの表の複製を作る。表全体を複製してから落とすのではなく、見出し(colgroup・thead)と
 * 先頭 `rowCount` 行、各行の行番号セルと先頭 `colCount` 列分(結合の colSpan を数える)のセルだけを複製する。
 * 未指定の向きは全部残す。
 */
export function buildFrozenPaneClone(table: HTMLElement, rowCount: number | undefined, colCount: number | undefined): HTMLElement {
	const clone = table.cloneNode(false) as HTMLElement;
	let remainingRows = rowCount ?? Number.POSITIVE_INFINITY;
	for (const child of Array.from(table.childNodes)) {
		if (!dom.isHTMLElement(child) || child.tagName !== 'TBODY') {
			clone.appendChild(child.cloneNode(true));
			continue;
		}
		const body = child.cloneNode(false);
		for (const row of Array.from((child as HTMLTableSectionElement).rows)) {
			if (remainingRows <= 0) {
				break;
			}
			remainingRows--;
			body.appendChild(colCount === undefined ? row.cloneNode(true) : cloneFrozenPaneRow(row, colCount));
		}
		clone.appendChild(body);
	}
	return clone;
}

/** 行番号セル(先頭)と、データ列 `colCount` 本分のセルだけを複製した行。 */
function cloneFrozenPaneRow(row: HTMLTableRowElement, colCount: number): Node {
	const clone = row.cloneNode(false);
	const cells = Array.from(row.children);
	let spanned = 0;
	cells.forEach((cell, index) => {
		if (index === 0) {
			clone.appendChild(cell.cloneNode(true));
			return;
		}
		if (spanned >= colCount) {
			return;
		}
		spanned += Math.max(1, Number((cell as HTMLTableCellElement).colSpan) || 1);
		clone.appendChild(cell.cloneNode(true));
	});
	return clone;
}

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
	private _noteOverlay: HTMLElement | undefined;
	private _pageBreakOverlay: SVGElement | undefined;
	private _pageLabelOverlay: SVGElement | undefined;
	// フォント反映等の再フローで行高が変わると図形/改ページ線の固定Y座標が古くなるため、再測定・再配置トリガを張る。
	private _replaceToken: object = {};
	/**
	 * 重ね要素・帯・固定枠を最後に組んだときの行の位置と表の寸法。ResizeObserver やフォントの読み込みで呼ばれても、
	 * これが同じなら作り直さない(同じ位置に同じものを作り直すだけになる)。表を組み直したら消す。
	 */
	private _placedLayoutKey: string | undefined;

	private _scale = 1;
	private _userAdjusted = false;

	private readonly _headerDisposables = this._register(new DisposableStore());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	/** 読み込み中・表示できないときの面（{@link renderParadisViewerState}）。 */
	private readonly _stateView = this._register(new MutableDisposable<IDisposable>());
	// タブ描画は _renderTabs のたびに DOM とリスナーを作り直すため、入力単位の store ではなく
	// 描画単位の専用 store で管理する(旧タブのリスナー/切り離し済み DOM を都度解放する)。
	private readonly _tabsDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _overlayRaf = this._register(new MutableDisposable());
	private readonly _overlayTriggers = this._register(new MutableDisposable<DisposableStore>());
	private readonly _virtualRenderer = this._register(new MutableDisposable<ParadisSpreadsheetGridRenderer>());
	/** いまの仮想グリッドの viewport と revision（描き直す前に、見ていた位置を取り出すため）。 */
	private _virtualViewport: ParadisSpreadsheetViewport | undefined;
	private _virtualRevision: string | undefined;
	/** 仮想グリッドを画面に出ていないときに作り、行の高さを測れていない。 */
	private _virtualRowsUnmeasured = false;
	private _previousVirtualPosition: { readonly revision: string; readonly anchor: ReturnType<ParadisSpreadsheetViewport['logicalAnchor']>; readonly selection?: ParadisSpreadsheetGridRenderer['selection'] } | undefined;

	/** 仮想グリッドで見ていた位置。同じシートの描き直しでだけ使う。 */
	private get _virtualPosition(): { readonly revision: string; readonly anchor: ReturnType<ParadisSpreadsheetViewport['logicalAnchor']>; readonly selection?: ParadisSpreadsheetGridRenderer['selection'] } | undefined {
		const renderer = this._virtualRenderer.value;
		const viewport = this._virtualViewport;
		return renderer && viewport && this._virtualRevision ? { revision: this._virtualRevision, anchor: viewport.logicalAnchor(renderer.frame), selection: renderer.selection } : undefined;
	}
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
	/**
	 * 表示の見張りと観測。
	 * ブックの解析は共有プロセス側で走るので、あちらが黙ると renderer からは何も起きない。
	 */
	private readonly _probe = this._register(new ParadisOfficeViewerProbe('excel-view', generation => this._onRenderTimeout(generation)));

	// watcher 由来の _load が並行実行され応答が逆順到着しても、最新ロードの結果だけを表示するための世代トークン。
	private _loadGeneration = 0;
	/** 表示は描き終え、意味解析の到達度を待っている間だけ真。 */
	private _semanticPending = false;
	/** 描いた後で読めなかった画像（図形 → シート名）。代替表示に数え、描き直しはまとめて 1 回にする。 */
	private readonly _brokenImages = this._register(new ParadisSpreadsheetBrokenImages(() => {
		const current = this._workbook;
		if (current) {
			this._renderSemanticUi(current, this._currentSpreadsheetViewState());
		}
	}));
	/** 走っている詳しい解析の取り消し。読み直し・閉じる・破棄で取り消す（shared process の待ち行列と worker から外れる）。 */
	private readonly _semanticRequest = this._register(new MutableDisposable<IDisposable>());
	/** 表示用の解析の依頼。次の読み込みと、エディタを閉じたときに取り消す。 */
	private readonly _parseRequest = this._register(new MutableDisposable<IDisposable>());
	private readonly _metafileRequest = this._register(new MutableDisposable<IDisposable>());
	/** ブックを表示しているあいだ、覚えておいた解析結果を手放させない。 */
	private readonly _openCacheLease = this._register(new MutableDisposable());
	/** 開いてから表が描かれるまでの計測（`setInput` で始め、最初に描けたら送る）。 */
	private readonly _openTiming = this._register(new MutableDisposable<IParadisViewerOpenTiming>());
	/** いま開いているブックの大きさ（計測に添える）。 */
	private _openBytes = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHoverService private readonly _hoverService: IHoverService,
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

		const header = createParadisViewerToolbar(this._root, 'paradis-spreadsheet-header', localize('paradis.spreadsheet.toolbar', "スプレッドシートのツールバー"));
		this._diagnosticsEl = dom.append(header.start, $('.paradis-spreadsheet-diagnostics-host'));
		const right = header.end;
		this._inspectorToggle = appendParadisViewerToolbarPanelToggle(right, localize('paradis.spreadsheet.inspector', "変更点"), Codicon.listUnordered);
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

		this._inspectorPanel = dom.append(this._root, $(`.paradis-spreadsheet-inspector-panel.${PARADIS_OFFICE_PANEL_SURFACE_CLASS}.${PARADIS_OFFICE_CHANGE_PANEL_CLASS}`));
		this._inspectorPanel.style.display = 'none';
		this._findWidget.value?.avoidOverlapWith(this._inspectorPanel);

		// ズーム −/%/＋（HTMLビューアと同じUI）。
		const zoom = appendParadisViewerToolbarGroup(right);
		const zoomOutLabel = localize('paradis.spreadsheet.zoomOut', "ズームアウト");
		this._accessibility.labelButton(appendIconButton(zoom, Codicon.zoomOut, zoomOutLabel, this._headerDisposables, () => this._zoom(1 / 1.2)), zoomOutLabel);
		this._percentBtn = appendParadisViewerToolbarPercent(zoom, localize('paradis.spreadsheet.resetZoom', "ズームをリセット"));
		this._accessibility.labelButton(this._percentBtn, localize('paradis.spreadsheet.resetZoom', "ズームをリセット"));
		this._register(dom.addDisposableListener(this._percentBtn, dom.EventType.CLICK, () => this._resetZoom()));
		const zoomInLabel = localize('paradis.spreadsheet.zoomIn', "ズームイン");
		this._accessibility.labelButton(appendIconButton(zoom, Codicon.zoomIn, zoomInLabel, this._headerDisposables, () => this._zoom(1.2)), zoomInLabel);

		// 「既定のアプリで開く」ボタンは resource 依存なので入力ごとに作り直す。
		appendParadisViewerToolbarSeparator(right);
		this._openAppEl = appendParadisViewerToolbarGroup(right, 'paradis-spreadsheet-openapp');

		// bodywrap はスクロールしない位置基準。固定ヘッダー帯(列ラベル/行番号/角)を body(スクローラ)の
		// 兄弟として重ね、body の scroll イベントで transform だけ更新する。
		const bodyWrap = dom.append(this._root, $('.paradis-spreadsheet-bodywrap'));
		this._bodyEl = dom.append(bodyWrap, $('.paradis-spreadsheet-body'));
		this._register(dom.addDisposableListener(this._bodyEl, dom.EventType.MOUSE_OVER, event => this._showCommentHover(event)));
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
		this._register(styleParadisSpreadsheetSheetTabList(this._tabsEl));
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
		// ファイルを読み出している間に、解析の worker を起動して exceljs を読み込ませておく。
		warmSpreadsheetParser(this._sharedProcessService);
		this._runtimeConfiguration = snapshotSpreadsheetRuntimeConfiguration(this._configurationService);
		// 母数は「利用者が1つのブックを開いた」回数。同じブックならタブを往復しても増えない。
		this._probe.beginOpen(resource.toString(), this._diagnosticEngine());
		this._openTiming.value = startParadisViewerOpenTiming('excel');
		this._openBytes = 0;
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
			// 取り消された読み込みは誰も待っていない。見張りを残すと偽の時間切れになる。
			this._probe.disarm();
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
			// 取り消された読み込みは誰も待っていない。見張りを残すと偽の時間切れになる。
			this._probe.disarm();
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
				if (e.contains(resource)) {
					// 変わったファイルの解析結果は使わない（更新時刻と大きさが変わらない書き換えもあるので、etag に頼らない）。
					SPREADSHEET_OPEN_CACHE.delete(resource);
				}
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

	// ── 表示失敗の観測 ────────────────────────────────────────────────────

	/** Sentry へ載せる、いま有効な処理エンジン。設定が読めない間は既定側に倒す。 */
	private _diagnosticEngine(): ParadisOfficeDiagnosticEngine {
		return this._runtimeConfiguration?.engine === 'legacy' || !this._runtimeConfiguration ? 'legacy' : 'v1';
	}

	/**
	 * 予算内に解析・描画が終わらなかった。作り直し→作り直し→エラー表示の決まった順で畳ませる。
	 * **ここでは送らない**（途中経過を送るとレートリミットの枠を使い切る）。送るのは終端だけ。
	 */
	private _onRenderTimeout(generation: number): void {
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		// **走っている解析は止められない**（`parseSpreadsheetResource` に取り消しの口が無い）。
		// 遅れて返った結果がエラー画面を本物の表に描き替えることはあるが、表示としては良い方向
		// なので放置している。Word 2面は消毒を取り消せるので、あちらでは経路を1本に畳んでいる。
		// 大きさは読み出しの時点で分かるので `setBytes` 済み（Excel が固まる原因の第一候補が
		// 大きさなので、失敗イベントには必ず載せる）。
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'renderTimedOut', generation });
		if (transition.effects.length === 0) {
			// 状態機械が受理しなかった時計。原因として記録すると、後で起きる本当の失敗の
			// 理由が `timeout` に置き換わってしまう。
			return;
		}
		this._probe.noteAcceptedTimeout();
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource, this._currentSpreadsheetViewState());
	}

	private _finishRecoveryRender(recoveryGeneration: number, resource: URI, viewState: ParadisSpreadsheetViewState): void {
		this._probe.disarmFor(recoveryGeneration);
		const hasExpectedRoot = this._sheets.length > 0 && (!!this._tableEl || !!this._virtualHostEl);
		if (!hasExpectedRoot) {
			// 白紙も梯子を1周ぶん進める。ここで記録しないと `attempt` の意味が
			// 時間切れ経路とずれる（同じ3周でも 4 と 1 になる）。
			this._probe.note({ cause: 'blank', stage: 'render' });
		}
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'rendered', generation: recoveryGeneration, hasExpectedRoot });
		if (transition.state.phase === 'ready') {
			this._probe.noteSuccess();
			this._notePainted();
		}
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource, viewState);
	}

	/** 開いてから最初に表を描けたところ。DOM を作った次の描画の枠で記録する（表が画面に出る時点に近づける）。 */
	private _notePainted(): void {
		const timing = this._openTiming.value;
		const host = this._bodyEl;
		if (!timing || !host) {
			return;
		}
		const sheet = this._sheets[this._activeSheetIndex];
		const values = {
			safe_size_kb: Math.round(this._openBytes / 1024),
			safe_sheets: this._sheets.length,
			safe_rows: sheet?.rows.length ?? 0,
			safe_columns: sheet?.columnCount ?? 0,
			safe_virtual: !!this._virtualHostEl,
		};
		// 描く前に別のブックへ移った・閉じたときは `_openTiming` が捨てられ、`painted` は何もしない。
		// 読み直し（ファイルの変更）でもう一度ここへ来ても、`painted` は最初の 1 回しか送らない。
		dom.getWindow(host).requestAnimationFrame(() => timing.painted(values));
	}

	private async _load(resource: URI, token: CancellationToken, viewState = this._currentSpreadsheetViewState(), recoveryGeneration = this._recoveryState.generation, preserveCommitted = false): Promise<boolean> {
		const generation = ++this._loadGeneration;
		this._semanticRequest.clear();
		this._metafileRequest.clear();
		// 前の読み込みの解析は取り消す（時間切れのやり直しやファイルの変更で、前の解析の後ろにもう 1 件積まない）。
		const parseRequest = new CancellationTokenSource(token);
		this._parseRequest.value = toDisposable(() => parseRequest.dispose(true));
		// 解析は共有プロセス側で走る。あちらが黙ると renderer では何も起きないので、ここから見張る。
		this._probe.armSource(recoveryGeneration);
		if (!preserveCommitted) {
			this._clearSemanticUi();
			this._renderMessage(PARADIS_VIEWER_LOADING_LABEL, 'loading');
		}
		let workbook: IParadisWorkbookData;
		let content: VSBuffer | undefined;
		try {
			// 表示を先に返す。到達度の診断は描いた後に、同じバイト列で別に頼む（_loadSemanticDiagnostics）。
			// 同じブックを前に解析していて、ファイルが変わっていなければ、覚えた結果を使う。
			workbook = (await openSpreadsheetResource(this._fileService, this._sharedProcessService, resource, SPREADSHEET_OPEN_CACHE, (totalBytes, value) => {
				this._probe.setBytes(totalBytes);
				this._openBytes = totalBytes;
				content = value;
			}, parseRequest.token)).workbook;
		} catch (err) {
			if (generation === this._loadGeneration && !token.isCancellationRequested && isEqual(this._currentResource, resource)) {
				this._probe.disarm();
				const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'sourceUnavailable', generation: recoveryGeneration });
				this._recoveryState = transition.state;
				if (!preserveCommitted || transition.effects.length === 0) {
					// 理由をその場で画面に出す＝利用者はここで失敗を目にする。1件だけ送る。
					// Excel の一時ファイルなど xlsx でないもの・大きすぎるブックは、壊れたブックではないので送らない。
					if (!isParadisSpreadsheetUnreportedError(err)) {
						this._probe.noteAndReport({ cause: 'source', stage: 'source', error: err });
					}
					this._renderMessage(localize('paradis.spreadsheet.error', "スプレッドシートを開けませんでした: {0}", err instanceof Error ? err.message : String(err)), 'error', this._openInAppActions(resource));
				}
			}
			return false;
		}
		// 応答の逆順到着で古い結果が新しい結果を上書きしないよう、最新ロードでなければ破棄する。
		if (generation !== this._loadGeneration || token.isCancellationRequested || !isEqual(this._currentResource, resource)) {
			// 追い越された結果。この世代はもう誰も待っていないので見張りも解く。
			this._probe.disarmFor(recoveryGeneration);
			return false;
		}
		this._workbook = workbook;
		this._openCacheLease.value ??= SPREADSHEET_OPEN_CACHE.acquire();
		this._brokenImages.clear();
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
		// 覚えておいた結果に到達度の診断まで入っていれば、頼み直さない。
		const diagnose = !!this._runtimeConfiguration && isParadisSpreadsheetV1Enabled(this._runtimeConfiguration) && !workbook.semanticDiagnostics?.available;
		this._semanticPending = diagnose;
		this._renderSemanticUi(workbook, viewState);
		this._finishRecoveryRender(recoveryGeneration, resource, viewState);
		if (diagnose && content) {
			void this._loadSemanticDiagnostics(resource, generation, workbook, content, startSpreadsheetFollowUpRequest(this._semanticRequest));
		}
		// EMF・WMF は、表示を描いた後で worker に SVG にしてもらい、届いたら差し替える（それまでは代替表示の箱）。
		if (content && hasPendingSpreadsheetMetafiles(workbook)) {
			void this._loadMetafiles(resource, generation, content, startSpreadsheetFollowUpRequest(this._metafileRequest));
		}
		if (this._committedInput && isEqual(this._committedInput.resource, resource) && this.input === this._committedInput.input) {
			this._committedInput = this._captureCommittedInput(this._committedInput.input, this._committedInput.options);
		}
		return true;
	}

	/**
	 * 表示を描いた後で、意味解析の到達度を取ってリボンだけを描き直す。追い越された・取り消されたら捨てる。
	 * shared process が混み合っていれば（`busy`）、間を空けて頼み直す。
	 */
	private async _loadSemanticDiagnostics(resource: URI, generation: number, workbook: IParadisWorkbookData, content: VSBuffer, token: CancellationToken): Promise<void> {
		let semanticDiagnostics: IParadisSemanticDiagnosticsSummary;
		try {
			semanticDiagnostics = await collectSpreadsheetSemanticDiagnostics(this._sharedProcessService, content, token);
			for (const delay of SEMANTIC_BUSY_RETRY_DELAYS_MS) {
				if (semanticDiagnostics.unavailableReason !== 'busy') {
					break;
				}
				await timeout(delay, token);
				semanticDiagnostics = await collectSpreadsheetSemanticDiagnostics(this._sharedProcessService, content, token);
			}
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				return;
			}
			// IPC を越えた例外は名前も種類も失っている（常に "Error"）。サーバー側と同じく理由のコードにする。
			semanticDiagnostics = unavailableParadisSpreadsheetSemanticDiagnostics('failed');
		}
		// EMF・WMF の差し替えでブックの入れ物は作り直されるので、入れ物ではなく世代で見分け、今のブックに足す。
		const current = this._workbook;
		if (token.isCancellationRequested || generation !== this._loadGeneration || !current || !isEqual(this._currentResource, resource)) {
			return;
		}
		this._semanticPending = false;
		this._workbook = { ...current, semanticDiagnostics };
		if (semanticDiagnostics.available) {
			SPREADSHEET_OPEN_CACHE.update(resource, value => value.content === content ? { ...value, workbook: { ...value.workbook, semanticDiagnostics } } : undefined);
		}
		this._renderSemanticUi(this._workbook, this._currentSpreadsheetViewState());
	}

	/** EMF・WMF を SVG にしてもらい、図形が変わったシートを描き直す。追い越された・取り消されたら捨てる。 */
	private async _loadMetafiles(resource: URI, generation: number, content: VSBuffer, token: CancellationToken): Promise<void> {
		let converted: IParadisSpreadsheetMetafileImages;
		try {
			converted = await convertSpreadsheetMetafiles(this._sharedProcessService, content, token);
			for (const delay of SEMANTIC_BUSY_RETRY_DELAYS_MS) {
				if (converted.unavailableReason !== 'busy') {
					break;
				}
				await timeout(delay, token);
				converted = await convertSpreadsheetMetafiles(this._sharedProcessService, content, token);
			}
		} catch {
			// 変換できなかった EMF・WMF は、代替表示の箱のまま。
			return;
		}
		const current = this._workbook;
		if (token.isCancellationRequested || generation !== this._loadGeneration || !current || !isEqual(this._currentResource, resource)) {
			return;
		}
		const updated = applySpreadsheetMetafiles(current, converted);
		if (!converted.unavailableReason) {
			// 変換し終えたブックを覚える（変換できなかったときは覚えず、次に開いたときに頼み直す）。
			SPREADSHEET_OPEN_CACHE.update(resource, value => value.content === content ? { ...value, workbook: updated } : undefined, estimateParadisWorkbookBytes(updated, content));
		}
		const changed = new Set(updated.sheets.flatMap((sheet, index) => sheet !== current.sheets[index] ? [sheet.name] : []));
		this._workbook = updated;
		this._sheets = updated.sheets;
		if (changed.size === 0) {
			return;
		}
		this._brokenImages.forgetSheets(changed);
		const activeSheet = this._sheets[this._activeSheetIndex];
		if (activeSheet && changed.has(activeSheet.name)) {
			// 図形を描き直すためにシートを作り直す。見ていた位置は保つ。
			const scrollTop = this._bodyEl?.scrollTop ?? 0;
			const scrollLeft = this._bodyEl?.scrollLeft ?? 0;
			this._renderSheet();
			if (this._bodyEl) {
				this._bodyEl.scrollTop = scrollTop;
				this._bodyEl.scrollLeft = scrollLeft;
			}
		}
		this._renderSemanticUi(updated, this._currentSpreadsheetViewState());
	}

	/** 読めなかった画像を覚える（描き直しは後でまとめて 1 回）。別のブックの知らせは捨てる。 */
	private _noteBrokenImage(workbook: IParadisWorkbookData | undefined, sheetName: string, shape: IParadisRenderShape): void {
		// 診断が届くとブックの入れ物は作り直されるが、シートの中身は同じ。中身で見分ける。
		const current = this._workbook;
		if (!workbook || !current || workbook.sheets !== current.sheets) {
			return;
		}
		this._brokenImages.add(shape, sheetName);
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
				const model = createLegacySpreadsheetPrintModel(workbook, basename(this._currentResource ?? URI.file('spreadsheet.xlsx')), this.window.document);
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
		// 代替表示は、描けなかった図形（EMF などの画像・対応していないグラフや形）だけを数える。
		const placeholders = [...spreadsheetUndrawnPlaceholders(workbook.sheets), ...spreadsheetBrokenImagePlaceholders(this._brokenImages.entries)];
		// 表示そのものは互換の投影(exceljs)で作っているので、再現度は常に「近似」と申告する。
		// 意味解析の結果は「ファイルをどこまで読めたか」を伝えるためだけに使い、再現度の主張には
		// 使わない(読めたことと、同じ見た目に描けたことは別の話)。
		const semantic = workbook.semanticDiagnostics;
		const truncated = workbook.sheets.some(sheet => sheet.truncated);
		const coverages: ParadisOfficeRenderCoverage[] = ['approximated', ...placeholders.map(() => 'placeholder' as const)];
		if (truncated) {
			coverages.push('noAnchor');
		}
		if (this._diagnosticsEl) {
			const warnings: { readonly code: string; readonly message: string }[] = [];
			if (truncated) {
				warnings.push({
					code: 'spreadsheet.truncatedRows',
					message: localize('paradis.spreadsheet.truncatedRows', "行数が多いため、先頭部分だけを表示しています。"),
				});
			}
			if (this._semanticPending && !semantic) {
				warnings.push({
					code: 'spreadsheet.semanticPending',
					message: localize('paradis.spreadsheet.semanticPending', "詳しい解析を実行しています…"),
				});
			} else if (semantic?.available === false && semantic.unavailableReason === 'busy') {
				warnings.push({
					code: 'spreadsheet.semanticBusy',
					message: localize('paradis.spreadsheet.semanticBusy', "ほかのファイルの解析が混み合っているため、詳しい解析を見送りました。開き直すと解析します。"),
				});
			} else if (semantic?.available === false) {
				warnings.push({
					code: 'spreadsheet.semanticUnavailable',
					message: localize('paradis.spreadsheet.semanticUnavailable', "このファイルの詳しい解析はできませんでしたが、表示には影響していません。"),
				});
			} else if (semantic && (semantic.unresolvedReferences > 0 || semantic.unknownElements > 0)) {
				warnings.push({
					code: 'spreadsheet.semanticGaps',
					message: localize('paradis.spreadsheet.semanticGaps', "このファイルには、まだ対応していない要素が含まれています。"),
				});
			}
			// 意味解析が最後まで読めたときだけ「解析未完了」を外す（表示の再現度は近似のまま）。
			const outcome = semantic?.available && semantic.terminal ? 'complete' : 'degraded';
			renderSpreadsheetDiagnosticsRibbon(this._diagnosticsEl, { outcome, coverages, warnings });
		}
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		dom.clearNode(this._inspectorPanel);
		const inspector = new ParadisSpreadsheetChangeInspector(this._inspectorPanel, {
			// 見出しの「閉じる」は帯の「変更点」と同じ開け閉めを通し、フォーカスを帯のボタンへ戻す。
			onClose: () => {
				this._inspectorToggle?.click();
				this._inspectorToggle?.focus();
			},
			...(callbacks.search ? { search: callbacks.search.inspect } : {}),
			...(callbacks.print ? { getPrintModel: callbacks.print } : {}),
			onNavigate: target => this._navigateToLogicalLocator(target.locator, target.anchor),
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(viewState);
		inspector.setComparison([], INCOMPLETE_SPREADSHEET_MANIFEST, 'degraded');
		inspector.setPlaceholders(placeholders);
		inspector.setComments(workbook.sheets.flatMap(sheet => (sheet.comments ?? []).map(comment => ({ sheet: sheet.name, comment }))), workbook.sheets.reduce((sum, sheet) => sum + (sheet.commentsOmitted ?? 0), 0));
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
				// DOM の表と同じく、検索で移ったセルは画面の中央に出す
				void this._virtualRenderer.value.revealCell(rowIndex + VIRTUAL_GRID_HEADER_ROWS, columnIndex + VIRTUAL_GRID_HEADER_COLUMNS, true);
				return;
			}
			const rowElement = this._dataRowEls.find(item => item.excelRow === navigation.cell!.row)?.tr as HTMLTableRowElement | undefined;
			const cell = rowElement?.cells[columnIndex + 1];
			cell?.scrollIntoView({ block: 'center', inline: 'center' });
		});
		this._inputDisposables.value?.add(scheduledNavigation);
	}

	private _renderMessage(message: string, kind: ParadisViewerStateKind = 'info', actions: readonly IParadisViewerStateAction[] = []): void {
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
		this._stateView.value = renderParadisViewerState(this._bodyEl, kind, message, actions);
	}

	/** ローカルのファイルなら「既定のアプリで開く」を出す。 */
	private _openInAppActions(resource: URI): IParadisViewerStateAction[] {
		return resource.scheme === Schemas.file
			? [{ label: PARADIS_VIEWER_OPEN_IN_APP_LABEL, run: () => void this._nativeHostService.openExternal(resource.toString(true)) }]
			: [];
	}

	private _renderRecoveryError(resource: URI): void {
		this._probe.disarm();
		// 梯子を使い切った終端。ここが利用者の見る失敗なので、溜めた観測を1件だけ送る。
		// 原因は既に記録済み（白紙も時間切れも観測した場所で1件ずつ積んである）。
		this._probe.reportFailure();
		this._renderMessage(localize('paradis.spreadsheet.blank', "シートの内容を表示できませんでした。"), 'error', [{
			label: PARADIS_VIEWER_RETRY_LABEL,
			run: () => {
				// 再試行は新しい1回。前回送った記録を畳んでおかないと、また失敗しても無言になる。
				this._probe.beginRetry();
				const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'retry' });
				this._recoveryState = transition.state;
				this._applyRecoveryEffects(transition.effects, resource, this._currentSpreadsheetViewState());
			},
		}, ...this._openInAppActions(resource)]);
	}

	private _renderSheet(): void {
		this._stateView.clear();
		if (!this._bodyEl) {
			return;
		}
		// 捨てる前に、仮想グリッドで見ていた位置を取っておく（同じシートの描き直しで戻すため）
		this._previousVirtualPosition = this._virtualPosition;
		this._virtualRenderer.clear();
		this._virtualViewport = undefined;
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
		this._noteOverlay = undefined;
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
		// 寸法は倍率を掛ける前のまま持ち、倍率は描画側が中身ごと掛ける（DOM の表の transform: scale と同じ見え方）。
		// 先頭の 1 行・1 列は見出し（列記号と行番号）で、シートの固定枠と一緒に固定する。
		const revision = `${this._loadGeneration}:${this._activeSheetIndex}:${sheet.name}`;
		// 行の高さはシートごとに一度だけ測って覚える（拡大・縮小で描き直すたびに測り直さない。寸法は倍率を掛ける前のもの）。
		// 画面に出ていなくて測れなかったときは覚えず、出たとき（layout）に描き直して測る
		let contentRows = VIRTUAL_GRID_CONTENT_ROWS.get(sheet);
		if (!contentRows) {
			contentRows = measureVirtualGridContentRows(host, sheet);
			if (contentRows) {
				VIRTUAL_GRID_CONTENT_ROWS.set(sheet, contentRows);
				// 書体の読み込みが終わると文字の高さが変わることがある。終わった後に測り直し、変わっていれば描き直す
				const measured = contentRows;
				const fonts = dom.getWindow(host).document.fonts;
				// 書体の読み込みが済んでいれば、測り直しても同じなので測らない
				void (fonts && fonts.status !== 'loaded' ? fonts.ready : undefined)?.then(() => {
					if (this._virtualHostEl !== host || !host.isConnected) {
						return;
					}
					const again = measureVirtualGridContentRows(host, sheet);
					if (again && !sameRowHeights(measured, again)) {
						VIRTUAL_GRID_CONTENT_ROWS.set(sheet, again);
						this._renderSheet();
					}
				}, () => undefined);
			}
		}
		this._virtualRowsUnmeasured = !contentRows;
		const viewport = createVirtualGridViewport(sheet, measureVirtualGridHeaderHeight(host), revision, contentRows);
		const index = createVirtualGridIndex(sheet);
		// 枠線を出さない設定のシート（DOM の表は grid のクラスを付けない）
		host.classList.toggle('paradis-spreadsheet-virtual-nogrid', sheet.showGridLines === false);
		// Excel の見た目（縦位置など）の CSS はこのクラスの中だけに効く（CSV のビューアも同じグリッドを使う）
		host.classList.add('paradis-spreadsheet-virtual-excel');
		const renderer = new ParadisSpreadsheetGridRenderer(host, viewport, {
			getViewport: async request => legacyGridTile(sheet, request, index),
			fontsReady: dom.getWindow(host).document.fonts.ready,
			zoom: target,
			copyFocusedCell: true,
			copyRange: range => virtualGridCopyText(sheet, range),
		});
		// 行・列の数は、セルの aria の番号と同じく見出しの 1 行・1 列を含める
		applyParadisOfficeGridMetadata(host, localize('paradis.spreadsheet.sheetGrid', "シート「{0}」", sheet.name), Math.max(1, sheet.rows.length) + VIRTUAL_GRID_HEADER_ROWS, Math.max(1, sheet.columnCount) + VIRTUAL_GRID_HEADER_COLUMNS);
		// 打ち切りの知らせは、グリッド（本体いっぱいに広がる）の下に置き、その分だけグリッドを縮める（重なって隠れないように）
		let noticeHeight = 0;
		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "先頭2,000行のみ表示しています。ファイル全体にはさらに行があります。");
			notice.style.position = 'absolute';
			notice.style.left = '0';
			notice.style.right = '0';
			notice.style.bottom = '0';
			noticeHeight = notice.offsetHeight;
			host.style.bottom = `${noticeHeight}px`;
		}
		// 同じシートを描き直す（拡大・縮小、図形の診断など）ときは、見ていた位置を保つ
		const previous = this._previousVirtualPosition;
		this._previousVirtualPosition = undefined;
		const start = previous?.revision === revision ? viewport.remeasure({}, previous.anchor) : { scrollTop: 0, scrollLeft: 0 };
		if (previous?.revision === revision && previous.selection) {
			// 選んでいた範囲とフォーカスしていたセルも保つ
			renderer.setSelection(previous.selection.anchor, previous.selection.focused);
		}
		this._virtualRenderer.value = renderer;
		this._renderVirtualOverlays(sheet, viewport, renderer, host.ownerDocument);
		this._virtualViewport = viewport;
		this._virtualRevision = revision;
		void renderer.render({
			...start,
			width: Math.max(1, this._bodyEl.clientWidth / target),
			height: Math.max(1, (this._bodyEl.clientHeight - noticeHeight) / target),
		});
		if (this._percentBtn) {
			this._percentBtn.textContent = `${Math.round(target * 100)}%`;
		}
	}

	/**
	 * 図形・「表示」のメモ・改ページ線・印刷範囲・ページ番号の透かしを、DOM の表と同じ組み立てで仮想グリッドに重ねる。
	 * 行の位置は viewport から取る（DOM を測らない）。列の位置と見出しの分のずれは DOM の表と同じなので、組み立てはそのまま使える。
	 */
	private _renderVirtualOverlays(sheet: IParadisSheetData, viewport: ParadisSpreadsheetViewport, renderer: ParadisSpreadsheetGridRenderer, doc: Document): void {
		const rowY = virtualGridRowTops(sheet, viewport);
		const foreground: (HTMLElement | SVGElement)[] = [];
		const background: (HTMLElement | SVGElement)[] = [];
		if (sheet.shapes && sheet.shapes.length > 0) {
			const workbook = this._workbook;
			const shapes = buildShapeOverlay(sheet.shapes, rowY, sheet.columnWidths, sheet.minCol, doc, {
				onImageError: shape => this._noteBrokenImage(workbook, sheet.name, shape),
			});
			if (shapes) {
				foreground.push(shapes);
			}
		}
		const notes = sheet.comments ? buildShownNoteOverlay(sheet.comments, rowY, sheet.columnWidths, sheet.minCol, doc) : undefined;
		if (notes) {
			foreground.push(notes);
		}
		const { rowLines, colLines, labels } = describeSheetPageBreaks(sheet);
		const breaks = buildPageBreakOverlay(rowLines, colLines, sheet.printArea, labels, rowY, sheet.columnWidths, sheet.minCol, doc);
		if (breaks.lines) {
			foreground.push(breaks.lines);
		}
		if (breaks.labels) {
			background.push(breaks.labels);
		}
		if (foreground.length || background.length) {
			renderer.addDecorations(background, foreground);
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
		const rowY = new Map<number, number>();
		for (const { excelRow, tr } of this._dataRowEls) {
			rowY.set(excelRow, tr.offsetTop);
		}
		const last = this._dataRowEls[this._dataRowEls.length - 1];
		if (last) {
			rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
		}
		// 行の位置・見出しの列の位置・表の寸法が前回と同じなら、組み直しても同じものができるだけなので何もしない。
		const layoutKey = [
			...Array.from(rowY, ([row, y]) => `${row}:${y}`),
			...this._headCellEls.map(cell => cell.offsetLeft),
			this._tableEl?.offsetWidth ?? 0,
			this._tableEl?.offsetHeight ?? 0,
			this._theadEl?.offsetHeight ?? 0,
		].join(',');
		if (layoutKey === this._placedLayoutKey) {
			return;
		}
		if (this._shapeOverlay) {
			this._shapeOverlay.remove();
			this._shapeOverlay = undefined;
		}
		if (this._noteOverlay) {
			this._noteOverlay.remove();
			this._noteOverlay = undefined;
		}
		if (this._pageBreakOverlay) {
			this._pageBreakOverlay.remove();
			this._pageBreakOverlay = undefined;
		}
		if (this._pageLabelOverlay) {
			this._pageLabelOverlay.remove();
			this._pageLabelOverlay = undefined;
		}
		if (sheet.shapes && sheet.shapes.length > 0) {
			const workbook = this._workbook;
			const overlay = buildShapeOverlay(sheet.shapes, rowY, sheet.columnWidths, sheet.minCol, inner.ownerDocument, {
				onImageError: shape => this._noteBrokenImage(workbook, sheet.name, shape),
			});
			if (overlay) {
				inner.appendChild(overlay);
				this._shapeOverlay = overlay;
			}
		}
		// 「表示」に設定したメモは、図形と同じ層の上に吹き出しとして出す。
		const notes = sheet.comments ? buildShownNoteOverlay(sheet.comments, rowY, sheet.columnWidths, sheet.minCol, inner.ownerDocument) : undefined;
		if (notes) {
			inner.appendChild(notes);
			this._noteOverlay = notes;
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
		this._placedLayoutKey = layoutKey;
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
	 * 固定枠(freeze pane)の重ね要素を組み直す。表から要る行・列だけを複製し、
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
			const clone = buildFrozenPaneClone(table, rowCount, colCount);
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
		this._placedLayoutKey = undefined;
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

	/** メモ・コメントの印にマウスを乗せたら、最初の投稿だけを簡単に出す。 */
	private _showCommentHover(event: MouseEvent): void {
		if (!dom.isHTMLElement(event.target)) {
			return;
		}
		const target = event.target.closest<HTMLElement>('.paradis-spreadsheet-comment-note, .paradis-spreadsheet-comment-thread');
		if (!target || (dom.isHTMLElement(event.relatedTarget) && target.contains(event.relatedTarget))) {
			return;
		}
		const sheet = this._sheets[this._activeSheetIndex];
		if (!sheet?.comments) {
			return;
		}
		// 表のセルは番地を持つ。仮想のグリッドのセルは行と列の位置（aria）から番地を求める。
		let ref = target.dataset.paradisCommentRef;
		if (!ref) {
			// 仮想グリッドの番号は先頭の見出しの分だけずれている
			const rowIndex = Number(target.getAttribute('aria-rowindex')) - 1 - VIRTUAL_GRID_HEADER_ROWS;
			const columnIndex = Number(target.getAttribute('aria-colindex')) - 1 - VIRTUAL_GRID_HEADER_COLUMNS;
			const excelRow = sheet.rows[rowIndex]?.excelRow;
			ref = excelRow !== undefined && columnIndex >= 0 ? `${getColumnLabel(sheet.minCol - 1 + columnIndex)}${excelRow}` : undefined;
		}
		const comment = ref ? sheet.comments.find(candidate => candidate.ref === ref) : undefined;
		if (comment) {
			this._hoverService.showDelayedHover({ target, content: spreadsheetCommentHoverText(comment) }, { groupId: 'paradis-spreadsheet-comment' });
		}
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
			const tab = appendParadisSpreadsheetSheetTab(this._tabsEl!, { label: sheet.name, tabColor: sheet.tabColor, protectedSheet: sheet.protectedSheet }, tabsStore);
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
		this._brokenImages.clear();
		this._parseRequest.clear();
		this._semanticRequest.clear();
		this._metafileRequest.clear();
		this._openCacheLease.clear();
		this._openTiming.clear();
		this._probe.endOpen();
		this._inputGeneration.invalidate();
		this._loadGeneration++;
		this._inputDisposables.clear();
		this._tabsDisposables.clear();
		this._overlayRaf.clear();
		this._overlayTriggers.clear();
		this._virtualRenderer.clear();
		this._virtualViewport = undefined;
		this._previousVirtualPosition = undefined;
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
		this._noteOverlay = undefined;
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
		if (virtualRenderer && this._virtualRowsUnmeasured && this._virtualHostEl?.getClientRects().length) {
			// 画面に出たので、行の高さを測って描き直す（見ていた位置は保つ）
			this._virtualRowsUnmeasured = false;
			this._renderSheet();
		} else if (virtualRenderer) {
			void relayoutVirtualGrid(virtualRenderer, this._virtualHostEl, dimension);
		} else {
			this._applyScale();
		}
	}
}

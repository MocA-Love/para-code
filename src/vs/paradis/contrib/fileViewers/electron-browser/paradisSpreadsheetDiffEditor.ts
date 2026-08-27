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
import { basename, isEqual } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IHoverLifecycleOptions } from '../../../../base/browser/ui/hover/hover.js';
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
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import { IParadisOverflowItem, IParadisPageBreakOverlay, PARADIS_ROW_NUM_COL_WIDTH, appendDiagonalOverlay, applyBaseCellStyle, applyOverflow, buildPageBreakOverlay, buildShapeDiffOverlay, computeOverflowRoom, computeShapeBBox, createOverflowSpan, getColumnLabel, overflowToward, setCellContent } from './paradisSpreadsheetRender.js';
import { IParadisDataValidation, IParadisRenderShape, IParadisWorkbookData } from '../common/paradisSpreadsheet.js';
import type { ParadisOfficeChange, ParadisOfficeChangeCategory, ParadisOfficeChangeValue, ParadisOfficeCompletenessManifest, ParadisOfficePlaceholder, ParadisOfficeRenderCoverage } from '../common/paradisOfficeProtocol.js';
import type { ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { parseSpreadsheetResource } from './paradisSpreadsheetClient.js';
import { ParadisSpreadsheetDiffInput } from './paradisSpreadsheetInput.js';
import { IParadisDiffCell, IParadisDiffDetail, IParadisDiffRow, IParadisDiffSheet, IParadisPageBreakDiff, IParadisShapeDiff, IParadisShapeRender, buildDataValidationDiff, buildDiffSheets, buildPageBreakDiff, buildShapeDiff, getDiffRowIndices } from './paradisSpreadsheetDiff.js';
import { formatDiffDetails } from './paradisSpreadsheetDiffPresentation.js';
import { appendIconButton, appendOpenInAppButton } from './paradisSpreadsheetToolbar.js';
import { mapSpreadsheetLogicalAnchor } from './spreadsheet/paradisSpreadsheetViewport.js';
import { createLegacySpreadsheetPrintModel, createLegacySpreadsheetSearchPage, createParadisSpreadsheetSourceDescriptor, isParadisSpreadsheetV1Enabled, searchLegacySpreadsheetWorkbook, snapshotSpreadsheetRuntimeConfiguration } from './paradisSpreadsheetEditor.js';
import { PARADIS_SPREADSHEET_CHANGE_CATEGORIES, ParadisSpreadsheetChangeInspector, ParadisSpreadsheetOpenGeneration, resolveParadisSpreadsheetNavigation, restoreParadisSpreadsheetViewState, type ParadisSpreadsheetViewState } from './spreadsheet/paradisSpreadsheetChangeInspector.js';
import { renderSpreadsheetDiagnosticsRibbon } from './spreadsheet/paradisSpreadsheetDiagnostics.js';

import './media/paradisSpreadsheet.css';

const $ = dom.$;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const INCOMPLETE_SPREADSHEET_DIFF_MANIFEST: ParadisOfficeCompletenessManifest = Object.freeze({
	expectedParts: 2, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0,
	expectedSemanticUnits: 1, visitedSemanticUnits: 0, terminal: false,
});

/**
 * パース失敗の理由をユーザー向け文言へ整える。暗号化ブックは service 側が判別済みなので、
 * それ以外(zip破損・サイズ超過等)は生メッセージをそのまま見せる。
 */
function describeSpreadsheetParseError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface IDiffLocation {
	readonly sheetIndex: number;
	/** スクロール対象の差分行インデックス。 */
	readonly rowIndex: number;
	/** 図形の変更なら、ハイライト対象の図形と表示側。 */
	readonly shape?: { readonly render: IParadisRenderShape; readonly side: 'original' | 'modified' };
	/** 入力規則の変更なら、セル位置と変更前後の規則。 */
	readonly validation?: IValidationChange;
}

interface IParadisSpreadsheetDiffCommittedInput {
	readonly input: EditorInput;
	readonly options: IEditorOptions | undefined;
	readonly originalResource: URI;
	readonly modifiedResource: URI;
	readonly originalWorkbook: IParadisWorkbookData | undefined;
	readonly modifiedWorkbook: IParadisWorkbookData | undefined;
	readonly diffSheets: IParadisDiffSheet[];
	readonly shapeDiffs: IParadisShapeDiff[];
	readonly pageBreakDiffs: IParadisPageBreakDiff[];
	readonly allDiffLocations: IDiffLocation[];
	readonly validationLocations: IDiffLocation[];
	readonly diffLocations: IDiffLocation[];
	readonly validationFilter: boolean;
	readonly selectedValidation: IValidationChange | undefined;
	readonly activeSheetIndex: number;
	readonly currentDiffIndex: number;
	readonly scale: number;
	readonly userAdjusted: boolean;
	readonly runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	readonly viewState: ParadisSpreadsheetViewState;
}

interface IValidationChange {
	readonly sheetIndex: number;
	readonly sheetName: string;
	readonly rowIndex: number;
	readonly columnIndex: number;
	readonly address: string;
	readonly status: 'added' | 'removed' | 'modified';
	readonly original?: IParadisDataValidation;
	readonly modified?: IParadisDataValidation;
}

/** ペインの自然座標(拡縮(transform:scale)適用前)での行位置測定結果。図形/ハイライトの配置に使う。 */
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

/** Preserves the within-row logical position when aligned rows have different measured heights. */
export function scaleSpreadsheetLogicalOffset(offset: number, sourceSize: number, targetSize: number): number {
	if (!Number.isFinite(offset) || !Number.isFinite(sourceSize) || !Number.isFinite(targetSize) || sourceSize <= 0 || targetSize <= 0) {
		return 0;
	}
	return Math.min(Math.max(0, offset), sourceSize) / sourceSize * targetSize;
}

function legacyChangeValue(value: string | undefined): ParadisOfficeChangeValue {
	return value === undefined ? { kind: 'none' } : { kind: 'scalar', valueType: 'text', value };
}

function legacyDetailCategory(kind: IParadisDiffDetail['kind']): ParadisOfficeChangeCategory {
	if (kind === 'value' || kind === 'richText') {
		return 'content';
	}
	if (kind === 'dataValidation') {
		return 'annotation';
	}
	if (kind.startsWith('object')) {
		return 'object';
	}
	if (kind === 'mergedColumns' || kind === 'mergedRows') {
		return 'structure';
	}
	return 'formatting';
}

function legacyDetailSubject(kind: IParadisDiffDetail['kind']): string {
	if (kind === 'diagonalBorder') {
		return 'cell.diagonalBorder';
	}
	if (kind === 'dataValidation') {
		return 'cell.dataValidation';
	}
	return `cell.${kind}`;
}

export const PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT = 10_000;

export interface IParadisSpreadsheetLegacyChangeSet {
	readonly changes: readonly ParadisOfficeChange[];
	readonly truncated: boolean;
	readonly minimumChangeCount: number;
}

/** Adapts the existing projection diff to the typed Inspector contract without claiming semantic completeness. */
export function adaptLegacySpreadsheetInspectorChangeSet(sheets: readonly IParadisDiffSheet[]): IParadisSpreadsheetLegacyChangeSet {
	const changes: ParadisOfficeChange[] = [];
	let truncated = false;
	const append = (change: ParadisOfficeChange): boolean => {
		if (changes.length >= PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT) {
			truncated = true;
			return false;
		}
		changes.push(change);
		return true;
	};
	for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
		const sheet = sheets[sheetIndex];
		if (sheet.semanticChanges && sheet.semanticChanges.length > 0) {
			for (const change of sheet.semanticChanges) {
				if (!append(change)) {
					break;
				}
			}
			if (truncated) {
				break;
			}
			continue;
		}
		const seen = new Set<string>();
		const appendSide = (rows: IParadisDiffSheet['originalRows'], minColumn: number, side: 'original' | 'modified'): void => {
			for (let rowIndex = 0; rowIndex < rows.length && !truncated; rowIndex++) {
				const row = rows[rowIndex];
				const excelRow = row.excelRow ?? rowIndex + 1;
				for (let columnIndex = 0; columnIndex < row.cells.length && !truncated; columnIndex++) {
					const cell = row.cells[columnIndex];
					if (!cell.diffStatus) {
						continue;
					}
					const address = `${getColumnLabel(minColumn - 1 + columnIndex)}${excelRow}`;
					const locator = `${sheet.name}!${address}`;
					const details = cell.diffDetails?.length
						? cell.diffDetails
						: [{ kind: 'value' as const, original: side === 'original' ? cell.value : undefined, modified: side === 'modified' ? cell.value : undefined }];
					for (const detail of details) {
						const key = `${locator}:${detail.kind}:${detail.property ?? ''}`;
						if (seen.has(key)) {
							continue;
						}
						seen.add(key);
						append({
							id: `legacy-cell:${sheetIndex}:${key}`,
							category: legacyDetailCategory(detail.kind),
							subject: { kind: legacyDetailSubject(detail.kind), locator },
							before: legacyChangeValue(detail.original),
							after: legacyChangeValue(detail.modified),
							certainty: 'degraded',
							sourceParts: [],
							navigableAnchor: `cell:${sheet.name}:${address}`,
						});
					}
				}
			}
		};
		appendSide(sheet.originalRows, sheet.originalMinCol ?? sheet.modifiedMinCol ?? 1, 'original');
		appendSide(sheet.modifiedRows, sheet.modifiedMinCol ?? sheet.originalMinCol ?? 1, 'modified');
		if (truncated) {
			break;
		}
		const shapeDiff = buildShapeDiff(sheet.originalShapes, sheet.modifiedShapes);
		for (let shapeIndex = 0; shapeIndex < shapeDiff.changes.length; shapeIndex++) {
			const shape = shapeDiff.changes[shapeIndex];
			const name = shape.shape.name ?? shape.shape.shapeId ?? `${shape.shape.type}-${shapeIndex + 1}`;
			if (!append({
				id: `legacy-object:${sheetIndex}:${shapeIndex}:${shape.key}`,
				category: 'object',
				subject: { kind: shape.shape.type === 'line' ? 'object.lineGeometry' : 'sheet.objects', locator: `${sheet.name}!object:${name}` },
				before: shape.status === 'added' ? { kind: 'none' } : { kind: 'scalar', valueType: 'text', value: shape.status },
				after: shape.status === 'removed' ? { kind: 'none' } : { kind: 'scalar', valueType: 'text', value: shape.status },
				certainty: 'degraded',
				sourceParts: [],
				navigableAnchor: `sheet:${sheet.name}`,
			})) {
				break;
			}
		}
		if (truncated) {
			break;
		}
	}
	return { changes, truncated, minimumChangeCount: changes.length + (truncated ? 1 : 0) };
}

export function adaptLegacySpreadsheetInspectorChanges(sheets: readonly IParadisDiffSheet[]): readonly ParadisOfficeChange[] {
	return adaptLegacySpreadsheetInspectorChangeSet(sheets).changes;
}

function spreadsheetDiffViewStateFromOptions(value: object | undefined, fallback: ParadisSpreadsheetViewState): ParadisSpreadsheetViewState {
	const nested = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'viewState')
		? (value as { readonly viewState?: unknown }).viewState
		: value;
	return restoreParadisSpreadsheetViewState(nested, fallback);
}

function axisIndexAt(tops: readonly number[], heights: readonly number[], offset: number): number {
	if (tops.length === 0) {
		return 0;
	}
	let low = 0;
	let high = tops.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (tops[middle] + (heights[middle] ?? 0) <= offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return Math.min(low, tops.length - 1);
}

function nearestLogicalRow(rows: readonly IParadisDiffRow[], start: number): number {
	for (let distance = 0; distance < rows.length; distance++) {
		const after = rows[start + distance]?.excelRow;
		if (after !== undefined) {
			return after;
		}
		const before = rows[start - distance]?.excelRow;
		if (before !== undefined) {
			return before;
		}
	}
	return 0;
}

function nearestRowIndex(rows: readonly IParadisDiffRow[], logicalRow: number): number {
	let nearest = 0;
	let distance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index].excelRow;
		if (row === undefined) {
			continue;
		}
		const candidateDistance = Math.abs(row - logicalRow);
		if (candidateDistance < distance) {
			nearest = index;
			distance = candidateDistance;
		}
	}
	return nearest;
}

function widthIndexAt(offsets: readonly number[], offset: number): number {
	let low = 0;
	let high = Math.max(0, offsets.length - 1);
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (offsets[middle + 1] <= offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

export class ParadisSpreadsheetDiffEditor extends EditorPane {

	static readonly ID = PARADIS_SPREADSHEET_DIFF_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _diagnosticsEl: HTMLElement | undefined;
	private _inspectorPanel: HTMLElement | undefined;
	private _inspectorToggle: HTMLButtonElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _navPositionEl: HTMLElement | undefined;
	private _percentBtn: HTMLButtonElement | undefined;
	private _validationFilterBtn: HTMLButtonElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _panesEl: HTMLElement | undefined;
	private _validationInspector: HTMLElement | undefined;
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
	// 通常ビューアと同じく自然幅で表・図形を描画し、ペインごとに transform:scale で一括拡縮する
	// (列幅を事前縮小すると図形の EMU オフセットとズレるため。transform はレイアウトごと拡縮しスクロールも整合)。
	private _columnWidths: readonly number[] = [];
	private _columnOffsets: readonly number[] = [0];
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
	private readonly _changeInspector = this._register(new MutableDisposable<ParadisSpreadsheetChangeInspector>());
	private readonly _findWidget = this._register(new MutableDisposable<ParadisOfficeFindWidget>());
	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _originalWorkbook: IParadisWorkbookData | undefined;
	private _modifiedWorkbook: IParadisWorkbookData | undefined;
	private _diffSheets: IParadisDiffSheet[] = [];
	private _shapeDiffs: IParadisShapeDiff[] = [];
	private _pageBreakDiffs: IParadisPageBreakDiff[] = [];
	private _leftPageBreakOverlay: IParadisPageBreakOverlay | undefined;
	private _rightPageBreakOverlay: IParadisPageBreakOverlay | undefined;
	private _diffLocations: IDiffLocation[] = [];
	private _allDiffLocations: IDiffLocation[] = [];
	private _validationLocations: IDiffLocation[] = [];
	private _validationFilter = false;
	private _selectedValidation: IValidationChange | undefined;
	private _renderedValidationCells: { readonly cell: HTMLElement; readonly button: HTMLButtonElement; readonly address: string }[] = [];
	private _activeSheetIndex = 0;
	// 開いた直後はどの変更にも合っていない(先頭を表示しているだけ)ので -1。Next で先頭、Prev で末尾に入る。
	private _currentDiffIdx = -1;
	// watcher 由来の _load が並行実行され応答が逆順到着しても、最新ロードの結果だけを表示するための世代トークン。
	private _loadGeneration = 0;
	private readonly _inputGeneration = new ParadisSpreadsheetOpenGeneration();
	private _committedInput: IParadisSpreadsheetDiffCommittedInput | undefined;
	private _runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(PARADIS_SPREADSHEET_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-spreadsheet-diff'));
		this._root.style.position = 'relative';
		this._findWidget.value = new ParadisOfficeFindWidget(this._root, {
			onNavigate: result => this._navigateToLogicalLocator(result.locator, result.navigableAnchor),
		});

		const toolbar = dom.append(this._root, $('.paradis-spreadsheet-diff-toolbar'));
		const left = dom.append(toolbar, $('.paradis-spreadsheet-diff-toolbar-left'));
		this._countEl = dom.append(left, $('span.paradis-spreadsheet-diff-count'));
		this._diagnosticsEl = dom.append(left, $('.paradis-spreadsheet-diagnostics-host'));
		// 色の意味(緑=追加/赤=削除/青=変更)をツールバーに常時表示する。Word 差分と同じ語彙・配色。
		const legend = dom.append(left, $('.paradis-spreadsheet-diff-legend'));
		const legendEntries = [
			{ color: '#22c55e', label: localize('paradis.spreadsheet.legendAdded', "追加") },
			{ color: '#ef4444', label: localize('paradis.spreadsheet.legendRemoved', "削除") },
			{ color: '#3b82f6', label: localize('paradis.spreadsheet.legendModified', "変更") },
		];
		for (const entry of legendEntries) {
			const item = dom.append(legend, $('span.paradis-spreadsheet-diff-legend-item'));
			const swatch = dom.append(item, $('span.paradis-spreadsheet-diff-legend-swatch'));
			swatch.style.backgroundColor = entry.color;
			dom.append(item, $('span')).textContent = entry.label;
		}
		const right = dom.append(toolbar, $('.paradis-spreadsheet-diff-toolbar-right'));
		this._inspectorToggle = dom.append(right, $('button.paradis-spreadsheet-validation-filter')) as HTMLButtonElement;
		this._inspectorToggle.type = 'button';
		this._inspectorToggle.textContent = localize('paradis.spreadsheet.inspector', "Inspector");
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

		// 入力規則だけに絞り込み、セルマーカーと詳細ペインを表示する。
		this._validationFilterBtn = dom.append(right, $('button.paradis-spreadsheet-validation-filter')) as HTMLButtonElement;
		this._validationFilterBtn.title = localize('paradis.spreadsheet.validationFilter', "Show Data Validation Changes");
		this._validationFilterBtn.setAttribute('aria-pressed', 'false');
		dom.append(this._validationFilterBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.checklist)}`));
		const validationFilterLabel = dom.append(this._validationFilterBtn, $('span'));
		validationFilterLabel.textContent = localize('paradis.spreadsheet.validation', "Input Rules");
		this._headerDisposables.add(dom.addDisposableListener(this._validationFilterBtn, dom.EventType.CLICK, () => this._setValidationFilter(!this._validationFilter)));

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

		this._inspectorPanel = dom.append(this._root, $('.paradis-spreadsheet-inspector-panel'));
		this._inspectorPanel.style.position = 'absolute';
		this._inspectorPanel.style.top = '38px';
		this._inspectorPanel.style.right = '8px';
		this._inspectorPanel.style.zIndex = '20';
		this._inspectorPanel.style.width = '380px';
		this._inspectorPanel.style.maxHeight = '70%';
		this._inspectorPanel.style.overflow = 'auto';
		this._inspectorPanel.style.background = 'var(--vscode-editorWidget-background)';
		this._inspectorPanel.style.display = 'none';

		this._bodyEl = dom.append(this._root, $('.paradis-spreadsheet-diff-body'));
		this._tabsEl = dom.append(this._root, $('.paradis-spreadsheet-tabs'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const inputGeneration = this._inputGeneration.begin();
		if (this._committedInput && this.input === this._committedInput.input
			&& isEqual(this._originalResource, this._committedInput.originalResource)
			&& isEqual(this._modifiedResource, this._committedInput.modifiedResource)) {
			this._committedInput = this._captureCommittedInput(this._committedInput.input, this._committedInput.options);
		}
		const previous = this._committedInput;
		await super.setInput(input, options, context, token);
		if (!this._inputGeneration.isCurrent(inputGeneration)) {
			return;
		}

		const diffInput = input as ParadisSpreadsheetDiffInput;
		this._runtimeConfiguration = snapshotSpreadsheetRuntimeConfiguration(this._configurationService);
		const fallbackViewState = this._currentSpreadsheetViewState();
		const requestedViewState = spreadsheetDiffViewStateFromOptions(options?.viewState, fallbackViewState);
		this._originalResource = diffInput.originalResource;
		this._modifiedResource = diffInput.modifiedResource;
		this._activeSheetIndex = 0;
		this._currentDiffIdx = -1;
		this._validationFilter = false;
		this._selectedValidation = undefined;
		this._allDiffLocations = [];
		this._validationLocations = [];
		this._diffLocations = [];
		this._updateValidationFilterButton();
		this._userAdjusted = options?.viewState !== undefined;
		this._scale = requestedViewState.zoom;
		this._clearSemanticUi();
		this._configureInputResources(this._originalResource, this._modifiedResource);

		const loaded = await this._load(token, requestedViewState);
		if (!this._inputGeneration.isCurrent(inputGeneration)) {
			return;
		}
		if (!loaded && token.isCancellationRequested && previous) {
			this._originalResource = previous.originalResource;
			this._modifiedResource = previous.modifiedResource;
			this._originalWorkbook = previous.originalWorkbook;
			this._modifiedWorkbook = previous.modifiedWorkbook;
			this._diffSheets = previous.diffSheets;
			this._shapeDiffs = previous.shapeDiffs;
			this._pageBreakDiffs = previous.pageBreakDiffs;
			this._allDiffLocations = previous.allDiffLocations;
			this._validationLocations = previous.validationLocations;
			this._diffLocations = previous.diffLocations;
			this._validationFilter = previous.validationFilter;
			this._selectedValidation = previous.selectedValidation;
			this._activeSheetIndex = previous.activeSheetIndex;
			this._currentDiffIdx = previous.currentDiffIndex;
			this._scale = previous.scale;
			this._userAdjusted = previous.userAdjusted;
			this._runtimeConfiguration = previous.runtimeConfiguration;
			this._configureInputResources(previous.originalResource, previous.modifiedResource);
			await super.setInput(previous.input, previous.options, context, CancellationToken.None);
			if (!this._inputGeneration.isCurrent(inputGeneration)) {
				return;
			}
			this._updateValidationFilterButton();
			this._renderSheet();
			this._renderTabs();
			this._updateNav();
			if (previous.modifiedWorkbook) {
				this._renderSemanticUi(previous.modifiedWorkbook, previous.viewState);
			}
			return;
		}
		if (!loaded && token.isCancellationRequested) {
			this.clearInput();
		} else if (loaded) {
			this._committedInput = this._captureCommittedInput(input, options);
		}
	}

	private _captureCommittedInput(input: EditorInput, options: IEditorOptions | undefined): IParadisSpreadsheetDiffCommittedInput {
		return {
			input,
			options,
			originalResource: this._originalResource!,
			modifiedResource: this._modifiedResource!,
			originalWorkbook: this._originalWorkbook,
			modifiedWorkbook: this._modifiedWorkbook,
			diffSheets: this._diffSheets,
			shapeDiffs: this._shapeDiffs,
			pageBreakDiffs: this._pageBreakDiffs,
			allDiffLocations: this._allDiffLocations,
			validationLocations: this._validationLocations,
			diffLocations: this._diffLocations,
			validationFilter: this._validationFilter,
			selectedValidation: this._selectedValidation,
			activeSheetIndex: this._activeSheetIndex,
			currentDiffIndex: this._currentDiffIdx,
			scale: this._scale,
			userAdjusted: this._userAdjusted,
			runtimeConfiguration: this._runtimeConfiguration,
			viewState: this._currentSpreadsheetViewState(),
		};
	}

	private _currentSpreadsheetViewState(): ParadisSpreadsheetViewState {
		const inspectorState = this._changeInspector.value?.getViewState();
		return {
			zoom: this._scale,
			activeSheet: this._diffSheets[this._activeSheetIndex]?.name ?? inspectorState?.activeSheet ?? 'Sheet1',
			categories: inspectorState?.categories ?? PARADIS_SPREADSHEET_CHANGE_CATEGORIES,
			...(inspectorState?.selectedChangeId ? { selectedChangeId: inspectorState.selectedChangeId } : {}),
		};
	}

	private _clearSemanticUi(): void {
		this._changeInspector.clear();
		this._findWidget.value?.setSearchProvider(undefined, localize('paradis.spreadsheet.diffSearchDisabledOrUnavailable', "Search is disabled or unavailable for this comparison."));
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

	private _renderSemanticUi(modifiedWorkbook: IParadisWorkbookData, restoredViewState?: ParadisSpreadsheetViewState): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration || !isParadisSpreadsheetV1Enabled(configuration)) {
			this._clearSemanticUi();
			return;
		}
		const viewState = restoredViewState ?? this._currentSpreadsheetViewState();
		this._findWidget.value?.setSearchProvider(configuration.searchPrint ? async (query, cursor, token) => {
			if (cursor || token.isCancellationRequested) {
				return Object.freeze({ results: Object.freeze([]), total: 0, capped: false });
			}
			return createLegacySpreadsheetSearchPage(modifiedWorkbook, query.text, query.matchCase);
		} : undefined, configuration.searchPrint
			? localize('paradis.spreadsheet.diffSearchUnavailableAdapter', "Search is unavailable for this compatible comparison adapter.")
			: localize('paradis.spreadsheet.diffSearchDisabled', "Search is disabled by configuration."));
		const legacyChangeSet = adaptLegacySpreadsheetInspectorChangeSet(this._diffSheets);
		const changes = legacyChangeSet.changes;
		const placeholders: ParadisOfficePlaceholder[] = [];
		for (const sheet of modifiedWorkbook.sheets) {
			for (let shapeIndex = 0; shapeIndex < (sheet.shapes?.length ?? 0); shapeIndex++) {
				const shape = sheet.shapes![shapeIndex];
				const name = shape.name ?? shape.shapeId ?? `${shape.type}-${shapeIndex + 1}`;
				placeholders.push({
					nodeId: `${sheet.name}!object:${name}`,
					feature: `drawing.${shape.type}`,
					reason: 'unsupported',
					title: shape.name ?? localize('paradis.spreadsheet.drawingObject', "Drawing Object"),
					detail: localize('paradis.spreadsheet.legacyDrawingDiagnostic', "Rendered through the compatible legacy projection."),
				});
			}
		}
		const coverages: ParadisOfficeRenderCoverage[] = changes.length > 0
			? changes.map(change => change.certainty === 'exact' || change.certainty === 'normalized' ? 'rendered' : 'approximated')
			: ['approximated'];
		coverages.push(...placeholders.map(() => 'placeholder' as const));
		if (this._diffSheets.some(sheet => sheet.truncated)) {
			coverages.push('noAnchor');
		}
		if (this._diagnosticsEl) {
			renderSpreadsheetDiagnosticsRibbon(this._diagnosticsEl, {
				outcome: 'degraded',
				coverages,
				warnings: [{
					code: 'spreadsheet.legacyDiffProjection',
					message: localize('paradis.spreadsheet.legacyDiffProjection', "The typed Inspector uses the compatible spreadsheet comparison while semantic backend results are unavailable."),
				}, ...(legacyChangeSet.truncated ? [{
					code: 'spreadsheet.legacyDiffInspectorLimit',
					message: localize('paradis.spreadsheet.legacyDiffInspectorLimit', "Showing the first {0} changes; at least {1} were detected, so analysis remains incomplete.", changes.length, legacyChangeSet.minimumChangeCount),
				}] : [])],
			});
		}
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		dom.clearNode(this._inspectorPanel);
		const inspector = new ParadisSpreadsheetChangeInspector(this._inspectorPanel, {
			...(configuration.searchPrint ? {
				search: async (query: string) => searchLegacySpreadsheetWorkbook(modifiedWorkbook, query),
				getPrintModel: async () => createLegacySpreadsheetPrintModel(modifiedWorkbook, basename(this._modifiedResource ?? URI.file('spreadsheet.xlsx'))),
			} : {}),
			onNavigate: target => this._navigateToLogicalLocator(target.locator, target.anchor),
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(viewState);
		inspector.setComparison(changes, INCOMPLETE_SPREADSHEET_DIFF_MANIFEST, 'degraded');
		inspector.setPlaceholders(placeholders);
	}

	private _navigateToLogicalLocator(locator: string, anchor?: string): void {
		const navigation = resolveParadisSpreadsheetNavigation(locator, anchor);
		if (!navigation) {
			return;
		}
		const sheetIndex = this._diffSheets.findIndex(sheet => sheet.name === navigation.sheetName);
		if (sheetIndex < 0) {
			return;
		}
		if (sheetIndex !== this._activeSheetIndex) {
			this._activeSheetIndex = sheetIndex;
			this._renderSheet();
			this._renderTabs();
		}
		this._changeInspector.value?.setActiveSheet(navigation.sheetName);

		let location: IDiffLocation | undefined;
		if (navigation.cell) {
			const sheet = this._diffSheets[sheetIndex];
			const rows = sheet.modifiedRows.some(row => row.excelRow !== undefined) ? sheet.modifiedRows : sheet.originalRows;
			if (rows.length > 0) {
				location = { sheetIndex, rowIndex: nearestRowIndex(rows, navigation.cell.row) };
			}
		} else if (navigation.objectName) {
			location = this._allDiffLocations.find(candidate => candidate.sheetIndex === sheetIndex && candidate.shape
				&& (candidate.shape.render.name === navigation.objectName || candidate.shape.render.shapeId === navigation.objectName));
		}
		if (!location) {
			return;
		}
		this._scrollToRow(location.rowIndex);
		this._navigateRaf.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => this._highlightLocation(location!));
	}

	private _configureInputResources(original: URI, modified: URI): void {
		const store = new DisposableStore();
		this._inputDisposables.value = store;
		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			appendOpenInAppButton(this._openAppEl, modified, this._nativeHostService, store);
		}
		if (modified.scheme === Schemas.file || modified.scheme === Schemas.vscodeRemote) {
			try {
				const watcher = this._fileService.createWatcher(modified, { recursive: false, excludes: [] });
				store.add(watcher);
				store.add(watcher.onDidChange(e => {
					if (isEqual(this._originalResource, original) && isEqual(this._modifiedResource, modified) && e.contains(modified)) {
						void this._load(CancellationToken.None);
					}
				}));
			} catch {
				// watcher 生成失敗は致命的ではない。
			}
		}
	}

	private async _load(token: CancellationToken, viewState = this._currentSpreadsheetViewState()): Promise<boolean> {
		const original = this._originalResource;
		const modified = this._modifiedResource;
		if (!original || !modified) {
			return false;
		}
		const generation = ++this._loadGeneration;
		const previousValidation = this._selectedValidation;
		this._clearSemanticUi();
		this._renderMessage(localize('paradis.spreadsheet.loadingDiff', "Loading diff..."));
		try {
			// パース失敗(暗号化・破損・サイズ超過・git参照消失)を空ブックとして握りつぶすと、
			// 「全行追加/削除/変更なし」という静かな誤差分になってしまう。失敗した側と理由を
			// 明示して差分の表示自体を止める(Word 差分と同じ挙動)。
			const loadSide = async (resource: URI): Promise<{ wb: IParadisWorkbookData; error?: unknown }> => {
				try {
					return { wb: await parseSpreadsheetResource(this._fileService, this._sharedProcessService, resource) };
				} catch (error) {
					return { wb: { sheets: [] }, error };
				}
			};
			const [origResult, modResult] = await Promise.all([loadSide(original), loadSide(modified)]);
			// 応答の逆順到着で古い結果が新しい結果を上書きしないよう、最新ロードでなければ破棄する。
			if (generation !== this._loadGeneration || token.isCancellationRequested || !isEqual(this._modifiedResource, modified)) {
				return false;
			}
			if (origResult.error || modResult.error) {
				// 失敗時は入力規則フィルタの見た目も落とす(エラー画面で active+disabled の
				// 不整合を出さない。次回成功ロード時にユーザーが付け直せる)。
				this._validationFilter = false;
				const reasons: string[] = [];
				if (origResult.error) {
					reasons.push(localize('paradis.spreadsheet.originalSideFailed', "旧版: {0}", describeSpreadsheetParseError(origResult.error)));
				}
				if (modResult.error) {
					reasons.push(localize('paradis.spreadsheet.modifiedSideFailed', "新版: {0}", describeSpreadsheetParseError(modResult.error)));
				}
				this._renderMessage(localize('paradis.spreadsheet.diffLoadFailed', "差分を表示できません。{0}", reasons.join(' / ')));
				return false;
			}
			const origWb = origResult.wb;
			const modWb = modResult.wb;
			this._originalWorkbook = origWb;
			this._modifiedWorkbook = modWb;
			this._diffSheets = buildDiffSheets(origWb.sheets, modWb.sheets);
			this._shapeDiffs = this._diffSheets.map(s => buildShapeDiff(s.originalShapes, s.modifiedShapes));
			// 改ページは差分シート(行の対応付け済み)ではなく、元のシートの用紙設定から比べる。
			const origByName = new Map(origWb.sheets.map(s => [s.name, s]));
			const modByName = new Map(modWb.sheets.map(s => [s.name, s]));
			this._pageBreakDiffs = this._diffSheets.map(s => buildPageBreakDiff(origByName.get(s.name), modByName.get(s.name)));
			this._allDiffLocations = this._diffSheets.flatMap((sheet, sheetIndex) => this._buildSheetLocations(sheet, sheetIndex));
			this._validationLocations = this._diffSheets.flatMap((sheet, sheetIndex) => this._buildValidationLocations(sheet, sheetIndex));
			let restoredLocation: IDiffLocation | undefined;
			if (this._validationFilter && this._validationLocations.length > 0) {
				this._diffLocations = this._validationLocations;
				const selectedLocation = this._validationLocations.find(location => {
					const validation = location.validation;
					return validation !== undefined
						&& previousValidation !== undefined
						&& validation.sheetName === previousValidation.sheetName
						&& validation.address === previousValidation.address;
				}) ?? this._validationLocations.find(location => location.sheetIndex === this._activeSheetIndex)
					?? this._validationLocations[0];
				this._selectedValidation = selectedLocation.validation;
				this._currentDiffIdx = this._validationLocations.indexOf(selectedLocation);
				this._activeSheetIndex = selectedLocation.sheetIndex;
				restoredLocation = selectedLocation;
			} else {
				this._validationFilter = false;
				this._selectedValidation = undefined;
				this._diffLocations = this._allDiffLocations;
				this._currentDiffIdx = -1;
			}
			const restoredSheet = this._diffSheets.findIndex(sheet => sheet.name === viewState.activeSheet);
			if (restoredSheet >= 0) {
				this._activeSheetIndex = restoredSheet;
			} else if (this._activeSheetIndex >= this._diffSheets.length) {
				this._activeSheetIndex = 0;
			}
			this._updateValidationFilterButton();
			this._renderSheet();
			this._renderTabs();
			this._updateNav();
			if (restoredLocation) {
				this._scrollToRow(restoredLocation.rowIndex);
				this._navigateRaf.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => this._highlightLocation(restoredLocation!));
			}
			this._renderSemanticUi(modWb, viewState);
			if (this._committedInput && isEqual(this._committedInput.originalResource, original)
				&& isEqual(this._committedInput.modifiedResource, modified) && this.input === this._committedInput.input) {
				this._committedInput = this._captureCommittedInput(this._committedInput.input, this._committedInput.options);
			}
			return true;
		} catch (err) {
			if (!token.isCancellationRequested) {
				this._renderMessage(localize('paradis.spreadsheet.errorDiff', "Failed to open spreadsheet diff: {0}", err instanceof Error ? err.message : String(err)));
			}
			return false;
		}
	}

	/** excelRow → アライメント後の行インデックス。行挿入/削除で片側だけがゴーストになりうるため、
	 * 呼び出し側は変更が属する側(original/modified)のマップを選んで引く。 */
	private _buildRowIndexByExcel(rows: IParadisDiffSheet['originalRows']): Map<number, number> {
		const map = new Map<number, number>();
		rows.forEach((row, index) => {
			if (row.excelRow !== undefined && !map.has(row.excelRow)) {
				map.set(row.excelRow, index);
			}
		});
		return map;
	}

	/** 1シート分の変更位置(セル行 + 図形)を行位置順にまとめて返す。 */
	private _buildSheetLocations(sheet: IParadisDiffSheet, sheetIndex: number): IDiffLocation[] {
		const locs: IDiffLocation[] = [];
		for (const rowIndex of getDiffRowIndices(sheet)) {
			locs.push({ sheetIndex, rowIndex });
		}
		const maxRows = Math.max(sheet.originalRows.length, sheet.modifiedRows.length);
		// anchorRow は change.side 側の Excel 行番号。行アライメントで挿入/削除があると
		// original/modified で同じアライメント位置が別の Excel 行を指すため、他方優先のマップ
		// 1つに寄せるとナビ先が本来の行からズレる。side ごとに別マップを引く。
		const rowIndexByExcelOriginal = this._buildRowIndexByExcel(sheet.originalRows);
		const rowIndexByExcelModified = this._buildRowIndexByExcel(sheet.modifiedRows);
		const resolveRowIndex = (change: { readonly anchorRow: number; readonly side: 'original' | 'modified' }): number => {
			const byExcel = change.side === 'original' ? rowIndexByExcelOriginal : rowIndexByExcelModified;
			return byExcel.get(change.anchorRow) ?? Math.max(0, Math.min(change.anchorRow - 1, maxRows - 1));
		};
		for (const change of this._shapeDiffs[sheetIndex].changes) {
			const rowIndex = resolveRowIndex(change);
			locs.push({ sheetIndex, rowIndex, shape: { render: change.shape, side: change.side } });
		}
		// 改ページの変更も Prev/Next の対象にする(該当行へスクロールすると、色分けした線が見える)。
		for (const change of this._pageBreakDiffs[sheetIndex]?.changes ?? []) {
			const rowIndex = resolveRowIndex(change);
			locs.push({ sheetIndex, rowIndex });
		}
		locs.sort((a, b) => a.rowIndex - b.rowIndex);
		return locs;
	}

	/** 入力規則が変わったセルを、セル単位のナビゲーション位置として返す。 */
	private _buildValidationLocations(sheet: IParadisDiffSheet, sheetIndex: number): IDiffLocation[] {
		const locations: IDiffLocation[] = [];
		const minColumn = sheet.modifiedMinCol ?? sheet.originalMinCol ?? 1;
		const buildRowPositions = (rows: IParadisDiffSheet['originalRows']) =>
			rows.flatMap((row, index) => row.excelRow === undefined ? [] : [{ excelRow: row.excelRow, index }]);
		const modifiedRowPositions = buildRowPositions(sheet.modifiedRows);
		const originalRowPositions = buildRowPositions(sheet.originalRows);
		const nearestRowIndex = (rowPositions: readonly { readonly excelRow: number; readonly index: number }[], excelRow: number): number => {
			if (rowPositions.length === 0) {
				return 0;
			}
			let low = 0;
			let high = rowPositions.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				if (rowPositions[middle].excelRow < excelRow) {
					low = middle + 1;
				} else {
					high = middle;
				}
			}
			const after = rowPositions[Math.min(low, rowPositions.length - 1)];
			const before = rowPositions[Math.max(0, low - 1)];
			return Math.abs(before.excelRow - excelRow) <= Math.abs(after.excelRow - excelRow) ? before.index : after.index;
		};
		for (const change of buildDataValidationDiff(sheet.originalDataValidations, sheet.modifiedDataValidations)) {
			// change.range は modified 優先(無ければ original)なので(buildDataValidationDiff参照)、
			// 行位置も同じ側から探す。'removed' は original にしか行が無い。
			const preferred = change.status === 'removed' ? originalRowPositions : modifiedRowPositions;
			const fallback = change.status === 'removed' ? modifiedRowPositions : originalRowPositions;
			const rowIndex = nearestRowIndex(preferred.length > 0 ? preferred : fallback, change.range.minR);
			const validation: IValidationChange = {
				sheetIndex,
				sheetName: sheet.name,
				rowIndex,
				columnIndex: change.range.minC - minColumn,
				address: change.address,
				status: change.status,
				...(change.original ? { original: change.original } : {}),
				...(change.modified ? { modified: change.modified } : {}),
			};
			locations.push({ sheetIndex, rowIndex, validation });
		}
		return locations;
	}

	private _updateValidationFilterButton(): void {
		if (!this._validationFilterBtn) {
			return;
		}
		this._validationFilterBtn.classList.toggle('active', this._validationFilter);
		this._validationFilterBtn.setAttribute('aria-pressed', String(this._validationFilter));
		this._validationFilterBtn.disabled = this._validationLocations.length === 0;
	}

	private _setValidationFilter(enabled: boolean): void {
		if (enabled && this._validationLocations.length === 0) {
			return;
		}
		if (enabled) {
			const first = this._validationLocations[0]?.validation;
			if (first) {
				this._selectValidationChange(first);
			}
			return;
		}
		this._validationFilter = enabled;
		this._diffLocations = this._allDiffLocations;
		this._currentDiffIdx = -1;
		this._selectedValidation = undefined;
		this._updateValidationFilterButton();
		this._renderSheet();
		this._renderTabs();
		this._updateNav();
	}

	private _selectValidationChange(change: IValidationChange, focusInspector = false): void {
		const needsRender = !this._validationFilter || change.sheetIndex !== this._activeSheetIndex;
		this._validationFilter = true;
		this._diffLocations = this._validationLocations;
		this._activeSheetIndex = change.sheetIndex;
		this._selectedValidation = change;
		this._currentDiffIdx = this._diffLocations.findIndex(location => location.validation === change);
		this._updateValidationFilterButton();
		if (needsRender) {
			this._renderSheet();
			this._renderTabs();
		} else {
			this._updateValidationSelection();
			this._renderValidationInspector(change);
		}
		this._updateNav();
		this._scrollToRow(change.rowIndex);
		this._navigateRaf.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => {
			this._highlightLocation({ sheetIndex: change.sheetIndex, rowIndex: change.rowIndex, validation: change });
			if (focusInspector) {
				this._validationInspector?.focus();
			}
		});
	}

	private _updateValidationSelection(): void {
		for (const rendered of this._renderedValidationCells) {
			const selected = rendered.address === this._selectedValidation?.address;
			rendered.cell.classList.toggle('selected', selected);
			rendered.button.setAttribute('aria-pressed', String(selected));
		}
	}

	private _validationTypeLabel(type: IParadisDataValidation['type'] | undefined): string {
		switch (type) {
			case 'any': return localize('paradis.spreadsheet.validation.any', "Any Value");
			case 'list': return localize('paradis.spreadsheet.validation.list', "List");
			case 'whole': return localize('paradis.spreadsheet.validation.whole', "Whole Number");
			case 'decimal': return localize('paradis.spreadsheet.validation.decimal', "Decimal");
			case 'date': return localize('paradis.spreadsheet.validation.date', "Date");
			case 'time': return localize('paradis.spreadsheet.validation.time', "Time");
			case 'textLength': return localize('paradis.spreadsheet.validation.textLength', "Text Length");
			case 'custom': return localize('paradis.spreadsheet.validation.custom', "Custom Formula");
			case undefined: return localize('paradis.spreadsheet.validation.unset', "Not Set");
		}
	}

	private _validationOperatorLabel(operator: IParadisDataValidation['operator'] | undefined): string {
		switch (operator) {
			case 'between': return localize('paradis.spreadsheet.validation.between', "Between");
			case 'notBetween': return localize('paradis.spreadsheet.validation.notBetween', "Not Between");
			case 'equal': return localize('paradis.spreadsheet.validation.equal', "Equal To");
			case 'notEqual': return localize('paradis.spreadsheet.validation.notEqual', "Not Equal To");
			case 'greaterThan': return localize('paradis.spreadsheet.validation.greaterThan', "Greater Than");
			case 'lessThan': return localize('paradis.spreadsheet.validation.lessThan', "Less Than");
			case 'greaterThanOrEqual': return localize('paradis.spreadsheet.validation.greaterThanOrEqual', "Greater Than or Equal To");
			case 'lessThanOrEqual': return localize('paradis.spreadsheet.validation.lessThanOrEqual', "Less Than or Equal To");
			case undefined: return localize('paradis.spreadsheet.validation.unset', "Not Set");
		}
	}

	private _validationBooleanLabel(value: boolean | undefined): string {
		return value === undefined
			? localize('paradis.spreadsheet.validation.unset', "Not Set")
			: value
				? localize('paradis.spreadsheet.validation.yes', "Yes")
				: localize('paradis.spreadsheet.validation.no', "No");
	}

	private _validationStatusLabel(status: IValidationChange['status']): string {
		return status === 'added'
			? localize('paradis.spreadsheet.validationAdded', "Added")
			: status === 'removed'
				? localize('paradis.spreadsheet.validationRemoved', "Removed")
				: localize('paradis.spreadsheet.validationModified', "Modified");
	}

	private _renderValidationInspector(change: IValidationChange | undefined): void {
		const inspector = this._validationInspector;
		if (!inspector) {
			return;
		}
		dom.clearNode(inspector);
		const header = dom.append(inspector, $('.paradis-spreadsheet-validation-inspector-header'));
		dom.append(header, $(`span${ThemeIcon.asCSSSelector(Codicon.checklist)}`));
		const headerLabel = dom.append(header, $('span'));
		headerLabel.textContent = localize('paradis.spreadsheet.validationChanges', "Input Rule Changes");
		if (!change) {
			const empty = dom.append(inspector, $('.paradis-spreadsheet-validation-empty'));
			empty.textContent = localize('paradis.spreadsheet.validationSelect', "Select a cell to inspect its input rule change.");
			return;
		}

		const content = dom.append(inspector, $('.paradis-spreadsheet-validation-inspector-content'));
		const heading = dom.append(content, $('.paradis-spreadsheet-validation-heading'));
		const address = dom.append(heading, $('strong'));
		address.textContent = change.address;
		const status = dom.append(heading, $(`span.paradis-spreadsheet-validation-status.${change.status}`));
		status.textContent = this._validationStatusLabel(change.status);

		const original = change.original;
		const modified = change.modified;
		const type = dom.append(content, $('.paradis-spreadsheet-validation-type'));
		type.textContent = this._validationTypeLabel(modified?.type ?? original?.type);

		const appendField = (label: string, before: string, after: string): void => {
			if (before === after) {
				return;
			}
			const field = dom.append(content, $('.paradis-spreadsheet-validation-field'));
			const fieldLabel = dom.append(field, $('.paradis-spreadsheet-validation-field-label'));
			fieldLabel.textContent = label;
			const beforeEl = dom.append(field, $('.paradis-spreadsheet-validation-value.before'));
			beforeEl.textContent = before;
			const arrow = dom.append(field, $('.paradis-spreadsheet-validation-arrow'));
			arrow.textContent = '↓';
			const afterEl = dom.append(field, $('.paradis-spreadsheet-validation-value.after'));
			afterEl.textContent = after;
		};
		const unset = localize('paradis.spreadsheet.validation.unset', "Not Set");
		appendField(localize('paradis.spreadsheet.validation.type', "Rule Type"), this._validationTypeLabel(original?.type), this._validationTypeLabel(modified?.type));
		appendField(localize('paradis.spreadsheet.validation.operator', "Condition"), this._validationOperatorLabel(original?.operator), this._validationOperatorLabel(modified?.operator));
		appendField(localize('paradis.spreadsheet.validation.formulae', "Values or Formula"), original ? original.formulae.join(', ') : unset, modified ? modified.formulae.join(', ') : unset);
		appendField(localize('paradis.spreadsheet.validation.allowBlank', "Allow Blank"), this._validationBooleanLabel(original?.allowBlank), this._validationBooleanLabel(modified?.allowBlank));
		appendField(localize('paradis.spreadsheet.validation.showInputMessage', "Show Input Message"), this._validationBooleanLabel(original?.showInputMessage), this._validationBooleanLabel(modified?.showInputMessage));
		appendField(localize('paradis.spreadsheet.validation.inputTitle', "Input Message Title"), original?.promptTitle ?? unset, modified?.promptTitle ?? unset);
		appendField(localize('paradis.spreadsheet.validation.inputMessage', "Input Message"), original?.prompt ?? unset, modified?.prompt ?? unset);
		appendField(localize('paradis.spreadsheet.validation.showErrorMessage', "Show Error Alert"), this._validationBooleanLabel(original?.showErrorMessage), this._validationBooleanLabel(modified?.showErrorMessage));
		appendField(localize('paradis.spreadsheet.validation.errorStyle', "Error Style"), original?.errorStyle ?? unset, modified?.errorStyle ?? unset);
		appendField(localize('paradis.spreadsheet.validation.errorTitle', "Error Title"), original?.errorTitle ?? unset, modified?.errorTitle ?? unset);
		appendField(localize('paradis.spreadsheet.validation.errorMessage', "Error Message"), original?.error ?? unset, modified?.error ?? unset);
	}

	private _renderMessage(message: string): void {
		if (!this._bodyEl) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(this._bodyEl);
		// メッセージ(Loading/失敗)表示中に旧い差分へタブやPrev/Nextで干渉できると、
		// パース失敗後に古い結果が再描画されて「静かな誤差分」になる。状態もここで
		// まるごと落とし、通常ビューアと同じくメッセージだけの画面にする。
		this._diffSheets = [];
		this._shapeDiffs = [];
		this._pageBreakDiffs = [];
		this._leftPageBreakOverlay = undefined;
		this._rightPageBreakOverlay = undefined;
		this._allDiffLocations = [];
		this._validationLocations = [];
		this._diffLocations = [];
		this._selectedValidation = undefined;
		this._currentDiffIdx = -1;
		this._activeSheetIndex = 0;
		this._updateValidationFilterButton();
		this._updateNav();
		this._renderTabs();
		this._renderedValidationCells = [];
		this._panesEl = undefined;
		this._validationInspector = undefined;
		const msg = dom.append(this._bodyEl, $('.paradis-spreadsheet-message'));
		msg.textContent = message;
	}

	private _renderSheet(): void {
		if (!this._bodyEl) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(this._bodyEl);
		this._renderedValidationCells = [];

		const sheet = this._diffSheets[this._activeSheetIndex];
		if (!sheet) {
			this._renderMessage(localize('paradis.spreadsheet.noChanges', "No changes found"));
			return;
		}

		// 自然幅で描画し、フィット/ズームは transform:scale で一括拡縮する。
		this._columnWidths = sheet.columnWidths;
		this._columnOffsets = sheet.columnWidths.reduce<number[]>((offsets, width) => {
			offsets.push(offsets[offsets.length - 1] + width);
			return offsets;
		}, [0]);
		this._naturalTableWidth = PARADIS_ROW_NUM_COL_WIDTH + sheet.columnWidths.reduce((s, w) => s + w, 0);
		this._bodyEl.classList.toggle('validation-filter', this._validationFilter);
		// main(横並び: ペイン+入力規則インスペクタ)の下に打ち切り通知帯を置くための縦積みラッパ。
		const main = dom.append(this._bodyEl, $('.paradis-spreadsheet-diff-main'));
		this._panesEl = dom.append(main, $('.paradis-spreadsheet-diff-panes'));
		const validationByCell = new Map<string, IValidationChange>();
		for (const location of this._validationLocations) {
			if (location.sheetIndex === this._activeSheetIndex && location.validation) {
				validationByCell.set(`${location.validation.rowIndex}:${location.validation.columnIndex}`, location.validation);
			}
		}

		// 左右ペインとも diff シート側で minCol 揃え済み(originalMinCol === modifiedMinCol)。
		const paneMinCol = sheet.originalMinCol ?? sheet.modifiedMinCol ?? 1;
		const left = this._buildDiffPane(sheet.originalRows, localize('paradis.spreadsheet.original', "Original"), 'original', validationByCell, paneMinCol);
		this._leftScroll = left.pane;
		this._leftContent = left.content;
		this._leftSizer = left.sizer;
		this._leftRows = left.rows;
		this._leftRowMeta = left.rowMeta;
		this._leftTable = left.table;
		this._leftHighlight = left.highlight;
		dom.append(this._panesEl, left.pane);
		dom.append(this._panesEl, $('.paradis-spreadsheet-diff-separator'));
		const right = this._buildDiffPane(sheet.modifiedRows, localize('paradis.spreadsheet.modified', "Modified (Working Copy)"), 'modified', validationByCell, paneMinCol);
		this._rightScroll = right.pane;
		this._rightContent = right.content;
		this._rightSizer = right.sizer;
		this._rightRows = right.rows;
		this._rightRowMeta = right.rowMeta;
		this._rightTable = right.table;
		this._rightHighlight = right.highlight;
		dom.append(this._panesEl, right.pane);
		if (this._validationFilter) {
			this._validationInspector = dom.append(main, $('.paradis-spreadsheet-validation-inspector'));
			this._validationInspector.tabIndex = -1;
			this._validationInspector.setAttribute('role', 'region');
			this._validationInspector.setAttribute('aria-label', localize('paradis.spreadsheet.validationChanges', "Input Rule Changes"));
			this._validationInspector.setAttribute('aria-live', 'polite');
			this._renderValidationInspector(this._selectedValidation);
		} else {
			this._validationInspector = undefined;
		}
		// どちらかの版が MAX_ROWS で打ち切られている場合は通知する。通常ビューアと同じ帯。
		if (sheet.truncated) {
			const notice = dom.append(this._bodyEl, $('.paradis-spreadsheet-truncated'));
			notice.textContent = localize('paradis.spreadsheet.truncated', "Showing first 2,000 rows. The full file contains more rows.");
		}

		this._wireSyncScroll(this._leftScroll, this._rightScroll, 'original');
		this._wireSyncScroll(this._rightScroll, this._leftScroll, 'modified');

		// レイアウト確定後に、はみ出し反映 → 測定 → 図形/ハイライト配置 → 拡縮(transform:scale)を行う。
		// さらにフォント反映等の再フローで行高が変わっても位置が古くならないよう再配置トリガも張る。
		this._renderDisposables.add(dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl), () => {
			applyOverflow(left.overflowCells);
			applyOverflow(right.overflowCells);
			this._placeOverlays();
			this._setupReplaceTriggers();
		}));
	}

	/**
	 * 行位置を自然座標で測り直し、図形オーバーレイとアクティブなハイライトを配置し直す。
	 * transform:scale は offsetTop/offsetHeight に影響しないため、測定は拡縮を外さず自然座標のまま行える。
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
		const pageBreaks = this._pageBreakDiffs[this._activeSheetIndex];
		this._appendPageBreakOverlay('original', pageBreaks, sheet.originalMinCol, this._leftMetrics.rowY);
		this._appendPageBreakOverlay('modified', pageBreaks, sheet.modifiedMinCol, this._rightMetrics.rowY);
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
	private _buildDiffPane(rows: readonly IParadisDiffRow[], label: string, side: 'original' | 'modified', validationByCell: ReadonlyMap<string, IValidationChange>, minCol: number): { pane: HTMLElement; sizer: HTMLElement; content: HTMLElement; table: HTMLElement; rows: HTMLElement[]; highlight: HTMLElement; rowMeta: { excelRow: number; tr: HTMLElement }[]; overflowCells: IParadisOverflowItem[] } {
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

		// 列ヘッダ(A,B,C…)。通常ビューアと同じく使用範囲の先頭列(minCol)を起点にする。
		const thead = dom.append(table, $('thead.paradis-spreadsheet-head'));
		const headRow = dom.append(thead, $('tr'));
		dom.append(headRow, $('th.paradis-spreadsheet-corner'));
		for (let ci = 0; ci < columnWidths.length; ci++) {
			const th = dom.append(headRow, $('th.paradis-spreadsheet-colhead'));
			th.textContent = getColumnLabel(minCol - 1 + ci);
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
			// Excel の行番号は絶対番号(excelRow)。空行(相手側にのみ対応行がある)は番号を出さない。
			rowHead.textContent = row.excelRow !== undefined ? String(row.excelRow) : '';
			for (let ci = 0; ci < row.cells.length; ci++) {
				const cell = row.cells[ci];
				if (cell.hidden) {
					continue;
				}
				const validation = validationByCell.get(`${rowIdx}:${ci}`);
				const visibleValidation = validation && (validation.status === 'modified' || validation.status === 'removed' && side === 'original' || validation.status === 'added' && side === 'modified') ? validation : undefined;
				this._buildDiffCell(tr, cell, row.cells, ci, columnWidths, overflowCells, visibleValidation);
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
				// reducedDelay: 既定の workbench.hover.delay は macOS で 1500ms と長く、差分詳細の
				// 初回表示が体感で遅い。短い方の workbench.hover.reducedDelay (既定 500ms) を使う。
				// 注: showDelayedHover の実装 (hoverService.ts) は reducedDelay を受け付けるが、
				// インターフェース (vs/base/.../hover.ts) の Pick が 'groupId' のみで未追随のため
				// アサーションで渡す (vs/base は fork では改変しない規約)。
				const lifecycleOptions: IHoverLifecycleOptions = { groupId: 'paradis-spreadsheet-diff-details', reducedDelay: true };
				this._hoverService.showDelayedHover({ target: cell, content: formatDiffDetails(details) }, lifecycleOptions as Pick<IHoverLifecycleOptions, 'groupId'>);
			}
		}));

		// 現在位置ハイライト用の要素(ナビ時に配置)。
		const highlight = dom.append(contentEl, $('.paradis-spreadsheet-diff-highlight'));

		return { pane, sizer, content: contentEl, table, rows: rowEls, highlight, rowMeta, overflowCells };
	}

	/** 拡縮(transform:scale)適用前の自然座標で行位置を測定する。 */
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

	/** 図形を差分ステータス色で描画して content に重ねる(自然座標。transform:scale で一緒に拡縮される)。既存のオーバーレイは貼り替える。 */
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

	/** 改ページ線とページ番号の透かしを両ペインに重ねる(線はセルの前面、透かしは背面)。既存のオーバーレイは貼り替える。 */
	private _appendPageBreakOverlay(side: 'original' | 'modified', diff: IParadisPageBreakDiff | undefined, minCol: number | undefined, rowY: Map<number, number>): void {
		const content = side === 'original' ? this._leftContent : this._rightContent;
		const prev = side === 'original' ? this._leftPageBreakOverlay : this._rightPageBreakOverlay;
		prev?.lines?.remove();
		prev?.labels?.remove();
		let built: IParadisPageBreakOverlay = {};
		if (content && diff && minCol !== undefined) {
			const rowLines = side === 'original' ? diff.originalRowLines : diff.modifiedRowLines;
			const colLines = side === 'original' ? diff.originalColLines : diff.modifiedColLines;
			const labels = side === 'original' ? diff.originalLabels : diff.modifiedLabels;
			built = buildPageBreakOverlay(rowLines, colLines, undefined, labels, rowY, this._columnWidths, minCol, content.ownerDocument);
			if (built.lines) {
				content.appendChild(built.lines);
			}
			if (built.labels) {
				content.appendChild(built.labels);
			}
		}
		if (side === 'original') {
			this._leftPageBreakOverlay = built;
		} else {
			this._rightPageBreakOverlay = built;
		}
	}

	private _buildDiffCell(tr: HTMLElement, cell: IParadisDiffCell, cells: readonly IParadisDiffCell[], index: number, columnWidths: readonly number[], overflowSink: IParadisOverflowItem[], validationChange: IValidationChange | undefined): void {
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
		if (validationChange) {
			td.classList.add('paradis-spreadsheet-validation-change', `validation-${validationChange.status}`);
			td.dataset.validationAddress = validationChange.address;
			if (this._selectedValidation === validationChange) {
				td.classList.add('selected');
			}
			this._renderDisposables.add(dom.addDisposableListener(td, dom.EventType.CLICK, () => this._selectValidationChange(validationChange)));
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
		if (validationChange) {
			const badge = dom.append(td, $(`button.paradis-spreadsheet-validation-badge${ThemeIcon.asCSSSelector(Codicon.checklist)}`)) as HTMLButtonElement;
			badge.type = 'button';
			badge.title = localize('paradis.spreadsheet.validationChanged', "Data Validation Changed");
			badge.setAttribute('aria-label', localize('paradis.spreadsheet.validationCellLabel', "Input rule {0} at {1}", this._validationStatusLabel(validationChange.status), validationChange.address));
			badge.setAttribute('aria-pressed', String(this._selectedValidation === validationChange));
			this._renderedValidationCells.push({ cell: td, button: badge, address: validationChange.address });
			this._renderDisposables.add(dom.addDisposableListener(badge, dom.EventType.CLICK, event => {
				event.stopPropagation();
				this._selectValidationChange(validationChange, event.detail === 0);
			}));
		}
	}

	private _zoom(factor: number): void {
		this._userAdjusted = true;
		this._scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._scale * factor));
		this._applyScale();
		this._changeInspector.value?.setZoom(this._scale);
	}

	private _resetZoom(): void {
		this._userAdjusted = false;
		this._applyScale();
		this._changeInspector.value?.setZoom(this._scale);
	}

	/** 各ペインの表がその半幅に収まる倍率(縮小のみ。1 を超えて拡大はしない)。 */
	private _computeFitScale(): number {
		const paneWidth = this._panesEl ? Math.max(0, Math.floor(this._panesEl.clientWidth / 2) - 1) : 0;
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

	private _wireSyncScroll(from: HTMLElement, to: HTMLElement, fromSide: 'original' | 'modified'): void {
		this._renderDisposables.add(dom.addDisposableListener(from, dom.EventType.SCROLL, () => {
			if (this._syncing) {
				return;
			}
			this._syncing = true;
			const target = this._logicalScrollTarget(from, fromSide);
			if (to.scrollTop !== target.top) {
				to.scrollTop = target.top;
			}
			if (to.scrollLeft !== target.left) {
				to.scrollLeft = target.left;
			}
			this._syncScrollReset.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(from), () => {
				this._syncing = false;
			});
		}));
	}

	/** Converts source pixels to a logical row/column anchor, maps it, then resolves target geometry. */
	private _logicalScrollTarget(from: HTMLElement, fromSide: 'original' | 'modified'): { readonly top: number; readonly left: number } {
		const sheet = this._diffSheets[this._activeSheetIndex];
		if (!sheet) {
			return { top: 0, left: 0 };
		}
		const targetSide = fromSide === 'original' ? 'modified' : 'original';
		const sourceRows = fromSide === 'original' ? sheet.originalRows : sheet.modifiedRows;
		const targetRows = targetSide === 'original' ? sheet.originalRows : sheet.modifiedRows;
		const sourceMetrics = fromSide === 'original' ? this._leftMetrics : this._rightMetrics;
		const targetMetrics = targetSide === 'original' ? this._leftMetrics : this._rightMetrics;
		const naturalTop = from.scrollTop / this._scale;
		const sourceFirstRowTop = sourceMetrics.rowTops[0] ?? 0;
		const targetFirstRowTop = targetMetrics.rowTops[0] ?? 0;
		const sourceRowIndex = axisIndexAt(sourceMetrics.rowTops, sourceMetrics.rowHeights, naturalTop);
		const sourceRow = nearestLogicalRow(sourceRows, sourceRowIndex);
		const sourceRowTop = sourceMetrics.rowTops[sourceRowIndex] ?? 0;
		const sourceMinColumn = (fromSide === 'original' ? sheet.originalMinCol : sheet.modifiedMinCol) ?? 1;
		const targetMinColumn = (targetSide === 'original' ? sheet.originalMinCol : sheet.modifiedMinCol) ?? 1;
		const naturalScrollLeft = from.scrollLeft / this._scale;
		const leadingColumnOffset = Math.min(naturalScrollLeft, PARADIS_ROW_NUM_COL_WIDTH);
		const naturalLeft = Math.max(0, naturalScrollLeft - PARADIS_ROW_NUM_COL_WIDTH);
		const sourceColumnIndex = widthIndexAt(this._columnOffsets, naturalLeft);
		const sourceColumnLeft = this._columnOffsets[sourceColumnIndex] ?? 0;
		const mapped = mapSpreadsheetLogicalAnchor({
			row: sourceRow,
			column: sourceMinColumn + sourceColumnIndex,
			rowOffset: Math.max(0, naturalTop - sourceRowTop),
			columnOffset: Math.max(0, naturalLeft - sourceColumnLeft),
		}, sheet.logicalAlignment, fromSide);
		const hasSemanticAlignment = !!sheet.logicalAlignment?.grid;
		const targetRowIndex = hasSemanticAlignment
			? nearestRowIndex(targetRows, mapped.row)
			: Math.min(sourceRowIndex, Math.max(0, targetRows.length - 1));
		const targetColumnIndex = hasSemanticAlignment
			? Math.max(0, Math.min(this._columnWidths.length - 1, mapped.column - targetMinColumn))
			: sourceColumnIndex;
		const targetRowOffset = scaleSpreadsheetLogicalOffset(
			mapped.rowOffset,
			sourceMetrics.rowHeights[sourceRowIndex] ?? 0,
			targetMetrics.rowHeights[targetRowIndex] ?? 0,
		);
		return {
			top: (naturalTop < sourceFirstRowTop && sourceFirstRowTop > 0
				? naturalTop / sourceFirstRowTop * targetFirstRowTop
				: (targetMetrics.rowTops[targetRowIndex] ?? 0) + targetRowOffset) * this._scale,
			left: (naturalScrollLeft <= PARADIS_ROW_NUM_COL_WIDTH
				? leadingColumnOffset
				: PARADIS_ROW_NUM_COL_WIDTH + (this._columnOffsets[targetColumnIndex] ?? 0) + mapped.columnOffset) * this._scale,
		};
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
				if (this._validationFilter) {
					const selectedLocation = this._validationLocations.find(location => location.sheetIndex === idx);
					this._selectedValidation = selectedLocation?.validation;
					this._currentDiffIdx = selectedLocation ? this._validationLocations.indexOf(selectedLocation) : -1;
				}
				this._renderSheet();
				this._renderTabs();
				this._updateNav();
				this._changeInspector.value?.setActiveSheet(sheet.name);
				if (this._selectedValidation) {
					const selected = this._selectedValidation;
					this._scrollToRow(selected.rowIndex);
					this._navigateRaf.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._bodyEl ?? this._root!), () => this._highlightLocation({ sheetIndex: selected.sheetIndex, rowIndex: selected.rowIndex, validation: selected }));
				}
			}));
		});
	}

	private _updateNav(): void {
		if (this._countEl) {
			this._countEl.textContent = this._diffLocations.length > 0
				? this._validationFilter
					? localize('paradis.spreadsheet.nValidationChanges', "{0} input rule changes", this._diffLocations.length)
					: localize('paradis.spreadsheet.nChanges', "{0} changes", this._diffLocations.length)
				: localize('paradis.spreadsheet.noChangesShort', "No changes");
		}
		if (this._navPositionEl) {
			// まだどの変更にも移動していない間は位置を伏せる(「1 / N」と出しつつ 1 番目を映していない状態を作らない)。
			this._navPositionEl.textContent = this._diffLocations.length > 0
				? `${this._currentDiffIdx < 0 ? '–' : this._currentDiffIdx + 1} / ${this._diffLocations.length}`
				: '';
		}
	}

	private _navigate(delta: number): void {
		if (this._diffLocations.length === 0) {
			return;
		}
		// 未移動(-1)からは Next で先頭、Prev で末尾へ入る。
		let idx = this._currentDiffIdx < 0
			? (delta > 0 ? 0 : this._diffLocations.length - 1)
			: this._currentDiffIdx + delta;
		if (idx < 0) {
			idx = this._diffLocations.length - 1;
		} else if (idx >= this._diffLocations.length) {
			idx = 0;
		}
		this._currentDiffIdx = idx;
		const location = this._diffLocations[idx];
		this._selectedValidation = location.validation;
		if (location.sheetIndex !== this._activeSheetIndex) {
			this._activeSheetIndex = location.sheetIndex;
			this._renderSheet();
			this._renderTabs();
		} else if (location.validation) {
			this._updateValidationSelection();
			this._renderValidationInspector(location.validation);
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
		// セル: 両ペインの該当行を帯で強調(自然座標。拡縮(transform:scale)適用前に測定した値を使う)。
		this._highlightRow(this._leftHighlight, this._leftMetrics, location.rowIndex, pulse);
		this._highlightRow(this._rightHighlight, this._rightMetrics, location.rowIndex, pulse);
	}

	/** 再フロー後などに、表示中のハイライトだけをパルスなしで測り直して置き直す。 */
	private _repositionHighlight(): void {
		const shown = (this._leftHighlight?.style.display === 'block') || (this._rightHighlight?.style.display === 'block');
		if (shown && this._currentDiffIdx >= 0 && this._diffLocations.length > 0) {
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
		this._inputGeneration.invalidate();
		this._loadGeneration++;
		this._inputDisposables.clear();
		this._renderDisposables.clear();
		this._tabsDisposables.clear();
		this._navigateRaf.clear();
		this._syncScrollReset.clear();
		this._clearSemanticUi();
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._originalWorkbook = undefined;
		this._modifiedWorkbook = undefined;
		this._diffSheets = [];
		this._shapeDiffs = [];
		this._pageBreakDiffs = [];
		this._leftPageBreakOverlay = undefined;
		this._rightPageBreakOverlay = undefined;
		this._diffLocations = [];
		this._allDiffLocations = [];
		this._validationLocations = [];
		this._validationFilter = false;
		this._selectedValidation = undefined;
		this._renderedValidationCells = [];
		this._updateValidationFilterButton();
		this._panesEl = undefined;
		this._validationInspector = undefined;
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
		this._columnOffsets = [0];
		this._naturalTableWidth = 0;
		this._runtimeConfiguration = undefined;
		this._committedInput = undefined;
		if (this._bodyEl) {
			dom.clearNode(this._bodyEl);
		}
		if (this._tabsEl) {
			dom.clearNode(this._tabsEl);
		}
		super.clearInput();
	}

	override getViewState(): object | undefined {
		if (!this._modifiedResource) {
			return undefined;
		}
		return {
			source: createParadisSpreadsheetSourceDescriptor(this._modifiedResource, 'modified'),
			viewState: this._currentSpreadsheetViewState(),
		};
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

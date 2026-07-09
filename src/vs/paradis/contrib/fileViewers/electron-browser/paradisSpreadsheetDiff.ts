/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel差分の比較アルゴリズム(Superset の useSpreadsheetDiff.ts の buildDiffSheets/computeDiffSegments 移植)。
// 2版を個別パースした構造化データ(IParadisSheetData[])を、シート名でマッチング→行×列総当たりで比較し、
// 各セルに diffStatus(added/removed/modified)と文字レベル差分(diffSegments)を付与する。
// 文字レベル差分は依存を増やさないため LCS ベースで自前実装している(Superset は `diff` パッケージの diffChars)。

import { IParadisCellData, IParadisRenderShape, IParadisSheetData } from '../common/paradisSpreadsheet.js';

export type ParadisDiffStatus = 'added' | 'removed' | 'modified';

export interface IParadisDiffDetail {
	readonly label: string;
	readonly original?: string;
	readonly modified?: string;
}

export interface IParadisDiffSegment {
	readonly text: string;
	readonly type: 'added' | 'removed' | 'unchanged';
}

export interface IParadisDiffCell extends IParadisCellData {
	readonly diffStatus?: ParadisDiffStatus;
	readonly diffSegments?: readonly IParadisDiffSegment[];
	readonly diffDetails?: readonly IParadisDiffDetail[];
	readonly diffTitle?: string;
}

export interface IParadisDiffRow {
	readonly cells: readonly IParadisDiffCell[];
	readonly height: number;
	/** この行に対応する元の Excel 行番号(図形の位置合わせ用。空行は undefined)。 */
	readonly excelRow?: number;
}

export interface IParadisDiffSheet {
	readonly name: string;
	readonly originalRows: readonly IParadisDiffRow[];
	readonly modifiedRows: readonly IParadisDiffRow[];
	readonly columnCount: number;
	readonly columnWidths: readonly number[];
	readonly sheetStatus?: 'added' | 'removed';
	/** 各版シートの図形(斜線コネクタ等)。左=original / 右=modified で個別に描画する。 */
	readonly originalShapes?: readonly IParadisRenderShape[];
	readonly modifiedShapes?: readonly IParadisRenderShape[];
	/** 図形描画時の Excel 行番号→Y座標の基準に使う、各版シートの行メタ(excelRow, height)。 */
	readonly originalMinCol?: number;
	readonly modifiedMinCol?: number;
	/** シートタブの色(hex)。新版優先、無ければ旧版。 */
	readonly tabColor?: string;
	/** シート保護が有効か(新版優先、無ければ旧版)。 */
	readonly protectedSheet?: boolean;
}

// 文字レベル差分が大きすぎる場合の粗いフォールバック閾値(n*m)。
const MAX_CHAR_DIFF_CELLS = 4_000_000;

const STYLE_LABELS: Record<string, string> = {
	fontFamily: 'Font',
	fontSize: 'Font size',
	textAlign: 'Horizontal alignment',
	verticalAlign: 'Vertical alignment',
	fontWeight: 'Font weight',
	fontStyle: 'Font style',
	textDecoration: 'Text decoration',
	color: 'Font color',
	backgroundColor: 'Fill color',
	borderTop: 'Top border',
	borderRight: 'Right border',
	borderBottom: 'Bottom border',
	borderLeft: 'Left border',
	paddingLeft: 'Indent',
};

const STYLE_ORDER = [
	'fontFamily',
	'fontSize',
	'textAlign',
	'verticalAlign',
	'fontWeight',
	'fontStyle',
	'textDecoration',
	'color',
	'backgroundColor',
	'paddingLeft',
	'borderTop',
	'borderRight',
	'borderBottom',
	'borderLeft',
];

const EMPTY_CELL: IParadisCellData = { value: '', style: {} };

interface CharRun {
	value: string;
	type: 'unchanged' | 'added' | 'removed';
}

function detailValue(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return 'null';
	}
	return String(value);
}

function titleValue(value: string | undefined): string {
	if (value === undefined) {
		return '(unset)';
	}
	if (value === '') {
		return '(empty)';
	}
	return value;
}

export function formatDiffDetails(details: readonly IParadisDiffDetail[]): string {
	return details.map(detail => `${detail.label}: ${titleValue(detail.original)} -> ${titleValue(detail.modified)}`).join('\n');
}

function pushDetail(details: IParadisDiffDetail[], label: string, original: unknown, modified: unknown): void {
	if (original === modified) {
		return;
	}
	details.push({ label, original: detailValue(original), modified: detailValue(modified) });
}

function normalizeStyle(style: IParadisCellData['style']): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of Object.keys(style)) {
		const value = style[key];
		// Renderer/parser defaults should not turn otherwise empty cells into formatting changes.
		if (key === 'verticalAlign' && value === 'bottom') {
			continue;
		}
		result[key] = value;
	}
	return result;
}

function sortedStyleKeys(original: Record<string, string>, modified: Record<string, string>): string[] {
	const keys = [...new Set([...Object.keys(original), ...Object.keys(modified)])];
	return keys.sort((a, b) => {
		const ai = STYLE_ORDER.indexOf(a);
		const bi = STYLE_ORDER.indexOf(b);
		if (ai !== -1 || bi !== -1) {
			return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
		}
		return a.localeCompare(b);
	});
}

function stableStringify(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return JSON.stringify(value.map(v => stablePlainValue(v)));
	}
	return JSON.stringify(stablePlainValue(value));
}

function stablePlainValue(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return value;
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const nested = record[key];
		out[key] = Array.isArray(nested) ? nested.map(v => stablePlainValue(v)) : stablePlainValue(nested);
	}
	return out;
}

function addStyleDetails(details: IParadisDiffDetail[], original: IParadisCellData['style'], modified: IParadisCellData['style']): void {
	const normalizedOriginal = normalizeStyle(original);
	const normalizedModified = normalizeStyle(modified);
	for (const key of sortedStyleKeys(normalizedOriginal, normalizedModified)) {
		pushDetail(details, STYLE_LABELS[key] ?? key, normalizedOriginal[key], normalizedModified[key]);
	}
}

function buildCellDiffDetails(original: IParadisCellData, modified: IParadisCellData): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'Value', original.value, modified.value);
	addStyleDetails(details, original.style, modified.style);
	pushDetail(details, 'Merged columns', original.colSpan ?? 1, modified.colSpan ?? 1);
	pushDetail(details, 'Merged rows', original.rowSpan ?? 1, modified.rowSpan ?? 1);
	pushDetail(details, 'Wrap text', !!original.wrapText, !!modified.wrapText);
	pushDetail(details, 'Vertical text', !!original.verticalText, !!modified.verticalText);
	pushDetail(details, 'Shrink to fit', !!original.shrinkToFit, !!modified.shrinkToFit);
	pushDetail(details, 'Rich text', stableStringify(original.richText), stableStringify(modified.richText));
	pushDetail(details, 'Diagonal border', stableStringify(original.diagonal), stableStringify(modified.diagonal));
	return details;
}

function cellHasComparableData(cell: IParadisCellData): boolean {
	return buildCellDiffDetails(EMPTY_CELL, cell).length > 0;
}

function withCellDiff(cell: IParadisCellData, status: ParadisDiffStatus, details: readonly IParadisDiffDetail[]): IParadisDiffCell {
	if (details.length === 0) {
		return { ...cell };
	}
	return { ...cell, diffStatus: status, diffDetails: details, diffTitle: formatDiffDetails(details) };
}

function markCell(cell: IParadisCellData, status: ParadisDiffStatus): IParadisDiffCell {
	if (!cellHasComparableData(cell)) {
		return { ...cell };
	}
	const original = status === 'added' ? EMPTY_CELL : cell;
	const modified = status === 'added' ? cell : EMPTY_CELL;
	return withCellDiff(cell, status, buildCellDiffDetails(original, modified));
}

/** 2つの文字列の LCS ベース差分。`diff` パッケージの diffChars 相当のランを返す。 */
function computeCharDiff(a: string, b: string): CharRun[] {
	const n = a.length;
	const m = b.length;
	if (n === 0 && m === 0) {
		return [];
	}
	if (n * m > MAX_CHAR_DIFF_CELLS) {
		const out: CharRun[] = [];
		if (a) {
			out.push({ value: a, type: 'removed' });
		}
		if (b) {
			out.push({ value: b, type: 'added' });
		}
		return out;
	}

	// dp[i][j] = LCS 長 of a[i..] と b[j..]
	const dp: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) {
		dp.push(new Uint32Array(m + 1));
	}
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const runs: CharRun[] = [];
	const push = (ch: string, type: CharRun['type']) => {
		const last = runs[runs.length - 1];
		if (last && last.type === type) {
			last.value += ch;
		} else {
			runs.push({ value: ch, type });
		}
	};

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push(a[i], 'unchanged');
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			push(a[i], 'removed');
			i++;
		} else {
			push(b[j], 'added');
			j++;
		}
	}
	while (i < n) {
		push(a[i], 'removed');
		i++;
	}
	while (j < m) {
		push(b[j], 'added');
		j++;
	}
	return runs;
}

/**
 * 変更セルの文字レベル差分セグメントを、表示する側(original/modified)に応じて生成する。
 * original 側は「削除+不変」、modified 側は「追加+不変」を表示する。
 */
function computeDiffSegments(oldValue: string, newValue: string, side: 'original' | 'modified'): IParadisDiffSegment[] {
	const runs = computeCharDiff(oldValue, newValue);
	const segments: IParadisDiffSegment[] = [];
	for (const run of runs) {
		if (run.type === 'added') {
			if (side === 'modified') {
				segments.push({ text: run.value, type: 'added' });
			}
		} else if (run.type === 'removed') {
			if (side === 'original') {
				segments.push({ text: run.value, type: 'removed' });
			}
		} else {
			segments.push({ text: run.value, type: 'unchanged' });
		}
	}
	return segments;
}

function markRow(row: IParadisSheetData['rows'][number], status: ParadisDiffStatus): IParadisDiffRow {
	return {
		height: row.height,
		excelRow: row.excelRow,
		cells: row.cells.map(c => markCell(c, status)),
	};
}

/** 旧版/新版シート配列を突き合わせ、セル単位の差分注釈を付けた DiffSheet 配列を返す。 */
export function buildDiffSheets(originalSheets: readonly IParadisSheetData[], modifiedSheets: readonly IParadisSheetData[]): IParadisDiffSheet[] {
	const result: IParadisDiffSheet[] = [];
	const origMap = new Map(originalSheets.map(s => [s.name, s]));
	const modMap = new Map(modifiedSheets.map(s => [s.name, s]));
	const allNames = new Set([...origMap.keys(), ...modMap.keys()]);

	for (const name of allNames) {
		const orig = origMap.get(name);
		const mod = modMap.get(name);

		if (!orig && mod) {
			result.push({
				name,
				originalRows: [],
				modifiedRows: mod.rows.map(r => markRow(r, 'added')),
				columnCount: mod.columnCount,
				columnWidths: mod.columnWidths,
				sheetStatus: 'added',
				modifiedShapes: mod.shapes,
				modifiedMinCol: mod.minCol,
				...(mod.tabColor ? { tabColor: mod.tabColor } : {}),
				...(mod.protectedSheet ? { protectedSheet: true } : {}),
			});
			continue;
		}
		if (orig && !mod) {
			result.push({
				name,
				originalRows: orig.rows.map(r => markRow(r, 'removed')),
				modifiedRows: [],
				columnCount: orig.columnCount,
				columnWidths: orig.columnWidths,
				sheetStatus: 'removed',
				originalShapes: orig.shapes,
				originalMinCol: orig.minCol,
				...(orig.tabColor ? { tabColor: orig.tabColor } : {}),
				...(orig.protectedSheet ? { protectedSheet: true } : {}),
			});
			continue;
		}
		if (!orig || !mod) {
			continue;
		}

		const maxRows = Math.max(orig.rows.length, mod.rows.length);
		const maxCols = Math.max(orig.columnCount, mod.columnCount);
		const colWidths = mod.columnWidths.length >= orig.columnWidths.length ? mod.columnWidths : orig.columnWidths;

		const origRows: IParadisDiffRow[] = [];
		const modRows: IParadisDiffRow[] = [];

		// 既知の弱点(2026-07-03、検証済み): 行の対応付けは「位置(index)ペアリング」である(LCS等の行アライメントはしていない)。
		// 実セル編集で行が挿入/削除されると以降の行が全体的にズレ、塗り付き結合行が短い/空の行と対になって
		// 片側(通常は modified)が emptyCell(白・style空)になり、背景/枠線が非対称に見えることがある。
		// 現状のフィクスチャ(図形XMLのみ差分=両版セル同一)では発生しないが、実編集diffで顕在化する。
		// 顕在化した場合は、ここを LCS ベースの行アライメントに置き換えること。
		for (let r = 0; r < maxRows; r++) {
			const origRow = orig.rows[r];
			const modRow = mod.rows[r];
			const origCells: IParadisDiffCell[] = [];
			const modCells: IParadisDiffCell[] = [];

			for (let c = 0; c < maxCols; c++) {
				const origCell = origRow?.cells[c];
				const modCell = modRow?.cells[c];
				const emptyCell: IParadisDiffCell = { value: '', style: {} };

				if (!origCell && modCell) {
					const details = buildCellDiffDetails(EMPTY_CELL, modCell);
					origCells.push(emptyCell);
					modCells.push(withCellDiff(modCell, 'added', details));
				} else if (origCell && !modCell) {
					const details = buildCellDiffDetails(origCell, EMPTY_CELL);
					origCells.push(withCellDiff(origCell, 'removed', details));
					modCells.push(emptyCell);
				} else if (origCell && modCell) {
					const details = buildCellDiffDetails(origCell, modCell);
					const changed = details.length > 0;
					const valueChanged = origCell.value !== modCell.value;
					origCells.push({
						...origCell,
						diffStatus: changed ? 'modified' : undefined,
						diffSegments: valueChanged ? computeDiffSegments(origCell.value, modCell.value, 'original') : undefined,
						diffDetails: changed ? details : undefined,
						diffTitle: changed ? formatDiffDetails(details) : undefined,
					});
					modCells.push({
						...modCell,
						diffStatus: changed ? 'modified' : undefined,
						diffSegments: valueChanged ? computeDiffSegments(origCell.value, modCell.value, 'modified') : undefined,
						diffDetails: changed ? details : undefined,
						diffTitle: changed ? formatDiffDetails(details) : undefined,
					});
				} else {
					origCells.push(emptyCell);
					modCells.push(emptyCell);
				}
			}

			origRows.push({ cells: origCells, height: origRow?.height ?? modRow?.height ?? 20, excelRow: origRow?.excelRow });
			modRows.push({ cells: modCells, height: modRow?.height ?? origRow?.height ?? 20, excelRow: modRow?.excelRow });
		}

		result.push({
			name,
			originalRows: origRows,
			modifiedRows: modRows,
			columnCount: maxCols,
			columnWidths: colWidths,
			originalShapes: orig.shapes,
			modifiedShapes: mod.shapes,
			originalMinCol: orig.minCol,
			modifiedMinCol: mod.minCol,
			...((mod.tabColor ?? orig.tabColor) ? { tabColor: mod.tabColor ?? orig.tabColor } : {}),
			...((mod.protectedSheet || orig.protectedSheet) ? { protectedSheet: true } : {}),
		});
	}

	return result;
}

/** 差分がある行のインデックス一覧(ナビ用)。追加/削除シートで変更行が無い場合は [0] を返す。 */
export function getDiffRowIndices(sheet: IParadisDiffSheet): number[] {
	const rowCount = Math.max(sheet.originalRows.length, sheet.modifiedRows.length);
	const indices: number[] = [];
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const originalHasDiff = sheet.originalRows[rowIndex]?.cells.some(cell => cell.diffStatus) ?? false;
		const modifiedHasDiff = sheet.modifiedRows[rowIndex]?.cells.some(cell => cell.diffStatus) ?? false;
		if (originalHasDiff || modifiedHasDiff) {
			indices.push(rowIndex);
		}
	}
	if (indices.length === 0 && (sheet.sheetStatus === 'added' || sheet.sheetStatus === 'removed')) {
		return [0];
	}
	return indices;
}

// ── 図形(drawing)の差分 ──

export type ParadisShapeDiffStatus = 'unchanged' | 'added' | 'removed' | 'moved' | 'changed';

/** 各版で描画する図形とその差分ステータス。 */
export interface IParadisShapeRender {
	readonly shape: IParadisRenderShape;
	readonly status: ParadisShapeDiffStatus;
	readonly diffDetails?: readonly IParadisDiffDetail[];
	readonly diffTitle?: string;
}

/** Prev/Next のナビ対象になる図形の変更1件。 */
export interface IParadisShapeChange {
	readonly key: string;
	readonly status: 'added' | 'removed' | 'moved' | 'changed';
	/** ナビ位置合わせ用の Excel 行番号(1始まり)。 */
	readonly anchorRow: number;
	/** ハイライト対象の図形と表示側(削除=original / それ以外=modified)。 */
	readonly shape: IParadisRenderShape;
	readonly side: 'original' | 'modified';
	readonly diffDetails?: readonly IParadisDiffDetail[];
	readonly diffTitle?: string;
}

export interface IParadisShapeDiff {
	readonly originalRenders: readonly IParadisShapeRender[];
	readonly modifiedRenders: readonly IParadisShapeRender[];
	readonly changes: readonly IParadisShapeChange[];
}

// 安定キー: cNvPr name → id → 幾何ハッシュ。
function shapeKey(s: IParadisRenderShape): string {
	return s.name || s.shapeId || `${s.type}:${s.from.c},${s.from.co},${s.from.r},${s.from.ro},${s.to.c},${s.to.r}`;
}

function sameGeometry(a: IParadisRenderShape, b: IParadisRenderShape): boolean {
	return a.from.c === b.from.c && a.from.co === b.from.co && a.from.r === b.from.r && a.from.ro === b.from.ro
		&& a.to.c === b.to.c && a.to.co === b.to.co && a.to.r === b.to.r && a.to.ro === b.to.ro
		&& (a.ext?.cx ?? -1) === (b.ext?.cx ?? -1) && (a.ext?.cy ?? -1) === (b.ext?.cy ?? -1);
}

function sameStyle(a: IParadisRenderShape, b: IParadisRenderShape): boolean {
	return a.type === b.type && a.outlineWidth === b.outlineWidth && a.outlineColor === b.outlineColor
		&& a.dash === b.dash && (a.href ?? '') === (b.href ?? '');
}

function anchorText(anchor: IParadisRenderShape['from']): string {
	return `row ${anchor.r + 1}, col ${anchor.c + 1}, offset ${anchor.ro}:${anchor.co}`;
}

function shapeName(shape: IParadisRenderShape): string {
	return shape.name || shape.shapeId || shape.type;
}

function shapeAddedDetails(shape: IParadisRenderShape): IParadisDiffDetail[] {
	return [{ label: 'Object', original: undefined, modified: shapeName(shape) }];
}

function shapeRemovedDetails(shape: IParadisRenderShape): IParadisDiffDetail[] {
	return [{ label: 'Object', original: shapeName(shape), modified: undefined }];
}

function shapeGeometryDetails(original: IParadisRenderShape, modified: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'Object start', anchorText(original.from), anchorText(modified.from));
	pushDetail(details, 'Object end', anchorText(original.to), anchorText(modified.to));
	pushDetail(details, 'Object width', original.ext?.cx, modified.ext?.cx);
	pushDetail(details, 'Object height', original.ext?.cy, modified.ext?.cy);
	return details;
}

function shapeStyleDetails(original: IParadisRenderShape, modified: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'Object type', original.type, modified.type);
	pushDetail(details, 'Object outline color', original.outlineColor, modified.outlineColor);
	pushDetail(details, 'Object outline width', original.outlineWidth, modified.outlineWidth);
	pushDetail(details, 'Object dash', original.dash, modified.dash);
	pushDetail(details, 'Object image', original.href, modified.href);
	return details;
}

function withShapeDiff(shape: IParadisRenderShape, status: ParadisShapeDiffStatus, details: readonly IParadisDiffDetail[] = []): IParadisShapeRender {
	if (details.length === 0) {
		return { shape, status };
	}
	return { shape, status, diffDetails: details, diffTitle: formatDiffDetails(details) };
}

function withShapeChange(key: string, status: IParadisShapeChange['status'], shape: IParadisRenderShape, side: 'original' | 'modified', details: readonly IParadisDiffDetail[]): IParadisShapeChange {
	return { key, status, anchorRow: shape.from.r + 1, shape, side, diffDetails: details, diffTitle: formatDiffDetails(details) };
}

/** 旧版/新版の図形を安定キーで突き合わせ、各版の描画リストと変更一覧を返す。 */
export function buildShapeDiff(original: readonly IParadisRenderShape[] | undefined, modified: readonly IParadisRenderShape[] | undefined): IParadisShapeDiff {
	const orig = original ?? [];
	const mod = modified ?? [];
	const origByKey = new Map<string, IParadisRenderShape>();
	for (const s of orig) {
		origByKey.set(shapeKey(s), s);
	}
	const modByKey = new Map<string, IParadisRenderShape>();
	for (const s of mod) {
		modByKey.set(shapeKey(s), s);
	}

	const originalRenders: IParadisShapeRender[] = [];
	const modifiedRenders: IParadisShapeRender[] = [];
	const changes: IParadisShapeChange[] = [];

	// original 側(左)。変更のカウントは削除のみここで、移動/スタイル変更は modified 側で1回だけ数える。
	for (const s of orig) {
		const key = shapeKey(s);
		const m = modByKey.get(key);
		if (!m) {
			const details = shapeRemovedDetails(s);
			originalRenders.push(withShapeDiff(s, 'removed', details));
			changes.push(withShapeChange(key, 'removed', s, 'original', details));
		} else if (!sameGeometry(s, m)) {
			originalRenders.push(withShapeDiff(s, 'moved', shapeGeometryDetails(s, m)));
		} else if (!sameStyle(s, m)) {
			originalRenders.push(withShapeDiff(s, 'changed', shapeStyleDetails(s, m)));
		} else {
			originalRenders.push({ shape: s, status: 'unchanged' });
		}
	}

	// modified 側(右)。追加/移動/スタイル変更をここでカウント。
	for (const s of mod) {
		const key = shapeKey(s);
		const o = origByKey.get(key);
		if (!o) {
			const details = shapeAddedDetails(s);
			modifiedRenders.push(withShapeDiff(s, 'added', details));
			changes.push(withShapeChange(key, 'added', s, 'modified', details));
		} else if (!sameGeometry(o, s)) {
			const details = shapeGeometryDetails(o, s);
			modifiedRenders.push(withShapeDiff(s, 'moved', details));
			changes.push(withShapeChange(key, 'moved', s, 'modified', details));
		} else if (!sameStyle(o, s)) {
			const details = shapeStyleDetails(o, s);
			modifiedRenders.push(withShapeDiff(s, 'changed', details));
			changes.push(withShapeChange(key, 'changed', s, 'modified', details));
		} else {
			modifiedRenders.push({ shape: s, status: 'unchanged' });
		}
	}

	return { originalRenders, modifiedRenders, changes };
}

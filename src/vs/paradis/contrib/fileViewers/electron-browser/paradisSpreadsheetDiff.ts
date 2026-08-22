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

import { stringHash } from '../../../../base/common/hash.js';
import { equals as objectsEqual } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { IParadisCellData, IParadisDataValidationEntry, IParadisRenderShape, IParadisSheetData, canonicalizeDataValidationEntries, dataValidationEntriesCoverSame } from '../common/paradisSpreadsheet.js';
import { computeLcsRowPairs, rowFingerprint } from '../common/paradisSpreadsheetRowAlign.js';
import { IParadisPageBreakLine, IParadisPageLabelBox, IParadisPageLayout, IParadisPageRectangle, ParadisPageBreakStatus, pageLabelText, pageRectangles } from '../common/paradisSpreadsheetPageLayout.js';

export type ParadisDiffStatus = 'added' | 'removed' | 'modified';

export type ParadisDiffDetailKind =
	| 'value'
	| 'fontFamily'
	| 'fontSize'
	| 'textAlign'
	| 'verticalAlign'
	| 'fontWeight'
	| 'fontStyle'
	| 'textDecoration'
	| 'color'
	| 'backgroundColor'
	| 'borderTop'
	| 'borderRight'
	| 'borderBottom'
	| 'borderLeft'
	| 'paddingLeft'
	| 'paddingRight'
	| 'otherStyle'
	| 'mergedColumns'
	| 'mergedRows'
	| 'wrapText'
	| 'verticalText'
	| 'shrinkToFit'
	| 'richText'
	| 'diagonalBorder'
	| 'dataValidation'
	| 'object'
	| 'objectStart'
	| 'objectEnd'
	| 'objectWidth'
	| 'objectHeight'
	| 'objectFlipHorizontal'
	| 'objectFlipVertical'
	| 'objectType'
	| 'objectOutlineColor'
	| 'objectOutlineWidth'
	| 'objectDash'
	| 'objectImage';

export interface IParadisDiffDetail {
	readonly kind: ParadisDiffDetailKind;
	readonly property?: string;
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
	readonly originalDataValidations?: readonly IParadisDataValidationEntry[];
	readonly modifiedDataValidations?: readonly IParadisDataValidationEntry[];
	/** 図形描画時の Excel 行番号→Y座標の基準に使う、各版シートの行メタ(excelRow, height)。 */
	readonly originalMinCol?: number;
	readonly modifiedMinCol?: number;
	/** シートタブの色(hex)。新版優先、無ければ旧版。 */
	readonly tabColor?: string;
	/** シート保護が有効か(新版優先、無ければ旧版)。 */
	readonly protectedSheet?: boolean;
	/** どちらかの版で MAX_ROWS を超えて打ち切られているか。差分UIに通知を出すために使う。 */
	readonly truncated?: boolean;
}

export interface IParadisDataValidationDiff {
	readonly address: string;
	readonly range: IParadisDataValidationEntry['range'];
	readonly status: 'added' | 'removed' | 'modified';
	readonly original?: IParadisDataValidationEntry['validation'];
	readonly modified?: IParadisDataValidationEntry['validation'];
}

function validationRangeKey(range: IParadisDataValidationEntry['range']): string {
	return `${range.minR}:${range.minC}:${range.maxR}:${range.maxC}`;
}

function validationColumnName(column: number): string {
	let value = column;
	let result = '';
	while (value > 0) {
		value--;
		result = String.fromCharCode(65 + value % 26) + result;
		value = Math.floor(value / 26);
	}
	return result;
}

function validationRangeAddress(range: IParadisDataValidationEntry['range']): string {
	const start = `${validationColumnName(range.minC)}${range.minR}`;
	const end = `${validationColumnName(range.maxC)}${range.maxR}`;
	return start === end ? start : `${start}:${end}`;
}

/** 表示矩形から離れたセルも含め、矩形範囲をキーに入力規則を比較する。 */
export function buildDataValidationDiff(originalEntries: readonly IParadisDataValidationEntry[] = [], modifiedEntries: readonly IParadisDataValidationEntry[] = []): IParadisDataValidationDiff[] {
	if (dataValidationEntriesCoverSame(originalEntries, modifiedEntries)) {
		return [];
	}
	const originalByRange = new Map(canonicalizeDataValidationEntries(originalEntries).map(entry => [validationRangeKey(entry.range), entry]));
	const modifiedByRange = new Map(canonicalizeDataValidationEntries(modifiedEntries).map(entry => [validationRangeKey(entry.range), entry]));
	const changes: IParadisDataValidationDiff[] = [];
	for (const key of new Set([...originalByRange.keys(), ...modifiedByRange.keys()])) {
		const originalEntry = originalByRange.get(key);
		const modifiedEntry = modifiedByRange.get(key);
		if (objectsEqual(originalEntry?.validation, modifiedEntry?.validation)) {
			continue;
		}
		const range = modifiedEntry?.range ?? originalEntry!.range;
		changes.push({
			address: validationRangeAddress(range),
			range,
			status: !originalEntry && modifiedEntry ? 'added' : originalEntry && !modifiedEntry ? 'removed' : 'modified',
			...(originalEntry ? { original: originalEntry.validation } : {}),
			...(modifiedEntry ? { modified: modifiedEntry.validation } : {}),
		});
	}
	return changes;
}

// 文字レベル差分が大きすぎる場合の粗いフォールバック閾値(n*m)。
const MAX_CHAR_DIFF_CELLS = 4_000_000;

const STYLE_DETAIL_KINDS: Record<string, ParadisDiffDetailKind> = {
	fontFamily: 'fontFamily',
	fontSize: 'fontSize',
	textAlign: 'textAlign',
	verticalAlign: 'verticalAlign',
	fontWeight: 'fontWeight',
	fontStyle: 'fontStyle',
	textDecoration: 'textDecoration',
	color: 'color',
	backgroundColor: 'backgroundColor',
	borderTop: 'borderTop',
	borderRight: 'borderRight',
	borderBottom: 'borderBottom',
	borderLeft: 'borderLeft',
	paddingLeft: 'paddingLeft',
	paddingRight: 'paddingRight',
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
	'paddingRight',
	'borderTop',
	'borderRight',
	'borderBottom',
	'borderLeft',
];

const EMPTY_CELL: IParadisCellData = { value: '', style: {} };
const MAX_DIFF_DETAIL_VALUE_LENGTH = 512;

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
	const text = String(value);
	return text.length <= MAX_DIFF_DETAIL_VALUE_LENGTH ? text : `${text.slice(0, MAX_DIFF_DETAIL_VALUE_LENGTH - 1)}…`;
}

function pushDetail(details: IParadisDiffDetail[], kind: ParadisDiffDetailKind, original: unknown, modified: unknown, property?: string): void {
	if (original === modified) {
		return;
	}
	const boundedProperty = detailValue(property);
	details.push({ kind, ...(boundedProperty ? { property: boundedProperty } : {}), original: detailValue(original), modified: detailValue(modified) });
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

function boundedStableStringify(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const chunks: string[] = [];
	let length = 0;
	let truncated = false;
	const append = (text: string): void => {
		const remaining = MAX_DIFF_DETAIL_VALUE_LENGTH - length;
		if (remaining <= 0) {
			truncated = true;
			return;
		}
		if (text.length > remaining) {
			chunks.push(text.slice(0, remaining));
			length = MAX_DIFF_DETAIL_VALUE_LENGTH;
			truncated = true;
			return;
		}
		chunks.push(text);
		length += text.length;
	};
	const serialize = (current: unknown, arrayItem = false): void => {
		if (truncated) {
			return;
		}
		if (current === undefined) {
			if (arrayItem) {
				append('null');
			}
			return;
		}
		if (current === null || typeof current === 'number' || typeof current === 'boolean') {
			append(JSON.stringify(current) ?? 'null');
			return;
		}
		if (typeof current === 'string') {
			const bounded = current.slice(0, MAX_DIFF_DETAIL_VALUE_LENGTH);
			append(JSON.stringify(bounded));
			if (bounded.length !== current.length) {
				truncated = true;
			}
			return;
		}
		if (Array.isArray(current)) {
			append('[');
			for (let i = 0; i < current.length && !truncated; i++) {
				if (i > 0) {
					append(',');
				}
				serialize(current[i], true);
			}
			append(']');
			return;
		}
		if (typeof current === 'object') {
			append('{');
			let emitted = 0;
			for (const key of Object.keys(current).sort()) {
				const nested = (current as Record<string, unknown>)[key];
				if (nested === undefined || truncated) {
					continue;
				}
				if (emitted++ > 0) {
					append(',');
				}
				serialize(key);
				append(':');
				serialize(nested);
			}
			append('}');
			return;
		}
		append(JSON.stringify(String(current)));
	};
	serialize(value);
	const result = chunks.join('');
	return truncated ? `${result.slice(0, MAX_DIFF_DETAIL_VALUE_LENGTH - 1)}…` : result;
}

function pushStructuredDetail(details: IParadisDiffDetail[], kind: ParadisDiffDetailKind, original: unknown, modified: unknown): void {
	if (objectsEqual(original, modified)) {
		return;
	}
	details.push({ kind, original: boundedStableStringify(original), modified: boundedStableStringify(modified) });
}

function addStyleDetails(details: IParadisDiffDetail[], original: IParadisCellData['style'], modified: IParadisCellData['style']): void {
	const normalizedOriginal = normalizeStyle(original);
	const normalizedModified = normalizeStyle(modified);
	for (const key of sortedStyleKeys(normalizedOriginal, normalizedModified)) {
		pushDetail(details, STYLE_DETAIL_KINDS[key] ?? 'otherStyle', normalizedOriginal[key], normalizedModified[key], STYLE_DETAIL_KINDS[key] ? undefined : key);
	}
}

function buildCellDiffDetails(original: IParadisCellData, modified: IParadisCellData): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'value', original.value, modified.value);
	addStyleDetails(details, original.style, modified.style);
	pushDetail(details, 'mergedColumns', original.colSpan ?? 1, modified.colSpan ?? 1);
	pushDetail(details, 'mergedRows', original.rowSpan ?? 1, modified.rowSpan ?? 1);
	pushDetail(details, 'wrapText', !!original.wrapText, !!modified.wrapText);
	pushDetail(details, 'verticalText', !!original.verticalText, !!modified.verticalText);
	pushDetail(details, 'shrinkToFit', !!original.shrinkToFit, !!modified.shrinkToFit);
	pushStructuredDetail(details, 'richText', original.richText, modified.richText);
	pushStructuredDetail(details, 'diagonalBorder', original.diagonal, modified.diagonal);
	pushStructuredDetail(details, 'dataValidation', original.dataValidation, modified.dataValidation);
	return details;
}

function withCellDiff(cell: IParadisCellData, status: ParadisDiffStatus, details: readonly IParadisDiffDetail[]): IParadisDiffCell {
	if (details.length === 0) {
		return { ...cell };
	}
	return { ...cell, diffStatus: status, diffDetails: details };
}

function markCell(cell: IParadisCellData, status: ParadisDiffStatus): IParadisDiffCell {
	const original = status === 'added' ? EMPTY_CELL : cell;
	const modified = status === 'added' ? cell : EMPTY_CELL;
	const details = buildCellDiffDetails(original, modified);
	if (details.length === 0) {
		return { ...cell };
	}
	return withCellDiff(cell, status, details);
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
				modifiedDataValidations: mod.dataValidations,
				modifiedMinCol: mod.minCol,
				...(mod.tabColor ? { tabColor: mod.tabColor } : {}),
				...(mod.protectedSheet ? { protectedSheet: true } : {}),
				...(mod.truncated ? { truncated: true } : {}),
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
				originalDataValidations: orig.dataValidations,
				originalMinCol: orig.minCol,
				...(orig.tabColor ? { tabColor: orig.tabColor } : {}),
				...(orig.protectedSheet ? { protectedSheet: true } : {}),
				...(orig.truncated ? { truncated: true } : {}),
			});
			continue;
		}
		if (!orig || !mod) {
			continue;
		}

		const maxRows = Math.max(orig.rows.length, mod.rows.length);
		const minCol = Math.min(orig.minCol, mod.minCol);
		const maxCol = Math.max(orig.minCol + orig.columnCount - 1, mod.minCol + mod.columnCount - 1);
		const maxCols = maxCol - minCol + 1;
		const colWidths = Array.from({ length: maxCols }, (_, index) => {
			const absoluteColumn = minCol + index;
			return mod.columnWidths[absoluteColumn - mod.minCol]
				?? orig.columnWidths[absoluteColumn - orig.minCol]
				?? 64;
		});

		const origRows: IParadisDiffRow[] = [];
		const modRows: IParadisDiffRow[] = [];

		/** 1行ぶんの左右セルを比較して DiffRow の組を作る。片側 undefined は「相手側にしか無い行」(ゴースト)。 */
		const pushAlignedRow = (origRow: IParadisSheetData['rows'][number] | undefined, modRow: IParadisSheetData['rows'][number] | undefined): void => {
			const origCells: IParadisDiffCell[] = [];
			const modCells: IParadisDiffCell[] = [];

			for (let c = 0; c < maxCols; c++) {
				const absoluteColumn = minCol + c;
				const origCell = origRow?.cells[absoluteColumn - orig.minCol];
				const modCell = modRow?.cells[absoluteColumn - mod.minCol];
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
					});
					modCells.push({
						...modCell,
						diffStatus: changed ? 'modified' : undefined,
						diffSegments: valueChanged ? computeDiffSegments(origCell.value, modCell.value, 'modified') : undefined,
						diffDetails: changed ? details : undefined,
					});
				} else {
					origCells.push(emptyCell);
					modCells.push(emptyCell);
				}
			}

			// ゴースト(相手側にしか無い行)は相手の行高を借りる。左右の累積高さを揃えて
			// スクロール同期・ナビハイライトがズレないようにする。
			origRows.push({ cells: origCells, height: origRow?.height ?? modRow?.height ?? 20, excelRow: origRow?.excelRow });
			modRows.push({ cells: modCells, height: modRow?.height ?? origRow?.height ?? 20, excelRow: modRow?.excelRow });
		};

		// 行アライメント(LCS): 行の表示値フィンガープリントの最長共通部分列で対応行を見つけ、
		// 挿入/削除行を「相手側がゴーストの独立行」として切り出す。旧来のインデックス対比では
		// 1行の挿入で以降の全行が偽の modified になっていた。左右の行数はゴースト込みで常に一致するため、
		// 差分エディタのナビ・スクロール同期・ハイライトはこれまでどおり表示インデックス基準で動く。
		// 行数が多くDPテーブルが上限を超える場合は、従来のインデックス対比へフォールバックする。
		// この経路では「行挿入/削除以降が偽のmodifiedになる」既知の弱点が残る(巨大シート限定)。
		const lcsPairs = computeLcsRowPairs(orig.rows.map(rowFingerprint), mod.rows.map(rowFingerprint));
		if (!lcsPairs) {
			for (let r = 0; r < maxRows; r++) {
				pushAlignedRow(orig.rows[r], mod.rows[r]);
			}
		} else {
			let oi = 0;
			let mi = 0;
			for (const pair of lcsPairs) {
				while (mi < pair.m) {
					pushAlignedRow(undefined, mod.rows[mi]);
					mi++;
				}
				while (oi < pair.o) {
					pushAlignedRow(orig.rows[oi], undefined);
					oi++;
				}
				pushAlignedRow(orig.rows[pair.o], mod.rows[pair.m]);
				oi = pair.o + 1;
				mi = pair.m + 1;
			}
			while (mi < mod.rows.length) {
				pushAlignedRow(undefined, mod.rows[mi]);
				mi++;
			}
			while (oi < orig.rows.length) {
				pushAlignedRow(orig.rows[oi], undefined);
				oi++;
			}
		}

		result.push({
			name,
			originalRows: origRows,
			modifiedRows: modRows,
			columnCount: maxCols,
			columnWidths: colWidths,
			originalShapes: orig.shapes,
			modifiedShapes: mod.shapes,
			originalDataValidations: orig.dataValidations,
			modifiedDataValidations: mod.dataValidations,
			originalMinCol: minCol,
			modifiedMinCol: minCol,
			...((mod.tabColor ?? orig.tabColor) ? { tabColor: mod.tabColor ?? orig.tabColor } : {}),
			...((mod.protectedSheet || orig.protectedSheet) ? { protectedSheet: true } : {}),
			...((orig.truncated || mod.truncated) ? { truncated: true } : {}),
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

function anchorText(anchor: IParadisRenderShape['from']): string {
	return `${anchor.r + 1}:${anchor.c + 1}:${anchor.ro}:${anchor.co}`;
}

function shapeName(shape: IParadisRenderShape): string {
	return shape.name || shape.shapeId || shape.type;
}

function shapeAddedDetails(shape: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'object', undefined, shapeName(shape));
	return details;
}

function shapeRemovedDetails(shape: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'object', shapeName(shape), undefined);
	return details;
}

function shapeGeometryDetails(original: IParadisRenderShape, modified: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'objectStart', anchorText(original.from), anchorText(modified.from));
	pushDetail(details, 'objectEnd', anchorText(original.to), anchorText(modified.to));
	pushDetail(details, 'objectWidth', original.ext?.cx, modified.ext?.cx);
	pushDetail(details, 'objectHeight', original.ext?.cy, modified.ext?.cy);
	pushDetail(details, 'objectFlipHorizontal', original.flipH, modified.flipH);
	pushDetail(details, 'objectFlipVertical', original.flipV, modified.flipV);
	return details;
}

function imageDescription(href: string | undefined): string | undefined {
	if (!href) {
		return undefined;
	}
	const headerEnd = href.indexOf(',');
	const header = headerEnd === -1 ? '' : href.slice(0, headerEnd);
	const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
	const payloadLength = headerEnd === -1 ? href.length : href.length - headerEnd - 1;
	const padding = href.endsWith('==') ? 2 : href.endsWith('=') ? 1 : 0;
	const bytes = header.includes(';base64') ? Math.max(0, Math.floor(payloadLength * 3 / 4) - padding) : payloadLength;
	const fingerprint = (stringHash(href, 0) >>> 0).toString(16).padStart(8, '0');
	return `${mime}; ${bytes} B; ${fingerprint}`;
}

function shapeStyleDetails(original: IParadisRenderShape, modified: IParadisRenderShape): IParadisDiffDetail[] {
	const details: IParadisDiffDetail[] = [];
	pushDetail(details, 'objectType', original.type, modified.type);
	pushDetail(details, 'objectOutlineColor', original.outlineColor, modified.outlineColor);
	pushDetail(details, 'objectOutlineWidth', original.outlineWidth, modified.outlineWidth);
	pushDetail(details, 'objectDash', original.dash, modified.dash);
	if (original.href !== modified.href) {
		pushDetail(details, 'objectImage', imageDescription(original.href), imageDescription(modified.href));
	}
	return details;
}

function withShapeDiff(shape: IParadisRenderShape, status: ParadisShapeDiffStatus, details: readonly IParadisDiffDetail[] = []): IParadisShapeRender {
	if (details.length === 0) {
		return { shape, status };
	}
	return { shape, status, diffDetails: details };
}

function withShapeChange(key: string, status: IParadisShapeChange['status'], shape: IParadisRenderShape, side: 'original' | 'modified', details: readonly IParadisDiffDetail[]): IParadisShapeChange {
	return { key, status, anchorRow: shape.from.r + 1, shape, side, diffDetails: details };
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
	const pairDetails = new Map<string, { readonly geometry: readonly IParadisDiffDetail[]; readonly style: readonly IParadisDiffDetail[]; readonly all: readonly IParadisDiffDetail[] }>();
	for (const [key, originalShape] of origByKey) {
		const modifiedShape = modByKey.get(key);
		if (!modifiedShape) {
			continue;
		}
		const geometry = shapeGeometryDetails(originalShape, modifiedShape);
		const style = shapeStyleDetails(originalShape, modifiedShape);
		pairDetails.set(key, { geometry, style, all: [...geometry, ...style] });
	}

	// original 側(左)。変更のカウントは削除のみここで、移動/スタイル変更は modified 側で1回だけ数える。
	for (const s of orig) {
		const key = shapeKey(s);
		const m = modByKey.get(key);
		if (!m) {
			const details = shapeRemovedDetails(s);
			originalRenders.push(withShapeDiff(s, 'removed', details));
			changes.push(withShapeChange(key, 'removed', s, 'original', details));
		} else if ((pairDetails.get(key)?.geometry.length ?? 0) > 0) {
			originalRenders.push(withShapeDiff(s, 'moved', pairDetails.get(key)?.all));
		} else if ((pairDetails.get(key)?.style.length ?? 0) > 0) {
			originalRenders.push(withShapeDiff(s, 'changed', pairDetails.get(key)?.style));
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
		} else if ((pairDetails.get(key)?.geometry.length ?? 0) > 0) {
			const details = pairDetails.get(key)?.all ?? [];
			modifiedRenders.push(withShapeDiff(s, 'moved', details));
			changes.push(withShapeChange(key, 'moved', s, 'modified', details));
		} else if ((pairDetails.get(key)?.style.length ?? 0) > 0) {
			const details = pairDetails.get(key)?.style ?? [];
			modifiedRenders.push(withShapeDiff(s, 'changed', details));
			changes.push(withShapeChange(key, 'changed', s, 'modified', details));
		} else {
			modifiedRenders.push({ shape: s, status: 'unchanged' });
		}
	}

	return { originalRenders, modifiedRenders, changes };
}

// ── 改ページ(ページ区切り)の差分 ──

/** Prev/Next のナビ対象になる改ページの変更1件。 */
export interface IParadisPageBreakChange {
	readonly status: 'added' | 'removed' | 'moved' | 'repaged';
	/** 行方向(横線)か列方向(縦線)か。 */
	readonly axis: 'row' | 'column';
	/** 変更前・変更後それぞれの改ページ位置(Excel の1始まり)。 */
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	/** ナビでスクロールする側と行。 */
	readonly side: 'original' | 'modified';
	readonly anchorRow: number;
	/** 一覧に出す本文と補足。 */
	readonly title: string;
	readonly detail: string;
}

/** 両版の改ページ描画データと、変更一覧。 */
export interface IParadisPageBreakDiff {
	readonly originalRowLines: readonly IParadisPageBreakLine[];
	readonly modifiedRowLines: readonly IParadisPageBreakLine[];
	readonly originalColLines: readonly IParadisPageBreakLine[];
	readonly modifiedColLines: readonly IParadisPageBreakLine[];
	readonly originalLabels: readonly IParadisPageLabelBox[];
	readonly modifiedLabels: readonly IParadisPageLabelBox[];
	readonly changes: readonly IParadisPageBreakChange[];
}

/**
 * 改ページの位置は Excel の行番号で持つが、行が挿入・削除されると番号だけがずれる。
 * それを「改ページが動いた」と報告しないよう、改ページ直後の行の中身を手掛かり(キー)にして対応付ける。
 */
function anchorKeyAfter(sheet: IParadisSheetData, breakIndex: number): string {
	const parts: string[] = [];
	for (const row of sheet.rows) {
		if (row.excelRow <= breakIndex) {
			continue;
		}
		const text = row.cells.map(c => c.value).filter(v => v).join(' ').trim();
		if (text) {
			parts.push(text);
		}
		if (parts.length >= 2 || parts.join(' ').length > 120) {
			break;
		}
	}
	return parts.join(' ').slice(0, 120);
}

/**
 * 印刷対象範囲(ページ割りが実際に敷き詰めた範囲)に入っているかの判定。
 * 使用範囲の外に取り残された古い改ページは Excel でも表示されないので、描画も比較もしない。
 */
function printRangeFilter(sheet: IParadisSheetData, axis: 'row' | 'column'): (index: number) => boolean {
	const bands = axis === 'row' ? sheet.pageLayout?.rowBands : sheet.pageLayout?.colBands;
	if (!bands || bands.length === 0) {
		return () => true;
	}
	const last = bands[bands.length - 1].to;
	return (index: number) => index < last;
}

/** ページの中身を表す手掛かり。横に並ぶページを取り違えないよう、列の開始位置も混ぜる。 */
function pageKey(sheet: IParadisSheetData, rect: IParadisPageRectangle): string {
	const anchor = anchorKeyAfter(sheet, rect.fromRow - 1);
	return anchor ? `c${rect.fromCol}:${anchor}` : '';
}

/**
 * 改ページ位置(Excelの1始まり) → その区切りで終わるページの番号。
 * 自動改ページも数に入るので、手動改ページの本数からは求められない(ページ割りから引く)。
 */
function pageNumberEndingAt(layout: IParadisPageLayout | undefined, axis: 'row' | 'column', index: number): number | undefined {
	if (!layout) {
		return undefined;
	}
	const bands = axis === 'row' ? layout.rowBands : layout.colBands;
	const bandIndex = bands.findIndex(band => band.to === index);
	if (bandIndex < 0) {
		return undefined;
	}
	return axis === 'row' ? layout.pageNumbers[bandIndex]?.[0] : layout.pageNumbers[0]?.[bandIndex];
}

function collectLines(sheet: IParadisSheetData, axis: 'row' | 'column'): { manual: number[]; auto: number[] } {
	const inRange = printRangeFilter(sheet, axis);
	const manual = Array.from(new Set(axis === 'row' ? (sheet.rowBreaks ?? []) : (sheet.colBreaks ?? []))).filter(inRange).sort((a, b) => a - b);
	const layoutAuto = axis === 'row' ? sheet.pageLayout?.autoRowBreaks : sheet.pageLayout?.autoColBreaks;
	const auto = (layoutAuto ?? []).filter(i => !manual.includes(i)).sort((a, b) => a - b);
	return { manual, auto };
}

/**
 * 改ページの差分。手動改ページを内容キーで突き合わせ、追加・削除・移動を求める。
 * 自動改ページ(用紙設定から計算した位置)は行の増減で普通に動くので、差分としては報告せず描画だけする。
 */
export function buildPageBreakDiff(original: IParadisSheetData | undefined, modified: IParadisSheetData | undefined): IParadisPageBreakDiff {
	const empty: IParadisPageBreakDiff = {
		originalRowLines: [], modifiedRowLines: [], originalColLines: [], modifiedColLines: [],
		originalLabels: [], modifiedLabels: [], changes: [],
	};
	if (!original || !modified) {
		return empty;
	}

	const changes: IParadisPageBreakChange[] = [];
	const buildAxis = (axis: 'row' | 'column') => {
		const o = collectLines(original, axis);
		const m = collectLines(modified, axis);
		const oStatus = new Map<number, ParadisPageBreakStatus>();
		const mStatus = new Map<number, ParadisPageBreakStatus>();
		const oTitle = new Map<number, string>();
		const mTitle = new Map<number, string>();
		const takenM = new Set<number>();

		// 1) 位置が変わっていないものは、それだけで「同じ改ページ」。
		//    列方向は中身の手掛かりが取れないので、この判定が唯一の突き合わせになる。
		for (const oi of o.manual) {
			if (m.manual.includes(oi)) {
				oStatus.set(oi, 'unchanged');
				mStatus.set(oi, 'unchanged');
				takenM.add(oi);
			}
		}

		// 2) 改ページの直後に来る中身が同じなら、行番号が変わっていても「同じ改ページ」。
		const keyOf = axis === 'row'
			? (sheet: IParadisSheetData, index: number) => anchorKeyAfter(sheet, index)
			: () => '';
		const mKeys = new Map<number, string>(m.manual.map(i => [i, keyOf(modified, i)]));
		for (const oi of o.manual) {
			if (oStatus.has(oi)) {
				continue;
			}
			const key = keyOf(original, oi);
			if (!key) {
				continue;
			}
			const hit = m.manual.find(mi => !takenM.has(mi) && mKeys.get(mi) === key);
			if (hit !== undefined) {
				takenM.add(hit);
				oStatus.set(oi, 'unchanged');
				mStatus.set(hit, 'unchanged');
			}
		}

		// 3) 残りは「何ページ目の区切りか」の順で対にして移動とみなす。
		const restO = o.manual.filter(i => !oStatus.has(i));
		const restM = m.manual.filter(i => !takenM.has(i));
		const pairCount = Math.min(restO.length, restM.length);
		for (let i = 0; i < pairCount; i++) {
			const oi = restO[i];
			const mi = restM[i];
			oStatus.set(oi, 'movedFrom');
			mStatus.set(mi, 'movedTo');
			takenM.add(mi);
			const page = pageNumberEndingAt(modified.pageLayout, axis, mi);
			const movedDetail = axis === 'row'
				? localize('paradis.spreadsheet.pageBreak.movedRowDetail', "{0} 行の下 → {1} 行の下", oi, mi)
				: localize('paradis.spreadsheet.pageBreak.movedColumnDetail', "{0} 列の右 → {1} 列の右", oi, mi);
			const movedTitle = page !== undefined
				? localize('paradis.spreadsheet.pageBreak.movedPage', "{0} ページ目の区切りが移動しました", page)
				: localize('paradis.spreadsheet.pageBreak.moved', "ページの区切りが移動しました");
			oTitle.set(oi, `${movedTitle}\n${movedDetail}`);
			mTitle.set(mi, `${movedTitle}\n${movedDetail}`);
			changes.push({
				status: 'moved',
				axis,
				originalIndex: oi,
				modifiedIndex: mi,
				side: 'modified',
				anchorRow: axis === 'row' ? mi : 1,
				title: movedTitle,
				detail: movedDetail,
			});
		}

		// 4) 余りは削除・追加。
		for (const oi of restO.slice(pairCount)) {
			oStatus.set(oi, 'removed');
			const title = localize('paradis.spreadsheet.pageBreak.removed', "ページの区切りが削除されました");
			const detail = axis === 'row'
				? localize('paradis.spreadsheet.pageBreak.removedRow', "{0} 行の下 — 前後のページがつながります", oi)
				: localize('paradis.spreadsheet.pageBreak.removedColumn', "{0} 列の右 — 左右のページがつながります", oi);
			oTitle.set(oi, `${title}\n${detail}`);
			changes.push({
				status: 'removed',
				axis,
				originalIndex: oi,
				side: 'original',
				anchorRow: axis === 'row' ? oi : 1,
				title,
				detail,
			});
		}
		for (const mi of restM.slice(pairCount)) {
			mStatus.set(mi, 'added');
			const title = localize('paradis.spreadsheet.pageBreak.added', "ページの区切りが追加されました");
			const detail = axis === 'row'
				? localize('paradis.spreadsheet.pageBreak.addedRow', "{0} 行の下 — ここから新しいページになります", mi)
				: localize('paradis.spreadsheet.pageBreak.addedColumn', "{0} 列の右 — ここから新しいページになります", mi);
			mTitle.set(mi, `${title}\n${detail}`);
			changes.push({
				status: 'added',
				axis,
				modifiedIndex: mi,
				side: 'modified',
				anchorRow: axis === 'row' ? mi : 1,
				title,
				detail,
			});
		}

		const toLines = (source: { manual: number[]; auto: number[] }, status: Map<number, ParadisPageBreakStatus>, titles: Map<number, string>): IParadisPageBreakLine[] => [
			...source.manual.map(index => ({
				index,
				kind: 'manual' as const,
				status: status.get(index) ?? 'unchanged',
				...(titles.has(index) ? { title: titles.get(index) } : {}),
			})),
			...source.auto.map(index => ({ index, kind: 'auto' as const })),
		];
		return { originalLines: toLines(o, oStatus, oTitle), modifiedLines: toLines(m, mStatus, mTitle) };
	};

	const rows = buildAxis('row');
	const cols = buildAxis('column');

	// ページ番号の振り直し(同じ中身が別のページ番号に載るようになった)。
	const originalPages = original.pageLayout ? pageRectangles(original.pageLayout) : [];
	const modifiedPages = modified.pageLayout ? pageRectangles(modified.pageLayout) : [];
	const movedPages = new Set<number>();
	if (originalPages.length && modifiedPages.length) {
		const modByKey = new Map<string, number>();
		for (const rect of modifiedPages) {
			const key = pageKey(modified, rect);
			if (key && !modByKey.has(key)) {
				modByKey.set(key, rect.page);
			}
		}
		const repaged: { from: number; to: number; fromRow: number }[] = [];
		for (const rect of originalPages) {
			const key = pageKey(original, rect);
			const to = key ? modByKey.get(key) : undefined;
			if (to !== undefined && to !== rect.page) {
				movedPages.add(to);
				repaged.push({ from: rect.page, to, fromRow: rect.fromRow });
			}
		}
		const first = repaged[0];
		if (first) {
			changes.push({
				status: 'repaged',
				axis: 'row',
				side: 'modified',
				anchorRow: modifiedPages.find(p => p.page === first.to)?.fromRow ?? 1,
				title: repaged.length === 1
					? localize('paradis.spreadsheet.pageBreak.repaged', "同じ内容が {0} ページ目から {1} ページ目に移りました", first.from, first.to)
					: localize('paradis.spreadsheet.pageBreak.repagedMany', "{0} ページ目から先のページ番号がずれました（{1} ページ分）", first.from, repaged.length),
				detail: localize('paradis.spreadsheet.pageBreak.repagedDetail', "変更前に {0} 行から始まっていたページが起点です", first.fromRow),
			});
		}
	}

	const labelsFor = (pages: readonly IParadisPageRectangle[], highlight: ReadonlySet<number>): IParadisPageLabelBox[] =>
		pages.length > 1
			? pages.map(rect => ({
				text: pageLabelText(rect.page),
				fromRow: rect.fromRow,
				toRow: rect.toRow,
				fromCol: rect.fromCol,
				toCol: rect.toCol,
				...(highlight.has(rect.page) ? { changed: true } : {}),
			}))
			: [];

	return {
		originalRowLines: rows.originalLines,
		modifiedRowLines: rows.modifiedLines,
		originalColLines: cols.originalLines,
		modifiedColLines: cols.modifiedLines,
		originalLabels: labelsFor(originalPages, new Set()),
		modifiedLabels: labelsFor(modifiedPages, movedPages),
		changes,
	};
}

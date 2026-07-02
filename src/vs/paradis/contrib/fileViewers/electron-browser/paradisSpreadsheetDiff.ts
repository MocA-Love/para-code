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

import { IParadisCellData, IParadisSheetData } from '../common/paradisSpreadsheet.js';

export type ParadisDiffStatus = 'added' | 'removed' | 'modified';

export interface IParadisDiffSegment {
	readonly text: string;
	readonly type: 'added' | 'removed' | 'unchanged';
}

export interface IParadisDiffCell extends IParadisCellData {
	readonly diffStatus?: ParadisDiffStatus;
	readonly diffSegments?: readonly IParadisDiffSegment[];
}

export interface IParadisDiffRow {
	readonly cells: readonly IParadisDiffCell[];
	readonly height: number;
}

export interface IParadisDiffSheet {
	readonly name: string;
	readonly originalRows: readonly IParadisDiffRow[];
	readonly modifiedRows: readonly IParadisDiffRow[];
	readonly columnCount: number;
	readonly columnWidths: readonly number[];
	readonly sheetStatus?: 'added' | 'removed';
}

// 文字レベル差分が大きすぎる場合の粗いフォールバック閾値(n*m)。
const MAX_CHAR_DIFF_CELLS = 4_000_000;

interface CharRun {
	value: string;
	type: 'unchanged' | 'added' | 'removed';
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
		cells: row.cells.map(c => ({ ...c, diffStatus: c.value ? status : undefined })),
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
					origCells.push(emptyCell);
					modCells.push({ ...modCell, diffStatus: modCell.value ? 'added' : undefined });
				} else if (origCell && !modCell) {
					origCells.push({ ...origCell, diffStatus: origCell.value ? 'removed' : undefined });
					modCells.push(emptyCell);
				} else if (origCell && modCell) {
					const changed = origCell.value !== modCell.value;
					origCells.push({
						...origCell,
						diffStatus: changed ? 'modified' : undefined,
						diffSegments: changed ? computeDiffSegments(origCell.value, modCell.value, 'original') : undefined,
					});
					modCells.push({
						...modCell,
						diffStatus: changed ? 'modified' : undefined,
						diffSegments: changed ? computeDiffSegments(origCell.value, modCell.value, 'modified') : undefined,
					});
				} else {
					origCells.push(emptyCell);
					modCells.push(emptyCell);
				}
			}

			origRows.push({ cells: origCells, height: origRow?.height ?? modRow?.height ?? 20 });
			modRows.push({ cells: modCells, height: modRow?.height ?? origRow?.height ?? 20 });
		}

		result.push({ name, originalRows: origRows, modifiedRows: modRows, columnCount: maxCols, columnWidths: colWidths });
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

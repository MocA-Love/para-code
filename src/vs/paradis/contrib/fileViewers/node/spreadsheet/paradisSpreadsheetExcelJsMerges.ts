/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// exceljs の結合セルの読み込みを速くする。
//
// exceljs 4.4.0 は、ブックを読むときに結合セルを 1 つ足すたびに、既にある全部の結合と重なりを比べる
// （`Worksheet._mergeCellsInternal`）。結合が M 個あると M^2/2 回比べるので、結合が数千ある方眼紙の
// 帳票では、ブックの解析時間の 3 割ほどがここに使われていた。重なりの確認を「結合で覆われたセルの集合」
// で行い、結合の適用は exceljs のコードのまま使う。結果（結合の一覧・各セルの結合先）は変わらない。
//
// exceljs の内部（`_parseMergeCells`・`_merges`）に依存するので、入れる前に小さなシートで形を確かめ、
// 合わなければ何もしない（遅いが今までどおり動く）。テストは exceljs の版を 4.4.0 に固定して確かめている。

import type ExcelJS from 'exceljs';

/** 差し替えを確かめた exceljs の版。上げたら、テストと内部の形を見直す。 */
export const PARADIS_EXCELJS_MERGE_FAST_PATH_VERSION = '4.4.0';

/** exceljs の `Range` のうち、使う部分。 */
interface IExcelJsMergeRange {
	readonly top: number;
	readonly left: number;
	readonly bottom: number;
	readonly right: number;
	readonly range: string;
}

/** exceljs の `Worksheet` のうち、使う内部。 */
interface IExcelJsWorksheetInternals {
	_merges: Record<string, IExcelJsMergeRange>;
	mergeCellsWithoutStyle(range: unknown): void;
}

type ExcelJsMergeCellsModel = { readonly mergeCells?: readonly unknown[] | Readonly<Record<string, unknown>> } | undefined;

interface IExcelJsWorksheetPrototype {
	_parseMergeCells(this: IExcelJsWorksheetInternals, model: ExcelJsMergeCellsModel): void;
}

/** 列の数の上限（XFD 列）。セルの番号を 1 つの数にまとめるのに使う。 */
const EXCEL_MAX_COLUMNS = 16_384;

/** 差し替えた prototype と、差し替える前の関数。 */
const installedPrototypes = new WeakMap<object, IExcelJsWorksheetPrototype['_parseMergeCells']>();

/**
 * exceljs の結合セルの読み込みを、重なりの確認だけ速い方法に差し替える。
 * 差し替えた（または既に差し替えてある）なら `true`、内部の形が合わず差し替えなかったなら `false`。
 */
export function installParadisExcelJsMergeFastPath(runtime: Pick<typeof ExcelJS, 'Workbook'>): boolean {
	let probe: IExcelJsWorksheetInternals;
	let prototype: Partial<IExcelJsWorksheetPrototype>;
	try {
		probe = new runtime.Workbook().addWorksheet('probe') as unknown as IExcelJsWorksheetInternals;
		prototype = Object.getPrototypeOf(probe) as Partial<IExcelJsWorksheetPrototype>;
	} catch {
		return false;
	}
	if (installedPrototypes.has(prototype)) {
		return true;
	}
	if (!hasExpectedMergeInternals(probe, prototype)) {
		return false;
	}
	const original = prototype._parseMergeCells;
	prototype._parseMergeCells = function (this: IExcelJsWorksheetInternals, model: ExcelJsMergeCellsModel): void {
		const merges = model?.mergeCells;
		if (!merges) {
			return;
		}
		const merged = this._merges;
		const covered = new Set<number>();
		for (const range of Object.values(merged)) {
			cover(covered, range);
		}
		const list = Array.isArray(merges) ? merges : Object.values(merges);
		for (const merge of list) {
			// exceljs は結合を足す前に `_merges` の全部と重なりを比べる。空の `_merges` を見せて比べる相手を無くし、
			// 重なりは覆われたセルの集合で確かめる。重なっていたら exceljs と同じ例外で読み込みを止める。
			this._merges = {};
			let added: Record<string, IExcelJsMergeRange>;
			try {
				this.mergeCellsWithoutStyle(merge);
			} finally {
				added = this._merges;
				this._merges = merged;
			}
			for (const [address, range] of Object.entries(added)) {
				if (!cover(covered, range)) {
					throw new Error('Cannot merge already merged cells');
				}
				merged[address] = range;
			}
		}
	};
	installedPrototypes.set(prototype, original);
	return true;
}

/** テスト用: `run` の間だけ exceljs のもとの結合の読み込みに戻す（差し替えの前後で結果が同じかを比べる）。 */
export async function withOriginalExcelJsMergesForTest<T>(runtime: Pick<typeof ExcelJS, 'Workbook'>, run: () => Promise<T>): Promise<T> {
	const prototype = Object.getPrototypeOf(new runtime.Workbook().addWorksheet('probe')) as IExcelJsWorksheetPrototype;
	const original = installedPrototypes.get(prototype);
	if (!original) {
		return run();
	}
	const fast = prototype._parseMergeCells;
	prototype._parseMergeCells = original;
	try {
		return await run();
	} finally {
		prototype._parseMergeCells = fast;
	}
}

/**
 * 結合の範囲の一覧（`A1:B2` の形）。`worksheet.model.merges` と同じ並びと中身を、シート全体のモデルを
 * 組み立てずに返す（`model` の getter は全行・全列のモデルを毎回作り直すので、結合だけ欲しいときに重い）。
 * 内部の形が合わなければ `model` から読む。
 */
export function paradisExcelJsMergeRanges(worksheet: ExcelJS.Worksheet): readonly string[] {
	const merges = (worksheet as unknown as Partial<IExcelJsWorksheetInternals>)._merges;
	if (merges && typeof merges === 'object') {
		const ranges: string[] = [];
		for (const range of Object.values(merges)) {
			if (typeof range?.range !== 'string') {
				return (worksheet.model as { merges?: string[] } | undefined)?.merges ?? [];
			}
			ranges.push(range.range);
		}
		return ranges;
	}
	return (worksheet.model as { merges?: string[] } | undefined)?.merges ?? [];
}

/** 範囲のセルを覆う。既に覆われたセルがあれば `false`（範囲の一部を覆ったまま返す。呼び出し側は読み込みを止める）。 */
function cover(covered: Set<number>, range: IExcelJsMergeRange): boolean {
	for (let row = range.top; row <= range.bottom; row++) {
		for (let column = range.left; column <= range.right; column++) {
			const key = row * EXCEL_MAX_COLUMNS + column;
			if (covered.has(key)) {
				return false;
			}
			covered.add(key);
		}
	}
	return true;
}

/** 差し替えの前提にしている内部の形を、使い捨てのシートで確かめる。 */
function hasExpectedMergeInternals(probe: IExcelJsWorksheetInternals, prototype: Partial<IExcelJsWorksheetPrototype>): prototype is IExcelJsWorksheetPrototype {
	try {
		if (typeof prototype._parseMergeCells !== 'function' || typeof probe.mergeCellsWithoutStyle !== 'function' || !probe._merges || typeof probe._merges !== 'object') {
			return false;
		}
		probe.mergeCellsWithoutStyle('B2:C3');
		const entries = Object.entries(probe._merges);
		if (entries.length !== 1) {
			return false;
		}
		const [address, range] = entries[0];
		return address === 'B2' && range.range === 'B2:C3' && range.top === 2 && range.left === 2 && range.bottom === 3 && range.right === 3;
	} catch {
		return false;
	}
}

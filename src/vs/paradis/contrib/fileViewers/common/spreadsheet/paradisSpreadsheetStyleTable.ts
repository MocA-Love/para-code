/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の解析結果を shared process から renderer へ渡すときに、セルの書式をブックごとの表にまとめる。
//
// 解析結果のほとんどはセルの書式（CSS のプロパティと値の組）で、同じ書式が何千ものセルで繰り返される。
// 渡すときは書式を表にし、セルは表の番号だけを持つ（実ファイルで受け渡しの JSON がおよそ半分になる）。
// 受け取った側（`paradisSpreadsheetClient.ts`）で元の形に戻すので、ビューア・差分・モバイル向けの表示は
// 今までと同じ `IParadisWorkbookData` を使う。戻した書式は同じ内容のセルで 1 つのオブジェクトを共有する
// （書式は読むだけで書き換えない）。

import type { IParadisCellData, IParadisCellStyle, IParadisRowData, IParadisSheetData, IParadisWorkbookData } from '../paradisSpreadsheet.js';

/** 書式を表の番号にしたセル。 */
export interface IParadisPackedCellData extends Omit<IParadisCellData, 'style'> {
	readonly style: number;
}

export interface IParadisPackedRowData extends Omit<IParadisRowData, 'cells'> {
	readonly cells: readonly IParadisPackedCellData[];
}

export interface IParadisPackedSheetData extends Omit<IParadisSheetData, 'rows'> {
	readonly rows: readonly IParadisPackedRowData[];
}

/** 受け渡しの形。`cellStyles` が書式の表。 */
export interface IParadisPackedWorkbookData extends Omit<IParadisWorkbookData, 'sheets'> {
	readonly cellStyles: readonly IParadisCellStyle[];
	readonly sheets: readonly IParadisPackedSheetData[];
}

/** 書式の中身から作る鍵。プロパティの並びも含める（戻したときに元と同じ並びになるように）。 */
function styleKey(style: IParadisCellStyle): string {
	let key = '';
	for (const property in style) {
		key += `${property}\u0001${style[property]}\u0002`;
	}
	return key;
}

/** セルの書式を表にまとめる。 */
export function packParadisWorkbookStyles(workbook: IParadisWorkbookData): IParadisPackedWorkbookData {
	const indexes = new Map<string, number>();
	const cellStyles: IParadisCellStyle[] = [];
	const sheets = workbook.sheets.map((sheet): IParadisPackedSheetData => ({
		...sheet,
		rows: sheet.rows.map((row): IParadisPackedRowData => ({
			...row,
			cells: row.cells.map((cell): IParadisPackedCellData => {
				const key = styleKey(cell.style);
				let index = indexes.get(key);
				if (index === undefined) {
					index = cellStyles.length;
					indexes.set(key, index);
					cellStyles.push(cell.style);
				}
				return { ...cell, style: index };
			}),
		})),
	}));
	return { ...workbook, cellStyles, sheets };
}

function isPacked(workbook: IParadisWorkbookData | IParadisPackedWorkbookData): workbook is IParadisPackedWorkbookData {
	return Array.isArray((workbook as Partial<IParadisPackedWorkbookData>).cellStyles);
}

/**
 * 表にまとめた書式を、セルごとの書式に戻す。まとめていない形（古い shared process・SSH の接続先から
 * 届いたもの）はそのまま返す。表に無い番号の書式は空にする。
 */
export function unpackParadisWorkbookStyles(workbook: IParadisWorkbookData | IParadisPackedWorkbookData): IParadisWorkbookData {
	if (!isPacked(workbook)) {
		return workbook;
	}
	const cellStyles = workbook.cellStyles;
	const empty: IParadisCellStyle = {};
	const sheets = workbook.sheets.map((sheet): IParadisSheetData => ({
		...sheet,
		rows: sheet.rows.map((row): IParadisRowData => ({
			...row,
			cells: row.cells.map((cell): IParadisCellData => ({ ...cell, style: (Number.isInteger(cell.style) ? cellStyles[cell.style] : undefined) ?? empty })),
		})),
	}));
	// 項目の並びも元のまま戻す（`sheets` を先頭のまま置き、表だけを外す）。
	const unpacked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(workbook)) {
		if (key !== 'cellStyles') {
			unpacked[key] = key === 'sheets' ? sheets : value;
		}
	}
	return unpacked as unknown as IParadisWorkbookData;
}

/**
 * {@link unpackParadisWorkbookStyles} と同じものを、写しを作らずに `workbook` を書き換えて返す。
 * 復号した直後で、ほかに誰も持っていないブックだけに使う（セル数に比例する写しを作らない）。
 */
export function unpackParadisWorkbookStylesInPlace(workbook: IParadisWorkbookData | IParadisPackedWorkbookData): IParadisWorkbookData {
	if (!isPacked(workbook)) {
		return workbook;
	}
	const cellStyles = workbook.cellStyles;
	const empty: IParadisCellStyle = {};
	for (const sheet of workbook.sheets) {
		for (const row of sheet.rows) {
			for (const cell of row.cells) {
				const style: unknown = cell.style;
				(cell as unknown as { style: IParadisCellStyle }).style = (Number.isInteger(style) ? cellStyles[style as number] : undefined) ?? empty;
			}
		}
	}
	delete (workbook as { cellStyles?: unknown }).cellStyles;
	return workbook as unknown as IParadisWorkbookData;
}

/**
 * 書式を表にまとめたブックを JSON のバイト列にする（解析の worker の中で使う）。shared process はこれを開かずに
 * renderer へ中継するので、大きなブックの写しと文字列化が shared process 本体で走らない。
 */
export function encodeParadisWorkbookJson(workbook: IParadisPackedWorkbookData): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(workbook));
}

/** {@link encodeParadisWorkbookJson} で作ったバイト列を戻す。 */
export function decodeParadisWorkbookJson(json: Uint8Array): IParadisPackedWorkbookData {
	return JSON.parse(new TextDecoder().decode(json)) as IParadisPackedWorkbookData;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分で共有する型とIPCチャネル名。xlsx のパースは exceljs を使う都合上 shared process
// （node層）で行い、ここで定義する「プレーンにシリアライズ可能な」構造化データを renderer へ返す。
// スタイルは CSS プロパティ名(camelCase)→値文字列 のプレーンオブジェクトで、renderer 側で
// Object.assign(element.style, style) によりそのまま適用できる。

import type { IParadisPageLayout } from './paradisSpreadsheetPageLayout.js';
import type { ParadisSemanticBorder, ParadisSemanticCell, ParadisSpreadsheetProjectionDiagnostic, ParadisSpreadsheetSnapshot } from './spreadsheet/paradisSpreadsheetSemantic.js';

/** workbench(renderer) ⇔ shared process 間の Excel パース用IPCチャネル名。 */
export const PARADIS_SPREADSHEET_CHANNEL = 'paradisSpreadsheet';

/** CSSプロパティ(camelCase)→値。renderer で Object.assign(el.style, ...) して適用する。 */
export interface IParadisCellStyle {
	readonly [cssProperty: string]: string;
}

/** リッチテキストの1ラン(部分文字列+スタイル)。 */
export interface IParadisRichTextPart {
	readonly text: string;
	readonly style: IParadisCellStyle;
}

/** セルの対角罫線(border.diagonal)。 */
export interface IParadisDiagonalBorder {
	/** 左下→右上。 */
	readonly up: boolean;
	/** 左上→右下。 */
	readonly down: boolean;
	/** CSS 罫線の太さ・種別(例 "1px solid")。 */
	readonly style: string;
	readonly color: string;
}

/** 図形のアンカー位置(セル基準 + EMU オフセット。col/row は0始まり)。 */
export interface IParadisRenderAnchor {
	readonly c: number;
	readonly co: number;
	readonly r: number;
	readonly ro: number;
}

/** シート上に描画された図形(直線コネクタ/矩形/画像)。重説等の斜線はこの直線コネクタで表現される。 */
export interface IParadisRenderShape {
	readonly type: 'line' | 'rect' | 'image';
	readonly flipV: boolean;
	readonly flipH: boolean;
	readonly from: IParadisRenderAnchor;
	readonly to: IParadisRenderAnchor;
	readonly outlineWidth: number;
	readonly outlineColor: string;
	readonly dash: string;
	/** 画像(type='image')の data URI。 */
	readonly href?: string;
	/** oneCellAnchor 画像のサイズ(EMU)。to が無い場合に from + ext で矩形化する。 */
	readonly ext?: { readonly cx: number; readonly cy: number };
	/** 図形の安定キー(diff用)。cNvPr の name/id。 */
	readonly name?: string;
	readonly shapeId?: string;
}

/** shared process が drawing ごとに渡す XML と埋め込みメディア(rId→dataURI)。 */
export interface IParadisDrawingData {
	readonly xml: string;
	readonly media: { readonly [rid: string]: string };
}

/** 印刷範囲などの矩形領域(Excel の1始まり行列)。 */
export interface IParadisCellRange {
	readonly minR: number;
	readonly maxR: number;
	readonly minC: number;
	readonly maxC: number;
}

/** Excel の入力規則。diff で安定比較できるよう、式・値は文字列へ正規化して保持する。 */
export interface IParadisDataValidation {
	readonly type: 'any' | 'list' | 'whole' | 'decimal' | 'date' | 'time' | 'textLength' | 'custom';
	readonly operator?: 'between' | 'notBetween' | 'equal' | 'notEqual' | 'greaterThan' | 'lessThan' | 'greaterThanOrEqual' | 'lessThanOrEqual';
	readonly formulae: readonly string[];
	readonly allowBlank?: boolean;
	readonly showInputMessage?: boolean;
	readonly promptTitle?: string;
	readonly prompt?: string;
	readonly showErrorMessage?: boolean;
	readonly errorStyle?: string;
	readonly errorTitle?: string;
	readonly error?: string;
}

/** 入力規則を連続矩形のまま保持する。表示矩形外の規則も展開せずdiff対象にするために使う。 */
export interface IParadisDataValidationEntry {
	readonly range: IParadisCellRange;
	readonly validation: IParadisDataValidation;
}

function dataValidationKey(validation: IParadisDataValidation): string {
	return JSON.stringify([
		validation.type,
		validation.operator ?? null,
		validation.formulae,
		validation.allowBlank ?? false,
		validation.showInputMessage ?? false,
		validation.promptTitle ?? null,
		validation.prompt ?? null,
		validation.showErrorMessage ?? false,
		validation.errorStyle ?? 'stop',
		validation.errorTitle ?? null,
		validation.error ?? null,
	]);
}

/** 同じ意味の隣接・重複範囲を安定した矩形集合へまとめる。 */
export function canonicalizeDataValidationEntries(entries: readonly IParadisDataValidationEntry[]): readonly IParadisDataValidationEntry[] {
	type KeyedEntry = { range: IParadisCellRange; validation: IParadisDataValidation; key: string };
	const source: KeyedEntry[] = entries.map(entry => ({ range: { ...entry.range }, validation: entry.validation, key: dataValidationKey(entry.validation) }));
	const merge = (items: readonly KeyedEntry[], axis: 'vertical' | 'horizontal'): KeyedEntry[] => {
		const sorted = [...items].sort((a, b) => {
			const keyOrder = a.key.localeCompare(b.key);
			if (keyOrder !== 0) {
				return keyOrder;
			}
			return axis === 'vertical'
				? a.range.minC - b.range.minC || a.range.maxC - b.range.maxC || a.range.minR - b.range.minR || a.range.maxR - b.range.maxR
				: a.range.minR - b.range.minR || a.range.maxR - b.range.maxR || a.range.minC - b.range.minC || a.range.maxC - b.range.maxC;
		});
		const result: KeyedEntry[] = [];
		for (const item of sorted) {
			const previous = result[result.length - 1];
			const canMerge = previous?.key === item.key && (axis === 'vertical'
				? previous.range.minC === item.range.minC && previous.range.maxC === item.range.maxC && item.range.minR <= previous.range.maxR + 1
				: previous.range.minR === item.range.minR && previous.range.maxR === item.range.maxR && item.range.minC <= previous.range.maxC + 1);
			if (previous && canMerge) {
				previous.range = axis === 'vertical'
					? { ...previous.range, minR: Math.min(previous.range.minR, item.range.minR), maxR: Math.max(previous.range.maxR, item.range.maxR) }
					: { ...previous.range, minC: Math.min(previous.range.minC, item.range.minC), maxC: Math.max(previous.range.maxC, item.range.maxC) };
			} else {
				result.push({ ...item, range: { ...item.range } });
			}
		}
		return result;
	};
	let canonical = source;
	// 交互方向の分割でも通常は数回で収束する。反復上限を固定し、多数sqrefでも O(N log N) を保つ。
	for (let pass = 0; pass < 8; pass++) {
		const next = merge(merge(canonical, 'vertical'), 'horizontal');
		if (next.length === canonical.length) {
			return next.map(({ range, validation }) => ({ range, validation }));
		}
		canonical = next;
	}
	return canonical.map(({ range, validation }) => ({ range, validation }));
}

function validationRangesCoverSame(original: readonly IParadisCellRange[], modified: readonly IParadisCellRange[]): boolean {
	if (original.length === 0 || modified.length === 0) {
		return original.length === modified.length;
	}
	type RangeEvent = { readonly row: number; readonly side: 0 | 1; readonly delta: 1 | -1; readonly minC: number; readonly maxCExclusive: number };
	const events: RangeEvent[] = [];
	const columnBoundaries = new Set<number>();
	const appendEvents = (ranges: readonly IParadisCellRange[], side: 0 | 1): void => {
		for (const range of ranges) {
			const maxCExclusive = range.maxC + 1;
			columnBoundaries.add(range.minC);
			columnBoundaries.add(maxCExclusive);
			events.push(
				{ row: range.minR, side, delta: 1, minC: range.minC, maxCExclusive },
				{ row: range.maxR + 1, side, delta: -1, minC: range.minC, maxCExclusive },
			);
		}
	};
	appendEvents(original, 0);
	appendEvents(modified, 1);
	const columns = [...columnBoundaries].sort((a, b) => a - b);
	const columnIndex = new Map(columns.map((column, index) => [column, index]));
	const segmentCount = columns.length - 1;
	const size = Math.max(1, segmentCount * 4 + 4);
	const coverOriginal = new Int32Array(size);
	const coverModified = new Int32Array(size);
	const lengthOriginal = new Float64Array(size);
	const lengthModified = new Float64Array(size);
	const lengthIntersection = new Float64Array(size);
	const pull = (node: number, left: number, right: number): void => {
		const totalLength = columns[right] - columns[left];
		const childOriginal = right - left === 1 ? 0 : lengthOriginal[node * 2] + lengthOriginal[node * 2 + 1];
		const childModified = right - left === 1 ? 0 : lengthModified[node * 2] + lengthModified[node * 2 + 1];
		const childIntersection = right - left === 1 ? 0 : lengthIntersection[node * 2] + lengthIntersection[node * 2 + 1];
		lengthOriginal[node] = coverOriginal[node] > 0 ? totalLength : childOriginal;
		lengthModified[node] = coverModified[node] > 0 ? totalLength : childModified;
		lengthIntersection[node] = coverOriginal[node] > 0
			? coverModified[node] > 0 ? totalLength : lengthModified[node]
			: coverModified[node] > 0 ? lengthOriginal[node] : childIntersection;
	};
	const update = (node: number, left: number, right: number, start: number, end: number, side: 0 | 1, delta: 1 | -1): void => {
		if (start <= left && right <= end) {
			(side === 0 ? coverOriginal : coverModified)[node] += delta;
			pull(node, left, right);
			return;
		}
		const middle = Math.floor((left + right) / 2);
		if (start < middle) {
			update(node * 2, left, middle, start, end, side, delta);
		}
		if (end > middle) {
			update(node * 2 + 1, middle, right, start, end, side, delta);
		}
		pull(node, left, right);
	};
	events.sort((a, b) => a.row - b.row);
	let previousRow = events[0].row;
	let index = 0;
	while (index < events.length) {
		const row = events[index].row;
		const symmetricDifferenceLength = lengthOriginal[1] + lengthModified[1] - 2 * lengthIntersection[1];
		if (row > previousRow && symmetricDifferenceLength !== 0) {
			return false;
		}
		while (index < events.length && events[index].row === row) {
			const event = events[index++];
			update(1, 0, segmentCount, columnIndex.get(event.minC)!, columnIndex.get(event.maxCExclusive)!, event.side, event.delta);
		}
		previousRow = row;
	}
	return true;
}

/** 範囲の分割方法に依存せず、各規則が覆う実効領域が同じかを比較する。 */
export function dataValidationEntriesCoverSame(original: readonly IParadisDataValidationEntry[], modified: readonly IParadisDataValidationEntry[]): boolean {
	const group = (entries: readonly IParadisDataValidationEntry[]): Map<string, IParadisCellRange[]> => {
		const result = new Map<string, IParadisCellRange[]>();
		for (const entry of entries) {
			const key = dataValidationKey(entry.validation);
			const ranges = result.get(key) ?? [];
			ranges.push(entry.range);
			result.set(key, ranges);
		}
		return result;
	};
	const originalGroups = group(original);
	const modifiedGroups = group(modified);
	for (const key of new Set([...originalGroups.keys(), ...modifiedGroups.keys()])) {
		if (!validationRangesCoverSame(originalGroups.get(key) ?? [], modifiedGroups.get(key) ?? [])) {
			return false;
		}
	}
	return true;
}

/** 1セルの表示データ。 */
export interface IParadisCellData {
	readonly value: string;
	readonly style: IParadisCellStyle;
	readonly colSpan?: number;
	readonly rowSpan?: number;
	/** 結合セルの従属セル(描画スキップ対象)。 */
	readonly hidden?: boolean;
	readonly wrapText?: boolean;
	readonly verticalText?: boolean;
	readonly shrinkToFit?: boolean;
	readonly richText?: readonly IParadisRichTextPart[];
	readonly diagonal?: IParadisDiagonalBorder;
	/** このセルに設定された入力規則。 */
	readonly dataValidation?: IParadisDataValidation;
}

/** 1行(Excelの行番号1始まり、表示高さpx、セル配列)。 */
export interface IParadisRowData {
	readonly excelRow: number;
	readonly cells: readonly IParadisCellData[];
	readonly height: number;
}

/** 1シート。 */
export interface IParadisSheetData {
	readonly name: string;
	readonly rows: readonly IParadisRowData[];
	readonly columnCount: number;
	readonly columnWidths: readonly number[];
	/** MAX_ROWS を超えて打ち切ったか。 */
	readonly truncated: boolean;
	/** データ先頭列(Excelの1始まり)。 */
	readonly minCol: number;
	/** 表示範囲外を含む、このシート上の入力規則。 */
	readonly dataValidations?: readonly IParadisDataValidationEntry[];
	/** このシートの図形(renderer 側で drawing XML から解析して付与)。 */
	readonly shapes?: readonly IParadisRenderShape[];
	/** 画面グリッド線を表示するか(sheetView.showGridLines、既定 true)。 */
	readonly showGridLines?: boolean;
	/** 保存時のズーム倍率(sheetView.zoomScale、100=等倍)。 */
	readonly zoomScale?: number;
	/** シートタブの色(hex)。 */
	readonly tabColor?: string;
	/** シート保護が有効か(sheetProtection.sheet===true)。 */
	readonly protectedSheet?: boolean;
	/** 手動改ページの行(その行の下端で改ページ。Excelの1始まり行番号)。 */
	readonly rowBreaks?: readonly number[];
	/** 手動改ページの列(その列の右端で改ページ。Excelの1始まり列番号)。 */
	readonly colBreaks?: readonly number[];
	/** 印刷範囲(あれば)。 */
	readonly printArea?: IParadisCellRange;
	/** 手動改ページ＋用紙設定から求めたページ割り(自動改ページとページ番号)。 */
	readonly pageLayout?: IParadisPageLayout;
}

/** パース結果のワークブック全体。 */
export interface IParadisWorkbookData {
	readonly sheets: readonly IParadisSheetData[];
	/**
	 * シート番号(1始まり、eachSheet=表示順)→ そのシートが参照する drawing(XML + 埋め込みメディア)の配列。
	 * 図形/画像の解析には DOMParser が必要で node 層では使えないため、XML と media(rId→dataURI)を渡し renderer で解析する。
	 */
	readonly drawingsBySheet?: { readonly [sheetIndex: number]: readonly IParadisDrawingData[] };
	/** theme1.xml の clrScheme 色(scheme名 lt1/dk1/accent1... → hex)。図形の schemeClr 解決に renderer 側で使う。 */
	readonly themeColors?: { readonly [schemeName: string]: string };
}

const MAX_SEMANTIC_PROJECTION_DIAGNOSTICS = 10_000;
const SEMANTIC_BORDER_STYLES: Readonly<Record<string, string>> = {
	thin: '1px solid', medium: '2px solid', thick: '3px solid', dotted: '1px dotted',
	dashed: '1px dashed', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed',
	dashDotDot: '1px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed',
	slantDashDot: '1px dashed', hair: '1px solid',
};

interface IParadisSpreadsheetProjectionDiagnosticOptions {
	readonly checkpoint?: () => void;
	readonly consumeProjectionSheet?: () => void;
	readonly consumeProjectionRow?: () => void;
	readonly consumeProjectionCell?: () => void;
}

interface IIndexedParadisProjectionSheet {
	readonly sheet: IParadisSheetData;
	readonly rows: ReadonlyMap<number, IParadisRowData>;
}

/**
 * Compares the legacy ExcelJS render projection with the raw OOXML semantic model.
 * Diagnostics are intentionally one-way: no projected value or normalized border mutates the snapshot.
 */
export function diagnoseSpreadsheetProjection(
	snapshot: ParadisSpreadsheetSnapshot,
	projection: IParadisWorkbookData,
	options: IParadisSpreadsheetProjectionDiagnosticOptions = {},
): readonly ParadisSpreadsheetProjectionDiagnostic[] {
	const diagnostics: ParadisSpreadsheetProjectionDiagnostic[] = [];
	const indexedSheets: IIndexedParadisProjectionSheet[] = [];
	const indexedSheetsByName = new Map<string, IIndexedParadisProjectionSheet>();
	for (const sheet of projection.sheets) {
		options.consumeProjectionSheet?.();
		options.checkpoint?.();
		const rows = new Map<number, IParadisRowData>();
		for (const row of sheet.rows) {
			options.consumeProjectionRow?.();
			options.checkpoint?.();
			for (let index = 0; index < row.cells.length; index++) {
				options.consumeProjectionCell?.();
				options.checkpoint?.();
			}
			rows.set(row.excelRow, row);
		}
		const indexed = { sheet, rows };
		indexedSheets.push(indexed);
		if (!indexedSheetsByName.has(sheet.name)) {
			indexedSheetsByName.set(sheet.name, indexed);
		}
	}
	for (const semanticSheet of snapshot.sheets) {
		options.checkpoint?.();
		const orderedSheet = indexedSheets[semanticSheet.order];
		const projected = orderedSheet?.sheet.name === semanticSheet.name ? orderedSheet : indexedSheetsByName.get(semanticSheet.name);
		if (!projected) {
			diagnostics.push({ kind: 'sheetMissing', sheetName: semanticSheet.name });
			if (diagnostics.length >= MAX_SEMANTIC_PROJECTION_DIAGNOSTICS) {
				break;
			}
			continue;
		}
		for (const [cellAddress, semanticCell] of semanticSheet.cells) {
			options.checkpoint?.();
			const coordinate = parseSemanticCellAddress(cellAddress);
			if (!coordinate) {
				continue;
			}
			const projectedCell = projected.rows.get(coordinate.row)?.cells[coordinate.column - projected.sheet.minCol];
			if (!projectedCell) {
				diagnostics.push({ kind: 'cellMissing', sheetName: semanticSheet.name, cellAddress });
			} else {
				const semanticValue = semanticProjectionValue(semanticCell);
				if (semanticValue !== projectedCell.value) {
					diagnostics.push({
						kind: 'valueMismatch',
						sheetName: semanticSheet.name,
						cellAddress,
						semanticValue,
						projectionValue: projectedCell.value,
					});
				}
				const semanticFormat = semanticCell.styleRef === undefined ? undefined : snapshot.styles.cellFormats[semanticCell.styleRef];
				const semanticBorder = semanticFormat?.borderRef === undefined ? undefined : snapshot.styles.borders[semanticFormat.borderRef];
				if ((semanticBorder?.diagonalUp || semanticBorder?.diagonalDown)
					&& !projectionDiagonalMatches(semanticBorder, projectedCell.diagonal)) {
					diagnostics.push({ kind: 'diagonalStyleMismatch', sheetName: semanticSheet.name, cellAddress });
				}
			}
			if (diagnostics.length >= MAX_SEMANTIC_PROJECTION_DIAGNOSTICS) {
				break;
			}
		}
		if (diagnostics.length >= MAX_SEMANTIC_PROJECTION_DIAGNOSTICS) {
			break;
		}
	}
	return diagnostics.slice(0, MAX_SEMANTIC_PROJECTION_DIAGNOSTICS);
}

function projectionDiagonalMatches(semanticBorder: ParadisSemanticBorder, projected: IParadisDiagonalBorder | undefined): boolean {
	if (!projected
		|| projected.up !== (semanticBorder.diagonalUp ?? false)
		|| projected.down !== (semanticBorder.diagonalDown ?? false)) {
		return false;
	}
	const semanticStyle = semanticBorder.diagonal?.style ? SEMANTIC_BORDER_STYLES[semanticBorder.diagonal.style] : undefined;
	if (semanticStyle && semanticStyle !== projected.style) {
		return false;
	}
	const rawRgb = semanticBorder.diagonal?.color?.rgb;
	if (rawRgb) {
		const semanticColor = `#${rawRgb.slice(-6)}`.toUpperCase();
		if (semanticColor !== projected.color.toUpperCase()) {
			return false;
		}
	}
	return true;
}

function semanticProjectionValue(cell: ParadisSemanticCell): string {
	if (cell.storedType === 'formula') {
		return cell.cachedResult?.present ? cell.cachedResult.rawValue : '';
	}
	return cell.text ?? cell.rawValue ?? '';
}

function parseSemanticCellAddress(address: string): { readonly row: number; readonly column: number } | undefined {
	const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address);
	if (!match) {
		return undefined;
	}
	let column = 0;
	for (const character of match[1]) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	return { row: Number.parseInt(match[2], 10), column };
}

/** shared process 側サービスのインターフェース(チャネル越しに呼ばれる)。 */
export interface IParadisSpreadsheetService {
	/** base64エンコードされた xlsx バイト列をパースして構造化データを返す。 */
	parseWorkbook(base64Content: string): Promise<IParadisWorkbookData>;
}

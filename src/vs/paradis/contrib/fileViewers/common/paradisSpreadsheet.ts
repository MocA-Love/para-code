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
import type { ParadisSemanticBorder, ParadisSemanticCell, ParadisSpreadsheetColor, ParadisSpreadsheetDiagonalIdentity, ParadisSpreadsheetProjectionDiagnostic, ParadisSpreadsheetSnapshot } from './spreadsheet/paradisSpreadsheetSemantic.js';

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
	/** Raw OOXML/ExcelJS border token retained for semantic diagnostics; CSS style is not authoritative. */
	readonly rawStyle?: string;
	/** Raw color source retained without resolving theme/indexed/auto provenance. */
	readonly rawColor?: ParadisSpreadsheetColor;
}

/** 図形のアンカー位置(セル基準 + EMU オフセット。col/row は0始まり)。 */
export interface IParadisRenderAnchor {
	readonly c: number;
	readonly co: number;
	readonly r: number;
	readonly ro: number;
}

/** 図形の形（DrawingML の prstGeom のうち描けるもの）。`path` は custGeom を `paths` で描く。 */
export type ParadisSpreadsheetShapeGeometry =
	| 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'rtTriangle' | 'diamond'
	| 'leftBracket' | 'rightBracket' | 'leftBrace' | 'rightBrace' | 'path';

/** 図形の中の文字の 1 区切り。大きさは pt。 */
export interface IParadisShapeTextRun {
	readonly text: string;
	readonly size?: number;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly color?: string;
	readonly font?: string;
}

export interface IParadisShapeTextParagraph {
	readonly runs: readonly IParadisShapeTextRun[];
	readonly align?: 'left' | 'center' | 'right' | 'justify';
}

/** 図形の中の文字（txBody）。余白は px。 */
export interface IParadisShapeText {
	readonly paragraphs: readonly IParadisShapeTextParagraph[];
	readonly anchor?: 'top' | 'middle' | 'bottom';
	readonly vertical?: boolean;
	readonly insets: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
	readonly wrap: boolean;
}

/** custGeom の 1 本の道筋。座標は図形の枠の中の割合（0〜1）。 */
export interface IParadisShapePath {
	readonly d: readonly (readonly [command: 'M' | 'L' | 'C' | 'Q' | 'Z', ...coordinates: number[]])[];
	readonly fill: boolean;
	readonly stroke: boolean;
}

/** データラベル（`dLbls`、ECMA-376 Part 1 §21.2.2.49）。何を出すかと、どこに置くか。 */
export interface IParadisChartDataLabels {
	readonly value: boolean;
	readonly category: boolean;
	readonly series: boolean;
	readonly percent: boolean;
	/** `dLblPos`。無ければ種類ごとの既定。 */
	readonly position?: 'outEnd' | 'inEnd' | 'ctr' | 'inBase' | 't' | 'b' | 'l' | 'r' | 'bestFit';
	/** 数値の書式（`numFmt`、`sourceLinked` でないもの）。 */
	readonly formatCode?: string;
}

/** グラフの系列。 */
export interface IParadisChartSeries {
	readonly name?: string;
	readonly categories: readonly string[];
	readonly values: readonly (number | null)[];
	/** 散布図・バブルの X。 */
	readonly xValues?: readonly (number | null)[];
	/** バブルの大きさ（`bubbleSize`）。 */
	readonly bubbleSizes?: readonly (number | null)[];
	readonly color?: string;
	/** 円・ドーナツの各要素の色。 */
	readonly pointColors?: readonly string[];
	/** 値の保存された書式（`numCache` の `formatCode`）。軸やラベルが「元の書式に合わせる」ときに使う。 */
	readonly formatCode?: string;
	readonly dataLabels?: IParadisChartDataLabels;
	/** 点に印を付けるか（折れ線・レーダー・散布図）。 */
	readonly marker?: boolean;
}

/** グラフの 1 群（棒・折れ線など。複合グラフは群が複数）。 */
export interface IParadisChartGroup {
	readonly kind: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'radar' | 'bubble' | 'stock' | 'surface';
	readonly grouping: 'clustered' | 'stacked' | 'percentStacked' | 'standard';
	readonly series: readonly IParadisChartSeries[];
	/** この群が使う軸（`axId`、{@link IParadisChartAxis.id}）。 */
	readonly axisIds?: readonly string[];
	readonly dataLabels?: IParadisChartDataLabels;
	/** レーダーの描き方（`radarStyle`）。 */
	readonly radarStyle?: 'standard' | 'marker' | 'filled';
	/** バブルの大きさの倍率（`bubbleScale`、%）と、大きさが表すもの（`sizeRepresents`）。 */
	readonly bubbleScale?: number;
	readonly bubbleSizeRepresents?: 'area' | 'w';
	/** 株価の高値と安値を結ぶ線（`hiLowLines`）と、始値と終値の箱（`upDownBars`）の色。 */
	readonly hiLowLines?: boolean;
	readonly upDownBars?: { readonly up: string; readonly down: string };
	/** 等高線の帯の色（帯の番号順）。 */
	readonly bandColors?: readonly string[];
	/** 3D の面を上から見た塗り分けで近似したか。 */
	readonly surface3D?: boolean;
}

/** グラフの軸（`catAx`・`valAx`・`dateAx`・`serAx`、ECMA-376 Part 1 §21.2.2）。 */
export interface IParadisChartAxis {
	readonly id: string;
	readonly kind: 'category' | 'value' | 'date' | 'series';
	/** `axPos`（l・r・t・b）。 */
	readonly position: 'l' | 'r' | 't' | 'b';
	/** `delete`。消した軸は目盛りの文字を描かない（値の範囲は使う）。 */
	readonly deleted: boolean;
	/** `scaling` の `min`・`max`・`logBase`・`orientation`（maxMin なら反転）。 */
	readonly min?: number;
	readonly max?: number;
	readonly logBase?: number;
	readonly reversed: boolean;
	/** `majorUnit`。 */
	readonly majorUnit?: number;
	/** `numFmt` の書式。`sourceLinked` なら系列の保存された書式を使う。 */
	readonly formatCode?: string;
	readonly sourceLinked: boolean;
	readonly title?: string;
	/** `majorGridlines`。 */
	readonly gridlines: boolean;
	/** `tickLblPos` が none でないか。 */
	readonly tickLabels: boolean;
	/** 相手の軸と交わる位置（`crosses`・`crossesAt`）。 */
	readonly crosses: 'autoZero' | 'min' | 'max' | number;
}

/** グラフ（chartN.xml の保存済みの値から描く）。 */
export interface IParadisChartData {
	readonly title?: string;
	readonly groups: readonly IParadisChartGroup[];
	readonly legend: boolean;
	/** 凡例の位置（`legendPos`）。無ければ右。 */
	readonly legendPosition?: 'r' | 'l' | 't' | 'b' | 'tr';
	readonly axes?: readonly IParadisChartAxis[];
	/** データラベルが多すぎて省いたか（グラフは描き、代替表示として数える）。 */
	readonly labelsOmitted?: boolean;
}

/** シート上に描画された図形(直線コネクタ/図形/画像/グラフ)。重説等の斜線はこの直線コネクタで表現される。 */
export interface IParadisRenderShape {
	/** `rect` は線以外の図形（形は `geometry`、無ければ矩形）。 */
	readonly type: 'line' | 'rect' | 'image' | 'chart';
	readonly flipV: boolean;
	readonly flipH: boolean;
	readonly from: IParadisRenderAnchor;
	readonly to: IParadisRenderAnchor;
	/** 線の太さ(px)。0 は線なし。 */
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
	readonly geometry?: ParadisSpreadsheetShapeGeometry;
	/** 形の調整値（角丸・括弧の丸み・中括弧の先端の位置など。100000 が全体）。 */
	readonly adjust?: readonly number[];
	readonly paths?: readonly IParadisShapePath[];
	/** 塗りの色。無ければ塗らない。 */
	readonly fill?: string;
	/** 塗りの不透明度(0〜1)。 */
	readonly fillOpacity?: number;
	readonly text?: IParadisShapeText;
	/** 回転(度、時計回り)。 */
	readonly rotation?: number;
	/** 線の端の矢印。 */
	readonly headEnd?: string;
	readonly tailEnd?: string;
	/**
	 * グループの中の図形の位置。アンカーの枠の中の割合（左上 x・y と幅・高さ、0〜1）。無ければ枠いっぱい。
	 */
	readonly frame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/**
	 * 図形を含むグループの回転・反転（外側のグループから順）。それぞれ、そのグループの枠（アンカーの枠の中の
	 * 割合）の中心まわりに掛ける。
	 */
	readonly groupTransforms?: readonly IParadisShapeGroupTransform[];
	readonly chart?: IParadisChartData;
}

/** グループの回転・反転。 */
export interface IParadisShapeGroupTransform {
	readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly rotation?: number;
	readonly flipH?: boolean;
	readonly flipV?: boolean;
}

/** 画像を描かなかった理由。EMF・WMF、表示しない形式（BMP など）、中身を確かめられなかったもの、1 枚が大きすぎるもの、ブックの画素の上限を越えたもの。 */
export type ParadisSpreadsheetImageRejection = 'metafile' | 'unsupportedFormat' | 'unverified' | 'tooLarge' | 'overBudget';

/** 描けなかった図形（代替表示に数える）。 */
export interface IParadisUndrawnObject {
	/**
	 * `overLimit` は、描く量の上限（図形の数・グループの深さ・道筋の長さ）を越えたもの。`chartLabels` は、
	 * グラフは描いたが、データラベルが多すぎて省いたもの。
	 */
	readonly kind: 'image' | 'chart' | 'graphicFrame' | 'geometry' | 'contentPart' | 'overLimit' | 'chartLabels';
	/** 画像を描かなかった理由。 */
	readonly reason?: ParadisSpreadsheetImageRejection;
	readonly name?: string;
	readonly from?: IParadisRenderAnchor;
}

/** shared process が drawing ごとに渡す XML と埋め込みメディア(rId→dataURI)。 */
export interface IParadisDrawingData {
	readonly xml: string;
	readonly media: { readonly [rid: string]: string };
	/** 描かなかった画像（rId→理由）。 */
	readonly rejectedMedia?: { readonly [rid: string]: ParadisSpreadsheetImageRejection };
	/**
	 * まだ描いていない EMF・WMF の画像（rId→メディアの名前 `image1.emf`）。表示を返した後で worker が SVG に
	 * 変換し、renderer が `IParadisSpreadsheetMetafileImages` で差し替える。
	 */
	readonly metafileMedia?: { readonly [rid: string]: string };
	/** グラフの XML（rId→chartN.xml の文字列）。 */
	readonly charts?: { readonly [rid: string]: string };
	/** シートごとの XML の上限を越えたので、この drawing を渡さなかった（描かずに代替表示に数える）。 */
	readonly omitted?: boolean;
}

/** EMF・WMF を SVG にした結果。メディアの名前（`image1.emf`）→ `data:image/svg+xml;base64,...`。 */
export interface IParadisSpreadsheetMetafileImages {
	readonly images: { readonly [mediaName: string]: string };
	/** 変換できなかった理由（worker が使えない・混んでいる・取り消し）。描けた分が無くても失敗とは限らない。 */
	readonly unavailableReason?: string;
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
	/** 描けなかった図形(renderer 側で付与)。代替表示に数える。 */
	readonly undrawnObjects?: readonly IParadisUndrawnObject[];
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
	/** ウィンドウ枠の固定(sheetView.pane)。行・列とも「固定する本数」で、0 は固定なし。 */
	readonly freezePane?: IParadisFreezePane;
	/** オートフィルタ/テーブルのフィルタ範囲(見出し行にフィルタ記号を出すため)。 */
	readonly filterRanges?: readonly IParadisCellRange[];
	/** このシート上のテーブル(縞模様・見出し・集計行の描き分けに使う)。 */
	readonly tables?: readonly IParadisSheetTable[];
}

/** Excel のテーブル(構造化テーブル)。描画に必要な範囲と体裁だけを持つ。 */
export interface IParadisSheetTable {
	readonly name: string;
	readonly range: IParadisCellRange;
	/** 先頭行が見出し行か。 */
	readonly headerRow: boolean;
	/** 末尾行が集計行か。 */
	readonly totalsRow: boolean;
	/** 1行おきの網掛け。 */
	readonly showRowStripes: boolean;
	/** 1列おきの網掛け。 */
	readonly showColumnStripes: boolean;
	/** 先頭列を強調するか。 */
	readonly showFirstColumn: boolean;
	/** 末尾列を強調するか。 */
	readonly showLastColumn: boolean;
}

/** ウィンドウ枠の固定。Excel の xSplit/ySplit(固定される列数・行数)に対応する。 */
export interface IParadisFreezePane {
	/** 固定する列数(左から)。 */
	readonly cols: number;
	/** 固定する行数(上から)。 */
	readonly rows: number;
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
	/** 意味解析(OOXML 直読み)と表示用データを突き合わせた結果。診断表示にそのまま使う。 */
	readonly semanticDiagnostics?: IParadisSemanticDiagnosticsSummary;
}

/**
 * 意味解析の到達度と、表示用データとの食い違い。診断リボンが表示する数字の実体。
 * 解析を回せなかった場合は `available: false` とし、理由だけを持つ。
 */
export interface IParadisSemanticDiagnosticsSummary {
	readonly available: boolean;
	/** 解析が最後まで到達したか(打ち切られていないか)。 */
	readonly terminal: boolean;
	readonly expectedParts: number;
	readonly parsedParts: number;
	readonly expectedSheets: number;
	readonly parsedSheets: number;
	readonly expectedCells: number;
	readonly parsedCells: number;
	readonly unknownElements: number;
	readonly unresolvedReferences: number;
	/** 表示用データと意味解析で食い違ったセル・シートの件数。 */
	readonly mismatchCount: number;
	/** 食い違いの内訳(種類→件数)。 */
	readonly mismatchesByKind?: { readonly [kind: string]: number };
	/**
	 * 解析を回せなかった/打ち切った理由のコード。パッケージの検査で落ちたときは `unsafe`・`malformed` など、
	 * 締め切りや worker のヒープの上限は `limitExceeded`、混み合って走らせなかったときは `busy`（頼み直せる）。
	 * チャネルの `collectSemanticDiagnostics`（表示とは別の呼び出し。worker で走る）が返す。
	 */
	readonly unavailableReason?: string;
	/** 解析にかかった時間（ミリ秒）。 */
	readonly elapsedMilliseconds?: number;
}

const MAX_SEMANTIC_PROJECTION_DIAGNOSTICS = 10_000;

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
				const semanticFormat = semanticCell.effectiveStyleRef === undefined ? undefined : snapshot.styles.cellFormats[semanticCell.effectiveStyleRef];
				const semanticBorder = semanticFormat?.borderRef === undefined ? undefined : snapshot.styles.borders[semanticFormat.borderRef];
				const semanticDiagonal = semanticDiagonalIdentity(semanticBorder);
				const projectionDiagonal = projectionDiagonalIdentity(projectedCell.diagonal);
				for (const kind of diagonalMismatchKinds(semanticDiagonal, projectionDiagonal)) {
					diagnostics.push({ kind, sheetName: semanticSheet.name, cellAddress, ...(semanticDiagonal ? { semanticDiagonal } : {}), ...(projectionDiagonal ? { projectionDiagonal } : {}) });
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

function semanticDiagonalIdentity(border: ParadisSemanticBorder | undefined): ParadisSpreadsheetDiagonalIdentity | undefined {
	if (!border || (!border.diagonalUp && !border.diagonalDown && !border.diagonal?.style && !border.diagonal?.color)) {
		return undefined;
	}
	return {
		up: border.diagonalUp ?? false,
		down: border.diagonalDown ?? false,
		...(border.diagonal?.style ? { style: border.diagonal.style } : {}),
		...(border.diagonal?.color ? { color: border.diagonal.color } : {}),
	};
}

function projectionDiagonalIdentity(diagonal: IParadisDiagonalBorder | undefined): ParadisSpreadsheetDiagonalIdentity | undefined {
	return diagonal ? {
		up: diagonal.up,
		down: diagonal.down,
		...(diagonal.rawStyle ? { style: diagonal.rawStyle } : {}),
		...(diagonal.rawColor ? { color: diagonal.rawColor } : {}),
	} : undefined;
}

function diagonalMismatchKinds(
	semantic: ParadisSpreadsheetDiagonalIdentity | undefined,
	projection: ParadisSpreadsheetDiagonalIdentity | undefined,
): readonly ParadisSpreadsheetProjectionDiagnostic['kind'][] {
	if (!semantic || !projection) {
		return semantic === projection ? [] : ['diagonalPresenceMismatch'];
	}
	const result: ParadisSpreadsheetProjectionDiagnostic['kind'][] = [];
	if (semantic.up !== projection.up || semantic.down !== projection.down) {
		result.push('diagonalDirectionMismatch');
	}
	if (semantic.style !== projection.style) {
		result.push('diagonalStyleMismatch');
	}
	if (!sameRawColor(semantic.color, projection.color)) {
		result.push('diagonalColorMismatch');
	}
	return result;
}

function sameRawColor(left: ParadisSpreadsheetColor | undefined, right: ParadisSpreadsheetColor | undefined): boolean {
	return left?.kind === right?.kind
		&& left?.rgb === right?.rgb
		&& left?.indexed === right?.indexed
		&& left?.theme === right?.theme
		&& left?.tint === right?.tint
		&& left?.auto === right?.auto;
}

function semanticProjectionValue(cell: ParadisSemanticCell): string {
	if (cell.storedType === 'formula') {
		return cell.cachedResult?.present ? cell.cachedResult.rawValue : '';
	}
	return cell.text ?? (cell.rawValue?.present ? cell.rawValue.text : '');
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
	/** `imagePixelBudget` はブックで描く画像の画素の合計の上限（既定は 1 億。比較では左右で半分ずつ）。 */
	parseWorkbook(base64Content: string, imagePixelBudget?: number): Promise<IParadisWorkbookData>;
}

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

/** shared process 側サービスのインターフェース(チャネル越しに呼ばれる)。 */
export interface IParadisSpreadsheetService {
	/** base64エンコードされた xlsx バイト列をパースして構造化データを返す。 */
	parseWorkbook(base64Content: string): Promise<IParadisWorkbookData>;
}

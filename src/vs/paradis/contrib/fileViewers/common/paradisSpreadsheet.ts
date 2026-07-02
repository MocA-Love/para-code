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

/** シート上に描画された図形(直線コネクタ/矩形)。重説等の斜線はこの直線コネクタで表現される。 */
export interface IParadisRenderShape {
	readonly type: 'line' | 'rect';
	readonly flipV: boolean;
	readonly flipH: boolean;
	readonly from: IParadisRenderAnchor;
	readonly to: IParadisRenderAnchor;
	readonly outlineWidth: number;
	readonly outlineColor: string;
	readonly dash: string;
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
}

/** パース結果のワークブック全体。 */
export interface IParadisWorkbookData {
	readonly sheets: readonly IParadisSheetData[];
	/**
	 * シート番号(1始まり、eachSheet 順)→ そのシートが参照する drawing XML 文字列の配列。
	 * 図形の解析には DOMParser が必要で node 層では使えないため、XML 文字列だけを渡し renderer で解析する。
	 */
	readonly drawingXmlBySheet?: { readonly [sheetIndex: number]: readonly string[] };
}

/** shared process 側サービスのインターフェース(チャネル越しに呼ばれる)。 */
export interface IParadisSpreadsheetService {
	/** base64エンコードされた xlsx バイト列をパースして構造化データを返す。 */
	parseWorkbook(base64Content: string): Promise<IParadisWorkbookData>;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 内で動く Excel パーサ本体（Superset apps/desktop の SpreadsheetViewer/parseWorkbook.ts の移植）。
// exceljs で xlsx を読み、セル値・スタイル・結合・列幅/行高を「プレーンにシリアライズ可能な」構造化データ
// (IParadisWorkbookData)へ変換する。図形(drawing)・対角罫線は今回はスコープ外。
// exceljs は Buffer/stream 依存のため workbench(renderer, sandbox)では動かず、node層で実行する必要がある。

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
	IParadisCellData,
	IParadisCellRange,
	IParadisCellStyle,
	IParadisDiagonalBorder,
	IParadisDrawingData,
	IParadisRichTextPart,
	IParadisRowData,
	IParadisSheetData,
	IParadisSpreadsheetService,
	IParadisWorkbookData,
} from '../common/paradisSpreadsheet.js';

const MAX_ROWS = 2000;

// exceljs の型定義は一部不完全なため、読み取るフィールドだけの局所インターフェースを定義して `any` を避ける。
interface IExcelColor {
	readonly argb?: string;
	readonly theme?: number;
	readonly tint?: number;
	readonly indexed?: number;
}
interface IExcelBorderSide {
	readonly style?: string;
	readonly color?: IExcelColor;
}
interface IExcelFont {
	readonly size?: number;
	readonly name?: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean | string;
	readonly strike?: boolean;
	readonly color?: IExcelColor;
	readonly vertAlign?: string;
}
interface IExcelRichTextRun {
	readonly text?: string;
	readonly font?: IExcelFont;
}

// ── Excel標準テーマ色(Office 2013+ の既定)。theme1.xml が読めない場合のフォールバック ──
// 古いブック(例: "Office 2007 - 2010" テーマは accent6 がオレンジ #F79646)ではパレットが異なるため、
// 実際の解決は theme1.xml の clrScheme から構築した activeThemeColors で行う。
const DEFAULT_THEME_COLORS: Record<number, string> = {
	0: '#FFFFFF', 1: '#000000', 2: '#E7E6E6', 3: '#44546A', 4: '#4472C4',
	5: '#ED7D31', 6: '#A5A5A5', 7: '#FFC000', 8: '#5B9BD5', 9: '#70AD47',
	10: '#0563C1', 11: '#954F72',
};

// styles.xml の theme インデックス → clrScheme 要素名。仕様上 0/1 と 2/3 は clrScheme の並び(dk1,lt1,dk2,lt2)と
// 入れ替わる(theme=0 が lt1=白、theme=1 が dk1=黒)。
const THEME_INDEX_TO_SCHEME_NAME: readonly string[] = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

// 現在パース中のワークブックのテーマパレット。parseWorkbook が同期処理区間(eachSheet ループ)の直前に設定し、
// ループ内の resolveColor だけが参照する。ループ内に await は無いため、並行する parseWorkbook 呼び出しと混線しない。
let activeThemeColors: Record<number, string> = DEFAULT_THEME_COLORS;

/** theme1.xml の clrScheme からテーマ色(scheme名→hex)を抽出する。srgbClr は val、sysClr は lastClr を使う。 */
function parseThemeScheme(themeXml: string): { [name: string]: string } {
	const byName: { [name: string]: string } = {};
	for (const name of THEME_INDEX_TO_SCHEME_NAME) {
		const block = themeXml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
		if (!block) {
			continue;
		}
		const val = block[1].match(/(?:srgbClr[^>]*\bval|sysClr[^>]*\blastClr)="([0-9A-Fa-f]{6})"/);
		if (val) {
			byName[name] = `#${val[1].toUpperCase()}`;
		}
	}
	return byName;
}

const BORDER_STYLES: Record<string, string> = {
	thin: '1px solid', medium: '2px solid', thick: '3px solid', dotted: '1px dotted',
	dashed: '1px dashed', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed',
	dashDotDot: '1px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed',
	slantDashDot: '1px dashed', hair: '1px solid',
};

function argbToHex(argb: string | undefined): string | null {
	if (!argb || argb.length < 6) {
		return null;
	}
	// 8桁(AARRGGBB)でアルファ 00 は完全透明なので「色なし」扱い。それ以外は下6桁を使う(黒 FF000000 も有効な色)。
	if (argb.length === 8 && argb.slice(0, 2) === '00') {
		return null;
	}
	return `#${argb.slice(-6)}`;
}

function applyTint(hex: string, tint: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const apply = (c: number) => tint < 0 ? Math.round(c * (1 + tint)) : Math.round(c + (255 - c) * tint);
	const clamp = (v: number) => Math.min(255, Math.max(0, v));
	return `#${clamp(apply(r)).toString(16).padStart(2, '0')}${clamp(apply(g)).toString(16).padStart(2, '0')}${clamp(apply(b)).toString(16).padStart(2, '0')}`;
}

function resolveColor(color: IExcelColor | undefined): string | null {
	if (!color) {
		return null;
	}
	if (color.argb) {
		return argbToHex(color.argb);
	}
	if (color.theme !== undefined) {
		const base = activeThemeColors[color.theme] || '#000000';
		return color.tint ? applyTint(base, color.tint) : base;
	}
	if (color.indexed !== undefined) {
		return color.indexed === 64 ? '#000000' : null;
	}
	return null;
}

function borderToCSS(b: IExcelBorderSide | undefined): string | null {
	if (!b?.style) {
		return null;
	}
	const base = BORDER_STYLES[b.style] || '1px solid';
	const col = resolveColor(b.color) || '#000';
	return `${base} ${col}`;
}

function rowHeightToPx(h: number | undefined, defaultRowHeightPt: number | undefined): number {
	// 行に明示高が無ければシートの既定行高(sheetFormatPr defaultRowHeight、pt)を使う。最後の 15pt は 20px 相当(旧既定)。
	const pt = h && h > 0 ? h : (defaultRowHeightPt && defaultRowHeightPt > 0 ? defaultRowHeightPt : 15);
	return Math.round((pt * 96) / 72);
}

// Excel の列幅は「既定フォントの最大数字幅(mdw)を1とする文字数」単位で保存される。
// px 換算は px ≈ round(文字数 * mdw) + 5(セル左右パディング)。Calibri 11pt の既定幅 8.43 → 64px、
// 日本語 Excel(ＭＳ Ｐゴシック 11pt, mdw=8)の 2.5 → 25px。
function charWidthToPx(w: number | undefined, defaultColWidth: number | undefined, maxDigitWidth: number): number {
	// 列に明示幅が無ければシートの既定列幅(sheetFormatPr defaultColWidth)へフォールバックする。
	// これを見ずに固定値へ落とすと、全列が既定幅のシート(方眼紙レイアウトの表紙等)が数倍幅で描かれる。
	const chars = w && w > 0 ? w : (defaultColWidth && defaultColWidth > 0 ? defaultColWidth : 8.43);
	return Math.max(4, Math.round(chars * maxDigitWidth) + 5);
}

/** 既定フォント(styles.xml の先頭 font)から最大数字幅(px)を推定する。日本語フォントは 8px、それ以外は 7px(いずれも 11pt 時)。 */
function estimateMaxDigitWidth(fontName: string | undefined, fontSize: number | undefined): number {
	const name = fontName ?? '';
	const isJapanese = MINCHO_MARKERS.some(m => name.includes(m)) || GOTHIC_MARKERS.some(m => name.includes(m)) || /[^\x00-\x7F]/.test(name);
	const base = isJapanese ? 8 : 7;
	const size = fontSize && fontSize > 0 ? fontSize : 11;
	return Math.max(4, Math.round((base * size) / 11));
}

// Windows 由来の日本語フォント名(ＭＳ Ｐ明朝/HGP明朝B/游明朝/ＭＳ Ｐゴシック 等)は macOS/Linux に存在せず、
// 単純に font-family へ出すと総称フォント(sans-serif)へ落ちて字形が変わる(明朝がゴシックになる等)。
// 元名を先頭に残しつつ、名前から明朝系/ゴシック系を判定して OS 標準の同系フォントを続けるフォールバックを付ける。
// allow-any-unicode-next-line
const MINCHO_MARKERS = ['明朝', '明體', 'Mincho', 'mincho'];
// allow-any-unicode-next-line
const GOTHIC_MARKERS = ['ゴシック', 'Gothic', 'gothic', 'Meiryo', 'メイリオ'];

function fontFamilyStack(name: string): string {
	if (MINCHO_MARKERS.some(m => name.includes(m))) {
		return `'${name}', 'Hiragino Mincho ProN', 'Yu Mincho', 'MS PMincho', serif`;
	}
	if (GOTHIC_MARKERS.some(m => name.includes(m))) {
		return `'${name}', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'MS PGothic', sans-serif`;
	}
	return `'${name}', sans-serif`;
}

function fontToStyle(font: IExcelFont | undefined, into: Record<string, string>): void {
	if (!font) {
		return;
	}
	if (font.size) {
		into.fontSize = `${font.size}pt`;
	}
	if (font.name) {
		into.fontFamily = fontFamilyStack(font.name);
	}
	if (font.bold) {
		into.fontWeight = 'bold';
	}
	if (font.italic) {
		into.fontStyle = 'italic';
	}
	const decor: string[] = [];
	if (font.underline) {
		decor.push('underline');
	}
	if (font.strike) {
		decor.push('line-through');
	}
	if (decor.length) {
		into.textDecoration = decor.join(' ');
	}
	// 白フォントも忠実に適用する(濃色塗り+白文字のセルで文字が黒く出てしまうため。白背景に白文字は Excel でも不可視)。
	const fc = resolveColor(font.color);
	if (fc) {
		into.color = fc;
	}
	if (font.vertAlign === 'superscript') {
		into.verticalAlign = 'super';
		into.fontSize = into.fontSize || '0.7em';
	}
	if (font.vertAlign === 'subscript') {
		into.verticalAlign = 'sub';
		into.fontSize = into.fontSize || '0.7em';
	}
}

function richTextFontStyle(font: IExcelFont | undefined): IParadisCellStyle {
	const s: Record<string, string> = {};
	fontToStyle(font, s);
	return s;
}

function getCellStyle(cell: ExcelJS.Cell): IParadisCellStyle {
	const style: Record<string, string> = { verticalAlign: 'bottom' };
	const al = cell.alignment;
	if (al) {
		const hmap: Record<string, string> = {
			left: 'left', center: 'center', right: 'right', fill: 'left',
			justify: 'justify', centerContinuous: 'center', distributed: 'center',
		};
		const vmap: Record<string, string> = {
			top: 'top', middle: 'middle', center: 'middle', bottom: 'bottom',
			distributed: 'middle', justify: 'middle',
		};
		// general 配置は exceljs では horizontal=undefined になる。ここでは設定せず、
		// 呼び出し側で「数値=右/文字=左」の規則に従って textAlign を決める。
		if (al.horizontal) {
			style.textAlign = hmap[al.horizontal] || 'left';
		}
		style.verticalAlign = (al.vertical && vmap[al.vertical]) || 'bottom';
		if (al.indent) {
			style.paddingLeft = `${al.indent * 8 + 3}px`;
		}
	}
	fontToStyle(cell.font as IExcelFont | undefined, style);
	const fill = cell.fill;
	if (fill?.type === 'pattern' && fill.pattern === 'solid') {
		const bg = resolveColor(fill.fgColor as IExcelColor | undefined);
		if (bg) {
			style.backgroundColor = bg;
		}
	}
	// 罫線は隣接セルとの「共有辺」解決が必要なため、呼び出し側で resolveEdgeBorders / getMergedCellBorders が付与する。
	return style;
}

interface IExcelBorders {
	readonly top?: IExcelBorderSide;
	readonly bottom?: IExcelBorderSide;
	readonly left?: IExcelBorderSide;
	readonly right?: IExcelBorderSide;
}

/** (r,c) のセル罫線(exceljs)。行/列が範囲外(0以下)なら undefined。 */
function borderAt(ws: ExcelJS.Worksheet, r: number, c: number): IExcelBorders | undefined {
	if (r < 1 || c < 1) {
		return undefined;
	}
	return ws.getRow(r).getCell(c).border as IExcelBorders | undefined;
}

// Excel の罫線は隣接セルと共有され、見た目上の1本の線がどちらのセルに保存されるかは不定
// (例: セルの「下線」が下のセルの top 罫線として保存されるのは普通にある)。HTML の border-collapse は
// 太さ・スタイルが同じ線同士の競合を「上/左のセルの色」で解決するため、線を持たない側のセルが
// CSS の薄いグリッド線を持っていると、そちらが勝って実線が消えたように見える。
// そこで4辺すべてを「自セルの辺 || 隣接セルの対向辺」で解決し、共有辺の両側のセルに同じ線を持たせる。

/** セル(r,c) の4辺を隣接セルの対向辺と合成して CSS 罫線にする。 */
function resolveEdgeBorders(ws: ExcelJS.Worksheet, r: number, c: number): Record<string, string> {
	const own = borderAt(ws, r, c);
	const borders: Record<string, string> = {};
	const top = borderToCSS(own?.top) || borderToCSS(borderAt(ws, r - 1, c)?.bottom);
	if (top) {
		borders.borderTop = top;
	}
	const bottom = borderToCSS(own?.bottom) || borderToCSS(borderAt(ws, r + 1, c)?.top);
	if (bottom) {
		borders.borderBottom = bottom;
	}
	const left = borderToCSS(own?.left) || borderToCSS(borderAt(ws, r, c - 1)?.right);
	if (left) {
		borders.borderLeft = left;
	}
	const right = borderToCSS(own?.right) || borderToCSS(borderAt(ws, r, c + 1)?.left);
	if (right) {
		borders.borderRight = right;
	}
	return borders;
}

function getCellDiagonal(cell: ExcelJS.Cell): IParadisDiagonalBorder | undefined {
	const bd = cell.border as { diagonal?: { up?: boolean; down?: boolean; style?: string; color?: IExcelColor } } | undefined;
	const dg = bd?.diagonal;
	if (!dg?.style) {
		return undefined;
	}
	const up = dg.up === true;
	const down = dg.down === true;
	if (!up && !down) {
		return undefined;
	}
	const base = BORDER_STYLES[dg.style] || '1px solid';
	const color = resolveColor(dg.color) || '#000';
	return { up, down, style: base, color };
}

/**
 * 結合セルの外周罫線。各辺を構成セル全体でスキャンし(原点セルだけを見ると原点以外に付いた線が落ちる)、
 * それぞれ隣接セルの対向辺との共有辺解決(resolveEdgeBorders と同じ規則)で最初に見つかった線を辺全体へ使う。
 */
function getMergedCellBorders(ws: ExcelJS.Worksheet, r: number, c: number, rowspan: number, colspan: number): Record<string, string> {
	const borders: Record<string, string> = {};
	const bottomRow = r + rowspan - 1;
	const rightCol = c + colspan - 1;
	for (let cc = c; cc <= rightCol; cc++) {
		const v = borderToCSS(borderAt(ws, r, cc)?.top) || borderToCSS(borderAt(ws, r - 1, cc)?.bottom);
		if (v) {
			borders.borderTop = v;
			break;
		}
	}
	for (let cc = c; cc <= rightCol; cc++) {
		const v = borderToCSS(borderAt(ws, bottomRow, cc)?.bottom) || borderToCSS(borderAt(ws, bottomRow + 1, cc)?.top);
		if (v) {
			borders.borderBottom = v;
			break;
		}
	}
	for (let rr = r; rr <= bottomRow; rr++) {
		const v = borderToCSS(borderAt(ws, rr, c)?.left) || borderToCSS(borderAt(ws, rr, c - 1)?.right);
		if (v) {
			borders.borderLeft = v;
			break;
		}
	}
	for (let rr = r; rr <= bottomRow; rr++) {
		const v = borderToCSS(borderAt(ws, rr, rightCol)?.right) || borderToCSS(borderAt(ws, rr, rightCol + 1)?.left);
		if (v) {
			borders.borderRight = v;
			break;
		}
	}
	return borders;
}

function getRichTextRuns(cell: ExcelJS.Cell): readonly IExcelRichTextRun[] | undefined {
	const value = cell.value as { richText?: IExcelRichTextRun[] } | null | undefined;
	return value && Array.isArray(value.richText) ? value.richText : undefined;
}

function isNotNil(v: unknown): boolean {
	return v !== undefined && v !== null;
}

function getCellDisplayValue(cell: ExcelJS.Cell): string {
	const runs = getRichTextRuns(cell);
	if (runs) {
		return runs.map(rt => rt.text || '').join('');
	}
	const value = cell.value;
	if (value instanceof Date) {
		return value.toLocaleDateString();
	}
	const asFormula = value as { formula?: string; result?: unknown } | null | undefined;
	if (asFormula && typeof asFormula === 'object' && asFormula.formula !== undefined) {
		return isNotNil(asFormula.result) ? String(asFormula.result) : '';
	}
	// exceljs の cell.text は数値フォーマット等を反映した表示文字列を返す。
	if (isNotNil(cell.text)) {
		return String(cell.text);
	}
	if (isNotNil(value)) {
		return String(value);
	}
	return '';
}

interface IMergeOrigin { readonly kind: 'origin'; readonly rowspan: number; readonly colspan: number }
interface IMergeSkip { readonly kind: 'skip' }
type MergeEntry = IMergeOrigin | IMergeSkip;

function decodeAddr(addr: string): { r: number; c: number } {
	const m = addr.match(/^([A-Z]+)(\d+)$/);
	if (!m) {
		return { r: 1, c: 1 };
	}
	const col = m[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
	return { r: Number.parseInt(m[2], 10), c: col };
}

function buildMergeMap(ws: ExcelJS.Worksheet): Record<string, MergeEntry> {
	const mm: Record<string, MergeEntry> = {};
	const model = ws.model as { merges?: string[] } | undefined;
	if (!model?.merges) {
		return mm;
	}
	for (const range of model.merges) {
		const parts = range.split(':');
		if (parts.length !== 2) {
			continue;
		}
		const s = decodeAddr(parts[0]);
		const e = decodeAddr(parts[1]);
		for (let r = s.r; r <= e.r; r++) {
			for (let c = s.c; c <= e.c; c++) {
				const key = `${r},${c}`;
				if (r === s.r && c === s.c) {
					mm[key] = { kind: 'origin', rowspan: e.r - s.r + 1, colspan: e.c - s.c + 1 };
				} else {
					mm[key] = { kind: 'skip' };
				}
			}
		}
	}
	return mm;
}

interface ISheetDims { minR: number; maxR: number; minC: number; maxC: number }

function parsePrintArea(area: string): ISheetDims | null {
	const clean = area.replace(/\$/g, '');
	const m = clean.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
	if (!m) {
		return null;
	}
	const colToNum = (s: string) => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
	return {
		minC: colToNum(m[1]), minR: Number.parseInt(m[2], 10),
		maxC: colToNum(m[3]), maxR: Number.parseInt(m[4], 10),
	};
}

function getSheetDimensions(ws: ExcelJS.Worksheet): ISheetDims {
	const printArea = (ws.pageSetup as { printArea?: string } | undefined)?.printArea;
	if (printArea) {
		const parsed = parsePrintArea(printArea.split(',')[0].trim());
		if (parsed) {
			return parsed;
		}
	}
	const dims = ws.dimensions as { top?: number; bottom?: number; left?: number; right?: number } | undefined;
	if (dims) {
		return { minR: dims.top || 1, maxR: dims.bottom || 1, minC: dims.left || 1, maxC: dims.right || 1 };
	}
	return { minR: 1, maxR: ws.rowCount || 1, minC: 1, maxC: ws.columnCount || 1 };
}

function isNumericCell(cell: ExcelJS.Cell): boolean {
	if (cell.type === ExcelJS.ValueType.Number) {
		return true;
	}
	const v = cell.value;
	if (typeof v === 'number') {
		return true;
	}
	const asFormula = v as { formula?: unknown; result?: unknown } | null | undefined;
	if (asFormula && typeof asFormula === 'object' && asFormula.formula !== undefined) {
		return typeof asFormula.result === 'number';
	}
	return false;
}

function getSheetPrintArea(ws: ExcelJS.Worksheet): IParadisCellRange | undefined {
	const printArea = (ws.pageSetup as { printArea?: string } | undefined)?.printArea;
	if (!printArea) {
		return undefined;
	}
	return parsePrintArea(printArea.split(',')[0].trim()) ?? undefined;
}

interface IXlsxExtras {
	drawingsBySheet: { [sheetIndex: number]: IParadisDrawingData[] };
	rowBreaksBySheet: { [sheetIndex: number]: number[] };
	colBreaksBySheet: { [sheetIndex: number]: number[] };
	/** theme1.xml の clrScheme 色(scheme名→hex)。読めなければ undefined(既定パレットを使う)。 */
	themeColorsByName?: { [name: string]: string };
	/** 既定フォントの最大数字幅(px)。列幅の文字数→px 換算に使う。 */
	maxDigitWidth: number;
}

function mediaMime(fileName: string): string | undefined {
	const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
	switch (ext) {
		case 'jpg': case 'jpeg': return 'image/jpeg';
		case 'png': return 'image/png';
		case 'gif': return 'image/gif';
		case 'bmp': return 'image/bmp';
		case 'svg': return 'image/svg+xml';
		// emf/wmf 等の Windows メタファイルはブラウザで表示できないため対象外。
		default: return undefined;
	}
}

function extractBrkIds(sheetXml: string, tag: 'rowBreaks' | 'colBreaks'): number[] {
	const block = sheetXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
	if (!block) {
		return [];
	}
	const ids: number[] = [];
	for (const brk of block[1].match(/<brk\b[^>]*\/?>/g) ?? []) {
		const id = brk.match(/\bid="(\d+)"/);
		if (id) {
			ids.push(Number.parseInt(id[1], 10));
		}
	}
	return ids;
}

// exceljs 4.4.0 は図形(drawing)・改ページ(rowBreaks/colBreaks)を読めないため、xlsx(ZIP)を jszip で直読みする。
// 図形/画像の解析には DOMParser が要るが node 層には無いので、drawing XML と埋め込みメディア(rId→dataURI)を
// renderer へ渡し renderer が DOMParser で図形化する。改ページは brk の id だけ抜き出す。
// 注意: sheetN.xml の「ファイル番号」は表示順と一致しない(workbook.xml の <sheets> 並びが表示順)。
// exceljs の eachSheet は表示順なので、すべて「表示順(1始まり)」に正規化して返す。
async function extractXlsxExtras(buffer: Buffer): Promise<IXlsxExtras> {
	const drawingsBySheet: { [sheetIndex: number]: IParadisDrawingData[] } = {};
	const rowBreaksBySheet: { [sheetIndex: number]: number[] } = {};
	const colBreaksBySheet: { [sheetIndex: number]: number[] } = {};
	let themeColorsByName: { [name: string]: string } | undefined;
	let maxDigitWidth = 7;
	try {
		const zip = await JSZip.loadAsync(buffer as unknown as Parameters<typeof JSZip.loadAsync>[0]);
		const files = zip.files;

		// テーマパレット(セルのテーマ色・図形の schemeClr の解決に使う)。
		const theme = files['xl/theme/theme1.xml'];
		if (theme) {
			const byName = parseThemeScheme(await theme.async('text'));
			if (Object.keys(byName).length > 0) {
				themeColorsByName = byName;
			}
		}

		// 既定フォント(styles.xml の先頭 <font>)から列幅換算用の最大数字幅を推定する。
		const styles = files['xl/styles.xml'];
		if (styles) {
			const stylesXml = await styles.async('text');
			const fontsBlock = stylesXml.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/);
			const firstFont = fontsBlock && fontsBlock[1].match(/<font\b[^>]*>([\s\S]*?)<\/font>/);
			if (firstFont) {
				const name = firstFont[1].match(/<name val="([^"]+)"/);
				const sz = firstFont[1].match(/<sz val="([\d.]+)"/);
				maxDigitWidth = estimateMaxDigitWidth(name?.[1], sz ? Number.parseFloat(sz[1]) : undefined);
			}
		}

		// rId -> sheetN.xml のファイル番号(workbook.xml.rels)
		const ridToFile = new Map<string, number>();
		const wbRels = files['xl/_rels/workbook.xml.rels'];
		if (wbRels) {
			for (const rel of (await wbRels.async('text')).match(/<Relationship[^>]*>/g) ?? []) {
				const id = rel.match(/Id="([^"]+)"/);
				const t = rel.match(/Target="[^"]*worksheets\/sheet(\d+)\.xml"/);
				if (id && t) {
					ridToFile.set(id[1], Number.parseInt(t[1], 10));
				}
			}
		}

		// workbook.xml の <sheet> 並び(表示順)-> ファイル番号 -> 表示インデックス(0始まり)
		const fileToDisplay = new Map<number, number>();
		const wb = files['xl/workbook.xml'];
		if (wb) {
			let display = 0;
			for (const st of (await wb.async('text')).match(/<sheet [^>]*?\/?>/g) ?? []) {
				const rid = st.match(/r:id="([^"]+)"/);
				const fileNum = rid ? ridToFile.get(rid[1]) : undefined;
				if (fileNum !== undefined) {
					fileToDisplay.set(fileNum, display);
				}
				display++;
			}
		}
		const keyForFile = (fileNum: number) => (fileToDisplay.get(fileNum) ?? fileNum - 1) + 1;

		// 各 sheetN.xml から改ページ + drawing 参照を読む
		const drawingToFile = new Map<string, number>();
		for (const name of Object.keys(files)) {
			const m = name.match(/xl\/worksheets\/sheet(\d+)\.xml$/);
			if (!m || files[name].dir) {
				continue;
			}
			const fileNum = Number.parseInt(m[1], 10);
			const sheetXml = await files[name].async('text');
			const key = keyForFile(fileNum);
			const rb = extractBrkIds(sheetXml, 'rowBreaks');
			const cb = extractBrkIds(sheetXml, 'colBreaks');
			if (rb.length) {
				rowBreaksBySheet[key] = rb;
			}
			if (cb.length) {
				colBreaksBySheet[key] = cb;
			}
		}
		for (const name of Object.keys(files)) {
			const m = name.match(/xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/);
			if (!m || files[name].dir) {
				continue;
			}
			const fileNum = Number.parseInt(m[1], 10);
			for (const dm of (await files[name].async('text')).match(/drawing(\d+)\.xml/g) ?? []) {
				const idm = dm.match(/drawing(\d+)\.xml/);
				if (idm) {
					drawingToFile.set(`drawing${idm[1]}`, fileNum);
				}
			}
		}

		// drawing XML + 埋め込みメディア(rId->dataURI)を表示順キーで格納
		for (const name of Object.keys(files)) {
			const m = name.match(/xl\/drawings\/(drawing\d+)\.xml$/);
			if (!m || files[name].dir) {
				continue;
			}
			const fileNum = drawingToFile.get(m[1]);
			if (fileNum === undefined) {
				continue;
			}
			const xml = await files[name].async('text');
			const media: { [rid: string]: string } = {};
			const relsFile = files[`xl/drawings/_rels/${m[1]}.xml.rels`];
			if (relsFile) {
				for (const rel of (await relsFile.async('text')).match(/<Relationship[^>]*>/g) ?? []) {
					const id = rel.match(/Id="([^"]+)"/);
					const target = rel.match(/Target="[^"]*media\/([^"]+)"/);
					if (id && target) {
						const mediaName = target[1];
						const mime = mediaMime(mediaName);
						const mediaFile = files[`xl/media/${mediaName}`];
						if (mime && mediaFile) {
							media[id[1]] = `data:${mime};base64,${await mediaFile.async('base64')}`;
						}
					}
				}
			}
			const key = keyForFile(fileNum);
			if (!drawingsBySheet[key]) {
				drawingsBySheet[key] = [];
			}
			drawingsBySheet[key].push({ xml, media });
		}
	} catch {
		// 図形/改ページ/テーマは任意要素。抽出に失敗しても表・値の表示は継続する。
	}
	return { drawingsBySheet, rowBreaksBySheet, colBreaksBySheet, themeColorsByName, maxDigitWidth };
}

export class ParadisSpreadsheetService implements IParadisSpreadsheetService {

	async parseWorkbook(base64Content: string): Promise<IParadisWorkbookData> {
		const workbook = new ExcelJS.Workbook();
		const buffer = Buffer.from(base64Content, 'base64');
		// exceljs の Buffer 型定義が現行 @types/node の Buffer と食い違うため、load の期待型そのものへ interop キャストする。
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

		const extras = await extractXlsxExtras(buffer);

		// このブックのテーマパレットを組み立てて有効化する(以降の eachSheet ループは同期なので、
		// 並行する parseWorkbook 呼び出しがあってもループ中に差し替わることはない)。
		const themeColors = { ...DEFAULT_THEME_COLORS };
		if (extras.themeColorsByName) {
			THEME_INDEX_TO_SCHEME_NAME.forEach((name, i) => {
				const hex = extras.themeColorsByName![name];
				if (hex) {
					themeColors[i] = hex;
				}
			});
		}
		activeThemeColors = themeColors;

		const sheets: IParadisSheetData[] = [];
		let sheetIndex = 0;

		workbook.eachSheet(worksheet => {
			sheetIndex++;
			const dims = getSheetDimensions(worksheet);
			const mergeMap = buildMergeMap(worksheet);
			const colCount = dims.maxC - dims.minC + 1;
			const sheetProps = worksheet.properties as { defaultColWidth?: number; defaultRowHeight?: number } | undefined;
			const showGridLines = (worksheet.views?.[0] as { showGridLines?: boolean } | undefined)?.showGridLines ?? true;
			const columnWidths: number[] = [];
			for (let c = dims.minC; c <= dims.maxC; c++) {
				const col = worksheet.getColumn(c);
				columnWidths.push(col.hidden ? 0 : charWidthToPx(col.width, sheetProps?.defaultColWidth, extras.maxDigitWidth));
			}

			const rows: IParadisRowData[] = [];
			const maxRow = Math.min(dims.maxR, dims.minR + MAX_ROWS - 1);
			const truncated = dims.maxR > maxRow;

			for (let r = dims.minR; r <= maxRow; r++) {
				const row = worksheet.getRow(r);
				if (row.hidden) {
					continue;
				}
				const cells: IParadisCellData[] = [];

				for (let c = dims.minC; c <= dims.maxC; c++) {
					const key = `${r},${c}`;
					const mergeEntry = mergeMap[key];
					if (mergeEntry && mergeEntry.kind === 'skip') {
						cells.push({ value: '', style: {}, hidden: true });
						continue;
					}

					const cell = worksheet.getRow(r).getCell(c);
					const val = getCellDisplayValue(cell);
					const style: Record<string, string> = getCellStyle(cell) as Record<string, string>;
					// general 配置(明示指定なし)の数値は右寄せにする。
					if (!style.textAlign && isNumericCell(cell)) {
						style.textAlign = 'right';
					}
					const mergeInfo = mergeEntry && mergeEntry.kind === 'origin' ? mergeEntry : null;
					const colspan = mergeInfo?.colspan ?? 1;
					const rowspan = mergeInfo?.rowspan ?? 1;

					// 罫線(共有辺解決)。結合セルは外周を辺全体でスキャンする。
					Object.assign(style, mergeInfo
						? getMergedCellBorders(worksheet, r, c, rowspan, colspan)
						: resolveEdgeBorders(worksheet, r, c));

					// Excel は塗りつぶしセルの上にグリッド線を描かない。罫線の無い辺を塗り色の線にして
					// CSS のグリッド線(border-collapse で競合する薄灰色)を打ち消す。
					if (showGridLines && style.backgroundColor) {
						for (const side of ['borderTop', 'borderBottom', 'borderLeft', 'borderRight']) {
							if (!style[side]) {
								style[side] = `1px solid ${style.backgroundColor}`;
							}
						}
					}

					const runs = getRichTextRuns(cell);
					const richText: IParadisRichTextPart[] | undefined = runs
						? runs.map(rt => ({ text: rt.text || '', style: richTextFontStyle(rt.font) }))
						: undefined;

					const al = cell.alignment;
					const wrapText = al?.wrapText === true || (typeof val === 'string' && val.includes('\n'));
					const verticalText = al?.textRotation === 'vertical' || al?.textRotation === 255;
					const shrinkToFit = al?.shrinkToFit === true;
					const diagonal = getCellDiagonal(cell);

					const parsed: IParadisCellData = {
						value: val,
						style,
						...(mergeInfo ? { colSpan: colspan, rowSpan: rowspan } : {}),
						...(wrapText ? { wrapText: true } : {}),
						...(verticalText ? { verticalText: true } : {}),
						...(shrinkToFit ? { shrinkToFit: true } : {}),
						...(richText ? { richText } : {}),
						...(diagonal ? { diagonal } : {}),
					};
					cells.push(parsed);
				}

				rows.push({ excelRow: r, cells, height: rowHeightToPx(row.height, sheetProps?.defaultRowHeight) });
			}

			const view = worksheet.views?.[0] as { zoomScale?: number } | undefined;
			const tabColorArgb = (worksheet.properties as { tabColor?: IExcelColor } | undefined)?.tabColor;
			const tabColor = resolveColor(tabColorArgb) ?? undefined;
			const protectedSheet = (worksheet as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet === true;
			const printArea = getSheetPrintArea(worksheet);

			sheets.push({
				name: worksheet.name,
				rows,
				columnCount: colCount,
				columnWidths,
				truncated,
				minCol: dims.minC,
				showGridLines,
				...(view?.zoomScale ? { zoomScale: view.zoomScale } : {}),
				...(tabColor ? { tabColor } : {}),
				...(protectedSheet ? { protectedSheet: true } : {}),
				...(extras.rowBreaksBySheet[sheetIndex] ? { rowBreaks: extras.rowBreaksBySheet[sheetIndex] } : {}),
				...(extras.colBreaksBySheet[sheetIndex] ? { colBreaks: extras.colBreaksBySheet[sheetIndex] } : {}),
				...(printArea ? { printArea } : {}),
			});
		});

		return {
			sheets,
			drawingsBySheet: extras.drawingsBySheet,
			...(extras.themeColorsByName ? { themeColors: extras.themeColorsByName } : {}),
		};
	}
}

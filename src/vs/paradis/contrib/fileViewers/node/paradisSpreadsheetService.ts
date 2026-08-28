/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 内で動く Excel パーサ本体（Superset apps/desktop の SpreadsheetViewer/parseWorkbook.ts の移植）。
// exceljs で xlsx を読み、セル値・スタイル・結合・列幅/行高を「プレーンにシリアライズ可能な」構造化データ
// (IParadisWorkbookData)へ変換する。対角罫線(getCellDiagonal)は exceljs の Cell.border から直接読む。
// 図形(drawing)・改ページ・データ検証・ページ設定・テーマ色は extractXlsxExtras() で xlsx(ZIP)を直読みして抽出する。
// exceljs は Buffer/stream 依存のため workbench(renderer, sandbox)では動かず、node層で実行する必要がある。

import { localize } from '../../../../nls.js';
import type ExcelJS from 'exceljs';
import type JSZip from 'jszip';
import {
	IParadisCellData,
	IParadisCellRange,
	IParadisCellStyle,
	IParadisDataValidation,
	IParadisDiagonalBorder,
	IParadisDrawingData,
	IParadisFreezePane,
	IParadisSheetTable,
	IParadisSemanticDiagnosticsSummary,
	IParadisParseWorkbookOptions,
	IParadisRichTextPart,
	IParadisRowData,
	canonicalizeDataValidationEntries,
	IParadisSheetData,
	IParadisSpreadsheetService,
	IParadisWorkbookData,
} from '../common/paradisSpreadsheet.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { inspectOfficePackage } from '../common/office/paradisOfficePackageCore.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../common/paradisOfficeProtocol.js';
import { createParadisOfficeNodeArchive } from './office/paradisOfficeNodeArchive.js';
import { parseSpreadsheetSemanticNode } from './spreadsheet/paradisSpreadsheetNodeAdapter.js';
import { evaluateLegacyConditionalFormatting, parseConditionalFormatRef, type IParadisLegacyCfBlock, type IParadisLegacyCfCellValue } from './spreadsheet/paradisSpreadsheetLegacyConditionalFormat.js';
import { IParadisPageLayout, IParadisPageSetup, computePageLayout, parsePageSetup, parsePrintTitleRows } from '../common/paradisSpreadsheetPageLayout.js';
import type { ParadisSpreadsheetColor } from '../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { formatPreparedSpreadsheetValue, prepareSpreadsheetNumberFormat, type ParadisFormattedCellValue, type ParadisSpreadsheetPreparedNumberFormat } from '../common/spreadsheet/paradisSpreadsheetNumberFormat.js';

const MAX_ROWS = 2000;

/** Heavy Node dependencies loaded only when the first workbook parse starts. */
export interface IParadisSpreadsheetRuntime {
	readonly ExcelJS: typeof ExcelJS;
	readonly JSZip: typeof JSZip;
}

type SpreadsheetRuntimeLoader = () => Promise<IParadisSpreadsheetRuntime>;

const loadSpreadsheetRuntime: SpreadsheetRuntimeLoader = async () => {
	const [excelJSModule, jsZipModule] = await Promise.all([
		import('exceljs'),
		import('jszip'),
	]);
	return { ExcelJS: excelJSModule.default, JSZip: jsZipModule.default };
};

/** CSS px(96dpi) を pt(72dpi) に。ページ割りの計算は pt で行う。 */
const PX_TO_PT = 72 / 96;

// exceljs の型定義は一部不完全なため、読み取るフィールドだけの局所インターフェースを定義して `any` を避ける。
interface IExcelColor {
	readonly argb?: string;
	readonly theme?: number;
	readonly tint?: number;
	readonly indexed?: number;
	readonly auto?: boolean;
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
interface IExcelDataValidation {
	readonly type?: IParadisDataValidation['type'];
	readonly operator?: IParadisDataValidation['operator'];
	readonly formulae?: readonly (string | number | boolean | Date)[];
	readonly allowBlank?: boolean;
	readonly showInputMessage?: boolean;
	readonly promptTitle?: string;
	readonly prompt?: string;
	readonly showErrorMessage?: boolean;
	readonly errorStyle?: string;
	readonly errorTitle?: string;
	readonly error?: string;
}

interface IExcelDataValidations {
	readonly model?: Readonly<Record<string, IExcelDataValidation | undefined>>;
}

/** exceljs の入力規則を IPC・diff 向けの安定した値へ正規化する。 */
function normalizeDataValidation(validation: IExcelDataValidation | undefined): IParadisDataValidation | undefined {
	if (!validation?.type) {
		return undefined;
	}
	const formulae = (validation.formulae ?? []).map(value => value instanceof Date ? value.toISOString() : String(value));
	return {
		type: validation.type,
		...(validation.operator !== undefined ? { operator: validation.operator } : {}),
		formulae,
		allowBlank: validation.allowBlank ?? false,
		showInputMessage: validation.showInputMessage ?? false,
		...(validation.promptTitle !== undefined ? { promptTitle: validation.promptTitle } : {}),
		...(validation.prompt !== undefined ? { prompt: validation.prompt } : {}),
		showErrorMessage: validation.showErrorMessage ?? false,
		errorStyle: validation.errorStyle ?? 'stop',
		...(validation.errorTitle !== undefined ? { errorTitle: validation.errorTitle } : {}),
		...(validation.error !== undefined ? { error: validation.error } : {}),
	};
}

interface IWorksheetDataValidations {
	readonly entries: readonly { readonly range: IParadisCellRange; readonly validation: IParadisDataValidation }[];
	readonly get: (address: string) => IParadisDataValidation | undefined;
}

function excelColumnName(column: number): string {
	let value = column;
	let result = '';
	while (value > 0) {
		value--;
		result = String.fromCharCode(65 + value % 26) + result;
		value = Math.floor(value / 26);
	}
	return result;
}

function getWorksheetDataValidations(ws: ExcelJS.Worksheet, ranges: readonly IParadisCellRange[]): IWorksheetDataValidations {
	const model = (ws as unknown as { readonly dataValidations?: IExcelDataValidations }).dataValidations?.model;
	const normalizedByRule = new Map<IExcelDataValidation, IParadisDataValidation>();
	const get = (address: string): IParadisDataValidation | undefined => {
		const source = model?.[address];
		if (!source) {
			return undefined;
		}
		let validation = normalizedByRule.get(source);
		if (!validation) {
			validation = normalizeDataValidation(source);
			if (!validation) {
				return undefined;
			}
			normalizedByRule.set(source, validation);
		}
		return validation;
	};
	const entries: { range: IParadisCellRange; validation: IParadisDataValidation }[] = [];
	for (const range of ranges) {
		const validation = get(`${excelColumnName(range.minC)}${range.minR}`);
		if (validation) {
			entries.push({ range: { ...range }, validation });
		}
	}
	return { entries: canonicalizeDataValidationEntries(entries), get };
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

// ── テーマ色の tint(OOXML 公式の HLS 輝度式) ──
// MS Learn(DocumentFormat.OpenXml Spreadsheet ColorType.Tint)の定義:
//   tint < 0: Lum' = Lum × (1 + tint)
//   tint > 0: Lum' = Lum × (1 − tint) + HLSMAX × tint
// 旧実装の RGB 各チャンネル線形補間は彩度を失い(青系がグレー寄りに)、Excel 実機の中間色とズレていた。

/** RGB(0-255)→HLS。h は0-360、l/s は0-255(HLSMAX=255 スケール)。 */
function rgbToHls(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l01 = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l01 > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
			case gn: h = (bn - rn) / d + 2; break;
			default: h = (rn - gn) / d + 4;
		}
		h *= 60;
	}
	return { h, s: s * 255, l: l01 * 255 };
}

/** HLS(h=0-360, l/s=0-255)→RGB(0-255)。 */
function hlsToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const ln = l / 255;
	const sn = s / 255;
	if (sn === 0) {
		const v = Math.round(l);
		return { r: v, g: v, b: v };
	}
	const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
	const p = 2 * ln - q;
	const hk = (((h % 360) + 360) % 360) / 360;
	const hue2rgb = (t: number): number => {
		if (t < 0) {
			t += 1;
		}
		if (t > 1) {
			t -= 1;
		}
		if (t < 1 / 6) {
			return p + (q - p) * 6 * t;
		}
		if (t < 1 / 2) {
			return q;
		}
		if (t < 2 / 3) {
			return p + (q - p) * (2 / 3 - t) * 6;
		}
		return p;
	};
	return {
		r: Math.round(hue2rgb(hk + 1 / 3) * 255),
		g: Math.round(hue2rgb(hk) * 255),
		b: Math.round(hue2rgb(hk - 1 / 3) * 255),
	};
}

/**
 * テーマ色へ tint を適用する(OOXML 公式の HLS 輝度式)。
 * 単体テストから直接参照するため export している。
 */
export function applyTint(hex: string, tint: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const { h, s, l } = rgbToHls(r, g, b);
	const lum = tint < 0 ? l * (1 + tint) : l * (1 - tint) + 255 * tint;
	const clamped = Math.min(255, Math.max(0, lum));
	const out = hlsToRgb(h, s, clamped);
	// テーマ色は parseThemeScheme で大文字化して保持するため、tint 結果も大文字で統一する。
	const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
	return `#${hex2(out.r)}${hex2(out.g)}${hex2(out.b)}`;
}

// ── レガシー indexed カラーパレット(ECMA-376 §18.8.27 既定値)。 ──
// 旧 BIFF 由来や一部生成ツールは罫線・フォント・塗りに indexed 0-63 を使う。
// exceljs は生値のまま返すだけで解決してくれないため、ここで既定パレットへ解決する。
const LEGACY_INDEXED_COLORS: readonly string[] = [
	'000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
	'000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
	'800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
	'9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
	'000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
	'00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
	'3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
	'003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/**
 * indexed カラー番号 → hex 色。単体テストから参照するため export。
 * 64=システム前景(黒として扱う)、65=システム背景(白として扱う)。範囲外は解決不可(null)。
 */
export function resolveIndexedColor(indexed: number): string | null {
	if (indexed === 64) {
		return '#000000';
	}
	if (indexed === 65) {
		return '#FFFFFF';
	}
	const entry = LEGACY_INDEXED_COLORS[indexed];
	return entry !== undefined ? `#${entry}` : null;
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
		return resolveIndexedColor(color.indexed);
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

function rowHeightToPt(h: number | undefined, defaultRowHeightPt: number | undefined): number {
	// 行に明示高が無ければシートの既定行高(sheetFormatPr defaultRowHeight、pt)を使う。最後の 15pt は 20px 相当(旧既定)。
	return h && h > 0 ? h : (defaultRowHeightPt && defaultRowHeightPt > 0 ? defaultRowHeightPt : 15);
}

function rowHeightToPx(h: number | undefined, defaultRowHeightPt: number | undefined): number {
	return Math.round((rowHeightToPt(h, defaultRowHeightPt) * 96) / 72);
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

// 印刷のページ割り用の列幅(pt)。表示用の charWidthToPx は左右パディング(+5px)を上乗せしているが、
// Excel の保存値(文字数単位)にはパディングが既に含まれているため、そのまま足すと 51 列で 1 ページ分ほど
// 余計に幅を見積もってしまう。ページ割りには OOXML の換算式をそのまま使う。
function charWidthToPrintPt(w: number | undefined, defaultColWidth: number | undefined, maxDigitWidth: number): number {
	const chars = w && w > 0 ? w : (defaultColWidth && defaultColWidth > 0 ? defaultColWidth : 8.43);
	const px = Math.trunc(((256 * chars + Math.trunc(128 / maxDigitWidth)) / 256) * maxDigitWidth);
	return px * PX_TO_PT;
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
	// 先にフォントを適用し、後から配置を上書きする。逆順だと上付き/下付き(vertAlign)が
	// セルの縦位置(bottom等)を破壊してしまうため、明示配置を優先させる。
	fontToStyle(cell.font as IExcelFont | undefined, style);
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
		// 呼び出し側で「数値/日付=右/文字=左/真偽値・エラー=中央」の規則に従って textAlign を決める。
		if (al.horizontal) {
			style.textAlign = hmap[al.horizontal] || 'left';
		}
		// vertical 未指定のときは fontToStyle 由来の上付き/下付き(super/sub)を尊重する。
		// 既定は bottom(Excel の初期縦位置)。
		if (al.vertical) {
			style.verticalAlign = vmap[al.vertical] || 'bottom';
		}
		// indent は左寄せ系なら左パディング、右寄せなら右パディングに効く(Excel の挙動に合わせる)。
		if (al.indent && al.indent > 0) {
			const pad = `${al.indent * 8 + 3}px`;
			if (style.textAlign === 'right') {
				style.paddingRight = pad;
			} else {
				style.paddingLeft = pad;
			}
		}
	}
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
	const rawColor = rawExcelColor(dg.color);
	return {
		up,
		down,
		style: base,
		color,
		rawStyle: dg.style,
		...(rawColor ? { rawColor } : {}),
	};
}

/** Test seam for ExcelJS color variants that its XLSX round-trip does not preserve. */
export function getCellDiagonalForTest(cell: ExcelJS.Cell): IParadisDiagonalBorder | undefined {
	return getCellDiagonal(cell);
}

function rawExcelColor(color: IExcelColor | undefined): ParadisSpreadsheetColor | undefined {
	if (!color) {
		return undefined;
	}
	const tint = color.tint !== undefined ? String(color.tint) : undefined;
	if (color.argb !== undefined) {
		return { kind: 'rgb', rgb: color.argb, ...(tint !== undefined ? { tint } : {}) };
	}
	if (color.theme !== undefined) {
		return { kind: 'theme', theme: color.theme, ...(tint !== undefined ? { tint } : {}) };
	}
	if (color.indexed !== undefined) {
		return { kind: 'indexed', indexed: color.indexed, ...(tint !== undefined ? { tint } : {}) };
	}
	if (color.auto !== undefined) {
		return { kind: 'auto', auto: color.auto, ...(tint !== undefined ? { tint } : {}) };
	}
	return undefined;
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

/**
 * 日付の表示フォールバック。ホストロケール依存の toLocaleDateString ではなく
 * 決定論的な「YYYY-MM-DD(時刻があれば HH:MM:SS)」で出す。表示が環境でブレると
 * 差分ビューアで偽の値変更になってしまうため。
 */
export function formatDateFallback(value: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	let out = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	if (value.getHours() || value.getMinutes() || value.getSeconds() || value.getMilliseconds()) {
		out += ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
	}
	return out;
}

/**
 * セルの表示文字列を作る。
 *
 * exceljs の `cell.text` は値の toString を返すだけで**表示形式(numFmt)を適用しない**ため、
 * パーセント・通貨・桁区切り・会計書式・科学表記・分数・経過時間などが素の数値のまま出てしまう。
 * 表示形式が付いているセルは共通の書式エンジンへ通し、扱えない書式や失敗時のみ従来の表示へ戻す。
 */
function getCellDisplayValue(cell: ExcelJS.Cell, formatter?: ISheetNumberFormatter): string {
	const runs = getRichTextRuns(cell);
	if (runs) {
		return runs.map(rt => rt.text || '').join('');
	}
	const value = cell.value;
	if (value instanceof Date) {
		return formatter?.format(cell, value) ?? formatDateFallback(value);
	}
	const asFormula = value as { formula?: string; result?: unknown } | null | undefined;
	if (asFormula && typeof asFormula === 'object' && asFormula.formula !== undefined) {
		const result = asFormula.result;
		// 数式の計算結果も、直値のセルと同じ表示規則に合わせる。日付は決定論的フォールバックを通し
		// (でなければ toString の環境依存表示に戻ってしまう)、エラーは #DIV/0! 等の文字列をそのまま出す
		// (でなければ [object Object] になる)。
		const asError = result as { error?: unknown } | null | undefined;
		if (asError && typeof asError === 'object' && typeof asError.error === 'string') {
			return asError.error;
		}
		const formatted = formatter?.format(cell, result);
		if (formatted !== undefined) {
			return formatted;
		}
		if (result instanceof Date) {
			return formatDateFallback(result);
		}
		return isNotNil(result) ? String(result) : '';
	}
	const formatted = formatter?.format(cell, value);
	if (formatted !== undefined) {
		return formatted;
	}
	if (isNotNil(cell.text)) {
		return String(cell.text);
	}
	if (isNotNil(value)) {
		return String(value);
	}
	return '';
}

/** Excel のシリアル値の基準日(1900年方式)。Date を書式エンジンへ渡すために逆変換する。 */
/**
 * 整形結果を採用してよいか決める。
 *
 * 近似止まりの書式は誤った見た目になるので従来表示へ委ねるが、`*`(塗りつぶし揃え)だけは例外。
 * これは「残り幅を指定文字で埋める」指定で、数値そのものの整形は正しくできている。
 * 会計書式(組み込み 41-44 や `_("$"* #,##0.00_)` など)は必ずこれを含むため、
 * 一律に捨てると会計書式が丸ごと効かなくなる。
 */
function usableFormattedText(result: ParadisFormattedCellValue): string | undefined {
	if (result.status === 'exact') {
		return result.text;
	}
	return result.unsupportedTokens.length > 0 && result.unsupportedTokens.every(token => token.startsWith('*'))
		? result.text
		: undefined;
}

/** 解析済み書式の保持上限。書式コードを大量に変えたファイルで溜め込まないための蓋。 */
const MAX_PREPARED_NUMBER_FORMATS = 512;

const EXCEL_SERIAL_EPOCH_OFFSET_1900 = 25569;
const EXCEL_SERIAL_EPOCH_OFFSET_1904 = 24107;
const MILLISECONDS_PER_DAY = 86400000;

interface ISheetNumberFormatter {
	/** 表示形式を適用した文字列。適用できない(または表示形式が無い)場合は undefined。 */
	format(cell: ExcelJS.Cell, value: unknown): string | undefined;
}

/**
 * ブック1冊分の表示形式エンジン。同じ numFmt を持つセルが大量にあるため、
 * 解析済みの書式をコード文字列でキャッシュして使い回す。
 */
function createSheetNumberFormatter(date1904: boolean): ISheetNumberFormatter {
	const prepared = new Map<string, ParadisSpreadsheetPreparedNumberFormat | null>();
	const context = { date1904 };
	const serialEpoch = date1904 ? EXCEL_SERIAL_EPOCH_OFFSET_1904 : EXCEL_SERIAL_EPOCH_OFFSET_1900;

	// 解析済みの書式は、同じ書式コードを持つセルで使い回す。ただし
	// (1) 書式コードを大量に変えたファイルで際限なく溜めない
	// (2) 解析済みハンドルは「用意した時点」からの制限時間を持つので、期限切れになったら
	//     作り直す(そうしないと途中から全セルの表示形式が黙って外れる)
	// の2点を守る。
	const resolve = (code: string): ParadisSpreadsheetPreparedNumberFormat | null => {
		const cached = prepared.get(code);
		if (cached !== undefined) {
			return cached;
		}
		if (prepared.size >= MAX_PREPARED_NUMBER_FORMATS) {
			prepared.clear();
		}
		let handle: ParadisSpreadsheetPreparedNumberFormat | null;
		try {
			handle = prepareSpreadsheetNumberFormat(code, context);
		} catch {
			// 壊れた書式コードは以後もあきらめる(セルごとに例外を出さない)。
			handle = null;
		}
		prepared.set(code, handle);
		return handle;
	};

	return {
		format(cell, value) {
			const code = (cell as { numFmt?: string }).numFmt;
			// General(表示形式なし)は従来の表示のままにする。
			if (!code || code === 'General') {
				return undefined;
			}
			// 書式エンジンは数値・文字列・真偽値だけを受け取る。Date はシリアル値へ戻す。
			// exceljs はファイル中のシリアル値を UTC の瞬間として Date 化するので、逆変換も UTC で行う
			// (ローカル基準で戻すと時差ぶんずれ、時刻だけのセルが実行環境によって別の値になる)。
			const input = value instanceof Date
				? value.getTime() / MILLISECONDS_PER_DAY + serialEpoch
				: value;
			if (input === null || input === undefined || (typeof input !== 'number' && typeof input !== 'string' && typeof input !== 'boolean')) {
				return undefined;
			}
			const handle = resolve(code);
			if (handle === null) {
				return undefined;
			}
			try {
				return usableFormattedText(formatPreparedSpreadsheetValue(handle, input));
			} catch {
				// 期限切れのハンドルを掴んでいる可能性があるので、一度だけ作り直して試す。
				prepared.delete(code);
				const retry = resolve(code);
				if (retry === null) {
					return undefined;
				}
				try {
					return usableFormattedText(formatPreparedSpreadsheetValue(retry, input));
				} catch {
					// 2回続けて駄目なら書式コード自体が扱えないものとして以後あきらめる。
					prepared.set(code, null);
					return undefined;
				}
			}
		},
	};
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

function isNumericCell(cell: ExcelJS.Cell, numberCellType: ExcelJS.ValueType): boolean {
	if (cell.type === numberCellType) {
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

/** 日付セルか(exceljs は Date を ValueType.Date / Date オブジェクトで返す)。general 配置では数値と同じく右寄せ。 */
function isDateCell(cell: ExcelJS.Cell): boolean {
	if (cell.value instanceof Date) {
		return true;
	}
	const asFormula = cell.value as { formula?: unknown; result?: unknown } | null | undefined;
	return !!asFormula && typeof asFormula === 'object' && asFormula.formula !== undefined && asFormula.result instanceof Date;
}

/** 真偽値セルか。general 配置の既定寄せは中央(ECMA-376 ST_HorizontalAlignment「Boolean types are centered」)。 */
function isBooleanCell(cell: ExcelJS.Cell, booleanCellType: ExcelJS.ValueType): boolean {
	if (cell.type === booleanCellType) {
		return true;
	}
	const v = cell.value;
	if (typeof v === 'boolean') {
		return true;
	}
	const asFormula = v as { formula?: unknown; result?: unknown } | null | undefined;
	return !!asFormula && typeof asFormula === 'object' && typeof asFormula.result === 'boolean';
}

/** エラー値セルか(#DIV/0! 等)。general 配置の既定寄せは真偽値と同じく中央。 */
function isErrorCell(cell: ExcelJS.Cell, errorCellType: ExcelJS.ValueType): boolean {
	if (cell.type === errorCellType) {
		return true;
	}
	const v = cell.value as { error?: unknown; formula?: unknown; result?: { error?: unknown } } | null | undefined;
	if (!v || typeof v !== 'object') {
		return false;
	}
	if (typeof v.error === 'string') {
		return true;
	}
	const result = v.result as { error?: unknown } | undefined;
	return !!result && typeof result === 'object' && typeof result.error === 'string';
}

/** 印刷したときに何か出るセルか(値・自分自身に設定された罫線・塗り)。ページ割りの範囲決めに使う。 */
function hasPrintableContent(cell: ExcelJS.Cell, displayValue: string): boolean {
	if (displayValue !== '') {
		return true;
	}
	const b = cell.border as { top?: unknown; bottom?: unknown; left?: unknown; right?: unknown; diagonal?: unknown } | undefined;
	if (b && (b.top || b.bottom || b.left || b.right || b.diagonal)) {
		return true;
	}
	const fill = cell.fill as { type?: string; pattern?: string } | undefined;
	return fill?.type === 'pattern' && fill.pattern !== undefined && fill.pattern !== 'none';
}

/** ウィンドウ枠の固定(sheetView の frozen pane)。分割(split)は固定ではないので対象外。 */
function getSheetFreezePane(ws: ExcelJS.Worksheet): IParadisFreezePane | undefined {
	const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
	if (view?.state !== 'frozen') {
		return undefined;
	}
	const cols = Math.max(0, Math.trunc(view.xSplit ?? 0));
	const rows = Math.max(0, Math.trunc(view.ySplit ?? 0));
	return cols === 0 && rows === 0 ? undefined : { cols, rows };
}

/** 意味解析にかける上限。超えたら診断は「出せなかった」として表示側へ委ねる。 */
const SEMANTIC_DIAGNOSTICS_DEADLINE_MS = 4000;

/**
 * ExcelJS の投影とは別に OOXML を直接読み、到達度と食い違いを数える。
 * 表示そのものは投影側が担うため、ここが失敗しても表示は変わらない(理由だけ返す)。
 */
async function collectSemanticDiagnostics(bytes: Uint8Array): Promise<IParadisSemanticDiagnosticsSummary> {
	const unavailable = (reason: string): IParadisSemanticDiagnosticsSummary => ({
		available: false, terminal: false,
		expectedParts: 0, parsedParts: 0, expectedSheets: 0, parsedSheets: 0, expectedCells: 0, parsedCells: 0,
		unknownElements: 0, unresolvedReferences: 0, mismatchCount: 0, unavailableReason: reason,
	});
	// 解析全体に締め切りを掛ける。パッケージ検査は自前の予算(30秒)を持っており、
	// こちらの締め切りの外側にあるため、トークンで確実に止められるようにする。
	const source = new CancellationTokenSource();
	const timer = setTimeout(() => source.cancel(), SEMANTIC_DIAGNOSTICS_DEADLINE_MS);
	try {
		const archive = await createParadisOfficeNodeArchive(bytes);
		const inventory = await inspectOfficePackage(archive, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, source.token);
		// 投影との全件突き合わせは行わない。表示用データは非表示行・列オフセット・行数上限で
		// 意図的に間引いてあるため、差分が実質すべて「表示側に無いセル」になり上限で解析ごと落ちる。
		// ここで欲しいのは「どこまで読めたか」なので到達度だけを取る。
		const snapshot = await parseSpreadsheetSemanticNode(bytes, inventory, source.token, {
			deadlineMilliseconds: SEMANTIC_DIAGNOSTICS_DEADLINE_MS,
		});
		const mismatchesByKind: Record<string, number> = {};
		for (const diagnostic of snapshot.projectionDiagnostics) {
			mismatchesByKind[diagnostic.kind] = (mismatchesByKind[diagnostic.kind] ?? 0) + 1;
		}
		const completeness = snapshot.completeness;
		return {
			available: true,
			terminal: completeness.terminal,
			expectedParts: completeness.expectedParts,
			parsedParts: completeness.parsedParts,
			expectedSheets: completeness.expectedSheets,
			parsedSheets: completeness.parsedSheets,
			expectedCells: completeness.expectedCells,
			parsedCells: completeness.parsedCells,
			unknownElements: completeness.unknownElements,
			unresolvedReferences: completeness.unresolvedReferences,
			mismatchCount: snapshot.projectionDiagnostics.length,
			...(Object.keys(mismatchesByKind).length > 0 ? { mismatchesByKind } : {}),
		};
	} catch (error) {
		return unavailable(error instanceof Error ? error.name : 'unknown');
	} finally {
		clearTimeout(timer);
		source.dispose();
	}
}

/** シート上のテーブル。縞模様・見出し行・集計行の描き分けに使う。 */
function getSheetTables(ws: ExcelJS.Worksheet): readonly IParadisSheetTable[] {
	const tables = (ws as unknown as { tables?: Record<string, unknown> }).tables;
	if (!tables) {
		return [];
	}
	const result: IParadisSheetTable[] = [];
	for (const entry of Object.values(tables)) {
		const model = (entry as { table?: Record<string, unknown> })?.table;
		const ref = typeof model?.tableRef === 'string' ? model.tableRef : undefined;
		const range = ref ? parseConditionalFormatRef(ref)[0] : undefined;
		if (!range) {
			continue;
		}
		const style = (model?.style ?? {}) as Record<string, unknown>;
		result.push({
			name: typeof model?.displayName === 'string' ? model.displayName : (typeof model?.name === 'string' ? model.name : ''),
			range,
			// exceljs は headerRowCount を boolean へ潰すので、属性の有無は区別できない。
			// そのまま真偽値として読む(`!== false` は何も守らない)。
			headerRow: model?.headerRow === true,
			totalsRow: model?.totalsRow === true,
			showRowStripes: style.showRowStripes === true,
			showColumnStripes: style.showColumnStripes === true,
			showFirstColumn: style.showFirstColumn === true,
			showLastColumn: style.showLastColumn === true,
		});
	}
	return result;
}

/** オートフィルタとテーブルのフィルタ範囲。見出し行にフィルタ記号を出すために使う。 */
function getSheetFilterRanges(ws: ExcelJS.Worksheet): readonly IParadisCellRange[] {
	const ranges: IParadisCellRange[] = [];
	const autoFilter = (ws as { autoFilter?: unknown }).autoFilter;
	if (typeof autoFilter === 'string') {
		ranges.push(...parseConditionalFormatRef(autoFilter));
	} else if (autoFilter && typeof autoFilter === 'object') {
		// exceljs は {from, to} 形式でも返す。from/to はアドレス文字列または {row, col}。
		const { from, to } = autoFilter as { from?: unknown; to?: unknown };
		const toAddress = (value: unknown): string | undefined => {
			if (typeof value === 'string') {
				return value;
			}
			if (value && typeof value === 'object') {
				const { row, column } = value as { row?: number; column?: number };
				if (typeof row === 'number' && typeof column === 'number') {
					return `${columnIndexToLetters(column)}${row}`;
				}
			}
			return undefined;
		};
		const fromAddress = toAddress(from);
		const toAddressValue = toAddress(to);
		if (fromAddress && toAddressValue) {
			ranges.push(...parseConditionalFormatRef(`${fromAddress}:${toAddressValue}`));
		}
	}
	const tables = (ws as unknown as { tables?: Record<string, unknown> }).tables;
	for (const table of tables ? Object.values(tables) : []) {
		// パース後のモデルの範囲は tableRef。`ref` は書き出し側の名前で、読み取り時には存在しない。
		const model = (table as { table?: { tableRef?: string; headerRow?: boolean } })?.table;
		if (model?.tableRef && model.headerRow === true) {
			ranges.push(...parseConditionalFormatRef(model.tableRef));
		}
	}
	return ranges;
}

function columnIndexToLetters(index: number): string {
	let letters = '';
	let remaining = index;
	while (remaining > 0) {
		const rest = (remaining - 1) % 26;
		letters = String.fromCharCode(65 + rest) + letters;
		remaining = Math.floor((remaining - 1) / 26);
	}
	return letters || 'A';
}

/** 条件付き書式の評価結果(CSS)を、既に組み上がった行データへ焼き込む。 */
function applyConditionalFormattingToRows(
	rows: readonly IParadisRowData[],
	styleByCell: ReadonlyMap<string, Record<string, string>>,
	minCol: number,
	showGridLines: boolean,
): IParadisRowData[] {
	if (styleByCell.size === 0) {
		return [...rows];
	}
	return rows.map(row => {
		let changed = false;
		const cells = row.cells.map((cell, index) => {
			// cells は minCol 起点の連番なので、Excel の実列番号へ戻してから引く。
			const overrides = styleByCell.get(`${row.excelRow},${minCol + index}`);
			if (!overrides) {
				return cell;
			}
			changed = true;
			const style: Record<string, string> = { ...cell.style, ...overrides };
			// 塗りのあるセルはグリッド線を塗り色の罫線で打ち消してある(getCellStyle の直後を参照)。
			// 条件付き書式で背景が変わったら、その打ち消し罫線も新しい色へ揃え直さないと
			// 元の塗り色の枠が 1px 残る。明示的な罫線(元から色が違うもの)は触らない。
			const nextBackground = overrides.backgroundColor;
			if (showGridLines && nextBackground) {
				const previousBackground = cell.style.backgroundColor;
				for (const side of ['borderTop', 'borderBottom', 'borderLeft', 'borderRight']) {
					if (!style[side] || (previousBackground && style[side] === `1px solid ${previousBackground}`)) {
						style[side] = `1px solid ${nextBackground}`;
					}
				}
			}
			return { ...cell, style };
		});
		return changed ? { ...row, cells } : row;
	});
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
	dataValidationRangesBySheet: { [sheetIndex: number]: IParadisCellRange[] };
	/** 用紙設定(表示順キー)。ページ割りの計算に使う。 */
	pageSetupBySheet: { [sheetIndex: number]: IParadisPageSetup };
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

function extractDataValidationRanges(sheetXml: string): IParadisCellRange[] {
	const ranges: IParadisCellRange[] = [];
	for (const tag of sheetXml.match(/<dataValidation\b[^>]*>/g) ?? []) {
		const sqref = tag.match(/\bsqref="([^"]+)"/)?.[1];
		if (!sqref) {
			continue;
		}
		for (const reference of sqref.trim().split(/\s+/)) {
			const normalized = reference.replace(/\$/g, '').toUpperCase();
			const range = normalized.includes(':') ? parsePrintArea(normalized) : parsePrintArea(`${normalized}:${normalized}`);
			if (range) {
				ranges.push(range);
			}
		}
	}
	return ranges;
}

// exceljs 4.4.0 は図形(drawing)・改ページ(rowBreaks/colBreaks)を読めないため、xlsx(ZIP)を jszip で直読みする。
// 図形/画像の解析には DOMParser が要るが node 層には無いので、drawing XML と埋め込みメディア(rId→dataURI)を
// renderer へ渡し renderer が DOMParser で図形化する。改ページは brk の id だけ抜き出す。
// 注意: sheetN.xml の「ファイル番号」は表示順と一致しない(workbook.xml の <sheets> 並びが表示順)。
// exceljs の eachSheet は表示順なので、すべて「表示順(1始まり)」に正規化して返す。
async function extractXlsxExtras(buffer: Buffer, JSZipRuntime: typeof JSZip): Promise<IXlsxExtras> {
	const drawingsBySheet: { [sheetIndex: number]: IParadisDrawingData[] } = {};
	const rowBreaksBySheet: { [sheetIndex: number]: number[] } = {};
	const colBreaksBySheet: { [sheetIndex: number]: number[] } = {};
	const dataValidationRangesBySheet: { [sheetIndex: number]: IParadisCellRange[] } = {};
	const pageSetupBySheet: { [sheetIndex: number]: IParadisPageSetup } = {};
	let themeColorsByName: { [name: string]: string } | undefined;
	let maxDigitWidth = 7;
	try {
		const zip = await JSZipRuntime.loadAsync(buffer as unknown as Parameters<typeof JSZip.loadAsync>[0]);
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
		let workbookXml = '';
		if (wb) {
			workbookXml = await wb.async('text');
			let display = 0;
			for (const st of (workbookXml.match(/<sheet [^>]*?\/?>/g) ?? [])) {
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
			const dataValidationRanges = extractDataValidationRanges(sheetXml);
			if (dataValidationRanges.length > 0) {
				dataValidationRangesBySheet[key] = dataValidationRanges;
			}
			// 用紙設定。exceljs は fitToPage・pageOrder・用紙コードを落とすので XML から直接読む。
			const titleRows = workbookXml ? parsePrintTitleRows(workbookXml, key - 1) : undefined;
			pageSetupBySheet[key] = {
				...parsePageSetup(sheetXml),
				...(titleRows ? { repeatRowsFrom: titleRows.from, repeatRowsTo: titleRows.to } : {}),
			};
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
	return { drawingsBySheet, rowBreaksBySheet, colBreaksBySheet, dataValidationRangesBySheet, pageSetupBySheet, themeColorsByName, maxDigitWidth };
}

export class ParadisSpreadsheetService implements IParadisSpreadsheetService {
	private runtimePromise: Promise<IParadisSpreadsheetRuntime> | undefined;

	constructor(private readonly runtimeLoader: SpreadsheetRuntimeLoader = loadSpreadsheetRuntime) { }

	async parseWorkbook(base64Content: string, options?: IParadisParseWorkbookOptions): Promise<IParadisWorkbookData> {
		const runtime = await this.getRuntime();
		const workbook = new runtime.ExcelJS.Workbook();
		const buffer = Buffer.from(base64Content, 'base64');
		// CFB(Compound File Binary)コンテナ=暗号化ブック。zip ではないため jszip/exceljs からは
		// 「central directory が見つからない」ような不親切なエラーで落ちる。先頭マジックで判別し、
		// ビューア/差分がそのまま表示できる理由文言へ変換する(D0 CF 11 E0 = OLE2 標準シグネチャ)。
		if (buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) {
			throw new Error(localize('paradis.spreadsheet.encryptedWorkbook', "このブックはパスワードで保護されているため開けません。パスワードを解除してから再度お試しください。"));
		}
		// exceljs の Buffer 型定義が現行 @types/node の Buffer と食い違うため、load の期待型そのものへ interop キャストする。
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

		const extras = await extractXlsxExtras(buffer, runtime.JSZip);

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

		// 表示形式は exceljs が適用しないので、ブック単位の書式エンジンを用意して各セルへ通す。
		const numberFormatter = createSheetNumberFormatter((workbook.properties as { date1904?: boolean } | undefined)?.date1904 === true);

		const sheets: IParadisSheetData[] = [];
		let sheetIndex = 0;

		workbook.eachSheet(worksheet => {
			sheetIndex++;
			const dims = getSheetDimensions(worksheet);
			const worksheetDataValidations = getWorksheetDataValidations(worksheet, extras.dataValidationRangesBySheet[sheetIndex] ?? []);
			const mergeMap = buildMergeMap(worksheet);
			const colCount = dims.maxC - dims.minC + 1;
			const sheetProps = worksheet.properties as { defaultColWidth?: number; defaultRowHeight?: number } | undefined;
			const showGridLines = (worksheet.views?.[0] as { showGridLines?: boolean } | undefined)?.showGridLines ?? true;
			const columnWidths: number[] = [];
			const columnPrintWidthsPt: number[] = [];
			for (let c = dims.minC; c <= dims.maxC; c++) {
				const col = worksheet.getColumn(c);
				columnWidths.push(col.hidden ? 0 : charWidthToPx(col.width, sheetProps?.defaultColWidth, extras.maxDigitWidth));
				columnPrintWidthsPt.push(col.hidden ? 0 : charWidthToPrintPt(col.width, sheetProps?.defaultColWidth, extras.maxDigitWidth));
			}

			const rows: IParadisRowData[] = [];
			const maxRow = Math.min(dims.maxR, dims.minR + MAX_ROWS - 1);
			const truncated = dims.maxR > maxRow;
			// 条件付き書式は範囲全体の最小/最大が要るため、セル実値を集めてから後段で評価する。
			const conditionalFormattings = (worksheet as unknown as { conditionalFormattings?: readonly IParadisLegacyCfBlock[] }).conditionalFormattings;
			const hasConditionalFormatting = !!conditionalFormattings?.length;
			const conditionalValues: IParadisLegacyCfCellValue[] = [];

			// 印刷して何か出る最も右下のセル。使用範囲の末尾は空のことが多く、そこを含めるとページが余分に増える。
			// resolveEdgeBorders 後のスタイルは隣接セルの罫線を写し取っているので、判定には生のセルを使う。
			let printMaxRow = dims.minR - 1;
			let printMaxCol = dims.minC - 1;

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
					const val = getCellDisplayValue(cell, numberFormatter);
					const style: Record<string, string> = getCellStyle(cell) as Record<string, string>;
					// general 配置(明示指定なし)の既定寄せ(ECMA-376): 数値・日付=右、真偽値・エラー値=中央。
					if (!style.textAlign) {
						const vt = runtime.ExcelJS.ValueType;
						if (isNumericCell(cell, vt.Number) || isDateCell(cell)) {
							style.textAlign = 'right';
						} else if (isBooleanCell(cell, vt.Boolean) || isErrorCell(cell, vt.Error)) {
							style.textAlign = 'center';
						}
					}
					const mergeInfo = mergeEntry && mergeEntry.kind === 'origin' ? mergeEntry : null;
					const colspan = mergeInfo?.colspan ?? 1;
					const rowspan = mergeInfo?.rowspan ?? 1;

					if (hasPrintableContent(cell, val)) {
						printMaxRow = Math.max(printMaxRow, r + rowspan - 1);
						printMaxCol = Math.max(printMaxCol, c + colspan - 1);
					}

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
					// 折り返しは Excel の設定(alignment.wrapText)だけに従う。セル内に改行文字があっても、
					// 折り返しが無効なら Excel は改行を表示せず1行で描き、狭い列では隣へはみ出させる。
					// ここで改行の有無から折り返しを推測すると、幅の狭い列で1文字ずつ折り返されて
					// 行高が破綻し、はみ出し描画にも入れなくなる。
					const wrapText = al?.wrapText === true;
					const verticalText = al?.textRotation === 'vertical' || al?.textRotation === 255;
					const shrinkToFit = al?.shrinkToFit === true;
					const diagonal = getCellDiagonal(cell);
					const dataValidation = worksheetDataValidations.get(cell.address.toUpperCase());

					const parsed: IParadisCellData = {
						value: val,
						style,
						...(mergeInfo ? { colSpan: colspan, rowSpan: rowspan } : {}),
						...(wrapText ? { wrapText: true } : {}),
						...(verticalText ? { verticalText: true } : {}),
						...(shrinkToFit ? { shrinkToFit: true } : {}),
						...(richText ? { richText } : {}),
						...(diagonal ? { diagonal } : {}),
						...(dataValidation ? { dataValidation } : {}),
					};
					cells.push(parsed);
					if (hasConditionalFormatting) {
						const numeric = typeof cell.value === 'number'
							? cell.value
							: (cell.result !== undefined && typeof cell.result === 'number' ? cell.result : undefined);
						conditionalValues.push({ row: r, col: c, ...(numeric !== undefined ? { num: numeric } : {}), text: val });
					}
				}

				rows.push({ excelRow: r, cells, height: rowHeightToPx(row.height, sheetProps?.defaultRowHeight) });
			}

			const view = worksheet.views?.[0] as { zoomScale?: number } | undefined;
			const tabColorArgb = (worksheet.properties as { tabColor?: IExcelColor } | undefined)?.tabColor;
			const tabColor = resolveColor(tabColorArgb) ?? undefined;
			const protectedSheet = (worksheet as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet === true;
			const printArea = getSheetPrintArea(worksheet);

			// ページ割り(自動改ページとページ番号)。行・列の大きさは pt で渡す。非表示行・非表示列は 0。
			const pageSetup = extras.pageSetupBySheet[sheetIndex];
			let pageLayout: IParadisPageLayout | undefined;
			if (pageSetup) {
				// 印刷範囲が明示されていればそれを、無ければ「何か出る最も右下のセル」までをページ割りの対象にする。
				const lastRow = printArea ? Math.min(printArea.maxR, maxRow) : Math.min(printMaxRow, maxRow);
				const lastCol = printArea ? Math.min(printArea.maxC, dims.maxC) : printMaxCol;
				const printColCount = Math.max(0, lastCol - dims.minC + 1);
				const rowHeightsPt: number[] = [];
				for (let r = dims.minR; r <= lastRow; r++) {
					const row = worksheet.getRow(r);
					rowHeightsPt.push(row.hidden ? 0 : rowHeightToPt(row.height, sheetProps?.defaultRowHeight));
				}
				pageLayout = computePageLayout({
					setup: pageSetup,
					minRow: dims.minR,
					rowHeights: rowHeightsPt,
					minCol: dims.minC,
					colWidths: columnPrintWidthsPt.slice(0, printColCount),
					manualRowBreaks: extras.rowBreaksBySheet[sheetIndex] ?? [],
					manualColBreaks: extras.colBreaksBySheet[sheetIndex] ?? [],
				});
			}

			// 条件付き書式を評価し、結果の CSS をセルスタイルへ焼き込む(描画側は無改造で反映される)。
			// ルール由来のスタイルは元のセル書式より優先される(Excel と同じ挙動)。
			const conditionalRows = hasConditionalFormatting
				? applyConditionalFormattingToRows(rows, evaluateLegacyConditionalFormatting(conditionalFormattings, conditionalValues, color => resolveColor(color as IExcelColor | undefined)), dims.minC, showGridLines)
				: rows;

			const freezePane = getSheetFreezePane(worksheet);
			const filterRanges = getSheetFilterRanges(worksheet);
			const tables = getSheetTables(worksheet);

			sheets.push({
				name: worksheet.name,
				rows: conditionalRows,
				columnCount: colCount,
				columnWidths,
				truncated,
				minCol: dims.minC,
				...(freezePane ? { freezePane } : {}),
				...(filterRanges.length > 0 ? { filterRanges } : {}),
				...(tables.length > 0 ? { tables } : {}),
				...(worksheetDataValidations.entries.length > 0 ? { dataValidations: worksheetDataValidations.entries } : {}),
				showGridLines,
				...(view?.zoomScale ? { zoomScale: view.zoomScale } : {}),
				...(tabColor ? { tabColor } : {}),
				...(protectedSheet ? { protectedSheet: true } : {}),
				...(extras.rowBreaksBySheet[sheetIndex] ? { rowBreaks: extras.rowBreaksBySheet[sheetIndex] } : {}),
				...(extras.colBreaksBySheet[sheetIndex] ? { colBreaks: extras.colBreaksBySheet[sheetIndex] } : {}),
				...(printArea ? { printArea } : {}),
				...(pageLayout ? { pageLayout } : {}),
			});
		});

		const projection: IParadisWorkbookData = {
			sheets,
			drawingsBySheet: extras.drawingsBySheet,
			...(extras.themeColorsByName ? { themeColors: extras.themeColorsByName } : {}),
		};
		// 表示は投影で確定済み。意味解析は診断表示のためだけに回すので、
		// 診断を出さない設定のときは費用を払わない。失敗しても表示は変わらない。
		if (options?.semanticDiagnostics !== true) {
			return projection;
		}
		// 解析側は Uint8Array そのものを要求する(Buffer を渡すと invalid で弾かれる)。
		const semanticDiagnostics = await collectSemanticDiagnostics(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
		return { ...projection, semanticDiagnostics };
	}

	private getRuntime(): Promise<IParadisSpreadsheetRuntime> {
		const runtimePromise = this.runtimePromise ??= this.runtimeLoader();
		return runtimePromise.catch(error => {
			if (this.runtimePromise === runtimePromise) {
				this.runtimePromise = undefined;
			}
			throw error;
		});
	}
}

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
import {
	IParadisCellData,
	IParadisCellStyle,
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

// ── Excel標準テーマ色(Office) ──
const THEME_COLORS: Record<number, string> = {
	0: '#FFFFFF', 1: '#000000', 2: '#E7E6E6', 3: '#44546A', 4: '#4472C4',
	5: '#ED7D31', 6: '#A5A5A5', 7: '#FFC000', 8: '#5B9BD5', 9: '#70AD47',
};

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
	const hex = argb.length === 8 ? argb.slice(2) : argb;
	if (/^0+$/.test(hex)) {
		return null;
	}
	return `#${hex}`;
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
		const base = THEME_COLORS[color.theme] || '#000000';
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

function rowHeightToPx(h: number | undefined): number {
	if (!h || h <= 0) {
		return 20;
	}
	return Math.round((h * 96) / 72);
}

function charWidthToPx(w: number | undefined): number {
	if (!w || w <= 0) {
		return 64;
	}
	return Math.max(4, Math.round(w * 10));
}

function fontToStyle(font: IExcelFont | undefined, into: Record<string, string>): void {
	if (!font) {
		return;
	}
	if (font.size) {
		into.fontSize = `${font.size}pt`;
	}
	if (font.name) {
		into.fontFamily = `'${font.name}', sans-serif`;
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
	const fc = resolveColor(font.color);
	if (fc && fc !== '#FFFFFF') {
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
	const bd = cell.border;
	if (bd) {
		const bt = borderToCSS(bd.top as IExcelBorderSide | undefined);
		if (bt) {
			style.borderTop = bt;
		}
		const bb = borderToCSS(bd.bottom as IExcelBorderSide | undefined);
		if (bb) {
			style.borderBottom = bb;
		}
		const bl = borderToCSS(bd.left as IExcelBorderSide | undefined);
		if (bl) {
			style.borderLeft = bl;
		}
		const br = borderToCSS(bd.right as IExcelBorderSide | undefined);
		if (br) {
			style.borderRight = br;
		}
	}
	return style;
}

function getMergedCellBorders(ws: ExcelJS.Worksheet, r: number, c: number, rowspan: number, colspan: number): Record<string, string> {
	const borders: Record<string, string> = {};
	const getBorder = (row: number, col: number) => ws.getRow(row).getCell(col).border;
	const topBd = getBorder(r, c);
	if (topBd?.top) {
		const v = borderToCSS(topBd.top as IExcelBorderSide);
		if (v) {
			borders.borderTop = v;
		}
	}
	if (topBd?.left) {
		const v = borderToCSS(topBd.left as IExcelBorderSide);
		if (v) {
			borders.borderLeft = v;
		}
	}
	const bottomRow = r + rowspan - 1;
	for (let cc = c; cc < c + colspan; cc++) {
		const bd = getBorder(bottomRow, cc);
		if (bd?.bottom) {
			const v = borderToCSS(bd.bottom as IExcelBorderSide);
			if (v) {
				borders.borderBottom = v;
				break;
			}
		}
	}
	const rightCol = c + colspan - 1;
	for (let rr = r; rr < r + rowspan; rr++) {
		const bd = getBorder(rr, rightCol);
		if (bd?.right) {
			const v = borderToCSS(bd.right as IExcelBorderSide);
			if (v) {
				borders.borderRight = v;
				break;
			}
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

export class ParadisSpreadsheetService implements IParadisSpreadsheetService {

	async parseWorkbook(base64Content: string): Promise<IParadisWorkbookData> {
		const workbook = new ExcelJS.Workbook();
		const buffer = Buffer.from(base64Content, 'base64');
		// exceljs の Buffer 型定義が現行 @types/node の Buffer と食い違うため、load の期待型そのものへ interop キャストする。
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

		const sheets: IParadisSheetData[] = [];

		workbook.eachSheet(worksheet => {
			const dims = getSheetDimensions(worksheet);
			const mergeMap = buildMergeMap(worksheet);
			const colCount = dims.maxC - dims.minC + 1;
			const columnWidths: number[] = [];
			for (let c = dims.minC; c <= dims.maxC; c++) {
				const col = worksheet.getColumn(c);
				columnWidths.push(col.hidden ? 0 : charWidthToPx(col.width));
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
					let style: Record<string, string> = getCellStyle(cell) as Record<string, string>;
					const mergeInfo = mergeEntry && mergeEntry.kind === 'origin' ? mergeEntry : null;
					const colspan = mergeInfo?.colspan ?? 1;
					const rowspan = mergeInfo?.rowspan ?? 1;

					if (mergeInfo) {
						const { borderTop, borderBottom, borderLeft, borderRight, ...rest } = style;
						style = { ...rest, ...getMergedCellBorders(worksheet, r, c, rowspan, colspan) };
					}

					const runs = getRichTextRuns(cell);
					const richText: IParadisRichTextPart[] | undefined = runs
						? runs.map(rt => ({ text: rt.text || '', style: richTextFontStyle(rt.font) }))
						: undefined;

					const al = cell.alignment;
					const wrapText = al?.wrapText === true || (typeof val === 'string' && val.includes('\n'));
					const verticalText = al?.textRotation === 'vertical' || al?.textRotation === 255;

					const parsed: IParadisCellData = {
						value: val,
						style,
						...(mergeInfo ? { colSpan: colspan, rowSpan: rowspan } : {}),
						...(wrapText ? { wrapText: true } : {}),
						...(verticalText ? { verticalText: true } : {}),
						...(richText ? { richText } : {}),
					};
					cells.push(parsed);
				}

				rows.push({ excelRow: r, cells, height: rowHeightToPx(row.height) });
			}

			sheets.push({
				name: worksheet.name,
				rows,
				columnCount: colCount,
				columnWidths,
				truncated,
				minCol: dims.minC,
			});
		});

		return { sheets };
	}
}

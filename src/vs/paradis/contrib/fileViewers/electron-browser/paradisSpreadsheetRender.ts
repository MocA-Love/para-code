/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分で共有する DOM 描画ヘルパー(Vanilla DOM。Superset の SpreadsheetViewer.tsx 相当)。

import * as dom from '../../../../base/browser/dom.js';
import { IParadisCellData, IParadisCellRange, IParadisCellStyle, IParadisDiagonalBorder, IParadisRenderAnchor, IParadisRenderShape } from '../common/paradisSpreadsheet.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const PARADIS_ROW_NUM_COL_WIDTH = 36;

/** EMU(1px = 9525 EMU @96DPI)→ px。 */
function emuToPx(emu: number): number {
	return emu / 9525;
}

// Excel の破線種別 → SVG stroke-dasharray。
const SVG_DASH_PATTERNS: Record<string, string> = {
	solid: '', sysDot: '2,2', sysDash: '6,2', dash: '8,4',
	dashDot: '8,4,2,4', lgDash: '12,4', lgDashDot: '12,4,2,4', lgDashDotDot: '12,4,2,4,2,4',
};

/** 0始まりの列インデックスを Excel の列ラベル(A, B, ..., Z, AA, ...)へ変換する。 */
export function getColumnLabel(index: number): string {
	let label = '';
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}

/** プレーンなスタイルオブジェクト(camelCase CSS プロパティ→値)を要素へ適用する。 */
export function applyStyleObject(el: HTMLElement, style: IParadisCellStyle): void {
	const target = el.style as unknown as Record<string, string>;
	for (const key in style) {
		if (Object.prototype.hasOwnProperty.call(style, key)) {
			target[key] = style[key];
		}
	}
}

/** セルの中身(リッチテキストなら複数span、それ以外はテキスト)を td に流し込む。 */
export function setCellContent(td: HTMLElement, cell: IParadisCellData): void {
	if (cell.richText && cell.richText.length > 0) {
		for (const part of cell.richText) {
			const span = dom.append(td, $('span'));
			span.textContent = part.text;
			applyStyleObject(span, part.style);
		}
		return;
	}
	td.textContent = cell.value;
}

/** ビューア/差分の各データセルに共通の基本スタイルを適用し、セル固有スタイルを重ねる。 */
export function applyBaseCellStyle(td: HTMLElement, cell: IParadisCellData): void {
	const s = td.style;
	s.overflow = 'hidden';
	s.padding = '1px 3px';
	s.whiteSpace = 'nowrap';
	s.lineHeight = 'normal';
	s.boxSizing = 'border-box';
	// 既定の文字色を黒でインライン指定する。これをしないと、フォント色未指定のセルが
	// ワークベンチ(ダークテーマ)の foreground を継承して白背景上で薄いグレーに見えてしまう。
	// セルにフォント色がある場合は cell.style.color が下で上書きする。
	s.color = '#000000';
	applyStyleObject(td, cell.style);
	if (cell.wrapText) {
		s.whiteSpace = 'pre-wrap';
		s.wordBreak = 'break-all';
		s.overflow = 'visible';
	}
	if (cell.verticalText) {
		s.writingMode = 'vertical-rl';
		s.textOrientation = 'upright';
		s.letterSpacing = '0';
		s.lineHeight = '1';
		s.textAlign = 'center';
		s.verticalAlign = 'middle';
		s.whiteSpace = 'normal';
		s.wordBreak = 'keep-all';
		s.overflow = 'hidden';
		s.padding = '2px 0';
	}
}

/** セルの対角罫線(border.diagonal)を SVG オーバーレイで td 内に描く。 */
export function appendDiagonalOverlay(td: HTMLElement, diagonal: IParadisDiagonalBorder): void {
	td.style.position = 'relative';
	const doc = td.ownerDocument;
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'paradis-spreadsheet-diagonal');
	svg.setAttribute('preserveAspectRatio', 'none');
	const widthMatch = diagonal.style.match(/^(\d+)px/);
	const strokeWidth = widthMatch ? widthMatch[1] : '1';
	const addLine = (x1: string, y1: string, x2: string, y2: string) => {
		const line = doc.createElementNS(SVG_NS, 'line');
		line.setAttribute('x1', x1);
		line.setAttribute('y1', y1);
		line.setAttribute('x2', x2);
		line.setAttribute('y2', y2);
		line.setAttribute('stroke', diagonal.color);
		line.setAttribute('stroke-width', strokeWidth);
		line.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.appendChild(line);
	};
	if (diagonal.down) {
		addLine('0', '0', '100%', '100%');
	}
	if (diagonal.up) {
		addLine('0', '100%', '100%', '0');
	}
	td.appendChild(svg);
}

/** Excel の行番号(1始まり)→ 表示Y座標(px)のマップと列幅から、図形(直線/矩形)の SVG オーバーレイを生成する。 */
export function buildShapeOverlay(
	shapes: readonly IParadisRenderShape[],
	rowYByExcelRow: Map<number, number>,
	columnWidths: readonly number[],
	minCol: number,
	doc: Document,
): SVGElement | undefined {
	if (shapes.length === 0) {
		return undefined;
	}
	const cumCol: number[] = [0];
	for (let i = 0; i < columnWidths.length; i++) {
		cumCol.push(cumCol[i] + columnWidths[i]);
	}
	const anchorPos = (a: IParadisRenderAnchor): { x: number; y: number } => {
		const colIdx = Math.max(0, Math.min(a.c - (minCol - 1), cumCol.length - 1));
		const x = PARADIS_ROW_NUM_COL_WIDTH + cumCol[colIdx] + emuToPx(a.co);
		const y = (rowYByExcelRow.get(a.r + 1) ?? 0) + emuToPx(a.ro);
		return { x, y };
	};

	const svg = doc.createElementNS(SVG_NS, 'svg') as SVGElement;
	svg.setAttribute('class', 'paradis-spreadsheet-shapes');
	for (const shape of shapes) {
		const tl = anchorPos(shape.from);
		const br = anchorPos(shape.to);
		const dash = SVG_DASH_PATTERNS[shape.dash] || '';
		if (shape.type === 'image' && shape.href) {
			const w = shape.ext ? emuToPx(shape.ext.cx) : Math.max(0, br.x - tl.x);
			const h = shape.ext ? emuToPx(shape.ext.cy) : Math.max(0, br.y - tl.y);
			const img = doc.createElementNS(SVG_NS, 'image');
			img.setAttribute('x', String(tl.x));
			img.setAttribute('y', String(tl.y));
			img.setAttribute('width', String(w));
			img.setAttribute('height', String(h));
			img.setAttribute('preserveAspectRatio', 'none');
			img.setAttribute('href', shape.href);
			svg.appendChild(img);
		} else if (shape.type === 'line') {
			const flipped = shape.flipV !== shape.flipH;
			const line = doc.createElementNS(SVG_NS, 'line');
			line.setAttribute('x1', String(tl.x));
			line.setAttribute('y1', String(flipped ? br.y : tl.y));
			line.setAttribute('x2', String(br.x));
			line.setAttribute('y2', String(flipped ? tl.y : br.y));
			line.setAttribute('stroke', shape.outlineColor);
			line.setAttribute('stroke-width', String(shape.outlineWidth));
			if (dash) {
				line.setAttribute('stroke-dasharray', dash);
			}
			svg.appendChild(line);
		} else {
			const rect = doc.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', String(tl.x));
			rect.setAttribute('y', String(tl.y));
			rect.setAttribute('width', String(Math.max(0, br.x - tl.x)));
			rect.setAttribute('height', String(Math.max(0, br.y - tl.y)));
			rect.setAttribute('fill', 'none');
			rect.setAttribute('stroke', shape.outlineColor);
			rect.setAttribute('stroke-width', String(shape.outlineWidth));
			if (dash) {
				rect.setAttribute('stroke-dasharray', dash);
			}
			svg.appendChild(rect);
		}
	}
	return svg;
}

/** shrinkToFit セル: 内容を span に包んで返す(後で applyShrinkToFit で横方向に縮小する)。 */
export function createShrinkSpan(td: HTMLElement, cell: IParadisCellData): HTMLElement {
	const span = td.ownerDocument.createElement('span');
	span.className = 'paradis-spreadsheet-shrink';
	if (cell.richText && cell.richText.length > 0) {
		for (const part of cell.richText) {
			const inner = span.ownerDocument.createElement('span');
			inner.textContent = part.text;
			applyStyleObject(inner, part.style);
			span.appendChild(inner);
		}
	} else {
		span.textContent = cell.value;
	}
	td.appendChild(span);
	return span;
}

/** shrinkToFit の span 群を、はみ出す分だけ横方向に縮小する。レイアウトスラッシング回避のため read→write の2パス。 */
export function applyShrinkToFit(items: readonly { readonly td: HTMLElement; readonly span: HTMLElement }[]): void {
	// pass 1: 計測(read)のみ
	const measures = items.map(({ td, span }) => ({
		span,
		align: td.style.textAlign || 'left',
		avail: td.clientWidth - 6,
		need: span.scrollWidth,
	}));
	// pass 2: 反映(write)のみ
	for (const m of measures) {
		if (m.need > m.avail && m.avail > 0 && m.need > 0) {
			const scale = m.avail / m.need;
			m.span.style.display = 'inline-block';
			m.span.style.transformOrigin = m.align === 'right' ? 'right center' : m.align === 'center' ? 'center center' : 'left center';
			m.span.style.transform = `scaleX(${scale})`;
		}
	}
}

/** 手動改ページ(青実線)+ 印刷範囲の外周(太い青線)の SVG オーバーレイを生成する。 */
export function buildPageBreakOverlay(
	rowBreaks: readonly number[] | undefined,
	colBreaks: readonly number[] | undefined,
	printArea: IParadisCellRange | undefined,
	rowYByExcelRow: Map<number, number>,
	columnWidths: readonly number[],
	minCol: number,
	doc: Document,
): SVGElement | undefined {
	const hasBreaks = (rowBreaks && rowBreaks.length) || (colBreaks && colBreaks.length) || printArea;
	if (!hasBreaks) {
		return undefined;
	}
	const cumCol: number[] = [0];
	for (let i = 0; i < columnWidths.length; i++) {
		cumCol.push(cumCol[i] + columnWidths[i]);
	}
	// Excelの1始まり列 -> その列の左端X。範囲外は端にクランプ。
	const colLeftX = (excelCol: number): number => {
		const idx = Math.max(0, Math.min(excelCol - minCol, cumCol.length - 1));
		return PARADIS_ROW_NUM_COL_WIDTH + cumCol[idx];
	};
	const rightEdgeX = PARADIS_ROW_NUM_COL_WIDTH + cumCol[cumCol.length - 1];
	// Excelの1始まり行 -> その行の上端Y。
	const rowTopY = (excelRow: number): number => rowYByExcelRow.get(excelRow) ?? 0;
	const bottomEdgeY = Math.max(...Array.from(rowYByExcelRow.values()), 0);

	const svg = doc.createElementNS(SVG_NS, 'svg') as SVGElement;
	svg.setAttribute('class', 'paradis-spreadsheet-pagebreaks');

	const addLine = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
		const line = doc.createElementNS(SVG_NS, 'line');
		line.setAttribute('x1', String(x1));
		line.setAttribute('y1', String(y1));
		line.setAttribute('x2', String(x2));
		line.setAttribute('y2', String(y2));
		line.setAttribute('class', cls);
		svg.appendChild(line);
	};

	// 手動改ページ(行): id 行の下端 = 次の行の上端 に横線。
	for (const id of rowBreaks ?? []) {
		const y = rowTopY(id + 1);
		if (y > 0) {
			addLine(PARADIS_ROW_NUM_COL_WIDTH, y, rightEdgeX, y, 'paradis-pagebreak-line');
		}
	}
	// 手動改ページ(列): id 列の右端 = 次の列の左端 に縦線。
	for (const id of colBreaks ?? []) {
		const x = colLeftX(id + 1);
		addLine(x, 0, x, bottomEdgeY, 'paradis-pagebreak-line');
	}

	// 印刷範囲の外周(太い青実線)。
	if (printArea) {
		const x1 = colLeftX(printArea.minC);
		const x2 = colLeftX(printArea.maxC + 1);
		const y1 = rowTopY(printArea.minR);
		const y2 = rowTopY(printArea.maxR + 1) || bottomEdgeY;
		const rect = doc.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('x', String(x1));
		rect.setAttribute('y', String(y1));
		rect.setAttribute('width', String(Math.max(0, x2 - x1)));
		rect.setAttribute('height', String(Math.max(0, y2 - y1)));
		rect.setAttribute('class', 'paradis-printarea-border');
		svg.appendChild(rect);
	}

	return svg;
}

/** 図形diffのステータス→SVG描画スタイル。 */
function shapeDiffStroke(status: string, side: 'original' | 'modified', shape: IParadisRenderShape): { stroke: string; dash: string; width: number; opacity: number } {
	switch (status) {
		case 'added':
			return { stroke: '#22c55e', dash: '', width: Math.max(2, shape.outlineWidth), opacity: 1 };
		case 'removed':
			return { stroke: '#ef4444', dash: '6,3', width: Math.max(1.5, shape.outlineWidth), opacity: 0.9 };
		case 'moved':
			return side === 'original'
				? { stroke: '#9ca3af', dash: '4,3', width: Math.max(1, shape.outlineWidth), opacity: 0.5 }
				: { stroke: '#3b82f6', dash: '', width: Math.max(2, shape.outlineWidth), opacity: 1 };
		case 'changed':
			return { stroke: '#3b82f6', dash: '', width: Math.max(2, shape.outlineWidth), opacity: 1 };
		default:
			return { stroke: shape.outlineColor, dash: SVG_DASH_PATTERNS[shape.dash] || '', width: shape.outlineWidth, opacity: 1 };
	}
}

/** 図形diff: 各図形を差分ステータス色で描画する SVG オーバーレイ。 */
export function buildShapeDiffOverlay(
	renders: readonly { readonly shape: IParadisRenderShape; readonly status: string }[],
	side: 'original' | 'modified',
	rowYByExcelRow: Map<number, number>,
	columnWidths: readonly number[],
	minCol: number,
	doc: Document,
): SVGElement | undefined {
	if (renders.length === 0) {
		return undefined;
	}
	const cumCol: number[] = [0];
	for (let i = 0; i < columnWidths.length; i++) {
		cumCol.push(cumCol[i] + columnWidths[i]);
	}
	const anchorPos = (a: IParadisRenderAnchor): { x: number; y: number } => {
		const colIdx = Math.max(0, Math.min(a.c - (minCol - 1), cumCol.length - 1));
		return { x: PARADIS_ROW_NUM_COL_WIDTH + cumCol[colIdx] + emuToPx(a.co), y: (rowYByExcelRow.get(a.r + 1) ?? 0) + emuToPx(a.ro) };
	};

	const svg = doc.createElementNS(SVG_NS, 'svg') as SVGElement;
	svg.setAttribute('class', 'paradis-spreadsheet-shapes');
	for (const { shape, status } of renders) {
		const tl = anchorPos(shape.from);
		const br = anchorPos(shape.to);
		const st = shapeDiffStroke(status, side, shape);

		if (shape.type === 'image' && shape.href) {
			const w = shape.ext ? emuToPx(shape.ext.cx) : Math.max(0, br.x - tl.x);
			const h = shape.ext ? emuToPx(shape.ext.cy) : Math.max(0, br.y - tl.y);
			const img = doc.createElementNS(SVG_NS, 'image');
			img.setAttribute('x', String(tl.x));
			img.setAttribute('y', String(tl.y));
			img.setAttribute('width', String(w));
			img.setAttribute('height', String(h));
			img.setAttribute('preserveAspectRatio', 'none');
			img.setAttribute('href', shape.href);
			img.setAttribute('opacity', String(st.opacity));
			svg.appendChild(img);
			if (status !== 'unchanged') {
				const rect = doc.createElementNS(SVG_NS, 'rect');
				rect.setAttribute('x', String(tl.x));
				rect.setAttribute('y', String(tl.y));
				rect.setAttribute('width', String(w));
				rect.setAttribute('height', String(h));
				rect.setAttribute('fill', 'none');
				rect.setAttribute('stroke', st.stroke);
				rect.setAttribute('stroke-width', String(st.width));
				if (st.dash) {
					rect.setAttribute('stroke-dasharray', st.dash);
				}
				svg.appendChild(rect);
			}
			continue;
		}

		if (shape.type === 'line') {
			const flipped = shape.flipV !== shape.flipH;
			const line = doc.createElementNS(SVG_NS, 'line');
			line.setAttribute('x1', String(tl.x));
			line.setAttribute('y1', String(flipped ? br.y : tl.y));
			line.setAttribute('x2', String(br.x));
			line.setAttribute('y2', String(flipped ? tl.y : br.y));
			line.setAttribute('stroke', st.stroke);
			line.setAttribute('stroke-width', String(st.width));
			line.setAttribute('opacity', String(st.opacity));
			if (st.dash) {
				line.setAttribute('stroke-dasharray', st.dash);
			}
			svg.appendChild(line);
		} else {
			const rect = doc.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', String(tl.x));
			rect.setAttribute('y', String(tl.y));
			rect.setAttribute('width', String(Math.max(0, br.x - tl.x)));
			rect.setAttribute('height', String(Math.max(0, br.y - tl.y)));
			rect.setAttribute('fill', 'none');
			rect.setAttribute('stroke', st.stroke);
			rect.setAttribute('stroke-width', String(st.width));
			rect.setAttribute('opacity', String(st.opacity));
			if (st.dash) {
				rect.setAttribute('stroke-dasharray', st.dash);
			}
			svg.appendChild(rect);
		}
	}
	return svg;
}

/** 図形のバウンディングボックス(px)を、測定済み行Yと列幅から計算する(現在位置ハイライト用)。 */
export function computeShapeBBox(shape: IParadisRenderShape, rowYByExcelRow: Map<number, number>, columnWidths: readonly number[], minCol: number): { x: number; y: number; w: number; h: number } {
	const cumCol: number[] = [0];
	for (let i = 0; i < columnWidths.length; i++) {
		cumCol.push(cumCol[i] + columnWidths[i]);
	}
	const anchorPos = (a: IParadisRenderAnchor): { x: number; y: number } => {
		const colIdx = Math.max(0, Math.min(a.c - (minCol - 1), cumCol.length - 1));
		return { x: PARADIS_ROW_NUM_COL_WIDTH + cumCol[colIdx] + emuToPx(a.co), y: (rowYByExcelRow.get(a.r + 1) ?? 0) + emuToPx(a.ro) };
	};
	const tl = anchorPos(shape.from);
	if (shape.ext) {
		return { x: tl.x, y: tl.y, w: emuToPx(shape.ext.cx), h: emuToPx(shape.ext.cy) };
	}
	const br = anchorPos(shape.to);
	const x = Math.min(tl.x, br.x);
	const y = Math.min(tl.y, br.y);
	return { x, y, w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) };
}

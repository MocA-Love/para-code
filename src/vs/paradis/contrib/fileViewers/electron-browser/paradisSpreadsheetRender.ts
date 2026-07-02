/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分で共有する DOM 描画ヘルパー(Vanilla DOM。Superset の SpreadsheetViewer.tsx 相当)。

import * as dom from '../../../../base/browser/dom.js';
import { IParadisCellData, IParadisCellStyle, IParadisDiagonalBorder, IParadisRenderAnchor, IParadisRenderShape } from '../common/paradisSpreadsheet.js';

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
		if (shape.type === 'line') {
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

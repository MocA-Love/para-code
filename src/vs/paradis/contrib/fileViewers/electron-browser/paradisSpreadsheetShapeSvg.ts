/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の図形 1 つを SVG に描く。ビューアの図形の重ね合わせ（buildShapeOverlay）と、差分の重ね合わせ
// （buildShapeDiffOverlay）が同じ描き方を使う。形は DrawingML の既定の形の定義（ECMA-376 Part 1 §20.1.10.56、
// presetShapeDefinitions.xml）に沿って、枠の中の座標で組み立てる。

import type { IParadisRenderShape, IParadisShapeText } from '../common/paradisSpreadsheet.js';
import { appendChartSvg } from './paradisSpreadsheetChartSvg.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** 図形を置く枠（px）。 */
export interface ParadisShapeBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** 線の描き方。差分では状態の色に差し替える。 */
export interface ParadisShapePaint {
	readonly stroke: string;
	readonly strokeWidth: number;
	readonly dash: string;
	readonly opacity: number;
	/** 塗りと文字を描くか（差分の削除側などで薄くするときも、形は描く）。 */
	readonly content: boolean;
}

/** アンカーの枠に、グループの中の位置（割合）を当てる。 */
export function applyShapeFrame(shape: IParadisRenderShape, anchorBox: ParadisShapeBox): ParadisShapeBox {
	const frame = shape.frame;
	if (!frame) {
		return anchorBox;
	}
	return {
		x: anchorBox.x + frame.x * anchorBox.width,
		y: anchorBox.y + frame.y * anchorBox.height,
		width: frame.width * anchorBox.width,
		height: frame.height * anchorBox.height,
	};
}

function adjustValue(shape: IParadisRenderShape, index: number, fallback: number): number {
	const value = shape.adjust?.[index];
	return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** 既定の形の道筋（SVG の d）。矩形と楕円も道筋にすると、回転や反転を同じ式で掛けられる。 */
export function shapeGeometryPath(shape: IParadisRenderShape, box: ParadisShapeBox): { readonly fill?: string; readonly stroke: string } {
	const { x, y, width: w, height: h } = box;
	const ss = Math.min(w, h);
	const n = round;
	switch (shape.geometry) {
		case 'ellipse': {
			const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
			const d = `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`;
			return { fill: d, stroke: d };
		}
		case 'roundRect': {
			const r = Math.min(ss * Math.max(0, Math.min(50000, adjustValue(shape, 0, 16667))) / 100000, w / 2, h / 2);
			const d = `M ${n(x + r)} ${n(y)} L ${n(x + w - r)} ${n(y)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)} L ${n(x + w)} ${n(y + h - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)} L ${n(x + r)} ${n(y + h)} A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)} L ${n(x)} ${n(y + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)} Z`;
			return { fill: d, stroke: d };
		}
		case 'triangle': {
			const apex = x + w * Math.max(0, Math.min(100000, adjustValue(shape, 0, 50000))) / 100000;
			const d = `M ${n(apex)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`;
			return { fill: d, stroke: d };
		}
		case 'rtTriangle': {
			const d = `M ${n(x)} ${n(y)} L ${n(x)} ${n(y + h)} L ${n(x + w)} ${n(y + h)} Z`;
			return { fill: d, stroke: d };
		}
		case 'diamond': {
			const d = `M ${n(x + w / 2)} ${n(y)} L ${n(x + w)} ${n(y + h / 2)} L ${n(x + w / 2)} ${n(y + h)} L ${n(x)} ${n(y + h / 2)} Z`;
			return { fill: d, stroke: d };
		}
		case 'leftBracket':
		case 'rightBracket': {
			// 角の丸みの縦の半径 y1 = ss * adj / 100000（adj は 0〜50000×h/ss）、横の半径は幅いっぱい。
			const r = Math.min(h / 2, ss * Math.max(0, adjustValue(shape, 0, 8333)) / 100000);
			const stroke = shape.geometry === 'leftBracket'
				? `M ${n(x + w)} ${n(y + h)} A ${n(w)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)} L ${n(x)} ${n(y + r)} A ${n(w)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y)}`
				: `M ${n(x)} ${n(y)} A ${n(w)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)} L ${n(x + w)} ${n(y + h - r)} A ${n(w)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h)}`;
			return { fill: `${stroke} Z`, stroke };
		}
		case 'leftBrace':
		case 'rightBrace': {
			// 丸み r1 = ss * adj1 / 100000、先端の高さ = h * adj2 / 100000。
			const r = Math.min(h / 4, ss * Math.max(0, adjustValue(shape, 0, 8333)) / 100000);
			const tip = y + h * Math.max(0, Math.min(100000, adjustValue(shape, 1, 50000))) / 100000;
			const half = w / 2;
			const stroke = shape.geometry === 'leftBrace'
				? `M ${n(x + w)} ${n(y)} A ${n(half)} ${n(r)} 0 0 0 ${n(x + half)} ${n(y + r)} L ${n(x + half)} ${n(tip - r)} A ${n(half)} ${n(r)} 0 0 1 ${n(x)} ${n(tip)} A ${n(half)} ${n(r)} 0 0 1 ${n(x + half)} ${n(tip + r)} L ${n(x + half)} ${n(y + h - r)} A ${n(half)} ${n(r)} 0 0 0 ${n(x + w)} ${n(y + h)}`
				: `M ${n(x)} ${n(y)} A ${n(half)} ${n(r)} 0 0 1 ${n(x + half)} ${n(y + r)} L ${n(x + half)} ${n(tip - r)} A ${n(half)} ${n(r)} 0 0 0 ${n(x + w)} ${n(tip)} A ${n(half)} ${n(r)} 0 0 0 ${n(x + half)} ${n(tip + r)} L ${n(x + half)} ${n(y + h - r)} A ${n(half)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h)}`;
			return { fill: `${stroke} Z`, stroke };
		}
		case 'path': {
			const toD = (paths: NonNullable<IParadisRenderShape['paths']>) => paths.map(path => path.d.map(([command, ...values]) => {
				const coordinates: string[] = [];
				for (let index = 0; index + 1 < values.length; index += 2) {
					coordinates.push(`${n(x + values[index] * w)} ${n(y + values[index + 1] * h)}`);
				}
				return `${command}${coordinates.length ? ' ' + coordinates.join(' ') : ''}`;
			}).join(' ')).join(' ');
			const paths = shape.paths ?? [];
			const fill = toD(paths.filter(path => path.fill));
			return { ...(fill ? { fill } : {}), stroke: toD(paths.filter(path => path.stroke)) };
		}
		default: {
			const d = `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`;
			return { fill: d, stroke: d };
		}
	}
}

/** 回転と反転（枠の中心まわり）。文字には反転を掛けない。 */
function transformAttribute(shape: IParadisRenderShape, box: ParadisShapeBox, flips: boolean): string {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const parts: string[] = [];
	if (shape.rotation) {
		parts.push(`rotate(${round(shape.rotation)} ${round(cx)} ${round(cy)})`);
	}
	if (flips && (shape.flipH || shape.flipV)) {
		parts.push(`translate(${round(cx)} ${round(cy)}) scale(${shape.flipH ? -1 : 1} ${shape.flipV ? -1 : 1}) translate(${round(-cx)} ${round(-cy)})`);
	}
	return parts.join(' ');
}

function setStroke(el: Element, paint: ParadisShapePaint): void {
	if (paint.strokeWidth > 0) {
		el.setAttribute('stroke', paint.stroke);
		el.setAttribute('stroke-width', String(paint.strokeWidth));
		if (paint.dash) {
			el.setAttribute('stroke-dasharray', paint.dash);
		}
	} else {
		el.setAttribute('stroke', 'none');
	}
}

/** 線の端の矢印（headEnd・tailEnd）。`at` が先端、`from` が線の向きの元。 */
function appendLineEnd(parent: Element, type: string, at: { x: number; y: number }, from: { x: number; y: number }, paint: ParadisShapePaint): void {
	const length = Math.hypot(at.x - from.x, at.y - from.y);
	if (length === 0 || paint.strokeWidth <= 0) {
		return;
	}
	const size = Math.max(6, paint.strokeWidth * 3);
	const ux = (at.x - from.x) / length;
	const uy = (at.y - from.y) / length;
	const doc = parent.ownerDocument;
	if (type === 'oval') {
		const circle = doc.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('cx', round(at.x));
		circle.setAttribute('cy', round(at.y));
		circle.setAttribute('r', round(size / 2));
		circle.setAttribute('fill', paint.stroke);
		parent.appendChild(circle);
		return;
	}
	const baseX = at.x - ux * size;
	const baseY = at.y - uy * size;
	const px = -uy * size / 2;
	const py = ux * size / 2;
	const points = type === 'diamond'
		? [[at.x, at.y], [baseX + ux * size / 2 + px, baseY + uy * size / 2 + py], [baseX, baseY], [baseX + ux * size / 2 - px, baseY + uy * size / 2 - py]]
		: [[at.x, at.y], [baseX + px, baseY + py], [baseX - px, baseY - py]];
	const polygon = doc.createElementNS(SVG_NS, 'polygon');
	polygon.setAttribute('points', points.map(([px1, py1]) => `${round(px1)},${round(py1)}`).join(' '));
	if (type === 'arrow') {
		polygon.setAttribute('fill', 'none');
		polygon.setAttribute('stroke', paint.stroke);
		polygon.setAttribute('stroke-width', String(paint.strokeWidth));
	} else {
		polygon.setAttribute('fill', paint.stroke);
	}
	parent.appendChild(polygon);
}

function appendText(parent: Element, text: IParadisShapeText, box: ParadisShapeBox): void {
	const doc = parent.ownerDocument;
	const foreign = doc.createElementNS(SVG_NS, 'foreignObject');
	foreign.setAttribute('x', round(box.x));
	foreign.setAttribute('y', round(box.y));
	foreign.setAttribute('width', round(Math.max(0, box.width)));
	foreign.setAttribute('height', round(Math.max(0, box.height)));
	const body = doc.createElementNS(XHTML_NS, 'div') as HTMLElement;
	const style = body.style;
	style.boxSizing = 'border-box';
	style.width = '100%';
	style.height = '100%';
	style.display = 'flex';
	style.flexDirection = 'column';
	style.justifyContent = text.anchor === 'middle' ? 'center' : text.anchor === 'bottom' ? 'flex-end' : 'flex-start';
	style.padding = `${round(text.insets.top)}px ${round(text.insets.right)}px ${round(text.insets.bottom)}px ${round(text.insets.left)}px`;
	style.overflow = 'hidden';
	style.color = '#000000';
	style.fontSize = `${round(11 * 96 / 72)}px`;
	style.lineHeight = '1.2';
	style.whiteSpace = text.wrap ? 'pre-wrap' : 'pre';
	style.overflowWrap = 'anywhere';
	if (text.vertical) {
		style.writingMode = 'vertical-rl';
	}
	for (const paragraph of text.paragraphs) {
		const line = doc.createElementNS(XHTML_NS, 'div') as HTMLElement;
		line.style.textAlign = paragraph.align ?? 'left';
		line.style.minHeight = '1.2em';
		for (const run of paragraph.runs) {
			const span = doc.createElementNS(XHTML_NS, 'span') as HTMLElement;
			span.textContent = run.text;
			if (run.size) {
				span.style.fontSize = `${round(run.size * 96 / 72)}px`;
			}
			if (run.bold) {
				span.style.fontWeight = 'bold';
			}
			if (run.italic) {
				span.style.fontStyle = 'italic';
			}
			if (run.underline) {
				span.style.textDecoration = 'underline';
			}
			if (run.color) {
				span.style.color = run.color;
			}
			if (run.font) {
				span.style.fontFamily = `"${run.font.replace(/["\\]/g, '')}", sans-serif`;
			}
			line.appendChild(span);
		}
		body.appendChild(line);
	}
	foreign.appendChild(body);
	parent.appendChild(foreign);
}

/** 外側のグループの回転・反転（外側から順に左へ並べる。SVG では左のものが最後に掛かる）。 */
function groupTransformAttribute(shape: IParadisRenderShape, anchorBox: ParadisShapeBox | undefined): string {
	if (!shape.groupTransforms?.length || !anchorBox) {
		return '';
	}
	return shape.groupTransforms.map(transform => {
		const box = {
			x: anchorBox.x + transform.frame.x * anchorBox.width,
			y: anchorBox.y + transform.frame.y * anchorBox.height,
			width: transform.frame.width * anchorBox.width,
			height: transform.frame.height * anchorBox.height,
		};
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const parts: string[] = [];
		if (transform.rotation) {
			parts.push(`rotate(${round(transform.rotation)} ${round(cx)} ${round(cy)})`);
		}
		if (transform.flipH || transform.flipV) {
			parts.push(`translate(${round(cx)} ${round(cy)}) scale(${transform.flipH ? -1 : 1} ${transform.flipV ? -1 : 1}) translate(${round(-cx)} ${round(-cy)})`);
		}
		return parts.join(' ');
	}).filter(Boolean).join(' ');
}

/**
 * 図形 1 つを `parent`（svg か g）へ足し、足した要素を返す。`box` は図形の枠、`anchorBox` はアンカーの枠
 * （グループの回転・反転の中心を求めるのに使う）。
 */
export function appendShapeSvg(parent: Element, shape: IParadisRenderShape, box: ParadisShapeBox, paint: ParadisShapePaint, anchorBox?: ParadisShapeBox): Element {
	const doc = parent.ownerDocument;
	const group = doc.createElementNS(SVG_NS, 'g');
	if (paint.opacity !== 1) {
		group.setAttribute('opacity', String(paint.opacity));
	}
	const outer = groupTransformAttribute(shape, anchorBox);
	if (outer) {
		group.setAttribute('transform', outer);
	}
	parent.appendChild(group);
	if (shape.type === 'line') {
		// 枠の対角線。片方だけ反転していれば右上から左下へ。
		const flipped = shape.flipV !== shape.flipH;
		const start = { x: box.x, y: flipped ? box.y + box.height : box.y };
		const end = { x: box.x + box.width, y: flipped ? box.y : box.y + box.height };
		const lineGroup = doc.createElementNS(SVG_NS, 'g');
		const rotation = transformAttribute(shape, box, false);
		if (rotation) {
			lineGroup.setAttribute('transform', rotation);
		}
		const line = doc.createElementNS(SVG_NS, 'line');
		line.setAttribute('x1', round(start.x));
		line.setAttribute('y1', round(start.y));
		line.setAttribute('x2', round(end.x));
		line.setAttribute('y2', round(end.y));
		setStroke(line, paint);
		lineGroup.appendChild(line);
		if (shape.headEnd) {
			appendLineEnd(lineGroup, shape.headEnd, start, end, paint);
		}
		if (shape.tailEnd) {
			appendLineEnd(lineGroup, shape.tailEnd, end, start, paint);
		}
		group.appendChild(lineGroup);
		return group;
	}
	if (shape.type === 'image' && shape.href) {
		const img = doc.createElementNS(SVG_NS, 'image');
		img.setAttribute('x', round(box.x));
		img.setAttribute('y', round(box.y));
		img.setAttribute('width', round(Math.max(0, box.width)));
		img.setAttribute('height', round(Math.max(0, box.height)));
		img.setAttribute('preserveAspectRatio', 'none');
		img.setAttribute('href', shape.href);
		const transform = transformAttribute(shape, box, true);
		if (transform) {
			img.setAttribute('transform', transform);
		}
		group.appendChild(img);
		return group;
	}
	if (shape.type === 'chart' && shape.chart) {
		appendChartSvg(group, shape.chart, box, paint.content);
		return group;
	}
	const geometry = shapeGeometryPath(shape, box);
	const shapeGroup = doc.createElementNS(SVG_NS, 'g');
	const transform = transformAttribute(shape, box, true);
	if (transform) {
		shapeGroup.setAttribute('transform', transform);
	}
	if (paint.content && shape.fill && geometry.fill) {
		const fill = doc.createElementNS(SVG_NS, 'path');
		fill.setAttribute('d', geometry.fill);
		fill.setAttribute('fill', shape.fill);
		if (shape.fillOpacity !== undefined) {
			fill.setAttribute('fill-opacity', String(shape.fillOpacity));
		}
		fill.setAttribute('stroke', 'none');
		shapeGroup.appendChild(fill);
	}
	const outline = doc.createElementNS(SVG_NS, 'path');
	outline.setAttribute('d', geometry.stroke);
	outline.setAttribute('fill', 'none');
	setStroke(outline, paint);
	shapeGroup.appendChild(outline);
	group.appendChild(shapeGroup);
	if (paint.content && shape.text) {
		const textGroup = doc.createElementNS(SVG_NS, 'g');
		// 外側のグループの反転は文字の位置だけを動かし、字形は裏返さない。奇数回の反転を、文字の枠の中心まわりの
		// 反転で打ち消す（外側の反転と合わせると、字形は表のまま位置だけが写る）。
		const flipH = (shape.groupTransforms ?? []).filter(transform => transform.flipH).length % 2 === 1;
		const flipV = (shape.groupTransforms ?? []).filter(transform => transform.flipV).length % 2 === 1;
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const counter = flipH || flipV ? `translate(${round(cx)} ${round(cy)}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1}) translate(${round(-cx)} ${round(-cy)})` : '';
		const rotation = [transformAttribute(shape, box, false), counter].filter(Boolean).join(' ');
		if (rotation) {
			textGroup.setAttribute('transform', rotation);
		}
		appendText(textGroup, shape.text, box);
		group.appendChild(textGroup);
	}
	return group;
}

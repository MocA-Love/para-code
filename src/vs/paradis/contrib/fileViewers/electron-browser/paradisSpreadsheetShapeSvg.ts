/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の図形 1 つを SVG に描く。ビューアの図形の重ね合わせ（buildShapeOverlay）と、差分の重ね合わせ
// （buildShapeDiffOverlay）が同じ描き方を使う。形は DrawingML の既定の形の定義（ECMA-376 Part 1 §20.1.10.56、
// presetShapeDefinitions.xml）に沿って、枠の中の座標で組み立てる。

import type { IParadisChartData, IParadisChartGroup, IParadisRenderShape, IParadisShapeText } from '../common/paradisSpreadsheet.js';

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
		const rotation = transformAttribute(shape, box, false);
		if (rotation) {
			textGroup.setAttribute('transform', rotation);
		}
		appendText(textGroup, shape.text, box);
		group.appendChild(textGroup);
	}
	return group;
}

// ── グラフ ──

function svgText(parent: Element, x: number, y: number, value: string, options: { readonly size?: number; readonly anchor?: 'start' | 'middle' | 'end'; readonly bold?: boolean; readonly baseline?: string } = {}): void {
	const text = parent.ownerDocument.createElementNS(SVG_NS, 'text');
	text.setAttribute('x', round(x));
	text.setAttribute('y', round(y));
	text.setAttribute('font-size', String(options.size ?? 10));
	text.setAttribute('fill', '#404040');
	text.setAttribute('text-anchor', options.anchor ?? 'start');
	if (options.baseline) {
		text.setAttribute('dominant-baseline', options.baseline);
	}
	if (options.bold) {
		text.setAttribute('font-weight', 'bold');
	}
	text.textContent = value;
	parent.appendChild(text);
}

function svgRect(parent: Element, x: number, y: number, width: number, height: number, fill: string, stroke?: string): void {
	const rect = parent.ownerDocument.createElementNS(SVG_NS, 'rect');
	rect.setAttribute('x', round(Math.min(x, x + width)));
	rect.setAttribute('y', round(Math.min(y, y + height)));
	rect.setAttribute('width', round(Math.abs(width)));
	rect.setAttribute('height', round(Math.abs(height)));
	rect.setAttribute('fill', fill);
	if (stroke) {
		rect.setAttribute('stroke', stroke);
		rect.setAttribute('stroke-width', '1');
	}
	parent.appendChild(rect);
}

function svgPath(parent: Element, d: string, stroke: string, fill: string, width = 1.5): void {
	const path = parent.ownerDocument.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('stroke', stroke);
	path.setAttribute('stroke-width', String(width));
	path.setAttribute('fill', fill);
	parent.appendChild(path);
}

/** 目盛りの間隔を 1・2・5×10^n から選ぶ。 */
function niceStep(range: number, ticks: number): number {
	if (!(range > 0)) {
		return 1;
	}
	const raw = range / ticks;
	const power = Math.pow(10, Math.floor(Math.log10(raw)));
	const fraction = raw / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

function formatTick(value: number, percent: boolean): string {
	if (percent) {
		return `${Math.round(value * 100)}%`;
	}
	const abs = Math.abs(value);
	return abs >= 1000 || abs === 0 || Number.isInteger(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(value * 100) / 100);
}

interface ValueRange {
	readonly min: number;
	readonly max: number;
}

/** 積み上げ・100% 積み上げを考えて、群ごとの各要素の値の区間を求める。 */
function stackedSegments(group: IParadisChartGroup, categoryCount: number): { readonly start: number; readonly end: number }[][] {
	const result: { start: number; end: number }[][] = group.series.map(() => []);
	for (let category = 0; category < categoryCount; category++) {
		let positive = 0;
		let negative = 0;
		const total = group.grouping === 'percentStacked' ? group.series.reduce((sum, series) => sum + Math.abs(series.values[category] ?? 0), 0) || 1 : 1;
		group.series.forEach((series, index) => {
			const raw = series.values[category] ?? 0;
			const value = group.grouping === 'percentStacked' ? raw / total : raw;
			if (group.grouping === 'stacked' || group.grouping === 'percentStacked') {
				const start = value >= 0 ? positive : negative;
				const end = start + value;
				if (value >= 0) { positive = end; } else { negative = end; }
				result[index][category] = { start, end };
			} else {
				result[index][category] = { start: 0, end: value };
			}
		});
	}
	return result;
}

/** 保存済みの値でグラフを描く（軸・目盛り・凡例は簡略）。 */
export function appendChartSvg(parent: Element, chart: IParadisChartData, box: ParadisShapeBox, content = true): void {
	const doc = parent.ownerDocument;
	const frame = doc.createElementNS(SVG_NS, 'g');
	parent.appendChild(frame);
	svgRect(frame, box.x, box.y, box.width, box.height, content ? '#FFFFFF' : 'none', '#D9D9D9');
	if (!content || box.width < 24 || box.height < 24) {
		return;
	}
	let top = box.y + 8;
	if (chart.title) {
		svgText(frame, box.x + box.width / 2, top + 12, chart.title, { size: 13, anchor: 'middle', bold: true });
		top += 22;
	}
	const pieGroup = chart.groups.find(group => group.kind === 'pie' || group.kind === 'doughnut');
	const legendItems = pieGroup
		? (pieGroup.series[0]?.categories ?? []).map((name, index) => ({ name: name || String(index + 1), color: pieGroup.series[0].pointColors?.[index] ?? '#888888' }))
		: chart.groups.flatMap(group => group.series.map((series, index) => ({ name: series.name ?? `Series${index + 1}`, color: series.color ?? '#888888' })));
	const legendWidth = chart.legend && legendItems.length > 0 ? Math.min(box.width * 0.3, 120) : 0;
	const plot = { x: box.x + 8, y: top, width: box.width - 16 - legendWidth, height: box.y + box.height - 8 - top };
	if (legendWidth > 0) {
		legendItems.slice(0, Math.max(1, Math.floor(plot.height / 14))).forEach((item, index) => {
			const ly = top + 6 + index * 14;
			svgRect(frame, plot.x + plot.width + 8, ly, 8, 8, item.color);
			svgText(frame, plot.x + plot.width + 20, ly + 8, item.name, { size: 9 });
		});
	}
	if (plot.width < 16 || plot.height < 16) {
		return;
	}
	if (pieGroup) {
		appendPie(frame, pieGroup, plot);
		return;
	}
	appendCartesian(frame, chart, plot);
}

function appendPie(parent: Element, group: IParadisChartGroup, plot: ParadisShapeBox): void {
	const series = group.series[0];
	if (!series) {
		return;
	}
	const values = series.values.map(value => Math.max(0, value ?? 0));
	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) {
		return;
	}
	const radius = Math.min(plot.width, plot.height) / 2 - 2;
	const cx = plot.x + plot.width / 2;
	const cy = plot.y + plot.height / 2;
	const inner = group.kind === 'doughnut' ? radius * 0.5 : 0;
	let angle = -Math.PI / 2;
	values.forEach((value, index) => {
		if (value <= 0) {
			return;
		}
		const sweep = value / total * Math.PI * 2;
		const end = angle + sweep;
		const large = sweep > Math.PI ? 1 : 0;
		const color = series.pointColors?.[index] ?? '#888888';
		if (sweep >= Math.PI * 2 - 1e-9) {
			svgPath(parent, `M ${round(cx - radius)} ${round(cy)} A ${round(radius)} ${round(radius)} 0 1 1 ${round(cx + radius)} ${round(cy)} A ${round(radius)} ${round(radius)} 0 1 1 ${round(cx - radius)} ${round(cy)} Z`, '#FFFFFF', color, 1);
		} else {
			const outerStart = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
			const outerEnd = [cx + radius * Math.cos(end), cy + radius * Math.sin(end)];
			const innerEnd = [cx + inner * Math.cos(end), cy + inner * Math.sin(end)];
			const innerStart = [cx + inner * Math.cos(angle), cy + inner * Math.sin(angle)];
			const d = inner > 0
				? `M ${round(outerStart[0])} ${round(outerStart[1])} A ${round(radius)} ${round(radius)} 0 ${large} 1 ${round(outerEnd[0])} ${round(outerEnd[1])} L ${round(innerEnd[0])} ${round(innerEnd[1])} A ${round(inner)} ${round(inner)} 0 ${large} 0 ${round(innerStart[0])} ${round(innerStart[1])} Z`
				: `M ${round(cx)} ${round(cy)} L ${round(outerStart[0])} ${round(outerStart[1])} A ${round(radius)} ${round(radius)} 0 ${large} 1 ${round(outerEnd[0])} ${round(outerEnd[1])} Z`;
			svgPath(parent, d, '#FFFFFF', color, 1);
		}
		angle = end;
	});
	if (inner > 0) {
		const hole = parent.ownerDocument.createElementNS(SVG_NS, 'circle');
		hole.setAttribute('cx', round(cx));
		hole.setAttribute('cy', round(cy));
		hole.setAttribute('r', round(inner));
		hole.setAttribute('fill', '#FFFFFF');
		parent.appendChild(hole);
	}
}

function appendCartesian(parent: Element, chart: IParadisChartData, plot: ParadisShapeBox): void {
	const groups = chart.groups;
	const scatter = groups.every(group => group.kind === 'scatter');
	const horizontal = groups.some(group => group.kind === 'bar');
	const categoryCount = Math.max(1, ...groups.flatMap(group => group.series.map(series => Math.max(series.values.length, series.categories.length))));
	const percent = groups.some(group => group.grouping === 'percentStacked');
	const segments = groups.map(group => stackedSegments(group, categoryCount));
	let range: ValueRange = { min: 0, max: 0 };
	for (const groupSegments of segments) {
		for (const seriesSegments of groupSegments) {
			for (const segment of seriesSegments) {
				if (segment) {
					range = { min: Math.min(range.min, segment.start, segment.end), max: Math.max(range.max, segment.start, segment.end) };
				}
			}
		}
	}
	let xRange: ValueRange = { min: 0, max: categoryCount };
	if (scatter) {
		const xs = groups.flatMap(group => group.series.flatMap(series => (series.xValues ?? []).filter((value): value is number => value !== null)));
		xRange = xs.length ? { min: Math.min(0, ...xs), max: Math.max(...xs) } : xRange;
	}
	if (range.max === range.min) {
		range = { min: range.min, max: range.min + 1 };
	}
	const step = niceStep(range.max - range.min, 5);
	const axisMin = Math.floor(range.min / step) * step;
	const axisMax = Math.ceil(range.max / step) * step;
	const labelSpace = 34;
	const area = horizontal
		? { x: plot.x + 48, y: plot.y, width: plot.width - 48, height: plot.height - 14 }
		: { x: plot.x + labelSpace, y: plot.y, width: plot.width - labelSpace, height: plot.height - 14 };
	if (area.width < 8 || area.height < 8) {
		return;
	}
	const valueToPx = (value: number) => horizontal
		? area.x + (value - axisMin) / (axisMax - axisMin) * area.width
		: area.y + area.height - (value - axisMin) / (axisMax - axisMin) * area.height;
	// 目盛りの線と値。
	for (let value = axisMin, guard = 0; value <= axisMax + step / 2 && guard < 50; value += step, guard++) {
		const position = valueToPx(value);
		svgPath(parent, horizontal ? `M ${round(position)} ${round(area.y)} L ${round(position)} ${round(area.y + area.height)}` : `M ${round(area.x)} ${round(position)} L ${round(area.x + area.width)} ${round(position)}`, '#E0E0E0', 'none', 1);
		if (horizontal) {
			svgText(parent, position, area.y + area.height + 11, formatTick(value, percent), { size: 9, anchor: 'middle' });
		} else {
			svgText(parent, area.x - 4, position + 3, formatTick(value, percent), { size: 9, anchor: 'end' });
		}
	}
	const zero = valueToPx(Math.max(axisMin, Math.min(axisMax, 0)));
	svgPath(parent, horizontal ? `M ${round(zero)} ${round(area.y)} L ${round(zero)} ${round(area.y + area.height)}` : `M ${round(area.x)} ${round(zero)} L ${round(area.x + area.width)} ${round(zero)}`, '#A0A0A0', 'none', 1);
	const slot = (horizontal ? area.height : area.width) / categoryCount;
	const categories = groups.flatMap(group => group.series).find(series => series.categories.some(Boolean))?.categories ?? [];
	const labelEvery = Math.max(1, Math.ceil(categoryCount / Math.max(1, Math.floor((horizontal ? area.height : area.width) / 40))));
	if (!scatter) {
		for (let category = 0; category < categoryCount; category += labelEvery) {
			const label = categories[category] ?? String(category + 1);
			if (horizontal) {
				svgText(parent, area.x - 4, area.y + slot * category + slot / 2 + 3, label, { size: 9, anchor: 'end' });
			} else {
				svgText(parent, area.x + slot * category + slot / 2, area.y + area.height + 11, label, { size: 9, anchor: 'middle' });
			}
		}
	}
	const barGroups = groups.filter(group => group.kind === 'column' || group.kind === 'bar');
	groups.forEach((group, groupIndex) => {
		const groupSegments = segments[groupIndex];
		if (group.kind === 'column' || group.kind === 'bar') {
			const clustered = group.grouping !== 'stacked' && group.grouping !== 'percentStacked';
			const barCount = clustered ? Math.max(1, group.series.length) : 1;
			const groupOffset = barGroups.indexOf(group);
			const width = slot * 0.7 / barCount / Math.max(1, barGroups.length);
			group.series.forEach((series, seriesIndex) => {
				for (let category = 0; category < categoryCount; category++) {
					const segment = groupSegments[seriesIndex][category];
					if (!segment || series.values[category] === null || series.values[category] === undefined) {
						continue;
					}
					const offset = slot * 0.15 + (groupOffset * barCount + (clustered ? seriesIndex : 0)) * width;
					const start = valueToPx(segment.start);
					const end = valueToPx(segment.end);
					if (horizontal) {
						svgRect(parent, start, area.y + slot * category + offset, end - start, width, series.color ?? '#888888');
					} else {
						svgRect(parent, area.x + slot * category + offset, end, width, start - end, series.color ?? '#888888');
					}
				}
			});
			return;
		}
		group.series.forEach((series, seriesIndex) => {
			const points: [number, number][] = [];
			for (let category = 0; category < categoryCount; category++) {
				const segment = groupSegments[seriesIndex][category];
				if (!segment || series.values[category] === null || series.values[category] === undefined) {
					continue;
				}
				const x = scatter && series.xValues
					? area.x + ((series.xValues[category] ?? 0) - xRange.min) / ((xRange.max - xRange.min) || 1) * area.width
					: area.x + slot * category + slot / 2;
				points.push([x, valueToPx(segment.end)]);
			}
			if (points.length === 0) {
				return;
			}
			const color = series.color ?? '#888888';
			const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`).join(' ');
			if (group.kind === 'area') {
				const base = valueToPx(0);
				svgPath(parent, `${line} L ${round(points[points.length - 1][0])} ${round(base)} L ${round(points[0][0])} ${round(base)} Z`, color, color, 1);
			} else if (group.kind === 'scatter') {
				for (const [x, y] of points) {
					svgRect(parent, x - 2.5, y - 2.5, 5, 5, color);
				}
			} else {
				svgPath(parent, line, color, 'none', 2);
			}
		});
	});
}

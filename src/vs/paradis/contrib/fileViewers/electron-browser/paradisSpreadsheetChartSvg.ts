/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のグラフを SVG に描く（図形の描画 paradisSpreadsheetShapeSvg.ts から分けた）。値は chartN.xml に
// 保存された値（numCache・strCache）を使い、文書の文字は textContent、数値は属性にだけ入れる。

import type { IParadisChartData, IParadisChartGroup } from '../common/paradisSpreadsheet.js';
import type { ParadisShapeBox } from './paradisSpreadsheetShapeSvg.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

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

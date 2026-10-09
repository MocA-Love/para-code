/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のグラフを SVG に描く（図形の描画 paradisSpreadsheetShapeSvg.ts から分けた）。値は chartN.xml に
// 保存された値（numCache・strCache）を使い、文書の文字は textContent、数値は属性にだけ入れる。

import type { IParadisChartAxis, IParadisChartData, IParadisChartDataLabels, IParadisChartGroup, IParadisChartSeries } from '../common/paradisSpreadsheet.js';
import { formatPreparedSpreadsheetValue, prepareSpreadsheetNumberFormat, type ParadisSpreadsheetPreparedNumberFormat } from '../common/spreadsheet/paradisSpreadsheetNumberFormat.js';
import { PARADIS_CHART_MAX_DATA_LABELS } from './paradisSpreadsheetChartParser.js';
import type { ParadisShapeBox } from './paradisSpreadsheetShapeSvg.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

function svgText(parent: Element, x: number, y: number, value: string, options: { readonly size?: number; readonly anchor?: 'start' | 'middle' | 'end'; readonly bold?: boolean; readonly baseline?: string; readonly rotate?: number } = {}): void {
	const text = parent.ownerDocument.createElementNS(SVG_NS, 'text');
	text.setAttribute('x', round(x));
	text.setAttribute('y', round(y));
	text.setAttribute('font-size', String(options.size ?? 10));
	text.setAttribute('fill', '#404040');
	if (options.rotate) {
		text.setAttribute('transform', `rotate(${round(options.rotate)} ${round(x)} ${round(y)})`);
	}
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

function svgRect(parent: Element, x: number, y: number, width: number, height: number, fill: string, stroke?: string): Element {
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
	return rect;
}

function svgPath(parent: Element, d: string, stroke: string, fill: string, width = 1.5): Element {
	const path = parent.ownerDocument.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('stroke', stroke);
	path.setAttribute('stroke-width', String(width));
	path.setAttribute('fill', fill);
	parent.appendChild(path);
	return path;
}

function svgCircle(parent: Element, cx: number, cy: number, r: number, fill: string, opacity?: number): void {
	const circle = parent.ownerDocument.createElementNS(SVG_NS, 'circle');
	circle.setAttribute('cx', round(cx));
	circle.setAttribute('cy', round(cy));
	circle.setAttribute('r', round(Math.max(0, r)));
	circle.setAttribute('fill', fill);
	if (opacity !== undefined) {
		circle.setAttribute('fill-opacity', String(opacity));
		circle.setAttribute('stroke', fill);
	}
	parent.appendChild(circle);
}

/** 文書から読んだ色は `#RRGGBB` だけを属性に入れる。それ以外は灰色にする。 */
function safeColor(color: string | undefined, fallback = '#888888'): string {
	return color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : fallback;
}

/** 文字の幅の見込み（px）。全角は 1 文字、半角は 0.6 文字で数える。 */
function textWidth(value: string, size: number): number {
	let width = 0;
	for (const char of value) {
		width += (char.codePointAt(0) ?? 0) >= 0x2E80 ? size : size * 0.6;
	}
	return width;
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

/**
 * 1 回の描画（{@link appendChartSvg} の呼び出し 1 回）の間だけ使う状態。書式は書式ごとに 1 回だけ準備し、
 * データラベルは上限の数まで描く。描画は同期で進むので、呼び出しの間だけ置いておく。
 */
interface ChartPaintState {
	readonly formats: Map<string, ParadisSpreadsheetPreparedNumberFormat | undefined>;
	labelsLeft: number;
}

let paintState: ChartPaintState | undefined;

/** データラベルを 1 つ描いてよいか（上限の数まで）。 */
function takeLabel(): boolean {
	return !paintState || paintState.labelsLeft-- > 0;
}

function preparedFormat(formatCode: string): ParadisSpreadsheetPreparedNumberFormat | undefined {
	const cache = paintState?.formats;
	if (cache?.has(formatCode)) {
		return cache.get(formatCode);
	}
	let prepared: ParadisSpreadsheetPreparedNumberFormat | undefined;
	try {
		prepared = prepareSpreadsheetNumberFormat(formatCode);
	} catch {
		prepared = undefined;
	}
	cache?.set(formatCode, prepared);
	return prepared;
}

/** 数値を書式に沿って文字にする。書式が無い・読めないときは簡単な書き方にする。 */
function formatNumber(value: number, formatCode: string | undefined, percent = false): string {
	const prepared = formatCode ? preparedFormat(formatCode) : undefined;
	if (prepared) {
		try {
			const formatted = formatPreparedSpreadsheetValue(prepared, value);
			if (formatted.text) {
				return formatted.text;
			}
		} catch {
			// 読めない書式は簡単な書き方へ。
		}
	}
	return formatTick(value, percent);
}

/** 数の並びの最小と最大（配列を引数に展開しないので、点が多くても止まらない）。 */
function extent(values: Iterable<number | null | undefined>): { readonly min: number; readonly max: number } | undefined {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		if (value !== null && value !== undefined && Number.isFinite(value)) {
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
	}
	return min <= max ? { min, max } : undefined;
}

function* seriesValues(group: IParadisChartGroup): Iterable<number | null> {
	for (const series of group.series) {
		yield* series.values;
	}
}

const MAX_TICKS = 50;

/** 値の軸の目盛り（範囲・間隔・反転・対数）。 */
interface ValueScale {
	readonly min: number;
	readonly max: number;
	readonly ticks: readonly number[];
	/** 値を軸の上の位置（最小の側を 0、最大の側を 1）にする。対数で 0 以下なら undefined。 */
	unit(value: number): number | undefined;
}

/** データの範囲と軸の指定から目盛りを決める。棒の付け根が見えるよう、線形では 0 を含める。 */
function buildValueScale(dataMin: number, dataMax: number, axis: IParadisChartAxis | undefined, includeZero = true): ValueScale {
	const reversed = axis?.reversed ?? false;
	const flip = (unit: number) => reversed ? 1 - unit : unit;
	if (axis?.logBase) {
		const base = axis.logBase;
		const log = (value: number) => Math.log(value) / Math.log(base);
		const positiveMin = dataMin > 0 ? dataMin : Math.min(1, dataMax > 0 ? dataMax : 1);
		let low = axis.min !== undefined && axis.min > 0 ? log(axis.min) : Math.floor(log(positiveMin));
		let high = axis.max !== undefined && axis.max > 0 ? log(axis.max) : Math.ceil(log(Math.max(dataMax, positiveMin)));
		if (!(high > low)) {
			high = low + 1;
		}
		if (high - low > MAX_TICKS) {
			low = high - MAX_TICKS;
		}
		const ticks: number[] = [];
		for (let exponent = Math.ceil(low - 1e-9); exponent <= high + 1e-9 && ticks.length <= MAX_TICKS; exponent++) {
			ticks.push(Math.pow(base, exponent));
		}
		return {
			min: Math.pow(base, low), max: Math.pow(base, high), ticks,
			unit: value => value > 0 ? flip((log(value) - low) / (high - low)) : undefined,
		};
	}
	let low = includeZero ? Math.min(0, dataMin) : dataMin;
	let high = includeZero ? Math.max(0, dataMax) : dataMax;
	if (axis?.min !== undefined) {
		low = axis.min;
	}
	if (axis?.max !== undefined) {
		high = axis.max;
	}
	if (!(high > low)) {
		high = low + 1;
	}
	let step = axis?.majorUnit ?? niceStep(high - low, 5);
	if ((high - low) / step > MAX_TICKS) {
		step = niceStep(high - low, 5);
	}
	const min = axis?.min !== undefined ? axis.min : Math.floor(low / step + 1e-9) * step;
	const max = axis?.max !== undefined ? axis.max : Math.ceil(high / step - 1e-9) * step;
	const ticks: number[] = [];
	for (let index = 0; ticks.length <= MAX_TICKS; index++) {
		const value = min + index * step;
		if (value > max + step * 1e-6) {
			break;
		}
		ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
	}
	const span = (max - min) || 1;
	return { min, max, ticks, unit: value => flip((value - min) / span) };
}

/** 軸の目盛りの文字の書式。`sourceLinked` なら系列の保存された書式を使う。 */
function axisFormat(axis: IParadisChartAxis | undefined, series: readonly IParadisChartSeries[]): string | undefined {
	if (axis && !axis.sourceLinked && axis.formatCode) {
		return axis.formatCode;
	}
	return series.find(item => item.formatCode)?.formatCode;
}

/** データラベルの文字（系列名・分類名・値・割合を「, 」でつなぐ）。 */
function labelText(labels: IParadisChartDataLabels, series: IParadisChartSeries, category: string, value: number, percent?: number): string {
	const parts: string[] = [];
	if (labels.series && series.name) {
		parts.push(series.name);
	}
	if (labels.category && category) {
		parts.push(category);
	}
	if (labels.value) {
		parts.push(formatNumber(value, labels.formatCode ?? series.formatCode));
	}
	if (labels.percent && percent !== undefined) {
		parts.push(formatNumber(percent, '0%', true));
	}
	return parts.join(', ');
}

/** 点の印（丸）。 */
function appendMarker(parent: Element, x: number, y: number, color: string): void {
	svgCircle(parent, x, y, 3, color);
}

/** 点の横にデータラベルを置く（折れ線・散布図・バブル・レーダー・株価）。 */
function appendPointLabel(parent: Element, x: number, y: number, text: string, position: IParadisChartDataLabels['position'], fallback: NonNullable<IParadisChartDataLabels['position']>): void {
	if (!takeLabel()) {
		return;
	}
	switch (position ?? fallback) {
		case 't': svgText(parent, x, y - 6, text, { size: 9, anchor: 'middle' }); break;
		case 'b': svgText(parent, x, y + 13, text, { size: 9, anchor: 'middle' }); break;
		case 'l': svgText(parent, x - 6, y + 3, text, { size: 9, anchor: 'end' }); break;
		case 'ctr': svgText(parent, x, y + 3, text, { size: 9, anchor: 'middle' }); break;
		default: svgText(parent, x + 6, y + 3, text, { size: 9 }); break;
	}
}

interface LegendItem {
	readonly name: string;
	readonly color: string;
}

/** 凡例を置き、残りの描く範囲を返す。 */
function layoutLegend(parent: Element, items: readonly LegendItem[], position: NonNullable<IParadisChartData['legendPosition']>, area: ParadisShapeBox): ParadisShapeBox {
	if (items.length === 0) {
		return area;
	}
	const rowHeight = 14;
	if (position === 't' || position === 'b') {
		// 横に並べ、入り切らなければ折り返す（最大 3 行）。
		const rows: { item: LegendItem; width: number }[][] = [[]];
		let rowWidth = 0;
		for (const item of items) {
			const width = 12 + textWidth(item.name, 9) + 12;
			if (rowWidth + width > area.width && rows[rows.length - 1].length > 0) {
				if (rows.length === 3) {
					break;
				}
				rows.push([]);
				rowWidth = 0;
			}
			rows[rows.length - 1].push({ item, width });
			rowWidth += width;
		}
		const height = rows.length * rowHeight + 4;
		const top = position === 't' ? area.y : area.y + area.height - height;
		rows.forEach((row, rowIndex) => {
			const total = row.reduce((sum, entry) => sum + entry.width, 0);
			let x = area.x + Math.max(0, (area.width - total) / 2);
			const y = top + 2 + rowIndex * rowHeight;
			for (const { item, width } of row) {
				svgRect(parent, x, y + 1, 8, 8, safeColor(item.color));
				svgText(parent, x + 12, y + 9, item.name, { size: 9 });
				x += width;
			}
		});
		return position === 't'
			? { x: area.x, y: area.y + height, width: area.width, height: area.height - height }
			: { x: area.x, y: area.y, width: area.width, height: area.height - height };
	}
	const visible = items.slice(0, Math.max(1, Math.floor((area.height - 6) / rowHeight)));
	const width = Math.min(area.width * 0.3, Math.max(40, (extent(visible.map(item => textWidth(item.name, 9)))?.max ?? 0) + 24), 120);
	const blockHeight = visible.length * rowHeight;
	const left = position === 'l' ? area.x : area.x + area.width - width;
	// 右は上下の真ん中、右上は上に寄せる（Excel の既定の置き方）。
	const top = position === 'tr' ? area.y + 4 : area.y + Math.max(4, (area.height - blockHeight) / 2);
	visible.forEach((item, index) => {
		const y = top + index * rowHeight;
		svgRect(parent, left + 4, y, 8, 8, safeColor(item.color));
		svgText(parent, left + 16, y + 8, item.name, { size: 9 });
	});
	return position === 'l'
		? { x: area.x + width, y: area.y, width: area.width - width, height: area.height }
		: { x: area.x, y: area.y, width: area.width - width, height: area.height };
}

/** 等高線の帯（値の軸の目盛りの区切り）。 */
function surfaceBands(chart: IParadisChartData, group: IParadisChartGroup): { readonly scale: ValueScale; readonly format: string | undefined } {
	const range = extent(seriesValues(group));
	const axis = valueAxisOf(chart, group);
	const scale = buildValueScale(range?.min ?? 0, range?.max ?? 1, axis, false);
	return { scale, format: axisFormat(axis, group.series) };
}

/** 凡例に並べる項目の上限（円の分類が何万あっても、凡例の項目を作りすぎない）。 */
const MAX_LEGEND_ITEMS = 200;

/**
 * 保存済みの値でグラフを描く。壊れた値で例外が出ても、このグラフの枠だけで止める（シートのほかの図形は
 * 描き続ける）。
 */
export function appendChartSvg(parent: Element, chart: IParadisChartData, box: ParadisShapeBox, content = true): void {
	const previous = paintState;
	paintState = { formats: new Map(), labelsLeft: PARADIS_CHART_MAX_DATA_LABELS };
	try {
		drawChart(parent, chart, box, content);
	} catch {
		// 描けたところまでで止める。
	} finally {
		paintState = previous;
	}
}

function drawChart(parent: Element, chart: IParadisChartData, box: ParadisShapeBox, content: boolean): void {
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
	const surfaceGroup = chart.groups.find(group => group.kind === 'surface');
	let legendItems: LegendItem[];
	if (pieGroup) {
		legendItems = (pieGroup.series[0]?.categories ?? []).slice(0, MAX_LEGEND_ITEMS).map((name, index) => ({ name: name || String(index + 1), color: pieGroup.series[0].pointColors?.[index] ?? '#888888' }));
	} else if (surfaceGroup) {
		const { scale, format } = surfaceBands(chart, surfaceGroup);
		legendItems = scale.ticks.slice(0, -1).map((value, index) => ({
			name: `${formatNumber(value, format)}-${formatNumber(scale.ticks[index + 1], format)}`,
			color: surfaceGroup.bandColors?.[index] ?? '#888888',
		}));
	} else {
		legendItems = chart.groups.flatMap(group => group.series.map((series, index) => ({ name: series.name ?? `Series${index + 1}`, color: series.color ?? '#888888' }))).slice(0, MAX_LEGEND_ITEMS);
	}
	const area = { x: box.x + 8, y: top, width: box.width - 16, height: box.y + box.height - 8 - top };
	const plot = chart.legend ? layoutLegend(frame, legendItems, chart.legendPosition ?? 'r', area) : area;
	if (plot.width < 16 || plot.height < 16) {
		return;
	}
	if (pieGroup) {
		appendPie(frame, pieGroup, plot);
		return;
	}
	if (surfaceGroup) {
		appendSurface(frame, chart, surfaceGroup, plot);
		return;
	}
	const radarGroup = chart.groups.find(group => group.kind === 'radar');
	if (radarGroup) {
		appendRadar(frame, chart, radarGroup, plot);
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
	const labels: { x: number; y: number; text: string }[] = [];
	let angle = -Math.PI / 2;
	values.forEach((value, index) => {
		if (value <= 0) {
			return;
		}
		const sweep = value / total * Math.PI * 2;
		const end = angle + sweep;
		const large = sweep > Math.PI ? 1 : 0;
		const color = safeColor(series.pointColors?.[index]);
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
		const labelSettings = series.dataLabels;
		if (labelSettings) {
			const middle = angle + sweep / 2;
			const distance = labelSettings.position === 'outEnd' ? radius + 10 : labelSettings.position === 'inEnd' ? radius * 0.8 : inner > 0 ? (radius + inner) / 2 : radius * 0.62;
			labels.push({ x: cx + distance * Math.cos(middle), y: cy + distance * Math.sin(middle), text: labelText(labelSettings, series, series.categories[index] ?? '', value, value / total) });
		}
		angle = end;
	});
	if (inner > 0) {
		svgCircle(parent, cx, cy, inner, '#FFFFFF');
	}
	for (const label of labels) {
		if (takeLabel()) {
			svgText(parent, label.x, label.y + 3, label.text, { size: 9, anchor: 'middle' });
		}
	}
}

/** 群が使う軸を探す。`kind` が合うもののうち、群の `axId` に挙がっているもの。 */
function groupAxis(chart: IParadisChartData, group: IParadisChartGroup, kinds: readonly IParadisChartAxis['kind'][], index = 0): IParadisChartAxis | undefined {
	const ids = group.axisIds ?? [];
	const matches = (chart.axes ?? []).filter(axis => ids.includes(axis.id) && kinds.includes(axis.kind));
	return matches[index];
}

/**
 * 散布図・バブルの 2 本の値の軸のうち、X（`horizontal`）か Y の軸。`axPos` が b・t なら X、l・r なら Y。
 * どちらとも決められなければ、`axId` の並び（X が先）に従う。
 */
function xyAxis(chart: IParadisChartData, group: IParadisChartGroup, horizontal: boolean): IParadisChartAxis | undefined {
	const ids = group.axisIds ?? [];
	const axes = ids.map(id => (chart.axes ?? []).find(axis => axis.id === id)).filter((axis): axis is IParadisChartAxis => !!axis);
	const byPosition = axes.find(axis => (axis.position === 'b' || axis.position === 't') === horizontal);
	return byPosition ?? axes[horizontal ? 0 : 1];
}

function valueAxisOf(chart: IParadisChartData, group: IParadisChartGroup): IParadisChartAxis | undefined {
	if (group.kind === 'scatter' || group.kind === 'bubble') {
		return xyAxis(chart, group, false);
	}
	return groupAxis(chart, group, ['value']);
}

function categoryAxisOf(chart: IParadisChartData, group: IParadisChartGroup): IParadisChartAxis | undefined {
	if (group.kind === 'scatter' || group.kind === 'bubble') {
		return xyAxis(chart, group, true);
	}
	return groupAxis(chart, group, ['category', 'date']);
}

/**
 * 値のある最後の添字 + 1。`ptCount` は文書がいくらでも大きく書けるので、軸や列の数には使わない。
 */
function filledLength(group: IParadisChartGroup): number {
	let length = 0;
	for (const series of group.series) {
		for (let index = series.values.length - 1; index >= length; index--) {
			if (series.values[index] !== null && series.values[index] !== undefined) {
				length = index + 1;
				break;
			}
		}
	}
	return length;
}

/** レーダーの目盛りの輪を多角形で描く頂点の数の上限。越えたら円で描く。 */
const MAX_RADAR_RING_VERTICES = 360;

/** レーダー: 分類を放射状の軸に、値を中心からの距離にする。 */
function appendRadar(parent: Element, chart: IParadisChartData, group: IParadisChartGroup, plot: ParadisShapeBox): void {
	const count = filledLength(group);
	if (count < 3) {
		return;
	}
	const range = extent(seriesValues(group));
	const axis = valueAxisOf(chart, group);
	const scale = buildValueScale(range?.min ?? 0, range?.max ?? 1, axis ? { ...axis, logBase: undefined, reversed: false } : undefined);
	const categories = group.series.find(series => series.categories.some(Boolean))?.categories ?? [];
	const radiusGuess = Math.max(4, Math.min(plot.width, plot.height) / 2 - 14);
	// 分類の文字と軸の線は、円周に 30px ごとに 1 本まで間引く（分類の軸の文字と同じ考え方）。
	const labelEvery = Math.max(1, Math.ceil(count / Math.max(3, Math.floor(2 * Math.PI * radiusGuess / 30))));
	let widestLabel = 0;
	for (let index = 0; index < count; index += labelEvery) {
		widestLabel = Math.max(widestLabel, textWidth(categories[index] ?? String(index + 1), 9));
	}
	const labelRoom = Math.min(40, widestLabel + 8);
	const radius = Math.max(4, Math.min(plot.width / 2 - labelRoom, plot.height / 2 - 14));
	const cx = plot.x + plot.width / 2;
	const cy = plot.y + plot.height / 2;
	const point = (index: number, unit: number): [number, number] => {
		const angle = -Math.PI / 2 + index / count * Math.PI * 2;
		return [cx + radius * unit * Math.cos(angle), cy + radius * unit * Math.sin(angle)];
	};
	const polygon = (unit: number) => {
		const parts: string[] = [];
		for (let index = 0; index < count; index++) {
			const [x, y] = point(index, unit);
			parts.push(`${index === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`);
		}
		return parts.join(' ') + ' Z';
	};
	if (axis?.gridlines ?? true) {
		for (const tick of scale.ticks) {
			const unit = scale.unit(tick) ?? 0;
			if (unit <= 0) {
				continue;
			}
			// 頂点が多いと、輪 1 本ごとに点の数だけ頂点ができる（目盛りの数を掛けると膨らむ）。円と見分けが
			// つかない数を越えたら、円で描く。
			if (count > MAX_RADAR_RING_VERTICES) {
				const ring = parent.ownerDocument.createElementNS(SVG_NS, 'circle');
				ring.setAttribute('cx', round(cx));
				ring.setAttribute('cy', round(cy));
				ring.setAttribute('r', round(radius * unit));
				ring.setAttribute('fill', 'none');
				ring.setAttribute('stroke', '#E0E0E0');
				ring.setAttribute('stroke-width', '1');
				parent.appendChild(ring);
			} else {
				svgPath(parent, polygon(unit), '#E0E0E0', 'none', 1);
			}
		}
	}
	for (let index = 0; index < count; index += labelEvery) {
		const [x, y] = point(index, 1);
		svgPath(parent, `M ${round(cx)} ${round(cy)} L ${round(x)} ${round(y)}`, '#D9D9D9', 'none', 1);
		const [lx, ly] = point(index, 1 + 10 / radius);
		const anchor = Math.abs(lx - cx) < 4 ? 'middle' : lx > cx ? 'start' : 'end';
		svgText(parent, lx, ly + 3, categories[index] ?? String(index + 1), { size: 9, anchor });
	}
	if (!axis?.deleted && (axis?.tickLabels ?? true)) {
		const format = axisFormat(axis, group.series);
		for (const tick of scale.ticks) {
			const unit = scale.unit(tick) ?? 0;
			svgText(parent, cx - 3, cy - radius * unit + 3, formatNumber(tick, format), { size: 8, anchor: 'end' });
		}
	}
	for (const series of group.series) {
		const color = safeColor(series.color);
		const parts: string[] = [];
		for (let index = 0; index < count; index++) {
			const value = series.values[index];
			const [x, y] = point(index, value === null || value === undefined ? 0 : Math.max(0, Math.min(1, scale.unit(value) ?? 0)));
			parts.push(`${index === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`);
		}
		const path = svgPath(parent, parts.join(' ') + ' Z', color, group.radarStyle === 'filled' ? color : 'none', 2);
		if (group.radarStyle === 'filled') {
			path.setAttribute('fill-opacity', '0.5');
		}
		for (let index = 0; index < count; index++) {
			const value = series.values[index];
			if (value === null || value === undefined) {
				continue;
			}
			const [x, y] = point(index, Math.max(0, Math.min(1, scale.unit(value) ?? 0)));
			if (series.marker) {
				appendMarker(parent, x, y, color);
			}
			if (series.dataLabels) {
				appendPointLabel(parent, x, y, labelText(series.dataLabels, series, categories[index] ?? '', value), series.dataLabels.position, 't');
			}
		}
	}
}

/** 等高線: 上から見た面を、値の帯ごとに塗り分ける（列が分類、行が系列）。 */
function appendSurface(parent: Element, chart: IParadisChartData, group: IParadisChartGroup, plot: ParadisShapeBox): void {
	const rows = group.series.length;
	const columns = filledLength(group);
	if (rows === 0 || columns === 0) {
		return;
	}
	const { scale } = surfaceBands(chart, group);
	const bandCount = Math.max(1, scale.ticks.length - 1);
	const bandOf = (value: number) => Math.max(0, Math.min(bandCount - 1, Math.floor((scale.unit(value) ?? 0) * bandCount)));
	const valueAt = (row: number, column: number) => group.series[Math.max(0, Math.min(rows - 1, row))].values[Math.max(0, Math.min(columns - 1, column))] ?? scale.min;
	// 格子の点（行・列）の間を双線形で補って、小さな升に分けて塗る。升の数は描く量の上限に収める。
	const cellsX = Math.max(1, columns - 1);
	const cellsY = Math.max(1, rows - 1);
	const per = Math.max(1, Math.min(12, Math.floor(Math.sqrt(20_000 / (cellsX * cellsY)))));
	const samplesX = cellsX * per;
	const samplesY = cellsY * per;
	const width = plot.width / samplesX;
	const height = plot.height / samplesY;
	const sample = (sx: number, sy: number) => {
		const fx = columns === 1 ? 0 : (sx + 0.5) / per;
		const fy = rows === 1 ? 0 : (sy + 0.5) / per;
		const x0 = Math.floor(fx), y0 = Math.floor(fy);
		const tx = fx - x0, ty = fy - y0;
		const top = valueAt(y0, x0) * (1 - tx) + valueAt(y0, x0 + 1) * tx;
		const bottom = valueAt(y0 + 1, x0) * (1 - tx) + valueAt(y0 + 1, x0 + 1) * tx;
		return top * (1 - ty) + bottom * ty;
	};
	for (let sy = 0; sy < samplesY; sy++) {
		// 同じ帯が続く升は 1 つの矩形にまとめる（DOM の数を抑える）。行の 0 番目の系列を下に置く。
		const y = plot.y + plot.height - (sy + 1) * height;
		let runStart = 0;
		let runBand = bandOf(sample(0, sy));
		for (let sx = 1; sx <= samplesX; sx++) {
			const band = sx < samplesX ? bandOf(sample(sx, sy)) : -1;
			if (band !== runBand) {
				svgRect(parent, plot.x + runStart * width, y, (sx - runStart) * width + 0.5, height + 0.5, safeColor(group.bandColors?.[runBand]));
				runStart = sx;
				runBand = band;
			}
		}
	}
	svgRect(parent, plot.x, plot.y, plot.width, plot.height, 'none', '#A0A0A0');
}

function appendCartesian(parent: Element, chart: IParadisChartData, plot: ParadisShapeBox): void {
	const groups = chart.groups;
	const xy = groups.every(group => group.kind === 'scatter' || group.kind === 'bubble');
	const horizontal = groups.some(group => group.kind === 'bar');
	let categoryCount = 1;
	for (const group of groups) {
		for (const series of group.series) {
			categoryCount = Math.max(categoryCount, series.values.length, series.categories.length);
		}
	}
	const segments = groups.map(group => stackedSegments(group, categoryCount));
	const hasBubbles = groups.some(group => group.kind === 'bubble');
	// 値の軸ごとに群を分ける（複合グラフの第 2 軸）。軸の情報が無いグラフは 1 本にまとめる。
	const found: (IParadisChartAxis | undefined)[] = [];
	const foundIndexOf = groups.map(group => {
		const axis = valueAxisOf(chart, group);
		let index = found.findIndex(candidate => candidate === axis || (candidate && axis && candidate.id === axis.id));
		if (index < 0) {
			index = found.length < 2 ? found.push(axis) - 1 : 0;
		}
		return index;
	});
	// 第 2 軸（右、横棒は上）は `axPos` で決める。出てくる順は使わない。
	const secondarySide = horizontal ? 't' : 'r';
	const swap = found.length === 2 && found[0]?.position === secondarySide && found[1]?.position !== secondarySide;
	const valueAxes = swap ? [found[1], found[0]] : found;
	const axisIndexOf = foundIndexOf.map(index => swap ? 1 - index : index);
	const scales = valueAxes.map((axis, axisIndex) => {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		groups.forEach((group, groupIndex) => {
			if (axisIndexOf[groupIndex] !== axisIndex) {
				return;
			}
			// 棒と面は付け根も範囲に入れる。折れ線・散布図・株価などは点の値だけ。
			const withBase = group.kind === 'column' || group.kind === 'bar' || group.kind === 'area';
			segments[groupIndex].forEach((seriesSegments, seriesIndex) => {
				seriesSegments.forEach((segment, category) => {
					const raw = group.series[seriesIndex].values[category];
					if (!segment || raw === null || raw === undefined) {
						return;
					}
					min = Math.min(min, segment.end, withBase ? segment.start : segment.end);
					max = Math.max(max, segment.end, withBase ? segment.start : segment.end);
				});
			});
		});
		if (!Number.isFinite(min)) {
			min = 0;
			max = 1;
		}
		if (hasBubbles) {
			[min, max] = padForBubbles(min, max);
		}
		// 散布図・バブル・株価は 0 を含めない（値の近くだけを見せる）。棒・折れ線・面は今までどおり 0 から。
		const includeZero = groups.some((group, groupIndex) => axisIndexOf[groupIndex] === axisIndex && group.kind !== 'scatter' && group.kind !== 'bubble' && group.kind !== 'stock');
		return buildValueScale(min, max, axis, includeZero);
	});
	const axisSeries = (axisIndex: number) => groups.filter((_, groupIndex) => axisIndexOf[groupIndex] === axisIndex).flatMap(group => group.series);
	const percent = (axisIndex: number) => groups.some((group, groupIndex) => axisIndexOf[groupIndex] === axisIndex && group.grouping === 'percentStacked');
	const tickText = (axisIndex: number, value: number) => formatNumber(value, axisFormat(valueAxes[axisIndex], axisSeries(axisIndex)) ?? (percent(axisIndex) ? '0%' : undefined), percent(axisIndex));
	const showTicks = (axis: IParadisChartAxis | undefined) => !axis?.deleted && (axis?.tickLabels ?? true);
	// 第 1 軸の群の分類の軸を、目盛りの文字に使う。
	const categoryAxis = categoryAxisOf(chart, groups.find((_, groupIndex) => axisIndexOf[groupIndex] === 0) ?? groups[0]);
	// 散布図・バブルの X は値の軸。
	let xScale: ValueScale | undefined;
	if (xy) {
		const xs = extent((function* () {
			for (const group of groups) {
				for (const series of group.series) {
					yield* series.xValues ?? [];
				}
			}
		})());
		const [low, high] = hasBubbles ? padForBubbles(xs?.min ?? 0, xs?.max ?? 1) : [xs?.min ?? 0, xs?.max ?? 1];
		xScale = buildValueScale(low, high, categoryAxis, false);
	}
	const categories = groups.flatMap(group => group.series).find(series => series.categories.some(Boolean))?.categories ?? [];
	const categoryFormat = categoryAxis && !categoryAxis.sourceLinked ? categoryAxis.formatCode : undefined;
	const categoryLabel = (index: number) => {
		const raw = categories[index] ?? String(index + 1);
		const number = Number(raw);
		return categoryFormat && raw.trim() !== '' && Number.isFinite(number) ? formatNumber(number, categoryFormat) : raw;
	};
	// 余白: 値の軸の目盛りの文字と、軸の名前の分。
	const primaryLabels = showTicks(valueAxes[0]) ? scales[0].ticks.map(tick => tickText(0, tick)) : [];
	const secondaryLabels = scales[1] && showTicks(valueAxes[1]) ? scales[1].ticks.map(tick => tickText(1, tick)) : [];
	const widest = (labels: readonly string[]) => labels.length ? (extent(labels.map(label => textWidth(label, 9)))?.max ?? 0) + 6 : 0;
	const categoryTitle = categoryAxis?.title;
	const primaryTitle = valueAxes[0]?.title;
	const secondaryTitle = valueAxes[1]?.title;
	const categoryLabelsShown = showTicks(categoryAxis);
	let left: number, right: number, topPad: number, bottom: number;
	if (horizontal) {
		// 描く分類の文字（縦に 14px ごとに 1 つまで）だけを測る。
		let widestCategory = 0;
		const step = Math.max(1, Math.ceil(categoryCount / Math.max(1, Math.floor(plot.height / 14))));
		for (let index = 0; categoryLabelsShown && index < categoryCount; index += step) {
			widestCategory = Math.max(widestCategory, textWidth(categoryLabel(index), 9));
		}
		const categoryLabelWidth = categoryLabelsShown ? Math.min(plot.width * 0.4, widestCategory + 6) : 0;
		left = categoryLabelWidth + (categoryTitle ? 14 : 0);
		right = 6;
		bottom = (primaryLabels.length ? 14 : 0) + (primaryTitle ? 14 : 0);
		topPad = (secondaryLabels.length ? 14 : 0) + (secondaryTitle ? 14 : 0);
	} else {
		left = Math.max(8, widest(primaryLabels)) + (primaryTitle ? 14 : 0);
		right = Math.max(6, widest(secondaryLabels)) + (secondaryTitle ? 14 : 0);
		bottom = (categoryLabelsShown || xy ? 14 : 0) + (categoryTitle ? 14 : 0);
		topPad = 4;
	}
	const area = { x: plot.x + left, y: plot.y + topPad, width: plot.width - left - right, height: plot.height - topPad - bottom };
	if (area.width < 8 || area.height < 8) {
		return;
	}
	const valueToPx = (axisIndex: number, value: number): number | undefined => {
		const unit = scales[axisIndex].unit(value);
		if (unit === undefined) {
			return undefined;
		}
		return horizontal ? area.x + unit * area.width : area.y + area.height - unit * area.height;
	};
	// 目盛りの線（第 1 軸の主目盛り線）と値の文字。
	const primaryAxis = valueAxes[0];
	const gridlines = chart.axes ? !!primaryAxis?.gridlines : true;
	scales.forEach((scale, axisIndex) => {
		for (const tick of scale.ticks) {
			const position = valueToPx(axisIndex, tick);
			if (position === undefined) {
				continue;
			}
			if (axisIndex === 0 && gridlines) {
				svgPath(parent, horizontal ? `M ${round(position)} ${round(area.y)} L ${round(position)} ${round(area.y + area.height)}` : `M ${round(area.x)} ${round(position)} L ${round(area.x + area.width)} ${round(position)}`, '#E0E0E0', 'none', 1);
			}
			if (!showTicks(valueAxes[axisIndex])) {
				continue;
			}
			const label = tickText(axisIndex, tick);
			if (horizontal) {
				svgText(parent, position, axisIndex === 0 ? area.y + area.height + 11 : area.y - 4, label, { size: 9, anchor: 'middle' });
			} else if (axisIndex === 0) {
				svgText(parent, area.x - 4, position + 3, label, { size: 9, anchor: 'end' });
			} else {
				svgText(parent, area.x + area.width + 4, position + 3, label, { size: 9 });
			}
		}
	});
	// 軸の名前。
	if (horizontal) {
		if (primaryTitle) {
			svgText(parent, area.x + area.width / 2, plot.y + plot.height - 2, primaryTitle, { size: 9, anchor: 'middle' });
		}
		if (secondaryTitle) {
			svgText(parent, area.x + area.width / 2, plot.y + 10, secondaryTitle, { size: 9, anchor: 'middle' });
		}
		if (categoryTitle) {
			svgText(parent, plot.x + 10, area.y + area.height / 2, categoryTitle, { size: 9, anchor: 'middle', rotate: -90 });
		}
	} else {
		if (primaryTitle) {
			svgText(parent, plot.x + 10, area.y + area.height / 2, primaryTitle, { size: 9, anchor: 'middle', rotate: -90 });
		}
		if (secondaryTitle) {
			svgText(parent, plot.x + plot.width - 4, area.y + area.height / 2, secondaryTitle, { size: 9, anchor: 'middle', rotate: 90 });
		}
		if (categoryTitle) {
			svgText(parent, area.x + area.width / 2, plot.y + plot.height - 2, categoryTitle, { size: 9, anchor: 'middle' });
		}
	}
	// 分類の軸が交わる値（棒の付け根）。第 2 軸の群は、その群の分類の軸の `crosses` を使う。
	const crossing = (axisIndex: number, group?: IParadisChartGroup): number => {
		const scale = scales[axisIndex];
		const crosses = (group ? categoryAxisOf(chart, group) : undefined)?.crosses ?? categoryAxis?.crosses ?? 'autoZero';
		const value = typeof crosses === 'number' ? crosses : crosses === 'min' ? scale.min : crosses === 'max' ? scale.max : Math.max(scale.min, Math.min(scale.max, 0));
		return valueAxes[axisIndex]?.logBase ? Math.max(scale.min, value) : value;
	};
	const baseline = valueToPx(0, crossing(0)) ?? (horizontal ? area.x : area.y + area.height);
	svgPath(parent, horizontal ? `M ${round(baseline)} ${round(area.y)} L ${round(baseline)} ${round(area.y + area.height)}` : `M ${round(area.x)} ${round(baseline)} L ${round(area.x + area.width)} ${round(baseline)}`, '#A0A0A0', 'none', 1);
	// 分類の位置。横棒は 1 つ目の分類を下に置く（Excel と同じ）。`orientation` が maxMin なら逆。
	const slot = (horizontal ? area.height : area.width) / categoryCount;
	const reversedCategories = categoryAxis?.reversed ?? false;
	const slotStart = (category: number) => {
		const order = horizontal !== reversedCategories ? categoryCount - 1 - category : category;
		return (horizontal ? area.y : area.x) + slot * order;
	};
	const xToPx = (value: number) => {
		const unit = xScale?.unit(value);
		return unit === undefined ? undefined : area.x + unit * area.width;
	};
	if (xy && xScale) {
		const xFormat = axisFormat(categoryAxis, []);
		for (const tick of xScale.ticks) {
			const position = xToPx(tick);
			if (position !== undefined && showTicks(categoryAxis)) {
				svgText(parent, position, area.y + area.height + 11, formatNumber(tick, xFormat), { size: 9, anchor: 'middle' });
			}
		}
	} else if (categoryLabelsShown) {
		const labelEvery = Math.max(1, Math.ceil(categoryCount / Math.max(1, Math.floor((horizontal ? area.height / 14 : area.width / 40)))));
		for (let category = 0; category < categoryCount; category += labelEvery) {
			const center = slotStart(category) + slot / 2;
			if (horizontal) {
				svgText(parent, area.x - 4, center + 3, categoryLabel(category), { size: 9, anchor: 'end' });
			} else {
				svgText(parent, center, area.y + area.height + 11, categoryLabel(category), { size: 9, anchor: 'middle' });
			}
		}
	}
	const labelLayer = parent.ownerDocument.createElementNS(SVG_NS, 'g');
	const barGroups = groups.filter(group => group.kind === 'column' || group.kind === 'bar');
	groups.forEach((group, groupIndex) => {
		const axisIndex = axisIndexOf[groupIndex];
		const groupSegments = segments[groupIndex];
		if (group.kind === 'column' || group.kind === 'bar') {
			const clustered = group.grouping !== 'stacked' && group.grouping !== 'percentStacked';
			const barCount = clustered ? Math.max(1, group.series.length) : 1;
			const groupOffset = barGroups.indexOf(group);
			const width = slot * 0.7 / barCount / Math.max(1, barGroups.length);
			const base = crossing(axisIndex, group);
			group.series.forEach((series, seriesIndex) => {
				const color = safeColor(series.color);
				for (let category = 0; category < categoryCount; category++) {
					const segment = groupSegments[seriesIndex][category];
					const raw = series.values[category];
					if (!segment || raw === null || raw === undefined) {
						continue;
					}
					const offset = slot * 0.15 + (groupOffset * barCount + (clustered ? seriesIndex : 0)) * width;
					const start = valueToPx(axisIndex, clustered ? base : segment.start);
					const end = valueToPx(axisIndex, segment.end);
					if (start === undefined || end === undefined) {
						continue;
					}
					const along = slotStart(category) + offset;
					if (horizontal) {
						svgRect(parent, start, along, end - start, width, color);
					} else {
						svgRect(parent, along, end, width, start - end, color);
					}
					if (series.dataLabels) {
						const text = labelText(series.dataLabels, series, categories[category] ?? '', raw);
						appendBarLabel(labelLayer, horizontal, along + width / 2, start, end, text, series.dataLabels.position ?? (clustered ? 'outEnd' : 'ctr'), area);
					}
				}
			});
			return;
		}
		if (group.kind === 'stock') {
			appendStock(parent, labelLayer, group, categoryCount, category => slotStart(category) + slot / 2, value => valueToPx(axisIndex, value), slot);
			return;
		}
		let bubbleMax = 0;
		if (group.kind === 'bubble') {
			for (const series of group.series) {
				for (const size of series.bubbleSizes ?? []) {
					bubbleMax = Math.max(bubbleMax, Math.abs(size ?? 0));
				}
			}
		}
		group.series.forEach((series, seriesIndex) => {
			const points: { x: number; y: number; value: number; category: number }[] = [];
			for (let category = 0; category < categoryCount; category++) {
				const segment = groupSegments[seriesIndex][category];
				const raw = series.values[category];
				if (!segment || raw === null || raw === undefined) {
					continue;
				}
				const x = xy ? xToPx(series.xValues?.[category] ?? category + 1) : slotStart(category) + slot / 2;
				const y = valueToPx(axisIndex, segment.end);
				if (x === undefined || y === undefined) {
					continue;
				}
				points.push({ x, y, value: raw, category });
			}
			if (points.length === 0) {
				return;
			}
			const color = safeColor(series.color);
			if (group.kind === 'bubble') {
				// 大きさの最大を、描く範囲の短い辺の 25%（`bubbleScale` が 100 のとき）の直径にする。
				const maxRadius = Math.min(area.width, area.height) * 0.125 * (group.bubbleScale ?? 100) / 100;
				for (const point of points) {
					const size = Math.abs(series.bubbleSizes?.[point.category] ?? 0);
					const ratio = bubbleMax > 0 ? size / bubbleMax : 0;
					const radius = maxRadius * (group.bubbleSizeRepresents === 'w' ? ratio : Math.sqrt(ratio));
					svgCircle(parent, point.x, point.y, radius, color, 0.75);
					if (series.dataLabels) {
						appendPointLabel(labelLayer, point.x, point.y, labelText(series.dataLabels, series, '', point.value), series.dataLabels.position, 'ctr');
					}
				}
				return;
			}
			const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
			if (group.kind === 'area') {
				const base = valueToPx(axisIndex, crossing(axisIndex, group)) ?? baseline;
				svgPath(parent, `${line} L ${round(points[points.length - 1].x)} ${round(base)} L ${round(points[0].x)} ${round(base)} Z`, color, color, 1);
			} else if (group.kind === 'scatter') {
				for (const point of points) {
					if (series.marker !== false) {
						svgRect(parent, point.x - 2.5, point.y - 2.5, 5, 5, color);
					}
				}
			} else {
				svgPath(parent, line, color, 'none', 2);
				if (series.marker) {
					for (const point of points) {
						appendMarker(parent, point.x, point.y, color);
					}
				}
			}
			if (series.dataLabels) {
				for (const point of points) {
					appendPointLabel(labelLayer, point.x, point.y, labelText(series.dataLabels, series, categories[point.category] ?? '', point.value), series.dataLabels.position, group.kind === 'area' ? 'ctr' : 'r');
				}
			}
		});
	});
	// ラベルは系列の上に重ねる。
	parent.appendChild(labelLayer);
}

/** バブルが描く範囲からはみ出さないよう、値の範囲を両側に 15% 広げる（軸の指定があればそちらが勝つ）。 */
function padForBubbles(min: number, max: number): [number, number] {
	const pad = (max - min) * 0.15 || 1;
	return [min - pad, max + pad];
}

/** 棒のデータラベル。`start` は付け根、`end` は先端の位置（値の軸の方向）。 */
function appendBarLabel(parent: Element, horizontal: boolean, center: number, start: number, end: number, text: string, position: NonNullable<IParadisChartDataLabels['position']>, area: ParadisShapeBox): void {
	if (!takeLabel()) {
		return;
	}
	const direction = end >= start ? 1 : -1;
	let along: number;
	switch (position) {
		case 'inEnd': along = end - direction * 8; break;
		case 'ctr': along = (start + end) / 2; break;
		case 'inBase': along = start + direction * 8; break;
		default: along = end + direction * 8; break;
	}
	if (horizontal) {
		svgText(parent, along, center + 3, text, { size: 9, anchor: position === 'ctr' ? 'middle' : direction > 0 === (position === 'outEnd' || position === 'inBase') ? 'start' : 'end' });
	} else {
		// 縦棒の値の軸は下が小さい（px は上ほど小さい）。描く範囲の外（タイトルの上など）には出さない。
		svgText(parent, center, Math.max(area.y + 9, Math.min(area.y + area.height - 2, along + 3)), text, { size: 9, anchor: 'middle' });
	}
}

/** 株価: 高値と安値を線で結び、始値と終値の箱（上がりは白、下がりは濃い色）を置く。 */
function appendStock(parent: Element, labels: Element, group: IParadisChartGroup, categoryCount: number, centerOf: (category: number) => number, valueToPx: (value: number) => number | undefined, slot: number): void {
	const series = group.series;
	// 系列は 始値・高値・安値・終値（4 本）か、高値・安値・終値（3 本）の順（ECMA-376 Part 1 §21.2.2.198）。
	const [open, high, low, close] = series.length >= 4 ? [series[0], series[1], series[2], series[3]] : [undefined, series[0], series[1], series[2]];
	if (!high || !low) {
		return;
	}
	const boxWidth = Math.max(2, Math.min(16, slot * 0.4));
	for (let category = 0; category < categoryCount; category++) {
		const x = centerOf(category);
		const highValue = high.values[category];
		const lowValue = low.values[category];
		if (highValue !== null && highValue !== undefined && lowValue !== null && lowValue !== undefined && group.hiLowLines !== false) {
			const top = valueToPx(highValue);
			const bottom = valueToPx(lowValue);
			if (top !== undefined && bottom !== undefined) {
				svgPath(parent, `M ${round(x)} ${round(top)} L ${round(x)} ${round(bottom)}`, '#404040', 'none', 1);
			}
		}
		const openValue = open?.values[category];
		const closeValue = close?.values[category];
		const openY = openValue === null || openValue === undefined ? undefined : valueToPx(openValue);
		const closeY = closeValue === null || closeValue === undefined ? undefined : valueToPx(closeValue);
		if (group.upDownBars && openY !== undefined && closeY !== undefined) {
			const up = (closeValue ?? 0) >= (openValue ?? 0);
			svgRect(parent, x - boxWidth / 2, Math.min(openY, closeY), boxWidth, Math.max(1, Math.abs(openY - closeY)), safeColor(up ? group.upDownBars.up : group.upDownBars.down, up ? '#FFFFFF' : '#404040'), '#404040');
		} else {
			// 箱が無いときは、始値を左、終値を右の短い線で示す。
			if (openY !== undefined) {
				svgPath(parent, `M ${round(x - boxWidth / 2)} ${round(openY)} L ${round(x)} ${round(openY)}`, '#404040', 'none', 1.5);
			}
			if (closeY !== undefined) {
				svgPath(parent, `M ${round(x)} ${round(closeY)} L ${round(x + boxWidth / 2)} ${round(closeY)}`, '#404040', 'none', 1.5);
			}
		}
		if (close?.dataLabels && closeY !== undefined && closeValue !== null && closeValue !== undefined) {
			appendPointLabel(labels, x, closeY, labelText(close.dataLabels, close, close.categories[category] ?? '', closeValue), close.dataLabels.position, 'r');
		}
	}
}

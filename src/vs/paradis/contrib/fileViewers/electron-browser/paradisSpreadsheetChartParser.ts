/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のグラフ（chartN.xml、ECMA-376 Part 1 §21.2 DrawingML - Charts）を読む。図形の読み込み
// （paradisSpreadsheetDrawings.ts）から分けた。色の解決（テーマ色・spPr）は図形と同じものを使うので、
// 呼び出し側から受け取る。

import type { IParadisChartAxis, IParadisChartData, IParadisChartDataLabels, IParadisChartGroup, IParadisChartSeries } from '../common/paradisSpreadsheet.js';

/** グラフの部品の色を決める（図形の読み込みと同じテーマ色・spPr の解き方を使う）。 */
export interface IParadisChartColors {
	/** 系列や点（`ser`・`dPt`）の spPr の色。無ければ undefined。 */
	color(part: Element | null): string | undefined;
	/** 既定の系列の色（`index` 番目）。 */
	palette(index: number): string;
}

/** 読む量の上限（paradisSpreadsheetDrawings.ts の上限と同じ値を渡す）。 */
export interface IParadisChartLimits {
	readonly chartSeries: number;
	readonly chartPoints: number;
}

// XML を辿る小さな道具。図形の読み込みにも同じものがあるが、あちらを import すると循環するので持つ。
function xmlAttr(el: Element, name: string): string {
	return el.getAttribute(name) || '';
}

function xmlChild(el: Element | null | undefined, localName: string): Element | null {
	if (!el) {
		return null;
	}
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (child.localName === localName) {
			return child;
		}
	}
	return null;
}

function xmlChildren(el: Element | null | undefined, localName?: string): Element[] {
	const result: Element[] = [];
	if (!el) {
		return result;
	}
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (localName === undefined || child.localName === localName) {
			result.push(child);
		}
	}
	return result;
}

function intAttr(el: Element | null, name: string, fallback: number): number {
	const value = el ? Number.parseInt(xmlAttr(el, name), 10) : Number.NaN;
	return Number.isFinite(value) ? value : fallback;
}

const CHART_KINDS: Record<string, IParadisChartGroup['kind'] | undefined> = {
	lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie',
	doughnutChart: 'doughnut', scatterChart: 'scatter', radarChart: 'radar', bubbleChart: 'bubble', stockChart: 'stock',
	surfaceChart: 'surface', surface3DChart: 'surface',
};

/** 等高線の帯の色を、いくつ先まで用意するか（目盛りの数の上限と同じ）。 */
const SURFACE_BAND_COLORS = 50;

function valAttr(el: Element | null): string | undefined {
	return el ? xmlAttr(el, 'val') : undefined;
}

/** `val` が真か（`c:showVal val="1"` など）。要素が無ければ `fallback`、`val` が無ければ真（ECMA の既定）。 */
function boolVal(el: Element | null, fallback: boolean): boolean {
	if (!el) {
		return fallback;
	}
	const value = xmlAttr(el, 'val');
	return value === '' || value === '1' || value === 'true';
}

function numberVal(el: Element | null): number | undefined {
	const raw = valAttr(el);
	if (raw === undefined || raw.trim() === '') {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

/** 書式の文字列。長すぎるものは使わない（数値の書式の読み手にも上限があるが、手前で切る）。 */
function formatCodeOf(numFmt: Element | null): string | undefined {
	const code = numFmt ? xmlAttr(numFmt, 'formatCode') : '';
	return code && code.length <= 256 ? code : undefined;
}

const LABEL_POSITIONS = new Set(['outEnd', 'inEnd', 'ctr', 'inBase', 't', 'b', 'l', 'r', 'bestFit']);

/** `dLbls` を読む。消してある・何も出さないなら undefined。 */
function parseDataLabels(dLbls: Element | null): IParadisChartDataLabels | undefined {
	if (!dLbls || boolVal(xmlChild(dLbls, 'delete'), false)) {
		return undefined;
	}
	const labels = {
		value: boolVal(xmlChild(dLbls, 'showVal'), false),
		category: boolVal(xmlChild(dLbls, 'showCatName'), false),
		series: boolVal(xmlChild(dLbls, 'showSerName'), false),
		percent: boolVal(xmlChild(dLbls, 'showPercent'), false),
	};
	if (!labels.value && !labels.category && !labels.series && !labels.percent) {
		return undefined;
	}
	const position = valAttr(xmlChild(dLbls, 'dLblPos'));
	const numFmt = xmlChild(dLbls, 'numFmt');
	const formatCode = numFmt && xmlAttr(numFmt, 'sourceLinked') !== '1' ? formatCodeOf(numFmt) : undefined;
	return {
		...labels,
		...(position && LABEL_POSITIONS.has(position) ? { position: position as IParadisChartDataLabels['position'] } : {}),
		...(formatCode ? { formatCode } : {}),
	};
}

/** 軸の名前など、`tx` の文字（書式つきの文字か、セルの参照の保存された値）。 */
function richTextOrCache(el: Element | null): string | undefined {
	const tx = xmlChild(el, 'tx');
	return richText(tx) || cachedValues(xmlChild(tx, 'strRef') ? tx : null).strings.join(' ') || undefined;
}

const AXIS_KINDS: Record<string, IParadisChartAxis['kind'] | undefined> = { catAx: 'category', valAx: 'value', dateAx: 'date', serAx: 'series' };

/** 軸を読む（`catAx`・`valAx`・`dateAx`・`serAx`）。 */
function parseAxis(el: Element): IParadisChartAxis | undefined {
	const kind = AXIS_KINDS[el.localName];
	const id = valAttr(xmlChild(el, 'axId'));
	if (!kind || !id) {
		return undefined;
	}
	const scaling = xmlChild(el, 'scaling');
	const position = valAttr(xmlChild(el, 'axPos'));
	const numFmt = xmlChild(el, 'numFmt');
	const logBase = numberVal(xmlChild(scaling, 'logBase'));
	const min = numberVal(xmlChild(scaling, 'min'));
	const max = numberVal(xmlChild(scaling, 'max'));
	const majorUnit = numberVal(xmlChild(el, 'majorUnit'));
	const crossesAt = numberVal(xmlChild(el, 'crossesAt'));
	const crosses = valAttr(xmlChild(el, 'crosses'));
	const title = richTextOrCache(xmlChild(el, 'title'));
	const formatCode = formatCodeOf(numFmt);
	return {
		id,
		kind,
		position: position === 'l' || position === 'r' || position === 't' || position === 'b' ? position : kind === 'value' ? 'l' : 'b',
		deleted: boolVal(xmlChild(el, 'delete'), false),
		...(min !== undefined ? { min } : {}),
		...(max !== undefined ? { max } : {}),
		// 2〜1000 だけを対数の底として受け付ける（ECMA の範囲）。
		...(logBase !== undefined && logBase >= 2 && logBase <= 1000 ? { logBase } : {}),
		reversed: valAttr(xmlChild(scaling, 'orientation')) === 'maxMin',
		...(majorUnit !== undefined && majorUnit > 0 ? { majorUnit } : {}),
		...(formatCode ? { formatCode } : {}),
		sourceLinked: numFmt ? xmlAttr(numFmt, 'sourceLinked') === '1' : true,
		...(title ? { title } : {}),
		gridlines: !!xmlChild(el, 'majorGridlines'),
		tickLabels: valAttr(xmlChild(el, 'tickLblPos')) !== 'none',
		crosses: crossesAt !== undefined ? crossesAt : crosses === 'min' || crosses === 'max' ? crosses : 'autoZero',
	};
}

function cachedFormatCode(ref: Element | null): string | undefined {
	const code = xmlChild(xmlChild(xmlChild(ref, 'numRef'), 'numCache'), 'formatCode')?.textContent ?? xmlChild(xmlChild(ref, 'numLit'), 'formatCode')?.textContent;
	return code && code !== 'General' && code.length <= 256 ? code : undefined;
}

function cachedValues(ref: Element | null): { strings: string[]; numbers: (number | null)[] } {
	const cache = xmlChild(xmlChild(ref, 'numRef'), 'numCache') ?? xmlChild(xmlChild(ref, 'strRef'), 'strCache') ?? xmlChild(ref, 'numLit') ?? xmlChild(ref, 'strLit')
		?? xmlChild(xmlChild(ref, 'multiLvlStrRef'), 'multiLvlStrCache');
	const count = Math.min(10_000, intAttr(xmlChild(cache, 'ptCount'), 'val', 0));
	const strings: string[] = new Array(count).fill('');
	const numbers: (number | null)[] = new Array(count).fill(null);
	const points = cache?.localName === 'multiLvlStrCache' ? xmlChildren(xmlChild(cache, 'lvl'), 'pt') : xmlChildren(cache, 'pt');
	for (const point of points) {
		const index = intAttr(point, 'idx', -1);
		if (index < 0 || index >= 10_000) {
			continue;
		}
		const value = xmlChild(point, 'v')?.textContent ?? '';
		while (strings.length <= index) { strings.push(''); numbers.push(null); }
		strings[index] = value;
		const number = Number(value);
		numbers[index] = value.trim() !== '' && Number.isFinite(number) ? number : null;
	}
	return { strings, numbers };
}

function richText(el: Element | null): string {
	const parts: string[] = [];
	// eslint-disable-next-line no-restricted-syntax -- DOMParser で生成した分離ドキュメントの走査(ライブDOMではない)
	for (const t of el ? Array.from(el.getElementsByTagNameNS('*', 't')) : []) {
		parts.push(t.textContent ?? '');
	}
	return parts.join('');
}

/**
 * 解析済みの chartN.xml からグラフを組み立てる。描けない種類が混ざれば undefined、系列や点が上限を
 * 越えれば `overLimit`。
 */
export function parseParadisChartDocument(doc: Document, colors: IParadisChartColors, limits: IParadisChartLimits): IParadisChartData | 'overLimit' | undefined {
	const chartEl = xmlChild(doc.documentElement, 'chart');
	const plotArea = xmlChild(chartEl, 'plotArea');
	if (!chartEl || !plotArea) {
		return undefined;
	}
	const groups: IParadisChartGroup[] = [];
	const axes: IParadisChartAxis[] = [];
	let seriesCount = 0;
	let pointCount = 0;
	for (const group of xmlChildren(plotArea)) {
		const axis = AXIS_KINDS[group.localName] ? parseAxis(group) : undefined;
		if (axis) {
			axes.push(axis);
			continue;
		}
		if (!group.localName.endsWith('Chart')) {
			continue;
		}
		const barDirection = xmlAttr(xmlChild(group, 'barDir') ?? group, 'val');
		const kind = group.localName === 'barChart' || group.localName === 'bar3DChart' ? (barDirection === 'bar' ? 'bar' : 'column') : CHART_KINDS[group.localName];
		if (!kind) {
			return undefined;
		}
		const groupingValue = xmlAttr(xmlChild(group, 'grouping') ?? group, 'val');
		const grouping = groupingValue === 'stacked' || groupingValue === 'percentStacked' || groupingValue === 'clustered' ? groupingValue : 'standard';
		const groupLabels = parseDataLabels(xmlChild(group, 'dLbls'));
		// 折れ線の群の `marker`（無ければ印なし）。系列の `marker/symbol` が none なら、その系列は印なし。
		const groupMarker = kind === 'line' ? boolVal(xmlChild(group, 'marker'), false) : kind === 'radar' ? valAttr(xmlChild(group, 'radarStyle')) === 'marker' : kind === 'scatter';
		const xy = kind === 'scatter' || kind === 'bubble';
		const series: IParadisChartSeries[] = [];
		for (const ser of xmlChildren(group, 'ser')) {
			if (++seriesCount > limits.chartSeries) {
				return 'overLimit';
			}
			const tx = xmlChild(ser, 'tx');
			const name = richText(tx) || cachedValues(tx).strings.join(' ') || xmlChild(tx, 'v')?.textContent || undefined;
			const categories = cachedValues(xmlChild(ser, xy ? 'xVal' : 'cat')).strings;
			const valueRef = xmlChild(ser, xy ? 'yVal' : 'val');
			const values = cachedValues(valueRef).numbers;
			const xValues = xy ? cachedValues(xmlChild(ser, 'xVal')).numbers : undefined;
			const bubbleSizes = kind === 'bubble' ? cachedValues(xmlChild(ser, 'bubbleSize')).numbers : undefined;
			pointCount += Math.max(values.length, categories.length) + (bubbleSizes?.length ?? 0);
			if (pointCount > limits.chartPoints) {
				return 'overLimit';
			}
			const seriesIndex = series.length;
			const color = colors.color(ser) ?? colors.palette(intAttr(xmlChild(ser, 'idx'), 'val', seriesIndex));
			let pointColors: string[] | undefined;
			if (kind === 'pie' || kind === 'doughnut') {
				const explicit = new Map<number, string>();
				for (const point of xmlChildren(ser, 'dPt')) {
					const pointColor = colors.color(point);
					if (pointColor) {
						explicit.set(intAttr(xmlChild(point, 'idx'), 'val', -1), pointColor);
					}
				}
				pointColors = values.map((_, index) => explicit.get(index) ?? colors.palette(index));
			}
			const symbol = valAttr(xmlChild(xmlChild(ser, 'marker'), 'symbol'));
			const marker = symbol === 'none' ? false : symbol !== undefined ? true : groupMarker;
			const dLbls = xmlChild(ser, 'dLbls');
			const dataLabels = dLbls ? parseDataLabels(dLbls) : groupLabels;
			const formatCode = cachedFormatCode(valueRef);
			series.push({
				...(name ? { name } : {}), categories, values, ...(xValues ? { xValues } : {}), ...(bubbleSizes ? { bubbleSizes } : {}),
				color, ...(pointColors ? { pointColors } : {}), ...(formatCode ? { formatCode } : {}), ...(dataLabels ? { dataLabels } : {}),
				...(kind === 'line' || kind === 'radar' || kind === 'scatter' ? { marker } : {}),
			});
		}
		const axisIds = xmlChildren(group, 'axId').map(axisId => xmlAttr(axisId, 'val')).filter(Boolean);
		groups.push({
			kind, grouping, series,
			...(axisIds.length ? { axisIds } : {}),
			...(groupLabels ? { dataLabels: groupLabels } : {}),
			...(kind === 'radar' ? { radarStyle: radarStyleOf(group) } : {}),
			...(kind === 'bubble' ? bubbleOptions(group) : {}),
			...(kind === 'stock' ? stockOptions(group, colors) : {}),
			...(kind === 'surface' ? surfaceOptions(group, colors) : {}),
		});
	}
	if (groups.length === 0) {
		return undefined;
	}
	const titleEl = xmlChild(chartEl, 'title');
	const title = titleEl ? richText(xmlChild(titleEl, 'tx')) : '';
	const autoDeleted = xmlAttr(xmlChild(chartEl, 'autoTitleDeleted') ?? chartEl, 'val') === '1';
	const singleSeriesTitle = !titleEl || autoDeleted ? undefined : title || (groups.length === 1 && groups[0].series.length === 1 ? groups[0].series[0].name : undefined);
	const legend = xmlChild(chartEl, 'legend');
	const legendPosition = valAttr(xmlChild(legend, 'legendPos'));
	return {
		...(singleSeriesTitle ? { title: singleSeriesTitle } : {}), groups, legend: !!legend,
		...(legendPosition === 'l' || legendPosition === 't' || legendPosition === 'b' || legendPosition === 'tr' || legendPosition === 'r' ? { legendPosition } : {}),
		...(axes.length ? { axes } : {}),
	};
}

function radarStyleOf(group: Element): 'standard' | 'marker' | 'filled' {
	const style = valAttr(xmlChild(group, 'radarStyle'));
	return style === 'marker' || style === 'filled' ? style : 'standard';
}

function bubbleOptions(group: Element): Pick<IParadisChartGroup, 'bubbleScale' | 'bubbleSizeRepresents'> {
	const scale = numberVal(xmlChild(group, 'bubbleScale'));
	return {
		// ECMA の範囲は 0〜300（%）。
		bubbleScale: scale !== undefined ? Math.max(0, Math.min(300, scale)) : 100,
		bubbleSizeRepresents: valAttr(xmlChild(group, 'sizeRepresents')) === 'w' ? 'w' : 'area',
	};
}

function stockOptions(group: Element, colors: IParadisChartColors): Pick<IParadisChartGroup, 'hiLowLines' | 'upDownBars'> {
	const upDown = xmlChild(group, 'upDownBars');
	return {
		hiLowLines: !!xmlChild(group, 'hiLowLines'),
		...(upDown ? { upDownBars: { up: colors.color(xmlChild(upDown, 'upBars')) ?? '#FFFFFF', down: colors.color(xmlChild(upDown, 'downBars')) ?? '#404040' } } : {}),
	};
}

function surfaceOptions(group: Element, colors: IParadisChartColors): Pick<IParadisChartGroup, 'bandColors' | 'surface3D'> {
	const explicit = new Map<number, string>();
	for (const band of xmlChildren(group, 'bandFmts').flatMap(bandFmts => xmlChildren(bandFmts, 'bandFmt'))) {
		const color = colors.color(band);
		if (color) {
			explicit.set(intAttr(xmlChild(band, 'idx'), 'val', -1), color);
		}
	}
	const bandColors: string[] = [];
	for (let index = 0; index < SURFACE_BAND_COLORS; index++) {
		bandColors.push(explicit.get(index) ?? colors.palette(index));
	}
	return { bandColors, ...(group.localName === 'surface3DChart' ? { surface3D: true } : {}) };
}

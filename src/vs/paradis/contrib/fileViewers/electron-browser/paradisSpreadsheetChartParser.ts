/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のグラフ（chartN.xml、ECMA-376 Part 1 §21.2 DrawingML - Charts）を読む。図形の読み込み
// （paradisSpreadsheetDrawings.ts）から分けた。色の解決（テーマ色・spPr）は図形と同じものを使うので、
// 呼び出し側から受け取る。

import type { IParadisChartData, IParadisChartGroup, IParadisChartSeries } from '../common/paradisSpreadsheet.js';

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
	doughnutChart: 'doughnut', scatterChart: 'scatter',
};

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
	let seriesCount = 0;
	let pointCount = 0;
	for (const group of xmlChildren(plotArea)) {
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
		const series: IParadisChartSeries[] = [];
		for (const ser of xmlChildren(group, 'ser')) {
			if (++seriesCount > limits.chartSeries) {
				return 'overLimit';
			}
			const tx = xmlChild(ser, 'tx');
			const name = richText(tx) || cachedValues(tx).strings.join(' ') || xmlChild(tx, 'v')?.textContent || undefined;
			const categories = cachedValues(xmlChild(ser, kind === 'scatter' ? 'xVal' : 'cat')).strings;
			const values = cachedValues(xmlChild(ser, kind === 'scatter' ? 'yVal' : 'val')).numbers;
			const xValues = kind === 'scatter' ? cachedValues(xmlChild(ser, 'xVal')).numbers : undefined;
			pointCount += Math.max(values.length, categories.length);
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
			series.push({ ...(name ? { name } : {}), categories, values, ...(xValues ? { xValues } : {}), color, ...(pointColors ? { pointColors } : {}) });
		}
		groups.push({ kind, grouping, series });
	}
	if (groups.length === 0) {
		return undefined;
	}
	const titleEl = xmlChild(chartEl, 'title');
	const title = titleEl ? richText(xmlChild(titleEl, 'tx')) : '';
	const autoDeleted = xmlAttr(xmlChild(chartEl, 'autoTitleDeleted') ?? chartEl, 'val') === '1';
	const singleSeriesTitle = !titleEl || autoDeleted ? undefined : title || (groups.length === 1 && groups[0].series.length === 1 ? groups[0].series[0].name : undefined);
	return { ...(singleSeriesTitle ? { title: singleSeriesTitle } : {}), groups, legend: !!xmlChild(chartEl, 'legend') };
}


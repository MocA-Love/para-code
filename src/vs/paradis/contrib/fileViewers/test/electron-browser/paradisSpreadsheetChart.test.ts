/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisChartData } from '../../common/paradisSpreadsheet.js';
import { parseChartXml } from '../../electron-browser/paradisSpreadsheetDrawings.js';
import { appendChartSvg } from '../../electron-browser/paradisSpreadsheetChartSvg.js';

// 架空の最小の chartN.xml。ECMA-376 Part 1 §21.2（DrawingML - Charts）の要素だけで組んでいる。実在のファイルは使っていない。
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function chartSpace(plotArea: string, extra = ''): string {
	return `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart>${extra.includes('<c:title>') ? '' : '<c:autoTitleDeleted val="1"/>'}${extra}<c:plotArea>${plotArea}</c:plotArea></c:chart></c:chartSpace>`;
}

function rich(text: string): string {
	return `<c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx>`;
}

function strCache(values: readonly string[]): string {
	return `<c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
}

function numCache(values: readonly number[], formatCode = 'General'): string {
	return `<c:numRef><c:f>Sheet1!$B$2</c:f><c:numCache><c:formatCode>${formatCode}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`;
}

function ser(index: number, name: string, inner: string): string {
	return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx>${strCache([name])}</c:tx>${inner}</c:ser>`;
}

function showValue(position?: string): string {
	return `<c:dLbls>${position ? `<c:dLblPos val="${position}"/>` : ''}<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
}

function catAx(id: number, cross: number, extra = ''): string {
	return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>${extra}</c:catAx>`;
}

function valAx(id: number, cross: number, scaling = '<c:orientation val="minMax"/>', extra = '', position = 'l'): string {
	return `<c:valAx><c:axId val="${id}"/><c:scaling>${scaling}</c:scaling><c:delete val="0"/><c:axPos val="${position}"/><c:majorGridlines/>${extra}<c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/></c:valAx>`;
}

const MONTHS = ['4月', '5月', '6月'];

/** 複合グラフ: 売上の棒（第 1 軸）と、利益率の折れ線（第 2 軸、右）。両方にデータラベル、凡例は下。 */
const COMBO = chartSpace(
	`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser(0, '売上', `${showValue()}<c:cat>${strCache(MONTHS)}</c:cat><c:val>${numCache([120, 150, 90])}</c:val>`)}<c:axId val="100"/><c:axId val="200"/></c:barChart>`
	+ `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser(1, '利益率', `<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${showValue('t')}<c:cat>${strCache(MONTHS)}</c:cat><c:val>${numCache([0.12, 0.18, 0.09], '0%')}</c:val>`)}<c:marker val="1"/><c:axId val="300"/><c:axId val="400"/></c:lineChart>`
	+ catAx(100, 200)
	+ valAx(200, 100, '<c:orientation val="minMax"/><c:max val="150"/><c:min val="0"/>', `<c:title>${rich('売上（万円）')}</c:title><c:numFmt formatCode="&quot;¥&quot;#,##0" sourceLinked="0"/><c:majorUnit val="50"/>`)
	+ `<c:catAx><c:axId val="300"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="400"/><c:crosses val="autoZero"/></c:catAx>`
	+ `<c:valAx><c:axId val="400"/><c:scaling><c:orientation val="minMax"/><c:max val="0.2"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="r"/><c:numFmt formatCode="0%" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="300"/><c:crosses val="max"/><c:majorUnit val="0.1"/></c:valAx>`,
	`<c:title>${rich('月別の売上')}</c:title><c:autoTitleDeleted val="0"/>`,
).replace('</c:plotArea>', '</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>');

const RADAR = chartSpace(
	`<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${ser(0, '評価', `<c:cat>${strCache(['品質', '価格', '納期', '対応', '提案'])}</c:cat><c:val>${numCache([4, 3, 5, 2, 4])}</c:val>`)}<c:axId val="10"/><c:axId val="20"/></c:radarChart>${catAx(10, 20)}${valAx(20, 10)}`,
);

const BUBBLE = chartSpace(
	`<c:bubbleChart><c:varyColors val="0"/>${ser(0, '地域', `<c:xVal>${numCache([1, 2, 3])}</c:xVal><c:yVal>${numCache([3, 5, 2])}</c:yVal><c:bubbleSize>${numCache([10, 40, 5])}</c:bubbleSize><c:bubble3D val="0"/>`)}<c:bubbleScale val="100"/><c:showNegBubbles val="0"/><c:axId val="1"/><c:axId val="2"/></c:bubbleChart>${valAx(1, 2, '<c:orientation val="minMax"/>', '', 'b')}${valAx(2, 1)}`,
);

const STOCK_DAYS = ['10/1', '10/2', '10/3', '10/4'];
const STOCK = chartSpace(
	`<c:stockChart>${ser(0, '始値', `<c:cat>${strCache(STOCK_DAYS)}</c:cat><c:val>${numCache([100, 120, 110, 130])}</c:val>`)}${ser(1, '高値', `<c:cat>${strCache(STOCK_DAYS)}</c:cat><c:val>${numCache([140, 125, 150, 135])}</c:val>`)}`
	+ `${ser(2, '安値', `<c:cat>${strCache(STOCK_DAYS)}</c:cat><c:val>${numCache([90, 100, 105, 110])}</c:val>`)}${ser(3, '終値', `<c:cat>${strCache(STOCK_DAYS)}</c:cat><c:val>${numCache([120, 105, 140, 115])}</c:val>`)}`
	+ `<c:hiLowLines/><c:upDownBars><c:gapWidth val="150"/><c:upBars><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></c:spPr></c:upBars><c:downBars><c:spPr><a:solidFill><a:srgbClr val="404040"/></a:solidFill></c:spPr></c:downBars></c:upDownBars><c:axId val="5"/><c:axId val="6"/></c:stockChart>${catAx(5, 6)}${valAx(6, 5)}`,
);

const SURFACE = chartSpace(
	`<c:surfaceChart><c:wireframe val="0"/>${[[5, 8, 12, 18], [9, 14, 21, 26], [12, 19, 25, 29]].map((row, index) => ser(index, `行${index + 1}`, `<c:cat>${strCache(['A', 'B', 'C', 'D'])}</c:cat><c:val>${numCache(row)}</c:val>`)).join('')}<c:axId val="7"/><c:axId val="8"/><c:axId val="9"/></c:surfaceChart>`
	+ catAx(7, 8) + valAx(8, 7, '<c:orientation val="minMax"/><c:max val="30"/><c:min val="0"/>', '<c:majorUnit val="10"/>')
	+ `<c:serAx><c:axId val="9"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="8"/><c:crosses val="autoZero"/></c:serAx>`,
).replace('</c:plotArea>', '</c:plotArea><c:legend><c:legendPos val="r"/></c:legend>');

function parse(xml: string, limits?: { chartSeries: number; chartPoints: number }): IParadisChartData {
	const chart = parseChartXml(xml, { parser: new DOMParser(), themeColors: undefined }, limits);
	ok(chart && chart !== 'overLimit', 'chart should parse');
	return chart;
}

function render(chart: IParadisChartData, width = 320, height = 250): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	appendChartSvg(svg, chart, { x: 0, y: 0, width, height });
	return svg;
}

function texts(svg: Element): string[] {
	return Array.from(svg.querySelectorAll('text')).map(text => text.textContent ?? '');
}

function textPosition(svg: Element, value: string): { x: number; y: number } {
	const text = Array.from(svg.querySelectorAll('text')).find(candidate => candidate.textContent === value);
	ok(text, `text ${value}`);
	return { x: Number(text.getAttribute('x')), y: Number(text.getAttribute('y')) };
}

suite('ParadisSpreadsheetChart', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads data labels, both value axes, axis formats and the legend position', () => {
		const chart = parse(COMBO);
		deepStrictEqual({
			legendPosition: chart.legendPosition,
			axisIds: chart.groups.map(group => group.axisIds),
			labels: chart.groups.map(group => group.series[0].dataLabels),
			formats: chart.groups.map(group => group.series[0].formatCode),
			marker: chart.groups[1].series[0].marker,
			axes: chart.axes?.map(axis => [axis.id, axis.kind, axis.position, axis.deleted, axis.min, axis.max, axis.majorUnit, axis.formatCode, axis.title, axis.crosses]),
		}, {
			legendPosition: 'b',
			axisIds: [['100', '200'], ['300', '400']],
			labels: [{ value: true, category: false, series: false, percent: false }, { value: true, category: false, series: false, percent: false, position: 't' }],
			formats: [undefined, '0%'],
			marker: true,
			axes: [
				['100', 'category', 'b', false, undefined, undefined, undefined, undefined, undefined, 'autoZero'],
				['200', 'value', 'l', false, 0, 150, 50, '"¥"#,##0', '売上（万円）', 'autoZero'],
				['300', 'category', 'b', true, undefined, undefined, undefined, undefined, undefined, 'autoZero'],
				['400', 'value', 'r', false, 0, 0.2, 0.1, '0%', undefined, 'max'],
			],
		});
	});

	test('draws the line of a combo chart on its own secondary axis instead of flat on zero', () => {
		const svg = render(parse(COMBO));
		const all = texts(svg);
		const line = Array.from(svg.querySelectorAll('path')).find(path => path.getAttribute('stroke') === '#ED7D31' && path.getAttribute('fill') === 'none');
		ok(line);
		const ys = (line.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)!.map(Number).filter((_, index) => index % 2 === 1);
		const zeroPercent = textPosition(svg, '0%').y - 3;
		const twentyPercent = textPosition(svg, '20%').y - 3;
		// 12% → 18% → 9%: 第 2 軸の 0%〜20% の中に、値どおりの高さで並ぶ。
		const expected = [0.12, 0.18, 0.09].map(value => zeroPercent + (twentyPercent - zeroPercent) * value / 0.2);
		deepStrictEqual({
			leftTicks: ['¥0', '¥50', '¥100', '¥150'].every(label => all.includes(label)),
			rightTicks: ['0%', '10%', '20%'].every(label => all.includes(label)),
			axisTitle: all.includes('売上（万円）'),
			labels: ['120', '150', '90', '12%', '18%', '9%'].every(label => all.includes(label)),
			lineMatchesSecondaryAxis: ys.every((y, index) => Math.abs(y - expected[index]) < 1),
			markers: svg.querySelectorAll('circle[fill="#ED7D31"]').length,
			legendBelow: textPosition(svg, '売上').y > textPosition(svg, '4月').y,
		}, { leftTicks: true, rightTicks: true, axisTitle: true, labels: true, lineMatchesSecondaryAxis: true, markers: 3, legendBelow: true });
	});

	test('applies the axis minimum, maximum, unit, reversal and logarithmic scale', () => {
		const column = (scaling: string, extra = '', categoryReversed = false) => chartSpace(
			`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser(0, 'A', `<c:cat>${strCache(['a', 'b', 'c'])}</c:cat><c:val>${numCache([2, 30, 700])}</c:val>`)}<c:axId val="1"/><c:axId val="2"/></c:barChart>`
			+ (categoryReversed ? catAx(1, 2).replace('<c:orientation val="minMax"/>', '<c:orientation val="maxMin"/>') : catAx(1, 2)) + valAx(2, 1, scaling, extra));
		const log = render(parse(column('<c:logBase val="10"/><c:orientation val="minMax"/><c:min val="1"/><c:max val="1000"/>')));
		const reversed = render(parse(column('<c:orientation val="maxMin"/><c:max val="800"/><c:min val="0"/>', '<c:majorUnit val="200"/>')));
		const categories = render(parse(column('<c:orientation val="minMax"/>', '', true)));
		deepStrictEqual({
			logTicks: ['1', '10', '100', '1,000'].map(label => texts(log).includes(label)),
			// 対数の目盛りは等間隔に並ぶ。
			logEven: Math.round(textPosition(log, '1').y - textPosition(log, '10').y) === Math.round(textPosition(log, '10').y - textPosition(log, '100').y),
			reversedTicks: ['0', '200', '400', '600', '800'].every(label => texts(reversed).includes(label)),
			reversedZeroOnTop: textPosition(reversed, '0').y < textPosition(reversed, '800').y,
			categoriesReversed: textPosition(categories, 'a').x > textPosition(categories, 'c').x,
		}, { logTicks: [true, true, true, true], logEven: true, reversedTicks: true, reversedZeroOnTop: true, categoriesReversed: true });
	});

	test('places the legend where legendPos says', () => {
		const base = parse(COMBO);
		const legendSquare = (position: IParadisChartData['legendPosition']) => {
			const svg = render({ ...base, legendPosition: position });
			const text = Array.from(svg.querySelectorAll('text')).find(candidate => candidate.textContent === '売上' && candidate.getAttribute('font-size') === '9');
			return { x: Number(text?.getAttribute('x')), y: Number(text?.getAttribute('y')) };
		};
		const right = legendSquare('r'), left = legendSquare('l'), top = legendSquare('t'), bottom = legendSquare('b'), topRight = legendSquare('tr');
		deepStrictEqual({
			rightIsRight: right.x > 200, leftIsLeft: left.x < 60, topIsTop: top.y < 60, bottomIsBottom: bottom.y > 200,
			topRightAboveRight: topRight.y < right.y && topRight.x > 200,
		}, { rightIsRight: true, leftIsLeft: true, topIsTop: true, bottomIsBottom: true, topRightAboveRight: true });
	});

	test('draws radar, bubble, stock and contour charts instead of leaving them out', () => {
		const radar = render(parse(RADAR));
		const bubbleChart = parse(BUBBLE);
		const bubble = render(bubbleChart);
		const stock = render(parse(STOCK));
		const surfaceChart = parse(SURFACE);
		const surface = render(surfaceChart);
		const bubbleRadii = Array.from(bubble.querySelectorAll('circle')).map(circle => Number(circle.getAttribute('r')));
		const surfaceFills = new Set(Array.from(surface.querySelectorAll('rect')).map(rect => rect.getAttribute('fill')));
		const bands = surfaceChart.groups[0].bandColors!.slice(0, 3);
		deepStrictEqual({
			radarPolygon: Array.from(radar.querySelectorAll('path')).some(path => path.getAttribute('stroke') === '#4472C4' && (path.getAttribute('d') ?? '').endsWith('Z')),
			radarMarkers: radar.querySelectorAll('circle[fill="#4472C4"]').length,
			radarCategories: ['品質', '価格', '納期', '対応', '提案'].every(label => texts(radar).includes(label)),
			bubbleCount: bubbleRadii.length,
			// 大きさは面積に比例する（半径は平方根）。10 は 40 の半分の半径。
			bubbleArea: Math.abs(bubbleRadii[0] / bubbleRadii[1] - 0.5) < 0.02,
			stockWicks: Array.from(stock.querySelectorAll('path')).filter(path => /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/.test(path.getAttribute('d') ?? '') && path.getAttribute('stroke') === '#404040').length >= 4,
			stockBoxes: [stock.querySelectorAll('rect[fill="#FFFFFF"][stroke="#404040"]').length, stock.querySelectorAll('rect[fill="#404040"]').length],
			surfaceBands: [...surfaceFills].filter(fill => bands.includes(fill ?? '')).length,
			surfaceLegend: ['0-10', '10-20', '20-30'].every(label => texts(surface).includes(label)),
			surface3D: parse(SURFACE.replace(/surfaceChart>/g, 'surface3DChart>')).groups[0].surface3D,
		}, {
			radarPolygon: true, radarMarkers: 5, radarCategories: true, bubbleCount: 3, bubbleArea: true, stockWicks: true,
			stockBoxes: [2, 2], surfaceBands: 3, surfaceLegend: true, surface3D: true,
		});
	});

	test('keeps the series and point limits, counting bubble sizes as points', () => {
		const limits = { chartSeries: 255, chartPoints: 5 };
		deepStrictEqual([
			parseChartXml(BUBBLE, { parser: new DOMParser(), themeColors: undefined }, limits),
			typeof parseChartXml(BUBBLE, { parser: new DOMParser(), themeColors: undefined }, { chartSeries: 255, chartPoints: 6 }),
			parseChartXml(STOCK, { parser: new DOMParser(), themeColors: undefined }, { chartSeries: 3, chartPoints: 100_000 }),
		], ['overLimit', 'object', 'overLimit']);
	});

	test('puts document text into text nodes only', () => {
		const svg = render(parse(COMBO.replace('売上</c:v>', '&lt;img src=x onerror=alert(1)&gt;</c:v>').replace('<c:v>4月</c:v>', '<c:v>&lt;script&gt;x&lt;/script&gt;</c:v>')));
		deepStrictEqual({
			elements: svg.querySelectorAll('img, script, foreignObject').length,
			asText: texts(svg).includes('<script>x</script>') && texts(svg).includes('<img src=x onerror=alert(1)>'),
		}, { elements: 0, asText: true });
	});
});

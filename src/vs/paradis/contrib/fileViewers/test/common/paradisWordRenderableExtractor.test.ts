/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractParadisWordRenderableObjects } from '../../common/word/paradisWordRenderableExtractor.js';
import type {
	ParadisWordChartObject,
	ParadisWordRenderableObject,
	ParadisWordSmartArtObject,
	ParadisWordTextboxObject,
} from '../../common/word/paradisWordRenderableObjects.js';

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wp = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const c = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const dgm = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const wps = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const o = 'urn:schemas-microsoft-com:office:office';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';

const uris = {
	document: '/word/document.xml',
	documentRels: '/word/_rels/document.xml.rels',
	chart: '/word/charts/chart1.xml',
	diagramData: '/word/diagrams/data1.xml',
	header: '/word/header1.xml',
	headerRels: '/word/_rels/header1.xml.rels',
} as const;

/** wp:inline の枠。中身の a:graphicData を差し替えて種類を切り替える。 */
function inlineDrawing(docPrId: string, graphicData: string, descr?: string): string {
	return `<w:drawing xmlns:w="${w}" xmlns:wp="${wp}" xmlns:a="${a}">
		<wp:inline distT="0" distB="0" distL="0" distR="0">
			<wp:extent cx="2743200" cy="1828800"/>
			<wp:docPr id="${docPrId}" name="Object ${docPrId}"${descr === undefined ? '' : ` descr="${descr}"`}/>
			<a:graphic><a:graphicData uri="${graphicDataUriOf(graphicData)}">${graphicData}</a:graphicData></a:graphic>
		</wp:inline>
	</w:drawing>`;
}

function graphicDataUriOf(graphicData: string): string {
	if (graphicData.includes('<c:chart')) { return `${a.slice(0, a.lastIndexOf('/'))}/chart`; }
	if (graphicData.includes('<dgm:relIds')) { return `${a.slice(0, a.lastIndexOf('/'))}/diagram`; }
	if (graphicData.includes('<pic:pic')) { return `${a.slice(0, a.lastIndexOf('/'))}/picture`; }
	return 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
}

function documentXml(body: string): string {
	return `<w:document xmlns:w="${w}" xmlns:wp="${wp}" xmlns:a="${a}" xmlns:r="${r}"><w:body><w:p><w:r>${body}</w:r></w:p></w:body></w:document>`;
}

function relationships(entries: readonly { readonly id: string; readonly type: string; readonly target: string }[]): string {
	return `<Relationships xmlns="${pkg}">${entries.map(entry => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"/>`).join('')}</Relationships>`;
}

function chartRel(id = 'rIdChart'): string {
	return relationships([{ id, type: `${r}/chart`, target: 'charts/chart1.xml' }]);
}

/** c:barChart などの本体。points は idx→値。 */
function chartXml(options: {
	readonly group?: string;
	readonly barDirection?: string;
	readonly title?: string;
	readonly series: readonly { readonly name?: string; readonly points: readonly (readonly [string, string])[] }[];
}): string {
	const group = options.group ?? 'barChart';
	const direction = options.barDirection === undefined ? '' : `<c:barDir val="${options.barDirection}"/>`;
	const title = options.title === undefined
		? ''
		: `<c:title><c:tx><c:rich><a:p><a:r><a:t>${options.title}</a:t></a:r></a:p></c:rich></c:tx></c:title>`;
	const series = options.series.map((entry, index) => `<c:ser>
		<c:idx val="${index}"/>
		${entry.name === undefined ? '' : `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>${entry.name}</c:v></c:pt></c:strCache></c:strRef></c:tx>`}
		<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache>${entry.points.map(([idx, value]) => `<c:pt idx="${idx}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>
	</c:ser>`).join('');
	return `<c:chartSpace xmlns:c="${c}" xmlns:a="${a}"><c:chart>${title}<c:plotArea><c:${group}>${direction}${series}</c:${group}></c:plotArea></c:chart></c:chartSpace>`;
}

function diagramDataXml(points: readonly { readonly id: string; readonly label: string; readonly type?: string }[], connections: readonly { readonly src: string; readonly dest: string; readonly type?: string }[]): string {
	return `<dgm:dataModel xmlns:dgm="${dgm}" xmlns:a="${a}">
		<dgm:ptLst>${points.map(point => `<dgm:pt modelId="${point.id}"${point.type === undefined ? '' : ` type="${point.type}"`}><dgm:t><a:p><a:r><a:t>${point.label}</a:t></a:r></a:p></dgm:t></dgm:pt>`).join('')}</dgm:ptLst>
		<dgm:cxnLst>${connections.map(connection => `<dgm:cxn modelId="cxn-${connection.src}-${connection.dest}" type="${connection.type ?? 'parOf'}" srcId="${connection.src}" destId="${connection.dest}"/>`).join('')}</dgm:cxnLst>
	</dgm:dataModel>`;
}

function extract(parts: Readonly<Record<string, string>>): readonly ParadisWordRenderableObject[] {
	return extractParadisWordRenderableObjects({ parts: new Map(Object.entries(parts)) });
}

function only<T extends ParadisWordRenderableObject['kind']>(objects: readonly ParadisWordRenderableObject[], kind: T): Extract<ParadisWordRenderableObject, { kind: T }> {
	strictEqual(objects.length, 1, `expected exactly one object, got ${objects.map(object => object.kind).join(',')}`);
	strictEqual(objects[0].kind, kind);
	return objects[0] as Extract<ParadisWordRenderableObject, { kind: T }>;
}

suite('paradisWordRenderableExtractor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts a column chart with title, series names and dense values', () => {
		const objects = extract({
			[uris.document]: documentXml(inlineDrawing('1', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`)),
			[uris.documentRels]: chartRel(),
			[uris.chart]: chartXml({
				barDirection: 'col',
				title: '売上',
				series: [
					{ name: '2024', points: [['0', '10'], ['1', '20'], ['2', '30']] },
					{ name: '2025', points: [['0', '4'], ['1', '5']] },
				],
			}),
		});
		const chart = only(objects, 'chart') as ParadisWordChartObject;
		deepStrictEqual({ chartType: chart.chartType, title: chart.title, series: chart.series }, {
			chartType: 'column',
			title: '売上',
			series: [
				{ name: '2024', values: [{ index: 0, value: '10' }, { index: 1, value: '20' }, { index: 2, value: '30' }] },
				{ name: '2025', values: [{ index: 0, value: '4' }, { index: 1, value: '5' }] },
			],
		});
		strictEqual(chart.geometry.placement, 'inline');
		deepStrictEqual(chart.geometry.extent, { cx: '2743200', cy: '1828800' });
	});

	test('maps c:barDir val="bar" to bar and defaults a missing barDir to column', () => {
		const of = (barDirection?: string) => (only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`)),
			[uris.documentRels]: chartRel(),
			[uris.chart]: chartXml({ barDirection, series: [{ points: [['0', '1']] }] }),
		}), 'chart') as ParadisWordChartObject).chartType;
		deepStrictEqual([of('bar'), of('col'), of(undefined)], ['bar', 'column', 'column']);
	});

	test('keeps other chart kinds under their OOXML name and omits an absent series name', () => {
		const chart = only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`)),
			[uris.documentRels]: chartRel(),
			[uris.chart]: chartXml({ group: 'lineChart', series: [{ points: [['0', '7']] }] }),
		}), 'chart') as ParadisWordChartObject;
		deepStrictEqual({ chartType: chart.chartType, series: chart.series }, { chartType: 'line', series: [{ values: [{ index: 0, value: '7' }] }] });
	});

	test('keeps sparse c:pt indices verbatim and drops points without a usable idx', () => {
		// 抽出側は idx を詰め直さない。歯抜けのまま渡し、描画側(chartValues)が諦める形にする。
		const chart = only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`)),
			[uris.documentRels]: chartRel(),
			[uris.chart]: chartXml({ barDirection: 'col', series: [{ points: [['0', '10'], ['3', '30'], ['x', '40'], ['', '50']] }] }),
		}), 'chart') as ParadisWordChartObject;
		deepStrictEqual(chart.series, [{ values: [{ index: 0, value: '10' }, { index: 3, value: '30' }] }]);
	});

	test('extracts SmartArt nodes, parent links and a hierarchy layout', () => {
		const smartArt = only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<dgm:relIds xmlns:dgm="${dgm}" xmlns:r="${r}" r:dm="rIdData" r:lo="rIdLayout"/>`)),
			[uris.documentRels]: relationships([{ id: 'rIdData', type: `${r}/diagramData`, target: 'diagrams/data1.xml' }]),
			[uris.diagramData]: diagramDataXml(
				[
					{ id: 'root', label: '親', type: 'node' },
					{ id: 'child', label: '子' },
					{ id: 'doc', label: '無視', type: 'doc' },
				],
				[{ src: 'root', dest: 'child' }, { src: 'root', dest: 'missing' }],
			),
		}), 'smartArt') as ParadisWordSmartArtObject;
		deepStrictEqual({ layout: smartArt.layout, nodes: smartArt.nodes }, {
			layout: 'hierarchy',
			nodes: [{ id: 'root', label: '親' }, { id: 'child', label: '子', parentId: 'root' }],
		});
	});

	test('falls back to a flow layout when no parOf connection links two nodes', () => {
		const smartArt = only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<dgm:relIds xmlns:dgm="${dgm}" xmlns:r="${r}" r:dm="rIdData"/>`)),
			[uris.documentRels]: relationships([{ id: 'rIdData', type: `${r}/diagramData`, target: 'diagrams/data1.xml' }]),
			[uris.diagramData]: diagramDataXml(
				[{ id: 'one', label: 'A' }, { id: 'two', label: 'B' }],
				[{ src: 'one', dest: 'two', type: 'presOf' }],
			),
		}), 'smartArt') as ParadisWordSmartArtObject;
		deepStrictEqual({ layout: smartArt.layout, nodes: smartArt.nodes }, { layout: 'flow', nodes: [{ id: 'one', label: 'A' }, { id: 'two', label: 'B' }] });
	});

	test('extracts textbox runs from wps:txbx', () => {
		const textbox = only(extract({
			[uris.document]: documentXml(inlineDrawing('1', `<wps:wsp xmlns:wps="${wps}" xmlns:w="${w}"><wps:txbx><w:txbxContent><w:p><w:r><w:t>こんにちは</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>`)),
		}), 'textbox') as ParadisWordTextboxObject;
		deepStrictEqual(textbox.runs, [{ text: 'こんにちは' }, { text: ' world' }]);
	});

	test('treats a wordprocessingShape without a textbox as a plain shape', () => {
		const objects = extract({
			[uris.document]: documentXml(inlineDrawing('1', `<wps:wsp xmlns:wps="${wps}" xmlns:a="${a}"><wps:spPr><a:prstGeom prst="rect"/></wps:spPr></wps:wsp>`)),
		});
		strictEqual(only(objects, 'shape').geometry.presetGeometry, 'rect');
	});

	test('ignores pictures that docx-preview already draws as an img', () => {
		// 画像は docx-preview が <img> にするので、こちらで重ねると二重になる。
		deepStrictEqual(extract({
			[uris.document]: documentXml(inlineDrawing('7', `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"/>`, 'ロゴ')),
		}), []);
	});

	test('extracts an embedded OLE object', () => {
		const objects = extract({
			[uris.document]: documentXml(`<w:object xmlns:w="${w}" xmlns:o="${o}" xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="_x0000_i1025"/><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025" DrawAspect="Content"/></w:object>`),
		});
		strictEqual(only(objects, 'ole').id, '/word/document.xml#0:_x0000_i1025');
	});

	test('ignores VML w:pict content that docx-preview already draws', () => {
		deepStrictEqual(extract({
			[uris.document]: documentXml(`<w:pict xmlns:w="${w}" xmlns:v="urn:schemas-microsoft-com:vml"><v:rect style="width:10pt;height:10pt"/></w:pict>`),
		}), []);
	});

	test('also scans header parts reached through the document relationships', () => {
		const objects = extract({
			[uris.document]: documentXml(`<w:object xmlns:w="${w}" xmlns:o="${o}"><o:OLEObject ShapeID="body"/></w:object>`),
			[uris.documentRels]: relationships([{ id: 'rIdHeader', type: `${r}/header`, target: 'header1.xml' }]),
			[uris.header]: `<w:hdr xmlns:w="${w}" xmlns:wp="${wp}" xmlns:a="${a}"><w:p><w:r>${inlineDrawing('9', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`)}</w:r></w:p></w:hdr>`,
			[uris.headerRels]: chartRel(),
			[uris.chart]: chartXml({ barDirection: 'col', series: [{ points: [['0', '1']] }] }),
		});
		deepStrictEqual(objects.map(object => [object.kind, object.id]), [['ole', '/word/document.xml#0:body'], ['chart', '/word/header1.xml#0:9']]);
	});

	test('drops malformed parts and unresolvable relationships without throwing', () => {
		const body = documentXml([
			inlineDrawing('1', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdMissing"/>`),
			inlineDrawing('2', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdBroken"/>`),
			inlineDrawing('3', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`),
			inlineDrawing('4', `<dgm:relIds xmlns:dgm="${dgm}" xmlns:r="${r}" r:dm="rIdGone"/>`),
		].join(''));
		const objects = extract({
			[uris.document]: body,
			[uris.documentRels]: relationships([
				{ id: 'rIdBroken', type: `${r}/chart`, target: 'charts/broken.xml' },
				{ id: 'rIdChart', type: `${r}/chart`, target: 'charts/chart1.xml' },
			]),
			'/word/charts/broken.xml': '<c:chartSpace><not closed',
			[uris.chart]: chartXml({ barDirection: 'bar', series: [{ points: [['0', '2']] }] }),
		});
		// 解決できない r:id、壊れたパート、行方不明の SmartArt データはそれぞれ落ち、健全なものだけが残る。
		deepStrictEqual(objects.map(object => [object.kind, object.id]), [['chart', '/word/document.xml#2:3']]);
	});

	test('returns nothing instead of throwing when the story part itself is malformed', () => {
		deepStrictEqual(extract({ [uris.document]: '<w:document><w:body>' }), []);
	});

	test('produces stable ids for repeated extractions of the same document', () => {
		const parts = {
			[uris.document]: documentXml([
				inlineDrawing('11', `<wps:wsp xmlns:wps="${wps}"/>`),
				inlineDrawing('12', `<c:chart xmlns:c="${c}" xmlns:r="${r}" r:id="rIdChart"/>`),
			].join('')),
			[uris.documentRels]: chartRel(),
			[uris.chart]: chartXml({ barDirection: 'col', series: [{ points: [['0', '1']] }] }),
		};
		const first = extract(parts).map(object => object.id);
		deepStrictEqual(first, extract(parts).map(object => object.id));
		deepStrictEqual(first, ['/word/document.xml#0:11', '/word/document.xml#1:12']);
	});

	test('stops once the element budget is spent instead of running away', () => {
		const objects = extractParadisWordRenderableObjects({
			parts: new Map(Object.entries({
				[uris.document]: documentXml([inlineDrawing('1', `<wps:wsp xmlns:wps="${wps}"/>`), inlineDrawing('2', `<wps:wsp xmlns:wps="${wps}"/>`)].join('')),
			})),
			limits: { elements: 12 },
		});
		ok(objects.length < 2, `expected the budget to cut the scan short, got ${objects.length}`);
	});
});

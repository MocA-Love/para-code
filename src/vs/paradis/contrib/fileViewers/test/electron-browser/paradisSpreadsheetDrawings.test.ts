/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisRenderShape } from '../../common/paradisSpreadsheet.js';
import { parseDrawingObjects, spreadsheetUndrawnPlaceholders } from '../../electron-browser/paradisSpreadsheetDrawings.js';
import { appendChartSvg, appendShapeSvg, shapeGeometryPath } from '../../electron-browser/paradisSpreadsheetShapeSvg.js';

// Invented minimal drawings. None of them comes from a real file.
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

function drawing(anchors: string): string {
	return `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:c="${C}">${anchors}</xdr:wsDr>`;
}

function anchor(content: string, from = [0, 0], to = [4, 4]): string {
	return `<xdr:twoCellAnchor><xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${content}<xdr:clientData/></xdr:twoCellAnchor>`;
}

function sp(id: number, spPr: string, extra = '', hidden = false): string {
	return `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Shape ${id}"${hidden ? ' hidden="1"' : ''}/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${spPr}</xdr:spPr>${extra}</xdr:sp>`;
}

function xfrm(x: number, y: number, cx: number, cy: number): string {
	return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function shapeSummary(shape: IParadisRenderShape): Record<string, unknown> {
	return {
		type: shape.type, name: shape.name, geometry: shape.geometry, outlineWidth: shape.outlineWidth, outlineColor: shape.outlineColor,
		...(shape.fill ? { fill: shape.fill } : {}), ...(shape.frame ? { frame: shape.frame } : {}), ...(shape.text ? { text: shape.text.paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('|') } : {}),
	};
}

suite('ParadisSpreadsheetDrawings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads geometry, line and fill (with style references), text, and skips hidden shapes', () => {
		const style = '<xdr:style><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></xdr:style>';
		const { shapes, undrawn } = parseDrawingObjects([{
			xml: drawing([
				anchor(sp(2, '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>')),
				anchor(sp(3, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', style)),
				anchor(sp(4, '<a:prstGeom prst="leftBracket"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>')),
				anchor(sp(5, '<a:prstGeom prst="wave"><a:avLst/></a:prstGeom><a:noFill/>')),
				anchor(sp(6, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', '', true)),
				anchor(sp(7, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>', '<xdr:txBody><a:bodyPr vert="eaVert" anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1400" b="1"/><a:t>AB</a:t></a:r></a:p></xdr:txBody>')),
			].join('')),
			media: {},
		}], { dk1: '#111111', lt1: '#EEEEEE', accent1: '#2244AA' });
		deepStrictEqual({ shapes: shapes.map(shapeSummary), undrawn, vertical: shapes[4].text?.vertical }, {
			shapes: [
				{ type: 'rect', name: 'Shape 2', geometry: 'ellipse', outlineWidth: 12700 / 12700 * 96 / 72, outlineColor: '#FF0000' },
				{ type: 'rect', name: 'Shape 3', geometry: 'rect', outlineWidth: 1, outlineColor: '#111111', fill: '#2244AA' },
				{ type: 'rect', name: 'Shape 4', geometry: 'leftBracket', outlineWidth: 0, outlineColor: '#000000' },
				{ type: 'rect', name: 'Shape 5', geometry: 'rect', outlineWidth: 0, outlineColor: '#000000' },
				{ type: 'rect', name: 'Shape 7', geometry: 'rect', outlineWidth: 0, outlineColor: '#000000', text: 'AB' },
			],
			undrawn: [{ kind: 'geometry', name: 'Shape 5', from: { c: 0, co: 0, r: 0, ro: 0 } }],
			vertical: true,
		});
	});

	test('places shapes inside nested groups by their share of the anchor, and picks AlternateContent branches', () => {
		const group = `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="10" name="Group 10"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></xdr:grpSpPr>`
			+ sp(11, `${xfrm(0, 0, 500, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>`)
			+ `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="12" name="Group 12"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="500" y="500"/><a:ext cx="500" cy="500"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></xdr:grpSpPr>`
			+ sp(13, `${xfrm(50, 0, 50, 100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>`)
			+ '</xdr:grpSp></xdr:grpSp>';
		const alternate = `<mc:AlternateContent><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">${anchor(sp(20, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'))}</mc:Choice><mc:Fallback/></mc:AlternateContent>`
			+ `<mc:AlternateContent><mc:Choice xmlns:x="urn:example:unknown" Requires="x">${anchor(sp(21, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'))}</mc:Choice><mc:Fallback>${anchor(sp(22, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'))}</mc:Fallback></mc:AlternateContent>`;
		const { shapes } = parseDrawingObjects([{ xml: drawing(anchor(group) + alternate), media: {} }]);
		deepStrictEqual(shapes.map(shape => [shape.name, shape.frame]), [
			['Shape 11', { x: 0, y: 0, width: 0.5, height: 1 }],
			['Shape 13', { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }],
			['Shape 20', undefined],
			['Shape 22', undefined],
		]);
	});

	test('draws images it can show and charts it can read, and counts the rest as undrawn', () => {
		const pic = (id: number, rid: string) => `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid}"/></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
		const frame = (id: number, uri: string, inner: string) => `<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></xdr:graphicFrame>`;
		const chartUri = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
		const barChart = `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea><c:legend/></c:chart></c:chartSpace>`;
		const radarChart = `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:radarChart/></c:plotArea></c:chart></c:chartSpace>`;
		const { shapes, undrawn } = parseDrawingObjects([{
			xml: drawing([
				anchor(pic(30, 'rIdPng')),
				anchor(pic(31, 'rIdEmf')),
				anchor(frame(32, chartUri, `<c:chart r:id="rIdBar"/>`)),
				anchor(frame(33, chartUri, `<c:chart r:id="rIdRadar"/>`)),
				anchor(frame(34, 'http://schemas.openxmlformats.org/drawingml/2006/diagram', '')),
			].join('')),
			media: { rIdPng: 'data:image/png;base64,AA==' },
			charts: { rIdBar: barChart, rIdRadar: radarChart },
		}], { accent1: '#2244AA' });
		const placeholders = spreadsheetUndrawnPlaceholders([{ name: 'Sheet1', rows: [], columnCount: 0, columnWidths: [], truncated: false, minCol: 1, undrawnObjects: undrawn }]);
		deepStrictEqual({
			shapes: shapes.map(shape => [shape.type, shape.name]),
			chart: shapes[1].chart,
			undrawn: undrawn.map(object => [object.kind, object.name]),
			placeholders: placeholders.map(placeholder => placeholder.feature),
		}, {
			shapes: [['image', 'Picture 30'], ['chart', 'Chart 32']],
			chart: { title: 'Sales', legend: true, groups: [{ kind: 'column', grouping: 'clustered', series: [{ name: 'A', categories: ['Q1', 'Q2'], values: [3, 5], color: '#2244AA' }] }] },
			undrawn: [['image', 'Picture 31'], ['chart', 'Chart 33'], ['graphicFrame', 'Chart 34']],
			placeholders: ['drawing.image', 'drawing.chart', 'drawing.graphicFrame'],
		});
	});

	test('builds preset geometry paths in the frame and draws a chart', () => {
		const base: IParadisRenderShape = { type: 'rect', flipH: false, flipV: false, from: { c: 0, co: 0, r: 0, ro: 0 }, to: { c: 0, co: 0, r: 0, ro: 0 }, outlineWidth: 1, outlineColor: '#000000', dash: 'solid' };
		const box = { x: 0, y: 0, width: 100, height: 40 };
		deepStrictEqual(['leftBracket', 'rightBrace', 'triangle'].map(geometry => shapeGeometryPath({ ...base, geometry: geometry as IParadisRenderShape['geometry'] }, box).stroke), [
			'M 100 40 A 100 3.33 0 0 1 0 36.67 L 0 3.33 A 100 3.33 0 0 1 100 0',
			'M 0 0 A 50 3.33 0 0 1 50 3.33 L 50 16.67 A 50 3.33 0 0 0 100 20 A 50 3.33 0 0 0 50 23.33 L 50 36.67 A 50 3.33 0 0 1 0 40',
			'M 50 0 L 100 40 L 0 40 Z',
		]);
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		appendShapeSvg(svg, { ...base, geometry: 'ellipse', fill: '#FF0000' }, box, { stroke: '#000000', strokeWidth: 1, dash: '', opacity: 1, content: true });
		appendChartSvg(svg, { legend: false, groups: [{ kind: 'column', grouping: 'clustered', series: [{ categories: ['a', 'b'], values: [1, 2], color: '#2244AA' }] }] }, { x: 0, y: 0, width: 200, height: 120 });
		deepStrictEqual({
			filled: svg.querySelector('path[fill="#FF0000"]') !== null,
			bars: svg.querySelectorAll('rect[fill="#2244AA"]').length,
		}, { filled: true, bars: 2 });
	});
});

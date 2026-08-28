/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractParadisWordRenderableObjects } from '../../common/word/paradisWordRenderableExtractor.js';
import { buildParadisWordOverlayItems } from '../../electron-browser/word/paradisWordObjectOverlayHtml.js';

const CHART_EXTENT = { cx: 2857500, cy: 1905000 };
const TEXTBOX_EXTENT = { cx: 952500, cy: 476250 };

function inlineDrawing(uri: string, inner: string, cx: number, cy: number, id: number): string {
	return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
		+ `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="obj${id}"/>`
		+ `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic>`
		+ `</wp:inline></w:drawing></w:r></w:p>`;
}

const chartDrawing = inlineDrawing(
	'http://schemas.openxmlformats.org/drawingml/2006/chart',
	'<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rC1"/>',
	CHART_EXTENT.cx, CHART_EXTENT.cy, 1,
);

const textboxDrawing = inlineDrawing(
	'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingShape',
	'<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
	+ '<wps:spPr><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"/></wps:spPr>'
	+ '<wps:txbx><w:txbxContent><w:p><w:r><w:t>枠内テキスト</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>',
	TEXTBOX_EXTENT.cx, TEXTBOX_EXTENT.cy, 2,
);

function packageParts(body: string): Map<string, string> {
	return new Map<string, string>([
		['/word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
		['/word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
			+ '<Relationship Id="rC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>'],
		['/word/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>'
			+ '<c:title><c:tx><c:rich><a:p><a:r><a:t>売上</a:t></a:r></a:p></c:rich></c:tx></c:title>'
			+ '<c:plotArea><c:barChart><c:barDir val="col"/><c:ser>'
			+ '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>25</c:v></c:pt></c:numCache></c:numRef></c:val>'
			+ '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'],
	]);
}

function overlayFor(body: string) {
	const objects = extractParadisWordRenderableObjects({ parts: packageParts(body) });
	const scratch = mainWindow.document.implementation.createHTMLDocument('word overlay');
	return { objects, items: buildParadisWordOverlayItems(objects, scratch) };
}

suite('ParadisWordObjectOverlayHtml', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns an extracted chart into an SVG sized to its drawing frame', () => {
		const { objects, items } = overlayFor(chartDrawing);

		strictEqual(objects.length, 1);
		strictEqual(items.length, 1);
		// 差し込み先は wp:docPr@id で決めるので、その値が載っていること。
		deepStrictEqual([items[0].kind, items[0].drawingId], ['chart', '1']);
		// 枠いっぱいに収まるよう viewBox と 100% 指定が付く。
		ok(items[0].svg.includes('viewBox="0 0 300 200"'), items[0].svg.slice(0, 200));
		ok(items[0].svg.includes('width="100%"'));
		ok(items[0].svg.includes('paradis-word-chart'));
		// 値2件ぶんの棒が描かれる。
		strictEqual(items[0].svg.split('paradis-word-chart-bar').length - 1, 2);
		ok(items[0].svg.includes('売上'));
	});

	test('renders textbox text through the same path', () => {
		const { items } = overlayFor(textboxDrawing);

		strictEqual(items.length, 1);
		strictEqual(items[0].kind, 'textbox');
		ok(items[0].svg.includes('枠内テキスト'));
	});

	test('keeps document order so the webview can match frames by position', () => {
		const { items } = overlayFor(chartDrawing + textboxDrawing);

		deepStrictEqual(items.map(item => item.kind), ['chart', 'textbox']);
	});

	test('produces nothing when the document has no drawable object', () => {
		const { items } = overlayFor('<w:p><w:r><w:t>本文だけ</w:t></w:r></w:p>');

		strictEqual(items.length, 0);
	});

	test('skips a drawing that carries no marker to match a frame with', () => {
		// 目印が無いと差し込み先を決められないので、はじめから作らない。
		const withoutDocPr = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
			+ `<wp:extent cx="${CHART_EXTENT.cx}" cy="${CHART_EXTENT.cy}"/>`
			+ `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">`
			+ `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rC1"/>`
			+ `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

		strictEqual(overlayFor(withoutDocPr).items.length, 0);
	});
});

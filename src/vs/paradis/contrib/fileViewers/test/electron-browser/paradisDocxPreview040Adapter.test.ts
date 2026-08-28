/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, match, strictEqual, throws } from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordParagraphNode, ParadisWordStory } from '../../common/word/paradisWordSemantic.js';
import {
	DocxPreview040RenderAdapter,
	applyDocxPreview040Patches,
	docxPreview040Build,
	docxPreview040Patches,
	PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE,
	type IDocxPreview040Api,
} from '../../electron-browser/word/paradisDocxPreview040Adapter.js';
import type { IDocxPreviewAstDocument, IDocxPreviewAstNode } from '../../electron-browser/word/paradisDocxRenderAdapter.js';

suite('DocxPreview040RenderAdapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('applies the seven still-required 0.4.0 compatibility patches exactly once and in order', () => {
		deepStrictEqual(docxPreview040Patches.map(patch => patch.id), [
			'vml-stroke-attributes',
			'vertical-writing-variants',
			'table-layout-type-attribute',
			'hanging-indent-tab-stop',
			'fixed-table-width',
			'page-relative-vml-origin',
			'numbering-css-content',
		]);
		const upstreamFixture = docxPreview040Patches.map(patch => patch.before).join('\n');
		const patched = applyDocxPreview040Patches(upstreamFixture);

		match(patched, /case"strokecolor"/);
		match(patched, /tbRlV:\{writingMode:"vertical-rl"/);
		match(patched, /attr\(e,"type"\)/);
		match(patched, /parseFloat\(o\.textIndent\)<0/);
		match(patched, /e\.columns\.reduce/);
		match(patched, /mso-position-horizontal-relative:page/);
		match(patched, /s\.join\(" "\)/);
		throws(() => applyDocxPreview040Patches(patched), /expected exactly one upstream match/);
	});

	test('matches the accepted 0.3.7 numbering table VML image page anchor and mobile golden', async () => {
		const semantic = semanticGolden();
		const ast = previewGolden();
		const api = golden040Api(ast);
		const adapter = new DocxPreview040RenderAdapter(api);
		const desktop = await render(adapter, semantic, document);
		const mobileDocument = document.implementation.createHTMLDocument('mobile');
		const mobile = await render(adapter, semantic, mobileDocument);

		strictEqual(desktop.result.outcome, 'complete');
		deepStrictEqual(goldenSnapshot(desktop.body, desktop.styles, desktop.result.anchors), accepted037Golden);
		deepStrictEqual(goldenSnapshot(mobile.body, mobile.styles, mobile.result.anchors), accepted037Golden);
		deepStrictEqual(nodeIdShape(desktop.body, desktop.styles), nodeIdShape(mobile.body, mobile.styles));
	});

	test('runs the hash-verified local patched 0.4 UMD through h() and the MathML anchor bridge', async function () {
		const candidate = await loadLocalActual040Candidate();
		if (!candidate) {
			this.skip();
		}
		const bytes = await minimalMathDocx(candidate.JSZip);
		const adapter = new DocxPreview040RenderAdapter(candidate.api);
		const rendered = await render(adapter, semanticMathGolden(), document, bytes);

		strictEqual(rendered.result.outcome, 'complete');
		strictEqual(rendered.body.querySelector('p')?.textContent, 'Actual 0.4');
		strictEqual(rendered.result.anchors.get('actual-omml')?.localName, 'math', `${rendered.body.innerHTML}\n${JSON.stringify(rendered.result.outcomes)}`);
		strictEqual(rendered.result.anchors.get('actual-omml')?.hasAttribute(PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE), true);
	});

	test('does not publish a completed 0.4 node array after its source revision becomes stale', async () => {
		const gate = new DeferredPromise<void>();
		const semantic = semanticGolden();
		const ast = previewGolden();
		let revision = 'r1';
		const api = golden040Api(ast, gate.p);
		const adapter = new DocxPreview040RenderAdapter(api);
		const body = document.createElement('div');
		const styles = document.createElement('div');
		body.textContent = 'previous';
		const pending = adapter.render(Uint8Array.of(1, 2, 3), semantic, {
			bodyContainer: body,
			styleContainer: styles,
			sourceRevision: 'r1',
			isRevisionCurrent: value => value === revision,
		});
		revision = 'r2';
		gate.complete();

		const result = await pending;

		strictEqual(result.outcome, 'stale');
		strictEqual(result.anchors.size, 0);
		strictEqual(body.textContent, 'previous');
		strictEqual(styles.childNodes.length, 0);
	});
});

const accepted037Golden = {
	numbering: '.docx-num-7-0:before { content: counter(docx-num-7-0, decimal) "." "\\9"; }',
	table: { width: '180pt', layout: 'fixed', columns: ['60pt', '120pt'], cell: '項目' },
	vml: {
		style: 'position: absolute; left: 0px; top: 0px;',
		line: { x1: '17.25', y1: '23.75', x2: '147.5', y2: '91.125', stroke: '#2f5597', strokeWidth: '1.5pt' },
	},
	image: {
		src: 'data:image/png;base64,AQID',
		transform: 'rotate(13deg) scale(1.25, 0.8)',
		clipPath: 'rect(10% 80% 90% 5%)',
	},
	page: { width: '612pt', height: '792pt' },
	styles: { html: 'Symbol', svg: '2px', mathml: 'overline' },
	anchors: { paragraph: 'P', table: 'TABLE', cell: 'TD', line: 'DIV', image: 'IMG', omml: 'math' },
};

function goldenSnapshot(body: HTMLElement, styles: HTMLElement, anchors: ReadonlyMap<string, Element>) {
	const table = body.querySelector('table') as HTMLTableElement;
	const line = body.querySelector('line') as SVGLineElement;
	const svg = line.ownerSVGElement as SVGSVGElement;
	const image = body.querySelector('img') as HTMLImageElement;
	const math = body.querySelector('math') as MathMLElement;
	const page = body.querySelector('section.docx') as HTMLElement;
	const idElements = [...styles.querySelectorAll(`[${PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE}]`), ...body.querySelectorAll(`[${PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE}]`)];
	strictEqual(new Set(idElements.map(element => element.getAttribute(PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE))).size, idElements.length);
	return {
		numbering: styles.querySelector('style')?.textContent,
		table: {
			width: table.style.width,
			layout: table.style.tableLayout,
			columns: [...table.querySelectorAll('col')].map(column => (column as HTMLElement).style.width),
			cell: table.querySelector('td')?.textContent,
		},
		vml: {
			style: svg.getAttribute('style'),
			line: {
				x1: line.getAttribute('x1'), y1: line.getAttribute('y1'), x2: line.getAttribute('x2'), y2: line.getAttribute('y2'),
				stroke: line.getAttribute('stroke'), strokeWidth: line.getAttribute('stroke-width'),
			},
		},
		image: { src: image.getAttribute('src'), transform: image.style.transform, clipPath: image.style.clipPath },
		page: { width: page.style.width, height: page.style.height },
		styles: {
			html: (body.querySelector('p') as HTMLElement).style.fontFamily,
			svg: line.style.strokeWidth,
			mathml: (math.firstElementChild as MathMLElement).style.textDecoration,
		},
		anchors: {
			paragraph: anchors.get('paragraph')?.tagName,
			table: anchors.get('table')?.tagName,
			cell: anchors.get('cell')?.tagName,
			line: anchors.get('line')?.tagName,
			image: anchors.get('image')?.tagName,
			omml: anchors.get('omml')?.tagName,
		},
	};
}

function nodeIdShape(body: HTMLElement, styles: HTMLElement): readonly string[] {
	return [...styles.querySelectorAll(`[${PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE}]`), ...body.querySelectorAll(`[${PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE}]`)]
		.map(element => `${element.tagName}:${element.getAttribute(PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE)}`);
}

function golden040Api(ast: IDocxPreviewAstDocument, renderGate?: Promise<void>): IDocxPreview040Api {
	return {
		async parseAsync(_data, options) {
			strictEqual(options.ignoreFonts, true);
			strictEqual(options.renderAltChunks, false);
			return ast;
		},
		async renderDocument(value, options) {
			await renderGate;
			const h = options.h;
			const [paragraphNode, tableNode, vmlNode, imageDrawingNode] = value.documentPart?.body?.children ?? [];
			const rowNode = tableNode.children?.[0];
			const cellNode = rowNode?.children?.[0];
			const imageNode = imageDrawingNode.children?.[0];
			const numbering = h({
				tagName: 'style',
				children: ['.docx-num-7-0:before { content: counter(docx-num-7-0, decimal) "." "\\9"; }'],
			});
			const paragraphRun = h({ tagName: 'span', style: paragraphNode.children?.[0].cssStyle, children: ['第1条'] });
			const paragraph = h({ tagName: 'p', className: 'docx-num-7-0', style: { ...paragraphNode.cssStyle, fontFamily: 'Symbol' }, children: [paragraphRun] });
			const cell = h({ tagName: 'td', style: cellNode?.cssStyle, children: ['項目'] });
			const row = h({ tagName: 'tr', style: rowNode?.cssStyle, children: [cell] });
			const columns = h({
				tagName: 'colgroup', children: [
					h({ tagName: 'col', style: { width: '60pt' } }),
					h({ tagName: 'col', style: { width: '120pt' } }),
				]
			});
			const table = h({ tagName: 'table', style: { ...tableNode.cssStyle, width: '180pt', 'table-layout': 'fixed' }, children: [columns, row] });
			const line = h({ ns: 'http://www.w3.org/2000/svg', tagName: 'line', style: { strokeWidth: '2px' } }) as SVGLineElement;
			for (const [name, raw] of Object.entries({ x1: '17.25', y1: '23.75', x2: '147.5', y2: '91.125', stroke: '#2f5597', 'stroke-width': '1.5pt' })) {
				line.setAttribute(name, raw);
			}
			const svg = h({
				ns: 'http://www.w3.org/2000/svg', tagName: 'svg',
				style: 'position:absolute', children: [line],
			}) as SVGSVGElement;
			svg.style.left = '0';
			svg.style.top = '0';
			const vml = h({ tagName: 'div', style: vmlNode.cssStyle, children: [svg] });
			const image = h({
				tagName: 'img', style: {
					...imageNode?.cssStyle,
					transform: 'rotate(13deg) scale(1.25, 0.8)',
					'clip-path': 'rect(10% 80% 90% 5%)',
				},
				src: 'data:image/png;base64,AQID',
			});
			const imageDrawing = h({ tagName: 'div', style: imageDrawingNode.cssStyle, children: [image] });
			// 0.4 renders mmlMath via renderContainerNS without forwarding the AST cssStyle.
			const mathRow = h({ ns: 'http://www.w3.org/1998/Math/MathML', tagName: 'mrow', style: { textDecoration: 'overline' }, children: ['x'] });
			const math = h({ ns: 'http://www.w3.org/1998/Math/MathML', tagName: 'math', xmlns: 'http://www.w3.org/1998/Math/MathML', children: [mathRow] });
			const page = h({ tagName: 'section', className: 'docx', style: { width: '612pt', height: '792pt' }, children: [paragraph, table, vml, imageDrawing, math] });
			const wrapper = h({ tagName: 'div', className: 'docx-wrapper', children: [page] });
			return [numbering, wrapper];
		},
	};
}

async function render(adapter: DocxPreview040RenderAdapter, semantic: ParadisWordDocument, ownerDocument: Document, bytes: Uint8Array<ArrayBufferLike> = Uint8Array.of(1, 2, 3)) {
	const body = ownerDocument.createElement('div');
	const styles = ownerDocument.createElement('div');
	const result = await adapter.render(bytes, semantic, {
		bodyContainer: body,
		styleContainer: styles,
		sourceRevision: 'r1',
	});
	return { body, styles, result };
}

async function loadLocalActual040Candidate(): Promise<{ readonly api: IDocxPreview040Api; readonly JSZip: typeof import('jszip') } | undefined> {
	const uri = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxPreview040Candidate.min.js').toString(true);
	let response: Response;
	try {
		response = await fetch(uri);
	} catch {
		return undefined;
	}
	if (!response.ok) {
		return undefined;
	}
	const source = await response.text();
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	strictEqual([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), docxPreview040Build.patchedSourceSha256);

	const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js');
	const module = { exports: {} as Record<string, unknown> };
	const evaluate = new Function('exports', 'module', 'require', source) as (exports: Record<string, unknown>, module: { exports: Record<string, unknown> }, require: (id: string) => unknown) => void;
	evaluate(module.exports, module, id => {
		if (id !== 'jszip') {
			throw new Error(`Unexpected docx-preview dependency: ${id}`);
		}
		return JSZip;
	});
	return { api: module.exports as unknown as IDocxPreview040Api, JSZip };
}

async function minimalMathDocx(JSZip: typeof import('jszip')): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
	zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
	zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>Actual 0.4</w:t></w:r></w:p><w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>');
	return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

function previewGolden(): IDocxPreviewAstDocument {
	return previewDocument([
		preview('paragraph', [preview('run', [previewText('第1条')])], { numbering: '7' }),
		preview('table', [preview('row', [preview('cell', [preview('paragraph', [preview('run', [previewText('項目')])])])])], { width: 'auto', 'table-layout': 'fixed' }),
		preview('drawing'),
		preview('drawing', [preview('image')]),
		preview('mmlMath'),
	]);
}

function semanticGolden(): ParadisWordDocument {
	const nodes: readonly ParadisWordNode[] = [
		paragraph('paragraph', [text('paragraph-text', '第1条', [0, 0, 0])], [0, 0]),
		{
			...base('table', 'table', [0, 1]), kind: 'table', diagonalBorders: [], children: [
				{
					...base('row', 'row', [0, 1, 0]), kind: 'row', children: [
						{ ...base('cell', 'cell', [0, 1, 0, 0]), kind: 'cell', children: [] },
					]
				},
			]
		},
		{ ...base('drawing', 'line', [0, 2]), kind: 'drawing', geometry: geometry('anchor'), children: [] },
		{
			...base('drawing', 'image-drawing', [0, 3]), kind: 'drawing', geometry: geometry('inline'), children: [
				{ ...base('image', 'image', [0, 3, 0]), kind: 'image', external: false },
			]
		},
		{ ...base('omml', 'omml', [0, 4]), kind: 'omml', text: 'x' },
	];
	return semanticDocument([story([{ ...base('section', 'section', [0]), kind: 'section', sectionOrdinal: 0, children: nodes }])]);
}

function semanticMathGolden(): ParadisWordDocument {
	const nodes: readonly ParadisWordNode[] = [
		paragraph('actual-paragraph', [text('actual-text', 'Actual 0.4', [0, 0, 0])], [0, 0]),
		{ ...base('omml', 'actual-omml', [0, 1]), kind: 'omml', text: 'x' },
	];
	return semanticDocument([story([{ ...base('section', 'actual-section', [0]), kind: 'section', sectionOrdinal: 0, children: nodes }])]);
}

function geometry(placement: 'anchor' | 'inline') {
	return { placement, distances: {}, sourcePartFingerprint: fingerprint('a') };
}

function preview(type: string, children: readonly IDocxPreviewAstNode[] = [], cssStyle: Record<string, string> = {}): IDocxPreviewAstNode {
	return { type, children: [...children], cssStyle };
}

function previewText(value: string): IDocxPreviewAstNode {
	return { type: 'text', text: value };
}

function previewDocument(children: readonly IDocxPreviewAstNode[]): IDocxPreviewAstDocument {
	return { documentPart: { body: { type: 'document', children: [...children] } } };
}

function fingerprint(seed: string): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: seed.repeat(64).slice(0, 64), byteLength: 1 };
}

function base(kind: ParadisWordNode['kind'], id: string, path: readonly number[]) {
	const partUri = '/word/document.xml';
	return {
		id,
		kind,
		source: { partUri, semanticPath: path, kind, ordinal: path.at(-1) ?? 0, fingerprint: `semantic:${id}`, partFingerprint: fingerprint('a') },
		anchor: { partUri, semanticPath: path, kind, ordinal: path.at(-1) ?? 0, fingerprint: `semantic:${id}` },
	};
}

function text(id: string, value: string, path: readonly number[]): ParadisWordNode {
	return { ...base('text', id, path), kind: 'text', text: value };
}

function paragraph(id: string, children: readonly ParadisWordNode[], path: readonly number[]): ParadisWordParagraphNode {
	return { ...base('paragraph', id, path), kind: 'paragraph', children };
}

function story(nodes: readonly ParadisWordNode[]): ParadisWordStory {
	const partUri = '/word/document.xml';
	return {
		id: 'body-story',
		address: { kind: 'body', partUri, ordinal: 0 },
		source: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: 'body:story', partFingerprint: fingerprint('a') },
		anchor: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: 'body:story' },
		nodes,
		text: '',
	};
}

function semanticDocument(stories: readonly ParadisWordStory[]): ParadisWordDocument {
	const source = { partUri: '/word/document.xml', semanticPath: [], kind: 'story' as const, ordinal: 0, fingerprint: 'document', partFingerprint: fingerprint('a') };
	return {
		documentSource: source,
		contentTypesSource: { ...source, partUri: '/[Content_Types].xml' },
		rootRelationshipsSource: { ...source, partUri: '/_rels/.rels' },
		documentRelationshipsSource: { ...source, partUri: '/word/_rels/document.xml.rels' },
		stories,
		storyReferences: [],
		completeness: { expectedParts: 4, visitedParts: 4, parsedParts: 4, stories: stories.length, nodes: 0, unknownBlocks: 0, unresolvedRelationships: 0, terminal: true },
	};
}

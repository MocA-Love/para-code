/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordParagraphNode, ParadisWordStory } from '../../common/word/paradisWordSemantic.js';
import {
	DocxPreview037RenderAdapter,
	type IDocxPreview037Api,
	type IDocxPreviewAstDocument,
	type IDocxPreviewAstNode,
} from '../../electron-browser/word/paradisDocxRenderAdapter.js';
import { PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE } from '../../electron-browser/word/paradisDocxRenderAnchor.js';

suite('DocxPreview037RenderAdapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps one semantic paragraph to its rendered DOM element', async () => {
		const fixture = renderFixture(
			semanticDocument([story([section([paragraph('paragraph', [text('text', 'hello', [0, 0, 0])], [0, 0])])])]),
			previewDocument([preview('paragraph', [preview('run', [previewText('hello')])])]),
		);

		const result = await fixture.render();

		strictEqual(result.outcome, 'complete');
		strictEqual(result.anchors.get('paragraph')?.tagName, 'P');
		deepStrictEqual(outcome(result, 'paragraph'), {
			nodeId: 'paragraph', coverage: 'rendered', destination: 'document', anchorNodeId: 'paragraph',
		});
	});

	test('maps multiple semantic text nodes to one safe run anchor', async () => {
		const fixture = renderFixture(
			semanticDocument([story([section([paragraph('paragraph', [text('left', 'left', [0, 0, 0]), text('right', 'right', [0, 0, 1])], [0, 0])])])]),
			previewDocument([preview('paragraph', [preview('run', [previewText('left'), previewText('right')])])]),
		);

		const result = await fixture.render();

		strictEqual(result.anchors.get('left'), result.anchors.get('right'));
		strictEqual(result.anchors.get('left')?.tagName, 'SPAN');
		deepStrictEqual([outcome(result, 'left'), outcome(result, 'right')], [
			{ nodeId: 'left', coverage: 'approximated', destination: 'document', anchorNodeId: 'paragraph' },
			{ nodeId: 'right', coverage: 'approximated', destination: 'document', anchorNodeId: 'paragraph' },
		]);
	});

	test('routes a duplicated DOM marker collision to the Inspector', async () => {
		const semantic = semanticDocument([story([section([paragraph('paragraph', [], [0, 0])])])]);
		const ast = previewDocument([preview('paragraph')]);
		const fixture = renderFixture(semantic, ast, { duplicateMarkedElements: true });

		const result = await fixture.render();

		strictEqual(result.outcome, 'degraded');
		strictEqual(result.anchors.has('paragraph'), false);
		deepStrictEqual(outcome(result, 'paragraph'), {
			nodeId: 'paragraph', coverage: 'noAnchor', destination: 'inspector', reason: 'collision',
		});
	});

	test('maps a renderer-omitted node to its nearest semantic ancestor marker', async () => {
		const omitted: ParadisWordNode = {
			...base('unknownBlock', 'omitted', [0, 0, 0]), kind: 'unknownBlock',
			name: { namespace: 'urn:unsupported', local: 'omitted' },
		};
		const fixture = renderFixture(
			semanticDocument([story([section([paragraph('paragraph', [omitted], [0, 0])])])]),
			previewDocument([preview('paragraph')]),
		);

		const result = await fixture.render();

		strictEqual(result.anchors.get('omitted'), result.anchors.get('paragraph'));
		deepStrictEqual(outcome(result, 'omitted'), {
			nodeId: 'omitted', coverage: 'approximated', destination: 'document', anchorNodeId: 'paragraph', reason: 'omitted',
		});
	});

	test('routes a story with no rendered anchor to the Inspector', async () => {
		const headerParagraph = paragraph('header-paragraph', [], [0]);
		const fixture = renderFixture(
			semanticDocument([story([], 'body'), story([headerParagraph], 'header')]),
			previewDocument([]),
		);

		const result = await fixture.render();

		strictEqual(result.outcome, 'degraded');
		deepStrictEqual(outcome(result, 'header-paragraph'), {
			nodeId: 'header-paragraph', coverage: 'noAnchor', destination: 'inspector', reason: 'noAnchor',
		});
	});

	test('replaces known Symbol-family private glyphs without changing ordinary styles', async () => {
		const fixture = renderFixture(semanticDocument([story([])]), previewDocument([]), {
			styleText: '.docx-num:before { content: "\uF0B7\uF0A7\uF0E0"; font-family: Symbol; }\n.wing:before { content: "\uF0FC"; font-family: Wingdings; }\n.symbol-selector:before { content: "\uF0A7"; font-family: Arial; }',
			symbolRuns: [{ fontFamily: 'Symbol', text: '\uF0B7' }, { fontFamily: 'Webdings', text: '\uF06C' }],
		});

		await fixture.render();

		strictEqual(fixture.styles.textContent,
			'.docx-num:before { content: "\u2022\u25AA\u2192"; font-family: Symbol; }\n.wing:before { content: "\u2713"; font-family: Wingdings; }\n.symbol-selector:before { content: "\uF0A7"; font-family: Arial; }');
		deepStrictEqual([...fixture.body.querySelectorAll('span')].map(element => element.textContent), ['\u2022', '\u25CF']);
	});

	test('widens a rendered page to contain a wide table', async () => {
		const fixture = renderFixture(semanticDocument([story([])]), previewDocument([]), { sectionWidth: [640, 920] });

		await fixture.render();

		strictEqual((fixture.body.querySelector('section.docx') as HTMLElement).style.width, '920px');
	});

	test('does not publish DOM or anchors when cancelled during parse', async () => {
		const gate = new DeferredPromise<void>();
		const cancellation = new CancellationTokenSource();
		const fixture = renderFixture(semanticDocument([story([section([paragraph('paragraph', [], [0, 0])])])]), previewDocument([preview('paragraph')]), { parseGate: gate.p });
		fixture.body.textContent = 'previous';
		const pending = fixture.render({ cancellationToken: cancellation.token });
		cancellation.cancel();
		gate.complete();

		const result = await pending;

		strictEqual(result.outcome, 'cancelled');
		strictEqual(result.anchors.size, 0);
		strictEqual(fixture.body.textContent, 'previous');
		cancellation.dispose();
	});

	test('does not publish DOM or anchors after the source revision becomes stale', async () => {
		const gate = new DeferredPromise<void>();
		let currentRevision = 'revision-1';
		const fixture = renderFixture(semanticDocument([story([section([paragraph('paragraph', [], [0, 0])])])]), previewDocument([preview('paragraph')]), { renderGate: gate.p });
		fixture.body.textContent = 'previous';
		const pending = fixture.render({ isRevisionCurrent: revision => revision === currentRevision });
		currentRevision = 'revision-2';
		gate.complete();

		const result = await pending;

		strictEqual(result.outcome, 'stale');
		strictEqual(result.anchors.size, 0);
		strictEqual(fixture.body.textContent, 'previous');
	});
});

interface FakePreviewOptions {
	readonly duplicateMarkedElements?: boolean;
	readonly styleText?: string;
	readonly symbolRuns?: readonly { readonly fontFamily: string; readonly text: string }[];
	readonly sectionWidth?: readonly [number, number];
	readonly parseGate?: Promise<void>;
	readonly renderGate?: Promise<void>;
}

function renderFixture(semantic: ParadisWordDocument, ast: IDocxPreviewAstDocument, fakeOptions: FakePreviewOptions = {}) {
	const body = document.createElement('div');
	const styles = document.createElement('div');
	const previewApi = fakePreviewApi(ast, fakeOptions);
	const adapter = new DocxPreview037RenderAdapter(previewApi);
	return {
		body,
		styles,
		render: (overrides: { readonly cancellationToken?: CancellationToken; readonly isRevisionCurrent?: (revision: string) => boolean } = {}) => adapter.render(
			Uint8Array.of(1, 2, 3), semantic, {
			bodyContainer: body,
			styleContainer: styles,
			sourceRevision: 'revision-1',
			cancellationToken: overrides.cancellationToken ?? CancellationToken.None,
			isRevisionCurrent: overrides.isRevisionCurrent ?? (() => true),
		}
		),
	};
}

function fakePreviewApi(ast: IDocxPreviewAstDocument, options: FakePreviewOptions): IDocxPreview037Api {
	return {
		async parseAsync() {
			await options.parseGate;
			return ast;
		},
		async renderDocument(value, body, styles) {
			await options.renderGate;
			for (const run of options.symbolRuns ?? []) {
				const symbol = body.ownerDocument.createElement('span');
				symbol.style.fontFamily = run.fontFamily;
				symbol.textContent = run.text;
				body.appendChild(symbol);
			}
			if (options.styleText !== undefined && styles) {
				const style = styles.ownerDocument.createElement('style');
				style.textContent = options.styleText;
				styles.appendChild(style);
			}
			if (options.sectionWidth) {
				const wrapper = body.ownerDocument.createElement('div');
				wrapper.className = 'docx-wrapper';
				const section = body.ownerDocument.createElement('section');
				section.className = 'docx';
				Object.defineProperties(section, {
					clientWidth: { configurable: true, value: options.sectionWidth[0] },
					scrollWidth: { configurable: true, value: options.sectionWidth[1] },
				});
				wrapper.appendChild(section);
				body.appendChild(wrapper);
			}
			for (const node of value.documentPart?.body?.children ?? []) {
				const element = renderPreviewNode(node, body.ownerDocument);
				if (element) {
					body.appendChild(element);
					if (options.duplicateMarkedElements && element instanceof Element && element.hasAttribute(PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE)) {
						body.appendChild(element.cloneNode(true));
					}
				}
			}
		},
	};
}

function renderPreviewNode(node: IDocxPreviewAstNode, ownerDocument: Document): Node | undefined {
	if (node.type === 'text') {
		return ownerDocument.createTextNode(node.text ?? '');
	}
	const tag = previewTag(node.type);
	if (!tag) {
		return undefined;
	}
	const element = ownerDocument.createElement(tag);
	for (const [key, value] of Object.entries(node.cssStyle ?? {})) {
		if (key.startsWith('$')) {
			element.setAttribute(key.slice(1), value);
		}
	}
	for (const child of node.children ?? []) {
		const rendered = renderPreviewNode(child, ownerDocument);
		if (rendered) {
			element.appendChild(rendered);
		}
	}
	return element;
}

function previewTag(type: string): keyof HTMLElementTagNameMap | undefined {
	switch (type) {
		case 'paragraph': return 'p';
		case 'run': return 'span';
		case 'table': return 'table';
		case 'row': return 'tr';
		case 'cell': return 'td';
		case 'hyperlink': return 'a';
		case 'drawing': return 'div';
		case 'image': return 'img';
		default: return undefined;
	}
}

function preview(type: string, children: readonly IDocxPreviewAstNode[] = []): IDocxPreviewAstNode {
	return { type, children: [...children], cssStyle: {} };
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

function section(children: readonly ParadisWordNode[]): ParadisWordNode {
	return { ...base('section', 'section', [0]), kind: 'section', sectionOrdinal: 0, children };
}

function story(nodes: readonly ParadisWordNode[], kind: ParadisWordStory['address']['kind'] = 'body'): ParadisWordStory {
	const partUri = kind === 'body' ? '/word/document.xml' : `/word/${kind}1.xml`;
	return {
		id: `${kind}-story`,
		address: { kind, partUri, ordinal: 0 },
		source: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: `${kind}:story`, partFingerprint: fingerprint('a') },
		anchor: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: `${kind}:story` },
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

function outcome(result: Awaited<ReturnType<ReturnType<typeof renderFixture>['render']>>, nodeId: string) {
	return result.outcomes.find(value => value.nodeId === nodeId);
}

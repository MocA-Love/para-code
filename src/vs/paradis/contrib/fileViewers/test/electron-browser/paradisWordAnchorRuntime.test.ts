/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_WORD_ANCHOR_RUNTIME } from '../../electron-browser/word/paradisWordAnchorRuntime.js';

interface AstNode {
	type: string;
	id?: string;
	text?: string;
	children?: AstNode[];
	cssStyle?: Record<string, string>;
}

interface Anchors {
	stamp(document: unknown): void;
	collect(root: Element): Record<string, string[]>;
	reveal(root: Element, message: { readonly marker?: string; readonly context: string; readonly focus: string; readonly matchCase: boolean }): boolean;
	setMarks(root: Element, entries: unknown[], labels: { readonly title: string; readonly close: string }, mode: string): void;
	setComments(root: Element, content: Element, entries: unknown[]): void;
	closePopover(): void;
}

/** 実行時のスクリプトを、テスト用の iframe の window と document で動かす。 */
function loadRuntime(): { readonly anchors: Anchors; readonly document: Document; dispose(): void } {
	const iframe = mainWindow.document.createElement('iframe');
	mainWindow.document.body.appendChild(iframe);
	const frameWindow = iframe.contentWindow as Window & typeof globalThis & { paradisWordAnchors?: Anchors };
	new Function('window', 'document', 'NodeFilter', 'CSS', 'Highlight', PARADIS_WORD_ANCHOR_RUNTIME)(
		frameWindow, frameWindow.document, frameWindow.NodeFilter, frameWindow.CSS, (frameWindow as unknown as { Highlight?: unknown }).Highlight,
	);
	return { anchors: frameWindow.paradisWordAnchors!, document: frameWindow.document, dispose: () => iframe.remove() };
}

function element(document: Document, tag: string, attributes: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
	const result = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		result.setAttribute(name, value);
	}
	for (const child of children) {
		result.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return result;
}

suite('ParadisWordAnchorRuntime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stamps paragraphs per story, collects their own text, and opens a text-only popover for a marked image', () => {
		const runtime = loadRuntime();
		try {
			const textbox: AstNode = { type: 'paragraph', children: [{ type: 'run', children: [{ type: 'text', text: 'Stamp' }] }] };
			const noteRun: AstNode = { type: 'run', children: [{ type: 'footnoteReference', id: '1' }] };
			const body: AstNode = {
				type: 'document', children: [
					{ type: 'paragraph', children: [{ type: 'run', children: [{ type: 'text', text: 'Hello world' }] }] },
					{ type: 'paragraph', children: [{ type: 'run', children: [{ type: 'vmlPicture', children: [{ type: 'vmlElement', children: [textbox] }] }] }, noteRun] },
				],
			};
			const header: AstNode = { type: 'header', children: [{ type: 'paragraph' }] };
			const note: AstNode = { type: 'footnote', id: '1', children: [{ type: 'paragraph' }] };
			runtime.anchors.stamp({
				documentPart: { path: 'word/document.xml', body },
				parts: [{ path: 'word/header1.xml', rootElement: header }],
				footnotesPart: { path: 'word/footnotes.xml', notes: [note] },
			});

			const document = runtime.document;
			const root = element(document, 'div', {},
				element(document, 'header', {}, element(document, 'p', { 'data-paradis-p': 'p:word/header1.xml#0' }, 'Sample company')),
				element(document, 'section', {},
					element(document, 'p', { 'data-paradis-p': 'b#0' }, 'Hel', element(document, 'span', {}, 'lo'), ' world ', element(document, 'img', {})),
					element(document, 'p', { 'data-paradis-p': 'b#1' },
						element(document, 'span', {}, 'Sig'),
						element(document, 'p', { 'data-paradis-p': 't:word/document.xml:0#0' }, 'Stamp'),
						element(document, 'span', { 'data-paradis-skip': '1' }, element(document, 'sup', {}, '1')),
						element(document, 'del', {}, 'gone'),
					),
				),
				element(document, 'header', {}, element(document, 'p', { 'data-paradis-p': 'p:word/header1.xml#0' }, 'Sample company')),
			);
			document.body.appendChild(root);
			runtime.anchors.setMarks(root, [{ marker: 'b#0', marks: [{ kind: 'image', start: 10, end: 10, ordinal: 0, rows: [['kind', 'image'], ['targetPartUri', '<img src=x onerror=alert(1)>']] }] }], { title: 'Info', close: 'Close' }, 'final');
			root.querySelector('img')!.dispatchEvent(new (document.defaultView as Window & typeof globalThis).MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
			const popover = document.querySelector('.paradis-word-popover');

			deepStrictEqual({
				stamped: [body.children![0].cssStyle, body.children![1].cssStyle, textbox.cssStyle, noteRun.cssStyle, header.children![0].cssStyle, note.children![0].cssStyle],
				collected: runtime.anchors.collect(root),
				revealed: runtime.anchors.reveal(root, { marker: 'b#0', context: '', focus: 'wor', matchCase: true }),
				popover: [...popover?.querySelectorAll('.paradis-word-popover-rows > div') ?? []].map(cell => cell.textContent),
				unsafeElements: popover?.querySelectorAll('img').length,
			}, {
				stamped: [
					{ '$data-paradis-p': 'b#0' },
					{ '$data-paradis-p': 'b#1' },
					{ '$data-paradis-p': 't:word/document.xml:0#0' },
					{ '$data-paradis-skip': '1' },
					{ '$data-paradis-p': 'p:word/header1.xml#0' },
					{ '$data-paradis-p': 'fn:1#0' },
				],
				collected: { 'p:word/header1.xml': ['Samplecompany'], b: ['Helloworld', 'Sig'], 't:word/document.xml:0': ['Stamp'] },
				revealed: true,
				popover: ['kind', 'image', 'targetPartUri', '<img src=x onerror=alert(1)>'],
				unsafeElements: 0,
			});

			runtime.anchors.setComments(root, root, [{ marker: 'b#0', author: 'Reviewer', date: '2026-09-29', text: 'Use the calendar year' }]);
			deepStrictEqual({
				note: root.querySelector('.paradis-word-comment-note')?.textContent,
				padded: root.classList.contains('paradis-word-has-comments'),
			}, { note: 'Reviewer 2026-09-29Use the calendar year', padded: true });
		} finally {
			runtime.anchors.closePopover();
			runtime.dispose();
		}
	});
});

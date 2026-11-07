/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import * as marked from '../../../../../base/common/marked/marked.js';
import { markedParadisAlertExtension, paradisMarkdownAlertOf } from '../../browser/paradisMarkdownAlerts.js';
import { renderParadisMarkdownDocument, renderParadisMarkdownDocumentDeferred } from '../../browser/paradisMarkdownDocumentRenderer.js';
import { markedMermaidExtension } from '../../browser/paradisMarkdownMermaid.js';

suite('paradisMarkdownAlerts', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let extensionService: IExtensionService;
	let languageService: ILanguageService;

	setup(() => {
		languageService = createCodeEditorServices(store).get(ILanguageService);
		// コードの色付けは拡張機能の登録を待つ。テストのサービスには無いので、すぐ済んだことにする。
		extensionService = { whenInstalledExtensionsRegistered: () => Promise.resolve(true) } as unknown as IExtensionService;
	});

	const options = { allowRelativeMediaPaths: true, allowRelativeLinkPaths: true, markedExtensions: [markedMermaidExtension(), markedParadisAlertExtension()] };

	async function render(text: string): Promise<string> {
		return (await renderParadisMarkdownDocument(text, extensionService, languageService, options)).toString().trim();
	}

	test('draws the five GitHub alerts and leaves other quotes alone', async () => {
		const results: Record<string, string> = {};
		const inputs: Record<string, string> = {
			note: '> [!NOTE]\n> Body with *em* and [a link](https://example.com).',
			lowercaseTip: '> [!tip]\n> Body',
			important: '> [!IMPORTANT]\n> First\n>\n> Second',
			warningWithList: '> [!WARNING]\n> - a\n> - b',
			cautionOnly: '> [!CAUTION]',
			inList: '- > [!NOTE]\n  > In a list',
			sameLine: '> [!NOTE] Same line',
			unknownKind: '> [!DANGER]\n> Body',
			inlineAfterMarker: '> [!NOTE]*em*',
			plainQuote: '> Just a quote',
		};
		for (const [name, text] of Object.entries(inputs)) {
			results[name] = await render(text);
		}
		assert.deepStrictEqual(results, {
			note: '<div class="paradis-markdown-alert paradis-markdown-alert-note" role="note">\n<p class="paradis-markdown-alert-title">Note</p>\n<p>Body with <em>em</em> and <a href="https://example.com">a link</a>.</p>\n</div>',
			lowercaseTip: '<div class="paradis-markdown-alert paradis-markdown-alert-tip" role="note">\n<p class="paradis-markdown-alert-title">Tip</p>\n<p>Body</p>\n</div>',
			important: '<div class="paradis-markdown-alert paradis-markdown-alert-important" role="note">\n<p class="paradis-markdown-alert-title">Important</p>\n<p>First</p>\n<p>Second</p>\n</div>',
			warningWithList: '<div class="paradis-markdown-alert paradis-markdown-alert-warning" role="note">\n<p class="paradis-markdown-alert-title">Warning</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n</div>',
			cautionOnly: '<div class="paradis-markdown-alert paradis-markdown-alert-caution" role="note">\n<p class="paradis-markdown-alert-title">Caution</p>\n</div>',
			inList: '<ul>\n<li><div class="paradis-markdown-alert paradis-markdown-alert-note" role="note">\n<p class="paradis-markdown-alert-title">Note</p>\n<p>In a list</p>\n</div>\n</li>\n</ul>',
			sameLine: '<blockquote>\n<p>[!NOTE] Same line</p>\n</blockquote>',
			unknownKind: '<blockquote>\n<p>[!DANGER]\nBody</p>\n</blockquote>',
			inlineAfterMarker: '<blockquote>\n<p>[!NOTE]<em>em</em></p>\n</blockquote>',
			plainQuote: '<blockquote>\n<p>Just a quote</p>\n</blockquote>',
		});
	});

	test('does not change the tokens', () => {
		// 色付けしたコードの差し込みに失敗したときは同じトークンでもう一度 parse するので、書き換えてはいけない
		const tokens = new marked.Marked().lexer('> [!NOTE]\n> Body *em*');
		const before = JSON.stringify(tokens);
		const alert = paradisMarkdownAlertOf((tokens[0] as marked.Tokens.Blockquote).tokens);
		assert.deepStrictEqual({ kind: alert?.kind, unchanged: JSON.stringify(tokens) === before }, { kind: 'note', unchanged: true });
	});

	test('inserts the highlighted code inside an alert like the rest of the document', async () => {
		const text = '> [!NOTE]\n> ```ts\n> const a = 1;\n> ```';
		const whole = (await renderParadisMarkdownDocument(text, extensionService, languageService, options)).toString();
		const deferred = await renderParadisMarkdownDocumentDeferred(text, extensionService, languageService, options);
		const body = new DOMParser().parseFromString(deferred.html as unknown as string, 'text/html').body;
		deferred.insertHighlightedCode(body);
		const expected = new DOMParser().parseFromString(whole, 'text/html').body;
		assert.deepStrictEqual({ same: body.innerHTML === expected.innerHTML, alert: body.querySelector('.paradis-markdown-alert-note .monaco-tokenized-source') !== null }, { same: true, alert: true });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { renderParadisMarkdownDocumentDeferred } from '../../browser/paradisMarkdownDocumentRenderer.js';
import { markedMermaidExtension } from '../../browser/paradisMarkdownMermaid.js';
import { PARADIS_CODE_COPY_MAX_CHARS, paradisCodeCopiedMessage, paradisCodeCopyScript, paradisReadCodeCopyRequest } from '../../common/paradisMarkdownCodeCopy.js';
import { paradisRecoverMarkdownCodeSources } from '../../common/paradisMarkdownCodeSource.js';
import { PARADIS_VIEWER_BODY_ROOT_ID } from '../../common/paradisViewerBodySwap.js';

/** コピーで確かめるコード（fence の中身）。タブ・連続した空白・空行・行末の空白・山括弧と & を含む。 */
const CODES: readonly { readonly lang: string; readonly text: string }[] = [
	{ lang: 'ts', text: 'function f(a: number) {\n\tif (a < 1 && a > -1) {\n\t\treturn `<b>${a}</b>`;   \n\t}\n\n\n    return a;\t// tab after\n}' },
	{ lang: '', text: 'plain text\n\twith a tab\n  two spaces  \n\nlast line' },
	{ lang: 'python', text: 'def g():\n    print("x")' },
	{ lang: 'unknown-lang', text: 'raw & <text>\n\t\tindented' },
	{ lang: 'sh', text: '' },
	{ lang: 'makefile', text: 'all:\n\tgo build ./...\n\t@echo "done"' },
];

function markdown(): string {
	const blocks = CODES.map(code => code.text ? `\`\`\`${code.lang}\n${code.text}\n\`\`\`` : `\`\`\`${code.lang}\n\`\`\``);
	return [
		'# 見出し',
		'',
		'段落の中の `インラインのコード` はそのまま。',
		'',
		...blocks.flatMap(block => [block, '']),
		'```mermaid',
		'flowchart LR',
		'  A --> B',
		'```',
		'',
		'- 箇条書きの中',
		'  ```js',
		'  if (x) {',
		'  \tconst x = 1;',
		'  }',
		'  ```',
	].join('\n');
}

/** ページに埋めるスクリプトを、試験の文書の中で動かす（`window` と `document` だけを差し替える）。 */
function runPageScript(root: HTMLElement, posted: unknown[]): { send(message: unknown): void; decorate(): void } {
	const script = paradisCodeCopyScript('n', { copy: 'Copy', copied: 'Copied', copyFailed: 'Failed' });
	const source = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
	const listeners: ((e: MessageEvent) => void)[] = [];
	const fakeWindow = { addEventListener: (_type: string, listener: (e: MessageEvent) => void) => listeners.push(listener) } as unknown as Window;
	const fakeDocument = { getElementById: (id: string) => id === PARADIS_VIEWER_BODY_ROOT_ID ? root : null, body: root, createElement: (tag: string) => mainWindow.document.createElement(tag) };
	new Function('window', 'document', 'acquireVsCodeApi', source)(fakeWindow, fakeDocument, () => ({ postMessage: (message: unknown) => posted.push(message) }));
	// 本物の親のフレームから届いたように見せる（送り主の子の一覧に自分がいる）。
	const parent = { length: 1, 0: fakeWindow };
	return {
		send: message => listeners.forEach(listener => listener({ data: message, source: parent } as unknown as MessageEvent)),
		decorate: () => (fakeWindow as unknown as { __paradisCodeCopy: { decorate(): void } }).__paradisCodeCopy.decorate(),
	};
}

suite('ParadisMarkdownCodeCopy', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let languageService: ILanguageService;
	const extensionService = { whenInstalledExtensionsRegistered: () => Promise.resolve(true) } as unknown as IExtensionService;

	setup(() => {
		languageService = createCodeEditorServices(store).get(ILanguageService);
	});

	test('each code block gets one copy button outside the pre, and the copied text is the fence content as written', async () => {
		const rendered = await renderParadisMarkdownDocumentDeferred(markdown(), extensionService, languageService, {
			allowRelativeMediaPaths: true,
			allowRelativeLinkPaths: true,
			markedExtensions: [markedMermaidExtension()],
		});
		const root = mainWindow.document.createElement('div');
		root.id = PARADIS_VIEWER_BODY_ROOT_ID;
		root.innerHTML = rendered.html as unknown as string;
		rendered.insertHighlightedCode(root);
		const highlighted = root.querySelectorAll('pre > code .monaco-tokenized-source').length;

		const posted: unknown[] = [];
		const page = runPageScript(root, posted);
		// 本文を差し替えた後の付け直しでも、同じブロックにボタンが増えない。
		page.decorate();
		const buttons = [...root.querySelectorAll<HTMLButtonElement>('.paradis-code-block > button.paradis-code-copy')];
		buttons.forEach(button => button.click());
		// ページは画面の文字を送り、ホストが書いたままの中身（行頭のタブ）に戻す（paradisMarkdownFileEditor と同じ手順）。
		const sources = paradisRecoverMarkdownCodeSources(markdown(), rendered.codeSources);
		const shown = posted.map(message => paradisReadCodeCopyRequest(message)!.text);
		const texts = shown.map(text => sources.get(text) ?? text);
		page.send(paradisCodeCopiedMessage(1, true));
		page.send(paradisCodeCopiedMessage(2, false));

		assert.deepStrictEqual({
			highlighted,
			buttons: buttons.length,
			insidePre: root.querySelectorAll('pre button').length,
			mermaid: root.querySelectorAll('.paradis-mermaid').length > 0 && !root.querySelector('.paradis-mermaid')!.closest('.paradis-code-block'),
			inline: root.querySelectorAll('p code').length === 1 && !root.querySelector('p .paradis-code-copy'),
			texts,
			shownTabs: shown.map(text => text.includes('\n\t')),
			labels: buttons.slice(0, 3).map(button => button.getAttribute('data-label')),
			noTextInButtons: buttons.every(button => button.textContent === ''),
		}, {
			highlighted: 7,
			buttons: 7,
			insidePre: 0,
			mermaid: true,
			inline: true,
			texts: [...CODES.map(code => code.text), 'if (x) {\n\tconst x = 1;\n}'],
			// marked は行頭のタブを空白に広げて描く（本家も同じ）。タブを戻すのはホストの側。
			shownTabs: [false, false, false, false, false, false, false],
			labels: ['Copied', 'Failed', 'Copy'],
			noTextInButtons: true,
		});
	});

	test('the host only accepts a copy request of the right shape and size', () => {
		assert.deepStrictEqual([
			paradisReadCodeCopyRequest({ __paradisCopyCode: 'a\tb\n', id: 3 }),
			paradisReadCodeCopyRequest({ __paradisCopyCode: 1, id: 3 }),
			paradisReadCodeCopyRequest({ __paradisCopyCode: 'a', id: '3' }),
			paradisReadCodeCopyRequest({ __paradisCopyCode: 'a', id: 1.5 }),
			paradisReadCodeCopyRequest({ __paradisCopyCode: 'x'.repeat(PARADIS_CODE_COPY_MAX_CHARS + 1), id: 1 }),
			paradisReadCodeCopyRequest('text'),
			paradisReadCodeCopyRequest(null),
		], [{ id: 3, text: 'a\tb\n' }, undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});

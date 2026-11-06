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
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { renderMarkdownDocument } from '../../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { parseParadisTokenizedCode, renderParadisMarkdownDocument, renderParadisMarkdownDocumentDeferred } from '../../browser/paradisMarkdownDocumentRenderer.js';
import { markedMermaidExtension } from '../../browser/paradisMarkdownMermaid.js';

/** 調査のベンチで使った文書の 1 節（見出し・段落・リンク・箇条書き・表・コード・引用）。 */
function section(index: number): string {
	return [
		`## ${index}. 経路の段 ${index} の説明`,
		'',
		'本文です。`renderDocument` が [リンク](https://example.com/x) と [相対リンク](./docs/page.md) を書き換えます。',
		'',
		'- 項目 A: `setInput` から `renderResource` まで',
		'- 項目 B: **強調** と ~~取り消し~~ と *斜体*',
		'  - 入れ子の項目',
		'',
		'| 段 | 時間 | 備考 |',
		'|---|---:|---|',
		`| 読み込み | ${index} ms | \`IPC\` |`,
		'| 変換 | 2 ms | <b>marked</b> |',
		'',
		'```ts',
		'export async function render(text: string): Promise<string> {',
		'\tif (text.length > 1024 && text.includes("<")) {',
		'\t\treturn `<div>${text}</div>`;',
		'\t}',
		'\treturn text;',
		'}',
		'```',
		'',
		'> 引用の中のコード:',
		'> ```',
		'> plain & <code>',
		'> ```',
		'',
	].join('\n');
}

const DOCUMENTS: Record<string, string> = {
	'sections': Array.from({ length: 30 }, (_, index) => section(index)).join('\n'),
	'images': Array.from({ length: 5 }, (_, index) => `${section(index)}\n![図${index}](./img/p${index}.png)\n\n<img src="./img/raw.png" alt="raw">\n`).join('\n'),
	'mermaid': Array.from({ length: 3 }, (_, index) => `${section(index)}\n\`\`\`mermaid\nflowchart LR\n  A[開く] --> B{変換}\n  B -->|marked| C["<b>sanitize</b>"]\n\`\`\`\n`).join('\n'),
	'lists and references': [
		'1. 番号付き',
		'   ```js',
		'   const a = 1 < 2;',
		'   ```',
		'2. 二つ目 [参照][ref]',
		'   - [ ] チェック',
		'   - [x] 済み',
		'',
		'<details><summary>開く</summary>',
		'',
		'```python',
		'print("x")',
		'```',
		'',
		'</details>',
		'',
		'見出し',
		'===',
		'',
		'```unknown-lang {.class}',
		'raw & text',
		'```',
		'',
		'[ref]: https://example.com/ref "title"',
	].join('\n'),
	// 利用者の文字が色付けの結果に入る経路（言語名・コードの中身）に、HTML として働きうるものを入れる。
	'hostile code and languages': [
		'```"><img src=x onerror=alert(1)>',
		'</code></pre><script>alert(1)</script><img src=x onerror=alert(2)>',
		'```',
		'',
		'```ts" onclick="alert(3)',
		'&lt;b&gt;already &amp; escaped&lt;/b&gt; & raw <b>bold</b> "quotes" \'single\'',
		'```',
		'',
		'```javascript:alert(4)',
		'\ttab\u00a0nbsp\u3000全角 😀 \u200b zero-width',
		'```',
		'',
		'```sh',
		'```',
		'',
		'- 箇条書きの中',
		'  ```py',
		'  <iframe srcdoc="<script>alert(5)</script>"></iframe>',
		'  ```',
		'',
		'> ```css',
		'> </div></span><br/><span class="x" onmouseover="alert(6)">',
		'> ```',
		'',
		'```ts',
		'nul \u0000 inside and a lone surrogate \ud800 here',
		'```',
		'',
		'```ts',
		'crlf line\r\nnext line\rlast',
		'```',
	].join('\n'),
};

/** 消毒済みの HTML を解析した body。 */
function parseBody(html: TrustedHTML): HTMLElement {
	return new DOMParser().parseFromString(html as unknown as string, 'text/html').body;
}

suite('paradisMarkdownDocumentRenderer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let extensionService: IExtensionService;
	let languageService: ILanguageService;

	setup(() => {
		instantiationService = createCodeEditorServices(store);
		// コードの色付けは拡張機能の登録を待つ。テストのサービスには無いので、すぐ済んだことにする。
		extensionService = { whenInstalledExtensionsRegistered: () => Promise.resolve(true) } as unknown as IExtensionService;
		languageService = instantiationService.get(ILanguageService);
	});

	test('returns the same HTML as the upstream renderMarkdownDocument', async () => {
		const results: Record<string, boolean> = {};
		for (const [name, text] of Object.entries(DOCUMENTS)) {
			const upstream = await renderMarkdownDocument(text, extensionService, languageService, {
				sanitizerConfig: { allowRelativeMediaPaths: true, allowRelativeLinkPaths: true },
				markedExtensions: [markedMermaidExtension()],
			});
			const paradis = await renderParadisMarkdownDocument(text, extensionService, languageService, {
				allowRelativeMediaPaths: true,
				allowRelativeLinkPaths: true,
				markedExtensions: [markedMermaidExtension()],
			});
			results[name] = upstream.toString() === paradis.toString() && paradis.toString().length > 0;
		}
		assert.deepStrictEqual(results, { 'sections': true, 'images': true, 'mermaid': true, 'lists and references': true, 'hostile code and languages': true });
	});

	test('inserting the highlighted code after sanitizing gives the same tree as sanitizing everything', async () => {
		const options = { allowRelativeMediaPaths: true, allowRelativeLinkPaths: true, markedExtensions: [markedMermaidExtension()] };
		const results: Record<string, { same: boolean; sanitizedWithCode: number; inserted: number; scripts: number; handlers: number }> = {};
		for (const [name, text] of Object.entries(DOCUMENTS)) {
			const whole = parseBody(await renderParadisMarkdownDocument(text, extensionService, languageService, options));
			const deferred = await renderParadisMarkdownDocumentDeferred(text, extensionService, languageService, options);
			const body = parseBody(deferred.html);
			// 消毒に通した色付けのコードの数と、後から差し込んだ数（差し込みを本当に通っていること）。
			const sanitizedWithCode = body.querySelectorAll('.monaco-tokenized-source').length;
			deferred.insertHighlightedCode(body);
			results[name] = {
				same: body.innerHTML === whole.innerHTML && body.innerHTML.length > 0,
				sanitizedWithCode,
				inserted: body.querySelectorAll('.monaco-tokenized-source').length - sanitizedWithCode,
				scripts: body.querySelectorAll('script, iframe, img[onerror]').length,
				handlers: [...body.querySelectorAll('*')].filter(element => [...element.attributes].some(attribute => attribute.name.startsWith('on'))).length,
			};
		}
		const safe = { same: true, sanitizedWithCode: 0, scripts: 0, handlers: 0 };
		assert.deepStrictEqual(results, {
			'sections': { ...safe, inserted: 60 },
			'images': { ...safe, inserted: 10 },
			'mermaid': { ...safe, inserted: 6 },
			'lists and references': { ...safe, inserted: 3 },
			// NUL と対の無いサロゲートを含むコードは、解析で形が変わるので差し込まずに消毒へ回す。
			'hostile code and languages': { ...safe, sanitizedWithCode: 1, inserted: 7 },
		});
	});

	test('falls back to sanitizing everything when a marker is not in a text node', async () => {
		const options = { allowRelativeMediaPaths: true, allowRelativeLinkPaths: true, markedExtensions: [markedMermaidExtension()] };
		const text = DOCUMENTS['lists and references'];
		const whole = parseBody(await renderParadisMarkdownDocument(text, extensionService, languageService, options));
		const deferred = await renderParadisMarkdownDocumentDeferred(text, extensionService, languageService, options);
		const body = parseBody(deferred.html);
		// 印を属性へ移す（文字列では 1 回ずつ数えられるが、text node としては見つからない状態）。
		const code = body.querySelector('pre > code')!;
		code.setAttribute('title', code.textContent ?? '');
		code.textContent = '\n';
		deferred.insertHighlightedCode(body);
		assert.deepStrictEqual({ same: body.innerHTML === whole.innerHTML, code: body.querySelectorAll('.monaco-tokenized-source').length }, { same: true, code: 3 });
	});

	test('only the fixed shape of tokenizeToString is inserted without sanitizing', () => {
		const open = '<div class="monaco-tokenized-source">';
		const inputs: Record<string, string> = {
			plain: `${open}<span class="mtk1">a &lt;b&gt; &amp; "c"</span><br/><span class="mtk5 mtki"></span></div>`,
			otherElement: `${open}<img src=x></div>`,
			extraAttribute: `${open}<span class="mtk1" onclick="x">a</span></div>`,
			otherClassCharacters: `${open}<span class="mtk1&quot;">a</span></div>`,
			otherEntity: `${open}<span class="mtk1">&quot;</span></div>`,
			rawAmpersand: `${open}<span class="mtk1">a & b</span></div>`,
			nul: `${open}<span class="mtk1">a\u0000b</span></div>`,
			loneSurrogate: `${open}<span class="mtk1">a\ud800b</span></div>`,
			unclosed: `${open}<span class="mtk1">a</div>`,
			trailing: `${open}</div><script></script>`,
		};
		const results: Record<string, unknown> = {};
		for (const [name, html] of Object.entries(inputs)) {
			results[name] = parseParadisTokenizedCode(html) ?? 'rejected';
		}
		assert.deepStrictEqual(results, {
			plain: [{ className: 'mtk1', text: 'a <b> & "c"' }, undefined, { className: 'mtk5 mtki', text: '' }],
			otherElement: 'rejected',
			extraAttribute: 'rejected',
			otherClassCharacters: 'rejected',
			otherEntity: 'rejected',
			rawAmpersand: 'rejected',
			nul: 'rejected',
			loneSurrogate: 'rejected',
			unclosed: 'rejected',
			trailing: 'rejected',
		});
	});
});

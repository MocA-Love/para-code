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
import { renderParadisMarkdownDocument } from '../../browser/paradisMarkdownDocumentRenderer.js';
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
};

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
		assert.deepStrictEqual(results, { 'sections': true, 'images': true, 'mermaid': true, 'lists and references': true });
	});
});

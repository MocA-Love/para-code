/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ok, strictEqual } from 'assert';
import * as marked from '../../../../../base/common/marked/marked.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { containsParadisMermaidBlock, markedMermaidExtension, paradisMarkdownCspContent, paradisNeutralizeScriptEnd } from '../../browser/paradisMarkdownMermaid.js';

suite('paradisMarkdownMermaid', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** marked を経由せずに renderer だけを直接呼ぶ（拡張単体の振る舞いを見るため）。 */
	function renderCode(token: Partial<marked.Tokens.Code>): string | false {
		const code = markedMermaidExtension().renderer?.code;
		ok(typeof code === 'function');
		// renderer の this は marked 本体のフォールバック renderer が入る場所なので、素の実体を渡す。
		return code.call(new marked.Renderer(), { type: 'code', raw: '', text: '', ...token });
	}

	suite('markedMermaidExtension', () => {

		test('renders a mermaid block as raw escaped text for mermaid.js to pick up', () => {
			strictEqual(
				renderCode({ lang: 'mermaid', text: 'graph TD;\n  A-->B;' }),
				'<pre class="paradis-mermaid mermaid">graph TD;\n  A--&gt;B;</pre>',
			);
		});

		test('accepts the language label regardless of case and surrounding whitespace', () => {
			for (const lang of ['mermaid', 'Mermaid', 'MERMAID', '  mermaid  ']) {
				strictEqual(renderCode({ lang, text: 'graph TD;' }), '<pre class="paradis-mermaid mermaid">graph TD;</pre>', lang);
			}
		});

		test('defers to the syntax highlighting renderer for every other block', () => {
			for (const lang of [undefined, '', 'ts', 'mermaidjs', 'not-mermaid']) {
				strictEqual(renderCode({ lang, text: 'graph TD;' }), false, String(lang));
			}
		});

		test('escapes diagram text so it cannot close the pre element or inject markup', () => {
			// ダイアグラム本文は生テキストとして webview に渡るので、ここでエスケープが漏れると
			// Markdown の中身がそのまま HTML として解釈されてしまう。引用符は要素の内容としては
			// 無害なため、エスケープ対象は `<` `>` `&` の3種だけで足りる。
			strictEqual(
				renderCode({ lang: 'mermaid', text: '</pre><img src=x onerror="alert(1)"> A&B' }),
				'<pre class="paradis-mermaid mermaid">&lt;/pre&gt;&lt;img src=x onerror="alert(1)"&gt; A&amp;B</pre>',
			);
		});

		test('does not escape twice when the highlighting path already escaped the text', () => {
			strictEqual(
				renderCode({ lang: 'mermaid', text: 'A--&gt;B', escaped: true }),
				'<pre class="paradis-mermaid mermaid">A--&gt;B</pre>',
			);
		});

		test('produces markup that containsParadisMermaidBlock recognizes through marked', () => {
			const parsed = new marked.Marked(markedMermaidExtension()).parse('```mermaid\ngraph TD;\n```\n', { async: false });
			ok(containsParadisMermaidBlock(parsed), parsed);
		});
	});

	suite('containsParadisMermaidBlock', () => {

		test('is true only for the class pair the renderer emits', () => {
			strictEqual(containsParadisMermaidBlock('<pre class="paradis-mermaid mermaid">graph TD;</pre>'), true);
			// 3.5MB の mermaid.js を読み込むかどうかの判定なので、単に mermaid という語が
			// 本文に出てくるだけで true になってはいけない。
			strictEqual(containsParadisMermaidBlock('<p>mermaid</p>'), false);
			strictEqual(containsParadisMermaidBlock('<pre class="mermaid">graph TD;</pre>'), false);
			strictEqual(containsParadisMermaidBlock(''), false);
		});
	});

	suite('paradisNeutralizeScriptEnd', () => {

		test('neutralizes every closing script tag spelling that would end the embedded script', () => {
			// mermaid.js 本体は <script> の本文としてそのまま埋め込むため、"</script" が残ると
			// そこで HTML パーサーがタグを閉じ、以降の初期化コードごと壊れる。大文字小文字を問わず
			// 閉じタグとして扱われるので、綴りに関わらず置き換える（置き換え後は小文字に揃う）。
			strictEqual(
				paradisNeutralizeScriptEnd('a = "</script>"; b = "</SCRIPT >"; c = "</ScRiPt";'),
				'a = "<\\/script>"; b = "<\\/script >"; c = "<\\/script";',
			);
		});

		test('leaves sources without a closing script tag untouched', () => {
			const source = 'const open = "<script>"; const path = "a/script";';
			strictEqual(paradisNeutralizeScriptEnd(source), source);
		});
	});

	suite('paradisMarkdownCspContent', () => {

		const NONCE = 'test-nonce';

		test('allows scripts only for documents that actually embed mermaid', () => {
			// mermaid を含まない文書まで script-src を開けると、`allowScripts` を有効にしている
			// 分の保証範囲が理由なく広がる。
			ok(!paradisMarkdownCspContent(NONCE, false).includes('script-src'));
			ok(paradisMarkdownCspContent(NONCE, true).includes(`script-src 'nonce-${NONCE}';`));
		});

		test('keeps the rest of the policy identical whether or not mermaid is enabled', () => {
			const base = `default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${NONCE}'; font-src https: data:;`;
			strictEqual(paradisMarkdownCspContent(NONCE, false), base);
			strictEqual(paradisMarkdownCspContent(NONCE, true), `${base} script-src 'nonce-${NONCE}';`);
		});

		test('never leaves default-src open', () => {
			for (const enabled of [false, true]) {
				ok(paradisMarkdownCspContent(NONCE, enabled).startsWith(`default-src 'none';`), String(enabled));
			}
		});
	});
});

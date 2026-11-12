// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { markdownContentSecurityPolicy, renderMarkdownSafely, sanitizeMarkdownRawHtml } from './markdownSafeHtml.js';

describe('Markdown の生の HTML を絞る', () => {
	test('許可したタグと属性だけを残し、外へ取りに行くものは出さない', () => {
		expect([
			sanitizeMarkdownRawHtml('<p align="center" onclick="x()" style="background:url(https://e.example/a)"><b>太字</b></p>'),
			sanitizeMarkdownRawHtml('<iframe src="https://e.example/"></iframe>後'),
			sanitizeMarkdownRawHtml('<form action="https://e.example/"><input name="q"><button>送る</button></form>'),
			sanitizeMarkdownRawHtml('<img src="https://e.example/a.png" alt="バッジ"> <img src=" //e.example/b.png"> <img src="data:image/png;base64,AA" alt="d">'),
			sanitizeMarkdownRawHtml('<script>alert(1)</script><style>p{}</style><!-- c -->残る'),
			sanitizeMarkdownRawHtml('<a href="java\tscript:alert(1)">x</a><a href="./doc.md#a">y</a>'),
			sanitizeMarkdownRawHtml('<details open><summary>開く</summary>a &amp; b < c &nbsp;</details>'),
			sanitizeMarkdownRawHtml('<a href="&#106;avascript:alert(1)">x</a><img src="&#104;ttps://e.example/x.png" alt="外">'),
		]).toEqual([
			'<p align="center"><b>太字</b></p>',
			'後',
			'送る',
			'<span class="ext-img">バッジ</span>  <img src="data:image/png;base64,AA" alt="d">',
			'残る',
			'<a>x</a><a href="./doc.md#a">y</a>',
			'<details open=""><summary>開く</summary>a &amp; b &lt; c &nbsp;</details>',
			'<a>x</a><span class="ext-img">外</span>',
		]);
	});

	test('Markdown の画像も、外のものは代わりの文字にする', () => {
		expect([
			renderMarkdownSafely('![CI](https://e.example/badge.svg)'),
			renderMarkdownSafely('![](https://e.example/badge.svg)'),
			renderMarkdownSafely('![図](./a.png)'),
		]).toEqual([
			'<p><span class="ext-img">CI</span></p>\n',
			'<p></p>\n',
			'<p><img src="./a.png" alt="図"></p>\n',
		]);
	});

	test('CSP は nonce の有無に関わらず外の画像とフレームとフォームを止める', () => {
		const nonce = '0123456789abcdef0123456789abcdef';
		expect([markdownContentSecurityPolicy(), markdownContentSecurityPolicy(nonce)]).toEqual([
			`script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; media-src data: blob:`,
			`script-src 'nonce-${nonce}'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; media-src data: blob:`,
		]);
	});
});

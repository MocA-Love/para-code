/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDocAnchorFunctions, PARADIS_DOC_ANCHOR_FUNCTIONS, paradisCreateDocAnchor } from '../../common/paradisDocCommentAnchor.js';

/** ページに埋める文字列そのものを動かす。 */
const fn: IParadisDocAnchorFunctions = new Function(`return ${PARADIS_DOC_ANCHOR_FUNCTIONS};`)();

/** 描いた後の本文の文字（節ごとの文を空白でつないだもの）。 */
function body(...blocks: string[]): string {
	return fn.normalize(blocks.join(' '));
}

/** `text` の中の `quote`（`nth` 番目）に付けたコメントの位置。 */
function anchorAt(text: string, quote: string, nth = 0, selector?: string) {
	let start = text.indexOf(quote);
	for (let i = 0; i < nth; i++) {
		start = text.indexOf(quote, start + 1);
	}
	assert.ok(start >= 0, `quote not in text: ${quote}`);
	return paradisCreateDocAnchor(text, start, start + quote.length, selector);
}

/** 当て直した範囲の文字と、当たり方。 */
function resolved(text: string, anchor: ReturnType<typeof anchorAt>, hint?: { start: number; end: number }) {
	const r = fn.resolve(text, anchor, hint);
	return r ? { text: text.slice(r.start, r.end), start: r.start, match: r.match, ambiguous: !!r.ambiguous } : null;
}

const INTRO = '概要 この資料は 2026 年度の売上の見通しをまとめたものです。';
const SALES = '売上 売上は前年比 12% 増加した。主因は新規顧客の獲得である。';
const COST = '費用 費用は前年並みで、広告費だけが 8% 増えた。';
const RISK = 'リスク 為替の変動が最大のリスクである。';

suite('Paradis doc comment anchor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the quote stays put when a section is added before it', () => {
		const before = body(INTRO, SALES, COST);
		const anchor = anchorAt(before, '主因は新規顧客の獲得である');
		const after = body('はじめに 先に読んでほしい注意書きを足しました。', INTRO, SALES, COST);
		assert.deepStrictEqual(resolved(after, anchor), {
			text: '主因は新規顧客の獲得である',
			start: after.indexOf('主因は新規顧客の獲得である'),
			match: 'exact',
			ambiguous: false,
		});
	});

	test('the same sentence in two places is told apart by its context, then by the selector', () => {
		const same = '詳細は別紙を参照。';
		const text = body(INTRO, `${SALES} ${same}`, `${COST} ${same}`, RISK);
		const first = anchorAt(text, same, 0);
		const second = anchorAt(text, same, 1);
		const moved = body('追加の節 新しい段落です。', INTRO, `${SALES} ${same}`, `${COST} ${same}`, RISK);
		// 文脈が同じ 2 か所（前後の文字まで同じ）は、セレクタの要素の範囲で決める。無ければ ambiguous
		const twins = body('A 同じ文。', 'A 同じ文。');
		const twin = paradisCreateDocAnchor(twins, twins.lastIndexOf('同じ文。'), twins.length);
		const bare = { quote: '同じ文。' };
		assert.deepStrictEqual({
			first: resolved(moved, first)?.start,
			second: resolved(moved, second)?.start,
			twinByContext: resolved(twins, twin)?.start,
			bareNoHint: resolved(twins, bare),
			bareWithHint: resolved(twins, bare, { start: 7, end: twins.length }),
		}, {
			first: moved.indexOf(same),
			second: moved.lastIndexOf(same),
			twinByContext: twins.lastIndexOf('同じ文。'),
			bareNoHint: { text: '同じ文。', start: 2, match: 'exact', ambiguous: true },
			bareWithHint: { text: '同じ文。', start: 9, match: 'exact', ambiguous: false },
		});
	});

	test('a partly rewritten quote is found between its context, or from the part that survived', () => {
		const before = body(INTRO, SALES, COST);
		const anchor = anchorAt(before, '売上は前年比 12% 増加した。');
		const numberChanged = body(INTRO, SALES.replace('12%', '15%'), COST);
		// 前の文脈ごと書き換わった（節の見出しが替わった）ので、残った後半から決める
		const headChanged = body(INTRO, '売上高 売上は前年比 12% 増加した見込み。主因は新規顧客の獲得である。', COST);
		assert.deepStrictEqual({
			numberChanged: resolved(numberChanged, anchor),
			headChanged: resolved(headChanged, { quote: '当期の売上は前年比 12% 増加した' }),
		}, {
			numberChanged: { text: '売上は前年比 15% 増加した。', start: numberChanged.indexOf('売上は前年比 15%'), match: 'fuzzy', ambiguous: false },
			headChanged: { text: '上高 売上は前年比 12% 増加した', start: headChanged.indexOf('上高 売上は'), match: 'fuzzy', ambiguous: false },
		});
	});

	test('a removed element and a rewritten document leave the comment without a position', () => {
		const before = body(INTRO, SALES, COST, RISK);
		const anchor = anchorAt(before, '費用は前年並みで、広告費だけが 8% 増えた。', 0, 'main > section:nth-of-type(3) > p');
		const removed = body(INTRO, SALES, RISK);
		const rewritten = body('Summary This document was rewritten from scratch in another language.', 'Nothing of the old text is left.');
		const rewrittenButKept = body('新しい構成 全体を書き直しました。', '第 1 章 費用は前年並みで、広告費だけが 8% 増えた。という点は変わりません。');
		assert.deepStrictEqual({
			removed: resolved(removed, anchor),
			rewritten: resolved(rewritten, anchor),
			rewrittenButKept: resolved(rewrittenButKept, anchor)?.match,
		}, {
			removed: null,
			rewritten: null,
			rewrittenButKept: 'exact',
		});
	});

	test('Markdown: the rendered text holds a quote that crosses inline markup, the source lines do not', () => {
		const source = [
			'# 見通し',
			'',
			'売上は**前年比 12%** 増加した。[詳細](./detail.md)を参照。',
			'',
			'- 新規顧客の獲得',
			'- `churn` の低下',
		].join('\n');
		const rendered = body('見通し', '売上は前年比 12% 増加した。詳細を参照。', '新規顧客の獲得', 'churn の低下');
		const quote = '前年比 12% 増加した。詳細を参照';
		assert.deepStrictEqual({
			inRendered: rendered.includes(quote),
			inSource: fn.normalize(source).includes(quote),
			// 記法を外した元の行には当たる（何行目かをエージェントに伝える材料にはなる）
			inStrippedLine: source.split('\n').findIndex(line => fn.fragmentToText(line, 'markdown').includes(quote)) + 1,
		}, {
			inRendered: true,
			inSource: false,
			inStrippedLine: 3,
		});
	});

	test('an Edit old_string is located in the rendered text (Markdown syntax and HTML tags removed)', () => {
		const markdownText = body('見通し', '売上は前年比 12% 増加した。詳細を参照。', '新規顧客の獲得', 'churn の低下', '項目 値', '売上 120', '費用 80');
		const htmlText = body('売上の見通し', '売上は前年比 12% 増加した。', '主因は新規顧客の獲得である。', 'A & B < C');
		const cut = (text: string, r: ReturnType<IParadisDocAnchorFunctions['locate']>) => r ? { text: text.slice(r.start, r.end), match: r.match, lines: `${r.matchedLines}/${r.totalLines}` } : null;
		assert.deepStrictEqual({
			paragraph: cut(markdownText, fn.locate(markdownText, '売上は**前年比 12%** 増加した。[詳細](./detail.md)を参照。', 'markdown')),
			headingAndList: cut(markdownText, fn.locate(markdownText, '- 新規顧客の獲得\n- `churn` の低下', 'markdown')),
			table: cut(markdownText, fn.locate(markdownText, '| 項目 | 値 |\n| --- | --- |\n| 売上 | 120 |', 'markdown')),
			html: cut(htmlText, fn.locate(htmlText, '<section class="sales">\n  <p>売上は<strong>前年比 12%</strong> 増加した。</p>\n  <p>主因は新規顧客の獲得である。</p>', 'html')),
			htmlEntities: cut(htmlText, fn.locate(htmlText, '<p>A &amp; B &lt; C</p>', 'html')),
			// 属性だけの変更（文字が無い）と、本文に無い文字は見つからない
			attributeOnly: cut(htmlText, fn.locate(htmlText, '<div class="card" style="color: red">', 'html')),
			missing: cut(htmlText, fn.locate(htmlText, '<p>ここには無い文</p>', 'html')),
			// 一部の行だけが本文にある（書き換えの途中など）
			partial: cut(htmlText, fn.locate(htmlText, '<p>主因は新規顧客の獲得である。</p>\n<p>まだ描かれていない行</p>', 'html')),
		}, {
			paragraph: { text: '売上は前年比 12% 増加した。詳細を参照。', match: 'exact', lines: '1/1' },
			headingAndList: { text: '新規顧客の獲得 churn の低下', match: 'exact', lines: '2/2' },
			table: { text: '項目 値 売上 120', match: 'exact', lines: '2/2' },
			html: { text: '売上は前年比 12% 増加した。 主因は新規顧客の獲得である。', match: 'exact', lines: '2/2' },
			htmlEntities: { text: 'A & B < C', match: 'exact', lines: '1/1' },
			attributeOnly: null,
			missing: null,
			partial: { text: '主因は新規顧客の獲得である。', match: 'partial', lines: '1/2' },
		});
	});
});

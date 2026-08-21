/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 控えの性質を固定する。**こぼれの申告が嘘になっていないこと**が主眼。
//
// ここが嘘をつくと、歯抜けの画面を何事も無かった顔で見せることになる。見た人は出ていないものを
// 「出なかった」と読むので、無言で誤った結論へ導く類の壊れ方になる。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisPtyScrollback } from '../../node/paradisPtyScrollback.js';

/** 実装が使っている上限。ここを直値で持つのは、**実装とずれたら気づきたい**から。 */
const LIMIT = 10 * 1024 * 1024;

function joined(scrollback: ParadisPtyScrollback): string {
	return scrollback.frames().map(frame => frame.data).join('');
}

suite('ParadisPtyScrollback', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('大きさの変わり目でコマを分け、渡しても控えは残る', () => {
		const scrollback = new ParadisPtyScrollback(80, 24);
		scrollback.handleData('before');
		scrollback.handleResize(100, 30);
		scrollback.handleData('after');

		const first = scrollback.frames();
		const second = scrollback.frames();

		assert.deepStrictEqual(
			{ first: first.map(f => [f.cols, f.rows, f.data]), sameAgain: JSON.stringify(second) === JSON.stringify(first), dropped: scrollback.dropped },
			{
				first: [[80, 24, 'before'], [100, 30, 'after']],
				// 繋ぎ直しは何度でも起こる。2つ目のウィンドウに空を見せない。
				sameAgain: true,
				dropped: false,
			},
		);
	});

	test('上限ちょうどではこぼしたと言わず、超えたら言う', () => {
		const exact = new ParadisPtyScrollback(80, 24);
		exact.handleData('x'.repeat(LIMIT));

		const over = new ParadisPtyScrollback(80, 24);
		over.handleData('x'.repeat(LIMIT));
		over.handleData('!');

		assert.deepStrictEqual(
			{ atLimit: exact.dropped, overLimit: over.dropped, keptLength: joined(over).length },
			{
				// 超えた分だけ削るので、ちょうどでは1文字も捨てていない。
				atLimit: false,
				overLimit: true,
				// 捨てるのは古い方から。持つ量は上限のまま。
				keptLength: LIMIT,
			},
		);
	});

	test('こぼれるのは古い方からで、新しい出力は残る', () => {
		const scrollback = new ParadisPtyScrollback(80, 24);
		scrollback.handleData('OLDEST');
		scrollback.handleData('x'.repeat(LIMIT));
		scrollback.handleData('NEWEST');

		const kept = joined(scrollback);

		assert.deepStrictEqual(
			{ dropped: scrollback.dropped, keepsOldest: kept.includes('OLDEST'), keepsNewest: kept.endsWith('NEWEST') },
			{ dropped: true, keepsOldest: false, keepsNewest: true },
		);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileOpResults } from '../../common/paradisMobileOpResults.js';

suite('Paradis mobile op results', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じ端末の同じ opId には 1 回目の返事を返し（成功なら duplicate を足す）、別の端末・期限切れ・例外の後はやり直す', async () => {
		let now = 0;
		const results = new ParadisMobileOpResults(() => now, 2, 100);
		let runs = 0;
		const ok = async () => { runs++; return { t: 'x', applied: true }; };
		const refused = async () => { runs++; return { error: 'busy', code: 'busy' }; };
		const replies = [
			await results.run('phone-a', 'op-1', ok),
			await results.run('phone-a', 'op-1', ok),
			await results.run('phone-b', 'op-1', ok),
			await results.run('phone-a', 'op-2', refused),
			await results.run('phone-a', 'op-2', ok),
		];
		await results.run('phone-a', 'op-3', async () => { throw new Error('boom'); }).catch(() => undefined);
		const afterThrow = await results.run('phone-a', 'op-3', ok);
		now = 200;
		const afterExpiry = await results.run('phone-a', 'op-1', ok);
		assert.deepStrictEqual({ replies, afterThrow, afterExpiry, runs }, {
			replies: [
				{ t: 'x', applied: true },
				{ t: 'x', applied: true, duplicate: true },
				{ t: 'x', applied: true },
				{ error: 'busy', code: 'busy' },
				{ error: 'busy', code: 'busy' },
			],
			afterThrow: { t: 'x', applied: true },
			afterExpiry: { t: 'x', applied: true },
			runs: 5,
		});
	});

	// Bot の書き込み（登録表の `{ error, code }` で断る）と要対応の答え（`{ ok: false, reason }` で断る）が同じ約束を守る
	for (const shape of [
		{ name: 'bots', ok: { t: 'botUpdate', ok: true }, refused: { error: 'busy', code: 'busy' } },
		{ name: 'humanAskAnswer', ok: { t: 'humanAskAnswer', ok: true }, refused: { t: 'humanAskAnswer', ok: false, reason: 'busy' } },
	]) {
		test(`同じ約束: ${shape.name}（ok の再送は duplicate、断りは同じ断り、最中の再送は 1 回目を待つ、例外は忘れる、上限と期間）`, async () => {
			let now = 0;
			const results = new ParadisMobileOpResults<object>(() => now, 2, 100);
			let runs = 0;
			const ok = async () => { runs++; return shape.ok; };
			const refused = async () => { runs++; return shape.refused; };
			let release: (reply: object) => void = () => { };
			const first = results.run('phone', 'slow', () => { runs++; return new Promise<object>(resolve => release = resolve); });
			const inFlight = results.run('phone', 'slow', ok);
			release(shape.ok);
			const replies = [
				await first,
				await inFlight,
				await results.run('phone', 'ok', ok),
				await results.run('phone', 'ok', refused),
				await results.run('phone', 'no', refused),
				await results.run('phone', 'no', ok),
			];
			await results.run('phone', 'throw', async () => { runs++; throw new Error('boom'); }).catch(() => undefined);
			replies.push(await results.run('phone', 'throw', refused));
			// 上限 2 件: 'ok' はもう忘れている
			replies.push(await results.run('phone', 'ok', refused));
			// 期間 100: 'throw' は上限では残っているが、期限切れで忘れる
			now = 99;
			replies.push(await results.run('phone', 'throw', ok));
			now = 100;
			replies.push(await results.run('phone', 'throw', ok));
			const dup = { ...shape.ok, duplicate: true };
			assert.deepStrictEqual({ replies, runs }, {
				replies: [shape.ok, dup, shape.ok, dup, shape.refused, shape.refused, shape.refused, shape.refused, shape.refused, shape.ok],
				runs: 7,
			});
		});
	}
});

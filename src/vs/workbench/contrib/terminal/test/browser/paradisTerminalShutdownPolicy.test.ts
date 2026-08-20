/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ShutdownReason } from '../../../../services/lifecycle/common/lifecycle.js';
import {
	IParadisShutdownTerminal,
	IParadisTerminalShutdownPolicy,
	paradisPrepareTerminalShutdown,
	paradisRegisterTerminalShutdownPolicy,
	paradisShouldKeepTerminalProcessAlive,
	paradisShouldKeepTerminalProcessesAlive,
} from '../../browser/paradisTerminalShutdownPolicy.js';

const REMOTE_TERMINAL: IParadisShutdownTerminal = { hasRemoteAuthority: true, shouldPersist: true };
const LOCAL_TERMINAL: IParadisShutdownTerminal = { hasRemoteAuthority: false, shouldPersist: true };

function policy(overrides: Partial<IParadisTerminalShutdownPolicy>): IParadisTerminalShutdownPolicy {
	return {
		prepare: async () => { },
		shouldKeepProcessesAlive: () => false,
		shouldKeepProcessAlive: () => false,
		warn: () => { },
		...overrides,
	};
}

suite('ParadisTerminalShutdownPolicy', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('lets each place that can hold terminals answer for its own', async () => {
		// 接続先用とこの PC の常駐用が同時に居る状況。それぞれ自分の担当にだけ true を答える。
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			shouldKeepProcessesAlive: () => true,
			shouldKeepProcessAlive: (_reason, terminal) => terminal.hasRemoteAuthority,
		})));
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			shouldKeepProcessAlive: (_reason, terminal) => !terminal.hasRemoteAuthority,
		})));

		assert.deepStrictEqual(
			{
				window: paradisShouldKeepTerminalProcessesAlive(ShutdownReason.CLOSE),
				remote: paradisShouldKeepTerminalProcessAlive(ShutdownReason.CLOSE, REMOTE_TERMINAL),
				local: paradisShouldKeepTerminalProcessAlive(ShutdownReason.CLOSE, LOCAL_TERMINAL),
			},
			{ window: true, remote: true, local: true },
		);
	});

	test('one broken policy does not silence the others', async () => {
		// 投げるのはこのテストの狙いそのもの。実装は `onUnexpectedError` へ流して握り潰す
		// (閉じる処理を止めないため) ので、テスト側でも想定内として受け取る。
		const originalHandler = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(() => { });
		try {
			await assertBrokenPolicyIsIsolated();
		} finally {
			setUnexpectedErrorHandler(originalHandler);
		}
	});

	async function assertBrokenPolicyIsIsolated(): Promise<void> {
		const prepared: string[] = [];
		// 先に登録した方が投げる。包み方を誤ると、ここで残りの `prepare` が走らないまま先へ
		// 進み、尋ねてもいない答えで端末を畳むことになる。`paradisPrepareTerminalShutdown`
		// 自身が reject しないことも同時に見る (reject すると閉じる処理ごと巻き添えで飛ぶ)。
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			prepare: async () => { prepared.push('throws'); throw new Error('boom'); },
			shouldKeepProcessAlive: () => { throw new Error('boom'); },
		})));
		// **待たずに先へ進んでいないか**を見るための1本。`prepare` の中で一度手放すので、
		// 実装が呼ぶだけで待たなければ、下の `finished` は false のままになる。
		let finished = false;
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			prepare: async () => {
				prepared.push('slow');
				await timeout(0);
				finished = true;
			},
			shouldKeepProcessAlive: () => true,
		})));

		await paradisPrepareTerminalShutdown(ShutdownReason.CLOSE);

		assert.deepStrictEqual(
			{
				prepared: prepared.sort(),
				finished,
				keep: paradisShouldKeepTerminalProcessAlive(ShutdownReason.CLOSE, LOCAL_TERMINAL),
			},
			{ prepared: ['slow', 'throws'], finished: true, keep: true },
		);
	}

	test('asks one policy at a time, not all at once', async () => {
		// 並行に走らせると、画面に出ていないダイアログの待ち時間だけが減る。ダイアログは1つずつ
		// しか出ないので、後ろに並んだ役は表示される前に上限を使い切り、押した答えが捨てられる。
		// `Promise.all` に戻すと ['first:start', 'second:start', 'first:end'] になって落ちる。
		const order: string[] = [];
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			prepare: async () => { order.push('first:start'); await timeout(0); order.push('first:end'); },
		})));
		store.add(paradisRegisterTerminalShutdownPolicy(policy({
			prepare: async () => { order.push('second:start'); },
		})));

		await paradisPrepareTerminalShutdown(ShutdownReason.CLOSE);

		assert.deepStrictEqual(order, ['first:start', 'first:end', 'second:start']);
	});

	test('answers no once every policy has gone away', () => {
		// 判断役が居ないときは upstream の従来どおり (残さない) に倒れること。
		// `policies` はモジュール全体で共有なので、これは前のテストの後始末も見ている
		// (登録したまま dispose し忘れた役が居ると、ここが落ちる)。
		assert.deepStrictEqual(
			{
				window: paradisShouldKeepTerminalProcessesAlive(ShutdownReason.CLOSE),
				terminal: paradisShouldKeepTerminalProcessAlive(ShutdownReason.CLOSE, LOCAL_TERMINAL),
			},
			{ window: false, terminal: false },
		);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResetWebviewServiceWorkers } from '../../electron-main/paradisWebviewServiceWorkerReset.js';

/**
 * 起動時の service worker 掃除。ここが「消す対象を広げすぎる」「起動を止める」のどちらに転んでも
 * 影響が大きいので、渡す条件と失敗時の振る舞いだけを固定する。
 */
suite('ParadisWebviewServiceWorkerReset', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** `clearStorageData` だけを持つ最小のセッション。呼び出し内容を記録する。 */
	function createSession(behavior: () => Promise<void>): { session: Electron.Session; calls: Electron.ClearStorageDataOptions[] } {
		const calls: Electron.ClearStorageDataOptions[] = [];
		const session = {
			clearStorageData: (options?: Electron.ClearStorageDataOptions) => {
				calls.push(options ?? {});
				return behavior();
			}
		} as unknown as Electron.Session;
		return { session, calls };
	}

	/**
	 * `clearData`（新しい方の API）はカスタムスキームの登録を消せず、成功だけ返す。Electron 42.6.0 で
	 * 実測済みなので、うっかり乗り換えられないようここで呼び出しの形を固定する。
	 */
	test('clears service worker storage only, without narrowing to origins', async () => {
		const { session, calls } = createSession(() => Promise.resolve());

		await paradisResetWebviewServiceWorkers(session, new NullLogService());

		assert.deepStrictEqual(calls, [{ storages: ['serviceworkers'] }]);
	});

	test('does not throw when the session refuses to clear', async () => {
		const { session, calls } = createSession(() => Promise.reject(new Error('boom')));

		await paradisResetWebviewServiceWorkers(session, new NullLogService());

		assert.strictEqual(calls.length, 1);
	});
});

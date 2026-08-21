/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SERVICE_WORKER_RESET_KEY, PARADIS_SERVICE_WORKER_RESET_VERSION, paradisResetWebviewServiceWorkers } from '../../electron-main/paradisWebviewServiceWorkerReset.js';

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

	/** main プロセスの state の代わり。済み印だけを覚える。 */
	function createLedger(initial: Record<string, unknown> = {}) {
		const store = new Map<string, unknown>(Object.entries(initial));
		return {
			store,
			getItem: <T>(key: string, defaultValue: T): T => (store.has(key) ? store.get(key) as T : defaultValue),
			setItem: (key: string, data?: unknown) => { store.set(key, data); },
		};
	}

	/**
	 * `clearData`（新しい方の API）はカスタムスキームの登録を消せず、成功だけ返す。Electron 42.6.0 で
	 * 実測済みなので、うっかり乗り換えられないようここで呼び出しの形を固定する。
	 */
	test('clears service worker storage only, without narrowing to origins', async () => {
		const { session, calls } = createSession(() => Promise.resolve());

		await paradisResetWebviewServiceWorkers(session, new NullLogService(), createLedger());

		assert.deepStrictEqual(calls, [{ storages: ['serviceworkers'] }]);
	});

	test('does not throw when the session refuses to clear', async () => {
		const { session, calls } = createSession(() => Promise.reject(new Error('boom')));

		await paradisResetWebviewServiceWorkers(session, new NullLogService(), createLedger());

		assert.strictEqual(calls.length, 1);
	});

	test('clears once and then leaves later launches alone', async () => {
		const ledger = createLedger();
		const first = createSession(() => Promise.resolve());
		await paradisResetWebviewServiceWorkers(first.session, new NullLogService(), ledger);
		assert.strictEqual(first.calls.length, 1);
		assert.strictEqual(ledger.store.get(PARADIS_SERVICE_WORKER_RESET_KEY), PARADIS_SERVICE_WORKER_RESET_VERSION);

		// 同じ profile の次の起動。ここで消すと、開いた webview が毎回ゼロから登録し直すことになる。
		const second = createSession(() => Promise.resolve());
		await paradisResetWebviewServiceWorkers(second.session, new NullLogService(), ledger);
		assert.strictEqual(second.calls.length, 0);
	});

	test('tries again when the clear did not finish, so a full profile is not left dirty', async () => {
		const ledger = createLedger();
		// 時間切れ（解決しない）。消しきれたか分からない回を「済み」にしてはいけない。
		const stuck = createSession(() => new Promise<void>(() => { }));
		await paradisResetWebviewServiceWorkers(stuck.session, new NullLogService(), ledger, 10);
		assert.strictEqual(ledger.store.has(PARADIS_SERVICE_WORKER_RESET_KEY), false);

		const retry = createSession(() => Promise.resolve());
		await paradisResetWebviewServiceWorkers(retry.session, new NullLogService(), ledger);
		assert.strictEqual(retry.calls.length, 1);
	});

	test('runs again when the cleanup version is raised', async () => {
		const ledger = createLedger({ [PARADIS_SERVICE_WORKER_RESET_KEY]: PARADIS_SERVICE_WORKER_RESET_VERSION - 1 });
		const { session, calls } = createSession(() => Promise.resolve());

		await paradisResetWebviewServiceWorkers(session, new NullLogService(), ledger);

		assert.strictEqual(calls.length, 1);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisGithubMetricsService } from '../../node/paradisGithubMetricsChannel.js';

suite('ParadisGithubMetricsService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const RATE_LIMIT_JSON = JSON.stringify({
		resources: { core: { limit: 5000, used: 100, remaining: 4900, reset: 9_999 } },
	});

	/**
	 * `gh` の実行を差し替えたサービスを作る。実際の spawn は行わず、呼び出し回数と
	 * 与える結果をテストから制御する。
	 */
	function createService(behaviour: (invocation: number) => { stdout?: string; error?: NodeJS.ErrnoException }) {
		const state = { calls: 0, clock: 1_000_000 };
		const execFile = ((_file: string, _args: string[], _options: unknown, callback: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			state.calls++;
			const result = behaviour(state.calls);
			// 実物と同じく非同期にコールバックする
			setTimeout(() => callback(result.error ?? null, result.stdout ?? '', ''), 0);
			return undefined;
		}) as unknown as typeof cp.execFile;

		const service = new ParadisGithubMetricsService(
			new NullLogService(),
			undefined,
			undefined,
			execFile,
			() => state.clock,
			async () => ({}),
		);
		return { service, state };
	}

	test('fetches rate limits once and reuses them until the minimum interval passes', async () => {
		const { service, state } = createService(() => ({ stdout: RATE_LIMIT_JSON }));

		const first = await service.getSnapshot();
		state.clock += 10_000;
		await service.getSnapshot();
		state.clock += 60_000;
		const third = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			ghCalls: state.calls,
			rateLimits: first.rateLimits,
			// 最短間隔を過ぎた3回目で取り直し、取得時刻が進む
			refetchedAt: third.rateLimitFetchedAt,
			// レート枠取得そのものは枠を消費しないので呼び出し内訳には出さない
			operations: third.operations,
			error: third.rateLimitError,
		}, {
			ghCalls: 2,
			rateLimits: [{ resource: 'core', limit: 5000, used: 100, remaining: 4900, resetAt: 9_999_000 }],
			refetchedAt: 1_070_000,
			operations: [],
			error: undefined,
		});
	});

	test('forces a refetch even inside the minimum interval', async () => {
		const { service, state } = createService(() => ({ stdout: RATE_LIMIT_JSON }));

		await service.getSnapshot();
		await service.getSnapshot({ force: true });
		service.dispose();

		assert.strictEqual(state.calls, 2);
	});

	test('collapses concurrent requests into a single gh invocation', async () => {
		const { service, state } = createService(() => ({ stdout: RATE_LIMIT_JSON }));

		await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);
		service.dispose();

		assert.strictEqual(state.calls, 1);
	});

	test('stops spawning gh when it is not installed, but retries on an explicit refresh', async () => {
		const notFound: NodeJS.ErrnoException = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
		const { service, state } = createService(invocation => invocation === 1
			? { error: notFound }
			: { stdout: RATE_LIMIT_JSON });

		const first = await service.getSnapshot();
		state.clock += 3_600_000;
		await service.getSnapshot();
		// 明示的な更新だけは再確認する（あとから gh を入れた場合に再起動を強いない）
		const forced = await service.getSnapshot({ force: true });
		service.dispose();

		assert.deepStrictEqual({
			ghCalls: state.calls,
			unavailableAfterEnoent: first.ghAvailable,
			availableAfterForcedRetry: forced.ghAvailable,
			rateLimits: forced.rateLimits.map(entry => entry.resource),
		}, {
			// 2回目はスキップされ、3回目(force)だけが実行される
			ghCalls: 2,
			unavailableAfterEnoent: false,
			availableAfterForcedRetry: true,
			rateLimits: ['core'],
		});
	});

	test('records calls forwarded from a remote process (e.g. the Agent Sessions window)', async () => {
		const { service } = createService(() => ({ stdout: RATE_LIMIT_JSON }));

		service.recordCall({ at: 1_000_000, callSite: 'githubPRFetcher.reviewThreads', resource: 'graphql', durationMs: 40, success: true, rateLimited: false });
		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			callSites: snapshot.operations.map(operation => operation.callSite),
			resource: snapshot.operations[0]?.resource,
			spaceCount: snapshot.spaces.length,
		}, {
			callSites: ['githubPRFetcher.reviewThreads'],
			resource: 'graphql',
			spaceCount: 1,
		});
	});

	test('backs off while gh keeps failing (for example when it is not signed in)', async () => {
		const authError = new Error('gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable');
		const { service, state } = createService(() => ({ error: authError }));

		await service.getSnapshot();
		// 通常の最短間隔(45秒)は過ぎているが、1回失敗しているので1分は待つ
		state.clock += 50_000;
		await service.getSnapshot();
		const afterBackoff = state.calls;
		state.clock += 70_000;
		await service.getSnapshot();
		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			callsDuringBackoff: afterBackoff,
			callsAfterBackoff: state.calls,
			error: snapshot.rateLimitError,
			ghAvailable: snapshot.ghAvailable,
		}, {
			callsDuringBackoff: 1,
			callsAfterBackoff: 2,
			error: authError.message,
			ghAvailable: true,
		});
	});
});

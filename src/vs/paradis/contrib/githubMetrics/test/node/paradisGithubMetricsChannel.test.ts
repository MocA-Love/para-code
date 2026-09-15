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

	/** 1回の更新で走るプローブの本数（core と graphql）。 */
	const PROBES_PER_REFRESH = 2;

	const MONITOR_SPACE = '\u0000rate-limit-monitor';
	const UNSCOPED_SPACE = '\u0000agent-sessions';
	const CORE_CALL_SITE = 'gh api user (rate limit probe)';
	const GRAPHQL_CALL_SITE = 'gh api graphql (rate limit probe)';

	/** `gh api -i` と同じ形（ステータス行 + CRLF 区切りのヘッダ + 空行 + ボディ）で返す。 */
	function headerResponse(limit: number, remaining: number, used: number, reset: number): string {
		return [
			'HTTP/2.0 200 OK',
			`X-Ratelimit-Limit: ${limit}\r`,
			`X-Ratelimit-Remaining: ${remaining}\r`,
			`X-Ratelimit-Used: ${used}\r`,
			`X-Ratelimit-Reset: ${reset}\r`,
			'\r',
			'',
		].join('\n');
	}

	/** 引数からどちらのプローブかを見分けて、それらしいレスポンスを返す。 */
	function respondToProbe(args: readonly string[]): string {
		return args.includes('graphql')
			? headerResponse(5000, 3180, 1820, 2_000)
			: headerResponse(5000, 4900, 100, 9_999);
	}

	const OK_CORE = { resource: 'core', limit: 5000, remaining: 4900, used: 100, resetAt: 9_999_000 };
	const OK_GRAPHQL = { resource: 'graphql', limit: 5000, remaining: 3180, used: 1820, resetAt: 2_000_000 };

	/**
	 * `gh` の実行を差し替えたサービスを作る。実際の spawn は行わず、呼び出し回数と
	 * 与える結果をテストから制御する。
	 */
	function createService(behaviour: (invocation: number, args: readonly string[]) => { stdout?: string; error?: NodeJS.ErrnoException }) {
		const state = { calls: 0, clock: 1_000_000 };
		const execFile = ((_file: string, args: string[], _options: unknown, callback: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			state.calls++;
			const result = behaviour(state.calls, args);
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

	function okService() {
		return createService((_invocation, args) => ({ stdout: respondToProbe(args) }));
	}

	test('reads both resources from the response headers and reuses them until the minimum interval passes', async () => {
		const { service, state } = okService();

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
			error: third.rateLimitError,
		}, {
			ghCalls: 2 * PROBES_PER_REFRESH,
			rateLimits: [OK_CORE, OK_GRAPHQL],
			refetchedAt: 1_070_000,
			error: undefined,
		});
	});

	test('counts its own probes in the call breakdown, because they consume the budget', async () => {
		const { service } = okService();

		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			callSites: snapshot.operations.map(operation => operation.callSite).sort(),
			calls: snapshot.totals.rolling5mCalls,
			failures: snapshot.totals.rolling5mFailures,
			// Agent Sessions ウィンドウの消費とは混ぜず、監視専用のスペースへ入れる
			spaces: snapshot.spaces.map(space => space.space),
		}, {
			callSites: [GRAPHQL_CALL_SITE, CORE_CALL_SITE].sort(),
			calls: PROBES_PER_REFRESH,
			failures: 0,
			spaces: [MONITOR_SPACE],
		});
	});

	test('keeps the last known value of a resource whose probe fails', async () => {
		let graphqlFails = false;
		const { service, state } = createService((_invocation, args) => graphqlFails && args.includes('graphql')
			? { error: new Error('gh: GraphQL: Bad credentials') }
			: { stdout: respondToProbe(args) });

		await service.getSnapshot();
		graphqlFails = true;
		state.clock += 60_000;
		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			// graphql の行が消えると「枠が読めない」ではなく「枠が無い」ように見えてしまう
			rateLimits: snapshot.rateLimits,
			error: snapshot.rateLimitError,
		}, {
			rateLimits: [OK_CORE, OK_GRAPHQL],
			error: 'gh: GraphQL: Bad credentials',
		});
	});

	test('drops a kept value once its window has reset', async () => {
		let graphqlFails = false;
		const { service, state } = createService((_invocation, args) => graphqlFails && args.includes('graphql')
			? { error: new Error('gh: GraphQL: Bad credentials') }
			: { stdout: respondToProbe(args) });

		await service.getSnapshot();
		graphqlFails = true;
		// graphql の resetAt(2_000_000)を過ぎると、その remaining はもう何も意味しない
		state.clock = 2_100_000;
		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual(snapshot.rateLimits.map(entry => entry.resource), ['core']);
	});

	test('reads the headers of a 403 response, so an exhausted budget is visible', async () => {
		// 枠を使い切ると gh は非0終了するが、レスポンスには残量0とリセット時刻が載っている
		const { service } = createService((_invocation, args) => args.includes('graphql')
			? { stdout: respondToProbe(args) }
			: { stdout: headerResponse(5000, 0, 5000, 4_000), error: new Error('gh: API rate limit exceeded') });

		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			core: snapshot.rateLimits.find(entry => entry.resource === 'core'),
			rateLimited: snapshot.operations.find(operation => operation.callSite === CORE_CALL_SITE)?.session.rateLimited,
		}, {
			core: { resource: 'core', limit: 5000, remaining: 0, used: 5000, resetAt: 4_000_000 },
			rateLimited: 1,
		});
	});

	test('does not fill the error list with probes that never reached GitHub', async () => {
		const { service } = createService(() => ({ error: new Error('gh: To use GitHub CLI, run: gh auth login') }));

		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			// 枠を使っていない失敗まで数えると、ユーザー自身の gh の失敗が内訳から押し出される
			lastErrors: snapshot.lastErrors,
			operations: snapshot.operations,
			error: snapshot.rateLimitError,
		}, {
			lastErrors: [],
			operations: [],
			error: 'gh: To use GitHub CLI, run: gh auth login',
		});
	});

	test('reports a missing header block as an error instead of a full budget', async () => {
		const { service } = createService(() => ({ stdout: '{"login":"octocat"}' }));

		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			rateLimits: snapshot.rateLimits,
			hasError: snapshot.rateLimitError !== undefined,
		}, {
			rateLimits: [],
			hasError: true,
		});
	});

	test('forces a refetch even inside the minimum interval', async () => {
		const { service, state } = okService();

		await service.getSnapshot();
		await service.getSnapshot({ force: true });
		service.dispose();

		assert.strictEqual(state.calls, 2 * PROBES_PER_REFRESH);
	});

	test('collapses concurrent requests into a single round of probes', async () => {
		const { service, state } = okService();

		await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);
		service.dispose();

		assert.strictEqual(state.calls, PROBES_PER_REFRESH);
	});

	test('stops spawning gh when it is not installed, but retries on an explicit refresh', async () => {
		const notFound: NodeJS.ErrnoException = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
		const { service, state } = createService((invocation, args) => invocation <= PROBES_PER_REFRESH
			? { error: notFound }
			: { stdout: respondToProbe(args) });

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
			// 2回目はスキップされ、3回目(force)のプローブだけが実行される
			ghCalls: 2 * PROBES_PER_REFRESH,
			unavailableAfterEnoent: false,
			availableAfterForcedRetry: true,
			rateLimits: ['core', 'graphql'],
		});
	});

	test('records calls forwarded from a remote process (e.g. the Agent Sessions window)', async () => {
		const { service } = okService();

		service.recordCall({ at: 1_000_000, callSite: 'githubPRFetcher.reviewThreads', resource: 'graphql', durationMs: 40, success: true, rateLimited: false });
		const snapshot = await service.getSnapshot();
		service.dispose();

		assert.deepStrictEqual({
			forwarded: snapshot.operations.find(operation => operation.callSite === 'githubPRFetcher.reviewThreads')?.resource,
			// 転送された呼び出し（worktree 無し）と監視自身のプローブは別のスペースに分かれる
			spaces: snapshot.spaces.map(space => space.space).sort(),
		}, {
			forwarded: 'graphql',
			spaces: [MONITOR_SPACE, UNSCOPED_SPACE].sort(),
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
			callsDuringBackoff: PROBES_PER_REFRESH,
			callsAfterBackoff: 2 * PROBES_PER_REFRESH,
			error: authError.message,
			ghAvailable: true,
		});
	});
});

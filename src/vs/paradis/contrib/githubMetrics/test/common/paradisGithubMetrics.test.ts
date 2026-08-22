/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisGithubCallEvent,
	paradisCoerceGithubCallEvent,
	paradisGithubCallSiteFromArgs,
	paradisGithubFormatCountdown,
	paradisGithubSeverity,
	paradisGithubWorstRemainingRatio,
	paradisIsGithubNoPullRequestMessage,
	paradisIsGithubRateLimitMessage,
	paradisParseGhRateLimit,
	paradisRedactHomePath,
	ParadisGithubCallLog,
	ParadisGithubRateLimitHistory,
	PARADIS_GITHUB_UNSCOPED_SPACE,
} from '../../common/paradisGithubMetrics.js';

suite('ParadisGithubMetrics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const RATE_LIMIT_JSON = JSON.stringify({
		resources: {
			core: { limit: 5000, used: 769, remaining: 4231, reset: 1000 },
			graphql: { limit: 5000, used: 1820, remaining: 3180, reset: 2000 },
			search: { limit: 30, used: 0, remaining: 30, reset: 1100 },
			broken: { limit: 0, remaining: 0, reset: 1000 },
		},
	});

	test('parses gh api rate_limit output and drops unusable resources', () => {
		assert.deepStrictEqual(paradisParseGhRateLimit(RATE_LIMIT_JSON), [
			{ resource: 'core', limit: 5000, remaining: 4231, used: 769, resetAt: 1_000_000 },
			{ resource: 'graphql', limit: 5000, remaining: 3180, used: 1820, resetAt: 2_000_000 },
			{ resource: 'search', limit: 30, remaining: 30, used: 0, resetAt: 1_100_000 },
		]);
	});

	test('returns nothing for malformed output', () => {
		assert.deepStrictEqual({
			notJson: paradisParseGhRateLimit('gh: command failed'),
			noResources: paradisParseGhRateLimit('{"message":"Bad credentials"}'),
			empty: paradisParseGhRateLimit(''),
		}, {
			notJson: [],
			noResources: [],
			empty: [],
		});
	});

	test('summarizes the worst primary resource for the status bar', () => {
		const entries = paradisParseGhRateLimit(RATE_LIMIT_JSON);
		assert.deepStrictEqual({
			// search(30/30 = 100%) は代表値に含めない。graphql の 63.6% が最小
			worst: paradisGithubWorstRemainingRatio(entries)?.toFixed(3),
			none: paradisGithubWorstRemainingRatio([]),
			severityOk: paradisGithubSeverity(0.8),
			severityWarning: paradisGithubSeverity(0.25),
			severityCritical: paradisGithubSeverity(0.05),
			severityUnknown: paradisGithubSeverity(undefined),
		}, {
			worst: '0.636',
			none: undefined,
			severityOk: 'ok',
			severityWarning: 'warning',
			severityCritical: 'critical',
			severityUnknown: 'ok',
		});
	});

	test('formats countdowns', () => {
		assert.deepStrictEqual({
			seconds: paradisGithubFormatCountdown(9_000),
			minutes: paradisGithubFormatCountdown(134_000),
			hours: paradisGithubFormatCountdown(3_723_000),
			past: paradisGithubFormatCountdown(-5_000),
		}, {
			seconds: '0:09',
			minutes: '2:14',
			hours: '1:02:03',
			past: '0:00',
		});
	});

	test('derives call site names without leaking path arguments', () => {
		assert.deepStrictEqual({
			prView: paradisGithubCallSiteFromArgs(['pr', 'view', '--json', 'number,title']),
			rateLimit: paradisGithubCallSiteFromArgs(['api', 'rate_limit']),
			apiPath: paradisGithubCallSiteFromArgs(['api', 'repos/acme/secret-project/pulls/7']),
			flagFirst: paradisGithubCallSiteFromArgs(['--version']),
		}, {
			prView: 'gh pr view',
			rateLimit: 'gh api rate_limit',
			apiPath: 'gh api repos/…',
			flagFirst: 'gh',
		});
	});

	test('classifies gh failure messages', () => {
		assert.deepStrictEqual({
			noPr: paradisIsGithubNoPullRequestMessage('no pull requests found for branch "feature/x"'),
			noOpenPr: paradisIsGithubNoPullRequestMessage('no open pull requests found'),
			otherFailure: paradisIsGithubNoPullRequestMessage('could not resolve to a Repository'),
			primaryLimit: paradisIsGithubRateLimitMessage('API rate limit exceeded for user'),
			secondaryLimit: paradisIsGithubRateLimitMessage('You have exceeded a secondary rate limit'),
			unrelated: paradisIsGithubRateLimitMessage('connection refused'),
			undefinedMessage: paradisIsGithubRateLimitMessage(undefined),
		}, {
			noPr: true,
			noOpenPr: true,
			otherFailure: false,
			primaryLimit: true,
			secondaryLimit: true,
			unrelated: false,
			undefinedMessage: false,
		});
	});

	test('aggregates calls per caller for the session and the rolling window', () => {
		const now = 10_000_000;
		const log = new ParadisGithubCallLog(now - 3_600_000);
		// 5分窓の外(10分前)、1時間窓の中
		log.record({ at: now - 600_000, callSite: 'gh pr view', resource: 'core', durationMs: 100, success: true, rateLimited: false, worktreePath: '/w/old' });
		// 5分窓の中
		log.record({ at: now - 60_000, callSite: 'gh pr view', resource: 'core', durationMs: 200, success: true, rateLimited: false, worktreePath: '/w/a' });
		log.record({ at: now - 30_000, callSite: 'gh pr view', resource: 'core', durationMs: 400, success: false, rateLimited: true, errorMessage: 'API rate limit exceeded', worktreePath: '/w/a' });
		log.record({ at: now - 10_000, callSite: 'gh api rate_limit', resource: 'core', durationMs: 50, success: true, rateLimited: false });
		// worktree に紐付かない呼び出し（Agent Sessionsウィンドウ相当）。graphql資源。
		log.record({ at: now - 20_000, callSite: 'githubPRFetcher.reviewThreads', resource: 'graphql', durationMs: 80, success: true, rateLimited: false });

		const snapshot = log.snapshot(now);
		assert.deepStrictEqual({
			totals: snapshot.totals,
			// 直近5分の多い順に並ぶ
			order: snapshot.operations.map(operation => operation.callSite),
			prView: snapshot.operations.find(operation => operation.callSite === 'gh pr view'),
			errors: snapshot.lastErrors,
			spaceOrder: snapshot.spaces.map(space => space.space),
			worktreeA: snapshot.spaces.find(space => space.space === '/w/a'),
			unscoped: snapshot.spaces.find(space => space.space === PARADIS_GITHUB_UNSCOPED_SPACE),
		}, {
			totals: {
				sessionCalls: 5,
				sessionFailures: 1,
				rolling5mCalls: 4,
				rolling5mFailures: 1,
				rolling5mRateLimited: 1,
			},
			order: ['gh pr view', 'gh api rate_limit', 'githubPRFetcher.reviewThreads'],
			prView: {
				callSite: 'gh pr view',
				resource: 'core',
				session: { calls: 3, failures: 1, rateLimited: 1, avgDurationMs: 700 / 3, maxDurationMs: 400, lastRunAt: now - 30_000 },
				rolling5m: { calls: 2, failures: 1, rateLimited: 1, avgDurationMs: 300, maxDurationMs: 400, lastRunAt: now - 30_000 },
				rolling1h: { calls: 3, failures: 1, rateLimited: 1, avgDurationMs: 700 / 3, maxDurationMs: 400, lastRunAt: now - 30_000 },
				lastRunAt: now - 30_000,
				lastErrorAt: now - 30_000,
				lastErrorMessage: 'API rate limit exceeded',
				topWorktreePath: '/w/a',
			},
			errors: [{ at: now - 30_000, callSite: 'gh pr view', message: 'API rate limit exceeded', worktreePath: '/w/a' }],
			spaceOrder: ['/w/a', PARADIS_GITHUB_UNSCOPED_SPACE, '/w/old'],
			worktreeA: {
				space: '/w/a',
				session: { calls: 2, failures: 1, rateLimited: 1, avgDurationMs: 300, maxDurationMs: 400, lastRunAt: now - 30_000 },
				rolling5m: { calls: 2, failures: 1, rateLimited: 1, avgDurationMs: 300, maxDurationMs: 400, lastRunAt: now - 30_000 },
				rolling1h: { calls: 2, failures: 1, rateLimited: 1, avgDurationMs: 300, maxDurationMs: 400, lastRunAt: now - 30_000 },
				topCallSite: 'gh pr view',
				coreRatio: 1,
				rolling5mCoreRatio: 1,
				rolling1hCoreRatio: 1,
			},
			unscoped: {
				space: PARADIS_GITHUB_UNSCOPED_SPACE,
				session: { calls: 2, failures: 0, rateLimited: 0, avgDurationMs: 65, maxDurationMs: 80, lastRunAt: now - 10_000 },
				rolling5m: { calls: 2, failures: 0, rateLimited: 0, avgDurationMs: 65, maxDurationMs: 80, lastRunAt: now - 10_000 },
				rolling1h: { calls: 2, failures: 0, rateLimited: 0, avgDurationMs: 65, maxDurationMs: 80, lastRunAt: now - 10_000 },
				topCallSite: 'gh api rate_limit',
				coreRatio: 0.5,
				rolling5mCoreRatio: 0.5,
				rolling1hCoreRatio: 0.5,
			},
		});
	});

	test('coerces IPC-sourced call events and rejects malformed ones', () => {
		const valid = paradisCoerceGithubCallEvent({
			at: 1000, callSite: 'githubPRFetcher.reviewThreads', resource: 'graphql', durationMs: 42, success: true, rateLimited: false,
		});
		assert.deepStrictEqual(valid, {
			at: 1000, callSite: 'githubPRFetcher.reviewThreads', resource: 'graphql', durationMs: 42,
			success: true, rateLimited: false, errorMessage: undefined, worktreePath: undefined,
		});

		// 負のdurationMsはクランプされる、不要なフィールドは無視される
		const clamped = paradisCoerceGithubCallEvent({ at: 1, callSite: 'x', resource: 'core', durationMs: -5, success: true, rateLimited: false, extra: 'ignored' });
		assert.strictEqual(clamped?.durationMs, 0);

		assert.deepStrictEqual({
			notAnObject: paradisCoerceGithubCallEvent('nope'),
			null: paradisCoerceGithubCallEvent(null),
			missingAt: paradisCoerceGithubCallEvent({ callSite: 'x', resource: 'core', durationMs: 1, success: true, rateLimited: false }),
			nanAt: paradisCoerceGithubCallEvent({ at: NaN, callSite: 'x', resource: 'core', durationMs: 1, success: true, rateLimited: false }),
			badResource: paradisCoerceGithubCallEvent({ at: 1, callSite: 'x', resource: 'rest', durationMs: 1, success: true, rateLimited: false }),
			emptyCallSite: paradisCoerceGithubCallEvent({ at: 1, callSite: '', resource: 'core', durationMs: 1, success: true, rateLimited: false }),
			missingDuration: paradisCoerceGithubCallEvent({ at: 1, callSite: 'x', resource: 'core', success: true, rateLimited: false }),
		}, {
			notAnObject: undefined,
			null: undefined,
			missingAt: undefined,
			nanAt: undefined,
			badResource: undefined,
			emptyCallSite: undefined,
			missingDuration: undefined,
		});

		// callSiteは長さ上限で切り詰められる
		const longCallSite = paradisCoerceGithubCallEvent({ at: 1, callSite: 'x'.repeat(500), resource: 'core', durationMs: 1, success: true, rateLimited: false });
		assert.strictEqual(longCallSite?.callSite.length, 200);

		// worktreePathも長さ上限で切り詰められる
		const longWorktree = paradisCoerceGithubCallEvent({ at: 1, callSite: 'x', resource: 'core', durationMs: 1, success: true, rateLimited: false, worktreePath: `/w/${'b'.repeat(500)}` });
		assert.strictEqual(longWorktree?.worktreePath?.length, 200);
	});

	test('caps the per-call-site worktree breakdown and truncates same-process long paths', () => {
		const now = 10_000_000;
		const log = new ParadisGithubCallLog(now - 3_600_000);
		const event = (worktreePath: string): IParadisGithubCallEvent => ({ at: now, callSite: 'gh pr view', resource: 'core', durationMs: 10, success: true, rateLimited: false, worktreePath });
		for (let i = 0; i < 250; i++) {
			log.record(event(`/w/site-${i}`));
		}
		// 上限(200)到達後の新規パスは内訳に載らないが、既存パスの再カウントは生きる
		log.record(event('/w/site-7'));
		log.record(event('/w/site-7'));
		log.record(event('/w/after-cap'));

		const prView = log.snapshot(now).operations.find(operation => operation.callSite === 'gh pr view');
		assert.strictEqual(prView?.session.calls, 253);
		assert.strictEqual(prView?.topWorktreePath, '/w/site-7');

		// record 直呼び（同一プロセス）でも長いパスは lastErrors 向けに丸められる
		log.record({ at: now, callSite: 'gh other', resource: 'core', durationMs: 1, success: false, rateLimited: false, errorMessage: 'boom', worktreePath: `/w/${'c'.repeat(500)}` });
		const [lastError] = log.snapshot(now).lastErrors;
		assert.strictEqual(lastError.worktreePath?.length, 200);
	});

	test('derives consumption and exhaustion estimates from rate limit samples', () => {
		const now = 10_000_000;
		const history = new ParadisGithubRateLimitHistory();
		const sample = (remaining: number, resetAt: number) => [{ resource: 'core', limit: 5000, used: 5000 - remaining, remaining, resetAt }];

		history.record(sample(5000, now + 3_600_000), now - 180_000);
		history.record(sample(4940, now + 3_600_000), now - 120_000);
		history.record(sample(4900, now + 3_600_000), now - 60_000);
		history.record(sample(4880, now + 3_600_000), now);

		const [core] = history.consumption(now);
		assert.deepStrictEqual({
			resource: core.resource,
			// 直近5分＝3区間分すべて (60 + 40 + 20)
			rolling5m: core.rolling5m,
			rolling1h: core.rolling1h,
			// 120 / 3分 = 40 req/min
			perMinute: core.perMinute,
			series: core.series,
			// 4880 / 40 = 122分 > リセットまでの60分なので「枯渇しない」
			exhaustionEtaMs: core.exhaustionEtaMs,
		}, {
			resource: 'core',
			rolling5m: 120,
			rolling1h: 120,
			perMinute: 40,
			series: [60, 40, 20],
			exhaustionEtaMs: undefined,
		});
	});

	test('counts only post-reset usage across a window reset, and keeps it out of the pace', () => {
		const now = 10_000_000;
		const history = new ParadisGithubRateLimitHistory();
		const sample = (remaining: number, resetAt: number) => [{ resource: 'core', limit: 5000, used: 5000 - remaining, remaining, resetAt }];

		// 残量が増えた区間＝枠のリセットを跨いだので、リセット後に減った分(5000-4600=400)だけ数える
		history.record(sample(200, now - 60_000), now - 120_000);
		history.record(sample(4600, now + 600_000), now - 60_000);

		const [core] = history.consumption(now);
		assert.deepStrictEqual({
			// 消費量としては数える(リセット後に 400 使われたことは分かる)
			rolling5m: core.rolling5m,
			// ただし「その400をこの区間で使った」わけではないので、ペースと枯渇予測の母数からは外す
			perMinute: core.perMinute,
			hasEta: core.exhaustionEtaMs !== undefined,
		}, {
			rolling5m: 400,
			perMinute: undefined,
			hasEta: false,
		});
	});

	test('does not let a long gap between samples flood the 5 minute window', () => {
		const now = 10_000_000;
		const history = new ParadisGithubRateLimitHistory();
		const sample = (remaining: number) => [{ resource: 'core', limit: 5000, used: 5000 - remaining, remaining, resetAt: now + 3_600_000 }];

		// UI が閉じている間はサンプリングされないので、2時間ぶりの1件が来ることがある。
		// その 1,200 リクエストを丸ごと「直近5分の消費」に数えてはいけない
		history.record(sample(5000), now - 7_200_000);
		history.record(sample(3800), now);

		const [core] = history.consumption(now);
		assert.deepStrictEqual({
			// 5分 / 120分 = 1/24 の按分
			rolling5m: core.rolling5m,
			rolling1h: core.rolling1h,
			perMinute: core.perMinute,
		}, {
			rolling5m: 50,
			rolling1h: 600,
			perMinute: 10,
		});
	});

	test('trims the event buffer without breaking the rolling window', () => {
		const now = 10_000_000;
		const log = new ParadisGithubCallLog(now - 3_600_000);
		// 上限(2000)を超えて記録しても、直近5分の集計は最新のイベントを反映し続ける
		for (let i = 0; i < 2500; i++) {
			log.record({ at: now - 2500 + i, callSite: 'gh pr view', resource: 'core', durationMs: 10, success: true, rateLimited: false });
		}

		const snapshot = log.snapshot(now);
		assert.deepStrictEqual({
			sessionCalls: snapshot.totals.sessionCalls,
			rolling5mCalls: snapshot.totals.rolling5mCalls,
		}, {
			// セッション累計は集計値なので全件、ローリングは保持している 2000 件分
			sessionCalls: 2500,
			rolling5mCalls: 2000,
		});
	});

	test('clips long error messages and redacts home directories', () => {
		const now = 10_000_000;
		const log = new ParadisGithubCallLog(now);
		log.record({ at: now, callSite: 'gh pr view', resource: 'core', durationMs: 10, success: false, rateLimited: false, errorMessage: 'x'.repeat(900) });

		const [error] = log.snapshot(now).lastErrors;
		assert.deepStrictEqual({
			messageLength: error.message.length,
			endsWithEllipsis: error.message.endsWith('…'),
			home: paradisRedactHomePath('/Users/example/projects/repo', '/Users/example'),
			otherPath: paradisRedactHomePath('/opt/work/repo', '/Users/example'),
			noHome: paradisRedactHomePath('/opt/work/repo', undefined),
		}, {
			messageLength: 501,
			endsWithEllipsis: true,
			home: '~/projects/repo',
			otherPath: '/opt/work/repo',
			noHome: '/opt/work/repo',
		});
	});
});

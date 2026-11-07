/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisGithubRateLimitPause } from '../../../githubMetrics/common/paradisGithubRateLimitPause.js';
import { PARADIS_TASKS_CACHE_TTL_MS, paradisTasksCoerceSearchRequest, ParadisTasksGithubService } from '../../node/paradisTasksGithub.sharedProcess.js';

function response(numbers: number[], remaining = 4000): string {
	return JSON.stringify({
		data: {
			search: {
				issueCount: numbers.length,
				pageInfo: { hasNextPage: false, endCursor: null },
				nodes: numbers.map(number => ({
					__typename: 'Issue', number, title: `t${number}`, url: `https://github.com/a/b/issues/${number}`, state: 'OPEN', stateReason: null,
					updatedAt: '2026-11-08T00:00:00Z', repository: { nameWithOwner: 'a/b' }, author: { login: 'me' }, comments: { totalCount: 0 },
					assignees: { nodes: [{ login: 'me', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
				})),
			},
			rateLimit: { limit: 5000, remaining, resetAt: '2026-11-08T01:00:00Z' },
		},
	});
}

suite('ParadisTasksGithubService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// 同じ要求は相乗りし、60 秒はキャッシュから返す。更新（force）は読み直す。要求の文字列は repo: を付けた 1 本
	test('shares requests and caches for 60 seconds', async () => {
		let now = 1_000_000;
		const calls: string[] = [];
		const service = store.add(new ParadisTasksGithubService(async args => {
			calls.push(args.find(arg => arg.startsWith('q='))!);
			return { stdout: response([1, 2]), stderr: '', failed: false, notFound: false };
		}, new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		const request = { mode: 'issue' as const, repositories: ['c/d', 'a/b'], query: 'is:issue is:open' };
		const [first, second] = await Promise.all([service.search(request), service.search(request)]);
		now += PARADIS_TASKS_CACHE_TTL_MS - 1;
		await service.search(request);
		await service.search({ ...request, force: true });
		assert.deepStrictEqual({
			calls,
			same: first === second,
			numbers: first.ok ? first.result.items.map(item => [item.number, item.assignees[0].login, item.labels[0].name]) : [],
		}, {
			calls: ['q=is:issue is:open repo:a/b repo:c/d archived:false', 'q=is:issue is:open repo:a/b repo:c/d archived:false'],
			same: true,
			numbers: [[1, 'me', 'bug'], [2, 'me', 'bug']],
		});
	});

	// 枠を使い切ったら止め、止めている間は gh を起動しない。gh が無い・ログインしていないは別の理由で返す
	test('stops on rate limit and reports gh problems', async () => {
		const now = 1_000_000;
		let output: { stdout: string; stderr: string; failed: boolean; notFound: boolean; timedOut?: boolean } = { stdout: '', stderr: 'GraphQL: API rate limit exceeded for user', failed: true, notFound: false };
		let calls = 0;
		const service = store.add(new ParadisTasksGithubService(async () => {
			calls++;
			return output;
		}, new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		const limited = await service.search({ mode: 'pr', repositories: ['a/b'], query: '' });
		const paused = await service.search({ mode: 'pr', repositories: ['a/b'], query: 'is:open' });
		const service2 = store.add(new ParadisTasksGithubService(async () => output, new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		output = { stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', failed: true, notFound: false };
		const auth = await service2.search({ mode: 'issue', repositories: ['a/b'], query: '' });
		output = { stdout: '', stderr: '', failed: true, notFound: true };
		const noGh = await service2.search({ mode: 'issue', repositories: ['a/b'], query: 'x' });
		output = { stdout: '', stderr: '', failed: true, notFound: false, timedOut: true };
		const timedOut = await service2.search({ mode: 'issue', repositories: ['a/b'], query: 'y' });
		const none = await service2.search({ mode: 'issue', repositories: [], query: '' });
		assert.deepStrictEqual({
			kinds: [limited, paused, auth, noGh, timedOut].map(result => result.ok ? 'ok' : result.error.kind),
			calls,
			none: none.ok ? none.result.items.length : -1,
		}, {
			kinds: ['rate-limited', 'rate-limited', 'auth', 'no-gh', 'timeout'],
			calls: 1,
			none: 0,
		});
	});

	// 窓から届いた値は型が保証されないので、知らない値は空にして受ける
	test('coerces requests from the window', () => {
		assert.deepStrictEqual([
			paradisTasksCoerceSearchRequest({ mode: 'pr', repositories: ['a/b', 3], query: 'is:open', force: true }),
			paradisTasksCoerceSearchRequest(undefined),
		], [
			{ mode: 'pr', repositories: ['a/b'], query: 'is:open', after: undefined, force: true },
			{ mode: 'issue', repositories: [], query: '', after: undefined, force: false },
		]);
	});
});

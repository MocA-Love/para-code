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
import { PARADIS_TASKS_CACHE_TTL_MS, PARADIS_TASKS_PROJECTS_CACHE_TTL_MS, paradisTasksCoerceProjectItemsRequest, paradisTasksCoerceSearchRequest, ParadisTasksGithubService, paradisTasksProjectsQuery } from '../../node/paradisTasksGithub.sharedProcess.js';

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

	// プロジェクトの一覧は 1 回で読み、リポジトリにつながったものを先に、重ねず、閉じたものを後ろに並べる。5 分は使い回す
	test('lists projects once and caches them for 5 minutes', async () => {
		let now = 1_000_000;
		const queries: string[] = [];
		const project = (owner: string, number: number, closed = false) => ({ number, title: `${owner}-${number}`, url: `https://github.com/orgs/${owner}/projects/${number}`, closed, owner: { login: owner }, views: { nodes: [{ number: 1, name: 'Roadmap', layout: 'ROADMAP_LAYOUT', filter: null }, { number: 2, name: 'Me', layout: 'TABLE_LAYOUT', filter: 'assignee:@me' }] } });
		const service = store.add(new ParadisTasksGithubService(async args => {
			queries.push(args.find(arg => arg.startsWith('query='))!);
			return {
				stdout: JSON.stringify({
					data: {
						viewer: { projectsV2: { nodes: [project('me', 1), project('org', 7)] } },
						r0: { projectsV2: { nodes: [project('org', 7)] }, owner: { projectsV2: { nodes: [project('org', 3, true), project('org', 7)] } } },
						rateLimit: { limit: 5000, remaining: 4999, resetAt: '2026-11-08T01:00:00Z' },
					}
				}), stderr: '', failed: false, notFound: false,
			};
		}, new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		const first = await service.listProjects({ repositories: ['org/app'] });
		now += PARADIS_TASKS_PROJECTS_CACHE_TTL_MS - 1;
		await service.listProjects({ repositories: ['org/app'] });
		assert.deepStrictEqual({
			calls: queries.length,
			repositoryInQuery: queries[0].includes('r0: repository(owner: "org", name: "app")'),
			projects: first.ok ? first.result.projects.map(entry => [entry.owner, entry.number, entry.closed, entry.views.map(view => [view.name, view.layout, view.filter])]) : [],
		}, {
			calls: 1,
			repositoryInQuery: true,
			projects: [
				['org', 7, false, [['Roadmap', 'ROADMAP_LAYOUT', undefined], ['Me', 'TABLE_LAYOUT', 'assignee:@me']]],
				['me', 1, false, [['Roadmap', 'ROADMAP_LAYOUT', undefined], ['Me', 'TABLE_LAYOUT', 'assignee:@me']]],
				['org', 3, true, [['Roadmap', 'ROADMAP_LAYOUT', undefined], ['Me', 'TABLE_LAYOUT', 'assignee:@me']]],
			],
		});
	});

	// 項目はビューの絞り込みと人の絞り込みをつないで 1 回で読み、欄の値・下書き・アーカイブ済みを扱う
	test('reads project items with the view filter', async () => {
		const now = 1_000_000;
		const variables: string[][] = [];
		const service = store.add(new ParadisTasksGithubService(async args => {
			variables.push(args.filter(arg => /^(owner|number|view|q|n)=/.test(arg)));
			return {
				stdout: JSON.stringify({
					data: {
						repositoryOwner: {
							projectV2: {
								title: 'Roadmap', url: 'https://github.com/orgs/org/projects/7',
								view: { number: 2, name: 'Board', layout: 'BOARD_LAYOUT', filter: 'is:open', fields: { nodes: [{ name: 'Title', dataType: 'TITLE' }, { name: 'Status', dataType: 'SINGLE_SELECT', options: [{ name: 'Todo', color: 'GRAY' }] }, { name: 'Due', dataType: 'DATE' }] }, verticalGroupByFields: { nodes: [{ name: 'Status' }] }, groupByFields: { nodes: [] } },
								items: {
									totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [
										{
											id: 'i1', isArchived: false, content: { __typename: 'Issue', number: 5, title: 'fix', url: 'https://github.com/org/app/issues/5', state: 'OPEN', updatedAt: '2026-11-08T00:00:00Z', repository: { nameWithOwner: 'org/app' }, assignees: { nodes: [] }, labels: { nodes: [] } },
											fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', color: 'GRAY', field: { name: 'Status' } }, { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-11-20', field: { name: 'Due' } }, { __typename: 'ProjectV2ItemFieldUserValue' }] }
										},
										{ id: 'i2', isArchived: false, content: { __typename: 'DraftIssue', title: 'idea', updatedAt: '2026-11-07T00:00:00Z', assignees: { nodes: [{ login: 'me' }] } }, fieldValues: { nodes: [] } },
										{ id: 'i3', isArchived: true, content: { __typename: 'Issue', number: 6, title: 'old', url: 'u', state: 'CLOSED', updatedAt: '2026-11-01T00:00:00Z', repository: { nameWithOwner: 'org/app' } }, fieldValues: { nodes: [] } },
									]
								},
							}
						},
						rateLimit: { limit: 5000, remaining: 4990, resetAt: '2026-11-08T01:00:00Z' },
					}
				}), stderr: '', failed: false, notFound: false,
			};
		}, new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		const response = await service.projectItems(paradisTasksCoerceProjectItemsRequest([{ owner: 'org', number: 7, view: 2, viewFilter: 'is:open', query: 'status:Todo' }][0]));
		const invalid = await service.projectItems({ owner: 'bad owner', number: 7, view: 2 });
		assert.deepStrictEqual({
			variables,
			result: response.ok ? {
				layout: response.result.view.layout,
				columnField: response.result.columnField,
				items: response.result.items.map(entry => [entry.id, entry.kind, entry.number, entry.values]),
				next: [response.result.hasNextPage, response.result.endCursor],
			} : response.error,
			invalid: invalid.ok ? 'ok' : invalid.error.kind,
		}, {
			variables: [['owner=org', 'number=7', 'view=2', 'n=50', 'q=is:open status:Todo']],
			result: {
				layout: 'BOARD_LAYOUT',
				columnField: 'Status',
				items: [
					['i1', 'issue', 5, { Status: { text: 'Todo', color: 'GRAY' }, Due: { text: '2026-11-20', date: '2026-11-20' } }],
					['i2', 'draft', undefined, {}],
				],
				next: [true, 'c1'],
			},
			invalid: 'failed',
		});
	});

	// リポジトリの名前は形を確かめたものだけを問い合わせに埋める
	test('only embeds checked repository names in the projects query', () => {
		const query = paradisTasksProjectsQuery(['a/b', 'x") { evil }', 'c/d']);
		assert.deepStrictEqual([query.includes('r0: repository(owner: "a", name: "b")'), query.includes('r1: repository(owner: "c", name: "d")'), query.includes('evil')], [true, true, false]);
	});

	// errors のある応答: 権限不足は専用の理由、検索は失敗、プロジェクトの一覧は読めた分を出し、何も無ければ失敗
	test('handles GraphQL errors next to data', async () => {
		const now = 1_000_000;
		const outputs = [
			{ stdout: JSON.stringify({ data: { viewer: { projectsV2: null } }, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes' }] }), stderr: 'gh: Your token has not been granted the required scopes', failed: true, notFound: false },
			{ stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [] } }, errors: [{ type: 'NOT_FOUND', message: 'x' }] }), stderr: '', failed: true, notFound: false },
			{ stdout: JSON.stringify({ data: { viewer: { projectsV2: { nodes: [{ number: 1, title: 'p', url: 'u', closed: false, owner: { login: 'me' }, views: { nodes: [] } }] } }, r0: null }, errors: [{ type: 'FORBIDDEN', message: 'org' }] }), stderr: '', failed: true, notFound: false },
			{ stdout: JSON.stringify({ data: { viewer: { projectsV2: { nodes: [] } }, r0: null }, errors: [{ type: 'FORBIDDEN', message: 'org' }] }), stderr: '', failed: true, notFound: false },
			{ stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { title: 't', url: 'u', view: null } } }, errors: [{ type: 'NOT_FOUND', message: 'no view' }] }), stderr: '', failed: true, notFound: false },
		];
		let index = 0;
		const service = store.add(new ParadisTasksGithubService(async () => outputs[index++], new NullLogService(), new ParadisGithubRateLimitPause(() => now), () => now));
		const results = [
			await service.listProjects({ repositories: ['a/b'] }),
			await service.search({ mode: 'issue', repositories: ['a/b'], query: '' }),
			await service.listProjects({ repositories: ['a/c'] }),
			await service.listProjects({ repositories: ['a/d'] }),
			await service.projectItems({ owner: 'a', number: 1, view: 9 }),
		];
		assert.deepStrictEqual(results.map(result => result.ok ? 'ok' : `${result.error.kind}:${result.error.message.includes('NOT_FOUND') || result.error.message.includes('FORBIDDEN') || result.error.message.includes('scopes')}`), [
			'scope:true',
			'failed:true',
			'ok',
			'failed:true',
			'failed:true',
		]);
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { GitHubClient, GitHubError, classifyRateLimit, redactGitHubSecrets, type FetchLike } from '../server/github.js';
import { GitHubSync } from '../server/githubSync.js';

type Reply = { status: number; headers?: Record<string, string>; body?: string };

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

/** 呼ばれた要求を残し、reply が返す応答を返す偽の fetch。 */
function fakeFetch(reply: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Reply | Promise<Reply>) {
	const calls: { url: string; method: string; auth: string; etag?: string; body?: string }[] = [];
	const fetchLike: FetchLike = async (url, init) => {
		calls.push({ url, method: init.method, auth: init.headers['authorization'], etag: init.headers['if-none-match'], body: init.body });
		const r = await reply(url, init);
		return { status: r.status, headers: headers(r.headers), text: async () => r.body ?? '' };
	};
	return { fetchLike, calls };
}

const ok = (data: unknown, h: Record<string, string> = {}): Reply => ({ status: 200, headers: h, body: JSON.stringify({ data }) });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('GitHubClient: 呼び出しをまとめる・数える', () => {
	test('同時に走る同じ GET・同じ query は 1 回にまとめ、mutation はまとめない', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => release = r);
		const { fetchLike, calls } = fakeFetch(async (url, init) => {
			await gate;
			return url.endsWith('/graphql') ? ok({ x: JSON.parse(init.body!).query.startsWith('mutation') ? 'm' : 'q' }) : { status: 200, body: '{"a":1}' };
		});
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike });
		const gets = [client.get('/repos/o/r'), client.get('/repos/o/r')];
		const queries = [client.graphql('query { x }'), client.graphql('query { x }')];
		const mutations = [client.graphql('mutation { x }'), client.graphql('mutation { x }')];
		await tick();
		release();
		await Promise.all([...gets, ...queries, ...mutations]);
		expect({
			sent: calls.map(c => c.url.endsWith('/graphql') ? JSON.parse(c.body!).query : c.url).sort(),
			requests: client.requestCount,
			deduped: client.dedupedCount,
		}).toEqual({
			sent: ['https://api.github.com/repos/o/r', 'mutation { x }', 'mutation { x }', 'query { x }'],
			requests: 4,
			deduped: 2,
		});
	});

	test('ETag を送り、304 は覚えた本文を返して残量はヘッダーの値のまま（消費しない）', async () => {
		const { fetchLike, calls } = fakeFetch((_url, init): Reply => init.headers['if-none-match'] === '"v1"'
			? { status: 304, headers: { 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '2000000000' } }
			: { status: 200, headers: { etag: '"v1"', 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '2000000000' }, body: '{"n":1}' });
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike });
		const first = await client.get('/repos/o/r/pulls/1');
		const second = await client.get('/repos/o/r/pulls/1');
		expect({ first, second, etags: calls.map(c => c.etag), remaining: client.rest?.remaining, notModified: client.notModifiedCount }).toEqual({
			first: { n: 1 }, second: { n: 1 }, etags: [undefined, '"v1"'], remaining: 4990, notModified: 1,
		});
	});
});

describe('GitHubClient: 上限で止まる・待つ', () => {
	test('primary limit はその枠（core）だけをリセットまで止め、GraphQL は止めない', async () => {
		let now = 1_000_000;
		const reset = Math.floor(now / 1000) + 120;
		const { fetchLike, calls } = fakeFetch(url => url.endsWith('/graphql') ? ok({ v: 1 })
			: calls.length === 1 ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' }, body: '{"message":"API rate limit exceeded"}' }
				: { status: 200, body: '{}' });
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike, now: () => now });
		const first = await client.get('/repos/o/r').catch((e: GitHubError) => e.kind);
		const blocked = await client.get('/repos/o/r/issues').catch((e: GitHubError) => e.kind);
		const sentWhileBlocked = calls.length;
		await client.graphql('query { v }');
		now = reset * 1000 + 1;
		await client.get('/repos/o/r/issues');
		expect({ first, blocked, sentWhileBlocked, total: calls.length }).toEqual({ first: 'budget', blocked: 'budget', sentWhileBlocked: 1, total: 3 });
	});

	test('secondary limit はアカウントごと止め、待つ時間が無ければ 60 秒待つ', async () => {
		let now = 5_000_000;
		const { fetchLike, calls } = fakeFetch(() => calls.length === 1
			? { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: '{"message":"You have exceeded a secondary rate limit."}' }
			: ok({ v: 1 }));
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike, now: () => now });
		const first = await client.postText('/markdown', { text: 'x' }).catch((e: GitHubError) => e.kind);
		const graphql = await client.graphql('query { v }').catch((e: GitHubError) => e.kind);
		const blockedFor = client.blockedUntil('graphql') - now;
		now += 60_001;
		await client.graphql('query { v }');
		expect({ first, graphql, blockedFor, total: calls.length }).toEqual({ first: 'budget', graphql: 'budget', blockedFor: 60_000, total: 2 });
	});

	test('GraphQL の RATE_LIMITED（200 で返る）は GraphQL をリセットまで止める', async () => {
		const now = 9_000_000;
		const { fetchLike, calls } = fakeFetch(url => url.endsWith('/graphql')
			? { status: 200, headers: { 'x-ratelimit-reset': String(Math.floor(now / 1000) + 300), 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' }, body: JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }) }
			: { status: 200, body: '{}' });
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike, now: () => now });
		const first = await client.graphql('query { v }').catch((e: GitHubError) => e.kind);
		const second = await client.graphql('query { w }').catch((e: GitHubError) => e.kind);
		await client.get('/repos/o/r');
		expect({ first, second, until: client.blockedUntil('graphql') - now, total: calls.length }).toEqual({ first: 'budget', second: 'budget', until: 300_000, total: 2 });
	});

	test('上限の判定は本体と同じ（一般的な 403 は上限とみなさない）', () => {
		const r = (status: number, h: Record<string, string>) => ({ status, headers: headers(h) });
		expect([
			classifyRateLimit(r(403, {}), '{"message":"Resource not accessible by integration"}'),
			classifyRateLimit(r(403, { 'x-ratelimit-remaining': '0' }), ''),
			classifyRateLimit(r(429, {}), ''),
			classifyRateLimit(r(403, { 'x-github-secondary-rate-limited': 'true' }), ''),
			classifyRateLimit(r(403, {}), 'abuse detection mechanism'),
			classifyRateLimit(r(500, { 'retry-after': '3' }), ''),
		]).toEqual([undefined, 'primary', 'primary', 'secondary', 'secondary', undefined]);
	});
});

describe('GitHubClient: トークン', () => {
	test('401 で gh から取り直し、変わっていれば 1 回だけ送り直す。前のアカウントの ETag とログイン名は捨てる', async () => {
		const tokens = ['old-token-1', 'new-token-2'];
		let asked = 0;
		const { fetchLike, calls } = fakeFetch((url, init) => {
			if (init.headers['authorization'] === 'Bearer old-token-1' && calls.length > 2) {
				return { status: 401, body: '{"message":"Bad credentials"}' };
			}
			return url.endsWith('/graphql') ? ok({ viewer: { login: init.headers['authorization'].includes('new') ? 'second' : 'first' } }) : { status: 200, headers: { etag: '"e"' }, body: '{}' };
		});
		const client = new GitHubClient({ token: async () => tokens[Math.min(asked++, 1)], fetch: fetchLike });
		let changed = 0;
		client.onDidChangeAccount(() => changed++);
		await client.init();
		await client.get('/repos/o/r');
		await client.get('/repos/o/r');
		const loginAfter = client.login;
		await client.init();
		expect({
			auth: calls.map(c => c.auth.replace('Bearer ', '')),
			etags: calls.map(c => c.etag),
			asked, changed, loginAfter, login: client.login,
		}).toEqual({
			auth: ['old-token-1', 'old-token-1', 'old-token-1', 'new-token-2', 'new-token-2'],
			etags: [undefined, undefined, '"e"', undefined, undefined],
			asked: 2, changed: 1, loginAfter: undefined, login: 'second',
		});
	});

	test('取り直しても同じトークンなら認証のエラーにし、5 分の間は送らず gh も呼ばない', async () => {
		let now = 0;
		let asked = 0;
		const { fetchLike, calls } = fakeFetch(() => ({ status: 401, body: '{}' }));
		const client = new GitHubClient({ token: async () => { asked++; return 'same-token-x'; }, fetch: fetchLike, now: () => now });
		const first = await client.get('/user').catch((e: GitHubError) => e.kind);
		const second = await client.get('/user').catch((e: GitHubError) => e.kind);
		const before = { sent: calls.length, asked };
		now += 5 * 60 * 1000 + 1;
		await client.get('/user').catch(() => undefined);
		expect({ first, second, before, after: { sent: calls.length, asked } }).toEqual({ first: 'auth', second: 'auth', before: { sent: 1, asked: 2 }, after: { sent: 1, asked: 3 } });
	});

	test('5 分ごとに gh から受け取り直し、アカウントが変わったら覚えたものを捨てる', async () => {
		let now = 0;
		let token = 'first-token-a';
		const { fetchLike, calls } = fakeFetch(() => ({ status: 200, headers: { etag: '"e"' }, body: '{}' }));
		const client = new GitHubClient({ token: async () => token, fetch: fetchLike, now: () => now });
		await client.get('/repos/o/r');
		now += 60_000;
		await client.get('/repos/o/r');
		token = 'second-token-b';
		now += 5 * 60 * 1000;
		await client.get('/repos/o/r');
		expect(calls.map(c => `${c.auth.replace('Bearer ', '')} ${c.etag ?? '-'}`)).toEqual(['first-token-a -', 'first-token-a "e"', 'second-token-b -']);
	});
});

describe('GitHubClient: 伏せ字', () => {
	afterEach(() => vi.restoreAllMocks());

	test('トークンはエラーの文・警告・画面の状態に出ない', async () => {
		const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { fetchLike } = fakeFetch(url => {
			if (url.endsWith('/repos/o/r')) {
				throw new Error(`connect failed with ${token}`);
			}
			return { status: 200, body: JSON.stringify({ data: { viewer: { login: 'me' } }, errors: [{ message: `field failed for ${token}` }] }) };
		});
		const client = new GitHubClient({ token: async () => token, fetch: fetchLike });
		const engine = new TaskBoardEngine({ clock: Date.now, newId: () => 'x', agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner: { run() { }, cancel() { } }, workspaces: { prepare: () => Promise.resolve({}), release: () => Promise.resolve() } } as unknown as ConstructorParameters<typeof TaskBoardEngine>[0]);
		const sync = new GitHubSync({ client, engine, repo: undefined, onState: () => undefined });
		await client.init();
		const message = await client.get('/repos/o/r').then(() => '', (e: Error) => e.message);
		sync.dispose();
		const seen = [message, ...warn.mock.calls.flat().map(String), JSON.stringify(sync.getState())].join('\n');
		expect({ leaked: seen.includes(token), redacted: message.includes('***'), sample: redactGitHubSecrets('x github_pat_ABCDEFGHIJKLMNOPQRSTUV_123 y') }).toEqual({ leaked: false, redacted: true, sample: 'x *** y' });
	});
});

describe('GitHubClient: PR', () => {
	test('PR は持ち主付きの head で探し、既定のブランチへドラフトで作り、既にあれば（422）それを使う', async () => {
		let created = false;
		const { fetchLike, calls } = fakeFetch((url, init) => {
			if (url.endsWith('/repos/o/code')) {
				return { status: 200, body: '{"default_branch":"trunk"}' };
			}
			if (init.method === 'POST') {
				return created ? { status: 422, body: '{"message":"A pull request already exists"}' } : (created = true, { status: 201, body: '{"number":42,"html_url":"https://github.com/o/code/pull/42","title":"X","draft":true}' });
			}
			return { status: 200, body: created ? '[{"number":42,"html_url":"https://github.com/o/code/pull/42","title":"X","draft":true,"head":{"ref":"para/7-x","repo":{"owner":{"login":"o"}}}}]' : '[]' };
		});
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike });
		const none = await client.findOpenPullRequest('o', 'code', 'para/7-x');
		const first = await client.createDraftPullRequest('o', 'code', 'para/7-x', 'X', 'Closes #7');
		const again = await client.createDraftPullRequest('o', 'code', 'para/7-x', 'X', 'Closes #7');
		expect({
			none, first: first.number, again: { number: again.number, existed: again.existed },
			list: calls[0].url,
			post: JSON.parse(calls.find(c => c.method === 'POST')!.body!),
		}).toEqual({
			none: undefined, first: 42, again: { number: 42, existed: true },
			list: 'https://api.github.com/repos/o/code/pulls?head=o%3Apara%2F7-x&state=open&per_page=5',
			post: { title: 'X', head: 'para/7-x', base: 'trunk', body: 'Closes #7', draft: true },
		});
	});

	test('レビュー可能にするのは GraphQL の markPullRequestReadyForReview', async () => {
		const { fetchLike, calls } = fakeFetch((_url, init) => JSON.parse(init.body!).query.startsWith('mutation') ? ok({ markPullRequestReadyForReview: { pullRequest: { id: 'PR_1' } } }) : ok({ repository: { pullRequest: { id: 'PR_1' } } }));
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike });
		await client.markPullRequestReady('o', 'code', 42);
		expect(calls.map(c => JSON.parse(c.body!).variables)).toEqual([{ owner: 'o', repo: 'code', number: 42 }, { id: 'PR_1' }]);
	});
});

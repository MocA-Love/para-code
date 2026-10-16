// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';
import { loadFlows, saveFlow } from '../server/flows.js';
import { GitHubClient, GitHubError, type FetchLike } from '../server/github.js';
import { mapPr, parseRemote, pickPr, readProjectFields } from '../server/githubSync.js';

const pr = (over: Partial<Parameters<typeof mapPr>[0]> = {}): Parameters<typeof mapPr>[0] => ({
	number: 1, url: 'u', title: 't', state: 'OPEN', isDraft: false, merged: false, reviewDecision: null,
	repository: { owner: { login: 'o' }, name: 'r' },
	latestReviews: { nodes: [] },
	commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
	...over,
});

describe('GitHub の応答の読み替え', () => {
	test('remote の URL から owner/repo を取り出す', () => {
		expect([
			parseRemote('git@github.com:MocA-Love/para-code.git'),
			parseRemote('https://github.com/o/r'),
			parseRemote('https://github.com/o/r.git/'),
			parseRemote('https://gitlab.com/o/r'),
		]).toEqual([{ owner: 'MocA-Love', repo: 'para-code' }, { owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' }, undefined]);
	});

	test('PR の状態・チェック・レビューを要約する', () => {
		const rollup = (state: string, nodes: { __typename: string; conclusion?: string; state?: string }[]) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { totalCount: nodes.length, nodes } } } }] });
		expect([
			mapPr(pr({ isDraft: true })),
			mapPr(pr({ merged: true, state: 'MERGED' })),
			mapPr(pr({ commits: rollup('FAILURE', [{ __typename: 'CheckRun', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', conclusion: 'FAILURE' }, { __typename: 'StatusContext', state: 'SUCCESS' }]) })),
			mapPr(pr({ latestReviews: { nodes: [{ state: 'COMMENTED', author: { login: 'bot' } }] } })),
			mapPr(pr({ latestReviews: { nodes: [{ state: 'COMMENTED', author: null }, { state: 'CHANGES_REQUESTED', author: null }] } })),
			mapPr(pr({ reviewDecision: 'APPROVED' })),
		].map(p => [p.state, p.checks, p.checksPassed, p.checksTotal, p.review])).toEqual([
			['draft', 'none', undefined, undefined, 'none'],
			['merged', 'none', undefined, undefined, 'none'],
			['open', 'failure', 2, 3, 'none'],
			['open', 'none', undefined, undefined, 'commented'],
			['open', 'none', undefined, undefined, 'changes'],
			['open', 'none', undefined, undefined, 'approved'],
		]);
	});

	test('Issue を閉じる PR は、開いている新しいもの → マージ済みの順に選ぶ（閉じただけのものは選ばない）', () => {
		expect(pickPr([pr({ number: 3, state: 'CLOSED' }), pr({ number: 5, merged: true, state: 'MERGED' }), pr({ number: 4 }), pr({ number: 2 })])?.number).toBe(4);
		expect(pickPr([pr({ number: 3, state: 'CLOSED' }), pr({ number: 5, merged: true, state: 'MERGED' })])?.number).toBe(5);
		expect(pickPr([pr({ number: 3, state: 'CLOSED' })])).toBeUndefined();
	});

	test('Projects のフィールドからステータス・締切・優先度を読む', () => {
		const values = [
			{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } },
			{ __typename: 'ProjectV2ItemFieldDateValue', date: '2026-10-20', field: { name: 'Start' } },
			{ __typename: 'ProjectV2ItemFieldDateValue', date: '2026-10-31', field: { name: 'Dev Merge By' } },
			{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: '高', field: { name: '優先度' } },
		];
		expect(readProjectFields(values, TASK_BOARD_DEFAULT_FLOW)).toEqual({ status: 'Todo', due: '2026-10-20', priority: '高' });
		expect(readProjectFields(values, { ...TASK_BOARD_DEFAULT_FLOW, intake: { source: 'github-project', dueField: 'dev merge by', priorityField: 'Nope' } })).toEqual({ status: 'Todo', due: '2026-10-31', priority: undefined });
	});
});

describe('GitHubClient', () => {
	const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

	test('REST は ETag を覚え、304 では覚えた本文を返す', async () => {
		const seen: (string | undefined)[] = [];
		const fetchLike: FetchLike = async (_url, init) => {
			seen.push(init.headers['if-none-match']);
			if (init.headers['if-none-match'] === '"abc"') {
				return { status: 304, headers: headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '2000000000' }), text: async () => '' };
			}
			return { status: 200, headers: headers({ etag: '"abc"', 'x-ratelimit-remaining': '4998', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '2000000000' }), text: async () => '[{"filename":"a"}]' };
		};
		const client = new GitHubClient({ token: async () => 't', fetch: fetchLike });
		const first = await client.get<{ filename: string }[]>('/repos/o/r/pulls/1/files');
		const second = await client.get<{ filename: string }[]>('/repos/o/r/pulls/1/files');
		expect({ seen, first, second, remaining: client.rest?.remaining, requests: client.requestCount }).toEqual({ seen: [undefined, '"abc"'], first: [{ filename: 'a' }], second: [{ filename: 'a' }], remaining: 4999, requests: 2 });
	});

	test('残量が少ないとリセットまで呼ばない。401 は認証のエラーにする', async () => {
		const low: FetchLike = async () => ({ status: 200, headers: headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }), text: async () => '{"data":{"viewer":{"login":"me"}}}' });
		const client = new GitHubClient({ token: async () => 't', fetch: low });
		await client.graphql('query { viewer { login } }');
		await expect(client.graphql('query { viewer { login } }')).rejects.toMatchObject({ kind: 'budget' });
		const unauthorized = new GitHubClient({ token: async () => 't', fetch: async () => ({ status: 401, headers: headers({}), text: async () => '{}' }) });
		await expect(unauthorized.get('/user')).rejects.toBeInstanceOf(GitHubError);
	});
});

describe('フロー定義ファイル', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('旧 .paracode.json を読み、保存は .para-code/ へ移す（setup などのキーは残す）', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'tb-flows-'));
		writeFileSync(path.join(dir, '.paracode.json'), JSON.stringify({ setup: ['npm ci'], workflows: [{ id: 'team', name: 'Team', steps: [{ name: 'Do', kind: 'agent' }] }] }));
		const before = await loadFlows(dir, 'me');
		expect(before.flows.map(f => `${f.id}:${f.scope}`)).toEqual(['default:builtin', 'team:team']);
		const file = await saveFlow(dir, 'me', { ...before.flows[1], name: 'Team 2' }, 'team');
		expect(path.relative(dir, file)).toBe(path.join('.para-code', 'paracode.json'));
		expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ setup: ['npm ci'], workflows: [{ id: 'team', name: 'Team 2' }] });
	});

	test('個人のフローは同じ id の共通フローより優先し、使うフローも覚える', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'tb-flows-'));
		mkdirSync(path.join(dir, '.para-code'), { recursive: true });
		writeFileSync(path.join(dir, '.para-code', 'paracode.json'), JSON.stringify({ workflows: [{ id: 'x', name: 'Team X', steps: [{ name: 'A', kind: 'agent' }] }] }));
		await saveFlow(dir, 'me', { ...TASK_BOARD_DEFAULT_FLOW, id: 'x', name: 'My X', scope: 'personal' }, 'personal', 'x');
		const loaded = await loadFlows(dir, 'me');
		expect({ names: loaded.flows.map(f => f.name), active: loaded.active, problems: loaded.problems }).toEqual({ names: ['標準', 'My X'], active: 'x', problems: [] });
		// ほかの人のフォルダは読まない
		expect((await loadFlows(dir, 'someone')).flows.map(f => f.name)).toEqual(['標準', 'Team X']);
	});

	test('ログイン名が不正な形なら個人のフォルダを作らない', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'tb-flows-'));
		await expect(saveFlow(dir, '../evil', TASK_BOARD_DEFAULT_FLOW, 'personal')).rejects.toThrow(/login/);
	});
});

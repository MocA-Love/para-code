/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisActivityFileSummary,
	PARADIS_SPACE_USAGE_OTHER_KEY,
	ParadisActivityTranscriptParser,
	paradisAggregateSpaceUsage,
	paradisAggregateWorkStats,
	paradisAllocateSpaceCosts,
	paradisCreateSpaceMatcher,
} from '../../common/paradisAgentActivity.js';

/** ローカル時刻の日時を ISO 文字列にする（日付の境界がテストを動かすマシンのタイムゾーンに依らないように）。 */
function at(day: number, hour: number, minute = 0): string {
	return new Date(2026, 8, day, hour, minute).toISOString();
}

function claudeAssistant(timestamp: string, id: string, usage: object, extra: object = {}): string {
	return JSON.stringify({ type: 'assistant', timestamp, requestId: `req-${id}`, sessionId: 's1', cwd: '/work/repo', message: { id, model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage }, ...extra });
}

function claudeUser(timestamp: string, content: unknown, extra: object = {}): string {
	return JSON.stringify({ type: 'user', timestamp, sessionId: 's1', cwd: '/work/repo', message: { role: 'user', content }, ...extra });
}

suite('ParadisAgentActivity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts Claude usage once per message and request, turns only for typed prompts, and PR links', () => {
		const parser = new ParadisActivityTranscriptParser('claude');
		const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
		for (const line of [
			claudeUser(at(20, 10, 0), 'テストを足して'),
			claudeAssistant(at(20, 10, 1), 'm1', usage),
			// 同じ応答の別ブロック。usage は重複なので数えない
			claudeAssistant(at(20, 10, 1), 'm1', usage),
			// ツールの結果はターンではない
			claudeUser(at(20, 10, 2), [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]),
			// メタ情報・サブエージェントの発言はターンではない
			claudeUser(at(20, 10, 3), 'caveat', { isMeta: true }),
			claudeUser(at(20, 10, 3), 'sub', { isSidechain: true }),
			JSON.stringify({ type: 'pr-link', timestamp: at(20, 10, 4), prUrl: 'https://github.com/o/r/pull/7' }),
			// 20 分空いたので稼働時間には入らない
			claudeUser(at(20, 10, 24), '<local-command-stdout>x</local-command-stdout>'),
			claudeUser(at(21, 9, 0), '次の日の依頼'),
			'not json',
		]) {
			parser.pushLine(line);
		}
		const summary = parser.finish();
		assert.deepStrictEqual(summary, {
			agent: 'claude',
			sessionId: 's1',
			cwd: '/work/repo',
			root: true,
			days: {
				'2026-09-20': { turns: 1, activeMs: 4 * 60_000, models: { 'claude-opus-4': { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 } } },
				'2026-09-21': { turns: 1, activeMs: 0, models: {} },
			},
			prs: [{ url: 'https://github.com/o/r/pull/7', day: '2026-09-20' }],
		});
	});

	test('counts Codex usage from cumulative token counts and detects gh pr create output', () => {
		const parser = new ParadisActivityTranscriptParser('codex');
		const total = (input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', timestamp: at(20, 11, 5), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
		for (const line of [
			JSON.stringify({ type: 'session_meta', timestamp: at(20, 11, 0), payload: { id: 'c1', cwd: '/work/repo/.wt/a' } }),
			JSON.stringify({ type: 'turn_context', timestamp: at(20, 11, 0), payload: { model: 'gpt-5-codex', cwd: '/work/repo/.wt/a' } }),
			JSON.stringify({ type: 'response_item', timestamp: at(20, 11, 1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
			JSON.stringify({ type: 'response_item', timestamp: at(20, 11, 1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PR を作って' }] } }),
			total(100, 40, 10),
			// 同じ累計がもう一度来ても増えない
			total(100, 40, 10),
			total(300, 140, 30),
			JSON.stringify({ type: 'response_item', timestamp: at(20, 11, 6), payload: { type: 'function_call', name: 'shell', call_id: 'call1', arguments: '{"command":["gh","pr","create","--fill"]}' } }),
			JSON.stringify({ type: 'response_item', timestamp: at(20, 11, 7), payload: { type: 'function_call_output', call_id: 'call1', output: 'https://github.com/o/r/pull/12\n' } }),
		]) {
			parser.pushLine(line);
		}
		const summary = parser.finish();
		assert.deepStrictEqual({ cwd: summary.cwd, root: summary.root, day: summary.days['2026-09-20'], prs: summary.prs }, {
			cwd: '/work/repo/.wt/a',
			root: true,
			day: { turns: 1, activeMs: 7 * 60_000, models: { 'gpt-5-codex': { input: 160, output: 30, cacheCreation: 0, cacheRead: 140 } } },
			prs: [{ url: 'https://github.com/o/r/pull/12', day: '2026-09-20' }],
		});
	});

	test('does not count turns of Codex subagents but keeps their tokens', () => {
		const parser = new ParadisActivityTranscriptParser('codex');
		parser.pushLine(JSON.stringify({ type: 'session_meta', timestamp: at(20, 11, 0), payload: { id: 'c2', cwd: '/work/repo', source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } } }));
		parser.pushLine(JSON.stringify({ type: 'response_item', timestamp: at(20, 11, 1), payload: { type: 'message', role: 'user', content: 'do it' } }));
		parser.pushLine(JSON.stringify({ type: 'event_msg', timestamp: at(20, 11, 2), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 } } } }));
		const summary = parser.finish();
		assert.deepStrictEqual({ root: summary.root, day: summary.days['2026-09-20'] }, {
			root: false,
			day: { turns: 0, activeMs: 2 * 60_000, models: { unknown: { input: 5, output: 1, cacheCreation: 0, cacheRead: 0 } } },
		});
	});

	test('assigns a working directory to the deepest space and aggregates buckets and work stats', () => {
		const match = paradisCreateSpaceMatcher([
			{ key: 'repo', name: 'repo', roots: ['/work/repo'] },
			{ key: 'wt', name: 'repo / a', roots: ['/work/repo/.wt/a/'] },
		], false);
		const tokens = { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 };
		const summaries: IParadisActivityFileSummary[] = [
			{ agent: 'claude', cwd: '/work/repo/src', root: true, days: { '2026-09-20': { turns: 2, activeMs: 1000, models: { m: tokens } }, '2026-09-01': { turns: 5, activeMs: 5, models: { m: tokens } } }, prs: [{ url: 'u1', day: '2026-09-20' }] },
			{ agent: 'codex', cwd: '/work/repo/.wt/a', root: true, days: { '2026-09-21': { turns: 1, activeMs: 2000, models: { m: tokens } } }, prs: [{ url: 'u2', day: '2026-09-01' }] },
			{ agent: 'claude', cwd: '/elsewhere', root: false, days: { '2026-09-20': { turns: 0, activeMs: 0, models: { m: tokens } } }, prs: [] },
			{ agent: 'claude', cwd: '/work/repository', root: true, days: { '2026-09-20': { turns: 0, activeMs: 0, models: { m: tokens } } }, prs: [] },
		];
		const range = { since: '2026-09-20', until: '2026-09-26' };
		const buckets = paradisAggregateSpaceUsage(summaries, range, match);
		const stats = paradisAggregateWorkStats(summaries, range);
		assert.deepStrictEqual({ buckets, stats }, {
			buckets: [
				{ key: 'repo', sessions: 1, days: { '2026-09-20': { m: tokens } } },
				{ key: 'wt', sessions: 1, days: { '2026-09-21': { m: tokens } } },
				{ key: PARADIS_SPACE_USAGE_OTHER_KEY, sessions: 1, days: { '2026-09-20': { m: { input: 2, output: 2, cacheCreation: 0, cacheRead: 0 } } } },
			],
			stats: {
				claude: { sessions: 1, turns: 2, activeMs: 1000, prs: 1, days: { '2026-09-20': { turns: 2, activeMs: 1000 } } },
				codex: { sessions: 1, turns: 1, activeMs: 2000, prs: 0, days: { '2026-09-21': { turns: 1, activeMs: 2000 } } },
			},
		});
	});

	test('allocates ccusage costs by weighted token share so that the parts add up to the total', () => {
		const buckets = [
			{ key: 'a', sessions: 1, days: { '2026-09-20': { 'claude-opus-4-20250101': { input: 0, output: 100, cacheCreation: 0, cacheRead: 0 } } } },
			{ key: 'b', sessions: 2, days: { '2026-09-20': { 'claude-opus-4-20250101': { input: 0, output: 0, cacheCreation: 0, cacheRead: 5000 }, 'gpt-5': { input: 10, output: 0, cacheCreation: 0, cacheRead: 0 } } } },
		];
		const allocation = paradisAllocateSpaceCosts([
			{ date: '2026-09-20', models: [{ model: 'claude-opus-4', agent: 'claude', cost: 10 }, { model: 'gpt-5-mini', agent: 'codex', cost: 3 }, { model: 'gemini-2', agent: 'gemini', cost: 1 }] },
			{ date: '2026-09-22', models: [{ model: 'claude-opus-4', agent: 'claude', cost: 2 }] },
			{ date: '2026-08-01', models: [{ model: 'claude-opus-4', agent: 'claude', cost: 100 }] },
		], buckets, '2026-09-20', '2026-09-26');
		const rounded = allocation.spaces.map(space => ({ ...space, cost: Math.round(space.cost * 1000) / 1000 }));
		assert.deepStrictEqual({ spaces: rounded, unallocated: allocation.unallocatedCost, total: allocation.totalCost }, {
			// opus: 重み a=500, b=500 → 5 ずつ。gpt-5-mini は同じモデルが無いので codex 全体（b のみ）→ 3。
			// gemini はその日の全記録の比（a=500, b=510）。9/22 は記録が無いので未割り当て。
			spaces: [
				{ key: 'a', cost: Math.round((5 + 500 / 1010) * 1000) / 1000, tokens: 100, sessions: 1 },
				{ key: 'b', cost: Math.round((5 + 3 + 510 / 1010) * 1000) / 1000, tokens: 5010, sessions: 2 },
			],
			unallocated: 2,
			total: 16,
		});
	});
});

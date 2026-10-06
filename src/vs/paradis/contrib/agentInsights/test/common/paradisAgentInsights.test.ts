/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisAgentPaneInsight,
	IParadisAgentPaneSubagent,
	PARADIS_PROMPT_CACHE_TTL_1H,
	PARADIS_PROMPT_CACHE_TTL_5M,
	paradisFormatPromptCacheRemaining,
	paradisReadClaudePromptCacheUsage,
	paradisReadClaudeRequestStart,
	paradisSelectInsightSubagents,
	paradisSummarizePermissionInput,
	paradisSummarizeQuestionInput,
	paradisVisiblePromptCacheRemainingMs,
} from '../../common/paradisAgentInsights.js';

const AT = '2026-09-27T10:00:00.000Z';
const AT_MS = Date.parse(AT);

function assistantLine(usage: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: 'assistant', timestamp: AT, message: { role: 'assistant', content: [], ...(usage ? { usage } : {}) }, ...extra };
}

function subagent(id: string, status: IParadisAgentPaneSubagent['status'], updatedAt: number): IParadisAgentPaneSubagent {
	return { id, label: id, role: 'subagent', status, startedAt: 0, updatedAt };
}

suite('ParadisAgentInsights', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the prompt cache lifetime from the Claude usage of each request', () => {
		assert.deepStrictEqual([
			// 5分のキャッシュを書いた
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } })),
			// 1時間のキャッシュだけを書いた
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 } })),
			// 両方あれば 1時間（Claude Code と同じ）
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 900 } })),
			// 内訳の無い古い形式
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_creation_input_tokens: 5 })),
			// 読んだだけ = 長さは直前のまま (呼び出し側が引き継ぐ)
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_read_input_tokens: 1200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })),
			// キャッシュを使っていないリクエスト・usage 無し・サブエージェントの行・ユーザーの行は読まない
			paradisReadClaudePromptCacheUsage(assistantLine({ input_tokens: 3, cache_read_input_tokens: 0 })),
			paradisReadClaudePromptCacheUsage(assistantLine(undefined)),
			paradisReadClaudePromptCacheUsage(assistantLine({ cache_creation_input_tokens: 5 }, { isSidechain: true })),
			paradisReadClaudePromptCacheUsage({ type: 'user', timestamp: AT, message: { usage: { cache_creation_input_tokens: 5 } } }),
		], [
			{ at: AT_MS, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M },
			{ at: AT_MS, ttlMs: PARADIS_PROMPT_CACHE_TTL_1H },
			{ at: AT_MS, ttlMs: PARADIS_PROMPT_CACHE_TTL_1H },
			{ at: AT_MS, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M },
			{ at: AT_MS, ttlMs: undefined },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('treats user and tool_result lines as the moment the next request was sent', () => {
		assert.deepStrictEqual([
			paradisReadClaudeRequestStart({ type: 'user', timestamp: AT, message: { content: 'hi' } }),
			paradisReadClaudeRequestStart({ type: 'user', timestamp: AT, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
			paradisReadClaudeRequestStart({ type: 'user', timestamp: AT, isSidechain: true }),
			paradisReadClaudeRequestStart(assistantLine({ cache_read_input_tokens: 1 })),
			paradisReadClaudeRequestStart({ type: 'user', timestamp: 'nonsense' }),
		], [AT_MS, AT_MS, undefined, undefined, undefined]);
	});

	test('shows the remaining time only for idle Claude panes whose cache is still alive', () => {
		const claude: IParadisAgentPaneInsight = { token: 't', agent: 'claude', subagents: [], promptCache: { lastUsedAt: 1_000, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M } };
		const codex: IParadisAgentPaneInsight = { ...claude, agent: 'codex' };
		assert.deepStrictEqual([
			paradisVisiblePromptCacheRemainingMs(claude, false, 1_000 + 48_000),
			// 応答中はキャッシュを使い続けているので出さない
			paradisVisiblePromptCacheRemainingMs(claude, true, 1_000 + 48_000),
			// 切れたら消す
			paradisVisiblePromptCacheRemainingMs(claude, false, 1_000 + PARADIS_PROMPT_CACHE_TTL_5M),
			// Codex は有効期限を決める根拠が無いので出さない
			paradisVisiblePromptCacheRemainingMs(codex, false, 1_000),
			paradisVisiblePromptCacheRemainingMs(undefined, false, 1_000),
		], [PARADIS_PROMPT_CACHE_TTL_5M - 48_000, undefined, undefined, undefined, undefined]);
	});

	test('formats the countdown like a clock and rounds seconds up', () => {
		assert.deepStrictEqual([
			paradisFormatPromptCacheRemaining(252_000),
			paradisFormatPromptCacheRemaining(47_100),
			paradisFormatPromptCacheRemaining(3_723_000),
			paradisFormatPromptCacheRemaining(0),
		], ['4:12', '0:48', '1:02:03', '0:00']);
	});

	test('summarizes what the agent is waiting for in one line', () => {
		assert.deepStrictEqual([
			paradisSummarizeQuestionInput({ questions: [{ header: 'TTL', question: 'TTL を 1 時間に\n延ばしますか?', options: [] }, { question: '2問目' }] }),
			paradisSummarizeQuestionInput({ questions: [] }),
			paradisSummarizePermissionInput('Bash', { command: 'npm test -- login', description: 'Run tests' }),
			paradisSummarizePermissionInput('Edit', { file_path: '/repo/src/a.ts', old_string: 'x' }),
			paradisSummarizePermissionInput('mcp__github__create_pr', { title: 'x' }),
			paradisSummarizePermissionInput(undefined, undefined),
		], [
			'TTL を 1 時間に 延ばしますか?',
			undefined,
			'npm test -- login',
			'Edit: /repo/src/a.ts',
			'mcp__github__create_pr',
			undefined,
		]);
	});

	test('keeps every running subagent but only a few recent finished ones', () => {
		const selected = paradisSelectInsightSubagents([
			subagent('done-old', 'completed', 1),
			subagent('run-1', 'running', 5),
			subagent('done-new', 'failed', 9),
			subagent('idle-1', 'idle', 2),
			subagent('done-mid', 'interrupted', 4),
		], { active: 20, finished: 2 });
		assert.deepStrictEqual(selected.map(item => item.id), ['run-1', 'idle-1', 'done-new', 'done-mid']);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisAgentPaneInsight, PARADIS_PROMPT_CACHE_TTL_1H } from '../../../agentInsights/common/paradisAgentInsights.js';
import { ParadisMobileAgentChat } from '../../node/paradisMobileAgentChat.js';

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

/**
 * 本物の ~/.claude には触れないよう、Claude の設定置き場を一時ディレクトリへ向けて動かす。
 */
async function withClaudeHome(run: (claudeHome: string) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-desktop-insights-')));
	const claudeHome = join(root, 'claude-home');
	await mkdir(join(claudeHome, 'projects', 'repo'), { recursive: true });
	const previous = process.env['CLAUDE_CONFIG_DIR'];
	process.env['CLAUDE_CONFIG_DIR'] = claudeHome;
	try {
		await run(claudeHome);
	} finally {
		if (previous === undefined) {
			delete process.env['CLAUDE_CONFIG_DIR'];
		} else {
			process.env['CLAUDE_CONFIG_DIR'] = previous;
		}
		await rm(root, { recursive: true, force: true });
	}
}

suite('ParadisMobileAgentChat desktop insights', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes subagents, the last message, the pending question and the prompt cache without sending anything to mobile', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-insights';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-1.jsonl');
		// 起点は応答を書き終えた時刻 (10:00) ではなく、その応答を求めたリクエストの時刻 (直前の user 行)
		const requestSent = '2026-09-27T09:59:00.000Z';
		const lastUsed = '2026-09-27T10:00:00.000Z';
		await writeFile(transcriptPath, [
			JSON.stringify({ type: 'user', timestamp: requestSent, message: { role: 'user', content: 'キャッシュの既定値を調べて' } }),
			JSON.stringify({
				type: 'assistant', timestamp: lastUsed, message: {
					role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: '原因は TTL の\n既定値でした' }],
					usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } },
				},
			}),
			'',
		].join('\n'));

		const sent: unknown[] = [];
		const chat = new ParadisMobileAgentChat(payload => sent.push(payload), () => { }, info => sent.push(info), new NullLogService());
		let changes = 0;
		const listener = chat.onDidChangeDesktopPaneInsights(() => changes++);
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>> };
		const insight = (): IParadisAgentPaneInsight | undefined => chat.getDesktopPaneInsights([token])[0];
		try {
			// モバイル連携は無効のまま (setEagerTailing を呼ばない)
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-1', transcriptPath, cwd: '/repo', payload: { prompt: '調べて' }, at: Date.now() });
			await waitFor(() => !access.hookProcessing.has(token), 'UserPromptSubmit was not processed');
			await waitFor(() => insight()?.lastMessage !== undefined, 'transcript was not read');

			fireParadisAgentHookEvent({ token, event: 'SubagentStart', sessionId: 'session-1', transcriptPath, cwd: '/repo', payload: { agent_id: 'reviewer-1', agent_type: 'code-reviewer' }, at: Date.now() });
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-1', transcriptPath, cwd: '/repo', toolName: 'AskUserQuestion',
				toolInput: { questions: [{ header: 'TTL', question: 'TTL を 1 時間に延ばしますか?', options: [{ label: 'はい' }, { label: 'いいえ' }] }] }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'hooks were not processed');
			await waitFor(() => (insight()?.subagents.length ?? 0) > 0 && changes > 0, 'subagent did not appear');

			const current = insight();
			assert.deepStrictEqual({
				agent: current?.agent,
				subagents: current?.subagents.map(item => [item.id, item.status]),
				lastMessage: current?.lastMessage?.text,
				interaction: current?.interaction && { kind: current.interaction.kind, text: current.interaction.text },
				promptCache: current?.promptCache,
			}, {
				agent: 'claude',
				subagents: [['reviewer-1', 'running']],
				lastMessage: '原因は TTL の 既定値でした',
				interaction: { kind: 'question', text: 'TTL を 1 時間に延ばしますか?' },
				promptCache: { lastUsedAt: Date.parse(requestSent), ttlMs: PARADIS_PROMPT_CACHE_TTL_1H },
			});

			// 質問が決着したら消える
			fireParadisAgentHookEvent({ token, event: 'PostToolUse', sessionId: 'session-1', transcriptPath, cwd: '/repo', toolName: 'AskUserQuestion', at: Date.now() });
			await waitFor(() => insight()?.interaction === undefined, 'answered question was not cleared');

			// 知らないペイン・まだセッションの無いペインは返さない
			assert.deepStrictEqual(chat.getDesktopPaneInsights(['unknown-pane']), []);
			// モバイルへは何も送っていない
			assert.deepStrictEqual(sent, []);
		} finally {
			listener.dispose();
			chat.dispose();
		}
	}));
});

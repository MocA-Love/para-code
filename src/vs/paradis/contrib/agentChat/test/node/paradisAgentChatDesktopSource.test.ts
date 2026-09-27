/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisMobileAgentChat } from '../../../mobileRelay/node/paradisMobileAgentChat.js';
import { IParadisAgentChatView } from '../../common/paradisAgentChat.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

/** 本物の ~/.claude には触れないよう、Claude の設定置き場を一時ディレクトリへ向けて動かす。 */
async function withClaudeHome(run: (claudeHome: string) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-chat-')));
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

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

suite('ParadisMobileAgentChat desktop chat source', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('serves the conversation to the desktop chat as snapshots and deltas, and captures questions while watched without a mobile', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-chat';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-1.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'README を直して' } })
			+ line({ type: 'assistant', timestamp: '2026-09-27T10:00:05.000Z', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: '直します' }] } }));

		const sent: unknown[] = [];
		const chat = new ParadisMobileAgentChat(payload => sent.push(payload), () => { }, info => sent.push(info), new NullLogService());
		const changed: string[] = [];
		const listener = chat.onDidChangeDesktopChat(tokens => changed.push(...tokens));
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>> };
		try {
			// モバイル連携は無効のまま (setEagerTailing を呼ばない)
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			assert.strictEqual(await chat.getDesktopChat(token, undefined), undefined, 'a pane without a session has no chat');
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: 'session-1', transcriptPath, cwd: '/repo', at: Date.now() });
			await waitFor(() => !access.hookProcessing.has(token), 'SessionStart was not processed');
			chat.watchDesktopChat('window-1', [token]);

			let view: IParadisAgentChatView | undefined;
			await waitFor(async () => (view = await chat.getDesktopChat(token, undefined))?.messages.length === 2, 'transcript was not read');
			const first = view!;
			assert.deepStrictEqual({
				agent: first.agent, reset: first.reset, busy: first.busy, interaction: first.interaction, model: first.info?.model,
				messages: first.messages.map(message => [message.role, message.kind, message.text]),
			}, {
				agent: 'claude', reset: true, busy: false, interaction: null, model: 'claude-opus-4-5',
				messages: [['user', 'text', 'README を直して'], ['assistant', 'text', '直します']],
			});

			// 追記分だけが差分で届く
			await appendFile(transcriptPath, line({ type: 'assistant', timestamp: '2026-09-27T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/repo/README.md', old_string: 'a', new_string: 'b' } }] } }));
			await waitFor(async () => (view = await chat.getDesktopChat(token, { epoch: first.epoch, rev: first.rev }))?.messages.length === 1, 'appended line was not read');
			assert.deepStrictEqual({ reset: view!.reset, tools: view!.messages.map(message => [message.kind, message.tool]) }, { reset: false, tools: [['tool_use', 'Edit']] });
			await waitFor(() => changed.includes(token), 'the desktop chat was not told about the change');

			// 起点が合わない（別の epoch）なら全量に戻る
			const mismatched = await chat.getDesktopChat(token, { epoch: 'other', rev: 0 });
			assert.deepStrictEqual({ reset: mismatched?.reset, count: mismatched?.messages.length }, { reset: true, count: 3 });

			// 見ている間は、モバイルとつないでいなくても質問のカードが入る
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-1', transcriptPath, cwd: '/repo', toolName: 'AskUserQuestion',
				toolInput: { questions: [{ header: '範囲', question: '見出しも直しますか?', options: [{ label: 'はい' }, { label: 'いいえ' }] }] }, at: Date.now(),
			});
			await waitFor(async () => (view = await chat.getDesktopChat(token, undefined))?.interaction?.kind === 'question', 'question was not captured');
			assert.deepStrictEqual(view!.pendingQuestions?.map(question => [question.text, question.options?.map(option => option.label)]), [['見出しも直しますか?', ['はい', 'いいえ']]]);

			// モバイルへは何も送っていない
			assert.deepStrictEqual(sent, []);
		} finally {
			listener.dispose();
			chat.dispose();
		}
	}));

	test('does not capture questions for panes nobody is watching when no mobile is paired', () => withClaudeHome(async claudeHome => {
		const token = 'pane-unwatched';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-2.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'hi' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>> };
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: 'session-2', transcriptPath, cwd: '/repo', at: Date.now() });
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-2', transcriptPath, cwd: '/repo', toolName: 'AskUserQuestion',
				toolInput: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'hooks were not processed');
			const view = await chat.getDesktopChat(token, undefined);
			assert.strictEqual(view?.interaction, null);
		} finally {
			chat.dispose();
		}
	}));
});

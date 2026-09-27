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
import { clearParadisAgentPaneActivity, fireParadisAgentHookEvent, getParadisAgentPaneActivity, registerParadisAgentPaneActivityGuard } from '../../../agentBrowser/node/paradisAgentHookBus.js';
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
			chat.watchDesktopChat('window-1', [token], [token]);

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

			// 打鍵で答える間はモバイルと同じ claim を取る。2つ目は取れず、送らずに返せばまた取れる
			const group = view!.interaction!.id;
			const claims = [chat.claimDesktopInteraction(token, 'question', group), chat.claimDesktopInteraction(token, 'question', group)];
			chat.releaseDesktopInteraction(token, 'question', group, false);
			claims.push(chat.claimDesktopInteraction(token, 'question', group));
			chat.releaseDesktopInteraction(token, 'question', group, false);
			assert.deepStrictEqual(claims, [true, false, true]);

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

			// 取り込むが知らせない（チャットを開いていない）ペインの変化は、ウィンドウへ知らせない
			const changed: string[] = [];
			const listener = chat.onDidChangeDesktopChat(tokens => changed.push(...tokens));
			chat.watchDesktopChat('window-1', [token], []);
			await appendFile(transcriptPath, line({ type: 'assistant', timestamp: '2026-09-27T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }));
			await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.messages.length === 2, 'appended line was not read');
			await new Promise<void>(resolve => setTimeout(resolve, 200));
			listener.dispose();
			assert.deepStrictEqual({ interaction: view?.interaction, changed }, { interaction: null, changed: [] });
		} finally {
			chat.dispose();
		}
	}));

	test('an approval captured only for the desktop chat does not turn the pane status into waiting for permission', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-approval';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-3.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'テストして' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>> };
		// ペインの状態は shared process の持ち主の確認を通ったものだけが記録される（本番と同じ関門を立てる）
		const guard = registerParadisAgentPaneActivityGuard(candidate => candidate === token);
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: 'session-3', transcriptPath, cwd: '/repo', at: Date.now() });
			await waitFor(() => !access.hookProcessing.has(token), 'SessionStart was not processed');
			chat.watchDesktopChat('window-1', [token], [token]);
			fireParadisAgentHookEvent({ token, event: 'PermissionRequest', sessionId: 'session-3', transcriptPath, cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npm test' }, at: Date.now() });
			await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.interaction?.kind === 'approval', 'approval was not captured');
			const beforeMobile = getParadisAgentPaneActivity(token).pendingApproval;
			// モバイル向けの注入が有効になったら、ふつうの承認として数える
			chat.setEagerTailing(true);
			await waitFor(() => getParadisAgentPaneActivity(token).pendingApproval, 'approval was not promoted');
			assert.strictEqual(beforeMobile, false);
		} finally {
			chat.dispose();
			guard.dispose();
			clearParadisAgentPaneActivity(token);
		}
	}));
	test('ties a permission request to its tool call, keeps it through parallel calls of the same tool, marks the agent as exited after SessionEnd, and hands desktop-only captures to a mobile that attaches later', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-synthetic';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-4.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'テストして' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>>; tailers: Map<string, { enqueue(work: () => Promise<void>): Promise<void> }> };
		// hook の処理と、tailer のキューに積まれた変更（承認の解除など）の両方が済むまで待つ。
		const settled = async () => {
			await waitFor(() => !access.hookProcessing.has(token), 'hook was not processed');
			await access.tailers.get(token)?.enqueue(async () => { });
		};
		const hook = (event: string, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token, event, sessionId: 'session-4', transcriptPath, cwd: '/repo', at: Date.now(), ...extra });
		const guard = registerParadisAgentPaneActivityGuard(candidate => candidate === token);
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			hook('SessionStart');
			await settled();
			chat.watchDesktopChat('window-1', [token], [token]);
			const interaction = async () => (await chat.getDesktopChat(token, undefined))?.interaction ?? null;

			// 並列の同名ツール: 許可の要らない Read が先に終わっても、許可を待つ Read の承認は残る。
			// PermissionRequest には tool_use_id が無いが、同じ入力の PreToolUse から id を引き当てる。
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_a', toolInput: { file_path: '/repo/a.ts' } });
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_b', toolInput: { file_path: '/etc/hosts' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/etc/hosts' } });
			await settled();
			const tied = (await interaction())?.id;
			hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_a' });
			await settled();
			const afterOtherRead = (await interaction())?.id;
			hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_b' });
			await settled();
			const afterOwnRead = await interaction();

			// 同じ入力の呼び出しが2つあって決まらないときは合成 id。両方が終わるまで解かない
			hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_c', toolInput: { command: 'npm test' } });
			hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_d', toolInput: { command: 'npm test' } });
			hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
			await settled();
			const synthetic = (await interaction())?.id ?? '';
			hook('PostToolUse', { toolName: 'Bash', toolUseId: 'toolu_c' });
			await settled();
			const afterFirstBash = (await interaction())?.id;
			hook('PostToolUse', { toolName: 'Bash', toolUseId: 'toolu_d' });
			await settled();
			const afterBothBash = await interaction();

			// PreToolUse を1つも覚えていない承認は、ツールの完了では解かない（以前どおりターン終了まで）
			hook('PermissionRequest', { toolName: 'WebFetch', toolInput: { url: 'https://example.com' } });
			await settled();
			hook('PostToolUse', { toolName: 'WebFetch', toolUseId: 'toolu_e' });
			await settled();
			const unknownCallStillPending = (await interaction())?.kind;
			hook('Stop');
			await settled();

			// デスクトップ専用で入れた質問はペインの状態に数えない。モバイルが注入を有効にしたら数える
			hook('PreToolUse', { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] } });
			await waitFor(async () => (await interaction())?.kind === 'question', 'question was not captured');
			const questionBeforeMobile = getParadisAgentPaneActivity(token).pendingQuestion;
			chat.setEagerTailing(true);
			await waitFor(() => getParadisAgentPaneActivity(token).pendingQuestion, 'question was not promoted');

			hook('SessionEnd');
			await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.agentExited === true, 'exit was not recorded');
			hook('SessionStart');
			await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.agentExited === undefined, 'exit mark was not cleared');

			assert.deepStrictEqual({ tied, afterOtherRead, afterOwnRead, syntheticPrefix: synthetic.startsWith('approval:'), afterFirstBash: afterFirstBash === synthetic, afterBothBash, unknownCallStillPending, questionBeforeMobile }, {
				tied: 'toolu_b', afterOtherRead: 'toolu_b', afterOwnRead: null, syntheticPrefix: true, afterFirstBash: true, afterBothBash: null, unknownCallStillPending: 'approval', questionBeforeMobile: false,
			});
		} finally {
			chat.dispose();
			guard.dispose();
			clearParadisAgentPaneActivity(token);
		}
	}));
	test('keeps overlapping permission requests in a queue, shows the latest first, and settles one when its tool result is written without a hook', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-queue';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-5.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: '読んで' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>>; tailers: Map<string, { enqueue(work: () => Promise<void>): Promise<void> }> };
		const settled = async () => {
			await waitFor(() => !access.hookProcessing.has(token), 'hook was not processed');
			await access.tailers.get(token)?.enqueue(async () => { });
		};
		const hook = (event: string, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token, event, sessionId: 'session-5', transcriptPath, cwd: '/repo', at: Date.now(), ...extra });
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			hook('SessionStart');
			await settled();
			chat.watchDesktopChat('window-1', [token], [token]);
			const interaction = async () => (await chat.getDesktopChat(token, undefined))?.interaction ?? null;

			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_b', toolInput: { file_path: '/outside/b.txt' } });
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_c', toolInput: { file_path: '/outside/c.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/b.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/c.txt' } });
			await settled();
			const first = (await interaction())?.id;
			// c をターミナルで拒否した: hook は来ず、transcript に is_error の結果だけが書かれる（Claude Code 2.1.283）
			await appendFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c', is_error: true, content: `The user doesn't want to proceed with this tool use.` }] } }));
			await waitFor(async () => (await interaction())?.id === 'toolu_b', 'the earlier request did not come back to the front');
			hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_b' });
			await settled();
			const afterBoth = await interaction();

			assert.deepStrictEqual({ first, afterBoth }, { first: 'toolu_c', afterBoth: null });
		} finally {
			chat.dispose();
		}
	}));
});

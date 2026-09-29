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
import { clearParadisAgentPaneActivity, fireParadisAgentHookEvent, getParadisAgentPaneActivity, onParadisAgentAwaitingUser, onParadisAgentTurnEnded, registerParadisAgentPaneActivityGuard } from '../../../agentBrowser/node/paradisAgentHookBus.js';
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

/** 本物の ~/.codex には触れないよう、Codex の置き場を一時ディレクトリへ向けて動かす。 */
async function withCodexHome(run: (codexHome: string) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-chat-codex-')));
	const codexHome = join(root, 'codex-home');
	await mkdir(join(codexHome, 'sessions', '2026', '09', '27'), { recursive: true });
	const previous = process.env['CODEX_HOME'];
	process.env['CODEX_HOME'] = codexHome;
	try {
		await run(codexHome);
	} finally {
		if (previous === undefined) {
			delete process.env['CODEX_HOME'];
		} else {
			process.env['CODEX_HOME'] = previous;
		}
		await rm(root, { recursive: true, force: true });
	}
}

/** ペインが止まって次の指示を待つ合図（idle）と、ターン終了の合図（review）を集める。 */
function recordPaneSignals(token: string): { readonly awaitingUser: number[]; readonly turnEnded: number[]; dispose(): void } {
	const awaitingUser: number[] = [];
	const turnEnded: number[] = [];
	const awaitingListener = onParadisAgentAwaitingUser(event => { if (event.token === token) { awaitingUser.push(1); } });
	const turnEndedListener = onParadisAgentTurnEnded(event => { if (event.token === token) { turnEnded.push(1); } });
	return {
		awaitingUser, turnEnded,
		dispose: () => {
			awaitingListener.dispose();
			turnEndedListener.dispose();
		},
	};
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
	test('drops the approval card when the agent CLI exits, so a mobile attaching later does not revive it, but keeps it when the CLI is only suspended or the pane briefly leaves the list', () => withClaudeHome(async claudeHome => {
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>> };
		const tokens = ['pane-cli-exit', 'pane-cli-suspended'];
		const guard = registerParadisAgentPaneActivityGuard(candidate => tokens.includes(candidate));
		const causes: string[] = [];
		const causeListener = onParadisAgentTurnEnded(event => causes.push(`${event.token}:${event.cause}`));
		try {
			chat.syncPanes(1, 'window-session', 1, 1, tokens.map((token, index) => ({ terminalId: index + 1, token })));
			for (const [index, token] of tokens.entries()) {
				const transcriptPath = join(claudeHome, 'projects', 'repo', `session-exit-${index}.jsonl`);
				await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'テストして' } }));
				fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: `session-exit-${index}`, transcriptPath, cwd: '/repo', at: Date.now() });
				await waitFor(() => !access.hookProcessing.has(token), 'SessionStart was not processed');
				chat.watchDesktopChat('window-1', tokens, tokens);
				fireParadisAgentHookEvent({ token, event: 'PermissionRequest', sessionId: `session-exit-${index}`, transcriptPath, cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npm test' }, at: Date.now() });
				await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.interaction?.kind === 'approval', 'approval was not captured');
			}
			chat.onCliCommandFinished('pane-cli-exit');
			chat.onCliCommandFinished('pane-cli-suspended', 'suspended');
			await waitFor(async () => (await chat.getDesktopChat('pane-cli-exit', undefined))?.interaction === null, 'the approval card was not dropped');
			// モバイル向けの注入が有効になる（デスクトップ専用だった承認をふつうの承認として数え直す）
			chat.setEagerTailing(true);
			await waitFor(() => getParadisAgentPaneActivity('pane-cli-suspended').pendingApproval, 'the suspended approval was not promoted');
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual({
				causes,
				exited: { pendingApproval: getParadisAgentPaneActivity('pane-cli-exit').pendingApproval, card: (await chat.getDesktopChat('pane-cli-exit', undefined))?.interaction },
				suspendedCard: (await chat.getDesktopChat('pane-cli-suspended', undefined))?.interaction?.kind,
			}, {
				causes: ['pane-cli-exit:cli-exit', 'pane-cli-suspended:turn'],
				exited: { pendingApproval: false, card: null },
				suspendedCard: 'approval',
			});
		} finally {
			causeListener.dispose();
			chat.dispose();
			guard.dispose();
			for (const token of tokens) {
				clearParadisAgentPaneActivity(token);
			}
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
	test('queues a second identical permission request for a second identical call, and settles the waiting state after a rejection with no hook', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-twins';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-6.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: '読んで' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>>; tailers: Map<string, { enqueue(work: () => Promise<void>): Promise<void> }> };
		const settled = async () => {
			await waitFor(() => !access.hookProcessing.has(token), 'hook was not processed');
			await access.tailers.get(token)?.enqueue(async () => { });
		};
		const hook = (event: string, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token, event, sessionId: 'session-6', transcriptPath, cwd: '/repo', at: Date.now(), ...extra });
		const signals = recordPaneSignals(token);
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			hook('SessionStart');
			await settled();
			chat.watchDesktopChat('window-1', [token], [token]);
			const view = () => chat.getDesktopChat(token, undefined);

			// 同じ内容の呼び出しが2つ → 同じ内容の許可要求も2件まで積む。3件目は同じ hook の再送として捨てる
			hook('UserPromptSubmit', { payload: { prompt: '読んで' } });
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_x', toolInput: { file_path: '/outside/same.txt' } });
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_y', toolInput: { file_path: '/outside/same.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/same.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/same.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/same.txt' } });
			await settled();
			const cards = (await view())?.messages.filter(message => message.tool === 'approval_request').length;
			const livePhase = (await view())?.live?.phase;

			// Esc で拒否: hook は来ず、両方の結果が transcript に書かれるだけ（Claude Code 2.1.283）
			const rejected = `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`;
			await appendFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: rejected }, { type: 'tool_result', tool_use_id: 'toolu_y', is_error: true, content: rejected }] } }));
			await waitFor(async () => (await view())?.interaction === null, 'the approvals were not settled');
			await waitFor(async () => (await view())?.live === null, 'the waiting state was not cleared');
			const after = await view();

			// 拒否は完了ではない: ペインを状態なし（idle）へ移す合図だけを出し、完了（review）の合図は出さない
			assert.deepStrictEqual({ cards, livePhase, busy: after?.busy, awaitingUser: signals.awaitingUser.length, turnEnded: signals.turnEnded.length }, { cards: 2, livePhase: 'permission', busy: false, awaitingUser: 1, turnEnded: 0 });
		} finally {
			signals.dispose();
			chat.dispose();
		}
	}));
	test('shows the second of two identical permission requests after the first is answered from the desktop, and removes both only when the tools finish', () => withClaudeHome(async claudeHome => {
		const token = 'pane-desktop-answered-twins';
		const transcriptPath = join(claudeHome, 'projects', 'repo', 'session-7.jsonl');
		await writeFile(transcriptPath, line({ type: 'user', timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: '読んで' } }));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { hookProcessing: Map<string, Promise<void>>; tailers: Map<string, { enqueue(work: () => Promise<void>): Promise<void> }> };
		const settled = async () => {
			await waitFor(() => !access.hookProcessing.has(token), 'hook was not processed');
			await access.tailers.get(token)?.enqueue(async () => { });
		};
		const hook = (event: string, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token, event, sessionId: 'session-7', transcriptPath, cwd: '/repo', at: Date.now(), ...extra });
		try {
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
			hook('SessionStart');
			await settled();
			chat.watchDesktopChat('window-1', [token], [token]);
			const interaction = async () => (await chat.getDesktopChat(token, undefined))?.interaction ?? null;

			// 実機の形: 同じ入力の呼び出しが2つ、tool_use_id の無い同じ本文の許可要求が2つ（どちらも合成 id）
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_p', toolInput: { file_path: '/outside/same.txt' } });
			hook('PreToolUse', { toolName: 'Read', toolUseId: 'toolu_q', toolInput: { file_path: '/outside/same.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/same.txt' } });
			hook('PermissionRequest', { toolName: 'Read', toolInput: { file_path: '/outside/same.txt' } });
			await settled();
			const first = (await interaction())?.id ?? '';

			// デスクトップのカードから1件目に答える（キーを送り終えた）
			const claimed = chat.claimDesktopInteraction(token, 'approval', first);
			chat.releaseDesktopInteraction(token, 'approval', first, true);
			await settled();
			const second = (await interaction())?.id ?? '';
			// 答え終えた1件目にはもう答えられない
			const claimAnsweredAgain = chat.claimDesktopInteraction(token, 'approval', first);

			hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_p' });
			await settled();
			const afterFirstTool = (await interaction())?.id;
			hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_q' });
			await settled();
			const afterBothTools = await interaction();

			assert.deepStrictEqual({
				bothSynthetic: first.startsWith('approval:') && second.startsWith('approval:'),
				secondIsAnother: second !== first,
				claimed, claimAnsweredAgain,
				afterFirstToolStillSecond: afterFirstTool === second,
				afterBothTools,
			}, {
				bothSynthetic: true, secondIsAnother: true, claimed: true, claimAnsweredAgain: false, afterFirstToolStillSecond: true, afterBothTools: null,
			});
		} finally {
			chat.dispose();
		}
	}));
	for (const split of [false, true]) {
		test(`moves a Codex pane to idle, not to completion, when the approval is denied from the card and the rollout writes the aborted result before turn_aborted${split ? ' in separate reads' : ''}`, () => withCodexHome(async codexHome => {
			const token = `pane-desktop-codex-deny${split ? '-split' : ''}`;
			const rolloutPath = join(codexHome, 'sessions', '2026', '09', '27', 'rollout-2026-09-27T10-00-00-thread-deny.jsonl');
			await writeFile(rolloutPath, line({ timestamp: '2026-09-27T10:00:00.000Z', type: 'session_meta', payload: { id: 'thread-deny', cwd: '/repo', originator: 'codex_cli_rs' } })
				+ line({ timestamp: '2026-09-27T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'テストして' }] } }));
			const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
			const access = chat as unknown as { hookProcessing: Map<string, Promise<void>>; tailers: Map<string, { enqueue(work: () => Promise<void>): Promise<void> }> };
			const settled = async () => {
				await waitFor(() => !access.hookProcessing.has(token), 'hook was not processed');
				await access.tailers.get(token)?.enqueue(async () => { });
			};
			const hook = (event: string, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token, event, sessionId: 'thread-deny', transcriptPath: rolloutPath, cwd: '/repo', at: Date.now(), ...extra });
			const signals = recordPaneSignals(token);
			try {
				chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]);
				hook('SessionStart');
				await settled();
				chat.watchDesktopChat('window-1', [token], [token]);
				const interaction = async () => (await chat.getDesktopChat(token, undefined))?.interaction ?? null;

				hook('PreToolUse', { toolName: 'Bash', toolUseId: 'call_deny', toolInput: { command: 'npm test' } });
				hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
				await waitFor(async () => (await interaction())?.kind === 'approval', 'approval was not captured');
				const approvalId = (await interaction())?.id ?? '';
				// カードから拒否した（キーを送り終えた）
				chat.claimDesktopInteraction(token, 'approval', approvalId);
				chat.releaseDesktopInteraction(token, 'approval', approvalId, true);
				await settled();
				// 実機（codex-cli 0.155.1）の順: 拒否したツールの結果（aborted by user）の直後に turn_aborted
				const aborted = line({ timestamp: '2026-09-27T10:00:05.764Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_deny', output: 'Wall time: 7.5 seconds\naborted by user' } });
				const turnAborted = line({ timestamp: '2026-09-27T10:00:05.769Z', type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });
				if (split) {
					await appendFile(rolloutPath, aborted);
					await waitFor(async () => (await interaction()) === null, 'the denied approval was not settled by its result');
					await settled();
					await appendFile(rolloutPath, turnAborted);
				} else {
					await appendFile(rolloutPath, aborted + turnAborted);
				}
				await waitFor(async () => (await chat.getDesktopChat(token, undefined))?.messages.some(message => message.kind === 'tool_result') === true, 'the aborted result was not read');
				await waitFor(() => signals.awaitingUser.length > 0, 'the pane was not moved to idle');
				await settled();
				await access.tailers.get(token)?.enqueue(async () => { });
				const afterAbort = { stoppedForUser: signals.awaitingUser.length > 0, turnEnded: signals.turnEnded.length, interaction: await interaction() };

				// 承認の無いターンの完了は、今までどおり完了（review）の合図
				await appendFile(rolloutPath, line({ timestamp: '2026-09-27T10:00:09.000Z', type: 'event_msg', payload: { type: 'task_started' } })
					+ line({ timestamp: '2026-09-27T10:00:10.000Z', type: 'event_msg', payload: { type: 'task_complete' } }));
				await waitFor(() => signals.turnEnded.length > 0, 'the completed turn was not signalled');

				assert.deepStrictEqual(afterAbort, { stoppedForUser: true, turnEnded: 0, interaction: null });
			} finally {
				signals.dispose();
				chat.dispose();
			}
		}));
	}
});

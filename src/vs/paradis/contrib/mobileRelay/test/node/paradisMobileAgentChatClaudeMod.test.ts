/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の mod（Claude Mods）と、モバイルのエージェントチャットの結合（paradisClaudeModBridge.ts と
// ParadisMobileAgentChat）。transcript は一時ディレクトリに置く（CLAUDE_CONFIG_DIR を差し替える）。

import assert from 'assert';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisClaudeModBridge } from '../../../claudeMod/node/paradisClaudeModBridge.js';
import { ParadisMobileAgentChat, paradisModApprovalChoices } from '../../node/paradisMobileAgentChat.js';

const SESSION = 'session-claude-mod';

interface ITailerAccess {
	readonly epoch: string;
	readonly messages: readonly { readonly kind: string; readonly text: string; readonly toolUseId?: string }[];
	readonly model: string | undefined;
	currentInteraction(): { readonly kind: string; readonly id: string; readonly choices?: readonly { readonly id: string }[] } | null;
}

interface IHarness {
	readonly token: string;
	readonly transcriptPath: string;
	readonly bridge: ParadisClaudeModBridge;
	readonly chat: ParadisMobileAgentChat;
	readonly sent: Record<string, unknown>[];
	readonly actions: Record<string, unknown>[];
	readonly signal: AbortSignal;
	tailer(): ITailerAccess | undefined;
	inbound(message: Record<string, unknown>): void;
	mod(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** 送り主の確かめの結果（既定では確かめられる）。 */
	callerVerified: boolean;
	hook(event: string, extra?: Record<string, unknown>): void;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

async function withHarness(run: (harness: IHarness) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-claude-mod-')));
	const previous = process.env['CLAUDE_CONFIG_DIR'];
	process.env['CLAUDE_CONFIG_DIR'] = root;
	const project = join(root, 'projects', 'para-code-tests');
	await mkdir(project, { recursive: true });
	const transcriptPath = join(project, `${SESSION}.jsonl`);
	await writeFile(transcriptPath, '');
	const token = 'pane-claude-mod';
	const bridge = new ParadisClaudeModBridge();
	bridge.setPresence(() => 'connected');
	bridge.setApprovalWait(() => 600_000);
	const sent: Record<string, unknown>[] = [];
	const actions: Record<string, unknown>[] = [];
	const chat = new ParadisMobileAgentChat(
		(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
		(_mobileId, _windowId, _windowSession, _generation, payload) => actions.push(JSON.parse(new TextDecoder().decode(payload))),
		() => { }, new NullLogService(), async () => true, () => { }, undefined, undefined, undefined, bridge,
	);
	const controller = new AbortController();
	const access = chat as unknown as { tailers: Map<string, ITailerAccess> };
	const harness: IHarness = {
		token, transcriptPath, bridge, chat, sent, actions, signal: controller.signal,
		tailer: () => access.tailers.get(token),
		inbound: message => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({ id: 1, token, ...message }))),
		mod: async (op, body) => (await bridge.handle(token, op, { sessionId: SESSION, ...body }, controller.signal, async () => harness.callerVerified)).body,
		callerVerified: true,
		hook: (event, extra) => fireParadisAgentHookEvent({ token, event, sessionId: SESSION, transcriptPath, cwd: '/workspace', at: Date.now(), ...extra }),
	};
	try {
		chat.setEagerTailing(true);
		assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
		harness.hook('UserPromptSubmit');
		await waitFor(() => harness.tailer() !== undefined, 'the pane session was not established');
		harness.inbound({ t: 'attach' });
		await waitFor(() => sent.some(message => message.t === 'snapshot'), 'the attach did not answer with a snapshot');
		await run(harness);
	} finally {
		controller.abort();
		chat.dispose();
		bridge.dispose();
		if (previous === undefined) {
			delete process.env['CLAUDE_CONFIG_DIR'];
		} else {
			process.env['CLAUDE_CONFIG_DIR'] = previous;
		}
		await rm(root, { recursive: true, force: true });
	}
}

suite('ParadisMobileAgentChat with the Claude Code mod', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows a row from the mod first and does not repeat it when the transcript line arrives', () => withHarness(async harness => {
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-1', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'mod から先に届いた本文' }] } }] });
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === 'mod から先に届いた本文') === true, 'the mod row was not shown');
		await appendFile(harness.transcriptPath, `${JSON.stringify({ type: 'assistant', uuid: 'u-1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-test-model', content: [{ type: 'text', text: 'mod から先に届いた本文' }] } })}\n`);
		await waitFor(() => harness.tailer()?.model === 'claude-test-model', 'the transcript line was not read');
		// a line the mod did not send is still read from the file
		await appendFile(harness.transcriptPath, `${JSON.stringify({ type: 'assistant', uuid: 'u-2', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ファイルだけの本文' }] } })}\n`);
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === 'ファイルだけの本文') === true, 'the file-only line was not read');
		// the mod row arriving after the file line is not added again
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-2', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'ファイルだけの本文' }] } }] });
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-3', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '最後' }] } }] });
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === '最後') === true, 'the last mod row was not shown');
		assert.deepStrictEqual(harness.tailer()?.messages.filter(message => message.kind === 'text').map(message => message.text), ['mod から先に届いた本文', 'ファイルだけの本文', '最後']);
	}));

	test('streams the text the mod sends as the live message and clears it when the row lands', () => withHarness(async harness => {
		await harness.mod('event', { events: [{ type: 'turn.start', turnId: 't-1' }, { type: 'step', turnId: 't-1', step: 0, chunks: [{ index: 0, text: 'こんに' }], end: false }] });
		await harness.mod('event', { events: [{ type: 'step', turnId: 't-1', step: 0, chunks: [{ index: 0, text: 'ちは' }], end: true }] });
		const liveTexts = () => harness.sent.filter(message => message.t === 'delta').map(message => (message.live as { text?: string } | null | undefined)?.text ?? (message.liveAppend as { text?: string } | undefined)?.text).filter(text => text !== undefined);
		await waitFor(() => liveTexts().includes('こんにちは'), 'the streamed text was not sent');
		// MessageDisplay hooks are not used while the mod streams
		harness.hook('MessageDisplay', { messageId: 'm-1', messageDelta: '古い行\n', messageIndex: 0, messageFinal: false });
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-live', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'こんにちは' }] } }] });
		await waitFor(() => harness.sent.some(message => message.t === 'delta' && message.live === null), 'the live message was not cleared');
		assert.strictEqual(liveTexts().includes('古い行\n'), false);
	}));

	test('answers a question with values through the mod instead of keys', () => withHarness(async harness => {
		const questions = [{ question: '色は？', header: '色', multiSelect: false, options: [{ label: '赤', description: '' }, { label: '緑', description: '' }] }];
		const registered = await harness.mod('question', { toolUseId: 'toolu_q', questions });
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-q', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'question', 'the question card was not shown');
		const waiting = harness.mod('wait', { id: registered.id });
		harness.inbound({ t: 'action/answerQuestion', requestId: 'answer-1', epoch: harness.tailer()!.epoch, interactionId: 'toolu_q', answers: [{ kind: 'option', index: 1 }] });
		const reply = await waiting;
		harness.inbound({ t: 'action/answerQuestion', requestId: 'answer-2', epoch: harness.tailer()!.epoch, interactionId: 'toolu_q', answers: [{ kind: 'option', index: 0 }] });
		await waitFor(() => harness.sent.filter(message => message.t === 'action-result').length >= 2, 'the answers were not acknowledged');
		assert.deepStrictEqual({
			reply,
			results: harness.sent.filter(message => message.t === 'action-result').map(message => ({ requestId: message.requestId, status: message.status, code: message.code })),
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, {
			reply: { state: 'answer', answers: { '色は？': '緑' } },
			results: [{ requestId: 'answer-1', status: 'accepted', code: undefined }, { requestId: 'answer-2', status: 'rejected', code: 'interaction-locked' }],
			keys: 0,
		});
	}));

	test('offers "always allow" on a mod-backed approval and hands the decision to the mod', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_b', toolInput: { command: 'npm test' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		const registered = await harness.mod('permission', { toolUseId: 'toolu_b', toolName: 'Bash', toolInput: { command: 'npm test' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.choices?.some(choice => choice.id === 'always') === true, 'the approval did not offer "always"');
		const waiting = harness.mod('wait', { id: registered.id });
		harness.inbound({ t: 'action/answerApproval', requestId: 'approve-1', epoch: harness.tailer()!.epoch, interactionId: 'toolu_b', choice: 'always' });
		assert.deepStrictEqual({
			reply: await waiting,
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, { reply: { state: 'answer', decision: 'allow', always: true }, keys: 0 });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'approve-1' && message.status === 'accepted'), 'the approval was not acknowledged');
	}));

	test('sends a message through the mod while the agent is idle', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const poll = harness.mod('commands', { busy: false });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-1', epoch: harness.tailer()!.epoch, text: '続けて' });
		const commands = (await poll).commands as { id: string; kind: string; text: string }[];
		await harness.mod('ack', { id: commands[0].id, ok: true });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'send-1'), 'the send was not acknowledged');
		assert.deepStrictEqual({
			command: { kind: commands[0].kind, text: commands[0].text },
			result: harness.sent.filter(message => message.t === 'action-result').map(message => ({ status: message.status })),
			keys: harness.actions.filter(action => action.t === 'action/sendMessage').length,
		}, { command: { kind: 'submit', text: '続けて' }, result: [{ status: 'accepted' }], keys: 0 });
	}));

	test('falls back to the keys when no mod is listening', () => withHarness(async harness => {
		harness.hook('Stop');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-keys', epoch: harness.tailer()!.epoch, text: '続けて' });
		await waitFor(() => harness.actions.some(action => action.t === 'action/sendMessage'), 'the send did not go to the window');
	}));

	test('ends a subagent on its turn.complete, also when it was stopped', () => withHarness(async harness => {
		await harness.mod('event', { events: [{ type: 'subagent.start', agentId: 'a-one', subagentType: 'general-purpose', description: '調べる' }, { type: 'subagent.start', agentId: 'a-two', subagentType: 'Explore' }] });
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-a', agentId: 'a-one', aborted: false, reason: 'answer' }, { type: 'turn.complete', turnId: 't-b', agentId: 'a-two', aborted: true, reason: 'aborted' }, { type: 'turn.complete', turnId: 't-c', agentId: 'a-internal', aborted: false }] });
		const agents = () => ((harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { agents: readonly { id: string; status: string; label: string }[] } | undefined }> }).activityTrackers.get(harness.token)?.snapshot()?.agents ?? []);
		await waitFor(() => agents().length === 2 && agents().every(agent => agent.status !== 'running'), 'the subagents did not end');
		assert.deepStrictEqual(agents().map(agent => ({ id: agent.id, status: agent.status, label: agent.label })).sort((a, b) => a.id.localeCompare(b.id)), [
			{ id: 'a-one', status: 'completed', label: 'general-purpose' },
			{ id: 'a-two', status: 'interrupted', label: 'Explore' },
		]);
	}));

	test('leaves the approval card to the Stop hook when the mod reports the end of the turn', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_keep', toolInput: { command: 'ls' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-1', aborted: true, reason: 'aborted' }] });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const afterMod = harness.tailer()?.currentInteraction()?.kind;
		harness.hook('Stop');
		await waitFor(() => harness.tailer()?.currentInteraction() === null, 'the Stop hook did not clear the approval');
		assert.strictEqual(afterMod, 'approval');
	}));

	test('does not tie an old approval card to the wait of another call; shows the mod\'s own card instead', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_old', toolInput: { command: 'npm test' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.id === 'toolu_old', 'the old approval card was not shown');
		await harness.mod('permission', { toolUseId: 'toolu_new', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'session' }] });
		const interactions = () => (harness.chat as unknown as { tailers: Map<string, { approvalInteractions(): readonly { id: string; choices?: readonly { id: string; label: string }[] }[] }> }).tailers.get(harness.token)?.approvalInteractions() ?? [];
		await waitFor(() => interactions().some(card => card.id === 'toolu_new'), 'the mod\'s own card was not shown');
		await waitFor(() => interactions().find(card => card.id === 'toolu_new')?.choices?.some(choice => choice.id === 'always') === true, 'the mod card did not offer "always"');
		assert.deepStrictEqual(interactions().map(card => ({ id: card.id, choices: card.choices?.map(choice => choice.id === 'always' ? `always:${choice.label}` : choice.id) })), [
			{ id: 'toolu_old', choices: ['yes', 'no'] },
			{ id: 'toolu_new', choices: ['yes', 'always:許可（このセッションでは以後確認しない: Bash(rm -rf build)）', 'no'] },
		]);
		// "always" on the old card cannot reach the mod (it waits for another call)
		harness.inbound({ t: 'action/answerApproval', requestId: 'old-always', epoch: harness.tailer()!.epoch, interactionId: 'toolu_old', choice: 'always' });
		await waitFor(() => harness.sent.some(message => message.requestId === 'old-always'), 'the answer was not refused');
		assert.strictEqual(harness.sent.find(message => message.requestId === 'old-always')?.status, 'rejected');
	}));

	test('splits "this time" from "keep the rule" when the rule would outlive the session', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_p', toolInput: { command: 'npm test' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		await harness.mod('permission', { toolUseId: 'toolu_p', toolName: 'Bash', toolInput: { command: 'npm test' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.choices?.length === 3, 'the choices were not split');
		assert.deepStrictEqual(harness.tailer()?.currentInteraction()?.choices?.map(choice => (choice as { label?: string }).label), ['今回だけ許可', '許可して設定に残す: Bash(npm test:*)', '拒否']);
	}));

	test('ignores state changes from a caller that is not the pane\'s process, but still shows its rows', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_v', toolInput: { command: 'ls' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		harness.callerVerified = false;
		const registered = await harness.mod('permission', { toolUseId: 'toolu_v', toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-v', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '見える行' }] } }] });
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === '見える行') === true, 'the observed row was not shown');
		assert.deepStrictEqual({ registered: registered.error, choices: harness.tailer()?.currentInteraction()?.choices?.map(choice => choice.id) }, { registered: 'caller not verified', choices: ['yes', 'no'] });
	}));
	test('does not let rows from an unverified caller create a question card, a subagent or a user turn', () => withHarness(async harness => {
		harness.callerVerified = false;
		const questions = [{ question: '偽の質問？', header: '偽', multiSelect: false, options: [{ label: 'はい', description: '' }, { label: 'いいえ', description: '' }] }];
		await harness.mod('event', {
			events: [
				{ type: 'row', uuid: 'u-fake-q', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake', name: 'AskUserQuestion', input: { questions } }] } },
				{ type: 'row', uuid: 'u-fake-agent', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '偽の前置き' }, { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '偽', subagent_type: 'x' } }] } },
				{ type: 'row', uuid: 'u-fake-user', door: 'prompt', message: { type: 'user', role: 'user', content: [{ type: 'text', text: '偽の発言' }] } },
				{ type: 'row', uuid: 'u-shown', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '表示だけの文章' }] } },
			],
		});
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === '表示だけの文章') === true, 'the display-only row was not shown');
		assert.deepStrictEqual({
			interaction: harness.tailer()?.currentInteraction() ?? null,
			texts: harness.tailer()?.messages.map(message => `${message.kind}:${message.text}`),
		}, { interaction: null, texts: ['text:表示だけの文章'] });
		// the real line of a dropped row is still read from the file (not skipped as already shown)
		await appendFile(harness.transcriptPath, `${JSON.stringify({ type: 'assistant', uuid: 'u-fake-agent', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ファイルの本物' }] } })}\n`);
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === 'ファイルの本物') === true, 'the file line of a dropped row was skipped');
	}));

	test('a fake AskUserQuestion row from an unverified caller makes no card, even while a verification is remembered', () => withHarness(async harness => {
		// the real mod was verified a moment ago (the remembered verification is fresh)
		await harness.mod('event', { events: [{ type: 'turn.start', turnId: 't-v' }] });
		harness.callerVerified = false;
		const questions = [{ question: '偽の質問？', header: '偽', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-fake-q2', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake2', name: 'AskUserQuestion', input: { questions } }] } }] });
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-after', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '後の文章' }] } }] });
		await waitFor(() => harness.tailer()?.messages.some(message => message.text === '後の文章') === true, 'the display-only row was not shown');
		assert.deepStrictEqual({ interaction: harness.tailer()?.currentInteraction() ?? null, questions: harness.tailer()?.messages.filter(message => message.kind === 'question').length }, { interaction: null, questions: 0 });
		// the same row from the verified mod does make the card
		harness.callerVerified = true;
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-real-q', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_real', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.id === 'toolu_real', 'the verified question was not shown');
	}));

	test('words the "always" choice by what it adds, separating a mode switch and folding long lists', () => {
		const label = (suggestions: unknown[]) => paradisModApprovalChoices(suggestions).map(choice => choice.label);
		const many = Array.from({ length: 5 }, (_, index) => ({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `${'x'.repeat(60)}-${index}` }], behavior: 'allow', destination: 'session' }));
		assert.deepStrictEqual({
			mode: label([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
			folded: label(many)[1].endsWith('ほか 3 件）') && label(many)[1].length <= 200,
			none: label([]),
		}, {
			mode: ['今回だけ許可', '許可してモードを切り替える: mode: acceptEdits', '拒否'],
			folded: true,
			none: ['許可', '拒否'],
		});
	});
	test('tells the conversation when the mod received a message but could not send it', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const poll = harness.mod('commands', { busy: false });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const text = 'この発言は届かない長い本文です。'.repeat(6);
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-late', epoch: harness.tailer()!.epoch, text });
		const [command] = (await poll).commands as { id: string }[];
		await harness.mod('ack', { id: command.id, received: true });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'send-late'), 'the send was not acknowledged');
		await harness.mod('ack', { id: command.id, ok: false });
		const notice = () => harness.tailer()?.messages.find(message => message.text.startsWith('送れませんでした: '));
		await waitFor(() => notice() !== undefined, 'the failure was not told');
		const head = text.slice(0, 60);
		assert.deepStrictEqual({
			notice: notice()?.text,
			delivered: harness.sent.some(message => message.t === 'delta' && (message.messages as { text: string }[]).some(item => item.text === notice()?.text)),
			keys: harness.actions.filter(action => action.t === 'action/sendMessage').length,
		}, { notice: `送れませんでした: ${head}…`, delivered: true, keys: 0 });
	}));
});

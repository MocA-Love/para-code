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
import { fireParadisAgentHookEvent, onParadisAgentAwaitingUser } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisClaudeModBridge } from '../../../claudeMod/node/paradisClaudeModBridge.js';
import { ParadisMobileAgentChat, paradisModApprovalChoices } from '../../node/paradisMobileAgentChat.js';
import { paradisApprovalDenyMessage } from '../../common/paradisAgentApprovalRequest.js';

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
	/** mod へ渡した回答の鍵の時計を進める量（ms）。 */
	clockOffset: number;
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

interface IHarnessOptions {
	/** tailer を作る前に transcript へ書いておく行（初回読み込みで読まれる）。 */
	readonly initialLines?: readonly Record<string, unknown>[];
	/** tailer を作る前に mod から送る要求（`op` と本文）。 */
	readonly beforeStart?: readonly { readonly op: string; readonly body: Record<string, unknown> }[];
}

async function withHarness(run: (harness: IHarness) => Promise<void>, options: IHarnessOptions = {}): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-claude-mod-')));
	const previous = process.env['CLAUDE_CONFIG_DIR'];
	process.env['CLAUDE_CONFIG_DIR'] = root;
	const project = join(root, 'projects', 'para-code-tests');
	await mkdir(project, { recursive: true });
	const transcriptPath = join(project, `${SESSION}.jsonl`);
	await writeFile(transcriptPath, (options.initialLines ?? []).map(line => `${JSON.stringify(line)}\n`).join(''));
	const token = 'pane-claude-mod';
	const bridge = new ParadisClaudeModBridge();
	bridge.setPresence(() => 'connected');
	bridge.setApprovalWait(() => 600_000);
	const sent: Record<string, unknown>[] = [];
	const actions: Record<string, unknown>[] = [];
	const chat = new ParadisMobileAgentChat(
		(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
		(_mobileId, _windowId, _windowSession, _generation, payload) => actions.push(JSON.parse(new TextDecoder().decode(payload))),
		() => { }, new NullLogService(), async () => true, () => { }, undefined, undefined, undefined, bridge, () => Date.now() + harness.clockOffset,
	);
	const controller = new AbortController();
	const access = chat as unknown as { tailers: Map<string, ITailerAccess> };
	const harness: IHarness = {
		token, transcriptPath, bridge, chat, sent, actions, signal: controller.signal,
		tailer: () => access.tailers.get(token),
		inbound: message => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({ id: 1, token, ...message }))),
		mod: async (op, body) => (await bridge.handle(token, op, { sessionId: SESSION, ...body }, controller.signal, async () => harness.callerVerified)).body,
		callerVerified: true,
		clockOffset: 0,
		hook: (event, extra) => fireParadisAgentHookEvent({ token, event, sessionId: SESSION, transcriptPath, cwd: '/workspace', at: Date.now(), ...extra }),
	};
	try {
		for (const request of options.beforeStart ?? []) {
			await harness.mod(request.op, request.body);
		}
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

	test('sends the stop access again when the mod arrives, and stops a background shell through it', () => withHarness(async harness => {
		const accessOf = (message: Record<string, unknown> | undefined) => JSON.stringify(message?.shellsAccess);
		const snapshot = harness.sent.find(message => message.t === 'snapshot');
		await harness.mod('event', { events: [{ type: 'hello', version: '1.0.0' }] });
		await waitFor(() => harness.sent.some(message => message.t === 'delta' && accessOf(message) === JSON.stringify({ output: process.platform !== 'win32', stop: process.platform !== 'win32' })), 'the access was not sent again when the mod arrived');
		const poll = harness.mod('commands', { busy: true });
		harness.inbound({ t: 'action/stopShell', requestId: 'stop-1', epoch: harness.tailer()!.epoch, shellId: 'bshell1' });
		const commands = (await poll).commands as { id: string; kind: string; taskId: string }[];
		await harness.mod('ack', { id: commands[0]?.id, ok: true, message: 'Successfully stopped task: bshell1 (sleep 600)' });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'stop-1'), 'the stop was not answered');
		const shells = (harness.chat as unknown as { tailers: Map<string, { shells(): readonly { id: string; status: string; stoppedBy?: string }[] }> }).tailers.get(harness.token)?.shells();
		assert.deepStrictEqual({
			before: accessOf(snapshot),
			command: { kind: commands[0]?.kind, taskId: commands[0]?.taskId },
			result: harness.sent.find(message => message.t === 'action-result' && message.requestId === 'stop-1')?.status,
			shells: shells?.map(shell => `${shell.id}:${shell.status}:${shell.stoppedBy}`),
		}, {
			before: JSON.stringify({ output: process.platform !== 'win32', stop: false }),
			command: { kind: 'taskStop', taskId: 'bshell1' },
			result: 'accepted',
			shells: ['bshell1:stopped:mobile'],
		});
	}, {
		initialLines: [
			{ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } },
			{ type: 'user', timestamp: new Date().toISOString(), toolUseResult: { backgroundTaskId: 'bshell1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Command running in background with ID: bshell1.' }] } },
		],
	}));

	test('returns the plain Advisor reply when its detail is asked for', () => withHarness(async harness => {
		const trackers = (harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { advisors?: readonly { id: string; status: string }[] } | undefined }> }).activityTrackers;
		const line = (uuid: string, block: unknown) => `${JSON.stringify({ type: 'assistant', uuid, timestamp: new Date().toISOString(), advisorModel: 'claude-opus-4-7', message: { id: 'msg_plain', role: 'assistant', content: [block] } })}\n`;
		await appendFile(harness.transcriptPath, line('u-p1', { type: 'server_tool_use', id: 'srvtoolu_plain', name: 'advisor', input: {} }) + line('u-p2', { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_plain', content: { type: 'advisor_result', text: '順番を入れ替えてください。' } }));
		await waitFor(() => trackers.get(harness.token)?.snapshot()?.advisors?.[0]?.status === 'completed', 'the consultation was not listed');
		harness.inbound({ t: 'activity-detail', requestId: 'advisor-ok', epoch: harness.tailer()!.epoch, activityId: 'srvtoolu_plain' });
		await waitFor(() => harness.sent.some(message => message.t === 'activity-detail' && message.requestId === 'advisor-ok'), 'the detail was not answered');
		const answer = harness.sent.find(message => message.t === 'activity-detail' && message.requestId === 'advisor-ok');
		assert.deepStrictEqual({ error: answer?.error, messages: answer?.messages }, {
			error: undefined,
			messages: [{ role: 'tool', kind: 'tool', toolKind: 'tool_result', tool: 'Advisor', text: '順番を入れ替えてください。', advisor: { model: 'claude-opus-4-7', outcome: 'text' } }],
		});
	}));

	test('refuses the Advisor reply for another conversation, a pane the phone does not follow, and an encrypted reply', () => withHarness(async harness => {
		const trackers = (harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { advisors?: readonly { id: string; status: string }[] } | undefined }> }).activityTrackers;
		const line = (uuid: string, block: unknown) => `${JSON.stringify({ type: 'assistant', uuid, timestamp: new Date().toISOString(), advisorModel: 'claude-opus-4-7', message: { id: 'msg_refuse', role: 'assistant', content: [block] } })}\n`;
		await appendFile(harness.transcriptPath, [
			line('u-r1', { type: 'server_tool_use', id: 'srvtoolu_plain', name: 'advisor', input: {} }),
			line('u-r2', { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_plain', content: { type: 'advisor_result', text: '本文' } }),
			line('u-r3', { type: 'server_tool_use', id: 'srvtoolu_secret', name: 'advisor', input: {} }),
			line('u-r4', { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_secret', content: { type: 'advisor_redacted_result', encrypted_content: 'x' } }),
		].join(''));
		await waitFor(() => trackers.get(harness.token)?.snapshot()?.advisors?.filter(advisor => advisor.status === 'completed').length === 2, 'the consultations were not listed');
		const epoch = harness.tailer()!.epoch;
		harness.inbound({ t: 'activity-detail', requestId: 'advisor-epoch', epoch: 'another-epoch', activityId: 'srvtoolu_plain' });
		harness.chat.handleInbound('mobile-2', new TextEncoder().encode(JSON.stringify({ id: 1, token: harness.token, t: 'activity-detail', requestId: 'advisor-unfollowed', epoch, activityId: 'srvtoolu_plain' })));
		harness.inbound({ t: 'activity-detail', requestId: 'advisor-redacted', epoch, activityId: 'srvtoolu_secret' });
		const answered = ['advisor-epoch', 'advisor-redacted'];
		await waitFor(() => answered.every(id => harness.sent.some(message => message.t === 'activity-detail' && message.requestId === id)), 'the refusals were not answered');
		// 購読していない端末の要求は、答えないか拒否するだけで、本文は送らない
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		assert.deepStrictEqual(['advisor-epoch', 'advisor-unfollowed', 'advisor-redacted'].map(id => {
			const answer = harness.sent.find(message => message.t === 'activity-detail' && message.requestId === id);
			return [id, answer === undefined || typeof answer.error === 'string', answer?.messages];
		}), [['advisor-epoch', true, undefined], ['advisor-unfollowed', true, undefined], ['advisor-redacted', true, undefined]]);
	}));

	test('shows "consulting the Advisor" while waiting and lists the consultation when the result lands', () => withHarness(async harness => {
		const access = harness.chat as unknown as {
			liveStates: Map<string, { phase: string; tool?: string; detail?: string }>;
			activityTrackers: Map<string, { snapshot(): { advisors?: readonly { id: string; status: string; outcome?: string }[] } | undefined }>;
		};
		const advisorLine = (uuid: string, block: unknown) => `${JSON.stringify({ type: 'assistant', uuid, timestamp: new Date().toISOString(), advisorModel: 'claude-opus-5-5', message: { id: 'msg_adv', role: 'assistant', content: [block] } })}\n`;
		await appendFile(harness.transcriptPath, advisorLine('u-adv-1', { type: 'server_tool_use', id: 'srvtoolu_live', name: 'advisor', input: {} }));
		await waitFor(() => access.liveStates.get(harness.token)?.tool === 'Advisor', 'the live state did not show the Advisor');
		const waiting = access.liveStates.get(harness.token);
		await appendFile(harness.transcriptPath, advisorLine('u-adv-2', { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_live', content: { type: 'advisor_redacted_result', encrypted_content: 'x' } }));
		await waitFor(() => access.activityTrackers.get(harness.token)?.snapshot()?.advisors?.[0]?.status === 'completed', 'the consultation was not listed as completed');
		assert.deepStrictEqual({
			waiting: { phase: waiting?.phase, tool: waiting?.tool, detail: waiting?.detail },
			after: access.liveStates.get(harness.token)?.phase,
			advisors: access.activityTrackers.get(harness.token)?.snapshot()?.advisors?.map(advisor => [advisor.id, advisor.status, advisor.outcome]),
			rows: harness.tailer()?.messages.filter(message => message.toolUseId === 'srvtoolu_live').map(message => message.kind),
		}, {
			waiting: { phase: 'tool', tool: 'Advisor', detail: 'claude-opus-5-5' },
			after: 'thinking',
			advisors: [['srvtoolu_live', 'completed', 'redacted']],
			rows: ['tool_use', 'tool_result'],
		});
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

	test('answers a question with a preview through the mod with the preview and the notes, and marks the card as answerable by the mod', () => withHarness(async harness => {
		const questions = [
			{ question: '見せ方は？', header: '表示', multiSelect: false, options: [{ label: 'トースト', description: '', preview: '# Toast\n+---+' }, { label: 'インライン', description: '', preview: '# Inline' }] },
			{ question: '色は？', header: '色', multiSelect: false, options: [{ label: '赤', description: '' }, { label: '緑', description: '' }] },
		];
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-p', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'question', 'the question card was not shown');
		const before = harness.tailer()!.currentInteraction();
		const registered = await harness.mod('question', { toolUseId: 'toolu_p', questions });
		await waitFor(() => (harness.tailer()!.currentInteraction() as { answerVia?: string } | null)?.answerVia === 'mod', 'the card did not become answerable by the mod');
		// メモは preview のある質問にだけ付けられる
		harness.inbound({ t: 'action/answerQuestion', requestId: 'notes-wrong', epoch: harness.tailer()!.epoch, interactionId: 'toolu_p', answers: [{ kind: 'option', index: 0 }, { kind: 'option', index: 0, notes: 'x' }] });
		const waiting = harness.mod('wait', { id: registered.id });
		harness.inbound({ t: 'action/answerQuestion', requestId: 'notes-1', epoch: harness.tailer()!.epoch, interactionId: 'toolu_p', answers: [{ kind: 'option', index: 1, notes: '短めに' }, { kind: 'option', index: 0 }] });
		const reply = await waiting;
		await waitFor(() => harness.sent.filter(message => message.t === 'action-result').length >= 2, 'the answers were not acknowledged');
		const preview = (harness.tailer()!.messages.find(message => message.kind === 'question') as { options?: readonly { preview?: string }[] } | undefined)?.options?.map(option => option.preview);
		assert.deepStrictEqual({
			before,
			preview,
			reply,
			results: harness.sent.filter(message => message.t === 'action-result').map(message => ({ requestId: message.requestId, status: message.status, code: message.code })),
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, {
			before: { kind: 'question', id: 'toolu_p', answerVia: 'keys' },
			preview: ['# Toast\n+---+', '# Inline'],
			reply: { state: 'answer', answers: { '見せ方は？': 'インライン', '色は？': '赤' }, annotations: { '見せ方は？': { preview: '# Inline', notes: '短めに' } } },
			results: [{ requestId: 'notes-wrong', status: 'rejected', code: 'invalid-answer' }, { requestId: 'notes-1', status: 'accepted', code: undefined }],
			keys: 0,
		});
	}));

	test('withdraws the questions through the mod: with a message as the response, without one as the refusal the terminal writes', () => withHarness(async harness => {
		const questions = [
			{ question: '見せ方は？', header: '表示', multiSelect: false, options: [{ label: 'トースト', description: '', preview: '# Toast' }, { label: 'インライン', description: '' }] },
			{ question: '色は？', header: '色', multiSelect: false, options: [{ label: '赤', description: '' }, { label: '緑', description: '' }] },
		];
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-c', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'question', 'the question card was not shown');
		const first = await harness.mod('question', { toolUseId: 'toolu_c', questions });
		const waitingFirst = harness.mod('wait', { id: first.id });
		harness.inbound({ t: 'action/clarifyQuestion', requestId: 'chat-1', epoch: harness.tailer()!.epoch, interactionId: 'toolu_c', response: 'その前に画面を見せて' });
		const withMessage = await waitingFirst;
		// 同じカードへの 2 度目は受けない
		harness.inbound({ t: 'action/clarifyQuestion', requestId: 'chat-2', epoch: harness.tailer()!.epoch, interactionId: 'toolu_c' });
		await waitFor(() => harness.sent.filter(message => message.t === 'action-result').length >= 2, 'the withdrawals were not acknowledged');
		// 同じカードへの二度目を断る時間（60 秒）を過ぎたことにする
		harness.clockOffset = 61_000;
		const second = await harness.mod('question', { toolUseId: 'toolu_c', questions });
		const waitingSecond = harness.mod('wait', { id: second.id });
		harness.inbound({ t: 'action/clarifyQuestion', requestId: 'chat-3', epoch: harness.tailer()!.epoch, interactionId: 'toolu_c', answers: [{ kind: 'option', index: 0, notes: '短めに' }, null] });
		const withoutMessage = await waitingSecond;
		assert.deepStrictEqual({
			withMessage,
			withoutMessage,
			results: harness.sent.filter(message => message.t === 'action-result').map(message => ({ requestId: message.requestId, status: message.status, code: message.code })),
		}, {
			withMessage: { state: 'clarify', response: 'その前に画面を見せて' },
			withoutMessage: {
				state: 'clarify',
				deny: 'The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "見せ方は？"\n  Answer: トースト\n  User notes: 短めに\n- "色は？"\n  (No answer provided)',
			},
			results: [{ requestId: 'chat-1', status: 'accepted', code: undefined }, { requestId: 'chat-2', status: 'rejected', code: 'interaction-locked' }, { requestId: 'chat-3', status: 'accepted', code: undefined }],
		});
	}));

	test('without the mod, refuses the notes, "Other" on a question with a preview and withdrawing, instead of typing keys', () => withHarness(async harness => {
		const questions = [{ question: '見せ方は？', header: '表示', multiSelect: false, options: [{ label: 'トースト', description: '', preview: '# Toast' }, { label: 'インライン', description: '' }] }];
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-k', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_k', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'question', 'the question card was not shown');
		const epoch = harness.tailer()!.epoch;
		harness.inbound({ t: 'action/answerQuestion', requestId: 'k-notes', epoch, interactionId: 'toolu_k', answers: [{ kind: 'option', index: 0, notes: 'メモ' }] });
		harness.inbound({ t: 'action/answerQuestion', requestId: 'k-other', epoch, interactionId: 'toolu_k', answers: [{ kind: 'text', optionCount: 2, text: 'ダイアログ' }] });
		harness.inbound({ t: 'action/clarifyQuestion', requestId: 'k-chat', epoch, interactionId: 'toolu_k', response: '話したい' });
		await waitFor(() => harness.sent.filter(message => message.t === 'action-result').length >= 3, 'the answers were not refused');
		assert.deepStrictEqual({
			interaction: harness.tailer()!.currentInteraction(),
			results: harness.sent.filter(message => message.t === 'action-result').map(message => ({ requestId: message.requestId, status: message.status, code: message.code })),
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, {
			interaction: { kind: 'question', id: 'toolu_k', answerVia: 'keys' },
			results: [
				{ requestId: 'k-notes', status: 'rejected', code: 'invalid-answer' },
				{ requestId: 'k-other', status: 'rejected', code: 'invalid-answer' },
				{ requestId: 'k-chat', status: 'rejected', code: 'stale-interaction' },
			],
			keys: 0,
		});
	}));

	test('marks the card as answerable by the keys again when the mod stops waiting', () => withHarness(async harness => {
		const questions = [{ question: '見せ方は？', header: '表示', multiSelect: false, options: [{ label: 'トースト', description: '', preview: '# Toast' }, { label: 'インライン', description: '' }] }];
		await harness.mod('event', { events: [{ type: 'row', uuid: 'u-s', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'AskUserQuestion', input: { questions } }] } }] });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'question', 'the question card was not shown');
		const registered = await harness.mod('question', { toolUseId: 'toolu_s', questions });
		await waitFor(() => (harness.tailer()!.currentInteraction() as { answerVia?: string } | null)?.answerVia === 'mod', 'the card did not become answerable by the mod');
		// the terminal answered first: the mod settles its wait
		await harness.mod('settle', { ids: [registered.id] });
		await waitFor(() => (harness.tailer()!.currentInteraction() as { answerVia?: string } | null)?.answerVia === 'keys', 'the card stayed answerable by the mod');
		const pushed = harness.sent.filter(message => (message.t === 'delta' || message.t === 'snapshot') && (message.interaction as { answerVia?: string } | null)?.answerVia !== undefined)
			.map(message => (message.interaction as { answerVia: string }).answerVia);
		assert.deepStrictEqual(pushed.filter((value, index) => index === 0 || value !== pushed[index - 1]), ['keys', 'mod', 'keys']);
	}));

	test('a question already in the transcript when the pane is first read is answerable by the mod that was waiting before', () => {
		const questions = [{ question: '見せ方は？', header: '表示', multiSelect: false, options: [{ label: 'トースト', description: '', preview: '# Toast' }, { label: 'インライン', description: '' }] }];
		return withHarness(async harness => {
			await waitFor(() => (harness.tailer()?.currentInteraction() as { answerVia?: string } | null | undefined)?.answerVia === 'mod', 'the first read left the card on the keys');
			assert.deepStrictEqual(harness.tailer()!.currentInteraction(), { kind: 'question', id: 'toolu_i', answerVia: 'mod' });
		}, {
			initialLines: [{ type: 'assistant', uuid: 'u-i', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_i', name: 'AskUserQuestion', input: { questions } }] } }],
			beforeStart: [{ op: 'question', body: { toolUseId: 'toolu_i', questions } }],
		});
	});

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

	test('denies with the instruction through a mod that accepts it, and shows what was asked and by which subagent', () => withHarness(async harness => {
		const input = { command: 'sh -c "rm -rf build"', description: 'Clean the build' };
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_d', toolInput: input });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: input, payload: { agent_id: 'a-sub', agent_type: 'general-purpose', permission_suggestions: [] } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		const registered = await harness.mod('permission', { toolUseId: 'toolu_d', toolName: 'Bash', toolInput: input, suggestions: [], agentId: 'a-sub', denyMessage: true });
		const card = () => harness.tailer()?.currentInteraction() as { readonly answerVia?: string; readonly request?: unknown; readonly detail?: string } | null | undefined;
		await waitFor(() => card()?.answerVia === 'mod', 'the approval was not marked as answerable with an instruction');
		const shown = { detail: card()?.detail, request: card()?.request };
		const waiting = harness.mod('wait', { id: registered.id });
		harness.inbound({ t: 'action/answerApproval', requestId: 'deny-1', epoch: harness.tailer()!.epoch, interactionId: 'toolu_d', choice: 'no', message: 'build は残して、echo kept だけ実行して' });
		assert.deepStrictEqual({
			shown,
			reply: await waiting,
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, {
			shown: {
				detail: 'Bash: Clean the build',
				request: { tool: 'Bash', kind: 'bash', command: 'sh -c "rm -rf build"', description: 'Clean the build', agent: { id: 'a-sub', name: 'general-purpose', role: 'subagent' } },
			},
			reply: { state: 'answer', decision: 'deny', message: paradisApprovalDenyMessage('build は残して、echo kept だけ実行して') },
			keys: 0,
		});
	}));

	test('keeps the pane working after a refusal that carries an instruction (the phone or the terminal amend), and stops it on a plain refusal', () => withHarness(async harness => {
		const access = harness.chat as unknown as { liveStates: Map<string, unknown>; activeTurnTokens: Set<string> };
		const awaiting: number[] = [];
		const listener = onParadisAgentAwaitingUser(event => { if (event.token === harness.token) { awaiting.push(event.at); } });
		try {
			// Claude Code 2.1.289 が書く tool_result（実測。指示付きは TUI の amend とモバイルの「拒否して指示を書く」で同じ）
			const plain = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.';
			const result = (id: string, text: string) => `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'rm -rf build' } }] } })}\n${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] } })}\n`;
			const refuse = async (id: string, text: string) => {
				harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: id, toolInput: { command: 'rm -rf build' } });
				harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'rm -rf build' } });
				await waitFor(() => harness.tailer()?.currentInteraction()?.id === id, `the approval ${id} was not shown`);
				await appendFile(harness.transcriptPath, result(id, text));
				await waitFor(() => harness.tailer()?.currentInteraction() === null, `the approval ${id} was not settled`);
				await new Promise<void>(resolve => setTimeout(resolve, 50));
				return { live: access.liveStates.has(harness.token), activeTurn: access.activeTurnTokens.has(harness.token), awaitingUser: awaiting.length };
			};
			const withInstruction = await refuse('toolu_i', paradisApprovalDenyMessage('build は残して、echo kept だけ実行して'));
			const plainRefusal = await refuse('toolu_p', plain);
			assert.deepStrictEqual({ withInstruction, plainRefusal }, {
				withInstruction: { live: true, activeTurn: true, awaitingUser: 0 },
				plainRefusal: { live: false, activeTurn: false, awaitingUser: 1 },
			});
		} finally {
			listener.dispose();
		}
	}));

	test('does not tie a card to a mod wait with the same description but another command', () => withHarness(async harness => {
		type Card = { readonly id: string; readonly answerVia?: string; readonly request?: { readonly command?: string; readonly agent?: unknown } };
		const cards = () => (harness.tailer() as unknown as { approvalInteractions(): readonly Card[] }).approvalInteractions();
		// agent_type だけの hook（agent_id が無い）は送り元を作らない
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test', description: 'Run the checks' }, payload: { agent_type: 'general-purpose' } });
		await waitFor(() => cards().length === 1, 'the hook card was not shown');
		await harness.mod('permission', { toolName: 'Bash', toolInput: { command: 'rm -rf build', description: 'Run the checks' }, suggestions: [], denyMessage: true });
		// 合わなければ少し後に mod の内容で別のカードを出す
		await waitFor(() => cards().length === 2, 'the mod card was not shown separately');
		assert.deepStrictEqual(cards().map(card => ({ command: card.request?.command, agent: card.request?.agent, answerVia: card.answerVia })), [
			{ command: 'npm test', agent: undefined, answerVia: undefined },
			{ command: 'rm -rf build', agent: undefined, answerVia: 'mod' },
		]);
	}));

	test('does not drop the instruction when the mod cannot carry it (an older mod), and sends no keys', () => withHarness(async harness => {
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_e', toolInput: { command: 'npm test' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		await harness.mod('permission', { toolUseId: 'toolu_e', toolName: 'Bash', toolInput: { command: 'npm test' }, suggestions: [] });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/answerApproval', requestId: 'deny-2', epoch: harness.tailer()!.epoch, interactionId: 'toolu_e', choice: 'no', message: 'やめて' });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'deny-2'), 'the answer was not acknowledged');
		assert.deepStrictEqual({
			answerVia: (harness.tailer()?.currentInteraction() as { readonly answerVia?: string } | null | undefined)?.answerVia,
			result: harness.sent.filter(message => message.t === 'action-result' && message.requestId === 'deny-2').map(message => ({ status: message.status, code: message.code })),
			keys: harness.actions.filter(action => action.t === 'action/interaction').length,
		}, { answerVia: undefined, result: [{ status: 'rejected', code: 'stale-interaction' }], keys: 0 });
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

	test('a second message the mod refuses as busy goes by keys only after the first one was received', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const firstPoll = harness.mod('commands', { busy: false });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-first', epoch: harness.tailer()!.epoch, text: '一通目' });
		const [first] = (await firstPoll).commands as { id: string }[];
		// mod は 1 通目を送っている最中に次のポーリングへ来る。2 通目を渡し、busy で断らせる
		const secondPoll = harness.mod('commands', { busy: false });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-second', epoch: harness.tailer()!.epoch, text: '二通目' });
		const [second] = (await secondPoll).commands as { id: string }[];
		await harness.mod('ack', { id: second.id, ok: false, reason: 'busy' });
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		const keysBeforeFirst = harness.actions.filter(action => action.t === 'action/sendMessage').length;
		await harness.mod('ack', { id: first.id, received: true });
		await waitFor(() => harness.actions.some(action => action.t === 'action/sendMessage'), 'the second message did not go by keys');
		assert.deepStrictEqual({
			keysBeforeFirst,
			keys: harness.actions.filter(action => action.t === 'action/sendMessage').map(action => action.text),
			firstResult: harness.sent.find(message => message.t === 'action-result' && message.requestId === 'send-first')?.status,
		}, { keysBeforeFirst: 0, keys: ['二通目'], firstResult: 'accepted' });
	}));

	test('falls back to the keys when no mod is listening', () => withHarness(async harness => {
		harness.hook('Stop');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'send-keys', epoch: harness.tailer()!.epoch, text: '続けて' });
		await waitFor(() => harness.actions.some(action => action.t === 'action/sendMessage'), 'the send did not go to the window');
	}));

	test('runs a slash command through a mod that can, and answers its refusal with the reason', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const poll = harness.mod('commands', { busy: false, features: ['commands.list', 'command.run'] });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		harness.inbound({ t: 'action/sendMessage', requestId: 'slash-1', epoch: harness.tailer()!.epoch, text: '/nonexistent a b' });
		const [command] = (await poll).commands as { id: string; kind: string; command: string; args: string }[];
		await harness.mod('ack', { id: command.id, ok: false, reason: 'refused', message: 'no command named /nonexistent in this session' });
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'slash-1'), 'the slash command was not answered');
		assert.deepStrictEqual({
			command: { kind: command.kind, command: command.command, args: command.args },
			result: harness.sent.filter(message => message.t === 'action-result').map(message => ({ status: message.status, code: message.code, message: message.message })),
			keys: harness.actions.filter(action => action.t === 'action/sendMessage').length,
		}, {
			command: { kind: 'commandRun', command: 'nonexistent', args: 'a b' },
			result: [{ status: 'rejected', code: 'unknown-command', message: 'Claude Code が /nonexistent を実行しませんでした（no command named /nonexistent in this session）' }],
			keys: 0,
		});
	}));

	test('a slash command sent by keys to Claude Code is refused afterwards when the transcript says "Unknown command", without holding the window\'s answer', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const poll = harness.mod('commands', { busy: false });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const epoch = harness.tailer()!.epoch;
		harness.inbound({ t: 'action/sendMessage', requestId: 'slash-keys', epoch, text: '/nonexistent' });
		harness.inbound({ t: 'action/sendMessage', requestId: 'slash-known', epoch, text: '/context' });
		harness.inbound({ t: 'action/sendMessage', requestId: 'slash-untyped', epoch, text: '/other' });
		await waitFor(() => harness.actions.filter(action => action.t === 'action/sendMessage').length === 3, 'the slash commands did not go to the window');
		// 古い mod のポーリングは、後片付けで切れる
		void poll.catch(() => undefined);
		// 所有ウィンドウが受け取って打ったもの（claim 済み）だけ。`slash-untyped` は打たれていない
		for (const requestId of ['slash-keys', 'slash-known']) {
			assert.strictEqual(harness.chat.claimSendMessageAction('mobile-1', requestId, harness.token, epoch, 1, 'window-session'), 'claimed');
		}
		const now = new Date().toISOString();
		await appendFile(harness.transcriptPath, [
			JSON.stringify({ type: 'system', subtype: 'informational', content: 'Unknown command: /nonexistent', timestamp: now }),
			JSON.stringify({ type: 'system', subtype: 'informational', content: 'Unknown command: /other', timestamp: now }),
			JSON.stringify({ type: 'system', subtype: 'local_command', content: '<command-name>/context</command-name>', timestamp: now }),
		].map(line => `${line}\n`).join(''));
		await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === 'slash-keys'), 'the late refusal was not sent');
		await new Promise<void>(resolve => setTimeout(resolve, 400));
		assert.deepStrictEqual({
			window: harness.actions.filter(action => action.t === 'action/sendMessage').map(action => [action.agent, action.slashCheck]),
			late: harness.sent.filter(message => message.t === 'action-result' && message.late === true).map(message => ({ requestId: message.requestId, status: message.status, code: message.code, message: message.message, late: message.late })),
			notice: harness.tailer()?.messages.filter(message => (message as { notice?: boolean }).notice === true).map(message => message.text),
		}, {
			window: [['claude', undefined], ['claude', undefined], ['claude', undefined]],
			late: [{ requestId: 'slash-keys', status: 'rejected', code: 'unknown-command', message: 'Claude Code に /nonexistent というコマンドはありません', late: true }],
			notice: ['Claude Code に /nonexistent というコマンドはありません'],
		});
	}));

	test('asks the mod whether a screen holds the keys before typing, and does not retry by keys what the mod refused', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const features = ['commands.list', 'command.run', 'prompt.dialog'];
		const openPoll = () => harness.mod('commands', { busy: false, features });
		const handed: string[] = [];
		let poll = openPoll();
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		/** Takes the command the open poll hands over, opens the next poll, then acks it. */
		const answer = async (ack: (command: Record<string, unknown>) => Record<string, unknown>) => {
			const [command] = (await poll).commands as Record<string, unknown>[];
			handed.push(String(command.kind));
			poll = openPoll();
			await new Promise<void>(resolve => setTimeout(resolve, 20));
			await harness.mod('ack', { id: command.id, ...ack(command) });
		};
		const resultOf = async (requestId: string) => {
			await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === requestId), `${requestId} was not answered`);
			return harness.sent.filter(message => message.t === 'action-result' && message.requestId === requestId).map(message => ({ status: message.status, code: message.code }));
		};
		const epoch = harness.tailer()!.epoch;

		harness.inbound({ t: 'action/sendMessage', requestId: 'open-config', epoch, text: '/config' });
		await answer(() => ({ ok: true, dialog: false }));
		await answer(() => ({ received: true }));
		const opened = await resultOf('open-config');
		// まだ終わっていないコマンドは、画面を開いたかを聞き直し、開いていればアプリへ帯（panel）を送る
		await answer(() => ({ ok: true, dialog: true }));
		await waitFor(() => harness.sent.some(message => message.t === 'delta' && message.panel !== undefined), 'the open panel was not sent');

		harness.inbound({ t: 'action/sendMessage', requestId: 'while-open', epoch, text: '!ls' });
		await answer(() => ({ ok: true, dialog: true }));
		const whileOpen = await resultOf('while-open');

		// 「開いている」の答えは少しの間使う（mod へ聞き直さない）
		harness.inbound({ t: 'action/claudeSetting', requestId: 'model-while-open', epoch, setting: 'model', value: 'haiku' });
		const modelWhileOpen = await resultOf('model-while-open');
		await new Promise<void>(resolve => setTimeout(resolve, 600));

		harness.inbound({ t: 'action/sendMessage', requestId: 'refused', epoch, text: '続けて' });
		await answer(() => ({ ok: true, dialog: false }));
		await answer(() => ({ ok: false }));
		const refused = await resultOf('refused');

		harness.inbound({ t: 'action/sendMessage', requestId: 'internal', epoch, text: '/__remote-workflow' });
		const internal = await resultOf('internal');

		assert.deepStrictEqual({
			opened, whileOpen, modelWhileOpen, refused, internal, handed,
			keys: harness.actions.filter(action => action.t === 'action/sendMessage' || action.t === 'action/claudeSetting').length,
			// 開いた画面は /config の名前付きで送り、閉じていると分かったら null で外す
			panels: harness.sent.filter(message => message.t === 'delta' && message.panel !== undefined).map(message => message.panel === null ? null : (message.panel as { command?: string }).command ?? '(unknown)'),
		}, {
			opened: [{ status: 'accepted', code: undefined }],
			whileOpen: [{ status: 'rejected', code: 'panel-open' }],
			modelWhileOpen: [{ status: 'rejected', code: 'panel-open' }],
			refused: [{ status: 'rejected', code: 'send-refused' }],
			internal: [{ status: 'rejected', code: 'unknown-command' }],
			handed: ['dialogCheck', 'commandRun', 'dialogCheck', 'dialogCheck', 'dialogCheck', 'submit'],
			keys: 0,
			panels: ['config', null],
		});
	}));

	test('closes an open panel with Esc only after the mod says it is open, and switches the model by /config for /model <alias>', () => withHarness(async harness => {
		harness.hook('Stop');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		const features = ['commands.list', 'command.run', 'prompt.dialog'];
		const openPoll = () => harness.mod('commands', { busy: false, features });
		let poll = openPoll();
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const handed: Record<string, unknown>[] = [];
		const answer = async (ack: Record<string, unknown>) => {
			const [command] = (await poll).commands as Record<string, unknown>[];
			handed.push({ kind: command.kind, ...(command.command !== undefined ? { command: command.command, args: command.args } : {}) });
			poll = openPoll();
			await new Promise<void>(resolve => setTimeout(resolve, 20));
			await harness.mod('ack', { id: command.id, ...ack });
		};
		const resultOf = async (requestId: string) => {
			await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === requestId), `${requestId} was not answered`);
			return harness.sent.filter(message => message.t === 'action-result' && message.requestId === requestId).map(message => ({ status: message.status, code: message.code }));
		};
		const epoch = harness.tailer()!.epoch;

		// PC で開いた画面: 送ろうとしたときに分かり、名前の無い帯を出す
		harness.inbound({ t: 'action/sendMessage', requestId: 'blocked', epoch, text: '続けて' });
		await answer({ ok: true, dialog: true });
		const blocked = await resultOf('blocked');
		// 「閉じる」: 開いていると答えたら Esc を打つ（所有ウィンドウへ回す）
		harness.inbound({ t: 'action/closePanel', requestId: 'close-1', epoch });
		await answer({ ok: true, dialog: true });
		await waitFor(() => harness.actions.some(action => action.t === 'action/closePanel'), 'the Esc did not go to the window');
		// もう閉じていれば打たない
		harness.inbound({ t: 'action/closePanel', requestId: 'close-2', epoch });
		await answer({ ok: true, dialog: false });
		const closedAlready = await resultOf('close-2');

		// `/model <別名>` は確認を出さない `/config model=<別名>` で、別名でなければ送らない
		harness.inbound({ t: 'action/sendMessage', requestId: 'model-alias', epoch, text: '/model Sonnet' });
		await answer({ ok: true, dialog: false });
		await answer({ ok: true });
		const switched = await resultOf('model-alias');
		harness.inbound({ t: 'action/sendMessage', requestId: 'model-id', epoch, text: '/model claude-sonnet-5-5' });
		const notAlias = await resultOf('model-id');

		assert.deepStrictEqual({
			blocked, closedAlready, switched, notAlias, handed,
			escapes: harness.actions.filter(action => action.t === 'action/closePanel').map(action => action.requestId),
			panels: harness.sent.filter(message => message.t === 'delta' && message.panel !== undefined).map(message => message.panel === null ? null : Object.keys(message.panel as object).sort()),
		}, {
			blocked: [{ status: 'rejected', code: 'panel-open' }],
			closedAlready: [{ status: 'accepted', code: 'already-closed' }],
			switched: [{ status: 'accepted', code: undefined }],
			notAlias: [{ status: 'rejected', code: 'unknown-command' }],
			handed: [
				{ kind: 'dialogCheck' }, { kind: 'dialogCheck' }, { kind: 'dialogCheck' },
				{ kind: 'dialogCheck' }, { kind: 'commandRun', command: 'config', args: 'model=sonnet' },
			],
			escapes: ['close-1'],
			panels: [['since'], null],
		});
	}));

	test('does not send Esc to close a panel while working, compacting, waiting for an approval, without a mod that can tell, or when a turn started before the window took it', () => withHarness(async harness => {
		const epoch = harness.tailer()!.epoch;
		const closeResult = async (requestId: string) => {
			harness.inbound({ t: 'action/closePanel', requestId, epoch });
			await waitFor(() => harness.sent.some(message => message.t === 'action-result' && message.requestId === requestId), `${requestId} was not answered`);
			return harness.sent.filter(message => message.t === 'action-result' && message.requestId === requestId).map(message => message.code);
		};
		// mod が来ていないペイン（入力待ち）
		harness.hook('Stop');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const noMod = await closeResult('close-no-mod');

		const features = ['commands.list', 'command.run', 'prompt.dialog'];
		let poll = harness.mod('commands', { busy: false, features });
		await waitFor(() => harness.bridge.isAlive(harness.token, SESSION), 'the mod was not alive');
		await harness.mod('event', { events: [{ type: 'turn.complete', turnId: 't-0', aborted: false, reason: 'answer' }] });
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// 作業中
		harness.hook('UserPromptSubmit');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const working = await closeResult('close-working');
		harness.hook('Stop');
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// 圧縮中（PreCompact から PostCompact まで）
		harness.hook('PreCompact', { payload: { hook_event_name: 'PreCompact', trigger: 'manual' } });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const compacting = await closeResult('close-compacting');
		harness.hook('PostCompact', { payload: { hook_event_name: 'PostCompact', trigger: 'manual' } });
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// mod が prompt.dialog を持たない（古い mod）
		poll = harness.mod('commands', { busy: false, features: ['commands.list', 'command.run'] });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const noDialog = await closeResult('close-no-dialog');
		poll = harness.mod('commands', { busy: false, features });
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// Esc を回した後、所有ウィンドウが受け取る前にターンが始まった（claim で確かめ直して stale）
		harness.inbound({ t: 'action/closePanel', requestId: 'close-raced', epoch });
		const [check] = (await poll).commands as Record<string, unknown>[];
		poll = harness.mod('commands', { busy: false, features });
		await harness.mod('ack', { id: check.id, ok: true, dialog: true });
		await waitFor(() => harness.actions.some(action => action.t === 'action/closePanel' && action.requestId === 'close-raced'), 'the Esc did not go to the window');
		harness.hook('UserPromptSubmit');
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		const raced = harness.chat.claimSendMessageAction('mobile-1', 'close-raced', harness.token, epoch, 1, 'window-session');
		harness.hook('Stop');
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// 承認を待っている（mod の画面の問い合わせはその画面と区別できない）
		harness.hook('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_close', toolInput: { command: 'npm test' } });
		harness.hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' } });
		await waitFor(() => harness.tailer()?.currentInteraction()?.kind === 'approval', 'the approval card was not shown');
		const approval = await closeResult('close-approval');

		void poll.catch(() => undefined);
		assert.deepStrictEqual({ noMod, working, compacting, noDialog, raced, approval, escapes: harness.actions.filter(action => action.t === 'action/closePanel').map(action => action.requestId) }, {
			noMod: ['panel-not-closable'],
			working: ['panel-not-closable'],
			compacting: ['panel-not-closable'],
			noDialog: ['panel-not-closable'],
			raced: 'stale',
			approval: ['panel-not-closable'],
			escapes: ['close-raced'],
		});
	}));

	test('keeps the full compaction summary apart from the tool outputs, so many tool results do not push it out', () => withHarness(async harness => {
		const at = () => new Date().toISOString();
		const body = `1. Primary Request and Intent:\n${'summary '.repeat(200)}`;
		const lines = [
			JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at(), compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 } }),
			JSON.stringify({ type: 'user', timestamp: at(), isCompactSummary: true, message: { role: 'user', content: body } }),
		];
		for (let index = 0; index < 45; index++) {
			lines.push(JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_fill${index}`, name: 'Bash', input: { command: 'cat big' } }] } }));
			lines.push(JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_fill${index}`, content: `${index} `.repeat(1000) }] } }));
		}
		await appendFile(harness.transcriptPath, lines.map(line => `${line}\n`).join(''));
		const summaryRev = () => (harness.tailer()?.messages as readonly { readonly rev?: number; readonly noticeSource?: string }[] | undefined)?.find(message => message.noticeSource === 'compact-summary')?.rev;
		await waitFor(() => summaryRev() !== undefined && harness.tailer()!.messages.filter(message => message.kind === 'tool_result').length >= 45, 'the summary and the tool results were not read');
		harness.inbound({ t: 'tool-full', requestId: 'summary-full', epoch: harness.tailer()!.epoch, rev: summaryRev() });
		await waitFor(() => harness.sent.some(message => message.t === 'tool-full' && message.requestId === 'summary-full'), 'the full summary was not answered');
		const reply = harness.sent.find(message => message.t === 'tool-full' && message.requestId === 'summary-full');
		assert.deepStrictEqual({ text: reply?.text, error: reply?.error }, { text: body.trim(), error: undefined });
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

	test('links a subagent to the Agent call the mod reports it was started by', () => withHarness(async harness => {
		await harness.mod('event', { events: [{ type: 'subagent.start', agentId: 'a-one', toolUseId: 'toolu_agent1', subagentType: 'general-purpose' }] });
		const agents = () => ((harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { agents: readonly { id: string; toolUseIds?: readonly string[] }[] } | undefined }> }).activityTrackers.get(harness.token)?.snapshot()?.agents ?? []);
		await waitFor(() => agents().length === 1, 'the subagent was not listed');
		assert.deepStrictEqual(agents().map(agent => ({ id: agent.id, toolUseIds: agent.toolUseIds })), [{ id: 'a-one', toolUseIds: ['toolu_agent1'] }]);
	}));

	test('does not revive a finished subagent when the mod reports its start after the end', () => withHarness(async harness => {
		const agents = () => ((harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { agents: readonly { id: string; status: string; toolUseIds?: readonly string[] }[] } | undefined }> }).activityTrackers.get(harness.token)?.snapshot()?.agents ?? []);
		const now = Date.now();
		harness.hook('SubagentStart', { payload: { agent_id: 'a-grand', agent_type: 'Explore' }, at: now - 5_000 });
		await waitFor(() => agents().some(agent => agent.id === 'a-grand'), 'the subagent was not listed');
		harness.hook('SubagentStop', { payload: { agent_id: 'a-grand' }, at: now - 4_000 });
		await waitFor(() => agents().some(agent => agent.id === 'a-grand' && agent.status === 'completed'), 'the subagent did not end');
		// フォアグラウンドの子の subagent.start は Agent の結果から作られ、終わった 3 秒後に届く
		await harness.mod('event', { events: [{ type: 'subagent.start', agentId: 'a-grand', toolUseId: 'toolu_grand', subagentType: 'Explore', at: now - 1_000 }] });
		await waitFor(() => agents().some(agent => agent.toolUseIds !== undefined), 'the subagent was not linked');
		assert.deepStrictEqual(agents().map(agent => ({ id: agent.id, status: agent.status, toolUseIds: agent.toolUseIds })), [{ id: 'a-grand', status: 'completed', toolUseIds: ['toolu_grand'] }]);
	}));

	test('moves the calls that started and resumed a named subagent from its name to its transcript file when reading the records again', () => withHarness(async harness => {
		const agents = () => ((harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { agents: readonly { id: string; label: string; toolUseIds?: readonly string[] }[] } | undefined }> }).activityTrackers.get(harness.token)?.snapshot()?.agents ?? []);
		const at = (second: number) => new Date(Date.now() - 60_000 + second * 1_000).toISOString();
		await writeFile(harness.transcriptPath, [
			{ type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { name: 'worker', description: '調べる', subagent_type: 'general-purpose' } }] } },
			{ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn', content: 'Spawned successfully.\nagent_id: worker@team\nThe agent is now running.' }] } },
			{ type: 'assistant', timestamp: at(5), message: { content: [{ type: 'tool_use', id: 'toolu_send', name: 'SendMessage', input: { to: 'worker', message: '続けて' } }] } },
			{ type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '{"success":true,"message":"Resuming agent worker","resumedAgentId":"worker"}' }] } },
		].map(line => JSON.stringify(line)).join('\n') + '\n');
		const subagents = join(harness.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
		await mkdir(subagents, { recursive: true });
		await writeFile(join(subagents, 'agent-afile01.jsonl'), JSON.stringify({ type: 'user', timestamp: at(2), message: { content: '調べる' } }) + '\n');
		await writeFile(join(subagents, 'agent-afile01.meta.json'), JSON.stringify({ name: 'worker', agentType: 'general-purpose' }));
		// hook のたびに記録を読み直す
		harness.hook('PostToolUse', { toolName: 'SendMessage', toolUseId: 'toolu_send' });
		await waitFor(() => agents().some(agent => agent.toolUseIds?.length === 2), 'the calls were not linked to the transcript file');
		assert.deepStrictEqual(agents().map(agent => ({ id: agent.id, label: agent.label, toolUseIds: agent.toolUseIds })), [{ id: 'afile01', label: 'worker', toolUseIds: ['toolu_spawn', 'toolu_send'] }]);
	}));

	test('links a subagent to the Agent call from the hooks only when one launch is waiting', () => withHarness(async harness => {
		const agents = () => ((harness.chat as unknown as { activityTrackers: Map<string, { snapshot(): { agents: readonly { id: string; toolUseIds?: readonly string[] }[] } | undefined }> }).activityTrackers.get(harness.token)?.snapshot()?.agents ?? []);
		const waiting = () => (harness.chat as unknown as { pendingSubagentCalls: Map<string, { launches: Map<string, number> }> }).pendingSubagentCalls.get(harness.token)?.launches.size ?? 0;
		harness.hook('PreToolUse', { toolName: 'Agent', toolUseId: 'toolu_one', toolInput: { description: '調べる' } });
		await waitFor(() => waiting() === 1, 'the launch was not remembered');
		harness.hook('SubagentStart', { payload: { agent_id: 'a-one', agent_type: 'Explore' } });
		await waitFor(() => agents().length === 1 && waiting() === 0, 'the subagent was not listed');
		// 並列の起動はどれがどの子か分からないので結ばない
		harness.hook('PreToolUse', { toolName: 'Agent', toolUseId: 'toolu_p1', toolInput: { description: 'A' } });
		harness.hook('PreToolUse', { toolName: 'Agent', toolUseId: 'toolu_p2', toolInput: { description: 'B' } });
		await waitFor(() => waiting() === 2, 'the parallel launches were not remembered');
		harness.hook('SubagentStart', { payload: { agent_id: 'a-p1', agent_type: 'Explore' } });
		await waitFor(() => agents().length === 2, 'the first parallel subagent was not listed');
		harness.hook('SubagentStart', { payload: { agent_id: 'a-p2', agent_type: 'Explore' } });
		await waitFor(() => agents().length === 3, 'the second parallel subagent was not listed');
		assert.deepStrictEqual(agents().map(agent => ({ id: agent.id, toolUseIds: agent.toolUseIds })).sort((a, b) => a.id.localeCompare(b.id)), [
			{ id: 'a-one', toolUseIds: ['toolu_one'] },
			{ id: 'a-p1', toolUseIds: undefined },
			{ id: 'a-p2', toolUseIds: undefined },
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
			// エージェントの発言と分けて出すための印が付いて届く
			delivered: harness.sent.some(message => message.t === 'delta' && (message.messages as { text: string; notice?: boolean }[]).some(item => item.text === notice()?.text && item.notice === true)),
			keys: harness.actions.filter(action => action.t === 'action/sendMessage').length,
		}, { notice: `送れませんでした: ${head}…`, delivered: true, keys: 0 });
	}));
});

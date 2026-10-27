/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisOpenCodeBridge } from '../../../agentBrowser/node/paradisOpenCodeBridge.js';
import { ParadisMobileAgentChat } from '../../node/paradisMobileAgentChat.js';

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) { return; }
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
	assert.fail('OpenCode mobile state did not settle');
}

suite('Paradis OpenCode mobile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isolates sessions sharing SQLite and sends exact permission/question IDs through the bridge', async () => {
		const sandbox = sinon.createSandbox();
		const hasSession = sandbox.stub(paradisOpenCodeBridge, 'hasSession').callsFake((token, sid) => token === 'pane-a' && sid === 'ses_alpha' || token === 'pane-b' && sid === 'ses_beta');
		sandbox.stub(paradisOpenCodeBridge, 'databasePath').returns('/registered/opencode.db');
		sandbox.stub(paradisOpenCodeBridge, 'readMessages').callsFake(async (_token, sid) => [{ id: sid, role: 'user', kind: 'message', text: sid === 'ses_alpha' ? 'Alpha conversation' : 'Beta conversation' }]);
		const permission = sandbox.stub(paradisOpenCodeBridge, 'answerPermission').resolves('accepted');
		const question = sandbox.stub(paradisOpenCodeBridge, 'answerQuestion').resolves('accepted');
		const interrupt = sandbox.stub(paradisOpenCodeBridge, 'interrupt').resolves('accepted');
		const sendMessage = sandbox.stub(paradisOpenCodeBridge, 'sendMessage').resolves('accepted');
		const sent: Record<string, unknown>[] = [];
		const terminalActions: Uint8Array[] = [];
		const chat = new ParadisMobileAgentChat((_mobile, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))), (_mobile, _window, _session, _generation, bytes) => terminalActions.push(bytes), () => { }, new NullLogService());
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		const hookBase = { transcriptPath: '/untrusted/payload.db', cwd: '/workspace' };
		const hook = (token: string, sid: string) => fireParadisAgentHookEvent({ ...hookBase, token, sessionId: sid, event: 'SessionStart', transcriptPath: '/untrusted/payload.db', at: Date.now(), payload: { agent_kind: 'opencode' } });
		const access = chat as unknown as { tailers: Map<string, { epoch: string; messages: readonly { text: string }[]; currentInteraction(): { kind: string; id: string } | null }> };
		try {
			chat.setEagerTailing(true);
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-a' }, { terminalId: 2, token: 'pane-b' }]);
			hook('pane-a', 'ses_alpha');
			hook('pane-b', 'ses_beta');
			await waitFor(() => access.tailers.size === 2);
			inbound({ t: 'attach', id: 1, token: 'pane-a' });
			inbound({ t: 'attach', id: 2, token: 'pane-b' });
			await waitFor(() => sent.filter(frame => frame.t === 'snapshot').length >= 2);
			assert.deepStrictEqual([...access.tailers.values()].map(tailer => tailer.messages.map(message => message.text)), [['Alpha conversation'], ['Beta conversation']]);
			assert.strictEqual((await chat.getDesktopChat('pane-a', undefined))?.sessionId, 'ses_alpha');
			assert.strictEqual(sent.filter(frame => frame.t === 'snapshot').some(frame => frame.sessionId !== undefined), false);
			assert.strictEqual(await chat.sendOpenCodeMessage('pane-a', 'ses_other', 'wrong session'), false);
			const tailer = access.tailers.get('pane-a')!;
			fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'PermissionRequest', toolName: 'bash', toolInput: { command: 'npm test' }, at: Date.now(), payload: { agent_kind: 'opencode', opencode_request_id: 'per_exact' } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:per_exact');
			const base = { id: 1, token: 'pane-a', epoch: tailer.epoch };
			inbound({ ...base, t: 'action/answerApproval', requestId: 'wrong', interactionId: 'per_foreign', choice: 'yes' });
			inbound({ ...base, t: 'action/answerApproval', requestId: 'permit', interactionId: 'opencode:per_exact', choice: 'yes' });
			inbound({ ...base, t: 'action/answerApproval', requestId: 'permit', interactionId: 'opencode:per_exact', choice: 'yes' });
			await waitFor(() => sent.some(frame => frame.requestId === 'permit' && frame.status === 'accepted'));
			await waitFor(() => tailer.currentInteraction() === null);
			fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'PreToolUse', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Choose', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: false }] }, at: Date.now(), payload: { agent_kind: 'opencode', opencode_request_id: 'que_exact' } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:que_exact');
			inbound({ ...base, t: 'action/answerQuestion', requestId: 'answer', interactionId: 'opencode:que_exact', answers: [{ kind: 'option', index: 1 }] });
			await waitFor(() => sent.some(frame => frame.requestId === 'answer' && frame.status === 'accepted'));
			await waitFor(() => tailer.currentInteraction() === null);
			for (const requestId of ['que_second', 'que_third']) {
				fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'PreToolUse', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Same question', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: false }] }, at: Date.now(), payload: { agent_kind: 'opencode', opencode_request_id: requestId } });
			}
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:que_third');
			inbound({ ...base, t: 'action/answerQuestion', requestId: 'answer-third', interactionId: 'opencode:que_third', answers: [{ kind: 'option', index: 0 }] });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:que_second');
			inbound({ ...base, t: 'action/answerQuestion', requestId: 'answer-second', interactionId: 'opencode:que_second', answers: [{ kind: 'option', index: 1 }] });
			await waitFor(() => tailer.currentInteraction() === null);
			fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'PreToolUse', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Answered on PC', options: [{ label: 'Done' }], multiSelect: false }] }, at: Date.now(), payload: { agent_kind: 'opencode', opencode_request_id: 'que_local' } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:que_local');
			fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'PostToolUse', toolName: 'AskUserQuestion', at: Date.now(), payload: { agent_kind: 'opencode', opencode_request_id: 'que_local' } });
			await waitFor(() => tailer.currentInteraction() === null);
			inbound({ ...base, t: 'action/sendMessage', requestId: 'send', text: 'Continue' });
			await waitFor(() => sent.some(frame => frame.requestId === 'send' && frame.status === 'accepted'));
			inbound({ ...base, t: 'action/interrupt', requestId: 'interrupt' });
			await waitFor(() => sent.some(frame => frame.requestId === 'interrupt' && frame.status === 'accepted'));
			assert.deepStrictEqual({ permission: permission.args, question: question.args, send: sendMessage.args, interrupt: interrupt.args, terminalActions: terminalActions.length }, {
				permission: [['pane-a', 'ses_alpha', 'per_exact', 'once']], question: [['pane-a', 'ses_alpha', 'que_exact', [['Two']]], ['pane-a', 'ses_alpha', 'que_third', [['One']]], ['pane-a', 'ses_alpha', 'que_second', [['Two']]]], send: [['pane-a', 'ses_alpha', 'Continue']], interrupt: [['pane-a', 'ses_alpha']], terminalActions: 0,
			});
			hasSession.callsFake(() => false);
			fireParadisAgentHookEvent({ ...hookBase, token: 'pane-a', sessionId: 'ses_alpha', event: 'SessionEnd', at: Date.now(), payload: { agent_kind: 'opencode' } });
			await waitFor(() => (chat as unknown as { desktopExitedTokens: Set<string> }).desktopExitedTokens.has('pane-a'));
			assert.strictEqual((await chat.getDesktopChat('pane-a', undefined))?.agentExited, true);
			inbound({ ...base, t: 'action/interrupt', requestId: 'interrupt-after-exit' });
			await waitFor(() => sent.some(frame => frame.requestId === 'interrupt-after-exit'));
			assert.deepStrictEqual(sent.filter(frame => frame.requestId === 'interrupt-after-exit').map(frame => [frame.status, frame.code]), [['rejected', 'agent-exited']]);
		} finally {
			chat.dispose();
			sandbox.restore();
		}
	});

	test('does not resend the whole conversation while a reply that was growing at attach time keeps growing', async () => {
		const sandbox = sinon.createSandbox();
		sandbox.stub(paradisOpenCodeBridge, 'hasSession').callsFake((token, sid) => token === 'pane-a' && sid === 'ses_alpha');
		sandbox.stub(paradisOpenCodeBridge, 'databasePath').returns('/registered/opencode.db');
		let reply: string | undefined;
		sandbox.stub(paradisOpenCodeBridge, 'readMessages').callsFake(async () => [
			{ id: 'msg_user', role: 'user', kind: 'message', text: 'Start' },
			...(reply !== undefined ? [{ id: 'msg_reply', role: 'assistant' as const, kind: 'message' as const, text: reply }] : []),
		]);
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat((_mobile, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))), () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { tailers: Map<string, { epoch: string; messages: readonly { text: string }[] }> };
		try {
			chat.setEagerTailing(true);
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-a' }]);
			const turn = (event: string) => fireParadisAgentHookEvent({ token: 'pane-a', sessionId: 'ses_alpha', transcriptPath: '/untrusted/payload.db', cwd: '/workspace', event, at: Date.now(), payload: { agent_kind: 'opencode' } });
			turn('SessionStart');
			await waitFor(() => access.tailers.size === 1);
			// The turn is already running, and its reply growing, when the phone attaches
			turn('UserPromptSubmit');
			await waitFor(() => (chat as unknown as { activeTurnTokens: Set<string> }).activeTurnTokens.has('pane-a'));
			reply = 'Hel';
			chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({ t: 'attach', id: 1, token: 'pane-a' })));
			await waitFor(() => sent.some(frame => frame.t === 'snapshot'));
			const tailer = access.tailers.get('pane-a')!;
			clearInterval(Reflect.get(tailer, 'pollTimer') as ReturnType<typeof setInterval>);
			const poll = () => (Reflect.get(tailer, 'readOpenCodeHistory') as (emit: boolean) => Promise<void>).call(tailer, true);
			const epoch = tailer.epoch;
			const atAttach = tailer.messages.map(message => message.text);
			const live: (string | undefined)[] = [];
			for (const next of ['Hello', 'Hello world', 'Hello world, again']) {
				reply = next;
				await poll();
				live.push((chat as unknown as { liveStates: Map<string, { text?: string }> }).liveStates.get('pane-a')?.text);
			}
			const duringTurn = tailer.messages.map(message => message.text);
			turn('Stop');
			await waitFor(() => !(chat as unknown as { activeTurnTokens: Set<string> }).activeTurnTokens.has('pane-a'));
			await poll();
			assert.deepStrictEqual({
				atAttach, duringTurn, live, epochKept: tailer.epoch === epoch, snapshots: sent.filter(frame => frame.t === 'snapshot').length,
				deltas: sent.filter(frame => frame.t === 'delta').flatMap(frame => (frame.messages as { text: string }[]).map(message => message.text)),
				history: tailer.messages.map(message => message.text),
			}, {
				atAttach: ['Start'], duringTurn: ['Start'], live: ['Hello', 'Hello world', 'Hello world, again'], epochKept: true, snapshots: 1,
				deltas: ['Hello world, again'], history: ['Start', 'Hello world, again'],
			});
		} finally {
			chat.dispose();
			sandbox.restore();
		}
	});

	test('keeps the guard when the frontend took an action but never answered, answers an in-flight resend as a duplicate, and hides credentials in live rows', async () => {
		const sandbox = sinon.createSandbox();
		sandbox.stub(paradisOpenCodeBridge, 'hasSession').callsFake((token, sid) => token === 'pane-a' && sid === 'ses_alpha');
		sandbox.stub(paradisOpenCodeBridge, 'databasePath').returns('/registered/opencode.db');
		sandbox.stub(paradisOpenCodeBridge, 'readMessages').callsFake(async () => [
			{ id: 'msg_user', role: 'user', kind: 'message', text: 'Log in' },
			{ id: 'call_login', role: 'assistant', kind: 'tool', text: '', tool: { name: 'para-browser_set_http_credentials', input: JSON.stringify({ origin: 'https://intranet.example.com', username: 'u', password: 'fixture-private-value' }), output: 'ok', status: 'completed' } },
		]);
		let finishSend: (outcome: 'accepted' | 'rejected' | 'unknown') => void = () => { };
		const sendMessage = sandbox.stub(paradisOpenCodeBridge, 'sendMessage').callsFake(() => new Promise(resolve => { finishSend = resolve; }));
		const permission = sandbox.stub(paradisOpenCodeBridge, 'answerPermission').resolves('unknown');
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat((_mobile, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))), () => { }, () => { }, new NullLogService());
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		const hook = (event: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token: 'pane-a', sessionId: 'ses_alpha', transcriptPath: '/untrusted/payload.db', cwd: '/workspace', event, at: Date.now(), payload: { agent_kind: 'opencode', ...payload }, ...extra });
		const access = chat as unknown as { tailers: Map<string, { epoch: string; messages: readonly { text: string; kind: string }[]; currentInteraction(): { kind: string; id: string } | null }> };
		try {
			chat.setEagerTailing(true);
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-a' }]);
			hook('SessionStart');
			await waitFor(() => access.tailers.size === 1);
			inbound({ t: 'attach', id: 1, token: 'pane-a' });
			await waitFor(() => sent.some(frame => frame.t === 'snapshot'));
			const tailer = access.tailers.get('pane-a')!;
			const base = { id: 1, token: 'pane-a', epoch: tailer.epoch };
			const shown = JSON.stringify(tailer.messages) + JSON.stringify(sent);
			inbound({ ...base, t: 'action/sendMessage', requestId: 'send-1', sendId: 'queued-1', text: 'Continue' });
			await waitFor(() => sendMessage.callCount === 1);
			inbound({ ...base, t: 'action/sendMessage', requestId: 'send-2', sendId: 'queued-1', text: 'Continue' });
			await waitFor(() => sent.some(frame => frame.requestId === 'send-2'));
			finishSend('unknown');
			await waitFor(() => sent.some(frame => frame.requestId === 'send-1'));
			inbound({ ...base, t: 'action/sendMessage', requestId: 'send-3', sendId: 'queued-1', text: 'Continue' });
			await waitFor(() => sent.some(frame => frame.requestId === 'send-3'));
			hook('PermissionRequest', { opencode_request_id: 'per_unknown' }, { toolName: 'bash', toolInput: { command: 'npm test' } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:per_unknown');
			inbound({ ...base, t: 'action/answerApproval', requestId: 'approve-1', interactionId: 'opencode:per_unknown', choice: 'yes' });
			await waitFor(() => sent.some(frame => frame.requestId === 'approve-1'));
			inbound({ ...base, t: 'action/answerApproval', requestId: 'approve-2', interactionId: 'opencode:per_unknown', choice: 'yes' });
			await waitFor(() => sent.some(frame => frame.requestId === 'approve-2'));
			const results = (ids: readonly string[]) => ids.map(id => sent.filter(frame => frame.requestId === id).map(frame => [frame.status, frame.code]));
			assert.deepStrictEqual({
				leaked: shown.includes('fixture-private-value'), hidden: shown.includes('[hidden]'),
				sends: sendMessage.callCount, approvals: permission.callCount,
				results: results(['send-1', 'send-2', 'send-3', 'approve-1', 'approve-2']),
			}, {
				leaked: false, hidden: true, sends: 1, approvals: 1,
				results: [[['rejected', 'action-timeout']], [['accepted', 'duplicate']], [['accepted', 'duplicate']], [['rejected', 'action-timeout']], [['rejected', 'stale-interaction']]],
			});
		} finally {
			chat.dispose();
			sandbox.restore();
		}
	});

	test('lets a failed answer be retried and keeps a growing reply out of the history until it settles', async () => {
		const sandbox = sinon.createSandbox();
		sandbox.stub(paradisOpenCodeBridge, 'hasSession').callsFake((token, sid) => token === 'pane-a' && sid === 'ses_alpha');
		sandbox.stub(paradisOpenCodeBridge, 'databasePath').returns('/registered/opencode.db');
		type Row = { id: string; role: 'user' | 'assistant'; kind: 'message'; text: string };
		let rows: Row[] = [{ id: 'msg_user', role: 'user', kind: 'message', text: 'Start' }];
		sandbox.stub(paradisOpenCodeBridge, 'readMessages').callsFake(async () => rows);
		const permission = sandbox.stub(paradisOpenCodeBridge, 'answerPermission');
		permission.onFirstCall().resolves('rejected');
		permission.onSecondCall().resolves('accepted');
		const desktopPermission = sandbox.stub(paradisOpenCodeBridge, 'answerQuestion');
		desktopPermission.onFirstCall().rejects(new Error('frontend unavailable'));
		desktopPermission.onSecondCall().resolves('accepted');
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat((_mobile, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))), () => { }, () => { }, new NullLogService());
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		const hook = (event: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => fireParadisAgentHookEvent({ token: 'pane-a', sessionId: 'ses_alpha', transcriptPath: '/untrusted/payload.db', cwd: '/workspace', event, at: Date.now(), payload: { agent_kind: 'opencode', ...payload }, ...extra });
		const access = chat as unknown as { tailers: Map<string, { epoch: string; messages: readonly { text: string }[]; currentInteraction(): { kind: string; id: string } | null }> };
		try {
			chat.setEagerTailing(true);
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-a' }]);
			hook('SessionStart');
			await waitFor(() => access.tailers.size === 1);
			inbound({ t: 'attach', id: 1, token: 'pane-a' });
			await waitFor(() => sent.some(frame => frame.t === 'snapshot'));
			const tailer = access.tailers.get('pane-a')!;
			const base = { id: 1, token: 'pane-a', epoch: tailer.epoch };
			hook('PermissionRequest', { opencode_request_id: 'per_retry' }, { toolName: 'bash', toolInput: { command: 'npm test' } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:per_retry');
			inbound({ ...base, t: 'action/answerApproval', requestId: 'first', interactionId: 'opencode:per_retry', choice: 'yes' });
			await waitFor(() => sent.some(frame => frame.requestId === 'first'));
			inbound({ ...base, t: 'action/answerApproval', requestId: 'second', interactionId: 'opencode:per_retry', choice: 'yes' });
			await waitFor(() => sent.some(frame => frame.requestId === 'second'));
			hook('PreToolUse', { opencode_request_id: 'que_retry' }, { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Choose', options: [{ label: 'One' }], multiSelect: false }] } });
			await waitFor(() => tailer.currentInteraction()?.id === 'opencode:que_retry');
			const answers = [{ kind: 'option' as const, index: 0 }];
			const desktop = [await chat.answerOpenCodeQuestions('pane-a', 'ses_alpha', 'opencode:que_retry', answers), await chat.answerOpenCodeQuestions('pane-a', 'ses_alpha', 'opencode:que_retry', answers)];

			// Drive the polls by hand so the tailer's own timer does not observe the rows in between.
			clearInterval(Reflect.get(tailer, 'pollTimer') as ReturnType<typeof setInterval>);
			const poll = () => (Reflect.get(tailer, 'readOpenCodeHistory') as (emit: boolean) => Promise<void>).call(tailer, true);
			const epoch = tailer.epoch;
			const sentBeforePolls = sent.length;
			const historyBeforePolls = tailer.messages.length;
			const deltas = () => sent.slice(sentBeforePolls).filter(frame => frame.t === 'delta').flatMap(frame => (frame.messages as { text: string }[]).map(message => message.text));
			hook('UserPromptSubmit');
			await waitFor(() => (chat as unknown as { activeTurnTokens: Set<string> }).activeTurnTokens.has('pane-a'));
			rows = [...rows, { id: 'msg_reply', role: 'assistant', kind: 'message', text: 'Hel' }];
			await poll();
			rows = [rows[0], { ...rows[1], text: 'Hello' }];
			await poll();
			await poll();
			// A later row settles the earlier reply; the last one waits for the turn to end.
			rows = [...rows, { id: 'msg_next', role: 'assistant', kind: 'message', text: 'Next' }];
			await poll();
			const heldBack = tailer.messages.slice(historyBeforePolls).map(message => message.text);
			hook('Stop');
			await waitFor(() => !(chat as unknown as { activeTurnTokens: Set<string> }).activeTurnTokens.has('pane-a'));
			// The frontend returns only its latest rows: the first row leaves the window.
			rows = rows.slice(1);
			await poll();
			assert.deepStrictEqual({
				answers: sent.filter(frame => frame.requestId === 'first' || frame.requestId === 'second').map(frame => frame.status), desktop,
				epochKept: tailer.epoch === epoch, heldBack, deltas: deltas(), history: tailer.messages.slice(historyBeforePolls).map(message => message.text),
				snapshots: sent.filter(frame => frame.t === 'snapshot').length,
			}, {
				answers: ['rejected', 'accepted'], desktop: [false, true],
				epochKept: true, heldBack: ['Hello'], deltas: ['Hello', 'Next'], history: ['Hello', 'Next'],
				snapshots: 1,
			});
			// A bridge-capable CLI reports its exit with TerminalExit, after which Ctrl+C belongs to the shell.
			hook('TerminalExit');
			await waitFor(() => (chat as unknown as { desktopExitedTokens: Set<string> }).desktopExitedTokens.has('pane-a'));
			inbound({ ...base, t: 'action/interrupt', requestId: 'interrupt-after-terminal-exit' });
			await waitFor(() => sent.some(frame => frame.requestId === 'interrupt-after-terminal-exit'));
			assert.deepStrictEqual(sent.filter(frame => frame.requestId === 'interrupt-after-terminal-exit').map(frame => [frame.status, frame.code]), [['rejected', 'agent-exited']]);
		} finally {
			chat.dispose();
			sandbox.restore();
		}
	});
});

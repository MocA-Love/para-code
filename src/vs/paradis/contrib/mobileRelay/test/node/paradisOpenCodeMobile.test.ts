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
		const permission = sandbox.stub(paradisOpenCodeBridge, 'answerPermission').resolves(true);
		const question = sandbox.stub(paradisOpenCodeBridge, 'answerQuestion').resolves(true);
		const interrupt = sandbox.stub(paradisOpenCodeBridge, 'interrupt').resolves(true);
		const sendMessage = sandbox.stub(paradisOpenCodeBridge, 'sendMessage').resolves(true);
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
		let reply = 'Hel';
		sandbox.stub(paradisOpenCodeBridge, 'readMessages').callsFake(async () => [
			{ id: 'msg_user', role: 'user', kind: 'message', text: 'Start' },
			{ id: 'msg_reply', role: 'assistant', kind: 'message', text: reply },
		]);
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat((_mobile, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))), () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { tailers: Map<string, { epoch: string; messages: readonly { text: string }[] }> };
		try {
			chat.setEagerTailing(true);
			chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-a' }]);
			fireParadisAgentHookEvent({ token: 'pane-a', sessionId: 'ses_alpha', transcriptPath: '/untrusted/payload.db', cwd: '/workspace', event: 'SessionStart', at: Date.now(), payload: { agent_kind: 'opencode' } });
			await waitFor(() => access.tailers.size === 1);
			chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({ t: 'attach', id: 1, token: 'pane-a' })));
			await waitFor(() => sent.some(frame => frame.t === 'snapshot'));
			const tailer = access.tailers.get('pane-a')!;
			clearInterval(Reflect.get(tailer, 'pollTimer') as ReturnType<typeof setInterval>);
			const poll = () => (Reflect.get(tailer, 'readOpenCodeHistory') as (emit: boolean) => Promise<void>).call(tailer, true);
			const epoch = tailer.epoch;
			const atAttach = tailer.messages.map(message => message.text);
			for (const next of ['Hello', 'Hello world', 'Hello world']) {
				reply = next;
				await poll();
			}
			assert.deepStrictEqual({
				atAttach, epochKept: tailer.epoch === epoch, snapshots: sent.filter(frame => frame.t === 'snapshot').length,
				deltas: sent.filter(frame => frame.t === 'delta').flatMap(frame => (frame.messages as { text: string }[]).map(message => message.text)),
				history: tailer.messages.map(message => message.text),
			}, { atAttach: ['Start'], epochKept: true, snapshots: 1, deltas: ['Hello world'], history: ['Start', 'Hello world'] });
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
		permission.onFirstCall().resolves(false);
		permission.onSecondCall().resolves(true);
		const desktopPermission = sandbox.stub(paradisOpenCodeBridge, 'answerQuestion');
		desktopPermission.onFirstCall().rejects(new Error('frontend unavailable'));
		desktopPermission.onSecondCall().resolves(true);
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
			rows = [...rows, { id: 'msg_reply', role: 'assistant', kind: 'message', text: 'Hel' }];
			await poll();
			rows = [rows[0], { ...rows[1], text: 'Hello' }];
			await poll();
			await poll();
			// The frontend returns only its latest rows: the first row leaves the window while a new one is added.
			rows = [rows[1], { id: 'msg_next', role: 'assistant', kind: 'message', text: 'Next' }];
			await poll();
			const heldBack = tailer.messages.slice(historyBeforePolls).map(message => message.text);
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

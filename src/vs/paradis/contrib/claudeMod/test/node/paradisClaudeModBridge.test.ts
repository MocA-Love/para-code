/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisClaudeModBridge, ParadisClaudeModEvent } from '../../node/paradisClaudeModBridge.js';

const TOKEN = 'pane-token';
const SESSION = 'session-1';
const QUESTIONS = [{ question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Green', description: '' }] }];

suite('ParadisClaudeModBridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let bridge: ParadisClaudeModBridge;
	let now: number;
	let events: ParadisClaudeModEvent[];
	let signal: AbortController;
	/** 送り主がそのペインのプロセスだと確かめられるか（hook と同じ確かめの結果）。 */
	let callerVerified: boolean;
	let verifications: number;

	setup(() => {
		now = 1_000_000;
		bridge = new ParadisClaudeModBridge(() => now);
		events = [];
		store.add(bridge.onEvent(event => events.push(event)));
		bridge.setPresence(() => 'connected');
		bridge.setApprovalWait(() => 600_000);
		signal = new AbortController();
		callerVerified = true;
		verifications = 0;
	});

	teardown(() => {
		signal.abort();
		bridge.dispose();
	});

	const verifyCaller = async () => {
		verifications++;
		return callerVerified;
	};
	/** 要求の処理（送り主の確かめを待つ）を進める。 */
	const flushRequests = () => new Promise<void>(resolve => setTimeout(resolve, 0));
	const call = (op: string, body: Record<string, unknown>) => bridge.handle(TOKEN, op, { sessionId: SESSION, ...body }, signal.signal, verifyCaller);

	test('rejects a request without a session id and unknown operations', async () => {
		assert.deepStrictEqual({
			noSession: (await bridge.handle(TOKEN, 'event', { events: [] }, signal.signal, verifyCaller)).status,
			unknown: (await call('nope', {})).status,
		}, { noSession: 400, unknown: 404 });
	});

	test('a question answered on the phone is handed to the waiting mod as values', async () => {
		const registered = await call('question', { toolUseId: 'toolu_q', questions: QUESTIONS });
		const id = registered.body.id as string;
		const waiting = call('wait', { id });
		assert.deepStrictEqual(bridge.pendingQuestions(TOKEN, SESSION).map(question => ({ toolUseId: question.toolUseId, labels: question.questions[0].options.map(option => option.label) })), [{ toolUseId: 'toolu_q', labels: ['Red', 'Green'] }]);
		assert.strictEqual(bridge.answerQuestion(TOKEN, id, { 'Pick a color?': 'Green' }), true);
		assert.deepStrictEqual({
			registered: registered.body.wait,
			reply: (await waiting).body,
			again: bridge.answerQuestion(TOKEN, id, { 'Pick a color?': 'Red' }),
			pending: bridge.pendingQuestions(TOKEN, SESSION).length,
		}, { registered: true, reply: { state: 'answer', answers: { 'Pick a color?': 'Green' } }, again: false, pending: 0 });
	});

	test('keeps the description and the preview of the options, and hands the notes and the withdrawal to the waiting mod', async () => {
		const questions = [{ question: 'Pick a look?', header: 'Look', multiSelect: false, options: [{ label: 'Toast', description: 'top', preview: '# Toast' }, { label: 'Inline', description: '', preview: '' }] }];
		const first = (await call('question', { toolUseId: 'toolu_p', questions })).body.id as string;
		const options = bridge.pendingQuestions(TOKEN, SESSION)[0]?.questions[0]?.options;
		const answered = call('wait', { id: first });
		bridge.answerQuestion(TOKEN, first, { 'Pick a look?': 'Toast' }, { 'Pick a look?': { preview: '# Toast', notes: 'shorter' } });
		const second = (await call('question', { toolUseId: 'toolu_p2', questions })).body.id as string;
		// 待ちが張られる前に渡した取り下げも、次の wait まで残る
		const clarified = bridge.clarifyQuestion(TOKEN, second, { kind: 'response', response: 'show me the screen first' });
		const third = (await call('question', { toolUseId: 'toolu_p3', questions })).body.id as string;
		const denied = call('wait', { id: third });
		bridge.clarifyQuestion(TOKEN, third, { kind: 'deny', deny: 'The user wants to clarify these questions.' });
		assert.deepStrictEqual({
			options,
			answered: (await answered).body,
			clarified,
			withMessage: (await call('wait', { id: second })).body,
			denied: (await denied).body,
			again: bridge.clarifyQuestion(TOKEN, third, { kind: 'response', response: 'x' }),
		}, {
			options: [{ label: 'Toast', description: 'top', preview: '# Toast' }, { label: 'Inline', preview: '' }],
			answered: { state: 'answer', answers: { 'Pick a look?': 'Toast' }, annotations: { 'Pick a look?': { preview: '# Toast', notes: 'shorter' } } },
			clarified: true,
			withMessage: { state: 'clarify', response: 'show me the screen first' },
			denied: { state: 'clarify', deny: 'The user wants to clarify these questions.' },
			again: false,
		});
	});

	test('an answer given before the mod asks again is kept for its next wait', async () => {
		const id = (await call('question', { questions: QUESTIONS })).body.id as string;
		bridge.answerQuestion(TOKEN, id, { 'Pick a color?': 'Red' });
		assert.deepStrictEqual((await call('wait', { id })).body, { state: 'answer', answers: { 'Pick a color?': 'Red' } });
	});

	test('the terminal answering first (settle) ends the open wait at once', async () => {
		const id = (await call('question', { questions: QUESTIONS })).body.id as string;
		const waiting = call('wait', { id });
		await call('settle', { ids: [id] });
		assert.deepStrictEqual((await waiting).body, { state: 'settled' });
	});

	test('waits for approvals only while a phone is connected and the setting allows it', async () => {
		bridge.setPresence(() => 'enabled');
		const notConnected = await call('permission', { toolName: 'Bash', toolInput: { command: 'ls' } });
		bridge.setPresence(() => 'connected');
		bridge.setApprovalWait(() => 0);
		const turnedOff = await call('permission', { toolName: 'Bash', toolInput: { command: 'ls' } });
		bridge.setApprovalWait(() => 600_000);
		const waits = await call('permission', { toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'toolu_b', suggestions: [{ type: 'addRules' }] });
		assert.deepStrictEqual({
			notConnected: notConnected.body,
			turnedOff: turnedOff.body,
			waits: waits.body.wait,
			pending: bridge.pendingPermissions(TOKEN, SESSION).map(permission => ({ toolName: permission.toolName, toolUseId: permission.toolUseId, hasSuggestions: permission.hasSuggestions })),
		}, {
			notConnected: { wait: false },
			turnedOff: { wait: false },
			waits: true,
			pending: [{ toolName: 'Bash', toolUseId: 'toolu_b', hasSuggestions: true }],
		});
	});

	test('"always" reaches the mod only when there are rules to add', async () => {
		const withRules = (await call('permission', { toolName: 'Bash', toolInput: {}, suggestions: [{ type: 'addRules' }] })).body.id as string;
		const withoutRules = (await call('permission', { toolName: 'Bash', toolInput: {} })).body.id as string;
		bridge.answerPermission(TOKEN, withRules, 'allow', true);
		bridge.answerPermission(TOKEN, withoutRules, 'allow', true);
		assert.deepStrictEqual([(await call('wait', { id: withRules })).body, (await call('wait', { id: withoutRules })).body], [
			{ state: 'answer', decision: 'allow', always: true },
			{ state: 'answer', decision: 'allow' },
		]);
	});

	test('a written tool result or the end of the main turn settles what was still waiting', async () => {
		const permission = (await call('permission', { toolName: 'Bash', toolInput: {}, toolUseId: 'toolu_1' })).body.id as string;
		const question = (await call('question', { questions: QUESTIONS })).body.id as string;
		const permissionWait = call('wait', { id: permission });
		const questionWait = call('wait', { id: question });
		await call('event', { events: [{ type: 'tool-results', ids: ['toolu_1'], errorIds: ['toolu_1'] }] });
		const afterResult = (await permissionWait).body;
		await call('event', { events: [{ type: 'turn.complete', turnId: 't1', agentId: 'a-sub', aborted: false }] });
		const pendingAfterSubagent = bridge.pendingQuestions(TOKEN, SESSION).length;
		await call('event', { events: [{ type: 'turn.complete', turnId: 't1', aborted: true, reason: 'aborted' }] });
		assert.deepStrictEqual({ afterResult, pendingAfterSubagent, afterTurn: (await questionWait).body }, {
			afterResult: { state: 'settled' }, pendingAfterSubagent: 1, afterTurn: { state: 'settled' },
		});
	});

	test('drops approvals once the phone has been away for a while', async () => {
		let presence: 'connected' | 'enabled' = 'connected';
		bridge.setPresence(() => presence);
		const id = (await call('permission', { toolName: 'Bash', toolInput: {} })).body.id as string;
		const waiting = call('wait', { id });
		await flushRequests();
		presence = 'enabled';
		bridge.sweep();
		now += 31_000;
		bridge.sweep();
		assert.deepStrictEqual((await waiting).body, { state: 'expired' });
	});

	test('passes observed events on in order, keeping only well-formed ones', async () => {
		await call('event', {
			events: [
				{ type: 'hello', version: '1.0.0' },
				{ type: 'row', uuid: 'u1', door: 'response', origin: 'model', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
				{ type: 'row', uuid: 'u2', door: 'tool-result', message: { type: 'user', content: [] } },
				{ type: 'step', turnId: 't1', step: 0, chunks: [{ index: 0, text: 'Hel' }, { index: 'x', text: 'bad' }], end: false },
				{ type: 'subagent.start', agentId: 'a1', subagentType: 'general-purpose', toolUseId: 'toolu_a' },
				{ type: 'subagent.resume', agentId: 'a1' },
				{ type: 'unknown' },
			],
		});
		// 生き死にの知らせ（alive-changed）は別の試験で見る
		assert.deepStrictEqual(events.filter(event => event.type !== 'alive-changed').map(event => event.type === 'step' ? { type: event.type, chunks: event.chunks } : { type: event.type }), [
			{ type: 'hello' },
			{ type: 'row' },
			{ type: 'step', chunks: [{ index: 0, text: 'Hel' }] },
			{ type: 'subagent.start' },
			{ type: 'subagent.resume' },
		]);
	});

	test('sends a prompt through a waiting command poll and reports the mod acknowledgement', async () => {
		const unavailable = await bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const poll = call('commands', { busy: false });
		await flushRequests();
		assert.strictEqual(bridge.isAlive(TOKEN, SESSION), true);
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const commands = (await poll).body.commands as { id: string; kind: string; text: string }[];
		await call('ack', { id: commands[0].id, ok: true });
		const refusedPoll = call('commands', { busy: false });
		const refusing = bridge.submitPrompt(TOKEN, SESSION, 'again');
		const refusedCommand = ((await refusedPoll).body.commands as { id: string }[])[0];
		await call('ack', { id: refusedCommand.id, ok: false });
		assert.deepStrictEqual({
			unavailable,
			command: { kind: commands[0].kind, text: commands[0].text },
			sent: await sending,
			refused: await refusing,
		}, { unavailable: 'unavailable', command: { kind: 'submit', text: 'hello' }, sent: 'accepted', refused: 'refused' });
	});

	test('hands a background task to stop through the command poll and reports the ack with its message', async () => {
		const poll = call('commands', { busy: true });
		await flushRequests();
		const stopping = bridge.stopTask(TOKEN, SESSION, 'b123');
		const command = ((await poll).body.commands as { id: string; kind: string; taskId: string }[])[0];
		await call('ack', { id: command.id, ok: true, message: 'Successfully stopped task: b123 (sleep 600)' });
		const refusedPoll = call('commands', { busy: true });
		await flushRequests();
		const refusing = bridge.stopTask(TOKEN, SESSION, 'b999');
		const refused = ((await refusedPoll).body.commands as { id: string }[])[0];
		await call('ack', { id: refused.id, ok: false, message: 'No task found with ID: b999' });
		assert.deepStrictEqual({
			command: { kind: command.kind, taskId: command.taskId },
			stopped: await stopping,
			refused: await refusing,
		}, {
			command: { kind: 'taskStop', taskId: 'b123' },
			stopped: { outcome: 'stopped', message: 'Successfully stopped task: b123 (sleep 600)' },
			refused: { outcome: 'refused', message: 'No task found with ID: b999' },
		});
	});

	test('keeps the session busy from a handed-over prompt until its turn completes, whatever the polls say', async () => {
		const poll = call('commands', { busy: false });
		await flushRequests();
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const command = ((await poll).body.commands as { id: string }[])[0];
		await call('ack', { id: command.id, received: true });
		const sent = await sending;
		// mod は $.prompt.submit を待たずに次のポーリングへ来る（busy: false のことがある）
		const nextPoll = call('commands', { busy: false });
		await flushRequests();
		const busyAfterPoll = bridge.isBusy(TOKEN, SESSION);
		await call('event', { events: [{ type: 'turn.start', turnId: 't1' }, { type: 'turn.complete', turnId: 't1', aborted: false }] });
		const busyAfterTurn = bridge.isBusy(TOKEN, SESSION);
		signal.abort();
		await nextPoll;
		assert.deepStrictEqual({ sent, busyAfterPoll, busyAfterTurn }, { sent: 'accepted', busyAfterPoll: true, busyAfterTurn: false });
	});

	/** 発言を 1 通渡し、mod の最初の ack を返す（`received` か `ok`）。 */
	async function handOver(firstAck: Record<string, unknown>): Promise<{ readonly id: string; readonly result: string }> {
		const poll = call('commands', { busy: false });
		await flushRequests();
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const command = ((await poll).body.commands as { id: string }[])[0];
		await call('ack', { id: command.id, ...firstAck });
		return { id: command.id, result: await sending };
	}

	/** mod の次のポーリング（busy: false）を張り、受け口に busy を計算させる。 */
	async function pollIdle(): Promise<void> {
		void call('commands', { busy: false });
		await flushRequests();
	}

	test('drops the held busy when the final ack says the prompt could not be sent', async () => {
		const { id: commandId } = await handOver({ received: true });
		await pollIdle();
		const held = bridge.isBusy(TOKEN, SESSION);
		await call('ack', { id: commandId, ok: false });
		assert.deepStrictEqual({ held, afterRefused: bridge.isBusy(TOKEN, SESSION) }, { held: true, afterRefused: false });
	});

	test('drops the held busy on an aborted turn.complete', async () => {
		await handOver({ received: true });
		await call('event', { events: [{ type: 'turn.start', turnId: 't1' }] });
		await pollIdle();
		const held = bridge.isBusy(TOKEN, SESSION);
		await call('event', { events: [{ type: 'turn.complete', turnId: 't1', aborted: true, reason: 'aborted' }] });
		assert.deepStrictEqual({ held, afterAbort: bridge.isBusy(TOKEN, SESSION) }, { held: true, afterAbort: false });
	});

	test('does not hold busy when the first ack already says sent (no received)', async () => {
		const { result } = await handOver({ ok: true });
		await pollIdle();
		assert.deepStrictEqual({ result, busy: bridge.isBusy(TOKEN, SESSION) }, { result: 'accepted', busy: false });
	});

	test('the held busy expires 30 s after received without a turn, and 10 minutes after the turn started', async () => {
		await handOver({ received: true });
		await pollIdle();
		now += 30_001;
		const noTurn = bridge.isBusy(TOKEN, SESSION);
		await handOver({ received: true });
		await call('event', { events: [{ type: 'turn.start', turnId: 't2' }] });
		await pollIdle();
		now += 31_000;
		const turnRunning = bridge.isBusy(TOKEN, SESSION);
		now += 10 * 60_000;
		const turnTooLong = bridge.isBusy(TOKEN, SESSION);
		assert.deepStrictEqual({ noTurn, turnRunning, turnTooLong }, { noTurn: false, turnRunning: true, turnTooLong: false });
	});

	test('a prompt the mod refuses because it is sending another one comes back as busy', async () => {
		const { result } = await handOver({ ok: false, reason: 'busy' });
		assert.strictEqual(result, 'busy');
	});

	test('tells when the mod comes and goes (alive-changed), only at the boundary', async () => {
		await call('event', { events: [{ type: 'hello' }] });
		await call('event', { events: [{ type: 'turn.start', turnId: 't1' }] });
		now += 76_000;
		bridge.sweep();
		bridge.sweep();
		await call('event', { events: [{ type: 'hello' }] });
		bridge.forgetToken(TOKEN);
		assert.deepStrictEqual(events.filter(event => event.type === 'alive-changed').map(event => event.type === 'alive-changed' ? event.alive : undefined), [true, false, true, false]);
	});

	test('a prompt whose reply could not be written goes back (unavailable), so the keys can send it', async () => {
		const poll = call('commands', { busy: false });
		await new Promise(resolve => setTimeout(resolve, 0));
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const reply = await poll;
		reply.onNotDelivered?.();
		assert.deepStrictEqual({ result: await sending, hadCommand: (reply.body.commands as unknown[]).length }, { result: 'unavailable', hadCommand: 1 });
	});

	test('accepts a prompt when its row shows up in the conversation, and reports it unconfirmed when nothing does', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		try {
			const poll = call('commands', { busy: false });
			await clock.tickAsync(0);
			const sending = bridge.submitPrompt(TOKEN, SESSION, '続けて');
			await poll;
			await call('event', { events: [{ type: 'row', uuid: 'u-p', door: 'prompt', origin: 'plugin', message: { type: 'user', role: 'user', content: [{ type: 'text', text: '続けて' }] } }] });
			const confirmedByRow = await sending;
			const silentPoll = call('commands', { busy: false });
			await clock.tickAsync(0);
			const silent = bridge.submitPrompt(TOKEN, SESSION, 'もう一度');
			await silentPoll;
			await clock.tickAsync(15_001);
			assert.deepStrictEqual({ confirmedByRow, silent: await silent }, { confirmedByRow: 'accepted', silent: 'unconfirmed' });
		} finally {
			clock.restore();
		}
	});

	test('takes only observation from a caller it could not verify as the pane\'s own process', async () => {
		callerVerified = false;
		const permission = await call('permission', { toolName: 'Bash', toolInput: {} });
		const commands = await call('commands', { busy: false });
		const questionStatus = (await call('question', { questions: QUESTIONS })).status;
		const verificationsBefore = verifications;
		await call('event', { events: [{ type: 'row', uuid: 'u1', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }, { type: 'step', turnId: 't', step: 0, chunks: [{ index: 0, text: 'h' }], end: false }] });
		const verificationsForObservation = verifications - verificationsBefore;
		await call('event', { events: [{ type: 'row', uuid: 'u2', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, { type: 'turn.complete', turnId: 't', aborted: false }, { type: 'subagent.start', agentId: 'a1' }, { type: 'tool-results', ids: ['x'], errorIds: [] }] });
		assert.deepStrictEqual({
			permission: permission.status, commands: commands.status, questionStatus, verificationsForObservation,
			events: events.map(event => event.type), alive: bridge.isAlive(TOKEN, SESSION),
		}, {
			permission: 403, commands: 403, questionStatus: 403, verificationsForObservation: 0,
			events: ['row', 'step', 'row'], alive: false,
		});
	});

	test('keeps the suggested rules (sanitized) with a pending approval', async () => {
		await call('permission', { toolName: 'set_http_credentials', toolInput: { username: 'me', password: 'secret' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] });
		const [pending] = bridge.pendingPermissions(TOKEN, SESSION);
		assert.deepStrictEqual({ password: (pending.toolInput as Record<string, unknown>).password === 'secret', suggestions: pending.suggestions.length, hasSuggestions: pending.hasSuggestions }, { password: false, suggestions: 1, hasSuggestions: true });
	});

	test('remembers a verified caller for a minute and marks rows accordingly', async () => {
		const rows: boolean[] = [];
		store.add(bridge.onEvent(event => { if (event.type === 'row') { rows.push(event.verified); } }));
		const row = (uuid: string) => call('event', { events: [{ type: 'row', uuid, door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 't' }] } }] });
		await call('settle', { ids: [] });
		const verificationsBefore = verifications;
		await row('u-a');
		now += 61_000;
		await row('u-b');
		assert.deepStrictEqual({ rows, verificationsForRows: verifications - verificationsBefore }, { rows: [true, false], verificationsForRows: 0 });
	});

	test('a prompt the mod reports as received is accepted even if it is sent later', async () => {
		const poll = call('commands', { busy: false });
		await flushRequests();
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const [command] = (await poll).body.commands as { id: string }[];
		await call('ack', { id: command.id, received: true });
		assert.strictEqual(await sending, 'accepted');
	});

	test('checks every batch that carries a tool row, even while a verification is remembered', async () => {
		await call('settle', { ids: [] });
		const rows: boolean[] = [];
		store.add(bridge.onEvent(event => { if (event.type === 'row') { rows.push(event.verified); } }));
		callerVerified = false;
		const verificationsBefore = verifications;
		await call('event', { events: [{ type: 'row', uuid: 'u-q', door: 'response', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'AskUserQuestion', input: {} }] } }] });
		await call('event', { events: [{ type: 'row', uuid: 'u-p', door: 'prompt', origin: 'plugin', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'x' }] } }] });
		assert.deepStrictEqual({ rows, checks: verifications - verificationsBefore }, { rows: [], checks: 2 });
	});

	test('reports a prompt that the mod received but then could not send', async () => {
		const poll = call('commands', { busy: false });
		await flushRequests();
		let lateFailures = 0;
		const sending = bridge.submitPrompt(TOKEN, SESSION, 'hello', () => lateFailures++);
		const [command] = (await poll).body.commands as { id: string }[];
		await call('ack', { id: command.id, received: true });
		const result = await sending;
		await call('ack', { id: command.id, ok: false });
		await call('ack', { id: command.id, ok: false });
		assert.deepStrictEqual({ result, lateFailures }, { result: 'accepted', lateFailures: 1 });
	});

	test('asks a mod that lists slash commands for them, and does not ask an older mod', async () => {
		const oldPoll = call('commands', { busy: false });
		await flushRequests();
		const fromOld = { supports: bridge.supports(TOKEN, SESSION, 'commands.list'), listed: await bridge.listCommands(TOKEN, SESSION) };
		signal.abort();
		await oldPoll;
		signal = new AbortController();
		const poll = call('commands', { busy: false, features: ['commands.list', 'command.run', 'unknown.feature'] });
		await flushRequests();
		const listing = bridge.listCommands(TOKEN, SESSION);
		const [command] = (await poll).body.commands as { id: string; kind: string }[];
		await call('ack', { id: command.id, ok: true, commands: [{ name: 'context', description: 'mine', source: 'user' }] });
		assert.deepStrictEqual({
			fromOld,
			supports: [bridge.supports(TOKEN, SESSION, 'commands.list'), bridge.supports(TOKEN, SESSION, 'command.run')],
			kind: command.kind,
			listed: await listing,
		}, {
			fromOld: { supports: false, listed: undefined },
			supports: [true, true],
			kind: 'commandList',
			listed: [{ name: 'context', description: 'mine', source: 'user' }],
		});
	});

	test('runs a slash command through the mod and reports a refusal with its reason, or a late failure', async () => {
		const features = ['commands.list', 'command.run'];
		const poll = call('commands', { busy: false, features });
		await flushRequests();
		const refusing = bridge.runCommand(TOKEN, SESSION, 'nope', 'a b');
		const [refused] = (await poll).body.commands as { id: string; kind: string; command: string; args: string }[];
		await call('ack', { id: refused.id, ok: false, reason: 'refused', message: 'no command named /nope in this session' });
		const panelPoll = call('commands', { busy: false, features });
		await flushRequests();
		const late: (string | undefined)[] = [];
		const opening = bridge.runCommand(TOKEN, SESSION, 'config', '', message => late.push(message));
		const [panel] = (await panelPoll).body.commands as { id: string }[];
		await call('ack', { id: panel.id, received: true });
		const opened = await opening;
		await call('ack', { id: panel.id, ok: false, reason: 'refused', message: 'closed badly' });
		assert.deepStrictEqual({
			command: { kind: refused.kind, command: refused.command, args: refused.args },
			refused: await refusing,
			opened,
			late,
		}, {
			command: { kind: 'commandRun', command: 'nope', args: 'a b' },
			refused: { outcome: 'refused', message: 'no command named /nope in this session' },
			opened: { outcome: 'accepted' },
			late: ['closed badly'],
		});
	});

	test('asks the mod whether a screen holds the keys, and tells stale and panel-open refusals apart', async () => {
		const oldPoll = call('commands', { busy: false, features: ['commands.list', 'command.run'] });
		await flushRequests();
		const fromOldMod = await bridge.isDialogOpen(TOKEN, SESSION);
		signal.abort();
		await oldPoll;
		signal = new AbortController();
		const features = ['commands.list', 'command.run', 'prompt.dialog'];
		const poll = call('commands', { busy: false, features });
		await flushRequests();
		const asking = bridge.isDialogOpen(TOKEN, SESSION);
		const [check] = (await poll).body.commands as { id: string; kind: string }[];
		await call('ack', { id: check.id, ok: true, dialog: true });
		const promptPoll = call('commands', { busy: false, features });
		await flushRequests();
		const prompting = bridge.submitPrompt(TOKEN, SESSION, 'hello');
		const [prompt] = (await promptPoll).body.commands as { id: string }[];
		await call('ack', { id: prompt.id, ok: false, reason: 'panel-open' });
		const stalePoll = call('commands', { busy: false, features });
		await flushRequests();
		const staleRun = bridge.runCommand(TOKEN, SESSION, 'context', '');
		const [stale] = (await stalePoll).body.commands as { id: string }[];
		await call('ack', { id: stale.id, ok: false, reason: 'stale' });
		assert.deepStrictEqual({
			fromOldMod,
			kind: check.kind,
			open: await asking,
			prompt: await prompting,
			stale: await staleRun,
		}, { fromOldMod: undefined, kind: 'dialogCheck', open: true, prompt: 'panel-open', stale: { outcome: 'stale' } });
	});

	test('forgets a pane: its waits end and the mod is no longer considered alive', async () => {
		const id = (await call('question', { questions: QUESTIONS })).body.id as string;
		const waiting = call('wait', { id });
		await flushRequests();
		bridge.forgetToken(TOKEN);
		assert.deepStrictEqual({ reply: (await waiting).body, alive: bridge.isAlive(TOKEN, SESSION) }, { reply: { state: 'expired' }, alive: false });
	});
});

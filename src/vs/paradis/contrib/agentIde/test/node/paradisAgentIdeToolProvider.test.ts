/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpPaneAgentStatus, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisAgentIdeInternal, ParadisAgentIdeRequest, ParadisAgentIdeResult } from '../../common/paradisAgentIde.js';
import { IParadisAgentIdeClock, IParadisAgentIdeSettings, ParadisAgentIdeToolProvider } from '../../node/paradisAgentIdeToolProvider.js';

const CALLER = 'caller-token';
const TARGET = 'target-secret-token';

class FakeClock implements IParadisAgentIdeClock {
	time = 1_000_000;
	onSleep: (() => void) | undefined;
	now(): number {
		return this.time;
	}
	async sleep(ms: number): Promise<void> {
		this.time += ms;
		this.onSleep?.();
	}
}

function text(result: unknown): { readonly isError: boolean; readonly body: string } {
	const value = result as { content: { text: string }[]; isError?: boolean };
	return { isError: value.isError === true, body: value.content[0].text };
}

// Claude Code 2.1.283 / codex-cli 0.155.1 の実際の画面の形（文言は CLI の文字列から拾った）
const CLAUDE_TRUST_DIALOG = [
	'\u256d\u2500\u2500\u2500\u2500\u256e',
	' Accessing workspace:',
	'',
	' /Users/example/projects/demo',
	'',
	' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
	' open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
	'',
	' \u276f 1. Yes, I trust this folder',
	'   2. No, exit',
].join('\n');
const CODEX_TRUST_DIALOG = [
	'> You are in /Users/example/projects/demo',
	'',
	'  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.',
	'',
	'\u203a 1. Yes, continue',
	'  2. No, quit',
].join('\n');
const CLAUDE_READY = [
	'\u256d\u2500\u2500\u256e',
	'\u2502 \u276f  \u2502',
	'\u2570\u2500\u2500\u256f',
	'  ? for shortcuts',
].join('\n');

suite('ParadisAgentIdeToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { actionsEnabled?: boolean; shellCommands?: boolean; caller?: ParadisMcpCallerKind } = {}) {
		const statuses = new Map<string, IParadisMcpPaneAgentStatus>();
		const marks = new Map<string, 'pending' | 'unverifiable'>();
		const hookTokens = new Set<string>([TARGET]);
		const calls: ParadisAgentIdeRequest[] = [];
		const state = { screen: '', agent: true, gone: false, launchedAt: undefined as number | undefined, launchedIdle: false };
		const internal = (): IParadisAgentIdeInternal => ({ paneToken: TARGET, status: 'idle', agent: state.agent, screen: state.screen, ...(state.launchedAt !== undefined ? { launchedAt: state.launchedAt } : {}), ...(state.launchedIdle ? { launchedIdle: true } : {}) });
		const respond = (request: ParadisAgentIdeRequest): ParadisAgentIdeResult => {
			switch (request.op) {
				case 'listTerminals': return { ok: true, data: { terminals: [] } };
				case 'resolveWriteTarget': return { ok: true, data: { terminal: request.terminal }, internal: internal() };
				case 'sendInput': return { ok: true, data: { terminal: request.terminal, typed: true, pressed_enter: false } };
				case 'sendKey': return { ok: true, data: { terminal: request.terminal, key: request.key } };
				case 'probeTerminal': return state.gone ? { ok: true, data: {}, internal: { gone: true } } : { ok: true, data: { id: request.terminal }, internal: internal() };
				default: return { ok: false, error: `unexpected ${request.op}` };
			}
		};
		const context: IParadisMcpToolCallContext = {
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
				assert.strictEqual(request.args[0], CALLER);
				const call = request.args[1] as ParadisAgentIdeRequest;
				calls.push(call);
				return { ok: true, value: respond(call) as T };
			},
			getPaneAgentStatus: token => statuses.get(token),
			getUnconfirmedRelease: token => marks.get(token),
			hasAgentHookHistory: token => hookTokens.has(token),
			classifyCaller: async () => options.caller ?? 'pane',
		};
		const clock = new FakeClock();
		const settings: IParadisAgentIdeSettings = {
			actionsEnabled: () => options.actionsEnabled ?? true,
			actionScope: () => 'space',
			readOtherSpaces: () => false,
			shellCommands: () => options.shellCommands ?? false,
		};
		const provider = new ParadisAgentIdeToolProvider(settings, undefined, clock);
		return { provider, calls, statuses, marks, hookTokens, state, clock, context };
	}

	const ops = (calls: ParadisAgentIdeRequest[]) => calls.map(call => call.op === 'sendKey' ? `sendKey:${call.key}` : call.op);

	test('ignores tools it does not own', async () => {
		const { provider, context } = setup();
		assert.strictEqual(await provider.callTool(CALLER, 'take_snapshot', {}, undefined, context), undefined);
	});

	test('reading works with actions off, and the settings are reported', async () => {
		const { provider, context } = setup({ actionsEnabled: false });
		const result = text(await provider.callTool(CALLER, 'list_terminals', {}, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, body: JSON.parse(result.body) }, {
			isError: false,
			body: { actions_enabled: false, action_scope: 'space', read_other_spaces: false, shell_commands: false, terminals: [] },
		});
	});

	test('actions are refused when turned off, or when the caller process is not in its pane', async () => {
		const off = setup({ actionsEnabled: false });
		const unverified = setup({ caller: 'unverified' });
		const tunnel = setup({ caller: 'tunnel' });
		const results = [
			text(await off.provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: true }, undefined, off.context)).isError,
			text(await unverified.provider.callTool(CALLER, 'launch_agent', { agent: 'claude' }, undefined, unverified.context)).isError,
			text(await tunnel.provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, tunnel.context)).isError,
		];
		assert.deepStrictEqual({ results, calls: [off.calls.length, unverified.calls.length, tunnel.calls.length] }, { results: [true, true, true], calls: [0, 0, 0] });
	});

	test('reading also needs a verified caller; over the SSH return path it works but actions are shown as unavailable', async () => {
		const unverified = setup({ caller: 'unverified' });
		const tunnel = setup({ caller: 'tunnel' });
		const refusedRead = text(await unverified.provider.callTool(CALLER, 'list_terminals', {}, undefined, unverified.context));
		const refusedWait = text(await unverified.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input' }, undefined, unverified.context));
		const listed = JSON.parse(text(await tunnel.provider.callTool(CALLER, 'list_terminals', {}, undefined, tunnel.context)).body);
		assert.deepStrictEqual({
			refused: [refusedRead.isError, refusedWait.isError, unverified.calls.length],
			actionsEnabled: listed.actions_enabled,
			note: typeof listed.actions_note,
		}, { refused: [true, true, 0], actionsEnabled: false, note: 'string' });
	});

	test('Enter is refused after a release that no verified hook confirmed yet', async () => {
		const { provider, context, statuses, marks } = setup();
		statuses.set(TARGET, { status: 'review', changedAt: 2 });
		marks.set(TARGET, 'pending');
		const pending = text(await provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, context));
		marks.set(TARGET, 'unverifiable');
		const unverifiable = text(await provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, context));
		// The viewer acknowledged the review, so the status entry is gone; the mark must still hold.
		statuses.delete(TARGET);
		const acknowledged = text(await provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, context));
		assert.deepStrictEqual([pending.isError, unverifiable.isError, unverifiable.body.includes('leaves pressing Enter there to the user'), acknowledged.isError], [true, true, true, true]);
	});

	test('pasted text that looks like a prompt does not block its own Enter, but a prompt already on screen does', async () => {
		const typed = setup();
		const own = text(await typed.provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'Reply (y/n) when done', press_enter: true }, undefined, typed.context));
		// the fake window shows the pasted text after the paste
		const onScreen = setup();
		onScreen.state.screen = 'Do you want to proceed?';
		const blocked = text(await onScreen.provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'hello', press_enter: true }, undefined, onScreen.context));
		assert.deepStrictEqual([own.isError, blocked.isError, ops(onScreen.calls)], [false, true, ['resolveWriteTarget']]);
	});

	test('putting a prompt phrase in the text does not hide a real prompt that appears after the paste', async () => {
		const { provider, context, state, clock, calls } = setup();
		clock.onSleep = () => { state.screen = 'Reply (y/n) when done\nDo you want to proceed?'; };
		const result = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'Reply (y/n) when done', press_enter: true }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, ops: ops(calls) }, { isError: true, ops: ['resolveWriteTarget', 'sendInput', 'resolveWriteTarget'] });
	});

	test('Enter is refused while a confirmation prompt is on screen', async () => {
		const { provider, context, state, calls } = setup();
		state.screen = 'Bash command\n  rm -rf build\nDo you want to proceed?\n\u276f 1. Yes\n  2. No';
		const result = text(await provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, ops: ops(calls) }, { isError: true, ops: ['resolveWriteTarget'] });
	});

	test('paste and Enter are separate calls, and the status is checked again before Enter', async () => {
		const { provider, context, calls, statuses, clock } = setup();
		clock.onSleep = () => statuses.set(TARGET, { status: 'permission', changedAt: clock.time });
		const refused = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: true }, undefined, context));
		assert.deepStrictEqual({ isError: refused.isError, typed: refused.body.startsWith('The text was typed, but Enter was not pressed'), ops: ops(calls) }, {
			isError: true, typed: true, ops: ['resolveWriteTarget', 'sendInput', 'resolveWriteTarget'],
		});
	});

	test('Enter goes through for an idle agent, and the pane token never reaches the agent', async () => {
		const { provider, context, calls } = setup();
		const result = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: true }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, ops: ops(calls), leaked: result.body.includes(TARGET) }, {
			isError: false, ops: ['resolveWriteTarget', 'sendInput', 'resolveWriteTarget', 'sendKey:enter'], leaked: false,
		});
	});

	test('Enter is refused while working, without hook history, and for plain shells unless allowed', async () => {
		const working = setup();
		working.statuses.set(TARGET, { status: 'working', changedAt: 1 });
		const noHooks = setup();
		noHooks.hookTokens.clear();
		const shell = setup();
		shell.state.agent = false;
		const shellAllowed = setup({ shellCommands: true });
		shellAllowed.state.agent = false;
		const run = async (fixture: ReturnType<typeof setup>) => text(await fixture.provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'enter' }, undefined, fixture.context)).isError;
		assert.deepStrictEqual([await run(working), await run(noHooks), await run(shell), await run(shellAllowed)], [true, true, true, false]);
	});

	test('agent_stopped waits for the agent to start and finish', async () => {
		const { provider, context, statuses, clock } = setup({ actionsEnabled: false });
		let polls = 0;
		clock.onSleep = () => {
			polls++;
			if (polls === 2) {
				statuses.set(TARGET, { status: 'working', changedAt: clock.time });
			} else if (polls === 4) {
				statuses.set(TARGET, { status: 'review', changedAt: clock.time });
			}
		};
		const result = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }, undefined, context)).body);
		assert.deepStrictEqual({ met: result.met, reason: result.reason, status: result.status, waited: result.waited_seconds, leaked: JSON.stringify(result).includes(TARGET) }, { met: true, reason: 'stopped', status: 'finished', waited: 4, leaked: false });
	});

	test('agent_stopped does not report silence as finished, and gives a launched agent longer to start', async () => {
		const plain = setup({ actionsEnabled: false });
		const silent = JSON.parse(text(await plain.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }, undefined, plain.context)).body);
		const launched = setup({ actionsEnabled: false });
		launched.state.launchedAt = launched.clock.time;
		const starting = JSON.parse(text(await launched.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped', timeout_seconds: 30 }, undefined, launched.context)).body);
		assert.deepStrictEqual([
			{ met: silent.met, reason: silent.reason, waited: silent.waited_seconds },
			{ met: starting.met, timedOut: starting.timed_out },
		], [
			{ met: false, reason: 'no_agent_status', waited: 5 },
			{ met: false, timedOut: true },
		]);
	});

	test('nothing is typed into a startup trust dialog, and waits report it as needing the user', async () => {
		const send = setup();
		send.hookTokens.clear();
		send.state.screen = CLAUDE_TRUST_DIALOG;
		const paste = text(await send.provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: '1', press_enter: false }, undefined, send.context));
		const key = text(await send.provider.callTool(CALLER, 'send_terminal_key', { terminal: 't_1', key: 'escape' }, undefined, send.context));

		const wait = setup({ actionsEnabled: false });
		wait.state.launchedAt = wait.clock.time;
		wait.state.screen = CODEX_TRUST_DIALOG;
		const stopped = JSON.parse(text(await wait.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }, undefined, wait.context)).body);
		const needsInput = JSON.parse(text(await wait.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input' }, undefined, wait.context)).body);

		assert.deepStrictEqual({
			paste: { isError: paste.isError, trust: paste.body.includes('trust') },
			key: key.isError,
			sent: ops(send.calls),
			stopped: { met: stopped.met, reason: stopped.reason, blockedBy: stopped.blocked_by, status: stopped.status, waited: stopped.waited_seconds },
			needsInput: { met: needsInput.met, blockedBy: needsInput.blocked_by },
		}, {
			paste: { isError: true, trust: true },
			key: true,
			sent: ['resolveWriteTarget', 'resolveWriteTarget'],
			stopped: { met: true, reason: 'needs_input', blockedBy: 'trust_dialog', status: 'waiting_for_permission', waited: 0 },
			needsInput: { met: true, blockedBy: 'trust_dialog' },
		});
	});

	test('an agent launched without a prompt is reported ready once its input box shows', async () => {
		const idle = setup({ actionsEnabled: false });
		idle.state.launchedAt = idle.clock.time;
		idle.state.launchedIdle = true;
		idle.clock.onSleep = () => { idle.state.screen = CLAUDE_READY; };
		const ready = JSON.parse(text(await idle.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }, undefined, idle.context)).body);

		const prompted = setup({ actionsEnabled: false });
		prompted.state.launchedAt = prompted.clock.time;
		prompted.state.screen = CLAUDE_READY;
		const starting = JSON.parse(text(await prompted.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped', timeout_seconds: 10 }, undefined, prompted.context)).body);

		assert.deepStrictEqual([
			{ met: ready.met, reason: ready.reason, waited: ready.waited_seconds },
			{ met: starting.met, timedOut: starting.timed_out },
		], [
			{ met: true, reason: 'ready', waited: 1 },
			{ met: false, timedOut: true },
		]);
	});

	test('a terminal closed while waiting ends the wait; an unknown one is an error', async () => {
		const closing = setup({ actionsEnabled: false });
		closing.clock.onSleep = () => { closing.state.gone = true; };
		const closed = JSON.parse(text(await closing.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input' }, undefined, closing.context)).body);
		const missing = setup({ actionsEnabled: false });
		missing.state.gone = true;
		const unknown = text(await missing.provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input' }, undefined, missing.context));
		assert.deepStrictEqual([{ met: closed.met, reason: closed.reason }, unknown.isError], [{ met: false, reason: 'terminal_closed' }, true]);
	});

	test('text wait times out with a hint and can succeed', async () => {
		const { provider, context, state, clock } = setup({ actionsEnabled: false });
		const timedOut = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'text', text: 'DONE', timeout_seconds: 3 }, undefined, context)).body);
		clock.onSleep = () => { state.screen = 'build\nDONE 42'; };
		const met = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'text', text: 'DONE', timeout_seconds: 3 }, undefined, context)).body);
		assert.deepStrictEqual(
			[{ met: timedOut.met, timedOut: timedOut.timed_out, waited: timedOut.waited_seconds }, { met: met.met, tail: met.screen_tail }],
			[{ met: false, timedOut: true, waited: 3 }, { met: true, tail: 'build\nDONE 42' }],
		);
	});

	test('concurrent waits per pane are limited', async () => {
		const { provider, context, clock } = setup({ actionsEnabled: false });
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		clock.sleep = async ms => { clock.time += ms; await gate; };
		const first = provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input', timeout_seconds: 10 }, undefined, context);
		const second = provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input', timeout_seconds: 10 }, undefined, context);
		await new Promise(resolve => setTimeout(resolve, 0));
		const third = text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'needs_input', timeout_seconds: 1 }, undefined, context));
		release();
		await Promise.all([first, second]);
		assert.deepStrictEqual(third.isError, true);
	});

	test('guide and server instructions are available without a window', async () => {
		const { provider } = setup({ actionsEnabled: false });
		const guide = text(await provider.callTool(CALLER, 'read_para_code_guide', {}));
		assert.deepStrictEqual({ guide: guide.body.startsWith('# Para Code IDE tools'), instructions: provider.instructions().includes('read_para_code_guide') }, { guide: true, instructions: true });
	});
});

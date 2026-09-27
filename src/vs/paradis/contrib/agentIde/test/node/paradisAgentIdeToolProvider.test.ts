/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpPaneAgentStatus, IParadisMcpToolCallContext, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
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

suite('ParadisAgentIdeToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { actionsEnabled?: boolean; shellCommands?: boolean; verified?: boolean } = {}) {
		const statuses = new Map<string, IParadisMcpPaneAgentStatus>();
		const hookTokens = new Set<string>([TARGET]);
		const calls: ParadisAgentIdeRequest[] = [];
		const state = { screen: '', agent: true, gone: false, launchedAt: undefined as number | undefined };
		const internal = (): IParadisAgentIdeInternal => ({ paneToken: TARGET, status: 'idle', agent: state.agent, screen: state.screen, ...(state.launchedAt !== undefined ? { launchedAt: state.launchedAt } : {}) });
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
			hasAgentHookHistory: token => hookTokens.has(token),
			verifyCallerProcess: async () => options.verified ?? true,
		};
		const clock = new FakeClock();
		const settings: IParadisAgentIdeSettings = {
			actionsEnabled: () => options.actionsEnabled ?? true,
			actionScope: () => 'space',
			readOtherSpaces: () => false,
			shellCommands: () => options.shellCommands ?? false,
		};
		const provider = new ParadisAgentIdeToolProvider(settings, undefined, clock);
		return { provider, calls, statuses, hookTokens, state, clock, context };
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
		const unverified = setup({ verified: false });
		const results = [
			text(await off.provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: true }, undefined, off.context)).isError,
			text(await unverified.provider.callTool(CALLER, 'launch_agent', { agent: 'claude' }, undefined, unverified.context)).isError,
		];
		assert.deepStrictEqual({ results, calls: [off.calls.length, unverified.calls.length] }, { results: [true, true], calls: [0, 0] });
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpPaneAgentStatus, IParadisMcpToolCallContext, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisAgentIdeRequest, ParadisAgentIdeResult } from '../../common/paradisAgentIde.js';
import { IParadisAgentIdeClock, ParadisAgentIdeToolProvider } from '../../node/paradisAgentIdeToolProvider.js';

const CALLER = 'caller-token';
const TARGET = 'target-secret-token';

interface IFakeWindow {
	readonly calls: ParadisAgentIdeRequest[];
	respond(request: ParadisAgentIdeRequest): ParadisAgentIdeResult;
}

function createContext(window: IFakeWindow, statuses: Map<string, IParadisMcpPaneAgentStatus>): IParadisMcpToolCallContext {
	return {
		callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
			assert.strictEqual(request.args[0], CALLER);
			const call = request.args[1] as ParadisAgentIdeRequest;
			window.calls.push(call);
			return { ok: true, value: window.respond(call) as T };
		},
		getPaneAgentStatus: token => statuses.get(token),
	};
}

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

	function setup(options: { actionsEnabled: boolean }) {
		const statuses = new Map<string, IParadisMcpPaneAgentStatus>();
		const window: IFakeWindow & { screen: string } = {
			calls: [],
			screen: '',
			respond(request) {
				switch (request.op) {
					case 'listTerminals': return { ok: true, data: { terminals: [] } };
					case 'resolveWriteTarget': return { ok: true, data: { terminal: request.terminal }, internal: { paneToken: TARGET, status: 'idle' } };
					case 'sendInput': return { ok: true, data: { terminal: request.terminal, typed: true, pressed_enter: request.pressEnter } };
					case 'probeTerminal': return { ok: true, data: { id: request.terminal }, internal: { paneToken: TARGET, status: 'idle', screen: window.screen } };
					default: return { ok: false, error: `unexpected ${request.op}` };
				}
			},
		};
		const clock = new FakeClock();
		const provider = new ParadisAgentIdeToolProvider({ actionsEnabled: () => options.actionsEnabled, actionScope: () => 'space' }, undefined, clock);
		return { provider, window, statuses, clock, context: createContext(window, statuses) };
	}

	test('ignores tools it does not own', async () => {
		const { provider, context } = setup({ actionsEnabled: true });
		assert.strictEqual(await provider.callTool(CALLER, 'take_snapshot', {}, undefined, context), undefined);
	});

	test('reading works with actions off, and the permission state is reported', async () => {
		const { provider, context } = setup({ actionsEnabled: false });
		const result = text(await provider.callTool(CALLER, 'list_terminals', {}, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, body: JSON.parse(result.body) }, { isError: false, body: { actions_enabled: false, action_scope: 'space', terminals: [] } });
	});

	test('actions are refused before reaching the window when turned off', async () => {
		const { provider, context, window } = setup({ actionsEnabled: false });
		const result = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: true }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, calls: window.calls.length }, { isError: true, calls: 0 });
	});

	test('input is refused while the target waits for a permission answer (hook status wins)', async () => {
		const { provider, context, window, statuses } = setup({ actionsEnabled: true });
		statuses.set(TARGET, { status: 'permission', changedAt: 1 });
		const result = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'yes', press_enter: true }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, ops: window.calls.map(call => call.op) }, { isError: true, ops: ['resolveWriteTarget'] });
	});

	test('input goes through when the target is idle, and the pane token never reaches the agent', async () => {
		const { provider, context, window } = setup({ actionsEnabled: true });
		const result = text(await provider.callTool(CALLER, 'send_terminal_input', { terminal: 't_1', text: 'go', press_enter: false }, undefined, context));
		assert.deepStrictEqual({ isError: result.isError, ops: window.calls.map(call => call.op), leaked: result.body.includes(TARGET) }, { isError: false, ops: ['resolveWriteTarget', 'sendInput'], leaked: false });
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
		assert.deepStrictEqual({ met: result.met, status: result.status, waited: result.waited_seconds, leaked: JSON.stringify(result).includes(TARGET) }, { met: true, status: 'finished', waited: 4, leaked: false });
	});

	test('agent_stopped returns after the start grace when nothing happens', async () => {
		const { provider, context } = setup({ actionsEnabled: false });
		const result = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }, undefined, context)).body);
		assert.deepStrictEqual({ met: result.met, status: result.status, waited: result.waited_seconds }, { met: true, status: 'idle', waited: 5 });
	});

	test('text wait times out with a hint and can succeed', async () => {
		const { provider, context, window, clock } = setup({ actionsEnabled: false });
		const timedOut = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'text', text: 'DONE', timeout_seconds: 3 }, undefined, context)).body);
		clock.onSleep = () => { window.screen = 'build\nDONE 42'; };
		const met = JSON.parse(text(await provider.callTool(CALLER, 'wait_for_terminal', { terminal: 't_1', until: 'text', text: 'DONE', timeout_seconds: 3 }, undefined, context)).body);
		assert.deepStrictEqual(
			[{ met: timedOut.met, timedOut: timedOut.timed_out, waited: timedOut.waited_seconds }, { met: met.met, tail: met.screen_tail }],
			[{ met: false, timedOut: true, waited: 3 }, { met: true, tail: 'build\nDONE 42' }],
		);
	});

	test('guide and server instructions are available without a window', async () => {
		const { provider } = setup({ actionsEnabled: false });
		const guide = text(await provider.callTool(CALLER, 'read_para_code_guide', {}));
		assert.deepStrictEqual({ guide: guide.body.startsWith('# Para Code IDE tools'), instructions: provider.instructions().includes('read_para_code_guide') }, { guide: true, instructions: true });
	});
});

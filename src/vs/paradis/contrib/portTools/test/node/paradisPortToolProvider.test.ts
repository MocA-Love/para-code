/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisPortToolProvider } from '../../node/paradisPortToolProvider.js';

function context(caller: ParadisMcpCallerKind, requests: IParadisMcpOwningWindowRequest[]): IParadisMcpToolCallContext {
	return {
		classifyCaller: async () => caller,
		callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
			requests.push(request);
			return { ok: true, value: { ok: true, data: { done: true } } as T };
		},
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => false,
	};
}

function outcome(result: unknown): string {
	const value = result as { content: { text: string }[]; isError?: boolean } | undefined;
	return value === undefined ? 'not mine' : value.isError ? `error: ${value.content[0].text.split('.')[0]}` : 'ok';
}

suite('ParadisPortToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts agents in the pane and on the SSH host, refuses unverified callers, and waits longer for changes', async () => {
		const provider = new ParadisPortToolProvider();
		const requests: IParadisMcpOwningWindowRequest[] = [];
		const results = [
			outcome(await provider.callTool('pane', 'list_port_forwards', {}, undefined, context('tunnel', requests))),
			outcome(await provider.callTool('pane', 'stop_port_forward', { remote_port: 21004 }, undefined, context('tunnel', requests))),
			outcome(await provider.callTool('pane', 'forward_port', { remote_port: 21004 }, undefined, context('pane', requests))),
			outcome(await provider.callTool('pane', 'forward_port', { remote_port: 21004 }, undefined, context('unverified', requests))),
			outcome(await provider.callTool('pane', 'forward_port', { remote_port: 0 }, undefined, context('tunnel', requests))),
			outcome(await provider.callTool('pane', 'take_snapshot', {}, undefined, context('pane', requests))),
		];
		assert.deepStrictEqual({
			results,
			requests: requests.map(request => ({ channel: request.channelName, args: request.args, timeoutMs: request.timeoutMs })),
		}, {
			results: ['ok', 'ok', 'ok', 'error: Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from the SSH host of its window), so it refuses the request', 'error: "remote_port" must be an integer port number from 1 to 65535', 'not mine'],
			requests: [
				{ channel: 'paradisPortTools', args: ['pane', { op: 'list', includeDetected: false }], timeoutMs: undefined },
				{ channel: 'paradisPortTools', args: ['pane', { op: 'stop', remotePorts: [21004] }], timeoutMs: 180_000 },
				{ channel: 'paradisPortTools', args: ['pane', { op: 'forward', items: [{ remotePort: 21004, localPort: 21004 }], batch: false }], timeoutMs: 180_000 },
			],
		});
	});
});

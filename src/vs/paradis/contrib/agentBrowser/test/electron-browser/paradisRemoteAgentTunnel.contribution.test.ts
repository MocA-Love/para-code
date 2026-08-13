/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRemoteAgentTunnelController } from '../../electron-browser/paradisRemoteAgentTunnel.contribution.js';

interface IChannelCall {
	readonly command: string;
	readonly argument: readonly string[] | undefined;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(complete => resolve = complete);
	return { promise, resolve };
}

suite('ParadisRemoteAgentTunnelController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens only SSH authorities and closes the same authority on disposal', async () => {
		const calls: IChannelCall[] = [];
		const channel: IChannel = {
			call: async <T>(command: string, argument?: readonly string[]): Promise<T> => {
				calls.push({ command, argument });
				return true as T;
			},
			listen: () => Event.None,
		};
		const local = store.add(new ParadisRemoteAgentTunnelController(undefined, true, channel, new NullLogService()));
		const container = store.add(new ParadisRemoteAgentTunnelController('dev-container+workspace', true, channel, new NullLogService()));
		const ssh = store.add(new ParadisRemoteAgentTunnelController('ssh-remote+example.com', true, channel, new NullLogService()));
		await Promise.resolve();

		local.dispose();
		container.dispose();
		ssh.dispose();
		await Promise.resolve();

		assert.deepStrictEqual(calls, [
			{ command: 'ensureRemoteAgentTunnel', argument: ['ssh-remote+example.com'] },
			{ command: 'closeRemoteAgentTunnel', argument: ['ssh-remote+example.com'] },
		]);
	});

	test('does not open or close a tunnel when the setting is disabled', async () => {
		const calls: IChannelCall[] = [];
		const channel: IChannel = {
			call: async <T>(command: string, argument?: readonly string[]): Promise<T> => {
				calls.push({ command, argument });
				return true as T;
			},
			listen: () => Event.None,
		};
		const controller = store.add(new ParadisRemoteAgentTunnelController('ssh-remote+disabled.example.com', false, channel, new NullLogService()));

		controller.dispose();
		await Promise.resolve();

		assert.deepStrictEqual(calls, []);
	});

	test('waits for a pending ensure before closing the tunnel', async () => {
		const calls: IChannelCall[] = [];
		const ensured = deferred();
		const channel: IChannel = {
			call: async <T>(command: string, argument?: readonly string[]): Promise<T> => {
				calls.push({ command, argument });
				if (command === 'ensureRemoteAgentTunnel') {
					await ensured.promise;
				}
				return true as T;
			},
			listen: () => Event.None,
		};
		const controller = store.add(new ParadisRemoteAgentTunnelController('ssh-remote+pending.example.com', true, channel, new NullLogService()));

		controller.dispose();
		assert.deepStrictEqual(calls, [
			{ command: 'ensureRemoteAgentTunnel', argument: ['ssh-remote+pending.example.com'] },
		]);

		ensured.resolve();
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(calls, [
			{ command: 'ensureRemoteAgentTunnel', argument: ['ssh-remote+pending.example.com'] },
			{ command: 'closeRemoteAgentTunnel', argument: ['ssh-remote+pending.example.com'] },
		]);
	});
});

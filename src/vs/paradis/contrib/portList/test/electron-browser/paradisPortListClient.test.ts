/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPortKillRequest, IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListClient } from '../../electron-browser/paradisPortListClient.js';

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

function recordingChannel(calls: IRecordedCall[]): IChannel {
	return {
		listen: () => Event.None,
		call: async <T>(command: string, arg?: unknown): Promise<T> => {
			calls.push({ command, arg });
			if (command === 'getSnapshot') {
				return { entries: [], collectedAt: 1 } as IParadisPortListSnapshot as T;
			}
			if (command === 'killAll') {
				return { failed: 0 } as T;
			}
			return undefined as T;
		},
	};
}

suite('ParadisPortListClient route identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses null as local and a connection object as remote for every operation', async () => {
		const request: IParadisPortKillRequest = { port: 3000, pid: 10, processName: 'node' };
		const expectedCalls: readonly IRecordedCall[] = [
			{ command: 'getSnapshot', arg: [{ force: false }] },
			{ command: 'kill', arg: [request] },
			{ command: 'killAll', arg: [[request]] },
		];
		const sharedCalls: IRecordedCall[] = [];
		const remoteCalls: IRecordedCall[] = [];
		const sharedChannel = recordingChannel(sharedCalls);
		const remoteChannel = recordingChannel(remoteCalls);
		let connection: IRemoteAgentConnection | null = null;
		const sharedProcessService = { getChannel: () => sharedChannel } as unknown as ISharedProcessService;
		const remoteAgentService = { getConnection: () => connection } as unknown as IRemoteAgentService;
		const client = new ParadisPortListClient(sharedProcessService, remoteAgentService);

		assert.strictEqual(client.connectedToRemote, false);
		await client.getSnapshot();
		await client.kill(request, false);
		assert.deepStrictEqual(await client.killAll([request], false), { failed: 0 });
		assert.deepStrictEqual(sharedCalls, expectedCalls);
		await assert.rejects(client.kill(request, true), /remote connection state changed/);
		await assert.rejects(client.killAll([request], true), /remote connection state changed/);
		assert.deepStrictEqual(sharedCalls, expectedCalls);

		connection = { getChannel: () => remoteChannel } as unknown as IRemoteAgentConnection;
		assert.strictEqual(client.connectedToRemote, true);
		await client.getSnapshot();
		await client.kill(request, true);
		assert.deepStrictEqual(await client.killAll([request], true), { failed: 0 });
		assert.deepStrictEqual(remoteCalls, expectedCalls);
		await assert.rejects(client.kill(request, false), /remote connection state changed/);
		await assert.rejects(client.killAll([request], false), /remote connection state changed/);
		assert.deepStrictEqual(remoteCalls, expectedCalls);

		connection = null;
		assert.strictEqual(client.connectedToRemote, false);
		await client.getSnapshot();
		await client.kill(request, false);
		await client.killAll([request], false);
		assert.deepStrictEqual(sharedCalls, [...expectedCalls, ...expectedCalls]);
		await assert.rejects(client.killAll([request], true), /remote connection state changed/);
		assert.deepStrictEqual(sharedCalls, [...expectedCalls, ...expectedCalls]);
	});
});

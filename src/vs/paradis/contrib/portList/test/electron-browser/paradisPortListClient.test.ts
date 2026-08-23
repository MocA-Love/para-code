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
import { IParadisPortKillRequest } from '../../common/paradisPortList.js';
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
			return { failed: 0 } as T;
		},
	};
}

suite('ParadisPortListClient batch kill', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends one remote Kill All envelope and rejects a route mismatch before IPC', async () => {
		const request: IParadisPortKillRequest = { port: 3000, pid: 10, processName: 'node' };
		const sharedCalls: IRecordedCall[] = [];
		const remoteCalls: IRecordedCall[] = [];
		const sharedChannel = recordingChannel(sharedCalls);
		const remoteChannel = recordingChannel(remoteCalls);
		const remoteConnection = { getChannel: () => remoteChannel } as unknown as IRemoteAgentConnection;
		const sharedProcessService = { getChannel: () => sharedChannel } as unknown as ISharedProcessService;
		const remoteAgentService = { getConnection: () => remoteConnection } as unknown as IRemoteAgentService;
		const client = new ParadisPortListClient(sharedProcessService, remoteAgentService);

		assert.deepStrictEqual(await client.killAll([request], true), { failed: 0 });
		await assert.rejects(client.killAll([request], false), /remote connection state changed/);
		assert.deepStrictEqual(remoteCalls, [{ command: 'killAll', arg: [[request]] }]);
		assert.deepStrictEqual(sharedCalls, []);
	});
});

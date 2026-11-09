/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓（リモートの接続がある窓）でも、シミュレータの一覧・映像・入力は手元の shared process のチャネルへ行くこと。
// 接続先（REH）には Xcode も simctl も adb の端末も無いので、リモートのチャネルへ振ると映像が出ない。

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_SIMULATOR_CHANNEL } from '../../common/paradisSimulator.js';
import { ParadisSimulatorClient } from '../../electron-browser/paradisSimulatorClient.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

function recordingChannel(where: string, log: string[]): IChannel {
	return {
		call: async <T>(command: string) => {
			log.push(`${where} call ${command}`);
			return [] as T;
		},
		listen: <T>(event: string) => {
			log.push(`${where} listen ${event}`);
			return Event.None as Event<T>;
		},
	};
}

suite('Paradis simulator: client in an SSH window', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the local shared process channel even when the window has a remote connection', async () => {
		const log: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ISharedProcessService, {
			getChannel: (name: string) => {
				log.push(`shared channel ${name}`);
				return recordingChannel('shared', log);
			},
		});
		// SSH の窓を模す: 接続があり、チャネルを求められたら記録する（呼ばれないこと）
		const connection: Pick<IRemoteAgentConnection, 'remoteAuthority' | 'getChannel'> = {
			remoteAuthority: 'ssh-remote+example',
			getChannel: <T extends IChannel>(name: string) => {
				log.push(`remote channel ${name}`);
				return recordingChannel('remote', log) as T;
			},
		};
		instantiationService.stub(IRemoteAgentService, { getConnection: () => connection as IRemoteAgentConnection });
		const client = instantiationService.createInstance(ParadisSimulatorClient);
		await client.listDevices();
		await client.listAndroidDevices();
		store.add(client.onFrames(UDID)(() => { }));
		await client.sendInput(UDID, { kind: 'button', button: 'home' });
		assert.deepStrictEqual(log, [
			`shared channel ${PARADIS_SIMULATOR_CHANNEL}`,
			'shared call listDevices',
			'shared call listAndroidDevices',
			'shared listen frames',
			'shared call sendInput',
		]);
	});
});

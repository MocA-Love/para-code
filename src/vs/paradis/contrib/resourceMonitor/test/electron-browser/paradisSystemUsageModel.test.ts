/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHostResources, IParadisResourceMonitorSnapshot } from '../../common/paradisResourceMonitor.js';
import { IParadisSystemUsageRequest, IParadisSystemUsageResponse, paradisEncodeSystemUsageSeries } from '../../common/paradisSystemUsage.js';
import { ParadisResourceMonitorClient } from '../../electron-browser/paradisResourceMonitorClient.js';
import { IParadisSystemUsageModel, ParadisSystemUsageMachineId, ParadisSystemUsageModel } from '../../electron-browser/paradisSystemUsageModel.js';

function hostResources(cpu: number, used: number): IParadisHostResources {
	return { cpu, cores: 8, memory: { total: 100, used }, disks: [{ path: '/', label: '/', total: 1000, free: 250 }], collectedAt: 77 };
}

function usageResponse(instanceId: string, hostname: string): IParadisSystemUsageResponse {
	return {
		version: 1,
		instanceId,
		machine: { os: 'linux', hostname, cores: 16, memTotal: 64 },
		tier: 'fine',
		stepMs: 5000,
		reset: true,
		unsupported: [],
		series: paradisEncodeSystemUsageSeries([{ t: 1, cpu: 10 }, { t: 2, cpu: 20 }]),
		latest: { t: 2, cpu: 20 },
	};
}

interface IChannelCall {
	readonly channel: string;
	readonly command: string;
	readonly arg: unknown;
}

function channelOf(name: string, calls: IChannelCall[], answer: (command: string, arg: unknown) => unknown) {
	return {
		call: async (command: string, arg: unknown) => {
			calls.push({ channel: name, command, arg });
			const value = answer(command, arg);
			if (value instanceof Error) {
				throw value;
			}
			return value;
		},
	};
}

suite('ParadisSystemUsageModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createModel(remote: ((command: string, arg: unknown) => unknown) | undefined, calls: IChannelCall[]) {
		const shared = { getChannel: (name: string) => channelOf(`shared:${name}`, calls, () => usageResponse('local-run', 'this-mac.local')) };
		const remoteAgent = {
			getConnection: () => remote === undefined ? null : { remoteAuthority: 'ssh-remote+dev-server', getChannel: (name: string) => channelOf(`remote:${name}`, calls, remote) },
		};
		const label = { getHostLabel: () => 'SSH: dev-server' };
		return new ParadisSystemUsageModel(shared as never, remoteAgent as never, label as never);
	}

	test('falls back to the current values when the remote server does not know the history command', async () => {
		const calls: IChannelCall[] = [];
		const model = createModel(command => command === 'getSystemUsage' ? new Error('Method not found: getSystemUsage') : hostResources(42.44, 80), calls);
		const view = await model.refresh('remote', '5m');
		assert.deepStrictEqual({
			calls: calls.map(call => `${call.channel}/${call.command}`),
			legacy: view.legacy,
			latest: view.latest,
			unsupported: view.unsupported,
			samples: view.samples,
			label: view.label,
			error: view.error,
		}, {
			calls: ['remote:paradisHostResources/getSystemUsage', 'remote:paradisHostResources/getHostResources'],
			legacy: true,
			latest: { t: 77, cpu: 42.4, mem: 80, disk: 75 },
			unsupported: ['diskIo', 'network', 'swap'],
			samples: [],
			label: 'SSH: dev-server',
			error: undefined,
		});
	});

	test('asks the shared process for this computer and the server for the remote, then only for the difference', async () => {
		const calls: IChannelCall[] = [];
		const model = createModel(() => usageResponse('remote-run', 'dev-server.example.com'), calls);
		const local = await model.refresh('local', '5m');
		const remote = await model.refresh('remote', '1h');
		await model.refresh('remote', '5m');
		assert.deepStrictEqual({
			machines: model.getMachines().map(machine => machine.id),
			defaultMachine: model.getDefaultMachineId(),
			calls: calls.map(call => ({ channel: call.channel, arg: call.arg })),
			local: local.samples.map(sample => sample.t),
			remoteLabel: remote.label,
		}, {
			machines: ['local', 'remote'],
			defaultMachine: 'remote',
			calls: [
				{ channel: 'shared:paradisSystemUsage', arg: { tier: 'fine' } },
				{ channel: 'remote:paradisHostResources', arg: { tier: 'fine' } },
				// 2 回目は手元の写しの最後の点から
				{ channel: 'remote:paradisHostResources', arg: { tier: 'fine', since: 2, instanceId: 'remote-run' } },
			],
			local: [1, 2],
			remoteLabel: 'dev-server',
		});
	});
});

suite('ParadisResourceMonitorClient mobile report', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const snapshot: IParadisResourceMonitorSnapshot = {
		app: { cpu: 0, memory: 0, main: { cpu: 0, memory: 0 }, renderer: { cpu: 0, memory: 0 }, other: { cpu: 0, memory: 0 } },
		scopes: [],
		totalCpu: 0,
		totalMemory: 0,
		hostTotalMemory: 0,
		collectedAt: 0,
	};

	/** SSH のウィンドウ（接続あり）の client。手元の値はメインプロセス、接続先の値は REH から取る。 */
	function createClient(connected: boolean) {
		const fetched: { machine: ParadisSystemUsageMachineId; request: IParadisSystemUsageRequest }[] = [];
		const model: IParadisSystemUsageModel = {
			_serviceBrand: undefined,
			getMachines: () => [],
			getDefaultMachineId: () => connected ? 'remote' : 'local',
			refresh: () => { throw new Error('unused'); },
			fetchRaw: async (machine, request) => {
				fetched.push({ machine, request });
				return usageResponse(`${machine}-run`, machine);
			},
		};
		const mainChannel = {
			call: async (command: string) => command === 'getSnapshot' ? snapshot : hostResources(10, 10),
		};
		const remoteChannel = { call: async () => hostResources(90, 90) };
		const client = new ParadisResourceMonitorClient(
			{ instances: [] } as never,
			{ paradisParkedGroups: [] } as never,
			{ getStateKeyForInstance: () => undefined } as never,
			{ repositories: [] } as never,
			{ getWorktrees: () => [] } as never,
			{ getChannel: () => mainChannel } as never,
			{ getConnection: () => connected ? { getChannel: () => remoteChannel } : null } as never,
			model,
		);
		return { client, fetched };
	}

	test('answers for the machine the app names, even from an SSH window', async () => {
		const ssh = createClient(true);
		const local = await ssh.client.getMobileReport(false, { machine: 'local', tier: 'fine' });
		const remote = await ssh.client.getMobileReport(false, { machine: 'remote', tier: 'coarse', since: 5, instanceId: 'x', maxPoints: 9 });
		// 古いアプリ（machine 無し・history 無し）は今までどおり、このウィンドウの繋がっているマシン
		const legacyApp = await ssh.client.getMobileReport(false);
		// 接続の無いウィンドウに接続先を頼まれた: 例外にせず、手元の値と「履歴は取れなかった」を返す
		const localWindow = createClient(false);
		const remoteFromLocal = await localWindow.client.getMobileReport(false, { machine: 'remote', tier: 'fine' });
		const remoteFromLocalWindow = { cpu: remoteFromLocal.host.cpu, history: remoteFromLocal.history, historyUnavailable: remoteFromLocal.historyUnavailable, historyMachine: remoteFromLocal.historyMachine, fetched: localWindow.fetched.length };
		assert.deepStrictEqual({
			local: { cpu: local.host.cpu, historyMachine: local.historyMachine, instance: local.history?.instanceId },
			remote: { cpu: remote.host.cpu, historyMachine: remote.historyMachine, instance: remote.history?.instanceId },
			legacyApp: { cpu: legacyApp.host.cpu, history: legacyApp.history, historyMachine: legacyApp.historyMachine },
			fetched: ssh.fetched,
			remoteFromLocalWindow,
		}, {
			local: { cpu: 10, historyMachine: 'local', instance: 'local-run' },
			remote: { cpu: 90, historyMachine: 'remote', instance: 'remote-run' },
			legacyApp: { cpu: 90, history: undefined, historyMachine: undefined },
			fetched: [
				{ machine: 'local', request: { tier: 'fine' } },
				{ machine: 'remote', request: { tier: 'coarse', since: 5, instanceId: 'x', maxPoints: 9 } },
			],
			remoteFromLocalWindow: { cpu: 10, history: undefined, historyUnavailable: 'failed', historyMachine: 'local', fetched: 0 },
		});
	});
});

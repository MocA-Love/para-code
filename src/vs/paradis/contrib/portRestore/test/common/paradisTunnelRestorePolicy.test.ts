/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { hash } from '../../../../../base/common/hash.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITunnelService, RemoteTunnel, TunnelPrivacyId } from '../../../../../platform/tunnel/common/tunnel.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { RestorableTunnel, TunnelCloseReason, TunnelModel, TunnelSource, UserTunnelSource } from '../../../../../workbench/services/remote/common/tunnelModel.js';
import { paradisImplicitTunnelSource, paradisIsImplicitTunnelSource, paradisMarkExplicitTunnelRecords, paradisTunnelsToRestore } from '../../../../../platform/tunnel/common/paradisTunnelRestorePolicy.js';

const authority = 'ssh-remote+example';

function record(remoteHost: string, remotePort: number, source: RestorableTunnel['source'], localPort = remotePort): RestorableTunnel {
	return {
		remoteHost,
		remotePort,
		localPort,
		localAddress: `localhost:${localPort}`,
		localUri: URI.parse(`http://localhost:${localPort}`),
		protocol: 'http' as RestorableTunnel['protocol'],
		source,
	};
}

function summary(tunnels: readonly { remoteHost: string; remotePort: number }[]): string[] {
	return tunnels.map(tunnel => `${tunnel.remoteHost}:${tunnel.remotePort}`).sort();
}

suite('paradisTunnelRestorePolicy', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps forwarded ports and fixed ports, drops implicit tunnels and stale ephemeral ports', () => {
		const implicit = paradisImplicitTunnelSource(TunnelSource.Extension);
		const extension = { source: TunnelSource.Extension, description: 'ext' };
		const auto = { source: TunnelSource.Auto, description: 'auto' };
		const tunnels = [
			record('localhost', 21004, UserTunnelSource, 65459),
			record('localhost', 3000, implicit),
			record('127.0.0.1', 33355, implicit),
			record('127.0.0.1', 41234, UserTunnelSource),
			record('localhost', 60605, UserTunnelSource),
			record('localhost', 50000, UserTunnelSource),
			record('localhost', 45000, auto),
			record('localhost', 8080, auto),
			record('localhost', 47000, extension),
		];
		const listening = new Set(['localhost:50000']);
		assert.deepStrictEqual(
			summary(paradisTunnelsToRestore(tunnels, TunnelSource.Extension, (host, port) => listening.has(`${host}:${port}`))),
			['localhost:21004', 'localhost:47000', 'localhost:50000', 'localhost:8080']
		);
	});

	test('records saved after this change are restored whatever their port', () => {
		const saved = [
			record('localhost', 41000, UserTunnelSource),
			record('localhost', 21004, UserTunnelSource),
			record('127.0.0.1', 33355, paradisImplicitTunnelSource(TunnelSource.Extension)),
		];
		paradisMarkExplicitTunnelRecords(saved);
		const stored = JSON.parse(JSON.stringify(saved)) as RestorableTunnel[];
		assert.deepStrictEqual({
			marked: stored.map(tunnel => `${tunnel.remotePort}:${(tunnel as { paradisExplicit?: boolean }).paradisExplicit === true}`),
			restored: summary(paradisTunnelsToRestore(stored, TunnelSource.Extension, () => false)),
		}, {
			marked: ['41000:true', '21004:true', '33355:false'],
			restored: ['localhost:21004', 'localhost:41000'],
		});
	});

	test('the implicit source survives a round trip through the stored JSON', () => {
		const stored = JSON.parse(JSON.stringify(record('127.0.0.1', 33355, paradisImplicitTunnelSource(TunnelSource.Extension)))) as RestorableTunnel;
		assert.deepStrictEqual(
			{ kind: stored.source.source, implicit: paradisIsImplicitTunnelSource(stored.source), user: paradisIsImplicitTunnelSource(UserTunnelSource) },
			{ kind: TunnelSource.Extension, implicit: true, user: false }
		);
	});

	suite('TunnelModel', () => {

		class FakeTunnelService extends mock<ITunnelService>() {
			readonly opened: Emitter<RemoteTunnel> = store.add(new Emitter<RemoteTunnel>());
			readonly closed: Emitter<{ host: string; port: number }> = store.add(new Emitter<{ host: string; port: number }>());
			override readonly onTunnelOpened = this.opened.event;
			override readonly onTunnelClosed = this.closed.event;
			override readonly tunnels = Promise.resolve([]);
			override readonly canElevate = false;
			readonly openedPorts: number[] = [];
			override async openTunnel(_addressProvider: unknown, remoteHost: string | undefined, remotePort: number, _localHost?: string, localPort?: number): Promise<RemoteTunnel | string | undefined> {
				this.openedPorts.push(remotePort);
				return makeRemoteTunnel(remoteHost ?? 'localhost', remotePort, localPort ?? remotePort);
			}
			override async closeTunnel(): Promise<void> { }
		}

		function makeRemoteTunnel(host: string, port: number, localPort: number): RemoteTunnel {
			return {
				tunnelRemoteHost: host,
				tunnelRemotePort: port,
				tunnelLocalPort: localPort,
				localAddress: `${host === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${localPort}`,
				privacy: TunnelPrivacyId.Private,
				protocol: undefined,
				dispose: async () => { },
			};
		}

		function createModel(storage: InMemoryStorageService): { model: TunnelModel; tunnels: FakeTunnelService } {
			const tunnels = new FakeTunnelService();
			const model = store.add(new TunnelModel(
				tunnels,
				storage,
				new TestConfigurationService({ 'remote.restoreForwardedPorts': true }),
				new class extends mock<IWorkbenchEnvironmentService>() { override readonly remoteAuthority = authority; },
				new class extends mock<IRemoteAuthorityResolverService>() { },
				new class extends mock<IWorkspaceContextService>() {
					override getWorkspace(): IWorkspace {
						return { id: 'w', folders: [{ uri: URI.file('/work'), name: 'work', index: 0, toResource: path => URI.file(path) }] };
					}
				},
				new NullLogService(),
				new class extends mock<IDialogService>() { },
				new class extends mock<IExtensionService>() {
					override readonly extensions = [];
					override readonly onDidRegisterExtensions = Event.None;
					override async activateByEvent(): Promise<void> { }
				},
				new MockContextKeyService(),
			));
			store.add(model.configPortsAttributes); // TunnelModel does not register it
			return { model, tunnels };
		}

		const restoreKey = `remote.tunnels.toRestore.${authority}.${hash('/work')}`;

		function storedPorts(storage: InMemoryStorageService): string[] {
			const value = storage.get(restoreKey, StorageScope.PROFILE);
			return value ? summary(JSON.parse(value) as RestorableTunnel[]) : [];
		}

		function unmarkedPorts(storage: InMemoryStorageService): number[] {
			const value = storage.get(restoreKey, StorageScope.PROFILE);
			return value ? (JSON.parse(value) as (RestorableTunnel & { paradisExplicit?: boolean })[]).filter(tunnel => tunnel.paradisExplicit !== true).map(tunnel => tunnel.remotePort) : [];
		}

		test('a forwarded port is restored even if it is ephemeral, a preview or link tunnel is not', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const storage = store.add(new InMemoryStorageService());
			const first = createModel(storage);
			await first.model.restoreForwarded();
			await first.model.forward({ remote: { host: 'localhost', port: 21004 } });
			await first.model.forward({ remote: { host: 'localhost', port: 40000 } }); // forwarded by hand, not listening
			first.tunnels.opened.fire(makeRemoteTunnel('127.0.0.1', 33355, 33355));
			first.tunnels.opened.fire(makeRemoteTunnel('localhost', 3000, 3000));
			await new Promise(resolve => setTimeout(resolve, 2000));

			const forwardedNow = Array.from(first.model.forwarded.values()).map(tunnel => `${tunnel.remotePort}:${TunnelSource[tunnel.source.source]}`).sort();
			const storedBefore = storedPorts(storage);
			first.model.dispose(); // the window closes with the preview still open

			const second = createModel(storage);
			await second.model.restoreForwarded();
			await second.model.forward({ remote: { host: 'localhost', port: 21005 } });
			await new Promise(resolve => setTimeout(resolve, 2000));

			assert.deepStrictEqual({ forwardedNow, storedBefore, reopened: second.tunnels.openedPorts, storedAfter: storedPorts(storage) }, {
				forwardedNow: ['21004:User', '3000:Extension', '33355:Extension', '40000:User'],
				storedBefore: ['127.0.0.1:33355', 'localhost:21004', 'localhost:3000', 'localhost:40000'],
				reopened: [21004, 40000, 21005],
				storedAfter: ['localhost:21004', 'localhost:21005', 'localhost:40000'],
			});
		}));

		test('forwarding a preview or link port from the Ports view makes it a forwarded port that is restored', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const storage = store.add(new InMemoryStorageService());
			const first = createModel(storage);
			await first.model.restoreForwarded();
			first.tunnels.opened.fire(makeRemoteTunnel('127.0.0.1', 33355, 33355));
			first.tunnels.opened.fire(makeRemoteTunnel('localhost', 3000, 3000));
			await new Promise(resolve => setTimeout(resolve, 2000));
			// The Ports view forwards the port the preview already uses.
			await first.model.forward({ remote: { host: '127.0.0.1', port: 33355 } });
			// Reforwarding a row (#787) closes it and forwards again with the row's own source.
			const linkSource = first.model.forwarded.get('localhost:3000')!.source;
			await first.model.close('localhost', 3000, TunnelCloseReason.Other);
			await first.model.forward({ remote: { host: 'localhost', port: 3000 }, source: linkSource });
			await new Promise(resolve => setTimeout(resolve, 2000));

			const forwardedNow = Array.from(first.model.forwarded.values()).map(tunnel => `${tunnel.remotePort}:${TunnelSource[tunnel.source.source]}:${paradisIsImplicitTunnelSource(tunnel.source)}`).sort();
			first.model.dispose();

			const second = createModel(storage);
			await second.model.restoreForwarded();
			assert.deepStrictEqual({ forwardedNow, reopened: second.tunnels.openedPorts }, {
				forwardedNow: ['3000:User:false', '33355:User:false'],
				reopened: [33355, 3000],
			});
		}));

		test('old records: fixed ports are restored, ephemeral ports are not and fall out on the next save, which marks the rest', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const storage = store.add(new InMemoryStorageService());
			// What a window saved before this change: every tunnel as "User Forwarded".
			storage.store(restoreKey, JSON.stringify([
				record('localhost', 21004, UserTunnelSource, 65459),
				record('127.0.0.1', 33355, UserTunnelSource),
				record('localhost', 60605, UserTunnelSource),
				record('localhost', 3000, UserTunnelSource),
			]), StorageScope.PROFILE, StorageTarget.USER);

			const reopened = createModel(storage);
			await reopened.model.restoreForwarded();
			await reopened.model.forward({ remote: { host: 'localhost', port: 21005 } });
			await new Promise(resolve => setTimeout(resolve, 2000));

			assert.deepStrictEqual({ reopened: reopened.tunnels.openedPorts, stored: storedPorts(storage), unmarkedAfter: unmarkedPorts(storage) }, {
				reopened: [21004, 3000, 21005],
				stored: ['localhost:21004', 'localhost:21005', 'localhost:3000'],
				unmarkedAfter: [],
			});
		}));
	});
});

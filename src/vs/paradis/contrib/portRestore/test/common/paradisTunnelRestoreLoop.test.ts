/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
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
import { paradisDeferTunnelStoreWhileRestoring, paradisRestoreTunnelsOneByOne } from '../../../../../platform/tunnel/common/paradisTunnelRestoreLoop.js';
import { ITunnelService, RemoteTunnel, TunnelPrivacyId } from '../../../../../platform/tunnel/common/tunnel.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { RestorableTunnel, TunnelCloseReason, TunnelModel, UserTunnelSource } from '../../../../../workbench/services/remote/common/tunnelModel.js';

const authority = 'ssh-remote+example';

suite('paradisTunnelRestoreLoop', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** How opening the tunnel to a remote port goes: it throws, hands an error back, or takes a while. */
	type Outcome = 'throws' | 'error' | { readonly delayMs: number };

	class FakeTunnelService extends mock<ITunnelService>() {
		override readonly onTunnelOpened = Event.None;
		override readonly onTunnelClosed = Event.None;
		override readonly tunnels = Promise.resolve([]);
		override readonly canElevate = false;
		readonly openedPorts: number[] = [];
		constructor(private readonly _outcomes: ReadonlyMap<number, Outcome>) {
			super();
		}
		override async openTunnel(_addressProvider: unknown, remoteHost: string | undefined, remotePort: number, _localHost?: string, localPort?: number): Promise<RemoteTunnel | string | undefined> {
			this.openedPorts.push(remotePort);
			const outcome = this._outcomes.get(remotePort);
			if (outcome === 'throws') {
				throw new Error('Could not create tunnel');
			} else if (outcome === 'error') {
				return 'the port is not available';
			} else if (outcome) {
				await timeout(outcome.delayMs);
			}
			return {
				tunnelRemoteHost: remoteHost ?? 'localhost',
				tunnelRemotePort: remotePort,
				tunnelLocalPort: localPort ?? remotePort,
				localAddress: `localhost:${localPort ?? remotePort}`,
				privacy: TunnelPrivacyId.Private,
				protocol: undefined,
				dispose: async () => { },
			};
		}
		override async closeTunnel(): Promise<void> { }
	}

	function createModel(storage: InMemoryStorageService, outcomes: ReadonlyMap<number, Outcome>): { model: TunnelModel; tunnels: FakeTunnelService } {
		const tunnels = new FakeTunnelService(outcomes);
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

	function save(storage: InMemoryStorageService, ports: readonly number[]): void {
		const records = ports.map(port => ({
			remoteHost: 'localhost',
			remotePort: port,
			localPort: port,
			localAddress: `localhost:${port}`,
			localUri: URI.parse(`http://localhost:${port}`),
			protocol: 'http' as RestorableTunnel['protocol'],
			source: UserTunnelSource,
			paradisExplicit: true,
		}));
		storage.store(restoreKey, JSON.stringify(records), StorageScope.PROFILE, StorageTarget.USER);
	}

	function storedPorts(storage: InMemoryStorageService): number[] {
		const value = storage.get(restoreKey, StorageScope.PROFILE);
		return value ? (JSON.parse(value) as RestorableTunnel[]).map(tunnel => tunnel.remotePort).sort() : [];
	}

	function forwardedPorts(model: TunnelModel): number[] {
		return Array.from(model.forwarded.values()).map(tunnel => tunnel.remotePort).sort();
	}

	test('a port that cannot be restored does not keep the others from coming back, nor later forwards from working', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const storage = store.add(new InMemoryStorageService());
		save(storage, [3000, 3001, 3002, 3003, 3004]);
		const { model, tunnels } = createModel(storage, new Map<number, Outcome>([[3001, 'throws'], [3003, 'error']]));

		await model.restoreForwarded();
		const restored = forwardedPorts(model);
		// Without the restore being reported as complete, this forward would wait forever.
		await model.forward({ remote: { host: 'localhost', port: 4000 } });
		await timeout(2000);

		assert.deepStrictEqual({ tried: tunnels.openedPorts, restored, forwarded: forwardedPorts(model), stored: storedPorts(storage) }, {
			tried: [3000, 3001, 3002, 3003, 3004, 4000],
			restored: [3000, 3002, 3004],
			forwarded: [3000, 3002, 3004, 4000],
			stored: [3000, 3002, 3004, 4000],
		});
	}));

	test('the saved list stays whole while the restore runs, and is saved again when it is done', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const storage = store.add(new InMemoryStorageService());
		save(storage, [3000, 3001, 3002]);
		// The second port takes longer than the delay of the save that the first one schedules.
		const { model } = createModel(storage, new Map<number, Outcome>([[3001, { delayMs: 5000 }]]));

		const restoring = model.restoreForwarded();
		await timeout(3000);
		const midway = { forwarded: forwardedPorts(model), stored: storedPorts(storage) };
		await restoring;
		// A port closed after the restore is saved as before.
		await model.close('localhost', 3002, TunnelCloseReason.Other);
		await timeout(2000);

		assert.deepStrictEqual({ midway, forwarded: forwardedPorts(model), stored: storedPorts(storage) }, {
			midway: { forwarded: [3000], stored: [3000, 3001, 3002] },
			forwarded: [3000, 3001],
			stored: [3000, 3001],
		});
	}));

	test('a save put off during overlapping restores is made up for once, after the last one', async () => {
		const owner = {};
		const events: string[] = [];
		const record = (port: number) => ({ remoteHost: 'localhost', remotePort: port });
		const storeNow = () => { events.push(paradisDeferTunnelStoreWhileRestoring(owner) ? 'store deferred' : 'store'); };

		const idle = new Promise<void>(resolve => setTimeout(resolve, 0));
		const first = paradisRestoreTunnelsOneByOne(owner, [record(1), record(2)], async tunnel => {
			events.push(`first ${tunnel.remotePort}`);
			storeNow();
			await idle;
		}, new NullLogService(), storeNow);
		const second = paradisRestoreTunnelsOneByOne(owner, [record(3)], async tunnel => {
			events.push(`second ${tunnel.remotePort}`);
			await first;
			events.push('second done');
		}, new NullLogService(), storeNow);
		await Promise.all([first, second]);

		// A restore during which nothing asked for a save does not save either.
		await paradisRestoreTunnelsOneByOne(owner, [record(4)], async () => { events.push('third'); }, new NullLogService(), storeNow);

		assert.deepStrictEqual(events, ['first 1', 'store deferred', 'second 3', 'first 2', 'store deferred', 'second done', 'store', 'third']);
	});
});

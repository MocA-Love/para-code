/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAddress, IAddressProvider } from '../../../remote/common/remoteAgentConnection.js';
import { RemoteConnectionType } from '../../../remote/common/remoteAuthorityResolver.js';
import { ISharedTunnelsService, RemoteTunnel, TunnelPrivacyId } from '../../common/tunnel.js';
import { ParadisSharedProcessTunnelService } from '../../node/paradisSharedProcessTunnelService.js';

const authority = 'ssh-remote+box';

/** The address of a window: each window reaches the remote agent through a local port of its own. */
function address(port: number): IAddress {
	return { connectTo: { type: RemoteConnectionType.WebSocket, host: '127.0.0.1', port }, connectionToken: undefined };
}

/**
 * The part of the shared process's tunnel service these tests need: one tunnel per remote port,
 * which keeps the address provider it was created with. A later request for the same port gets a
 * lease of that tunnel, and its provider is not looked at (as in `retainOrCreateTunnel`).
 */
class FakeSharedTunnelsService extends mock<ISharedTunnelsService>() {
	private readonly _entries = new Map<number, { provider: IAddressProvider; host: string; refcount: number }>();
	private readonly _carried = new Map<number, number>();
	failNext = false;

	override async openTunnel(_authority: string, addressProvider: IAddressProvider | undefined, remoteHost: string | undefined, remotePort: number): Promise<RemoteTunnel | string | undefined> {
		if (this.failNext) {
			this.failNext = false;
			return undefined;
		}
		let entry = this._entries.get(remotePort);
		if (entry) {
			entry.refcount++;
		} else {
			entry = { provider: addressProvider!, host: remoteHost ?? 'localhost', refcount: 1 + (this._carried.get(remotePort) ?? 0) };
			this._carried.delete(remotePort);
			this._entries.set(remotePort, entry);
		}
		return {
			tunnelRemoteHost: entry.host,
			tunnelRemotePort: remotePort,
			tunnelLocalPort: remotePort,
			localAddress: `localhost:${remotePort}`,
			privacy: TunnelPrivacyId.Private,
			protocol: undefined,
			dispose: async () => {
				const current = this._entries.get(remotePort);
				if (current && --current.refcount === 0) {
					this._entries.delete(remotePort);
				}
			},
		};
	}

	/** Drops the tunnel while windows still hold leases of it, as the Ports view's "Reforward" does. */
	forceClose(remotePort: number): void {
		// The next tunnel to the port takes the open leases over (see `ParadisNodeTunnelService`).
		this._carried.set(remotePort, this._entries.get(remotePort)?.refcount ?? 0);
		this._entries.delete(remotePort);
	}

	/** The local port of the window the tunnel to `remotePort` would connect through now, or 'waiting' while it has no address. */
	async dials(remotePort: number): Promise<number | 'waiting' | 'no tunnel'> {
		const entry = this._entries.get(remotePort);
		if (!entry) {
			return 'no tunnel';
		}
		const resolved = await Promise.race([entry.provider.getAddress(), new Promise<undefined>(resolve => setTimeout(resolve, 0))]);
		return resolved && resolved.connectTo.type === RemoteConnectionType.WebSocket ? resolved.connectTo.port : 'waiting';
	}
}

suite('ParadisSharedProcessTunnelService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): { service: ParadisSharedProcessTunnelService; tunnels: FakeSharedTunnelsService } {
		const tunnels = new FakeSharedTunnelsService();
		return { service: store.add(new ParadisSharedProcessTunnelService(tunnels, new NullLogService())), tunnels };
	}

	/** What a window does to forward a port, up to (not including) sending its address. */
	async function forward(service: ParadisSharedProcessTunnelService, remotePort: number, remoteHost = 'localhost'): Promise<string> {
		const { id } = await service.createTunnel();
		await service.startTunnel(authority, id, remoteHost, remotePort, '127.0.0.1', remotePort, false);
		return id;
	}

	test('the tunnel connects through the window that sent its address last, among those that still forward the port', async () => {
		const { service, tunnels } = createService();
		const actual: Record<string, number | string> = {};

		const a = await forward(service, 3000);
		actual['before any address'] = await tunnels.dials(3000);
		await service.setAddress(a, address(1));
		actual['A sent'] = await tunnels.dials(3000);

		const b = await forward(service, 3000, '127.0.0.1');
		actual['B forwards the same port'] = await tunnels.dials(3000);
		await service.setAddress(b, address(2));
		actual['B sent'] = await tunnels.dials(3000);

		await service.setAddress(a, address(3));
		actual['A reconnected'] = await tunnels.dials(3000);

		// A, whose address provider the tunnel was created with, goes away.
		await service.destroyTunnel(a);
		actual['A stopped forwarding'] = await tunnels.dials(3000);

		const c = await forward(service, 3000);
		await service.setAddress(c, address(4));
		await service.destroyTunnel(c);
		actual['C came and went'] = await tunnels.dials(3000);

		// Another port of the same remote is not affected by any of this.
		const other = await forward(service, 3001);
		actual['other port'] = await tunnels.dials(3001);
		await service.destroyTunnel(other);

		await service.destroyTunnel(b);
		actual['B stopped forwarding'] = await tunnels.dials(3000);

		assert.deepStrictEqual(actual, {
			'before any address': 'waiting',
			'A sent': 1,
			'B forwards the same port': 1,
			'B sent': 2,
			'A reconnected': 3,
			'A stopped forwarding': 2,
			'C came and went': 2,
			'other port': 'waiting',
			'B stopped forwarding': 'no tunnel',
		});
	});

	test('a window that leaves before the others have sent an address is not dialled any more', async () => {
		const { service, tunnels } = createService();
		const a = await forward(service, 3000);
		await service.setAddress(a, address(1));
		const b = await forward(service, 3000);
		await service.destroyTunnel(a);
		const beforeBSent = await tunnels.dials(3000);
		await service.setAddress(b, address(2));

		assert.deepStrictEqual({ beforeBSent, afterBSent: await tunnels.dials(3000) }, { beforeBSent: 'waiting', afterBSent: 2 });
		await service.destroyTunnel(b);
	});

	test('after the tunnel was closed for every window and forwarded again, it still follows the windows that hold the port', async () => {
		const { service, tunnels } = createService();
		const a = await forward(service, 3000);
		await service.setAddress(a, address(1));
		const b = await forward(service, 3000);
		await service.setAddress(b, address(2));

		// B reforwards: the tunnel is dropped for every window and B forwards the port again.
		tunnels.forceClose(3000);
		const b2 = await forward(service, 3000);
		const beforeB2Sent = await tunnels.dials(3000);
		await service.setAddress(b2, address(3));
		const afterB2Sent = await tunnels.dials(3000);
		await service.destroyTunnel(b);
		await service.destroyTunnel(b2);

		assert.deepStrictEqual({ beforeB2Sent, afterB2Sent, afterBLeft: await tunnels.dials(3000) }, { beforeB2Sent: 2, afterB2Sent: 3, afterBLeft: 1 });
		await service.destroyTunnel(a);
	});

	test('a tunnel that could not be created, or was given up while it started, leaves nothing behind', async () => {
		const { service, tunnels } = createService();
		const a = await forward(service, 3000);
		await service.setAddress(a, address(1));

		tunnels.failNext = true;
		const failed = await service.createTunnel();
		const failure = await service.startTunnel(authority, failed.id, 'localhost', 3000, '127.0.0.1', 3000, false).then(() => 'started', (error: Error) => error.message);

		const givenUp = await service.createTunnel();
		await service.destroyTunnel(givenUp.id);
		const cancelled = await service.startTunnel(authority, givenUp.id, 'localhost', 3000, '127.0.0.1', 3000, false).then(() => 'started', (error: Error) => error.name);
		await service.setAddress(givenUp.id, address(9));
		await service.setAddress(failed.id, address(9));

		assert.deepStrictEqual({ failure, cancelled, dials: await tunnels.dials(3000) }, { failure: 'Could not create tunnel', cancelled: 'Canceled', dials: 1 });
		await service.destroyTunnel(a);
		assert.strictEqual(await tunnels.dials(3000), 'no tunnel');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAddress, IAddressProvider } from '../../../remote/common/remoteAgentConnection.js';
import { IRemoteSocketFactoryService } from '../../../remote/common/remoteSocketFactoryService.js';
import { IMessage, ISignService } from '../../../sign/common/sign.js';
import { RemoteTunnel } from '../../common/tunnel.js';
import { ParadisSharedTunnelsService } from '../../node/paradisSharedTunnelsService.js';

suite('ParadisSharedTunnelsService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): ParadisSharedTunnelsService {
		const remoteSocketFactoryService: IRemoteSocketFactoryService = {
			_serviceBrand: undefined,
			connect() { throw new Error('should not be reached'); },
			register() { throw new Error('should not be reached'); },
		};
		const signService: ISignService = {
			_serviceBrand: undefined,
			async createNewMessage(value: string): Promise<IMessage> { return { id: 'test', data: value }; },
			async validate(): Promise<boolean> { return true; },
			async sign(value: string): Promise<string> { return value; },
		};
		const productService = { _serviceBrand: undefined } as IProductService;
		return new ParadisSharedTunnelsService(remoteSocketFactoryService, new NullLogService(), productService, signService, new TestConfigurationService());
	}

	/** Nothing in these tests dials the remote, so the address is never asked for. */
	const addressProvider: IAddressProvider = { getAddress: (): Promise<IAddress> => Promise.reject(new Error('no remote agent')) };

	async function open(service: ParadisSharedTunnelsService): Promise<RemoteTunnel> {
		const tunnel = await service.openTunnel('ssh-remote+box', addressProvider, 'localhost', 45124, '127.0.0.1');
		assert.ok(tunnel && typeof tunnel !== 'string');
		return tunnel;
	}

	/**
	 * Waits until the kept references of a force-closed tunnel have expired, with a wide margin over
	 * {@link ParadisSharedTunnelsService.carriedReferencesTimeoutMs} so a slow CI machine does not fire
	 * this wait first. Once the expiry timer has run, letting go of the per-authority service only
	 * awaits settled promises, so it is done before this longer timer fires.
	 */
	function waitPastCarriedReferencesTimeout(service: ParadisSharedTunnelsService): Promise<void> {
		return new Promise<void>(resolve => setTimeout(resolve, Math.max(service.carriedReferencesTimeoutMs * 20, 200)));
	}

	/**
	 * Whether the tunnel's local port is taken, judged by trying to listen on it ourselves.
	 * (Connecting is not a reliable probe here: the tunnel accepts and then resets at once,
	 * because nothing in these tests can reach a remote.)
	 */
	function isListening(tunnel: RemoteTunnel): Promise<boolean> {
		return new Promise(resolve => {
			const probe = net.createServer();
			probe.once('error', () => resolve(true));
			probe.listen(tunnel.tunnelLocalPort!, '127.0.0.1', () => probe.close(() => resolve(false)));
		});
	}

	test('a forced close drops the tunnel for every holder, and a stale lease does not close the new one', async () => {
		const service = createService();
		try {
			// Two windows hold the same shared tunnel.
			const first = await open(service);
			const second = await open(service);
			const shared = first.tunnelLocalPort === second.tunnelLocalPort;

			const closed = await service.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);
			const listeningAfterClose = await isListening(first);

			const fresh = await open(service);
			// The other window releases its reference to the tunnel that was closed under it.
			await second.dispose();
			const freshListeningAfterStaleRelease = await isListening(fresh);
			await fresh.dispose();

			assert.deepStrictEqual(
				{ shared, closed, listeningAfterClose, freshListeningAfterStaleRelease },
				{ shared: true, closed: true, listeningAfterClose: false, freshListeningAfterStaleRelease: true }
			);
			await first.dispose();
		} finally {
			service.dispose();
		}
	});

	test('the reforwarded tunnel keeps the other window\'s reference: it stays after A lets go and closes after B does', async () => {
		const service = createService();
		try {
			const windowA = await open(service);
			const windowB = await open(service);

			// Window A reforwards: it releases its own lease, closes the tunnel for everyone, forwards again.
			await windowA.dispose();
			await service.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);
			const reforwarded = await open(service);
			const listeningAfterReforward = await isListening(reforwarded);

			await reforwarded.dispose();
			const listeningAfterALetGo = await isListening(reforwarded);

			await windowB.dispose();
			const listeningAfterBLetGo = await isListening(reforwarded);

			assert.deepStrictEqual(
				{ listeningAfterReforward, listeningAfterALetGo, listeningAfterBLetGo },
				{ listeningAfterReforward: true, listeningAfterALetGo: true, listeningAfterBLetGo: false }
			);
		} finally {
			service.dispose();
		}
	});

	test('kept references expire when the reforward never forwards again, so a later forward is not inflated', async () => {
		const service = createService();
		service.carriedReferencesTimeoutMs = 10;
		try {
			const windowA = await open(service);
			const windowB = await open(service);
			await windowA.dispose();
			await service.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);

			// The reforward's forward failed (or its window closed): nothing takes window B's reference.
			await waitPastCarriedReferencesTimeout(service);

			const later = await open(service);
			await later.dispose();
			const listeningAfterLaterLetGo = await isListening(later);
			await windowB.dispose();

			assert.strictEqual(listeningAfterLaterLetGo, false);
		} finally {
			service.dispose();
		}
	});

	test('a lease returned between the forced close and the next forward counts the kept references down', async () => {
		const service = createService();
		try {
			const windowA = await open(service);
			const windowB = await open(service);
			await windowA.dispose();
			await service.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);

			// Window B lets go before window A forwards again.
			await windowB.dispose();
			const reforwarded = await open(service);
			const listeningAfterReforward = await isListening(reforwarded);
			await reforwarded.dispose();
			const listeningAfterALetGo = await isListening(reforwarded);

			assert.deepStrictEqual(
				{ listeningAfterReforward, listeningAfterALetGo },
				{ listeningAfterReforward: true, listeningAfterALetGo: false }
			);
		} finally {
			service.dispose();
		}
	});

	test('the per-authority service is let go of once kept references expire or are returned and no tunnel is left', async () => {
		// The kept references expire: nothing forwards the port again.
		const expiring = createService();
		expiring.carriedReferencesTimeoutMs = 10;
		// The kept reference is returned before anything forwards the port again (the timeout never fires here).
		const returning = createService();
		try {
			const windowA = await open(expiring);
			const windowB = await open(expiring);
			await windowA.dispose();
			await expiring.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);
			await waitPastCarriedReferencesTimeout(expiring);
			const keptAfterExpiry = await expiring.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);
			await windowB.dispose();

			const windowC = await open(returning);
			const windowD = await open(returning);
			await windowC.dispose();
			await returning.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);
			await windowD.dispose();
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			const keptAfterRelease = await returning.forceCloseTunnel('ssh-remote+box', 'localhost', 45124);

			assert.deepStrictEqual({ keptAfterExpiry, keptAfterRelease }, { keptAfterExpiry: false, keptAfterRelease: false });
		} finally {
			expiring.dispose();
			returning.dispose();
		}
	});

	test('a forced close for an unknown remote does nothing', async () => {
		const service = createService();
		try {
			assert.strictEqual(await service.forceCloseTunnel('ssh-remote+none', 'localhost', 45124), false);
		} finally {
			service.dispose();
		}
	});
});

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

	test('a forced close for an unknown remote does nothing', async () => {
		const service = createService();
		try {
			assert.strictEqual(await service.forceCloseTunnel('ssh-remote+none', 'localhost', 45124), false);
		} finally {
			service.dispose();
		}
	});
});

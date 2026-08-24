/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAddressProvider } from '../../../remote/common/remoteAgentConnection.js';
import {
	AbstractTunnelService,
	extractLocalHostUriMetaDataForPortMapping,
	extractQueryLocalHostUriMetaDataForPortMapping,
	getRemoteTunnelGeneration,
	ITunnelProvider,
	RemoteTunnel,
	TunnelCloseEvent
} from '../../common/tunnel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

class TestTunnelService extends AbstractTunnelService {
	override isPortPrivileged(): boolean { return false; }

	protected override retainOrCreateTunnel(
		addressProvider: IAddressProvider | ITunnelProvider,
		remoteHost: string,
		remotePort: number,
		_localHost: string,
		localPort: number | undefined,
		elevateIfNeeded: boolean,
		privacy?: string,
		protocol?: string,
	): Promise<RemoteTunnel | string | undefined> | undefined {
		const existing = this.getTunnelFromMap(remoteHost, remotePort);
		if (existing) {
			existing.refcount++;
			return existing.value;
		}
		return this.createWithProvider(addressProvider as ITunnelProvider, remoteHost, remotePort, localPort, elevateIfNeeded, privacy, protocol);
	}
}

suite('Tunnel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function portMappingDoTest(uri: string,
		func: (uri: URI) => { address: string; port: number } | undefined,
		expectedAddress?: string,
		expectedPort?: number) {
		const res = func(URI.parse(uri));
		assert.strictEqual(!expectedAddress, !res);
		assert.strictEqual(res?.address, expectedAddress);
		assert.strictEqual(res?.port, expectedPort);
	}

	function portMappingTest(uri: string, expectedAddress?: string, expectedPort?: number) {
		portMappingDoTest(uri, extractLocalHostUriMetaDataForPortMapping, expectedAddress, expectedPort);
	}

	function portMappingTestQuery(uri: string, expectedAddress?: string, expectedPort?: number) {
		portMappingDoTest(uri, extractQueryLocalHostUriMetaDataForPortMapping, expectedAddress, expectedPort);
	}

	test('portMapping', () => {
		portMappingTest('file:///foo.bar/baz');
		portMappingTest('http://foo.bar:1234');
		portMappingTest('http://localhost:8080', 'localhost', 8080);
		portMappingTest('https://localhost:443', 'localhost', 443);
		portMappingTest('http://127.0.0.1:3456', '127.0.0.1', 3456);
		portMappingTest('http://0.0.0.0:7654', '0.0.0.0', 7654);
		portMappingTest('http://localhost:8080/path?foo=bar', 'localhost', 8080);
		portMappingTest('http://localhost:8080/path?foo=http%3A%2F%2Flocalhost%3A8081', 'localhost', 8080);
		portMappingTestQuery('http://foo.bar/path?url=http%3A%2F%2Flocalhost%3A8081', 'localhost', 8081);
		portMappingTestQuery('http://foo.bar/path?url=http%3A%2F%2Flocalhost%3A8081&url2=http%3A%2F%2Flocalhost%3A8082', 'localhost', 8081);
		portMappingTestQuery('http://foo.bar/path?url=http%3A%2F%2Fmicrosoft.com%2Fbad&url2=http%3A%2F%2Flocalhost%3A8081', 'localhost', 8081);
	});

	test('keeps the disposed ledger generation on a delayed close event', async () => {
		let oldDisposeStarted!: () => void;
		const oldDisposeStarting = new Promise<void>(resolve => oldDisposeStarted = resolve);
		let releaseOldDispose!: () => void;
		const oldDisposeFinished = new Promise<void>(resolve => releaseOldDispose = resolve);
		const firstTunnel: RemoteTunnel = {
			tunnelRemoteHost: '127.0.0.1', tunnelRemotePort: 56789,
			localAddress: '127.0.0.1:45678', privacy: 'private',
			dispose: async () => { oldDisposeStarted(); await oldDisposeFinished; },
		};
		const secondTunnel: RemoteTunnel = {
			tunnelRemoteHost: '127.0.0.1', tunnelRemotePort: 56789,
			localAddress: '127.0.0.1:45678', privacy: 'private',
			dispose: async () => { },
		};
		let opened = 0;
		const service = new TestTunnelService(new NullLogService(), new TestConfigurationService());
		const provider = service.setTunnelProvider({
			forwardPort: () => Promise.resolve([firstTunnel, secondTunnel][opened++]),
		});
		const closedEvents: TunnelCloseEvent[] = [];
		const closeListener = service.onTunnelClosed(event => closedEvents.push(event));
		try {
			const firstLease = await service.openTunnel(undefined, '127.0.0.1', 56789);
			const retainedLease = await service.openTunnel(undefined, '127.0.0.1', 56789);
			assert.ok(firstLease && typeof firstLease !== 'string');
			assert.ok(retainedLease && typeof retainedLease !== 'string');
			assert.strictEqual(getRemoteTunnelGeneration(firstLease), getRemoteTunnelGeneration(retainedLease));
			await firstLease.dispose();
			const closing = retainedLease.dispose();
			await oldDisposeStarting;
			const secondLease = await service.openTunnel(undefined, '127.0.0.1', 56789);
			assert.ok(secondLease && typeof secondLease !== 'string');
			releaseOldDispose();
			await closing;

			assert.notStrictEqual(getRemoteTunnelGeneration(firstLease), getRemoteTunnelGeneration(secondLease));
			assert.strictEqual(closedEvents[0].generation, getRemoteTunnelGeneration(firstLease));
			assert.notStrictEqual(closedEvents[0].generation, getRemoteTunnelGeneration(secondLease));
			await secondLease.dispose();
		} finally {
			closeListener.dispose();
			provider.dispose();
			await service.dispose();
		}
	});
});

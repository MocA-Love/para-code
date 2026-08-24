/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { getRemoteTunnelGeneration, ITunnelService, RemoteTunnel } from '../../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisRemotePreviewMounter } from '../../electron-browser/paradisHtmlPreviewClient.js';

suite('ParadisRemotePreviewMounter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site' });

	function createMounter(localAddress: string): {
		readonly mounter: ParadisRemotePreviewMounter;
		readonly disposeCount: () => number;
		readonly openCount: () => number;
		readonly closeCurrent: () => void;
	} {
		const store = disposables.add(new DisposableStore());
		const tunnelClosed = store.add(new Emitter<{ host: string; port: number; generation?: object }>());
		let disposed = 0;
		let opened = 0;
		const tunnel = {
			tunnelRemotePort: 56789,
			tunnelRemoteHost: '127.0.0.1',
			tunnelLocalPort: 45678,
			localAddress,
			privacy: 'private',
			dispose: async () => { disposed++; },
		} as RemoteTunnel;
		const agent = {
			getConnection: () => ({
				remoteAuthority: 'ssh-remote+box',
				getChannel: () => ({
					call: async () => ({ port: 56789, token: '0123456789abcdef0123456789abcdef' }),
					listen: () => { throw new Error('not used'); },
				}),
			}),
		} as unknown as IRemoteAgentService;
		const resolver = {
			resolveAuthority: async () => ({
				authority: {
					authority: 'ssh-remote+box',
					connectTo: {},
					connectionToken: undefined,
				},
			}),
		} as unknown as IRemoteAuthorityResolverService;
		const tunnelService = {
			onTunnelClosed: tunnelClosed.event,
			openTunnel: async () => { opened++; return tunnel; },
		} as unknown as ITunnelService;
		return {
			mounter: store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService)),
			disposeCount: () => disposed,
			openCount: () => opened,
			closeCurrent: () => tunnelClosed.fire({
				host: '127.0.0.1',
				port: 56789,
				generation: getRemoteTunnelGeneration(tunnel),
			}),
		};
	}

	test('disposes a non-loopback tunnel exactly once before rejecting it', async () => {
		const fixture = createMounter('0.0.0.0:45678');

		await assert.rejects(fixture.mounter.mount(resource), /not loopback/);
		assert.strictEqual(fixture.disposeCount(), 1);

		fixture.mounter.dispose();
		await Promise.resolve();
		assert.strictEqual(fixture.disposeCount(), 1);
	});

	test('transfers a loopback tunnel to the mounter until its disposal', async () => {
		const fixture = createMounter('127.0.0.1:45678');

		const location = await fixture.mounter.mount(resource);
		assert.strictEqual(location.port, 45678);
		assert.strictEqual(fixture.disposeCount(), 0);

		fixture.mounter.dispose();
		await Promise.resolve();
		assert.strictEqual(fixture.disposeCount(), 1);
	});

	test('keeps a new mounter tunnel when an older generation closes on the same port', async () => {
		const store = disposables.add(new DisposableStore());
		const tunnelClosed = store.add(new Emitter<{ host: string; port: number; generation?: object }>());
		let opened = 0;
		let oldDisposeStarted!: () => void;
		const oldDisposeStarting = new Promise<void>(resolve => oldDisposeStarted = resolve);
		let releaseOldDispose!: () => void;
		const oldDisposeFinished = new Promise<void>(resolve => releaseOldDispose = resolve);
		let newDisposed = 0;
		let duplicateDisposed = 0;
		const oldTunnel = {
			tunnelRemotePort: 56789,
			tunnelRemoteHost: '127.0.0.1',
			tunnelLocalPort: 45678,
			localAddress: '127.0.0.1:45678',
			privacy: 'private',
			dispose: async () => {
				oldDisposeStarted();
				await oldDisposeFinished;
				tunnelClosed.fire({ host: '127.0.0.1', port: 56789, generation: getRemoteTunnelGeneration(oldTunnel) });
			},
		} as RemoteTunnel;
		const newTunnel = {
			tunnelRemotePort: 56789,
			tunnelRemoteHost: '127.0.0.1',
			tunnelLocalPort: 45678,
			localAddress: '127.0.0.1:45678',
			privacy: 'private',
			dispose: async () => { newDisposed++; },
		} as RemoteTunnel;
		const duplicateTunnel = {
			tunnelRemotePort: 56789,
			tunnelRemoteHost: '127.0.0.1',
			tunnelLocalPort: 45678,
			localAddress: '127.0.0.1:45678',
			privacy: 'private',
			dispose: async () => { duplicateDisposed++; },
		} as RemoteTunnel;
		const agent = {
			getConnection: () => ({
				remoteAuthority: 'ssh-remote+box',
				getChannel: () => ({
					call: async () => ({ port: 56789, token: '0123456789abcdef0123456789abcdef' }),
					listen: () => { throw new Error('not used'); },
				}),
			}),
		} as unknown as IRemoteAgentService;
		const resolver = {
			resolveAuthority: async () => ({
				authority: {
					authority: 'ssh-remote+box',
					connectTo: {},
					connectionToken: undefined,
				},
			}),
		} as unknown as IRemoteAuthorityResolverService;
		const tunnelService = {
			onTunnelClosed: tunnelClosed.event,
			openTunnel: async () => [oldTunnel, newTunnel, duplicateTunnel][opened++],
		} as unknown as ITunnelService;
		const oldMounter = store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService));
		const newMounter = store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService));

		await oldMounter.mount(resource);
		oldMounter.dispose();
		await oldDisposeStarting;
		await newMounter.mount(resource);
		releaseOldDispose();
		await Promise.resolve();
		await Promise.resolve();

		await newMounter.mount(resource);
		assert.strictEqual(opened, 2);

		newMounter.dispose();
		await Promise.resolve();
		assert.strictEqual(newDisposed, 1);
		assert.strictEqual(duplicateDisposed, 0);
	});

	test('drops the current generation so the next mount reopens it', async () => {
		const fixture = createMounter('127.0.0.1:45678');
		await fixture.mounter.mount(resource);
		fixture.closeCurrent();
		await Promise.resolve();
		await Promise.resolve();
		await fixture.mounter.mount(resource);
		assert.strictEqual(fixture.openCount(), 2);
	});
});

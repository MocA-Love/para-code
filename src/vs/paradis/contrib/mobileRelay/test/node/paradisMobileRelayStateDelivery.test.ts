/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { generateMobileIdentity, SecureChannel } from '../../common/paradisMobileCrypto.js';
import { FrameMux } from '../../common/paradisMobileMux.js';
import { IParadisMobileRendererManifest } from '../../common/paradisMobileWindowLease.js';
import { MobileSession, ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { ParadisMobileStateDelivery } from '../../node/paradisMobileStateDelivery.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

suite('ParadisMobileRelay State delivery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('全体broadcastだけを抑制し宛先指定Stateは毎回送る', async () => {
		const delivered: number[][] = [];
		const delivery = new ParadisMobileStateDelivery();
		const session = {
			isOnline: true,
			sendDesktopState: (payload: Uint8Array, force: boolean) => delivery.deliver(payload, force, async state => {
				delivered.push([...state]);
			}),
		};
		const manifest: IParadisMobileRendererManifest = { revision: 1, entries: [] };
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			desktopStateBroadcastChain: Promise.resolve(),
			windowLeaseClient: { manifest: async () => manifest },
			terminalRegistry: new ParadisMobileTerminalRegistry('test-desktop'),
			sessions: new Map([['mobile', session]]),
			logService: new NullLogService(),
		}) as unknown as { broadcastDesktopState(mobileId?: string): Promise<void> };

		await service.broadcastDesktopState();
		await service.broadcastDesktopState();
		assert.strictEqual(delivered.length, 1);

		await service.broadcastDesktopState('mobile');
		await service.broadcastDesktopState('mobile');
		assert.strictEqual(delivered.length, 3);
		assert.deepStrictEqual(delivered[0], delivered[1]);
		assert.deepStrictEqual(delivered[1], delivered[2]);
	});

	test('同じWindow State同期は自発送信せず内容変更だけを送る', async () => {
		const delivered: number[][] = [];
		const delivery = new ParadisMobileStateDelivery();
		const session = {
			isOnline: true,
			sendDesktopState: (payload: Uint8Array, force: boolean) => delivery.deliver(payload, force, async state => {
				delivered.push([...state]);
			}),
		};
		const manifest: IParadisMobileRendererManifest = {
			revision: 1,
			entries: [{ windowId: 1, windowSession: 'session', rendererGeneration: 1, windowRevision: 1, claimed: true }],
		};
		const registry = new ParadisMobileTerminalRegistry('test-desktop');
		registry.reconcile(manifest);
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			desktopStateBroadcastChain: Promise.resolve(),
			windowLeaseClient: { manifest: async () => manifest },
			terminalRegistry: registry,
			sessions: new Map([['mobile', session]]),
			logService: new NullLogService(),
		}) as unknown as { broadcastDesktopState(mobileId?: string): Promise<void> };
		const initialState = {
			activeWs: undefined,
			workspaces: [],
			terminals: [{ terminalKey: 'terminal', id: 1, title: 'Before' }],
		};

		registry.syncWindow(1, 'session', 1, initialState);
		await service.broadcastDesktopState();
		registry.syncWindow(1, 'session', 1, initialState);
		await service.broadcastDesktopState();
		assert.strictEqual(delivered.length, 1);

		registry.syncWindow(1, 'session', 1, {
			...initialState,
			terminals: [{ terminalKey: 'terminal', id: 1, title: 'After' }],
		});
		await service.broadcastDesktopState();
		assert.strictEqual(delivered.length, 2);
	});

	test('32バイトhelloによる暗号セッションreset後は同じStateを再送する', async () => {
		const pcIdentity = await generateMobileIdentity();
		const mobileIdentity = await generateMobileIdentity();
		const freshEphemeral = await generateMobileIdentity();
		const delivered: number[][] = [];
		const session = new MobileSession(
			'mobile',
			new Uint8Array(16),
			mobileIdentity.publicKey,
			pcIdentity,
			() => { },
			() => { },
			undefined,
			new NullLogService(),
		);
		const mux = {
			send: async (_channel: number, payload: Uint8Array) => { delivered.push([...payload]); },
			receive: async () => { throw new Error('old session cannot decrypt fresh hello'); },
		} as unknown as FrameMux;
		const access = session as unknown as {
			channel: SecureChannel | undefined;
			mux: FrameMux | undefined;
			confirmed: boolean;
		};
		Object.assign(access, { channel: {} as SecureChannel, mux, confirmed: true });
		const payload = Uint8Array.of(1, 2, 3);

		assert.strictEqual(await session.sendDesktopState(payload, false), true);
		await session.enqueuePayload(freshEphemeral.publicKey);
		Object.assign(access, { mux, confirmed: true });
		assert.strictEqual(await session.sendDesktopState(payload, false), true);
		assert.deepStrictEqual(delivered, [[1, 2, 3], [1, 2, 3]]);
	});
});

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
			() => true,
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

	test('確立済みのモバイルが古いセッションで送ってきたら、やり直しを促して自分の状態も畳む', async () => {
		// 32B分岐は「PCが古い・モバイルが新しい」方向しか救えない。本番で起きているのは逆で、
		// PC側にセッションが無いのにモバイルは確立済みのつもりで sealed frame を送ってくる。
		// PCから知らせる手段が無いとモバイルは黙って詰まる（受信は続くので死活監視も効かない）。
		const pcIdentity = await generateMobileIdentity();
		const mobileIdentity = await generateMobileIdentity();
		const sent: Uint8Array[] = [];
		const session = new MobileSession(
			'mobile',
			new Uint8Array(16),
			mobileIdentity.publicKey,
			pcIdentity,
			payload => { sent.push(payload); return true; },
			() => { },
			undefined,
			new NullLogService(),
		);
		const access = session as unknown as { channel: SecureChannel | undefined; confirmed: boolean };
		// hello(32B) ではない長さ = 封緘フレーム。未確立のPCはこれを hello と誤解して落ちる。
		const sealedFrame = new Uint8Array(57);

		await session.enqueuePayload(sealedFrame);
		await session.enqueuePayload(sealedFrame);

		assert.deepStrictEqual({
			// 送るのは1回だけ。毎フレーム返すと再接続ループになる。
			markers: sent.length,
			// 32Bにすると、逆流したときにPC側の32B自己回復と紛れる。
			isNot32Bytes: sent[0]?.length !== 32,
			// 封緘フレームの最小長(12+8+16=36)未満なら、鍵の状態に関係なく必ず復号に失敗する。
			failsToDecrypt: (sent[0]?.length ?? 0) < 36,
			channelCleared: access.channel === undefined,
			confirmedCleared: access.confirmed,
		}, {
			markers: 1,
			isNot32Bytes: true,
			failsToDecrypt: true,
			channelCleared: true,
			confirmedCleared: false,
		});
	});

	test('切断レポートにはクリア前のモバイルセッション数を記録する', () => {
		const reports: { readonly extras: Record<string, unknown> }[] = [];
		const stopped: string[] = [];
		const dropped: string[] = [];
		let voiceSubscriptionsCleared = false;
		const sessions = new Map<string, object>([['mobile-1', {}], ['mobile-2', {}]]);
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			sessions,
			webrtcRendererLeases: new Map(),
			// handleDisconnected が畳む対象はここに揃えておくこと。足りないと
			// 「clear が undefined」で落ちるだけで、何が欠けたのかは分からない。
			voiceSubscriptions: { clear: () => { voiceSubscriptionsCleared = true; } },
			enabled: true,
			connectionState: 'online',
			reconnectAttempt: 0,
			relayUrlOverride: undefined,
			keepaliveAcknowledged: true,
			consecutiveKeepaliveTimeouts: 0,
			browserMirror: { stopSession: (id: string) => stopped.push(id) },
			agentChat: { dropSubscriber: (id: string) => dropped.push(id) },
			disconnectReporter: { arm: (_operation: string, _message: string, extras: Record<string, unknown>) => reports.push({ extras }) },
			setConnectionState: () => { },
			scheduleReconnect: () => { },
		}) as unknown as {
			handleDisconnected(operation: string, message: string, extras: Record<string, unknown>): void;
		};

		service.handleDisconnected('test-disconnect', 'test disconnect', {});

		assert.deepStrictEqual({
			safeMobileSessions: reports[0]?.extras['safe_mobile_sessions'],
			remainingSessions: sessions.size,
			voiceSubscriptionsCleared,
			stopped,
			dropped,
		}, {
			safeMobileSessions: 2,
			remainingSessions: 0,
			voiceSubscriptionsCleared: true,
			stopped: ['mobile-1', 'mobile-2'],
			dropped: ['mobile-1', 'mobile-2'],
		});
	});
});

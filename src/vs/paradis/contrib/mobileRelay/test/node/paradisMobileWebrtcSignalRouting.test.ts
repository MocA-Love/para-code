/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame } from '../../common/paradisMobileRelay.js';
import { IParadisMobileWindowLease } from '../../common/paradisMobileWindowLease.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';

type Signal = { t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop'; targetId?: string; sid: string; id?: string };

suite('ParadisMobileRelayService WebRTC signal routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 写しの WebRTC の転送（forwardWebrtcSignal）だけを動かす。arm は呼び出し側が終わらせる。 */
	function createService() {
		const owner: IParadisMobileWindowLease = { windowId: 1, windowSession: 'w', rendererGeneration: 1 };
		const delivered: string[] = [];
		const arms: DeferredPromise<void>[] = [];
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			webrtcRendererLeases: new Map(),
			browserMirror: { setFramesPaused: () => { } },
			resolveWebrtcOwner: async () => owner,
			cdpFrames: {
				armMirrorCapture: () => {
					const arm = new DeferredPromise<void>();
					arms.push(arm);
					return arm.p;
				},
				disarmMirrorCapture: async () => { },
			},
			terminalRegistry: { leaseOfWindow: () => owner },
			withCurrentRegisteredLease: async (_lease: IParadisMobileWindowLease, task: () => Promise<unknown>) => task(),
			_onInboundFrame: {
				fire: (wire: readonly unknown[]) => {
					const body = JSON.parse((wire[3] as VSBuffer).toString()) as Signal;
					delivered.push(`${body.t}:${body.sid}`);
				},
			},
			logService: new NullLogService(),
		}) as unknown as { forwardWebrtcSignal(mobileId: string, frame: IParadisMobileInboundFrame, signal: Signal): Promise<void> };
		const send = (signal: Signal) => service.forwardWebrtcSignal('m', { ch: Channels.Browser, ws: undefined, seq: 0, payload: VSBuffer.fromString(JSON.stringify(signal)), mobileId: 'm' }, signal);
		return { send, delivered, arms };
	}

	test('ICE that arrives while the offer waits for the capture reservation follows the offer', async () => {
		const { send, delivered, arms } = createService();
		const offer = send({ t: 'webrtc-offer', targetId: 't', sid: 's1', id: 'o1' });
		await new Promise(resolve => setTimeout(resolve, 0));
		await send({ t: 'webrtc-ice', sid: 's1' });
		arms[0].complete();
		await offer;
		await send({ t: 'webrtc-ice', sid: 's1' });
		assert.deepStrictEqual(delivered, ['webrtc-offer:s1', 'webrtc-ice:s1', 'webrtc-ice:s1']);
	});

	test('a late ICE or stop of the previous session does not cut off the current one', async () => {
		const { send, delivered, arms } = createService();
		const offer = send({ t: 'webrtc-offer', targetId: 't', sid: 's2', id: 'o2' });
		await new Promise(resolve => setTimeout(resolve, 0));
		arms[0].complete();
		await offer;
		await send({ t: 'webrtc-ice', sid: 's1' });
		await send({ t: 'webrtc-stop', sid: 's1' });
		await send({ t: 'webrtc-ice', sid: 's2' });
		assert.deepStrictEqual(delivered, ['webrtc-offer:s2', 'webrtc-ice:s2']);
	});
});

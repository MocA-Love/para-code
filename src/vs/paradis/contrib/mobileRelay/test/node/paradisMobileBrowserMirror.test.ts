/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCdpFrameEvent, IParadisCdpFrameSubscription } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../../agentBrowser/node/paradisCdpUpstream.js';
import { ParadisMobileBrowserMirror } from '../../node/paradisMobileBrowserMirror.js';

suite('ParadisMobileBrowserMirror', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('同じpush JPEGを一度だけ送り重複通知も購読生存として扱う', () => {
		const frames = store.add(new Emitter<IParadisCdpFrameEvent>());
		const subscription: IParadisCdpFrameSubscription = {
			onDidFrame: frames.event,
			startFrameSubscription: async () => true,
			stopFrameSubscription: async () => undefined,
			resolveTargetWindowId: async () => 1,
			armMirrorCapture: async () => undefined,
		};
		const delivered: Uint8Array[] = [];
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(
			new ParadisCdpUpstream('', logService),
			subscription,
			undefined,
			logService,
		));
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a',
			nextId: 1,
			viewWidth: 0,
			viewHeight: 0,
			captureTimer: undefined,
			captureInFlight: false,
			lastFrameData: undefined,
			handlers: new Map(),
			pushMode: true,
			pushStarted: false,
			lastPushFrameAt: 0,
			lastMetricsAt: 0,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { sessions: Map<string, typeof session> }).sessions.set('mobile', session);
		const jpeg = 'A'.repeat(128 * 1024);

		frames.fire({ targetId: 'target-a', data: jpeg, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 1);
		const deliveredBytes = delivered[0].byteLength;
		session.lastPushFrameAt = 0;
		for (let i = 1; i < 60; i++) {
			frames.fire({ targetId: 'target-a', data: jpeg, w: 1200, h: 800 });
		}

		assert.strictEqual(delivered.length, 1);
		assert.strictEqual(delivered.reduce((sum, payload) => sum + payload.byteLength, 0), deliveredBytes);
		assert.ok(session.lastPushFrameAt > 0);

		frames.fire({ targetId: 'target-a', data: `${jpeg}B`, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 2);
		assert.strictEqual(JSON.parse(new TextDecoder().decode(delivered[1])).data, `${jpeg}B`);

		frames.fire({ targetId: 'target-b', data: `${jpeg}C`, w: 1200, h: 800 });
		session.pushMode = false;
		frames.fire({ targetId: 'target-a', data: `${jpeg}D`, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 2);
	});

	test('明示要求したセッションだけJPEGを可逆なbinary v1で送る', async () => {
		const frames = store.add(new Emitter<IParadisCdpFrameEvent>());
		const subscription: IParadisCdpFrameSubscription = {
			onDidFrame: frames.event,
			startFrameSubscription: async () => true,
			stopFrameSubscription: async () => undefined,
			resolveTargetWindowId: async () => 1,
			armMirrorCapture: async () => undefined,
		};
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(
			new ParadisCdpUpstream('', logService),
			subscription,
			undefined,
			logService,
		));

		const negotiated: Array<boolean | undefined> = [];
		(mirror as unknown as { start: (mobileId: string, targetId: string, send: (payload: Uint8Array) => void, binaryFrames?: boolean) => Promise<void> }).start
			= async (_mobileId, _targetId, _send, binaryFrames) => { negotiated.push(binaryFrames); };
		const replies: Uint8Array[] = [];
		await mirror.handleRequest('new-mobile', new TextEncoder().encode(JSON.stringify({
			t: 'start', id: 'new', targetId: 'target-a', frameEncoding: 'jpeg-binary-v1',
		})), payload => replies.push(payload));
		await mirror.handleRequest('old-mobile', new TextEncoder().encode(JSON.stringify({
			t: 'start', id: 'old', targetId: 'target-a',
		})), payload => replies.push(payload));
		assert.deepStrictEqual(negotiated, [true, false]);
		assert.deepStrictEqual(replies.map(payload => JSON.parse(new TextDecoder().decode(payload)).t), ['started', 'started']);

		const delivered: Uint8Array[] = [];
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a', nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
			handlers: new Map(), pushMode: true, pushStarted: false,
			lastPushFrameAt: 0, lastMetricsAt: 0, binaryFrames: true,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { sessions: Map<string, typeof session> }).sessions.set('new-mobile', session);
		const jpegBase64 = '/9gAAX+A/v/Z';
		frames.fire({ targetId: 'target-a', data: jpegBase64, w: 1200, h: 800 });

		assert.strictEqual(delivered.length, 1);
		assert.deepStrictEqual([...delivered[0].subarray(0, 4)], [0x50, 0x4a, 0x46, 0x01]);
		const view = new DataView(delivered[0].buffer, delivered[0].byteOffset, delivered[0].byteLength);
		assert.strictEqual(view.getUint32(4, false), 1200);
		assert.strictEqual(view.getUint32(8, false), 800);
		assert.deepStrictEqual([...delivered[0].subarray(12)], [0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xd9]);
		assert.ok(delivered[0].byteLength < new TextEncoder().encode(JSON.stringify({ t: 'frame', data: jpegBase64, w: 1200, h: 800 })).byteLength);

		assert.doesNotThrow(() => frames.fire({ targetId: 'target-a', data: 'invalid!', w: 1200, h: 800 }));
		assert.strictEqual(delivered.length, 2);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(delivered[1])), { t: 'frame', data: 'invalid!', w: 1200, h: 800 });
	});

	test('fallback captureも交渉済みセッションではbinary v1を送る', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(
			new ParadisCdpUpstream('', logService),
			undefined,
			undefined,
			logService,
		));
		const delivered: Uint8Array[] = [];
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a', nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
			handlers: new Map(), pushMode: false, pushStarted: false,
			lastPushFrameAt: 0, lastMetricsAt: 0, binaryFrames: true,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void }).cdpCall
			= (_session, method, _params, handler) => {
				if (method === 'Page.getLayoutMetrics') {
					handler({ cssVisualViewport: { clientWidth: 640, clientHeight: 360 } });
				} else if (method === 'Page.captureScreenshot') {
					handler({ data: '/9gAAX+A/v/Z' });
				}
			};

		(mirror as unknown as { captureFrame: (target: typeof session) => void }).captureFrame(session);

		assert.strictEqual(delivered.length, 1);
		assert.deepStrictEqual([...delivered[0].subarray(0, 4)], [0x50, 0x4a, 0x46, 0x01]);
		const view = new DataView(delivered[0].buffer, delivered[0].byteOffset, delivered[0].byteLength);
		assert.strictEqual(view.getUint32(4, false), 640);
		assert.strictEqual(view.getUint32(8, false), 360);
		assert.deepStrictEqual([...delivered[0].subarray(12)], [0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xd9]);
	});
});

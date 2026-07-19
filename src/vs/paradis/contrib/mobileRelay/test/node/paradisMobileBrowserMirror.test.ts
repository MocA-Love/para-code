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
});

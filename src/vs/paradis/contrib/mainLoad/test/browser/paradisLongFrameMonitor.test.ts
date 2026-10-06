/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisLongFrameEntry, IParadisLongFrameObserver, paradisDiffLongFrames, paradisLongFrameAttributes, paradisStartLongFrameWindow } from '../../browser/paradisLongFrameMonitor.js';

suite('ParadisLongFrameMonitor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('splits long frames by what invoked the script, plus style and layout, and diffs two snapshots', () => {
		let pending: IParadisLongFrameEntry[] = [];
		const log: string[] = [];
		const window = paradisStartLongFrameWindow(() => ({
			observe: options => log.push(`observe:${options.type}`),
			takeRecords: () => {
				const records = pending;
				pending = [];
				return records;
			},
			disconnect: () => log.push('disconnect'),
		} satisfies IParadisLongFrameObserver));
		pending = [{
			startTime: 0, duration: 200, styleAndLayoutStart: 170,
			scripts: [
				{ duration: 90, invokerType: 'event-listener', invoker: 'WebSocket.onmessage' },
				{ duration: 40, invokerType: 'event-listener', invoker: 'MessagePort.onmessage' },
			],
		}];
		const before = window.snapshot();
		pending = [{
			startTime: 1000, duration: 300, styleAndLayoutStart: 1200,
			scripts: [
				{ duration: 60, invokerType: 'user-callback', invoker: 'Window.requestAnimationFrame' },
				{ duration: 30, invokerType: 'user-callback', invoker: 'Window.setTimeout' },
				{ duration: 20, invokerType: 'user-callback', invoker: 'TimerHandler:setInterval' },
				{ duration: 30, invokerType: 'resolve-promise', invoker: 'Response.json.then' },
				{ duration: 20, invokerType: 'event-listener', invoker: 'HTMLDivElement.onclick' },
				{ duration: 10, invokerType: 'classic-script', invoker: 'https://example.invalid/a.js' },
			],
		}];
		const after = window.snapshot();
		const phase = paradisDiffLongFrames(before, after);
		const final = window.stop();
		assert.deepStrictEqual({
			before: paradisLongFrameAttributes('safe_', before),
			phase: paradisLongFrameAttributes('safe_update_folders_', phase),
			final: final?.count,
			afterStop: window.snapshot(),
			log,
		}, {
			before: { safe_busy_frames: 1, safe_busy_socket_ms: 90, safe_busy_port_ms: 40, safe_busy_layout_ms: 30, safe_busy_other_ms: 40 },
			phase: {
				safe_update_folders_busy_frames: 1,
				safe_update_folders_busy_event_ms: 20,
				safe_update_folders_busy_timer_ms: 50,
				safe_update_folders_busy_frame_ms: 60,
				safe_update_folders_busy_promise_ms: 30,
				safe_update_folders_busy_code_ms: 10,
				safe_update_folders_busy_layout_ms: 100,
				safe_update_folders_busy_other_ms: 30,
			},
			final: 2,
			afterStop: undefined,
			log: ['observe:long-animation-frame', 'disconnect'],
		});
	});

	test('reports nothing where long animation frames cannot be observed', () => {
		assert.deepStrictEqual({
			unsupported: paradisStartLongFrameWindow(() => undefined).stop(),
			throwing: paradisStartLongFrameWindow(() => { throw new Error('no observer'); }).snapshot(),
			attributes: paradisLongFrameAttributes('safe_', undefined),
			diff: paradisDiffLongFrames(undefined, { count: 1, bucketMs: { port: 0, socket: 0, event: 0, timer: 0, frame: 0, promise: 0, code: 0, layout: 0, other: 0 } }),
		}, { unsupported: undefined, throwing: undefined, attributes: {}, diff: undefined });
	});
});

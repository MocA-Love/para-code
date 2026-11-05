/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCountFileChannel } from '../../common/paradisFolderUpdateTrace.js';
import { paradisBeginFileIoWindow, paradisResetFileIoWatchForTest } from '../../common/paradisFileIoWatch.js';
import { paradisFormatSlowSwitchLog, paradisFormatStuckSwitchLog, paradisShouldLogSlowSwitch } from '../../common/paradisSlowSwitchLog.js';

suite('ParadisSlowSwitchLog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let now = 0;
	let restore: { dispose(): void };
	setup(() => {
		now = 10_000;
		restore = paradisResetFileIoWatchForTest(() => now);
	});
	teardown(() => restore.dispose());

	/** 呼び出しごとに返事を手で返せるチャネル。 */
	function deferredChannel(): { channel: IChannel; pending: DeferredPromise<unknown>[] } {
		const pending: DeferredPromise<unknown>[] = [];
		const channel: IChannel = {
			call<T>(): Promise<T> {
				const deferred = new DeferredPromise<unknown>();
				pending.push(deferred);
				return deferred.p as Promise<T>;
			},
			listen<T>(): Event<T> {
				return Event.None;
			},
		};
		return { channel, pending };
	}

	test('counts in-flight file calls, the slowest reply and the stat range for the window it is open', async () => {
		const { channel, pending } = deferredChannel();
		const remote = paradisCountFileChannel(channel, 'remote');

		// 区間を開く前から返事を待っている削除（接続先で大きなフォルダを消している）。
		const deleting = remote.call('delete', []);
		now += 1_000;
		const window = paradisBeginFileIoWindow();
		const stat1 = remote.call('stat', []);
		const stat2 = remote.call('stat', []);
		const read = remote.call('readFile', []);
		now += 3;
		pending[1].complete({});
		await stat1;
		now += 4_000;
		pending[2].complete({});
		await stat2;
		pending[3].error(new Error('gone'));
		await read.catch(() => undefined);
		now += 500;
		const summary = window.summarize();
		window.dispose();
		// 閉じた後の呼び出しは数えない。
		pending[0].complete(undefined);
		await deleting;
		const after = remote.call('stat', []);
		pending[4].complete({});
		await after;

		assert.deepStrictEqual(summary, {
			remote: {
				calls: 3,
				failed: 1,
				inflightAtStart: 1,
				maxInflight: 4,
				inflightNow: 1,
				inflightDeletesNow: 1,
				oldestInflightMs: 5_503,
				maxMs: 4_003,
				minStatMs: 3,
				maxStatMs: 4_003,
				deletes: 0,
			},
			local: {
				calls: 0,
				failed: 0,
				inflightAtStart: 0,
				maxInflight: 0,
				inflightNow: 0,
				inflightDeletesNow: 0,
				oldestInflightMs: 0,
				maxMs: 0,
				minStatMs: undefined,
				maxStatMs: undefined,
				deletes: 0,
			},
		});
	});

	test('formats one line without paths, and only logs switches slower than 2 seconds counting the queue wait', () => {
		const idle = { calls: 0, failed: 0, inflightAtStart: 0, maxInflight: 0, inflightNow: 0, inflightDeletesNow: 0, oldestInflightMs: 0, maxMs: 0, minStatMs: undefined, maxStatMs: undefined, deletes: 0 };
		const busy = { calls: 40, failed: 0, inflightAtStart: 0, maxInflight: 12, inflightNow: 0, inflightDeletesNow: 0, oldestInflightMs: 0, maxMs: 24_900, minStatMs: 3, maxStatMs: 24_850.4, deletes: 0 };
		const io = { remote: busy, local: idle };
		assert.deepStrictEqual({
			fast: paradisShouldLogSlowSwitch({ queuedMs: 0, totalMs: 1_900 }),
			queued: paradisShouldLogSlowSwitch({ queuedMs: 1_500, totalMs: 600 }),
			slow: paradisFormatSlowSwitchLog({
				queuedMs: 1_200,
				totalMs: 25_300,
				completed: true,
				failed: false,
				targetRemote: true,
				sourceRemote: true,
				phaseMs: { capture_scope: 4, apply_working_set: 12_000.6, update_folders: 13_000 },
				io,
				fileEvents: 3,
				configEvents: 1,
				lastDeleteAgoMs: { remote: 4_400, local: undefined },
			}),
			stuck: paradisFormatStuckSwitchLog({
				elapsedMs: 20_000,
				phase: 'update_folders',
				phaseElapsedMs: 7_000,
				phaseMs: { capture_scope: 4, apply_working_set: 12_000 },
				io: { remote: { ...busy, inflightNow: 3, oldestInflightMs: 6_999 }, local: idle },
				lastDeleteAgoMs: { remote: undefined, local: 61_000 },
			}),
		}, {
			fast: false,
			queued: true,
			slow: '[ParadisWorkspaceSwitch] Slow space switch: 26500ms (queued 1200ms, body 25300ms, completed, target remote, source remote)'
				+ ' | phases: capture_scope=4 apply_working_set=12001 update_folders=13000'
				+ ' | remote io: calls=40 failed=0 deletes=0 inflight start=0 peak=12 now=0 (deletes 0, oldest 0ms) slowest=24900ms stat=3ms..24850ms'
				+ ' | local io: calls=0 failed=0 deletes=0 inflight start=0 peak=0 now=0 (deletes 0, oldest 0ms) slowest=0ms stat=none'
				+ ' | file events=3 config events=1'
				+ ' | last delete: remote 4s ago, local none',
			stuck: '[ParadisWorkspaceSwitch] Space switch still running after 20000ms: in update_folders for 7000ms'
				+ ' | finished phases: capture_scope=4 apply_working_set=12000'
				+ ' | remote io: calls=40 failed=0 deletes=0 inflight start=0 peak=12 now=3 (deletes 0, oldest 6999ms) slowest=24900ms stat=3ms..24850ms'
				+ ' | local io: calls=0 failed=0 deletes=0 inflight start=0 peak=0 now=0 (deletes 0, oldest 0ms) slowest=0ms stat=none'
				+ ' | last delete: remote none, local 61s ago',
		});
	});
});

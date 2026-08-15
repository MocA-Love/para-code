/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobilePcFocusHeartbeatTimer, ParadisMobilePcFocusHeartbeat } from '../../electron-browser/paradisMobilePcFocusHeartbeat.js';

class FakeIntervalTimer implements IParadisMobilePcFocusHeartbeatTimer {
	private callback: (() => void) | undefined;
	readonly intervals: number[] = [];
	disposed = false;

	cancel(): void {
		this.callback = undefined;
	}

	cancelAndSet(callback: () => void, intervalMs: number): void {
		this.callback = callback;
		this.intervals.push(intervalMs);
	}

	dispose(): void {
		this.cancel();
		this.disposed = true;
	}

	fire(): void {
		this.callback?.();
	}

	get active(): boolean { return this.callback !== undefined; }
}

class DeferredIdleTime {
	readonly requests: DeferredPromise<number>[] = [];

	getSystemIdleTime = (): Promise<number> => {
		const request = new DeferredPromise<number>();
		this.requests.push(request);
		return request.p;
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

suite('ParadisMobilePcFocusHeartbeat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stops its focus heartbeat immediately when mobile relay is disabled', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const reports: boolean[] = [];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async focused => { reports.push(focused); },
		}, timer);

		heartbeat.setEnabled(true);
		assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, idleRequests: idleTime.requests.length }, {
			active: true,
			intervals: [25_000],
			idleRequests: 1,
		});
		idleTime.requests[0].complete(0);
		await flushMicrotasks();

		heartbeat.setEnabled(false);
		timer.fire();
		await flushMicrotasks();

		assert.deepStrictEqual({ active: timer.active, reports, idleRequests: idleTime.requests.length }, {
			active: false,
			reports: [true],
			idleRequests: 1,
		});
		heartbeat.dispose();
	});

	test('drops an idle result that was superseded by a screen lock report', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const reports: boolean[] = [];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async focused => { reports.push(focused); },
		}, timer);

		heartbeat.setEnabled(true);
		heartbeat.setScreenLocked(true);
		heartbeat.reportNow();
		await flushMicrotasks();
		idleTime.requests[0].complete(0);
		await flushMicrotasks();

		assert.deepStrictEqual({ reports, idleRequests: idleTime.requests.length }, {
			reports: [false],
			idleRequests: 1,
		});
		heartbeat.dispose();
	});

	test('lets a publish delegate reject a report made stale while waiting for its renderer lease', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const lease = new DeferredPromise<void>();
		const reports: boolean[] = [];
		let leaseWaits = 0;
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async (focused, stillCurrent) => {
				leaseWaits++;
				await lease.p;
				if (stillCurrent()) {
					reports.push(focused);
				}
			},
		}, timer);

		heartbeat.setEnabled(true);
		idleTime.requests[0].complete(0);
		await flushMicrotasks();
		assert.strictEqual(leaseWaits, 1);

		heartbeat.setEnabled(false);
		lease.complete(undefined);
		await flushMicrotasks();

		assert.deepStrictEqual(reports, []);
		heartbeat.dispose();
	});

	test('cancels the heartbeat and invalidates pending idle reports when disposed', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const reports: boolean[] = [];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async focused => { reports.push(focused); },
		}, timer);

		heartbeat.setEnabled(true);
		heartbeat.dispose();
		idleTime.requests[0].complete(0);
		await flushMicrotasks();

		assert.deepStrictEqual({ active: timer.active, disposed: timer.disposed, reports }, {
			active: false,
			disposed: true,
			reports: [],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobilePcFocusHeartbeatTimer, ParadisMobilePcFocusHeartbeat, ParadisMobilePcFocusHeartbeatCoordinator } from '../../electron-browser/paradisMobilePcFocusHeartbeat.js';

class FakeIntervalTimer implements IParadisMobilePcFocusHeartbeatTimer {
	private callback: (() => void) | undefined;
	readonly intervals: number[] = [];
	disposed = false;

	constructor(
		private readonly onCancel?: () => void,
		private readonly onSet?: () => void,
	) {
	}

	cancel(): void {
		this.callback = undefined;
		this.onCancel?.();
	}

	cancelAndSet(callback: () => void, intervalMs: number): void {
		this.callback = callback;
		this.intervals.push(intervalMs);
		this.onSet?.();
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

	test('reports again when the enabled heartbeat timer fires after 25 seconds', async () => {
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
		idleTime.requests[0].complete(0);
		await flushMicrotasks();
		timer.fire();
		idleTime.requests[1].complete(0);
		await flushMicrotasks();

		assert.deepStrictEqual({ intervals: timer.intervals, reports }, {
			intervals: [25_000],
			reports: [true, true],
		});
		heartbeat.dispose();
	});

	test('does not restart or invalidate a report for equal enabled and lock values', async () => {
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
		heartbeat.setEnabled(true);
		heartbeat.setScreenLocked(false);
		idleTime.requests[0].complete(0);
		await flushMicrotasks();

		assert.deepStrictEqual({ intervals: timer.intervals, idleRequests: idleTime.requests.length, reports }, {
			intervals: [25_000],
			idleRequests: 1,
			reports: [true],
		});
		heartbeat.dispose();
	});

	test('reports unfocused without querying system idle time', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const reports: boolean[] = [];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => false,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async focused => { reports.push(focused); },
		}, timer);

		heartbeat.setEnabled(true);
		await flushMicrotasks();

		assert.deepStrictEqual({ idleRequests: idleTime.requests.length, reports }, {
			idleRequests: 0,
			reports: [false],
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

	test('invalidates an older renderer lease wait when a newer report starts', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const oldLease = new DeferredPromise<void>();
		const newLease = new DeferredPromise<void>();
		const reports: boolean[] = [];
		const leases = [oldLease, newLease];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			publish: async (focused, stillCurrent) => {
				const lease = leases.shift();
				if (lease === undefined) {
					throw new Error('Unexpected renderer lease request');
				}
				await lease.p;
				if (stillCurrent()) {
					reports.push(focused);
				}
			},
		}, timer);

		heartbeat.setEnabled(true);
		idleTime.requests[0].complete(0);
		await flushMicrotasks();
		heartbeat.reportNow();
		idleTime.requests[1].complete(0);
		await flushMicrotasks();
		oldLease.complete(undefined);
		await flushMicrotasks();
		newLease.complete(undefined);
		await flushMicrotasks();

		assert.deepStrictEqual(reports, [true]);
		heartbeat.dispose();
	});

	test('does not publish a pending unfocused report after disabled relay is reenabled', async () => {
		const timer = new FakeIntervalTimer();
		const oldLease = new DeferredPromise<void>();
		const newLease = new DeferredPromise<void>();
		const reports: boolean[] = [];
		const leases = [oldLease, newLease];
		const heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: 25_000,
			isVisiblyFocused: () => false,
			getSystemIdleTime: async () => { throw new Error('Unfocused reports must not query idle time'); },
			publish: async (focused, stillCurrent) => {
				const lease = leases.shift();
				if (lease === undefined) {
					throw new Error('Unexpected renderer lease request');
				}
				await lease.p;
				if (stillCurrent()) {
					reports.push(focused);
				}
			},
		}, timer);

		heartbeat.setEnabled(true);
		heartbeat.setEnabled(false);
		heartbeat.setEnabled(true);
		oldLease.complete(undefined);
		await flushMicrotasks();
		newLease.complete(undefined);
		await flushMicrotasks();

		assert.deepStrictEqual(reports, [false]);
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

	test('binds PC focus events, enables after provider construction, and synchronizes configuration after the controller', async () => {
		const locked = new Emitter<void>();
		const unlocked = new Emitter<void>();
		const focused = new Emitter<void>();
		const visibilityChanged = new Emitter<void>();
		let visiblyFocused = true;
		let idleQueries = 0;
		const events: string[] = [];
		const timer = new FakeIntervalTimer(
			() => events.push('controller-stop'),
			() => events.push('controller-start'),
		);
		const reports: boolean[] = [];
		const coordinator = new ParadisMobilePcFocusHeartbeatCoordinator({
			heartbeatIntervalMs: 25_000,
			isEnabled: () => true,
			isVisiblyFocused: () => visiblyFocused,
			getSystemIdleTime: async () => { idleQueries++; return 0; },
			resolveCurrentRendererLease: async () => 'current',
			resolveWindowLease: async () => 'window',
			setPcFocus: async (_lease, active) => { reports.push(active); },
			setSharedProcessEnabled: async () => { events.push('shared'); },
			onDidLockScreen: locked.event,
			onDidUnlockScreen: unlocked.event,
			onDidChangeFocus: focused.event,
			onDidChangeVisibility: visibilityChanged.event,
		}, timer);

		const provider = coordinator.createProvider(() => { events.push('provider'); return { ready: true }; });
		await flushMicrotasks();
		locked.fire();
		await flushMicrotasks();
		unlocked.fire();
		await flushMicrotasks();
		visiblyFocused = false;
		focused.fire();
		await flushMicrotasks();
		visibilityChanged.fire();
		await flushMicrotasks();
		coordinator.setEnabledAndSynchronize(false);
		await flushMicrotasks();

		assert.deepStrictEqual({ provider, events, idleQueries, reports, heartbeatActive: timer.active }, {
			provider: { ready: true },
			events: ['provider', 'controller-start', 'controller-stop', 'shared'],
			idleQueries: 2,
			reports: [true, false, true, false, false],
			heartbeatActive: false,
		});
		coordinator.dispose();
		locked.dispose();
		unlocked.dispose();
		focused.dispose();
		visibilityChanged.dispose();
	});

	test('rechecks the current report after renderer lease resolution before IPC', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const oldLease = new DeferredPromise<string>();
		const newLease = new DeferredPromise<string>();
		const leases = [oldLease, newLease];
		const reports: Array<{ lease: string; active: boolean }> = [];
		const never = new Emitter<void>();
		const coordinator = new ParadisMobilePcFocusHeartbeatCoordinator({
			heartbeatIntervalMs: 25_000,
			isEnabled: () => true,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			resolveCurrentRendererLease: () => {
				const lease = leases.shift();
				if (lease === undefined) {
					throw new Error('Unexpected renderer lease request');
				}
				return lease.p;
			},
			resolveWindowLease: async () => 'window',
			setPcFocus: async (lease, active) => { reports.push({ lease, active }); },
			setSharedProcessEnabled: async () => { },
			onDidLockScreen: never.event,
			onDidUnlockScreen: never.event,
			onDidChangeFocus: never.event,
			onDidChangeVisibility: never.event,
		}, timer);

		coordinator.createProvider(() => undefined);
		idleTime.requests[0].complete(0);
		await flushMicrotasks();
		coordinator.reportNow();
		idleTime.requests[1].complete(0);
		await flushMicrotasks();
		oldLease.complete('old');
		await flushMicrotasks();
		newLease.complete('new');
		await flushMicrotasks();

		assert.deepStrictEqual(reports, [{ lease: 'new', active: true }]);
		coordinator.dispose();
		never.dispose();
	});

	test('invalidates the controller before requesting the final unfocused report on disposal', async () => {
		const timer = new FakeIntervalTimer();
		const idleTime = new DeferredIdleTime();
		const currentLease = new DeferredPromise<string>();
		const finalLease = new DeferredPromise<string>();
		const events: string[] = [];
		const reports: Array<{ lease: string; active: boolean }> = [];
		const never = new Emitter<void>();
		const coordinator = new ParadisMobilePcFocusHeartbeatCoordinator({
			heartbeatIntervalMs: 25_000,
			isEnabled: () => true,
			isVisiblyFocused: () => true,
			getSystemIdleTime: idleTime.getSystemIdleTime,
			resolveCurrentRendererLease: () => currentLease.p,
			resolveWindowLease: () => {
				events.push(`final-lease-after-dispose:${timer.disposed}`);
				return finalLease.p;
			},
			setPcFocus: async (lease, active) => { reports.push({ lease, active }); },
			setSharedProcessEnabled: async () => { },
			onDidLockScreen: never.event,
			onDidUnlockScreen: never.event,
			onDidChangeFocus: never.event,
			onDidChangeVisibility: never.event,
		}, timer);

		coordinator.createProvider(() => undefined);
		idleTime.requests[0].complete(0);
		await flushMicrotasks();
		coordinator.dispose();
		finalLease.complete('final');
		await flushMicrotasks();
		currentLease.complete('current');
		await flushMicrotasks();

		assert.deepStrictEqual({ events, reports }, {
			events: ['final-lease-after-dispose:true'],
			reports: [{ lease: 'final', active: false }],
		});
		never.dispose();
	});
});

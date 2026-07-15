/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCreateBrowserViewInitialization } from '../../../../../workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.js';

suite('BrowserViewWorkbenchService initialization', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createManualTimers() {
		let nextHandle = 0;
		const scheduled = new Map<number, { readonly callback: () => void; readonly delay: number }>();
		return {
			scheduled,
			setTimeout: (callback: () => void, delay: number): number => {
				const handle = ++nextHandle;
				scheduled.set(handle, { callback, delay });
				return handle;
			},
			clearTimeout: (handle: unknown): void => { scheduled.delete(handle as number); },
			runNext(): number {
				const entry = scheduled.entries().next().value as [number, { readonly callback: () => void; readonly delay: number }] | undefined;
				assert.ok(entry);
				scheduled.delete(entry[0]);
				entry[1].callback();
				return entry[1].delay;
			},
		};
	}

	async function flushMicrotasks(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}

	test('subscribes before taking the snapshot and accepts both event and snapshot views', async () => {
		const snapshot = new DeferredPromise<readonly string[]>();
		const order: string[] = [];
		let listener: ((view: string) => void) | undefined;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			callback => {
				order.push('listen');
				listener = callback;
				return toDisposable(() => undefined);
			},
			() => {
				order.push('snapshot');
				return snapshot.p;
			},
			view => order.push(`accept:${view}`),
			() => assert.fail('unexpected initialization failure'),
		);
		store.add(initialization.listener);

		assert.deepStrictEqual(order, ['listen', 'snapshot']);
		listener?.('event');
		snapshot.complete(['snapshot']);
		assert.strictEqual(await initialization.whenInitialized, true);
		assert.deepStrictEqual(order, ['listen', 'snapshot', 'accept:event', 'accept:snapshot']);
	});

	test('retries any number of transient snapshot failures with capped backoff before succeeding', async () => {
		const timers = createManualTimers();
		const logged: unknown[] = [];
		let attempts = 0;
		const accepted: string[] = [];
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => ++attempts < 5 ? Promise.reject(new Error(`snapshot failed ${attempts}`)) : Promise.resolve(['retained']),
			view => accepted.push(view),
			error => logged.push(error),
			{
				initialRetryDelayMs: 10,
				maximumRetryDelayMs: 40,
				attemptTimeoutMs: 1_000,
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
				now: () => 0,
			},
		);
		store.add(initialization.listener);

		const delays: number[] = [];
		for (let failure = 0; failure < 4; failure++) {
			await flushMicrotasks();
			// The attempt timeout is replaced by exactly one retry timer after rejection.
			assert.strictEqual(timers.scheduled.size, 1);
			delays.push(timers.runNext());
		}
		assert.strictEqual(await initialization.whenInitialized, true);
		assert.strictEqual(attempts, 5);
		assert.deepStrictEqual(delays, [10, 20, 40, 40]);
		assert.deepStrictEqual(accepted, ['retained']);
		assert.strictEqual(logged.length, 1);
	});

	test('retries the whole idempotent snapshot when accepting one view throws', async () => {
		const timers = createManualTimers();
		let accepts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => Promise.resolve(['broken']),
			() => {
				if (++accepts === 1) {
					throw new Error('accept failed');
				}
			},
			() => undefined,
			{ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
		);
		store.add(initialization.listener);
		await flushMicrotasks();
		timers.runNext();
		assert.strictEqual(await initialization.whenInitialized, true);
		assert.strictEqual(accepts, 2);
	});

	test('survives a throwing diagnostic callback and still recovers', async () => {
		const timers = createManualTimers();
		let attempts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => ++attempts === 1 ? Promise.reject(new Error('snapshot failed')) : Promise.resolve([]),
			() => undefined,
			() => { throw new Error('logging failed'); },
			{ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
		);
		store.add(initialization.listener);
		await flushMicrotasks();
		timers.runNext();
		assert.strictEqual(await initialization.whenInitialized, true);
	});

	test('fences a timed-out attempt and ignores its late snapshot after recovery', async () => {
		const timers = createManualTimers();
		const stale = new DeferredPromise<readonly string[]>();
		const accepted: string[] = [];
		let attempts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => ++attempts === 1 ? stale.p : Promise.resolve(['current']),
			view => accepted.push(view),
			() => undefined,
			{
				attemptTimeoutMs: 50,
				initialRetryDelayMs: 10,
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			},
		);
		store.add(initialization.listener);

		assert.strictEqual(timers.runNext(), 50);
		stale.complete(['stale']);
		await flushMicrotasks();
		assert.deepStrictEqual(accepted, []);
		assert.strictEqual(timers.runNext(), 10);
		assert.strictEqual(await initialization.whenInitialized, true);
		assert.deepStrictEqual(accepted, ['current']);
	});

	test('caps unresolved timed-out snapshots and resumes only after an orphan settles', async () => {
		const timers = createManualTimers();
		const pending: DeferredPromise<readonly string[]>[] = [];
		let attempts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => {
				attempts++;
				const snapshot = new DeferredPromise<readonly string[]>();
				pending.push(snapshot);
				return snapshot.p;
			},
			() => assert.fail('a stale timed-out snapshot must never be accepted'),
			() => undefined,
			{
				attemptTimeoutMs: 50,
				initialRetryDelayMs: 10,
				maximumRetryDelayMs: 40,
				maximumTimedOutAttempts: 2,
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			},
		);
		store.add(initialization.listener);

		assert.strictEqual(attempts, 1);
		assert.strictEqual(timers.runNext(), 50);
		assert.strictEqual(timers.runNext(), 10);
		assert.strictEqual(attempts, 2);
		assert.strictEqual(timers.runNext(), 50);
		assert.strictEqual(timers.scheduled.size, 0, 'the orphan cap must stop new IPC attempts');

		pending[0].complete(['stale']);
		await flushMicrotasks();
		assert.strictEqual(timers.scheduled.size, 1, 'settling one orphan must restore retry capacity');
		assert.strictEqual(timers.runNext(), 20);
		assert.strictEqual(attempts, 3);
	});

	test('dispose fences every retained timed-out snapshot callback', async () => {
		const timers = createManualTimers();
		const pending: DeferredPromise<readonly string[]>[] = [];
		let accepts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => {
				const snapshot = new DeferredPromise<readonly string[]>();
				pending.push(snapshot);
				return snapshot.p;
			},
			() => accepts++,
			() => undefined,
			{
				attemptTimeoutMs: 50,
				initialRetryDelayMs: 10,
				maximumTimedOutAttempts: 2,
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			},
		);
		assert.strictEqual(timers.runNext(), 50);
		assert.strictEqual(timers.runNext(), 10);
		assert.strictEqual(timers.runNext(), 50);

		initialization.listener.dispose();
		assert.strictEqual(await initialization.whenInitialized, false);
		for (const snapshot of pending) {
			snapshot.complete(['late']);
		}
		await flushMicrotasks();
		assert.strictEqual(accepts, 0);
		assert.strictEqual(timers.scheduled.size, 0);
	});

	test('cancels its only timer and resolves false when disposed', async () => {
		const timers = createManualTimers();
		let attempts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => { attempts++; return Promise.reject(new Error('offline')); },
			() => undefined,
			() => undefined,
			{ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
		);
		await flushMicrotasks();
		assert.strictEqual(timers.scheduled.size, 1);

		initialization.listener.dispose();
		assert.strictEqual(await initialization.whenInitialized, false);
		assert.strictEqual(timers.scheduled.size, 0);
		assert.strictEqual(attempts, 1);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IParadisWarmLeaseLimits, IParadisWarmLeaseScheduler, ParadisWarmLeaseController, ParadisWarmLeaseTracker, PARADIS_WARM_LEASE_DURATION_MS, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS } from '../../common/paradisWarmLease.js';

interface Target {
	readonly key: string;
	readonly value: string;
	readonly cost: number;
}

suite('ParadisWarmLeaseTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('renews one owner without adding membership and extends its expiry by 900,000ms', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(clock, scheduler, { maxOwners: 1, maxTotalMemberships: 1 }));

		tracker.setLease('owner-a', [target('a', 'first')]);
		clock.now = 1;
		tracker.setLease('owner-a', [target('a', 'renewed')]);
		tracker.setLease('owner-b', [target('b', 'ignored')]);
		clock.now = PARADIS_WARM_LEASE_DURATION_MS;

		assert.deepStrictEqual(active(tracker), [['a', 'renewed']]);
		assert.deepStrictEqual(scheduler.delays, [PARADIS_WARM_LEASE_DURATION_MS, PARADIS_WARM_LEASE_DURATION_MS]);
	});

	test('keeps one expiry timer scheduled for the earliest active lease', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(clock, scheduler));

		tracker.setLease('owner-a', [target('a', 'first')]);
		clock.now = 100;
		tracker.setLease('owner-b', [target('b', 'second')]);
		tracker.release('owner-a');

		assert.deepStrictEqual([scheduler.delays, scheduler.activeTimerCount], [[
			PARADIS_WARM_LEASE_DURATION_MS,
			PARADIS_WARM_LEASE_DURATION_MS - 100,
			PARADIS_WARM_LEASE_DURATION_MS,
		], 1]);
	});

	test('does not change generation, value, or change event for an equal target renewal', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(clock, scheduler));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));

		tracker.setLease('owner-a', [target('a', 'same')]);
		const initialSnapshots = tracker.activeTargets();
		const first = initialSnapshots[0];
		clock.now = 100;
		tracker.setLease('owner-a', [target('a', 'same')]);
		const renewed = tracker.activeTargets()[0];

		assert.deepStrictEqual([renewed.target.value, renewed.generation, changes, Object.isFrozen(initialSnapshots), Object.isFrozen(first), first === renewed], ['same', first.generation, 1, true, true, false]);
	});

	test('replaces an owner target set and removes its old targets', () => {
		const tracker = store.add(createTracker(new TestClock(), new TestScheduler()));

		tracker.setLease('owner-a', [target('old', 'old'), target('kept', 'before')]);
		tracker.setLease('owner-a', [target('kept', 'after'), target('new', 'new')]);

		assert.deepStrictEqual(active(tracker), [['kept', 'after'], ['new', 'new']]);
	});

	test('selects the last renewed owner and falls back after it releases', () => {
		const tracker = store.add(createTracker(new TestClock(), new TestScheduler()));

		tracker.setLease('owner-a', [target('shared', 'a-first')]);
		tracker.setLease('owner-b', [target('shared', 'b')]);
		tracker.setLease('owner-a', [target('shared', 'a-renewed')]);
		assert.deepStrictEqual(active(tracker), [['shared', 'a-renewed']]);

		tracker.release('owner-a');
		assert.deepStrictEqual(active(tracker), [['shared', 'b']]);
	});

	test('uses the latter renewal when two owners renew at the same time', () => {
		const tracker = store.add(createTracker(new TestClock(), new TestScheduler()));

		tracker.setLease('owner-a', [target('shared', 'a')]);
		tracker.setLease('owner-b', [target('shared', 'b')]);

		assert.deepStrictEqual(active(tracker), [['shared', 'b']]);
	});

	test('clears the final target and pending expiry timer on the last release', () => {
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(new TestClock(), scheduler));

		tracker.setLease('owner-a', [target('a', 'value')]);
		assert.strictEqual(scheduler.activeTimerCount, 1);
		tracker.release('owner-a');

		assert.deepStrictEqual(active(tracker), []);
		assert.strictEqual(scheduler.activeTimerCount, 0);
	});

	test('ignores release for an unknown owner', () => {
		const tracker = store.add(createTracker(new TestClock(), new TestScheduler()));

		tracker.setLease('owner-a', [target('a', 'value')]);
		const before = tracker.activeTargets();
		tracker.release('missing-owner');

		assert.deepStrictEqual(tracker.activeTargets(), before);
	});

	test('enforces owner, distinct key, membership, and cost caps without evicting active owners', () => {
		const ownerTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxOwners: 1 }));
		ownerTracker.setLease('owner-a', [target('a', 'kept')]);
		ownerTracker.setLease('owner-b', [target('b', 'blocked')]);

		const perOwnerTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxTargetsPerOwner: 1 }));
		perOwnerTracker.setLease('owner-a', [target('a', 'kept')]);
		perOwnerTracker.setLease('owner-a', [target('a', 'blocked'), target('b', 'blocked')]);

		const keyTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxDistinctKeys: 1 }));
		keyTracker.setLease('owner-a', [target('a', 'kept')]);
		keyTracker.setLease('owner-b', [target('b', 'blocked')]);

		const membershipTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxTotalMemberships: 1 }));
		membershipTracker.setLease('owner-a', [target('a', 'kept')]);
		membershipTracker.setLease('owner-b', [target('a', 'blocked')]);

		const costTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxTotalCost: 1 }));
		costTracker.setLease('owner-a', [target('a', 'kept', 1)]);
		costTracker.setLease('owner-b', [target('b', 'blocked', 1)]);

		assert.deepStrictEqual([
			active(ownerTracker),
			active(perOwnerTracker),
			active(keyTracker),
			active(membershipTracker),
			active(costTracker),
		], [
			[['a', 'kept']],
			[['a', 'kept']],
			[['a', 'kept']],
			[['a', 'kept']],
			[['a', 'kept']],
		]);
	});

	test('purges expired leases before cap checks even when the expiry callback was delayed', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(clock, scheduler, { maxOwners: 1 }));

		tracker.setLease('owner-a', [target('a', 'expired')]);
		clock.now = PARADIS_WARM_LEASE_DURATION_MS;
		tracker.setLease('owner-b', [target('b', 'fresh')]);

		assert.deepStrictEqual(active(tracker), [['b', 'fresh']]);
		assert.strictEqual(scheduler.runCount, 0);
	});

	test('never reuses a generation after a target is deleted and reacquired', () => {
		const tracker = store.add(createTracker(new TestClock(), new TestScheduler()));

		tracker.setLease('owner-a', [target('a', 'value')]);
		const firstGeneration = tracker.activeTargets()[0].generation;
		tracker.release('owner-a');
		tracker.setLease('owner-b', [target('a', 'value')]);

		assert.ok(tracker.activeTargets()[0].generation > firstGeneration);
	});

	test('synchronously purges expired targets from active snapshots and isCurrent', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(createTracker(clock, scheduler));

		tracker.setLease('owner-a', [target('a', 'expired')]);
		const snapshot = tracker.activeTargets()[0];
		clock.now = PARADIS_WARM_LEASE_DURATION_MS;

		assert.deepStrictEqual(active(tracker), []);
		assert.strictEqual(tracker.isCurrent(snapshot.key, snapshot.generation), false);
		assert.strictEqual(scheduler.runCount, 0);
	});
});

suite('ParadisWarmLeaseController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('acquires immediately, renews every 300,000ms, releases once, and uses a new owner after re-enable', async () => {
		const scheduler = new TestScheduler();
		const operations: string[] = [];
		const backendOwners = new Set<string>();
		const controller = store.add(new ParadisWarmLeaseController(
			async ownerId => { operations.push(`acquire:${ownerId}`); backendOwners.add(ownerId); },
			async ownerId => { operations.push(`renew:${ownerId}`); },
			async ownerId => { operations.push(`release:${ownerId}`); backendOwners.delete(ownerId); },
			runner => { scheduler.setRunner(runner); return scheduler; },
			ownerIds('owner-a', 'owner-b'),
		));

		controller.setEnabled(true);
		await flushMicrotasks();
		assert.deepStrictEqual([operations, scheduler.delays, [...backendOwners]], [['acquire:owner-a'], [PARADIS_WARM_LEASE_RENEW_INTERVAL_MS], ['owner-a']]);

		scheduler.run();
		await flushMicrotasks();
		assert.deepStrictEqual(operations, ['acquire:owner-a', 'renew:owner-a']);

		controller.setEnabled(false);
		await flushMicrotasks();
		assert.deepStrictEqual([operations, [...backendOwners], scheduler.activeTimerCount], [['acquire:owner-a', 'renew:owner-a', 'release:owner-a'], [], 0]);

		controller.setEnabled(true);
		await flushMicrotasks();
		controller.dispose();
		await flushMicrotasks();

		assert.deepStrictEqual([operations, [...backendOwners]], [[
			'acquire:owner-a',
			'renew:owner-a',
			'release:owner-a',
			'acquire:owner-b',
			'release:owner-b',
		], []]);
	});

	test('contains rejected acquire, renew, and release callbacks without unhandled rejections', async () => {
		const rejectionReasons: unknown[] = [];
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			rejectionReasons.push(event.reason);
			event.preventDefault();
		};
		globalThis.addEventListener('unhandledrejection', onUnhandledRejection);
		const acquireScheduler = new TestScheduler();
		const rejectedAcquire = store.add(new ParadisWarmLeaseController(
			async () => { throw new Error('acquire failed'); },
			async () => { throw new Error('not reached'); },
			async () => { throw new Error('not reached'); },
			runner => { acquireScheduler.setRunner(runner); return acquireScheduler; },
			ownerIds('acquire-owner'),
		));
		try {
			rejectedAcquire.setEnabled(true);
			await flushMicrotasks();
			rejectedAcquire.dispose();

			const scheduler = new TestScheduler();
			const rejectedRenewAndRelease = store.add(new ParadisWarmLeaseController(
				async () => { },
				async () => { throw new Error('renew failed'); },
				async () => { throw new Error('release failed'); },
				runner => { scheduler.setRunner(runner); return scheduler; },
				ownerIds('owner-a'),
			));
			rejectedRenewAndRelease.setEnabled(true);
			await flushMicrotasks();
			scheduler.run();
			await flushMicrotasks();
			rejectedRenewAndRelease.setEnabled(false);
			await flushMicrotasks();

			assert.deepStrictEqual([scheduler.delays, rejectionReasons], [[PARADIS_WARM_LEASE_RENEW_INTERVAL_MS, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS], []]);
		} finally {
			globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
		}
	});

	test('waits for a slow acquire before sending its trailing release on disable and dispose', async () => {
		const scheduler = new TestScheduler();
		const acquireGate = new Deferred<void>();
		const operations: string[] = [];
		const backendOwners = new Set<string>();
		const controller = store.add(new ParadisWarmLeaseController(
			async ownerId => { operations.push(`acquire:${ownerId}`); await acquireGate.promise; backendOwners.add(ownerId); },
			async ownerId => { operations.push(`renew:${ownerId}`); },
			async ownerId => { operations.push(`release:${ownerId}`); backendOwners.delete(ownerId); },
			runner => { scheduler.setRunner(runner); return scheduler; },
			ownerIds('owner-a'),
		));

		controller.setEnabled(true);
		controller.setEnabled(false);
		controller.dispose();
		await flushMicrotasks();
		assert.deepStrictEqual(operations, ['acquire:owner-a']);

		acquireGate.resolve();
		await flushMicrotasks();
		assert.deepStrictEqual([operations, [...backendOwners]], [['acquire:owner-a', 'release:owner-a'], []]);
	});

	test('serializes false to true changes during a slow acquire as release old then acquire new', async () => {
		const scheduler = new TestScheduler();
		const acquireGate = new Deferred<void>();
		const operations: string[] = [];
		const backendOwners = new Set<string>();
		const controller = store.add(new ParadisWarmLeaseController(
			async ownerId => {
				operations.push(`acquire:${ownerId}`);
				if (ownerId === 'owner-old') {
					await acquireGate.promise;
				}
				backendOwners.add(ownerId);
			},
			async ownerId => { operations.push(`renew:${ownerId}`); },
			async ownerId => { operations.push(`release:${ownerId}`); backendOwners.delete(ownerId); },
			runner => { scheduler.setRunner(runner); return scheduler; },
			ownerIds('owner-old', 'owner-new'),
		));

		controller.setEnabled(true);
		controller.setEnabled(false);
		controller.setEnabled(true);
		acquireGate.resolve();
		await flushMicrotasks();

		assert.deepStrictEqual([operations, [...backendOwners]], [[
			'acquire:owner-old',
			'release:owner-old',
			'acquire:owner-new',
		], ['owner-new']]);
	});

	test('coalesces repeated desired-state changes while a renew is in flight', async () => {
		const scheduler = new TestScheduler();
		const renewGate = new Deferred<void>();
		const operations: string[] = [];
		const backendOwners = new Set<string>();
		const controller = store.add(new ParadisWarmLeaseController(
			async ownerId => { operations.push(`acquire:${ownerId}`); backendOwners.add(ownerId); },
			async ownerId => { operations.push(`renew:${ownerId}`); await renewGate.promise; },
			async ownerId => { operations.push(`release:${ownerId}`); backendOwners.delete(ownerId); },
			runner => { scheduler.setRunner(runner); return scheduler; },
			ownerIds('owner-old', 'owner-new'),
		));

		controller.setEnabled(true);
		await flushMicrotasks();
		scheduler.run();
		await flushMicrotasks();
		controller.setEnabled(false);
		controller.setEnabled(true);
		controller.setEnabled(true);
		renewGate.resolve();
		await flushMicrotasks();

		assert.deepStrictEqual([operations, [...backendOwners]], [[
			'acquire:owner-old',
			'renew:owner-old',
			'release:owner-old',
			'acquire:owner-new',
		], ['owner-new']]);
	});
});

function createTracker(clock: TestClock, scheduler: TestScheduler, overrides: Partial<IParadisWarmLeaseLimits> = {}): ParadisWarmLeaseTracker<Target> {
	return new ParadisWarmLeaseTracker(
		target => target.key,
		(left, right) => left.value === right.value,
		target => target.cost,
		() => clock.now,
		runner => { scheduler.setRunner(runner); return scheduler; },
		{
			maxOwners: 4,
			maxTargetsPerOwner: 4,
			maxDistinctKeys: 4,
			maxTotalMemberships: 8,
			maxTotalCost: 8,
			...overrides,
		},
	);
}

function target(key: string, value: string, cost = 1): Target {
	return { key, value, cost };
}

function active(tracker: ParadisWarmLeaseTracker<Target>): Array<[string, string]> {
	return tracker.activeTargets().map(snapshot => [snapshot.key, snapshot.target.value]);
}

function ownerIds(...ids: string[]): () => string {
	let index = 0;
	return () => ids[index++];
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index++) {
		await Promise.resolve();
	}
}

class TestClock {
	now = 0;
}

class TestScheduler implements IParadisWarmLeaseScheduler {
	readonly delays: number[] = [];
	runCount = 0;
	private runner: () => void = () => { };
	private pending = false;

	setRunner(runner: () => void): void {
		this.runner = runner;
	}

	get activeTimerCount(): number {
		return this.pending ? 1 : 0;
	}

	schedule(delay: number): void {
		this.delays.push(delay);
		this.pending = true;
	}

	cancel(): void {
		this.pending = false;
	}

	dispose(): void {
		this.pending = false;
	}

	run(): void {
		if (!this.pending) {
			return;
		}
		this.pending = false;
		this.runCount++;
		this.runner();
	}
}

class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;

	constructor() {
		this.promise = new Promise<T>(resolve => this.resolvePromise = resolve);
	}

	resolve(value: T extends void ? undefined : T = undefined as T extends void ? undefined : T): void {
		this.resolvePromise(value);
	}
}

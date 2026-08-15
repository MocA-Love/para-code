/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IParadisWarmLeaseLimits, IParadisWarmLeaseScheduler, ParadisWarmLeaseController, ParadisWarmLeaseTracker, PARADIS_WARM_LEASE_DURATION_MS, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS, type ParadisWarmLeaseTargetValue } from '../../common/paradisWarmLease.js';

type Target = {
	readonly key: string;
	readonly value: string;
	readonly cost: number;
};

type NestedTarget = {
	readonly key: string;
	readonly value: {
		readonly label: string;
		readonly details: {
			readonly state: string;
		};
	};
	readonly tags: readonly string[];
	readonly optional?: string;
	readonly cost: number;
};

type NumericTarget = {
	readonly key: string;
	readonly values: readonly number[];
	readonly cost: number;
};

class CustomPrototypeTarget {
	readonly key = 'custom';
	readonly value = { label: 'custom', details: { state: 'custom' } };
	readonly tags: readonly string[] = [];
	readonly cost = 1;
}

suite('ParadisWarmLeaseTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('exports the recursive target contract and excludes custom prototype tracker types', () => {
		const supportedTarget: ParadisWarmLeaseTargetValue = nestedTarget('supported', 'label', 'state', ['tag'], 1);
		// @ts-expect-error Custom prototype targets are outside the static tracker contract.
		const unsupportedTracker: ParadisWarmLeaseTracker<CustomPrototypeTarget> | undefined = undefined;

		assert.deepStrictEqual([supportedTarget, unsupportedTracker], [nestedTarget('supported', 'label', 'state', ['tag'], 1), undefined]);
	});

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

		const keyTracker = store.add(createTracker(new TestClock(), new TestScheduler(), { maxDistinctTargets: 1 }));
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

	test('does not resume after an expiry listener disposes the tracker during public or queued timer purges', () => {
		const publicClock = new TestClock();
		const publicScheduler = new TestScheduler();
		const observedKeys: string[] = [];
		const publicTracker = store.add(new ParadisWarmLeaseTracker<Target>(
			target => {
				observedKeys.push(target.key);
				return target.key;
			},
			(left, right) => left.value === right.value,
			target => target.cost,
			() => publicClock.now,
			runner => { publicScheduler.setRunner(runner); return publicScheduler; },
			{
				maxOwners: 4,
				maxTargetsPerOwner: 4,
				maxDistinctTargets: 4,
				maxTotalMemberships: 8,
				maxTotalCost: 8,
			},
		));
		publicTracker.setLease('owner-a', [target('a', 'expired')]);
		store.add(publicTracker.onDidChange(() => publicTracker.dispose()));
		publicClock.now = PARADIS_WARM_LEASE_DURATION_MS;

		assert.doesNotThrow(() => publicTracker.setLease('owner-b', [target('b', 'must-not-register')]));
		assert.deepStrictEqual([observedKeys, active(publicTracker), publicScheduler.activeTimerCount], [['a'], [], 0]);

		const timerClock = new TestClock();
		const timerScheduler = new TestScheduler();
		const timerTracker = store.add(createTracker(timerClock, timerScheduler));
		timerTracker.setLease('owner-a', [target('a', 'expired')]);
		store.add(timerTracker.onDidChange(() => timerTracker.dispose()));
		timerClock.now = PARADIS_WARM_LEASE_DURATION_MS;

		assert.doesNotThrow(() => timerScheduler.runCallback());
		assert.deepStrictEqual([active(timerTracker), timerScheduler.activeTimerCount], [[], 0]);
	});

	test('uses the six-argument constructor to own target aliases', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(new ParadisWarmLeaseTracker<Target>(
			target => target.key,
			(left, right) => left.value === right.value,
			target => target.cost,
			() => clock.now,
			runner => { scheduler.setRunner(runner); return scheduler; },
			{
				maxOwners: 4,
				maxTargetsPerOwner: 4,
				maxDistinctTargets: 4,
				maxTotalMemberships: 8,
				maxTotalCost: 1,
			},
		));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));
		const source = target('a', 'kept', 1);

		tracker.setLease('owner-a', [source]);
		const first = tracker.activeTargets()[0];
		mutateTarget(source, 'source-mutated', 'source-mutated', 0);
		mutateTarget(first.target, 'returned-mutated', 'returned-mutated', 0);
		tracker.setLease('owner-b', [target('b', 'over-cap', 1)]);
		const retained = tracker.activeTargets()[0];

		assert.deepStrictEqual([
			active(tracker),
			retained.target.key,
			retained.target.cost,
			retained.generation,
			changes,
		], [[['a', 'kept']], 'a', 1, first.generation, 1]);
	});

	test('owns optional undefined and nested readonly target aliases with only the five documented limit fields', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(new ParadisWarmLeaseTracker<NestedTarget>(
			target => target.key,
			(left, right) => left.value.label === right.value.label,
			target => target.cost,
			() => clock.now,
			runner => { scheduler.setRunner(runner); return scheduler; },
			{
				maxOwners: 4,
				maxTargetsPerOwner: 4,
				maxDistinctTargets: 4,
				maxTotalMemberships: 8,
				maxTotalCost: 1,
			},
		));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));
		const source = nestedTarget('a', 'kept', 'kept', ['one'], 1);

		tracker.setLease('owner-a', [source]);
		const first = tracker.activeTargets()[0];
		assert.ok(first, 'a target with an optional undefined property must be admitted');
		mutateNestedTarget(source, 'source', 'source', 'source-tag', 0);
		mutateNestedTarget(first.target, 'returned', 'returned', 'returned-tag', 0);
		tracker.setLease('owner-b', [nestedTarget('b', 'blocked', 'blocked', ['two'], 1)]);
		const retained = tracker.activeTargets()[0];

		assert.deepStrictEqual([
			retained.key,
			retained.target.value.label,
			retained.target.value.details.state,
			retained.target.tags,
			Object.prototype.hasOwnProperty.call(retained.target, 'optional'),
			retained.target.optional,
			retained.target.cost,
			retained.generation,
			changes,
		], ['a', 'kept', 'kept', ['one'], true, undefined, 1, first.generation, 1]);
	});

	test('admits NaN and infinities in target data while its accounted cost remains finite', () => {
		const clock = new TestClock();
		const scheduler = new TestScheduler();
		const tracker = store.add(new ParadisWarmLeaseTracker<NumericTarget>(
			target => target.key,
			(left, right) => left.values.every((value, index) => Object.is(value, right.values[index])),
			target => target.cost,
			() => clock.now,
			runner => { scheduler.setRunner(runner); return scheduler; },
			{
				maxOwners: 1,
				maxTargetsPerOwner: 1,
				maxDistinctTargets: 1,
				maxTotalMemberships: 1,
				maxTotalCost: 1,
			},
		));
		const source = { key: 'numbers', values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], cost: 1 } as const;

		tracker.setLease('owner-a', [source]);
		const snapshot = tracker.activeTargets()[0];

		assert.ok(snapshot, 'all number values in target data must be admitted');
		assert.deepStrictEqual([snapshot.target.values, snapshot.target.cost], [[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], 1]);
	});

	test('rejects cyclic targets without changing state', () => {
		const scheduler = new TestScheduler();
		const tracker = store.add(createNestedTracker(new TestClock(), scheduler));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));
		const cyclic = { ...nestedTarget('a', 'cyclic', 'cyclic', [], 1), self: undefined as unknown };
		cyclic.self = cyclic;

		assert.doesNotThrow(() => tracker.setLease('owner-a', [cyclic]));
		assert.deepStrictEqual([tracker.activeTargets(), changes, scheduler.activeTimerCount], [[], 0, 0]);
	});

	test('rejects function-bearing targets without changing state', () => {
		const scheduler = new TestScheduler();
		const tracker = store.add(createNestedTracker(new TestClock(), scheduler));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));
		const withCallback = { ...nestedTarget('a', 'callback', 'callback', [], 1), callback: () => { } };

		assert.doesNotThrow(() => tracker.setLease('owner-a', [withCallback]));
		assert.deepStrictEqual([tracker.activeTargets(), changes, scheduler.activeTimerCount], [[], 0, 0]);
	});

	test('defensively rejects a custom prototype target cast across the static contract', () => {
		const scheduler = new TestScheduler();
		const tracker = store.add(createNestedTracker(new TestClock(), scheduler));
		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));
		const unsupportedTarget = new CustomPrototypeTarget() as NestedTarget;

		assert.doesNotThrow(() => tracker.setLease('owner-a', [unsupportedTarget]));
		assert.deepStrictEqual([tracker.activeTargets(), changes, scheduler.activeTimerCount], [[], 0, 0]);
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
			await waitForMacrotask();
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
			await waitForMacrotask();
			scheduler.run();
			await waitForMacrotask();
			rejectedRenewAndRelease.setEnabled(false);
			await waitForMacrotask();

			assert.deepStrictEqual([scheduler.delays, rejectionReasons], [[PARADIS_WARM_LEASE_RENEW_INTERVAL_MS, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS], []]);
		} finally {
			globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
		}
	});

	test('contains rejected acquire, renew, and release callbacks across a macrotask before later reconciliation', async () => {
		const rejectionReasons: unknown[] = [];
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			rejectionReasons.push(event.reason);
			event.preventDefault();
		};
		globalThis.addEventListener('unhandledrejection', onUnhandledRejection);
		try {
			const acquireScheduler = new TestScheduler();
			const acquireOperations: string[] = [];
			let acquireAttempts = 0;
			const acquireController = store.add(new ParadisWarmLeaseController(
				async ownerId => {
					acquireOperations.push(`acquire:${ownerId}`);
					if (acquireAttempts++ === 0) {
						throw new Error('acquire failed');
					}
				},
				async ownerId => { acquireOperations.push(`renew:${ownerId}`); },
				async ownerId => { acquireOperations.push(`release:${ownerId}`); },
				runner => { acquireScheduler.setRunner(runner); return acquireScheduler; },
				ownerIds('acquire-first', 'acquire-second'),
			));
			acquireController.setEnabled(true);
			await waitForMacrotask();
			acquireController.setEnabled(true);
			await waitForMacrotask();

			const renewScheduler = new TestScheduler();
			const renewOperations: string[] = [];
			let renewAttempts = 0;
			const renewController = store.add(new ParadisWarmLeaseController(
				async ownerId => { renewOperations.push(`acquire:${ownerId}`); },
				async ownerId => {
					renewOperations.push(`renew:${ownerId}`);
					if (renewAttempts++ === 0) {
						throw new Error('renew failed');
					}
				},
				async ownerId => { renewOperations.push(`release:${ownerId}`); },
				runner => { renewScheduler.setRunner(runner); return renewScheduler; },
				ownerIds('renew-owner'),
			));
			renewController.setEnabled(true);
			await flushMicrotasks();
			renewScheduler.run();
			await waitForMacrotask();
			renewScheduler.run();
			await waitForMacrotask();

			const releaseScheduler = new TestScheduler();
			const releaseOperations: string[] = [];
			let releaseAttempts = 0;
			const releaseController = store.add(new ParadisWarmLeaseController(
				async ownerId => { releaseOperations.push(`acquire:${ownerId}`); },
				async ownerId => { releaseOperations.push(`renew:${ownerId}`); },
				async ownerId => {
					releaseOperations.push(`release:${ownerId}`);
					if (releaseAttempts++ === 0) {
						throw new Error('release failed');
					}
				},
				runner => { releaseScheduler.setRunner(runner); return releaseScheduler; },
				ownerIds('release-first', 'release-second'),
			));
			releaseController.setEnabled(true);
			await flushMicrotasks();
			releaseController.setEnabled(false);
			await waitForMacrotask();
			releaseController.setEnabled(true);
			await waitForMacrotask();

			assert.deepStrictEqual([
				acquireOperations,
				renewOperations,
				releaseOperations,
				rejectionReasons,
			], [[
				'acquire:acquire-first',
				'acquire:acquire-second',
			], [
				'acquire:renew-owner',
				'renew:renew-owner',
				'renew:renew-owner',
			], [
				'acquire:release-first',
				'release:release-first',
				'acquire:release-second',
			], []]);
		} finally {
			globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
		}
	});

	test('waits for a slow acquire before sending its trailing release on disable and dispose', async () => {
		const scheduler = new TestScheduler();
		const acquireGate = new Deferred();
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
		const acquireGate = new Deferred();
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
		const renewGate = new Deferred();
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
			maxDistinctTargets: 4,
			maxTotalMemberships: 8,
			maxTotalCost: 8,
			...overrides,
		},
	);
}

function createNestedTracker(clock: TestClock, scheduler: TestScheduler): ParadisWarmLeaseTracker<NestedTarget> {
	return new ParadisWarmLeaseTracker(
		target => target.key,
		(left, right) => left.value.label === right.value.label,
		target => target.cost,
		() => clock.now,
		runner => { scheduler.setRunner(runner); return scheduler; },
		{
			maxOwners: 4,
			maxTargetsPerOwner: 4,
			maxDistinctTargets: 4,
			maxTotalMemberships: 8,
			maxTotalCost: 8,
		},
	);
}

function target(key: string, value: string, cost = 1): Target {
	return { key, value, cost };
}

function nestedTarget(key: string, label: string, state: string, tags: string[], cost: number): NestedTarget {
	return { key, value: { label, details: { state } }, tags, optional: undefined, cost };
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

function waitForMacrotask(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function mutateTarget(target: Target, key: string, value: string, cost: number): void {
	Reflect.set(target, 'key', key);
	Reflect.set(target, 'value', value);
	Reflect.set(target, 'cost', cost);
}

function mutateNestedTarget(target: NestedTarget, label: string, state: string, tag: string, cost: number): void {
	Reflect.set(target.value, 'label', label);
	Reflect.set(target.value.details, 'state', state);
	Reflect.set(target.tags, String(target.tags.length), tag);
	Reflect.set(target, 'cost', cost);
}

class TestClock {
	now = 0;
}

class TestScheduler implements IParadisWarmLeaseScheduler {
	readonly delays: number[] = [];
	runCount = 0;
	private runner: () => void = () => { };
	private pending = false;
	private disposed = false;

	setRunner(runner: () => void): void {
		this.runner = runner;
	}

	get activeTimerCount(): number {
		return this.pending ? 1 : 0;
	}

	schedule(delay: number): void {
		this.throwIfDisposed();
		this.delays.push(delay);
		this.pending = true;
	}

	cancel(): void {
		this.throwIfDisposed();
		this.pending = false;
	}

	dispose(): void {
		this.pending = false;
		this.disposed = true;
	}

	run(): void {
		if (!this.pending) {
			return;
		}
		this.pending = false;
		this.runCount++;
		this.runner();
	}

	runCallback(): void {
		this.runCount++;
		this.runner();
	}

	private throwIfDisposed(): void {
		if (this.disposed) {
			throw new Error('scheduler operation after disposal');
		}
	}
}

class Deferred {
	readonly promise: Promise<void>;
	private resolvePromise!: () => void;

	constructor() {
		this.promise = new Promise<void>(resolve => this.resolvePromise = resolve);
	}

	resolve(): void {
		this.resolvePromise();
	}
}

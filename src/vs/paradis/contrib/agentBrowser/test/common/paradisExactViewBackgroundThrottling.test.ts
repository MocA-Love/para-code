/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS,
	ParadisExactViewBackgroundThrottlingCoordinator,
	ParadisExactViewBackgroundThrottlingDispatcher,
	ParadisExactViewBackgroundThrottlingError,
} from '../../common/paradisExactViewBackgroundThrottling.js';

suite('ParadisExactViewBackgroundThrottlingCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const exactA = Object.freeze({ windowId: 1, viewId: 'view', targetId: 'target', viewLease: 'lease' });

	test('disables on the first exact reference and restores only after the last release', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();

		assert.deepStrictEqual(coordinator.setBinding('token-a', exactA), [
			{ descriptor: exactA, enabled: false },
		]);
		assert.deepStrictEqual(coordinator.setBinding('token-b', exactA), []);
		assert.strictEqual(coordinator.bindingCount, 2);
		assert.strictEqual(coordinator.exactViewCount, 1);

		assert.deepStrictEqual(coordinator.releaseBinding('token-a'), []);
		assert.deepStrictEqual(coordinator.releaseBinding('token-b'), [
			{ descriptor: exactA, enabled: true },
		]);
		assert.deepStrictEqual(coordinator.releaseBinding('token-b'), []);
		assert.deepStrictEqual(coordinator.releaseBinding('unknown'), []);
		assert.strictEqual(coordinator.bindingCount, 0);
		assert.strictEqual(coordinator.exactViewCount, 0);
	});

	test('treats an unchanged replacement as a no-op and transfers a changed exact identity', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		const exactB = Object.freeze({ windowId: 2, viewId: 'view-b', targetId: 'target-b', viewLease: 'lease-b' });

		coordinator.setBinding('token', exactA);
		assert.deepStrictEqual(coordinator.setBinding('token', { ...exactA }), []);
		assert.deepStrictEqual(coordinator.setBinding('token', exactB), [
			{ descriptor: exactB, enabled: false },
			{ descriptor: exactA, enabled: true },
		]);
		assert.strictEqual(coordinator.bindingCount, 1);
		assert.strictEqual(coordinator.exactViewCount, 1);
	});

	test('preserves both old and new exact refcounts while other tokens still reference them', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		const exactB = Object.freeze({ windowId: 2, viewId: 'view-b', targetId: 'target-b', viewLease: 'lease-b' });
		coordinator.setBinding('old-a', exactA);
		coordinator.setBinding('old-b', exactA);
		coordinator.setBinding('new-a', exactB);

		assert.deepStrictEqual(coordinator.setBinding('old-a', exactB), []);
		assert.deepStrictEqual(coordinator.releaseBinding('old-b'), [
			{ descriptor: exactA, enabled: true },
		]);
		assert.deepStrictEqual(coordinator.releaseBinding('old-a'), []);
		assert.deepStrictEqual(coordinator.releaseBinding('new-a'), [
			{ descriptor: exactB, enabled: true },
		]);
	});

	test('includes window, view, target, and lease in exact identity', () => {
		const variants = [
			{ ...exactA, windowId: 2 },
			{ ...exactA, viewId: 'other-view' },
			{ ...exactA, targetId: 'other-target' },
			{ ...exactA, viewLease: 'other-lease' },
		];

		for (const [index, variant] of variants.entries()) {
			const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
			coordinator.setBinding('first', exactA);
			assert.deepStrictEqual(coordinator.setBinding(`second-${index}`, variant), [
				{ descriptor: variant, enabled: false },
			]);
			assert.strictEqual(coordinator.exactViewCount, 2);
		}
	});

	test('copy-owns descriptors and returns immutable effects', () => {
		const source = { windowId: 1, viewId: 'owned-view', targetId: 'owned-target', viewLease: 'owned-lease' };
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		const acquired = coordinator.setBinding('token', source);
		source.windowId = 9;
		source.viewId = 'mutated-view';
		source.targetId = 'mutated-target';
		source.viewLease = 'mutated-lease';

		const expectedDescriptor = { windowId: 1, viewId: 'owned-view', targetId: 'owned-target', viewLease: 'owned-lease' };
		assert.deepStrictEqual(acquired, [{ descriptor: expectedDescriptor, enabled: false }]);
		const released = coordinator.releaseBinding('token');
		assert.deepStrictEqual(released, [{ descriptor: expectedDescriptor, enabled: true }]);
		assert.strictEqual(Object.isFrozen(acquired), true);
		assert.strictEqual(Object.isFrozen(acquired[0]), true);
		assert.strictEqual(Object.isFrozen(acquired[0].descriptor), true);
		assert.strictEqual(Object.isFrozen(released), true);
	});

	test('rejects invalid input and capacity overflow without mutating state', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator({ maximumBindings: 2, maximumExactViews: 1 });
		coordinator.setBinding('first', exactA);
		coordinator.setBinding('second', exactA);

		assert.throws(
			() => coordinator.setBinding('third', exactA),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'bindingCapacity',
		);
		assert.throws(
			() => coordinator.setBinding('', exactA),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'invalidToken',
		);
		assert.throws(
			() => coordinator.setBinding('first', { ...exactA, viewLease: '' }),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'invalidDescriptor',
		);
		assert.strictEqual(coordinator.bindingCount, 2);
		assert.strictEqual(coordinator.exactViewCount, 1);

		coordinator.releaseBinding('second');
		const exactB = { ...exactA, viewLease: 'next-lease' };
		assert.deepStrictEqual(coordinator.setBinding('first', exactB), [
			{ descriptor: exactB, enabled: false },
			{ descriptor: exactA, enabled: true },
		]);
		assert.strictEqual(coordinator.bindingCount, 1);
		assert.strictEqual(coordinator.exactViewCount, 1);

		assert.throws(
			() => coordinator.setBinding('other', exactA),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'exactViewCapacity',
		);
		assert.strictEqual(coordinator.bindingCount, 1);
		assert.strictEqual(coordinator.exactViewCount, 1);
	});

	test('enforces the shared service binding safety cap', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		for (let index = 0; index < PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS; index++) {
			coordinator.setBinding(`token-${index}`, exactA);
		}

		assert.strictEqual(coordinator.bindingCount, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS);
		assert.throws(
			() => coordinator.setBinding('overflow', exactA),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'bindingCapacity',
		);
		assert.strictEqual(coordinator.bindingCount, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS);
	});

	test('non-destructively validates the complete external registry before a prospective set', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		const exactB = Object.freeze({ windowId: 1, viewId: 'view-b', targetId: 'target-b', viewLease: 'lease-b' });
		coordinator.setBinding('token-a', exactA);
		coordinator.setBinding('token-b', exactA);

		coordinator.assertCanSetBinding([
			['token-a', exactA],
			['token-b', exactA],
		], 'token-a', exactB);
		assert.strictEqual(coordinator.bindingCount, 2);
		assert.strictEqual(coordinator.exactViewCount, 1);
		assert.deepStrictEqual(coordinator.setBinding('token-a', exactB), [
			{ descriptor: exactB, enabled: false },
		]);
	});

	test('rejects every external/coordinator token, exact identity, and refcount drift without mutation', () => {
		const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
		coordinator.setBinding('token-a', exactA);
		coordinator.setBinding('token-b', exactA);
		const exactB = Object.freeze({ ...exactA, viewLease: 'lease-b' });

		for (const snapshot of [
			[['token-a', exactA]] as const,
			[['token-a', exactA], ['token-b', exactA], ['extra', exactA]] as const,
			[['token-a', exactA], ['token-c', exactA]] as const,
			[['token-a', exactA], ['token-b', exactB]] as const,
		]) {
			assert.throws(
				() => coordinator.assertCanSetBinding(snapshot, 'token-a', exactB),
				error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'stateMismatch',
			);
		}

		assert.strictEqual(coordinator.bindingCount, 2);
		assert.strictEqual(coordinator.exactViewCount, 1);
		assert.deepStrictEqual(coordinator.releaseBinding('token-a'), []);
		assert.deepStrictEqual(coordinator.releaseBinding('token-b'), [{ descriptor: exactA, enabled: true }]);

		const refcountDrift = new ParadisExactViewBackgroundThrottlingCoordinator();
		refcountDrift.setBinding('token-a', exactA);
		refcountDrift.setBinding('token-b', exactA);
		const internalReferences = Reflect.get(refcountDrift, 'exactReferences') as Map<string, { refCount: number }>;
		internalReferences.values().next().value!.refCount = 1;
		assert.throws(
			() => refcountDrift.assertCanSetBinding([
				['token-a', exactA],
				['token-b', exactA],
			], 'token-a', exactB),
			error => error instanceof ParadisExactViewBackgroundThrottlingError && error.reason === 'stateMismatch',
		);
	});
});

suite('ParadisExactViewBackgroundThrottlingDispatcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const exact = Object.freeze({ windowId: 1, viewId: 'view', targetId: 'target', viewLease: 'lease' });

	test('serializes and coalesces a desired-state change for one exact view', async () => {
		const calls: boolean[] = [];
		const failures: boolean[] = [];
		let settleFirst!: (result: boolean) => void;
		const first = new Promise<boolean>(resolve => settleFirst = resolve);
		const dispatcher = new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: async effect => {
				calls.push(effect.enabled);
				return calls.length === 1 ? first : true;
			},
			onDisableFailure: () => failures.push(true),
		});

		dispatcher.dispatchEffects([{ descriptor: exact, enabled: false }]);
		dispatcher.dispatchEffects([{ descriptor: exact, enabled: true }]);
		assert.deepStrictEqual(calls, [false]);
		settleFirst(false);
		await dispatcher.whenIdle();

		assert.deepStrictEqual(calls, [false, true]);
		assert.deepStrictEqual(failures, []);
		assert.strictEqual(dispatcher.pendingExactViewCount, 0);
	});

	test('coalesces a duplicate desired state without issuing the same Main effect twice', async () => {
		let settle!: (result: boolean) => void;
		const pending = new Promise<boolean>(resolve => settle = resolve);
		let attempts = 0;
		const dispatcher = new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: () => {
				attempts++;
				return pending;
			},
			onDisableFailure: () => assert.fail('disable succeeds'),
		});

		dispatcher.dispatchEffects([{ descriptor: exact, enabled: false }]);
		dispatcher.dispatchEffects([{ descriptor: exact, enabled: false }]);
		const idle = dispatcher.whenIdle();
		assert.strictEqual(dispatcher.whenIdle(), idle);
		settle(true);
		await idle;

		assert.strictEqual(attempts, 1);
	});

	test('retries a rejected disable boundedly before reporting the still-current exact view', async () => {
		let attempts = 0;
		const failures: unknown[] = [];
		const dispatcher = new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: async () => {
				attempts++;
				throw new Error('transport unavailable');
			},
			onDisableFailure: descriptor => failures.push(descriptor),
		});

		dispatcher.dispatchEffects([{ descriptor: exact, enabled: false }]);
		await dispatcher.whenIdle();

		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(failures, [exact]);
		assert.strictEqual(dispatcher.pendingExactViewCount, 0);
	});

	test('retries restore only while unreferenced and treats an absent exact view as converged', async () => {
		const calls: boolean[] = [];
		const dispatcher = new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: async effect => {
				calls.push(effect.enabled);
				if (calls.length < 3) {
					throw new Error('transport unavailable');
				}
				return false;
			},
			onDisableFailure: () => assert.fail('restore must not retire bindings'),
		});

		dispatcher.dispatchEffects([{ descriptor: exact, enabled: true }]);
		await dispatcher.whenIdle();

		assert.deepStrictEqual(calls, [true, true, true]);
		assert.strictEqual(dispatcher.pendingExactViewCount, 0);
	});

	test('clears pending state on dispose and ignores a late completion', async () => {
		let settle!: (result: boolean) => void;
		const operation = new Promise<boolean>(resolve => settle = resolve);
		let failureCount = 0;
		const dispatcher = new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: () => operation,
			onDisableFailure: () => failureCount++,
		});

		dispatcher.dispatchEffects([{ descriptor: exact, enabled: false }]);
		assert.strictEqual(dispatcher.pendingExactViewCount, 1);
		dispatcher.dispose();
		assert.strictEqual(dispatcher.pendingExactViewCount, 0);
		settle(false);
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(failureCount, 0);
	});
});

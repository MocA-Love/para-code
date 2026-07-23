/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionGithubBackgroundRefreshScheduler } from '../../browser/sessionGithubBackgroundPolling.js';

class TestModel {
	refreshCalls = 0;
	refresh(): Promise<void> {
		this.refreshCalls++;
		return Promise.resolve();
	}
}

suite('SessionGithubBackgroundRefreshScheduler', () => {

	const store = new DisposableStore();
	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	let now = 0;

	function createScheduler(): SessionGithubBackgroundRefreshScheduler {
		now = 1_000_000;
		return store.add(new SessionGithubBackgroundRefreshScheduler(new NullLogService(), () => now));
	}

	test('serves cold models first, one per tick, in registration order', () => {
		const scheduler = createScheduler();
		const a = new TestModel();
		const b = new TestModel();
		store.add(scheduler.register(a, false));
		store.add(scheduler.register(b, false));

		scheduler.tick();
		assert.deepStrictEqual([a.refreshCalls, b.refreshCalls], [1, 0]);

		scheduler.tick();
		assert.deepStrictEqual([a.refreshCalls, b.refreshCalls], [1, 1]);

		// Both fetched and within the per-model interval → nothing to do.
		scheduler.tick();
		assert.deepStrictEqual([a.refreshCalls, b.refreshCalls], [1, 1]);
	});

	test('refreshes the least-recently refreshed model once its interval elapsed', () => {
		const scheduler = createScheduler();
		const a = new TestModel();
		const b = new TestModel();
		store.add(scheduler.register(a, false));
		store.add(scheduler.register(b, false));

		scheduler.tick(); // a
		now += 5_000;
		scheduler.tick(); // b

		// Just before a's interval elapses → idle.
		now += 894_999;
		scheduler.tick();
		assert.deepStrictEqual([a.refreshCalls, b.refreshCalls], [1, 1]);

		// a is now eligible (and older than b).
		now += 1;
		scheduler.tick();
		assert.deepStrictEqual([a.refreshCalls, b.refreshCalls], [2, 1]);
	});

	test('a model with data already waits a full interval instead of being served as cold', () => {
		const scheduler = createScheduler();
		const warm = new TestModel();
		const cold = new TestModel();
		store.add(scheduler.register(warm, true));
		store.add(scheduler.register(cold, false));

		scheduler.tick();
		scheduler.tick();
		assert.deepStrictEqual([warm.refreshCalls, cold.refreshCalls], [0, 1]);

		now += 900_000;
		scheduler.tick();
		assert.deepStrictEqual([warm.refreshCalls, cold.refreshCalls], [1, 1]);
	});

	test('reference-counts duplicate registrations of the same model', () => {
		const scheduler = createScheduler();
		const model = new TestModel();
		const first = scheduler.register(model, false);
		const second = scheduler.register(model, false);

		scheduler.tick();
		scheduler.tick();
		assert.strictEqual(model.refreshCalls, 1);

		first.dispose();
		now += 900_000;
		scheduler.tick();
		assert.strictEqual(model.refreshCalls, 2);

		second.dispose();
		now += 900_000;
		scheduler.tick();
		assert.strictEqual(model.refreshCalls, 2);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSessionResumeRefreshScheduler, ParadisSessionResumeRefreshController } from '../../electron-browser/paradisSessionResumeRefreshController.js';

suite('ParadisSessionResumeRefreshController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('defers hidden invalidations until the editor becomes visible', async () => {
		const scheduler = new TestScheduler();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => { runCount++; }));

		controller.start();
		controller.setVisible(false);
		controller.invalidate();
		controller.invalidate();
		assert.strictEqual(runCount, 0);
		assert.deepStrictEqual(scheduler.delays, []);

		controller.setVisible(true);
		assert.deepStrictEqual(scheduler.delays, [0]);
		await scheduler.run();
		assert.strictEqual(runCount, 1);
	});

	test('uses one fixed 750ms automatic refresh window', async () => {
		const scheduler = new TestScheduler();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => { runCount++; }));

		controller.start();
		controller.invalidate();
		controller.invalidate();

		assert.deepStrictEqual(scheduler.delays, [750]);
		await scheduler.run();
		assert.strictEqual(runCount, 1);
	});

	test('runs an immediate request without waiting for an automatic timer', async () => {
		const scheduler = new TestScheduler();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => { runCount++; }));

		controller.start();
		controller.invalidate();
		controller.requestImmediate();

		assert.strictEqual(scheduler.cancelCount, 1);
		assert.strictEqual(runCount, 1);
		await flushMicrotasks();
		assert.strictEqual(runCount, 1);
	});

	test('coalesces in-flight automatic and immediate requests into one trailing run', async () => {
		const scheduler = new TestScheduler();
		const first = new DeferredPromise<void>();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => {
			runCount++;
			if (runCount === 1) {
				await first.p;
			}
		}));

		controller.start();
		controller.requestImmediate();
		controller.invalidate();
		controller.invalidate();
		controller.requestImmediate();
		assert.strictEqual(runCount, 1);

		first.complete();
		await flushMicrotasks();
		assert.strictEqual(runCount, 2);
		await flushMicrotasks();
		assert.strictEqual(runCount, 2);
	});

	test('retains hidden invalidations that arrive while a refresh is in flight', async () => {
		const scheduler = new TestScheduler();
		const first = new DeferredPromise<void>();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => {
			runCount++;
			if (runCount === 1) {
				await first.p;
			}
		}));

		controller.start();
		controller.requestImmediate();
		controller.setVisible(false);
		controller.invalidate();
		first.complete();
		await flushMicrotasks();
		assert.strictEqual(runCount, 1);
		assert.deepStrictEqual(scheduler.delays, []);

		controller.setVisible(true);
		assert.deepStrictEqual(scheduler.delays, [0]);
		await scheduler.run();
		assert.strictEqual(runCount, 2);
	});

	test('does not automatically retry a failed refresh without a newer request', async () => {
		const scheduler = new TestScheduler();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => {
			runCount++;
			throw new Error('list failed');
		}));

		controller.start();
		controller.requestImmediate();
		await flushMicrotasks();

		assert.strictEqual(runCount, 1);
		assert.deepStrictEqual(scheduler.delays, []);
	});

	test('cancels scheduling and ignores a late completion after disposal', async () => {
		const scheduler = new TestScheduler();
		const pending = new DeferredPromise<void>();
		let runCount = 0;
		const controller = createController(scheduler, async () => {
			runCount++;
			await pending.p;
		});

		controller.start();
		controller.invalidate();
		controller.requestImmediate();
		controller.requestImmediate();
		controller.dispose();
		pending.complete();
		await flushMicrotasks();

		assert.strictEqual(runCount, 1);
		assert.strictEqual(scheduler.cancelCount, 1);
		assert.deepStrictEqual(scheduler.delays, [750]);
	});

	test('shares one pending completion until the trailing immediate refresh settles', async () => {
		const scheduler = new TestScheduler();
		const first = new DeferredPromise<void>();
		const second = new DeferredPromise<void>();
		let runCount = 0;
		const controller = store.add(createController(scheduler, async () => {
			runCount++;
			await (runCount === 1 ? first.p : second.p);
		}));

		controller.start();
		controller.requestImmediate();
		const pendingOne = controller.requestImmediate();
		const pendingTwo = controller.requestImmediate();
		assert.strictEqual(pendingOne, pendingTwo);

		first.complete();
		await flushMicrotasks();
		assert.strictEqual(runCount, 2);
		let settled = false;
		void pendingOne.then(() => { settled = true; });
		await flushMicrotasks();
		assert.strictEqual(settled, false);

		second.complete();
		await pendingOne;
		assert.strictEqual(settled, true);
	});

	test('settles the shared pending completion when disposed', async () => {
		const scheduler = new TestScheduler();
		const running = new DeferredPromise<void>();
		const controller = createController(scheduler, async () => running.p);

		controller.start();
		controller.requestImmediate();
		const pendingOne = controller.requestImmediate();
		const pendingTwo = controller.requestImmediate();
		assert.strictEqual(pendingOne, pendingTwo);
		controller.dispose();
		await pendingOne;
	});
});

function createController(scheduler: TestScheduler, run: () => Promise<void>): ParadisSessionResumeRefreshController {
	return new ParadisSessionResumeRefreshController(run, runner => {
		scheduler.setRunner(runner);
		return scheduler;
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
	}
}

class TestScheduler implements IParadisSessionResumeRefreshScheduler {
	readonly delays: number[] = [];
	cancelCount = 0;
	private runner: () => void = () => { };

	setRunner(runner: () => void): void {
		this.runner = runner;
	}

	schedule(delay: number): void {
		this.delays.push(delay);
	}

	cancel(): void {
		this.cancelCount++;
	}

	dispose(): void { }

	async run(): Promise<void> {
		this.runner();
		await flushMicrotasks();
	}
}

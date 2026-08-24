/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisKeepAwakeMode } from '../../common/paradisKeepAwake.js';
import { ParadisKeepAwakeController, ParadisKeepAwakeFailureOperation } from '../../common/paradisKeepAwakeController.js';

suite('ParadisKeepAwakeController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createController(options: {
		start(mode: Exclude<ParadisKeepAwakeMode, 'off'>): Promise<number>;
		stop(id: number): Promise<void>;
	}) {
		const modes: ParadisKeepAwakeMode[] = [];
		const reports: Array<{ operation: ParadisKeepAwakeFailureOperation; error: unknown }> = [];
		const controller = new ParadisKeepAwakeController({
			start: options.start,
			stop: options.stop,
			onDidChangeMode: mode => modes.push(mode),
			report: (operation, error) => reports.push({ operation, error }),
		});
		return { controller, modes, reports };
	}

	test('start rejection leaves actual mode off and reports a start failure', async () => {
		const failure = new Error('start failed');
		const fixture = createController({
			start: async () => { throw failure; },
			stop: async () => { },
		});

		await fixture.controller.setMode('system');

		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(fixture.modes, []);
		assert.deepStrictEqual(fixture.reports, [{ operation: 'blocker-start-failed', error: failure }]);
		fixture.controller.dispose();
	});

	test('a successful start publishes the requested system mode', async () => {
		const fixture = createController({
			start: async () => 17,
			stop: async () => { },
		});

		await fixture.controller.setMode('system');

		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(fixture.modes, ['system']);
		assert.deepStrictEqual(fixture.reports, []);
		fixture.controller.dispose();
		await fixture.controller.whenSettled();
	});

	test('stop rejection retains the id and retries the same id on the next reconcile', async () => {
		const stopped: number[] = [];
		let stopAttempts = 0;
		const failure = new Error('stop failed');
		const fixture = createController({
			start: async () => 41,
			stop: async id => {
				stopped.push(id);
				if (stopAttempts++ === 0) {
					throw failure;
				}
			},
		});

		await fixture.controller.setMode('system');
		await fixture.controller.setMode('off');
		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(fixture.reports, [{ operation: 'blocker-stop-failed', error: failure }]);

		await fixture.controller.reconcile();
		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(stopped, [41, 41]);
		fixture.controller.dispose();
	});

	test('display to system keeps reporting display while the old display blocker cannot stop', async () => {
		const starts: Array<Exclude<ParadisKeepAwakeMode, 'off'>> = [];
		let nextId = 1;
		let failDisplayStop = true;
		const fixture = createController({
			start: async mode => {
				starts.push(mode);
				return nextId++;
			},
			stop: async id => {
				if (id === 1 && failDisplayStop) {
					failDisplayStop = false;
					throw new Error('display stop failed');
				}
			},
		});

		await fixture.controller.setMode('display');
		await fixture.controller.setMode('system');
		assert.strictEqual(fixture.controller.actualMode, 'display');

		await fixture.controller.reconcile();
		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(starts, ['display', 'system']);
		fixture.controller.dispose();
		await fixture.controller.whenSettled();
	});

	test('a start that resolves after off is requested is still stopped and not leaked', async () => {
		const start = new DeferredPromise<number>();
		const stopped: number[] = [];
		let startCalled = false;
		const fixture = createController({
			start: async () => {
				startCalled = true;
				return start.p;
			},
			stop: async id => { stopped.push(id); },
		});

		const display = fixture.controller.setMode('display');
		while (!startCalled) {
			await Promise.resolve();
		}
		const off = fixture.controller.setMode('off');
		start.complete(73);
		await Promise.all([display, off]);

		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(stopped, [73]);
		fixture.controller.dispose();
	});

	test('dispose stops every successfully owned blocker', async () => {
		const stopped: number[] = [];
		const fixture = createController({
			start: async () => 91,
			stop: async id => { stopped.push(id); },
		});

		await fixture.controller.setMode('system');
		fixture.controller.dispose();
		await fixture.controller.whenSettled();

		assert.deepStrictEqual(stopped, [91]);
		assert.strictEqual(fixture.controller.actualMode, 'off');
	});

	test('dispose attempts every owned blocker even when one stop keeps failing', async () => {
		let nextId = 1;
		const stopped: number[] = [];
		const fixture = createController({
			start: async () => nextId++,
			stop: async id => {
				stopped.push(id);
				if (id === 1) {
					throw new Error('display stop failed');
				}
			},
		});

		await fixture.controller.setMode('display');
		await fixture.controller.setMode('system');
		fixture.controller.dispose();
		await fixture.controller.whenSettled();

		assert.deepStrictEqual(stopped, [1, 1, 2]);
		assert.strictEqual(fixture.controller.actualMode, 'display');
	});
});

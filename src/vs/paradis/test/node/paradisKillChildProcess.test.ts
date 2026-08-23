/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisChildProcessTreeTracker } from '../../node/paradisKillChildProcess.js';

suite('ParadisChildProcessTreeTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => {
		sinon.restore();
	});

	function child() {
		const kill = sinon.spy(() => true);
		return {
			process: {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as cp.ChildProcess,
			kill,
		};
	}

	test('starts tree termination at the deadline while reporting a timeout', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		const execution = tracker.track(fixture.process, 60_000);

		clock.tick(59_999);
		assert.strictEqual(execution.timedOut, false);
		assert.strictEqual(fixture.kill.callCount, 0);

		clock.tick(1);
		assert.strictEqual(execution.timedOut, true);
		assert.strictEqual(fixture.kill.callCount, 1);

		execution.dispose();
		tracker.dispose();
		assert.strictEqual(fixture.kill.callCount, 1);
	});

	test('normal completion clears the deadline without terminating the child', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		const execution = tracker.track(fixture.process, 60_000);

		execution.dispose();
		clock.tick(60_000);
		tracker.dispose();

		assert.strictEqual(execution.timedOut, false);
		assert.strictEqual(fixture.kill.callCount, 0);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('owner disposal clears the deadline and terminates each active child once', () => {
		const first = child();
		const second = child();
		const tracker = new ParadisChildProcessTreeTracker();
		tracker.track(first.process, 60_000);
		tracker.track(second.process, 60_000);

		tracker.dispose();
		clock.tick(60_000);
		tracker.dispose();

		assert.deepStrictEqual([first.kill.callCount, second.kill.callCount], [1, 1]);
		assert.strictEqual(clock.countTimers(), 0);
	});
});

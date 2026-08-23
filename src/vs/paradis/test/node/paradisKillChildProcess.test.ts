/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { type IParadisChildProcessTreeTerminationOptions, ParadisChildProcessTreeTracker, paradisKillChildProcessTree } from '../../node/paradisKillChildProcess.js';

suite('ParadisChildProcessTreeTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => {
		sinon.restore();
	});

	function child({ pid, exitCode = null, signalCode = null, kill = sinon.spy(() => true) }: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill?: sinon.SinonSpy } = {}) {
		return {
			process: {
				pid,
				exitCode,
				signalCode,
				kill,
			} as unknown as cp.ChildProcess,
			kill,
		};
	}

	function terminationOptions(platform: NodeJS.Platform, treeKill = sinon.stub().resolves(), terminator?: (child: cp.ChildProcess) => void): IParadisChildProcessTreeTerminationOptions {
		return { platform, treeKill, terminator };
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

	test('uses Windows tree kill at the deadline instead of direct child termination', () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().resolves();
		const tracker = new ParadisChildProcessTreeTracker(undefined, terminationOptions('win32', treeKill));
		const execution = tracker.track(fixture.process, 60_000);

		clock.tick(60_000);

		assert.strictEqual(treeKill.callCount, 1);
		assert.deepStrictEqual(treeKill.firstCall.args, [123, true]);
		assert.strictEqual(fixture.kill.callCount, 0);
		assert.strictEqual(execution.timedOut, true);
	});

	test('falls back to direct termination once when Windows tree kill rejects and reporting fails', async () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().rejects(new Error('tree kill failed'));
		const reporter = sinon.stub().throws(new Error('reporting failed'));

		assert.doesNotThrow(() => paradisKillChildProcessTree(fixture.process, reporter, terminationOptions('win32', treeKill)));
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(treeKill.callCount, 1);
		assert.deepStrictEqual(treeKill.firstCall.args, [123, true]);
		assert.strictEqual(reporter.callCount, 1);
		assert.strictEqual(fixture.kill.callCount, 1);
	});

	test('falls back to direct termination once when Windows tree kill throws synchronously', () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().throws(new Error('tree kill failed'));
		const reporter = sinon.stub().throws(new Error('reporting failed'));

		assert.doesNotThrow(() => paradisKillChildProcessTree(fixture.process, reporter, terminationOptions('win32', treeKill)));

		assert.strictEqual(treeKill.callCount, 1);
		assert.deepStrictEqual(treeKill.firstCall.args, [123, true]);
		assert.strictEqual(reporter.callCount, 1);
		assert.strictEqual(fixture.kill.callCount, 1);
	});

	test('does not terminate an exited Windows child with a reusable PID', () => {
		const fixture = child({ pid: 123, exitCode: 0 });
		const treeKill = sinon.stub().resolves();

		paradisKillChildProcessTree(fixture.process, undefined, terminationOptions('win32', treeKill));

		assert.strictEqual(treeKill.callCount, 0);
		assert.strictEqual(fixture.kill.callCount, 0);
	});

	test('uses the injected direct terminator outside Windows', () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().resolves();
		const terminator = sinon.spy();

		paradisKillChildProcessTree(fixture.process, undefined, terminationOptions('linux', treeKill, terminator));

		assert.strictEqual(treeKill.callCount, 0);
		assert.strictEqual(terminator.callCount, 1);
		assert.strictEqual(terminator.firstCall.args[0], fixture.process);
		assert.strictEqual(fixture.kill.callCount, 0);
	});

	test('continues owner disposal when direct termination and reporting throw', () => {
		const first = child({ kill: sinon.spy(() => { throw new Error('direct kill failed'); }) });
		const second = child();
		const reporter = sinon.stub().throws(new Error('reporting failed'));
		const tracker = new ParadisChildProcessTreeTracker(reporter, terminationOptions('linux'));
		tracker.track(first.process, 60_000);
		tracker.track(second.process, 60_000);

		assert.doesNotThrow(() => tracker.dispose());

		assert.deepStrictEqual([first.kill.callCount, second.kill.callCount], [1, 1]);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('immediately terminates a child tracked after owner disposal without leaving a timer', () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().resolves();
		const tracker = new ParadisChildProcessTreeTracker(undefined, terminationOptions('win32', treeKill));
		tracker.dispose();

		const execution = tracker.track(fixture.process, 60_000);
		execution.dispose();
		tracker.dispose();

		assert.strictEqual(treeKill.callCount, 1);
		assert.deepStrictEqual(treeKill.firstCall.args, [123, true]);
		assert.strictEqual(fixture.kill.callCount, 0);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('keeps a timed out execution active until its callback completes', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		const execution = tracker.track(fixture.process, 60_000);

		assert.strictEqual(tracker.activeCount, 1);
		clock.tick(60_000);
		assert.strictEqual(tracker.activeCount, 1);

		execution.dispose();
		assert.strictEqual(tracker.activeCount, 0);
	});

	test('owner disposal after the deadline is harmless before the callback completes', () => {
		const fixture = child({ pid: 123 });
		const treeKill = sinon.stub().resolves();
		const tracker = new ParadisChildProcessTreeTracker(undefined, terminationOptions('win32', treeKill));
		const execution = tracker.track(fixture.process, 60_000);

		clock.tick(60_000);
		tracker.dispose();
		execution.dispose();

		assert.strictEqual(treeKill.callCount, 1);
		assert.strictEqual(tracker.activeCount, 0);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('allows a synchronous consumer callback to avoid creating tracker ownership', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		let execution: ReturnType<ParadisChildProcessTreeTracker['track']> | undefined;
		let callbackCompleted = false;
		const callback = () => {
			callbackCompleted = true;
			execution?.dispose();
		};

		callback();
		if (!callbackCompleted) {
			execution = tracker.track(fixture.process, 60_000);
		}
		tracker.dispose();

		assert.strictEqual(tracker.activeCount, 0);
		assert.strictEqual(fixture.kill.callCount, 0);
		assert.strictEqual(clock.countTimers(), 0);
	});
});

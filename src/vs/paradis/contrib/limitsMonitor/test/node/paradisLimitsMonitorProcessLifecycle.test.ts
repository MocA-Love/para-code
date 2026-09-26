/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisLimitsMonitorService } from '../../node/paradisLimitsMonitorChannel.js';

suite('ParadisLimitsMonitor process lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('tracks the executable probe without using a Node timeout', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null) => void) | undefined;
		let timeoutOption: number | undefined;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			timeoutOption = options.timeout;
			callback = cb;
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);
		const probe = (service as unknown as { canExecute(command: string): Promise<boolean> }).canExecute('codex');

		await clock.tickAsync(10_000);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });
		callback!(Object.assign(new Error('terminated'), { killed: false }));
		assert.strictEqual(await probe, false);
		await clock.tickAsync(10_000);
		assert.strictEqual(kill.callCount, 1);
		service.dispose();
	});

	test('releases the executable probe deadline after a successful callback', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null) => void) | undefined;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			callback = cb;
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);
		const probe = (service as unknown as { canExecute(command: string): Promise<boolean> }).canExecute('codex');

		while (!callback) {
			await Promise.resolve();
		}
		callback(null);
		assert.strictEqual(await probe, true);
		await clock.tickAsync(10_001);
		service.dispose();
		assert.deepStrictEqual({ kills: kill.callCount, timers: clock.countTimers() }, { kills: 0, timers: 0 });
	});
});

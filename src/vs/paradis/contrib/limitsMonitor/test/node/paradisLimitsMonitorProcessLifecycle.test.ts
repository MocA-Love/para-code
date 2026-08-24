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

	test('tree-kills cswap at its explicit deadline and does not leave a Node timeout', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) | undefined;
		let timeoutOption: number | undefined;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			timeoutOption = options.timeout;
			callback = cb;
			return {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
				stdin: { write() { }, end() { } },
			} as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);

		const pending = service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [] });
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });
		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await pending;
		service.dispose();
	});

	test('service disposal cancels the deadline and terminates the active child once', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let started = false;
		const execFile = (() => {
			started = true;
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);

		void service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [] });
		while (!started) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(60_000);

		assert.strictEqual(kill.callCount, 1);
		assert.strictEqual(clock.countTimers(), 0);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

suite('ParadisCcusage process lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('tree-kills at 60 seconds and classifies the explicit deadline without an offline retry', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) | undefined;
		let timeoutOption: number | undefined;
		let invocations = 0;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			invocations++;
			timeoutOption = options.timeout;
			callback = cb;
			return {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		const pending = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.strictEqual(kill.callCount, 1);
		assert.strictEqual(timeoutOption, undefined);

		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await assert.rejects(pending, /terminated/);
		assert.strictEqual(invocations, 1, 'an explicitly timed out execution must not retry with --offline');
		service.dispose();
	});

	test('rejects a successful callback that follows the deadline without retrying or caching it', async () => {
		const clock = sinon.useFakeTimers();
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const invocations: string[][] = [];
		const execFile = ((_file: string, args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			callbacks.push(callback);
			invocations.push([...args]);
			return { pid: undefined, exitCode: null, signalCode: null, kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		const expired = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		callbacks[0](null, JSON.stringify({ daily: [{ period: 'late' }] }), '');
		await assert.rejects(expired, /timed out/);

		const refreshed = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (callbacks.length < 2) {
			await Promise.resolve();
		}
		callbacks[1](null, JSON.stringify({ daily: [{ period: 'fresh' }] }), '');
		assert.deepStrictEqual(await refreshed, [{ period: 'fresh' }]);
		assert.deepStrictEqual(invocations, [['daily', '--json'], ['daily', '--json']]);
		service.dispose();
	});

	test('does not retain a deadline for a synchronous callback', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			callback(null, JSON.stringify({ daily: [] }), '');
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kill.callCount, timers: clock.countTimers() }, { kills: 0, timers: 0 });
		service.dispose();
	});

	test('disposes deadlines after an asynchronous callback and all active children on service disposal', async () => {
		const clock = sinon.useFakeTimers();
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const kills: sinon.SinonSpy[] = [];
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			callbacks.push(callback);
			const kill = sinon.spy(() => true);
			kills.push(kill);
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		const completed = service.fetchDaily({ executablePath: '/test/first' });
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		callbacks[0](null, JSON.stringify({ daily: [] }), '');
		await completed;
		const active = service.fetchDaily({ executablePath: '/test/second' });
		const anotherActive = service.fetchDaily({ executablePath: '/test/third' });
		while (callbacks.length < 3) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills.map(kill => kill.callCount), timers: clock.countTimers() }, { kills: [0, 1, 1], timers: 0 });
		void active;
		void anotherActive;
	});

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
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);
		const probe = (service as unknown as { canExecute(command: string): Promise<boolean> }).canExecute('ccusage');

		await clock.tickAsync(10_000);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });
		callback!(Object.assign(new Error('terminated'), { killed: false }));
		assert.strictEqual(await probe, false);
		await clock.tickAsync(10_000);
		assert.strictEqual(kill.callCount, 1);
		service.dispose();
	});
});

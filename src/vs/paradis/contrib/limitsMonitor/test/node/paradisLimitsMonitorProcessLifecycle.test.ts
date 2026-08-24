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

	test('does not retain deadlines for synchronous or completed callbacks and disposes every active child', async () => {
		const clock = sinon.useFakeTimers();
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const kills: sinon.SinonSpy[] = [];
		let synchronous = true;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			const kill = sinon.spy(() => true);
			kills.push(kill);
			if (synchronous) {
				callback(null, JSON.stringify({ schemaVersion: 1, accounts: [] }), '');
			} else {
				callbacks.push(callback);
			}
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);

		await service.getSnapshot({ cswapPath: '/test/synchronous', codexHomes: [] });
		synchronous = false;
		const completed = service.getSnapshot({ cswapPath: '/test/completed', codexHomes: [] });
		while (callbacks.length < 1) {
			await Promise.resolve();
		}
		callbacks[0](null, JSON.stringify({ schemaVersion: 1, accounts: [] }), '');
		await completed;
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills.map(kill => kill.callCount), timers: clock.countTimers() }, { kills: [0, 0], timers: 0 });

		const first = service.getSnapshot({ cswapPath: '/test/first', codexHomes: [] });
		const second = service.getSnapshot({ cswapPath: '/test/second', codexHomes: [] });
		while (callbacks.length < 3) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills.map(kill => kill.callCount), timers: clock.countTimers() }, { kills: [0, 0, 1, 1], timers: 0 });
		void first;
		void second;
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
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);
		const probe = (service as unknown as { canExecute(command: string): Promise<boolean> }).canExecute('cswap');

		await clock.tickAsync(10_000);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });
		callback!(Object.assign(new Error('terminated'), { killed: false }));
		assert.strictEqual(await probe, false);
		await clock.tickAsync(10_000);
		assert.strictEqual(kill.callCount, 1);
		service.dispose();
	});

	test('surfaces a synchronous execFile throw as a source error, releases the inflight key, and leaves no unhandled rejection', async () => {
		let invocations = 0;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			invocations++;
			if (invocations === 1) {
				throw new Error('synchronous execFile failure');
			}
			callback(null, JSON.stringify({ schemaVersion: 1, accounts: [] }), '');
			return { pid: undefined, exitCode: null, signalCode: null, kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			const first = service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [], bypassCache: true });
			const settled = await Promise.race([
				first.then(
					value => ({ kind: 'value' as const, value }),
					error => ({ kind: 'error' as const, error }),
				),
				new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
			]);
			assert.strictEqual(settled.kind, 'value', 'the source error must settle getSnapshot rather than leave its inflight request pending');
			if (settled.kind === 'value') {
				assert.match(settled.value.claude.sourceError ?? '', /synchronous execFile failure/);
			}
			await Promise.resolve();
			assert.deepStrictEqual(unhandled, []);

			const retry = await service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [], bypassCache: true });
			assert.deepStrictEqual(retry.claude.accounts, []);
			assert.strictEqual(invocations, 2);
		} finally {
			process.removeListener('unhandledRejection', onUnhandledRejection);
			service.dispose();
		}
	});

	test('does not start an execution when disposal wins a delayed environment resolution', async () => {
		let resolveEnv: ((env: NodeJS.ProcessEnv) => void) | undefined;
		const delayedEnv = new Promise<NodeJS.ProcessEnv>(resolve => resolveEnv = resolve);
		let invocations = 0;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			invocations++;
			callback(null, JSON.stringify({ schemaVersion: 1, accounts: [] }), '');
			return { pid: undefined, exitCode: null, signalCode: null, kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);
		sinon.stub(service as unknown as { getExecEnv(): Promise<NodeJS.ProcessEnv> }, 'getExecEnv').returns(delayedEnv);

		const pending = service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [] });
		service.dispose();
		resolveEnv!({});
		const snapshot = await pending;

		assert.strictEqual(invocations, 0);
		assert.match(snapshot.claude.sourceError ?? '', /disposed/);
	});
});

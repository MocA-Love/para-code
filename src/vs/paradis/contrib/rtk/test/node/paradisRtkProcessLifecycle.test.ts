/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRtkService } from '../../node/paradisRtkChannel.js';

suite('ParadisRtk process lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('owns the 60 second deadline and clears it after callback completion', async () => {
		const clock = sinon.useFakeTimers();
		const kills: sinon.SinonSpy[] = [];
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const timeouts: Array<number | undefined> = [];
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			timeouts.push(options.timeout);
			callbacks.push(callback);
			const kill = sinon.spy(() => true);
			kills.push(kill);
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisRtkService(new NullLogService(), undefined, undefined, execFile, () => clock.now, false);

		const timedOut = service.fetchSummary({ executablePath: '/test/rtk' });
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills[0].callCount, timeout: timeouts[0] }, { kills: 1, timeout: undefined });
		callbacks[0](Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await assert.rejects(timedOut, /terminated/);

		const completed = service.fetchSummary({ executablePath: '/test/rtk', bypassCache: true });
		while (callbacks.length < 2) {
			await Promise.resolve();
		}
		callbacks[1](null, JSON.stringify({ summary: { total: 1 } }), '');
		await completed;
		await clock.tickAsync(60_000);
		assert.strictEqual(kills[1].callCount, 0);
		service.dispose();
	});

	test('rejects a successful callback that follows the deadline without caching it', async () => {
		const clock = sinon.useFakeTimers();
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			callbacks.push(callback);
			return { pid: undefined, exitCode: null, signalCode: null, kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisRtkService(new NullLogService(), undefined, undefined, execFile, () => clock.now, false);

		const expired = service.fetchSummary({ executablePath: '/test/rtk' });
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		callbacks[0](null, JSON.stringify({ summary: { total: 1 } }), '');
		await assert.rejects(expired, /timed out/);

		const refreshed = service.fetchSummary({ executablePath: '/test/rtk' });
		while (callbacks.length < 2) {
			await Promise.resolve();
		}
		callbacks[1](null, JSON.stringify({ summary: { total: 2 } }), '');
		assert.deepStrictEqual(await refreshed, { total: 2 });
		service.dispose();
	});

	test('does not retain a deadline for synchronous callbacks and disposes every active child', async () => {
		const clock = sinon.useFakeTimers();
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const kills: sinon.SinonSpy[] = [];
		let synchronous = true;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			const kill = sinon.spy(() => true);
			kills.push(kill);
			if (synchronous) {
				callback(null, JSON.stringify({ summary: { total: 1 } }), '');
			} else {
				callbacks.push(callback);
			}
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisRtkService(new NullLogService(), undefined, undefined, execFile, () => clock.now, false);

		await service.fetchSummary({ executablePath: '/test/synchronous' });
		synchronous = false;
		const first = service.fetchSummary({ executablePath: '/test/first' });
		const second = service.fetchSummary({ executablePath: '/test/second' });
		while (callbacks.length < 2) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills.map(kill => kill.callCount), timers: clock.countTimers() }, { kills: [0, 1, 1], timers: 0 });
		void first;
		void second;
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS } from '../../common/paradisCcusage.js';
import { ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

suite('ParadisCcusage process lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	/** 設定値ごとに、待っている側が打ち切られるまでの経過時間(ms)を測る（実行そのものはその時点では止めない）。 */
	async function measureDeadline(configuredValue: unknown): Promise<number | undefined> {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, _cb: unknown) => {
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const configurationService = new TestConfigurationService({ [PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS]: configuredValue });
		const service = new ParadisCcusageService(new NullLogService(), configurationService, undefined, execFile, () => clock.now);

		let rejectedAt: number | undefined;
		service.fetchDaily({ executablePath: '/test/ccusage' }).catch(() => { rejectedAt = clock.now; });
		// 上限(10分)を超えて回し、どこで打ち切られたかを見る。
		while (clock.now <= 11 * 60_000 && rejectedAt === undefined) {
			await clock.tickAsync(1_000);
		}
		const killedBeforeGivingUp = kill.callCount;
		service.dispose();
		clock.restore();
		assert.strictEqual(killedBeforeGivingUp, 0, 'giving up the wait must not stop the scan');
		return rejectedAt;
	}

	test('derives the execution deadline from the setting, clamped to 10 seconds and 10 minutes', async () => {
		assert.deepStrictEqual({
			configured: await measureDeadline(300),
			belowMinimum: await measureDeadline(3),
			aboveMaximum: await measureDeadline(9_999),
			negative: await measureDeadline(-5),
			notANumber: await measureDeadline('600'),
			unset: await measureDeadline(undefined),
		}, {
			configured: 300_000,
			belowMinimum: 10_000,
			aboveMaximum: 10 * 60_000,
			negative: 180_000,
			notANumber: 180_000,
			unset: 180_000,
		});
	});

	// 待っている側は既定の 180 秒で外すが、走査は止めずに 15 分の上限まで続ける（--offline でやり直さない）。
	test('stops waiting at the default 180 seconds but keeps the scan running until the 15 minute limit', async () => {
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
		pending.catch(() => undefined);
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(180_000);
		await assert.rejects(pending, /timed out/);
		assert.strictEqual(kill.callCount, 0, 'the scan must keep running after the foreground limit');
		await clock.tickAsync(15 * 60_000 - 180_000 - 1);
		assert.strictEqual(kill.callCount, 0);
		await clock.tickAsync(1);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });

		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await clock.tickAsync(0);
		assert.strictEqual(invocations, 1, 'a timed out execution must not retry with --offline');
		service.dispose();
	});

	// 待っている側を外した後に走査が終われば、その値をキャッシュし、次の要求はすぐ返る（走査をやり直さない）。
	test('caches a scan that completes after the foreground gave up waiting', async () => {
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
		expired.catch(() => undefined);
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		await clock.tickAsync(180_000);
		await assert.rejects(expired, /timed out/);
		// 打ち切った直後の要求は、走っている走査に相乗りする（新しく起こさない）
		const joined = service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(100_000);
		callbacks[0](null, JSON.stringify({ daily: [{ period: 'late' }] }), '');
		assert.deepStrictEqual(await joined, [{ period: 'late' }]);
		assert.deepStrictEqual(await service.fetchDaily({ executablePath: '/test/ccusage' }), [{ period: 'late' }]);
		assert.deepStrictEqual(invocations, [['daily', '--json']]);
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
		await clock.tickAsync(180_000);
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
		active.catch(() => undefined);
		anotherActive.catch(() => undefined);
		while (callbacks.length < 3) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(180_000);
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

	test('releases the executable probe deadline after a successful callback', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null) => void) | undefined;
		const execFile = ((_file: string, _args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			callback = cb;
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);
		const probe = (service as unknown as { canExecute(command: string): Promise<boolean> }).canExecute('ccusage');

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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

interface IExecResult {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly error?: NodeJS.ErrnoException & { killed?: boolean };
}

interface IExecInvocation {
	readonly file: string;
	readonly args: readonly string[];
	readonly encoding: BufferEncoding | null | undefined;
	readonly timeout: number | undefined;
	readonly maxBuffer: number | undefined;
	readonly windowsHide: boolean | undefined;
}

const INITIAL_TIME = 1_000_000;
const WARM_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_TTL_MS = 38 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 1000;
const WARM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const dailyOutput = (period: string): string => JSON.stringify({ daily: [{ period }] });

suite('ParadisCcusageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function createService(behaviour: (invocation: number) => IExecResult | Promise<IExecResult>) {
		const clock = sinon.useFakeTimers({ now: INITIAL_TIME });
		const invocations: IExecInvocation[] = [];
		const childKills: sinon.SinonSpy[] = [];
		const execFile = ((file: string, args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			const invocation = invocations.length + 1;
			invocations.push({
				file,
				args: [...args],
				encoding: options.encoding,
				timeout: options.timeout,
				maxBuffer: options.maxBuffer,
				windowsHide: options.windowsHide,
			});
			void Promise.resolve(behaviour(invocation)).then(result => {
				callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
			});
			const kill = sinon.spy(() => true);
			const child = { kill } as unknown as cp.ChildProcess;
			childKills.push(kill);
			return child;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(
			new NullLogService(),
			undefined,
			undefined,
			execFile,
			() => clock.now,
		);
		return { childKills, clock, invocations, service };
	}

	test('reuses a cached report until its TTL expires', async () => {
		const { clock, invocations, service } = createService(invocation => ({ stdout: dailyOutput(`day-${invocation}`) }));

		const first = await service.fetchDaily({ executablePath: '/test/ccusage' });
		clock.setSystemTime(INITIAL_TIME + CACHE_TTL_MS - 1);
		const cached = await service.fetchDaily({ executablePath: '/test/ccusage' });
		clock.setSystemTime(INITIAL_TIME + CACHE_TTL_MS);
		const expired = await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual({
			calls: invocations.length,
			periods: [first[0]?.period, cached[0]?.period, expired[0]?.period],
		}, {
			calls: 2,
			periods: ['day-1', 'day-1', 'day-2'],
		});
	});

	test('collapses concurrent requests for the same report into one child invocation', async () => {
		let release!: (result: IExecResult) => void;
		const pending = new Promise<IExecResult>(resolve => release = resolve);
		const { invocations, service } = createService(() => pending);

		const first = service.fetchDaily({ executablePath: '/test/ccusage' });
		const second = service.fetchDaily({ executablePath: '/test/ccusage' });
		release({ stdout: dailyOutput('shared') });
		const results = await Promise.all([first, second]);
		service.dispose();

		assert.deepStrictEqual({
			calls: invocations.length,
			periods: results.map(result => result[0]?.period),
		}, {
			calls: 1,
			periods: ['shared', 'shared'],
		});
	});

	test('manual bypass refreshes an otherwise fresh cached report', async () => {
		const { invocations, service } = createService(invocation => ({ stdout: dailyOutput(`day-${invocation}`) }));

		const cached = await service.fetchDaily({ executablePath: '/test/ccusage' });
		const refreshed = await service.fetchDaily({ executablePath: '/test/ccusage', bypassCache: true });
		service.dispose();

		assert.deepStrictEqual({
			calls: invocations.length,
			periods: [cached[0]?.period, refreshed[0]?.period],
		}, {
			calls: 2,
			periods: ['day-1', 'day-2'],
		});
	});

	test('warm pass skips a report refreshed shortly before the interval', async () => {
		const { clock, invocations, service } = createService(invocation => ({ stdout: dailyOutput(`day-${invocation}`) }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(WARM_INTERVAL_MS - 60 * 1000);
		await service.fetchDaily({ executablePath: '/test/ccusage', bypassCache: true });
		await clock.tickAsync(60 * 1000);
		service.dispose();

		assert.strictEqual(invocations.length, 2);
	});

	test('stops warming a report after it has been idle for twelve hours', async () => {
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('cached') }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		clock.setSystemTime(INITIAL_TIME + WARM_IDLE_TIMEOUT_MS);
		await clock.tickAsync(WARM_INTERVAL_MS);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 1, timers: 0 });
		service.dispose();
	});

	test('stops warming a report after three consecutive failures', async () => {
		const timeout = Object.assign(new Error('timed out'), { killed: true });
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? { stdout: dailyOutput('cached') }
			: { error: timeout, stderr: 'timed out' });

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(3 * WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 4, timers: 0 });
		service.dispose();
	});

	test('dispose kills an active child and does not cache its late completion', async () => {
		let releaseFirst!: (result: IExecResult) => void;
		const firstResult = new Promise<IExecResult>(resolve => releaseFirst = resolve);
		const { childKills, invocations, service } = createService(invocation => invocation === 1
			? firstResult
			: { stdout: dailyOutput('after-dispose') });

		const pending = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (invocations.length === 0) {
			await Promise.resolve();
		}
		service.dispose();
		const killed = childKills[0].calledOnce;
		releaseFirst({ stdout: dailyOutput('late') });
		const late = await pending;
		const afterDispose = await service.fetchDaily({ executablePath: '/test/ccusage' });

		assert.deepStrictEqual({
			calls: invocations.length,
			killed,
			periods: [late[0]?.period, afterDispose[0]?.period],
		}, {
			calls: 2,
			killed: true,
			periods: ['late', 'after-dispose'],
		});
	});

	test('dispose cancels future warm passes', async () => {
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('cached') }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 1, timers: 0 });
	});

	test('keeps an offline fallback only for its shorter TTL', async () => {
		const onlineFailure = new Error('pricing service unavailable');
		const { clock, invocations, service } = createService(invocation => {
			if (invocation === 1) {
				return { error: onlineFailure, stderr: onlineFailure.message };
			}
			return { stdout: dailyOutput(invocation === 2 ? 'offline' : 'online') };
		});

		const fallback = await service.fetchDaily({ executablePath: '/test/ccusage' });
		clock.setSystemTime(INITIAL_TIME + FALLBACK_CACHE_TTL_MS - 1);
		const cached = await service.fetchDaily({ executablePath: '/test/ccusage' });
		clock.setSystemTime(INITIAL_TIME + FALLBACK_CACHE_TTL_MS);
		const refreshed = await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual({
			calls: invocations.length,
			offlineArgs: invocations[1]?.args,
			periods: [fallback[0]?.period, cached[0]?.period, refreshed[0]?.period],
		}, {
			calls: 3,
			offlineArgs: ['daily', '--json', '--offline'],
			periods: ['offline', 'offline', 'online'],
		});
	});

	test('bounds each child with the ccusage timeout and output limit', async () => {
		const { invocations, service } = createService(() => ({ stdout: dailyOutput('bounded') }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual(invocations[0], {
			file: '/test/ccusage',
			args: ['daily', '--json'],
			encoding: 'utf8',
			timeout: 60_000,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
		});
	});
});

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
import { IParadisWarmLeaseScheduler } from '../../../../common/paradisWarmLease.js';
import { ParadisCcusageChannel, ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

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
const WARM_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 38 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 1000;

const dailyOutput = (period: string): string => JSON.stringify({ daily: [{ period }] });

const dailyWarmTarget = { kind: 'daily', options: { executablePath: '/test/ccusage', since: '20260519' } };

async function assertWarmLeaseRejected(channel: ParadisCcusageChannel, payload: unknown, ...extraArgs: readonly unknown[]): Promise<void> {
	await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease', [payload, ...extraArgs])));
}

async function keepLeasesAliveUntilNextWarmPass(clock: sinon.SinonFakeTimers, channel: ParadisCcusageChannel, payloads: readonly unknown[]): Promise<void> {
	for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
		for (const payload of payloads) {
			await channel.call('', 'setWarmLease', [payload]);
		}
	}
	await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
}

suite('ParadisCcusageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function createService(
		behaviour: (invocation: number) => IExecResult | Promise<IExecResult>,
		warmLeaseSchedulerFactory?: (runner: () => void) => IParadisWarmLeaseScheduler,
	) {
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
			warmLeaseSchedulerFactory,
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

	test('does not warm a foreground fetch that has no active owner lease', async () => {
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('foreground') }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 1, timers: 0 });
		service.dispose();
	});

	test('warms each target once while owners coexist and stops after the final release', async () => {
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('warm') }));
		const channel = new ParadisCcusageChannel(service);
		const statusPayload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };
		const dashboardPayload = {
			ownerId: 'dashboard-owner',
			active: true,
			targets: [
				dailyWarmTarget,
				{ kind: 'blocks', options: { executablePath: '/test/ccusage' } },
				{ kind: 'session', options: { executablePath: '/test/ccusage', since: '20260519' } },
				{ kind: 'projects', options: { executablePath: '/test/ccusage', since: '20260519' } },
			],
		};

		await channel.call('', 'setWarmLease', [statusPayload]);
		await channel.call('', 'setWarmLease', [dashboardPayload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [statusPayload, dashboardPayload]);
		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: false, targets: [] }]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [dashboardPayload]);
		await channel.call('', 'setWarmLease', [{ ownerId: 'dashboard-owner', active: false, targets: [] }]);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 8, timers: 0 });
		service.dispose();
	});

	test('purges an expired owner at the warm tick even when the expiry scheduler is delayed', async () => {
		const delayedScheduler: IParadisWarmLeaseScheduler = {
			schedule: () => { },
			cancel: () => { },
			dispose: () => { },
		};
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('expired') }), () => delayedScheduler);
		const channel = new ParadisCcusageChannel(service);

		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] }]);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 0, timers: 0 });
		service.dispose();
	});

	test('does not let a released warm generation cache after the same target is reacquired', async () => {
		let releaseWarm!: (result: IExecResult) => void;
		const pendingWarm = new Promise<IExecResult>(resolve => releaseWarm = resolve);
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? pendingWarm
			: { stdout: dailyOutput(`fresh-${invocation}`) });
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };

		await channel.call('', 'setWarmLease', [payload]);
		for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
			clock.tick(WARM_LEASE_RENEW_INTERVAL_MS);
			await channel.call('', 'setWarmLease', [payload]);
		}
		clock.tick(WARM_LEASE_RENEW_INTERVAL_MS);
		while (invocations.length === 0) {
			await Promise.resolve();
		}
		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: false, targets: [] }]);
		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] }]);
		releaseWarm({ stdout: dailyOutput('stale') });
		for (let index = 0; index < 6; index++) {
			await Promise.resolve();
		}
		const rows = await service.fetchDaily({ executablePath: '/test/ccusage', since: '20260519' });

		assert.deepStrictEqual({ calls: invocations.length, period: rows[0]?.period }, { calls: 2, period: 'fresh-2' });
		service.dispose();
	});

	test('accepts only bounded plain warm lease payloads on shared and remote channels', async () => {
		const { clock, service } = createService(() => ({ stdout: dailyOutput('warm') }));
		const localChannel = new ParadisCcusageChannel(service);
		const remoteChannel = new ParadisCcusageChannel<{ readonly remote: true }>(service);
		const validPayload = { ownerId: 'owner.1:opaque', active: true, targets: [dailyWarmTarget] };
		const targetsWithExtraField = Object.assign([dailyWarmTarget], { extra: true });

		await localChannel.call('', 'setWarmLease', [validPayload]);
		await remoteChannel.call({ remote: true }, 'setWarmLease', [validPayload]);
		await assert.rejects(() => Promise.resolve().then(() => localChannel.call('', 'setwarmLease', [validPayload])));
		await assert.rejects(() => Promise.resolve().then(() => localChannel.call('', 'setWarmLease')));
		await assert.rejects(() => Promise.resolve().then(() => localChannel.call('', 'setWarmLease', validPayload)));
		await assertWarmLeaseRejected(localChannel, { ownerId: '', active: true, targets: [dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'bad owner', active: true, targets: [dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: `owner-${'x'.repeat(128)}`, active: true, targets: [dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: false, targets: [dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ kind: 'unknown', options: {} }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [dailyWarmTarget, dailyWarmTarget, dailyWarmTarget, dailyWarmTarget, dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [dailyWarmTarget], extra: true });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ ...dailyWarmTarget, extra: true }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ kind: 'daily', options: { executablePath: ' /test/ccusage ', since: '20260519' } }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ kind: 'daily', options: { executablePath: '/test/ccusage' } }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ kind: 'blocks', options: { executablePath: '/test/ccusage', since: '20260519' } }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [{ kind: 'daily', options: { executablePath: '/test/ccusage', bypassCache: true } }] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [dailyWarmTarget, dailyWarmTarget] });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: targetsWithExtraField });
		await assertWarmLeaseRejected(localChannel, { ownerId: 'owner', active: true, targets: [dailyWarmTarget] }, 'unexpected');

		assert.strictEqual(clock.countTimers(), 2);
		service.dispose();
	});

	test('rejects the 129th active owner even when memberships and keys remain below their caps', async () => {
		const { service } = createService(() => ({ stdout: dailyOutput('owner-capped') }));
		const channel = new ParadisCcusageChannel(service);

		for (let index = 0; index < 128; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `owner-${index}`, active: true, targets: [dailyWarmTarget] }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: 'owner-overflow', active: true, targets: [dailyWarmTarget] });

		service.dispose();
	});

	test('accepts exactly 512 service-wide memberships and keys but rejects an overflow owner', async () => {
		const { service } = createService(() => ({ stdout: dailyOutput('capped') }));
		const channel = new ParadisCcusageChannel(service);

		for (let index = 0; index < 128; index++) {
			const executablePath = `/test/ccusage-${index}`;
			await channel.call('', 'setWarmLease', [{
				ownerId: `owner-${index}`,
				active: true,
				targets: [
					{ kind: 'daily', options: { executablePath, since: '20260519' } },
					{ kind: 'blocks', options: { executablePath } },
					{ kind: 'session', options: { executablePath, since: '20260519' } },
					{ kind: 'projects', options: { executablePath, since: '20260519' } },
				],
			}]);
		}
		await assertWarmLeaseRejected(channel, {
			ownerId: 'owner-overflow',
			active: true,
			targets: [{ kind: 'daily', options: { executablePath: '/test/ccusage-overflow', since: '20260519' } }],
		});

		service.dispose();
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

	test('warm pass skips a leased report refreshed shortly before the interval', async () => {
		const { clock, invocations, service } = createService(invocation => ({ stdout: dailyOutput(`day-${invocation}`) }));
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };

		await channel.call('', 'setWarmLease', [payload]);
		for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
			await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
			await channel.call('', 'setWarmLease', [payload]);
		}
		await clock.tickAsync(4 * 60 * 1000);
		await service.fetchDaily({ executablePath: '/test/ccusage', since: '20260519', bypassCache: true });
		await clock.tickAsync(60 * 1000);
		service.dispose();

		assert.strictEqual(invocations.length, 1);
	});

	test('does not reset the original warm deadline when a lease renews or changes target', async () => {
		const { clock, invocations, service } = createService(() => ({ stdout: dailyOutput('warm') }));
		const channel = new ParadisCcusageChannel(service);
		const firstPayload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };
		const changedPayload = {
			ownerId: 'status-owner',
			active: true,
			targets: [{ kind: 'daily', options: { executablePath: '/test/ccusage', since: '20260520' } }],
		};

		await channel.call('', 'setWarmLease', [firstPayload]);
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
		await channel.call('', 'setWarmLease', [firstPayload]);
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
		await channel.call('', 'setWarmLease', [changedPayload]);
		for (let elapsed = 15 * 60 * 1000; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
			await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
			await channel.call('', 'setWarmLease', [changedPayload]);
		}
		await clock.tickAsync(4 * 60 * 1000);
		assert.strictEqual(invocations.length, 0);
		await clock.tickAsync(60 * 1000);

		assert.deepStrictEqual(invocations.map(invocation => invocation.args), [
			['daily', '--json', '--since', '20260520'],
		]);
		service.dispose();
	});

	test('does not reset three-failure suppression when the same target renews', async () => {
		const timeout = Object.assign(new Error('timed out'), { killed: true });
		const { clock, invocations, service } = createService(() => ({ error: timeout, stderr: 'timed out' }));
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };

		await channel.call('', 'setWarmLease', [payload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [payload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [payload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [payload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [payload]);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 3, timers: 1 });
		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: false, targets: [] }]);
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
		const channel = new ParadisCcusageChannel(service);

		await channel.call('', 'setWarmLease', [{ ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] }]);
		service.dispose();
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 0, timers: 0 });
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

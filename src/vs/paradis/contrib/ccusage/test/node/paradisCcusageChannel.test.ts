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
import { ParadisCcusageChannel, ParadisCcusageService, paradisCcusageCodexHomeEnv, paradisCcusageProcessGroupOptions } from '../../node/paradisCcusageChannel.js';

interface IExecResult {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly error?: NodeJS.ErrnoException & { killed?: boolean };
	readonly delayMs?: number;
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
				if (result.delayMs === undefined) {
					callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
				} else {
					setTimeout(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''), result.delayMs);
				}
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

	// TTL を過ぎた値は待たせずに古い値として返し、裏で1本だけ取り直す（stale-while-revalidate）。
	test('serves a cached report until its TTL expires, then serves it stale while one revalidation runs', async () => {
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? { stdout: dailyOutput('day-1') }
			: { stdout: dailyOutput(`day-${invocation}`), delayMs: 1_000 });
		const options = { executablePath: '/test/ccusage' };
		const summary = (result: { value: { period: string }[]; fetchedAt: number; stale: boolean }) => ({ period: result.value[0]?.period, fetchedAt: result.fetchedAt - INITIAL_TIME, stale: result.stale });

		const first = summary(await service.fetchReport('daily', options));
		clock.setSystemTime(INITIAL_TIME + CACHE_TTL_MS - 1);
		const cached = summary(await service.fetchReport('daily', options));
		clock.setSystemTime(INITIAL_TIME + CACHE_TTL_MS);
		const expired = summary(await service.fetchReport('daily', options));
		const whileRevalidating = summary(await service.fetchReport('daily', options));
		await clock.tickAsync(1_000);
		const revalidated = summary(await service.fetchReport('daily', options));
		service.dispose();

		assert.deepStrictEqual({ calls: invocations.length, results: [first, cached, expired, whileRevalidating, revalidated] }, {
			calls: 2,
			results: [
				{ period: 'day-1', fetchedAt: 0, stale: false },
				{ period: 'day-1', fetchedAt: 0, stale: false },
				{ period: 'day-1', fetchedAt: 0, stale: true },
				{ period: 'day-1', fetchedAt: 0, stale: true },
				{ period: 'day-2', fetchedAt: CACHE_TTL_MS + 1_000, stale: false },
			],
		});
	});

	// `--since` は毎日1日進む。日付が変わっても前日の値を古い値として返し、新しい `--since` で取り直す。
	test('serves the value taken with a previous --since as stale and refetches with the new one', async () => {
		const { clock, invocations, service } = createService(invocation => ({ stdout: dailyOutput(`day-${invocation}`) }));

		await service.fetchReport('daily', { executablePath: '/test/ccusage', since: '20260519' });
		const nextDay = await service.fetchReport('daily', { executablePath: '/test/ccusage', since: '20260520' });
		await clock.tickAsync(0);
		const refetched = await service.fetchReport('daily', { executablePath: '/test/ccusage', since: '20260520' });
		service.dispose();

		assert.deepStrictEqual({
			args: invocations.map(invocation => invocation.args),
			nextDay: [nextDay.value[0]?.period, nextDay.stale],
			refetched: [refetched.value[0]?.period, refetched.stale],
		}, {
			args: [['daily', '--json', '--since', '20260519'], ['daily', '--json', '--since', '20260520']],
			nextDay: ['day-1', true],
			refetched: ['day-2', false],
		});
	});

	// 裏の取り直しが失敗し続けても、要求のたびに ccusage を起こし直さない（5 分から伸ばす）。手動更新は待って実行する。
	test('backs off a failing revalidation and still runs an explicit refresh', async () => {
		const timeout = Object.assign(new Error('terminated'), { killed: true });
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? { stdout: dailyOutput('day-1') }
			: { error: timeout, stderr: 'terminated' });
		const options = { executablePath: '/test/ccusage' };

		await service.fetchReport('daily', options);
		clock.setSystemTime(INITIAL_TIME + CACHE_TTL_MS);
		await service.fetchReport('daily', options);
		await clock.tickAsync(0);
		const callsAfterFirstFailure = invocations.length;
		await clock.tickAsync(5 * 60 * 1000 - 1);
		const stillStale = await service.fetchReport('daily', options);
		await clock.tickAsync(0);
		const callsWithinBackoff = invocations.length;
		await clock.tickAsync(1);
		await service.fetchReport('daily', options);
		await clock.tickAsync(0);
		const callsAfterBackoff = invocations.length;
		await assert.rejects(service.fetchReport('daily', { ...options, bypassCache: true }));
		service.dispose();

		assert.deepStrictEqual({
			stillStale: [stillStale.value[0]?.period, stillStale.stale],
			calls: [callsAfterFirstFailure, callsWithinBackoff, callsAfterBackoff, invocations.length],
		}, {
			stillStale: ['day-1', true],
			// 1 回目の失敗の後は --offline の再試行も走る（タイムアウト以外の失敗のため）
			calls: [3, 3, 5, 7],
		});
	});

	// 値が無いまま前景が失敗したら、2 分は同じ失敗を返して ccusage を起こし直さない。
	test('returns a recent foreground failure for two minutes without running ccusage again', async () => {
		const failure = Object.assign(new Error('spawn ccusage ENOENT'), { code: 'ENOENT' });
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? { error: failure, stderr: '' }
			: { stdout: dailyOutput('recovered') });
		const options = { executablePath: '/test/ccusage' };

		await assert.rejects(service.fetchReport('daily', options), /ENOENT/);
		await clock.tickAsync(2 * 60_000 - 1);
		await assert.rejects(service.fetchReport('daily', options), /ENOENT/);
		const callsWithinWindow = invocations.length;
		await clock.tickAsync(1);
		const recovered = await service.fetchReport('daily', options);
		service.dispose();

		assert.deepStrictEqual({ callsWithinWindow, calls: invocations.length, period: recovered.value[0]?.period }, { callsWithinWindow: 1, calls: 2, period: 'recovered' });
	});

	test('answers fetchReport over the channel and rejects an unknown kind', async () => {
		const { service } = createService(() => ({ stdout: JSON.stringify({ blocks: [{ id: 'gap', isGap: true, isActive: true, startTime: 'a', endTime: 'b' }, { id: 'active', isActive: true, startTime: 'a', endTime: 'b' }] }) }));
		const channel = new ParadisCcusageChannel(service);

		const result = await channel.call<{ value: { id: string }; fetchedAt: number; stale: boolean }>('', 'fetchReport', [{ kind: 'blocks', options: { executablePath: '/test/ccusage' } }]);
		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'fetchReport', [{ kind: 'shell', options: {} }])), /Invalid fetchReport kind/);
		service.dispose();

		assert.deepStrictEqual({ id: result.value.id, fetchedAt: result.fetchedAt, stale: result.stale }, { id: 'active', fetchedAt: INITIAL_TIME, stale: false });
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

	test('coalesces an overlapping warm tick into one pending pass before starting a different target', async () => {
		let releaseFirst!: (result: IExecResult) => void;
		const pendingFirst = new Promise<IExecResult>(resolve => releaseFirst = resolve);
		const { clock, invocations, service } = createService(invocation => invocation === 1
			? pendingFirst
			: { stdout: JSON.stringify({ blocks: [] }) });
		const channel = new ParadisCcusageChannel(service);
		const dailyPayload = { ownerId: 'dashboard-owner', active: true, targets: [dailyWarmTarget] };
		const blocksPayload = {
			ownerId: 'dashboard-owner',
			active: true,
			targets: [{ kind: 'blocks', options: { executablePath: '/test/ccusage' } }],
		};

		await channel.call('', 'setWarmLease', [dailyPayload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [dailyPayload]);
		assert.deepStrictEqual(invocations.map(invocation => invocation.args), [
			['daily', '--json', '--since', '20260519'],
		]);

		await channel.call('', 'setWarmLease', [blocksPayload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [blocksPayload]);
		assert.deepStrictEqual(invocations.map(invocation => invocation.args), [
			['daily', '--json', '--since', '20260519'],
		]);

		releaseFirst({ stdout: dailyOutput('stale') });
		for (let index = 0; index < 50 && invocations.length < 2; index++) {
			await Promise.resolve();
		}
		assert.deepStrictEqual(invocations.map(invocation => invocation.args), [
			['daily', '--json', '--since', '20260519'],
			['blocks', '--active', '--json'],
		]);
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

	test('publishes a warm-first in-flight result when a foreground request joins before owner release', async () => {
		let releaseWarm!: (result: IExecResult) => void;
		const pendingWarm = new Promise<IExecResult>(resolve => releaseWarm = resolve);
		const { clock, invocations, service } = createService(() => pendingWarm);
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'status-owner', active: true, targets: [dailyWarmTarget] };

		await channel.call('', 'setWarmLease', [payload]);
		await keepLeasesAliveUntilNextWarmPass(clock, channel, [payload]);
		const foreground = service.fetchDaily({ executablePath: '/test/ccusage', since: '20260519' });
		await channel.call('', 'setWarmLease', [{ ownerId: payload.ownerId, active: false, targets: [] }]);
		releaseWarm({ stdout: dailyOutput('foreground-joined') });
		const joined = await foreground;
		const cached = await service.fetchDaily({ executablePath: '/test/ccusage', since: '20260519' });

		assert.deepStrictEqual({ calls: invocations.length, periods: [joined[0]?.period, cached[0]?.period] }, {
			calls: 1,
			periods: ['foreground-joined', 'foreground-joined'],
		});
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

	// SSH 先へは手元のタイムゾーンが添えられ、その日付の区切りで数えさせる。名前に使えない文字は断る。
	test('accepts a time zone in warm lease targets and passes it to ccusage', async () => {
		const { clock, service, invocations } = createService(() => ({ stdout: dailyOutput('tz') }));
		const channel = new ParadisCcusageChannel<{ readonly remote: true }>(service);
		const options = { ...dailyWarmTarget.options, timezone: 'Asia/Tokyo' };
		await channel.call({ remote: true }, 'setWarmLease', [{ ownerId: 'owner.tz', active: true, targets: [{ kind: 'daily', options }, { kind: 'blocks', options: { timezone: 'Asia/Tokyo' } }] }]);
		await assert.rejects(() => Promise.resolve().then(() => channel.call({ remote: true }, 'setWarmLease', [{ ownerId: 'owner', active: true, targets: [{ kind: 'daily', options: { ...dailyWarmTarget.options, timezone: 'Asia/Tokyo; rm -rf' } }] }])));
		await service.fetchDaily(options);
		await clock.tickAsync(0);
		assert.deepStrictEqual(invocations[invocations.length - 1]?.args.slice(-2), ['--timezone', 'Asia/Tokyo']);
		service.dispose();
	});

	test('accepts the full opaque owner ID regex boundary and rejects 161 characters', async () => {
		const { service } = createService(() => ({ stdout: dailyOutput('owner-id') }));
		const channel = new ParadisCcusageChannel(service);

		for (const prefix of ['.', '_', ':', '-']) {
			await channel.call('', 'setWarmLease', [{ ownerId: `${prefix}${'x'.repeat(159)}`, active: true, targets: [dailyWarmTarget] }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: `.${'x'.repeat(160)}`, active: true, targets: [dailyWarmTarget] });

		service.dispose();
	});

	test('rejects outer IPC argument arrays with extra own properties', async () => {
		const { service } = createService(() => ({ stdout: dailyOutput('outer-array') }));
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'owner', active: true, targets: [dailyWarmTarget] };
		const argumentsWithExtraField = Object.assign([payload], { extra: true });

		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease', argumentsWithExtraField)));

		service.dispose();
	});

	test('rejects Array subclasses as outer IPC arguments', async () => {
		const { service } = createService(() => ({ stdout: dailyOutput('outer-array') }));
		const channel = new ParadisCcusageChannel(service);
		const payload = { ownerId: 'owner', active: true, targets: [dailyWarmTarget] };
		class WarmLeaseArguments extends Array<unknown> { }

		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease', new WarmLeaseArguments(payload))));

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
		const timeout = Object.assign(new Error('timed out'), { killed: false });
		// warm は誰も待たない実行なので、上限は 15 分（設定の 180 秒ではない）。そこで時間切れにする
		const { clock, invocations, service } = createService(() => ({ error: timeout, stderr: 'timed out', delayMs: 15 * 60_000 }));
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
		// 短い TTL を過ぎたら古い値として返し、裏で取り直す
		const stale = await service.fetchDaily({ executablePath: '/test/ccusage' });
		await clock.tickAsync(0);
		const refreshed = await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual({
			calls: invocations.length,
			offlineArgs: invocations[1]?.args,
			periods: [fallback[0]?.period, cached[0]?.period, stale[0]?.period, refreshed[0]?.period],
		}, {
			calls: 3,
			offlineArgs: ['daily', '--json', '--offline'],
			periods: ['offline', 'offline', 'offline', 'online'],
		});
	});

	// POSIX では自分のプロセスグループで起こし、止めるときに npx の先の孫までまとめて止める。Windows は付けない。
	test('starts ccusage in its own process group except on Windows', async () => {
		const detached: unknown[] = [];
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptions & { detached?: boolean }, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			detached.push(options.detached);
			callback(null, dailyOutput('grouped'), '');
			return { kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile);

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual({
			spawned: detached,
			darwin: paradisCcusageProcessGroupOptions('darwin'),
			linux: paradisCcusageProcessGroupOptions('linux'),
			win32: paradisCcusageProcessGroupOptions('win32'),
		}, {
			spawned: [process.platform === 'win32' ? undefined : true],
			darwin: { detached: true },
			linux: { detached: true },
			win32: {},
		});
	});

	test('owns each child deadline and preserves the output limit', async () => {
		const { invocations, service } = createService(() => ({ stdout: dailyOutput('bounded') }));

		await service.fetchDaily({ executablePath: '/test/ccusage' });
		service.dispose();

		assert.deepStrictEqual(invocations[0], {
			file: '/test/ccusage',
			args: ['daily', '--json'],
			encoding: 'utf8',
			timeout: undefined,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
		});
	});

	// Codex のアカウントを切り替えると別のホームへ会話ログを書くので、全ホームをカンマ区切りで渡す。
	// ホームが1つなら利用者の CODEX_HOME をそのまま使い、カンマを含むパスは区切りと見分けられないので外す。
	test('passes every Codex home to ccusage as a comma-separated CODEX_HOME only when there are several', () => {
		const env = { PATH: '/bin', CODEX_HOME: '/custom/codex' };
		assert.deepStrictEqual({
			several: paradisCcusageCodexHomeEnv(env, ['/home/u/.codex', '/home/u/.codex-2', '/home/u/odd,name']).CODEX_HOME,
			single: paradisCcusageCodexHomeEnv(env, ['/custom/codex']),
		}, {
			several: '/home/u/.codex,/home/u/.codex-2',
			single: env,
		});
	});
});

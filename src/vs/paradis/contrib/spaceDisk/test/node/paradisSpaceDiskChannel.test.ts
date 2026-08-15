/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisWarmLeaseScheduler } from '../../../../common/paradisWarmLease.js';
import { IParadisSpaceDiskTarget } from '../../common/paradisSpaceDisk.js';
import { IDirectorySizeOptions, IDirectorySizeResult } from '../../node/paradisDirectorySize.js';
import { ParadisSpaceDiskChannel, ParadisSpaceDiskService } from '../../node/paradisSpaceDiskChannel.js';

const INITIAL_TIME = 1_000_000;
const WARM_INTERVAL_MS = 60 * 60 * 1000;
const WARM_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;

interface IDirectoryMeasureInvocation {
	readonly root: string;
	readonly exclude: readonly string[];
}

interface IDeferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: Error) => void;
}

function deferred<T>(): IDeferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

function target(id: string, worktreeCount = 0): IParadisSpaceDiskTarget {
	return {
		stateKey: `repository-${id}`,
		name: `Repository ${id}`,
		path: `/repositories/${id}`,
		worktrees: Array.from({ length: worktreeCount }, (_, index) => ({
			stateKey: `worktree-${id}-${index}`,
			name: `Worktree ${id} ${index}`,
			path: `/worktrees/${id}-${index}`,
		})),
	};
}

function createService(
	behaviour: (invocation: number, root: string, options: IDirectorySizeOptions) => IDirectorySizeResult | Promise<IDirectorySizeResult> = invocation => ({ bytes: invocation, files: 1, truncated: false }),
	warmLeaseSchedulerFactory?: (runner: () => void) => IParadisWarmLeaseScheduler,
) {
	const clock = sinon.useFakeTimers({ now: INITIAL_TIME });
	const invocations: IDirectoryMeasureInvocation[] = [];
	const measureDirectory = async (root: string, options: IDirectorySizeOptions = {}): Promise<IDirectorySizeResult> => {
		const invocation = invocations.length + 1;
		invocations.push({ root, exclude: [...(options.exclude ?? [])] });
		return behaviour(invocation, root, options);
	};
	const service = new ParadisSpaceDiskService(
		new NullLogService(),
		() => clock.now,
		warmLeaseSchedulerFactory,
		measureDirectory,
	);
	return { channel: new ParadisSpaceDiskChannel(service), clock, invocations, service };
}

async function renewUntilNextWarmPass(
	clock: sinon.SinonFakeTimers,
	channel: ParadisSpaceDiskChannel,
	payloads: readonly { readonly ownerId: string; readonly active: true; readonly targets: readonly IParadisSpaceDiskTarget[] }[],
): Promise<void> {
	for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
		for (const payload of payloads) {
			await channel.call('', 'setWarmLease', [payload]);
		}
	}
	await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
}

async function assertWarmLeaseRejected(channel: ParadisSpaceDiskChannel, payload: unknown, ...extraArgs: readonly unknown[]): Promise<void> {
	await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease', [payload, ...extraArgs])));
}

function targetsWithWorktrees(targetCount: number, worktreesPerTarget: number, stringSize = 1): IParadisSpaceDiskTarget[] {
	const fill = 'x'.repeat(stringSize);
	return Array.from({ length: targetCount }, (_, targetIndex) => ({
		stateKey: `repository-${targetIndex}-${fill}`,
		name: `Repository ${targetIndex} ${fill}`,
		path: `/repositories/${targetIndex}/${fill}`,
		worktrees: Array.from({ length: worktreesPerTarget }, (_, worktreeIndex) => ({
			stateKey: `worktree-${targetIndex}-${worktreeIndex}-${fill}`,
			name: `Worktree ${targetIndex} ${worktreeIndex} ${fill}`,
			path: `/worktrees/${targetIndex}-${worktreeIndex}/${fill}`,
		})),
	}));
}

suite('ParadisSpaceDiskService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('reuses a signature cache and bypasses it only when requested', async () => {
		const { invocations, service } = createService();
		const targets = [target('one')];

		const first = await service.measure(targets);
		const cached = await service.measure(targets);
		const refreshed = await service.measure(targets, true);

		assert.deepStrictEqual({ calls: invocations.length, bytes: [first.spaces[0]?.ownBytes, cached.spaces[0]?.ownBytes, refreshed.spaces[0]?.ownBytes] }, {
			calls: 2,
			bytes: [1, 1, 2],
		});
		service.dispose();
	});

	test('shares an in-flight measurement only for the same signature', async () => {
		const pending = deferred<IDirectorySizeResult>();
		const { invocations, service } = createService(() => pending.promise);
		const targets = [target('shared')];

		const first = service.measure(targets);
		const second = service.measure(targets);
		await flushMicrotasks();
		assert.strictEqual(invocations.length, 1);

		pending.resolve({ bytes: 42, files: 1, truncated: false });
		const results = await Promise.all([first, second]);

		assert.deepStrictEqual(results.map(result => result.spaces[0]?.ownBytes), [42, 42]);
		service.dispose();
	});

	test('serializes different signatures so only the latest request publishes its cache', async () => {
		const firstPending = deferred<IDirectorySizeResult>();
		const secondPending = deferred<IDirectorySizeResult>();
		const { invocations, service } = createService(invocation => invocation === 1 ? firstPending.promise : secondPending.promise);

		const first = service.measure([target('first')]);
		const second = service.measure([target('second')]);
		await flushMicrotasks();
		assert.deepStrictEqual(invocations.map(invocation => invocation.root), ['/repositories/first']);

		firstPending.resolve({ bytes: 1, files: 1, truncated: false });
		await first;
		await flushMicrotasks();
		assert.deepStrictEqual(invocations.map(invocation => invocation.root), ['/repositories/first', '/repositories/second']);
		secondPending.resolve({ bytes: 2, files: 1, truncated: false });
		await Promise.all([first, second]);
		await service.measure([target('second')]);

		assert.strictEqual(invocations.length, 2);
		service.dispose();
	});

	test('returns readable entries when only part of a foreground measurement fails', async () => {
		const { service } = createService((_invocation, root) => {
			if (root.endsWith('/broken')) {
				throw new Error('permission denied');
			}
			return { bytes: 23, files: 1, truncated: false };
		});

		const result = await service.measure([target('broken'), target('readable')]);

		assert.deepStrictEqual(result.spaces.map(space => ({ name: space.name, bytes: space.ownBytes, error: space.error })), [
			{ name: 'Repository broken', bytes: 0, error: 'permission denied' },
			{ name: 'Repository readable', bytes: 23, error: undefined },
		]);
		service.dispose();
	});

	test('uses the injected clock for measuredAt and durationMs', async () => {
		let now = INITIAL_TIME;
		const service = new ParadisSpaceDiskService(new NullLogService(), () => now, undefined, async () => {
			now += 37;
			return { bytes: 1, files: 1, truncated: false };
		});

		const result = await service.measure([target('timed')]);

		assert.deepStrictEqual({ measuredAt: result.measuredAt, durationMs: result.durationMs }, { measuredAt: INITIAL_TIME + 37, durationMs: 37 });
		service.dispose();
	});

	test('does not warm a one-shot foreground measurement without an owner lease', async () => {
		const { clock, invocations, service } = createService();

		await service.measure([target('foreground')]);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 1, timers: 0 });
		service.dispose();
	});

	test('warms the active lease once per interval and stops after the final release', async () => {
		const { channel, clock, invocations, service } = createService();
		const payload = { ownerId: 'desktop-owner', active: true as const, targets: [target('warm')] };

		await channel.call('', 'setWarmLease', [payload]);
		await renewUntilNextWarmPass(clock, channel, [payload]);
		await channel.call('', 'setWarmLease', [{ ownerId: payload.ownerId, active: false, targets: [] }]);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ roots: invocations.map(invocation => invocation.root), timers: clock.countTimers() }, {
			roots: ['/repositories/warm'],
			timers: 0,
		});
		service.dispose();
	});

	test('uses the renewed target snapshot without resetting the warm deadline', async () => {
		const { channel, clock, invocations, service } = createService();
		let payload = { ownerId: 'desktop-owner', active: true as const, targets: [target('before')] };
		await channel.call('', 'setWarmLease', [payload]);

		for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
			await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
			payload = { ...payload, targets: elapsed < WARM_INTERVAL_MS - WARM_LEASE_RENEW_INTERVAL_MS ? payload.targets : [target('after')] };
			await channel.call('', 'setWarmLease', [payload]);
		}
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);

		assert.deepStrictEqual(invocations.map(invocation => invocation.root), ['/repositories/after']);
		service.dispose();
	});

	test('purges an expired lease before a delayed expiry callback can start a stale scan', async () => {
		const delayedScheduler: IParadisWarmLeaseScheduler = {
			schedule: () => { },
			cancel: () => { },
			dispose: () => { },
		};
		const { channel, clock, invocations, service } = createService(undefined, () => delayedScheduler);

		await channel.call('', 'setWarmLease', [{ ownerId: 'expired-owner', active: true, targets: [target('expired')] }]);
		await clock.tickAsync(WARM_INTERVAL_MS);

		assert.deepStrictEqual({ calls: invocations.length, timers: clock.countTimers() }, { calls: 0, timers: 0 });
		service.dispose();
	});

	test('uses only the latest-renewed owner snapshot and falls back after its release', async () => {
		const { channel, clock, invocations, service } = createService();
		const ownerA = { ownerId: 'owner-a', active: true as const, targets: [target('owner-a')] };
		const ownerB = { ownerId: 'owner-b', active: true as const, targets: [target('owner-b')] };

		await channel.call('', 'setWarmLease', [ownerA]);
		await channel.call('', 'setWarmLease', [ownerB]);
		await renewUntilNextWarmPass(clock, channel, [ownerA, ownerB]);
		await channel.call('', 'setWarmLease', [{ ownerId: ownerB.ownerId, active: false, targets: [] }]);
		await renewUntilNextWarmPass(clock, channel, [ownerA]);

		assert.deepStrictEqual(invocations.map(invocation => invocation.root), ['/repositories/owner-b', '/repositories/owner-a']);
		service.dispose();
	});

	test('does not publish a released warm generation after the same owner reacquires', async () => {
		const pendingWarm = deferred<IDirectorySizeResult>();
		const { channel, clock, invocations, service } = createService(invocation => invocation === 1
			? pendingWarm.promise
			: { bytes: 200, files: 1, truncated: false });
		const payload = { ownerId: 'desktop-owner', active: true as const, targets: [target('generation')] };

		await channel.call('', 'setWarmLease', [payload]);
		for (let elapsed = WARM_LEASE_RENEW_INTERVAL_MS; elapsed < WARM_INTERVAL_MS; elapsed += WARM_LEASE_RENEW_INTERVAL_MS) {
			clock.tick(WARM_LEASE_RENEW_INTERVAL_MS);
			await channel.call('', 'setWarmLease', [payload]);
		}
		clock.tick(WARM_LEASE_RENEW_INTERVAL_MS);
		await flushMicrotasks();
		assert.strictEqual(invocations.length, 1);

		await channel.call('', 'setWarmLease', [{ ownerId: payload.ownerId, active: false, targets: [] }]);
		await channel.call('', 'setWarmLease', [payload]);
		pendingWarm.resolve({ bytes: 100, files: 1, truncated: false });
		await flushMicrotasks();
		const foreground = await service.measure(payload.targets);

		assert.deepStrictEqual({ calls: invocations.length, bytes: foreground.spaces[0]?.ownBytes }, { calls: 2, bytes: 200 });
		service.dispose();
	});

	test('does not publish a foreground result that completes after disposal', async () => {
		const pending = deferred<IDirectorySizeResult>();
		const { invocations, service } = createService(() => pending.promise);
		const targets = [target('dispose')];
		const measurement = service.measure(targets);
		await flushMicrotasks();
		service.dispose();

		pending.resolve({ bytes: 100, files: 1, truncated: false });
		await measurement;
		await assert.rejects(() => service.measure(targets), /cancelled/);

		assert.strictEqual(invocations.length, 1);
	});
});

suite('ParadisSpaceDiskChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('accepts only exact bounded warm lease payload shapes', async () => {
		const accepted: { readonly ownerId: string; readonly active: boolean; readonly targets: readonly IParadisSpaceDiskTarget[] }[] = [];
		const service = {
			setWarmLease(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget[]): void {
				accepted.push({ ownerId, active, targets });
			},
		} as unknown as ParadisSpaceDiskService;
		const channel = new ParadisSpaceDiskChannel(service);
		const validTarget = target('valid', 1);
		const validPayload = { ownerId: 'owner.1:opaque', active: true, targets: [validTarget] };
		const targetsWithExtraField = Object.assign([validTarget], { extra: true });

		await channel.call('', 'setWarmLease', [validPayload]);
		await channel.call('', 'setWarmLease', [{ ownerId: validPayload.ownerId, active: false, targets: [] }]);
		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setwarmLease', [validPayload])));
		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease')));
		await assert.rejects(() => Promise.resolve().then(() => channel.call('', 'setWarmLease', validPayload)));
		await assertWarmLeaseRejected(channel, { ownerId: '', active: true, targets: [validTarget] });
		await assertWarmLeaseRejected(channel, { ownerId: 'bad owner', active: true, targets: [validTarget] });
		await assertWarmLeaseRejected(channel, { ownerId: `owner-${'x'.repeat(155)}`, active: true, targets: [validTarget] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: false, targets: [validTarget] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [validTarget], extra: true });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [{ ...validTarget, extra: true }] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [{ ...validTarget, stateKey: '' }] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [{ ...validTarget, name: 'x'.repeat(4097) }] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [{ ...validTarget, worktrees: [{ ...validTarget.worktrees[0]!, extra: true }] }] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: [{ ...validTarget, worktrees: [{ ...validTarget.worktrees[0]!, path: 1 }] }] });
		await assertWarmLeaseRejected(channel, { ownerId: 'owner', active: true, targets: targetsWithExtraField });
		await assertWarmLeaseRejected(channel, validPayload, 'unexpected');

		assert.deepStrictEqual(accepted.map(entry => ({ ownerId: entry.ownerId, active: entry.active, targetCount: entry.targets.length })), [
			{ ownerId: 'owner.1:opaque', active: true, targetCount: 1 },
			{ ownerId: 'owner.1:opaque', active: false, targetCount: 0 },
		]);
	});

	test('enforces per-snapshot target and worktree count caps', async () => {
		const { channel, service } = createService();

		await channel.call('', 'setWarmLease', [{ ownerId: 'target-cap', active: true, targets: targetsWithWorktrees(200, 0) }]);
		await assertWarmLeaseRejected(channel, { ownerId: 'target-cap', active: true, targets: targetsWithWorktrees(201, 0) });
		await channel.call('', 'setWarmLease', [{ ownerId: 'per-target-cap', active: true, targets: targetsWithWorktrees(1, 200) }]);
		await assertWarmLeaseRejected(channel, { ownerId: 'per-target-cap', active: true, targets: targetsWithWorktrees(1, 201) });
		await channel.call('', 'setWarmLease', [{ ownerId: 'total-worktree-cap', active: true, targets: targetsWithWorktrees(10, 200) }]);
		await assertWarmLeaseRejected(channel, { ownerId: 'total-worktree-cap', active: true, targets: targetsWithWorktrees(11, 200) });

		service.dispose();
	});

	test('enforces the two MiB serialized snapshot cap', async () => {
		const { channel, service } = createService();
		const acceptedTargets = targetsWithWorktrees(1, 200, 3000);
		const rejectedTargets = targetsWithWorktrees(1, 200, 3600);
		assert.ok(Buffer.byteLength(JSON.stringify(acceptedTargets), 'utf8') < MAX_SNAPSHOT_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify(rejectedTargets), 'utf8') > MAX_SNAPSHOT_BYTES);

		await channel.call('', 'setWarmLease', [{ ownerId: 'size-cap', active: true, targets: acceptedTargets }]);
		await assertWarmLeaseRejected(channel, { ownerId: 'size-cap', active: true, targets: rejectedTargets });

		service.dispose();
	});

	test('rejects the 129th active owner', async () => {
		const { channel, service } = createService();

		for (let index = 0; index < 128; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `owner-${index}`, active: true, targets: [] }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: 'owner-overflow', active: true, targets: [] });

		service.dispose();
	});

	test('enforces aggregate top-level target and worktree caps across active owners', async () => {
		const { channel, service } = createService();

		for (let index = 0; index < 4; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `target-owner-${index}`, active: true, targets: targetsWithWorktrees(200, 0) }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: 'target-overflow', active: true, targets: [target('overflow')] });
		for (let index = 0; index < 4; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `target-owner-${index}`, active: false, targets: [] }]);
		}
		for (let index = 0; index < 4; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `worktree-owner-${index}`, active: true, targets: targetsWithWorktrees(10, 200) }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: 'worktree-overflow', active: true, targets: [target('overflow', 1)] });

		service.dispose();
	});

	test('enforces the eight MiB aggregate snapshot cap across active owners', async () => {
		const { channel, service } = createService();
		const largeTargets = targetsWithWorktrees(1, 200, 3000);
		const overflowTargets = targetsWithWorktrees(1, 200, 1800);
		const largeCost = Buffer.byteLength(JSON.stringify(largeTargets), 'utf8');
		const overflowCost = Buffer.byteLength(JSON.stringify(overflowTargets), 'utf8');
		assert.ok(largeCost < MAX_SNAPSHOT_BYTES);
		assert.ok(overflowCost < MAX_SNAPSHOT_BYTES);
		assert.ok(largeCost * 4 <= MAX_TOTAL_SNAPSHOT_BYTES);
		assert.ok(largeCost * 4 + overflowCost > MAX_TOTAL_SNAPSHOT_BYTES);

		for (let index = 0; index < 4; index++) {
			await channel.call('', 'setWarmLease', [{ ownerId: `size-owner-${index}`, active: true, targets: largeTargets }]);
		}
		await assertWarmLeaseRejected(channel, { ownerId: 'size-overflow', active: true, targets: overflowTargets });

		service.dispose();
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	IParadisWorkspaceRepository,
	IParadisWorkspaceSwitchService,
	IParadisWorktree,
	IParadisWorktreeService,
} from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisMobileWarmLeaseProvider } from '../../../mobileRelay/electron-browser/paradisMobileWorkspaceProvider.js';
import { IParadisSpaceDiskTarget, PARADIS_SPACE_DISK_CHANNEL } from '../../common/paradisSpaceDisk.js';
import { ParadisSpaceDiskClient } from '../../electron-browser/paradisSpaceDiskClient.js';

const WARM_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;

interface IChannelCall {
	readonly command: string;
	readonly args: unknown;
}

interface IDeferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: Error) => void;
}

type TestSpaceDiskClient = ParadisSpaceDiskClient & {
	setWarmLease(ownerId: string, active: boolean, cancellation?: AbortSignal): Promise<void>;
	createWarmLease(): IDisposable;
};

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

function repository(id: string, name = `Repository ${id}`): IParadisWorkspaceRepository {
	return { id, name, uri: URI.file(`/repositories/${id}`) };
}

function worktree(repositoryId: string, name: string, path: string, overrides: Partial<IParadisWorktree> = {}): IParadisWorktree {
	return { repositoryId, name, uri: URI.file(path), ...overrides };
}

function createClient(options?: { readonly remoteAuthority?: string }) {
	let repositories: readonly IParadisWorkspaceRepository[] = [repository('one')];
	let worktrees = new Map<string, readonly IParadisWorktree[]>([
		['one', [worktree('one', 'Feature', '/worktrees/one-feature')]],
	]);
	let barrierFactory: () => Promise<void> = () => Promise.resolve();
	let barrierReads = 0;
	const calls: IChannelCall[] = [];
	const remoteCalls: IChannelCall[] = [];
	const channelRequests: string[] = [];
	const remoteChannelRequests: string[] = [];
	let callBehaviour: (call: IChannelCall) => Promise<unknown> = () => Promise.resolve({ spaces: [], measuredAt: 0, durationMs: 0 });
	let remoteCallBehaviour: (call: IChannelCall) => Promise<unknown> = () => Promise.resolve({ spaces: [], measuredAt: 0, durationMs: 0 });
	const channel = {
		call<T>(command: string, args?: unknown): Promise<T> {
			const call = { command, args };
			calls.push(call);
			return callBehaviour(call) as Promise<T>;
		},
	};
	const remoteChannel = {
		call<T>(command: string, args?: unknown): Promise<T> {
			const call = { command, args };
			remoteCalls.push(call);
			return remoteCallBehaviour(call) as Promise<T>;
		},
	};
	const workspaceSwitchService = {
		get repositories() { return repositories; },
	} as unknown as IParadisWorkspaceSwitchService;
	const worktreeService = {
		get initializationBarrier() {
			barrierReads++;
			return barrierFactory();
		},
		getWorktrees: (repositoryId: string) => worktrees.get(repositoryId) ?? [],
	} as unknown as IParadisWorktreeService;
	const sharedProcessService = {
		getChannel(name: string) {
			channelRequests.push(name);
			return channel;
		},
	} as unknown as ISharedProcessService;
	const remoteAuthority = options?.remoteAuthority;
	const remoteAgentService = {
		getConnection: () => remoteAuthority === undefined ? null : ({
			remoteAuthority,
			getChannel: (name: string) => { remoteChannelRequests.push(name); return remoteChannel; },
		} as unknown as IRemoteAgentConnection),
	} as unknown as IRemoteAgentService;
	const client = new ParadisSpaceDiskClient(workspaceSwitchService, worktreeService, sharedProcessService, remoteAgentService, new NullLogService()) as TestSpaceDiskClient;
	return {
		calls,
		remoteCalls,
		channelRequests,
		remoteChannelRequests,
		client,
		get barrierReads() { return barrierReads; },
		setBarrierFactory: (factory: () => Promise<void>) => barrierFactory = factory,
		setCallBehaviour: (behaviour: (call: IChannelCall) => Promise<unknown>) => callBehaviour = behaviour,
		setRemoteCallBehaviour: (behaviour: (call: IChannelCall) => Promise<unknown>) => remoteCallBehaviour = behaviour,
		setRepositories: (value: readonly IParadisWorkspaceRepository[]) => repositories = value,
		setWorktrees: (value: Map<string, readonly IParadisWorktree[]>) => worktrees = value,
	};
}

function warmPayload(call: IChannelCall): { readonly ownerId: string; readonly active: boolean; readonly targets: readonly IParadisSpaceDiskTarget[] } {
	return (call.args as readonly [{ readonly ownerId: string; readonly active: boolean; readonly targets: readonly IParadisSpaceDiskTarget[] }])[0];
}

function mobileSpaceWarmRequest(active: boolean) {
	return {
		t: 'spaceDiskWarmLease',
		leaseId: 'integration-lease',
		active,
		desktopEpoch: 'desktop-epoch',
		windowId: 7,
		rendererGeneration: 11,
	} as const;
}

suite('ParadisSpaceDiskClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('sends one-shot owner leases through the shared process with current local targets', async () => {
		const harness = createClient();
		harness.setRepositories([
			repository('one'),
			{ id: 'remote', name: 'Remote', uri: URI.parse('vscode-remote://ssh-remote+host/repository') },
		]);
		harness.setWorktrees(new Map([
			['one', [
				worktree('one', 'Feature', '/worktrees/one-feature'),
				worktree('one', 'Main', '/repositories/one', { isMainCheckout: true }),
				worktree('one', 'Missing', '/worktrees/missing', { missing: true }),
				{ repositoryId: 'one', name: 'Remote WT', uri: URI.parse('vscode-remote://ssh-remote+host/worktree') },
			]],
		]));

		await harness.client.setWarmLease('mobile-owner', true);
		await harness.client.setWarmLease('mobile-owner', false);

		assert.deepStrictEqual({ channels: harness.channelRequests, calls: harness.calls.map(call => ({ command: call.command, payload: warmPayload(call) })) }, {
			channels: [PARADIS_SPACE_DISK_CHANNEL],
			calls: [
				{
					command: 'setWarmLease',
					payload: {
						ownerId: 'mobile-owner',
						active: true,
						targets: [{
							stateKey: 'one',
							name: 'Repository one',
							path: '/repositories/one',
							worktrees: [{
								stateKey: 'worktree:file:///worktrees/one-feature',
								name: 'Feature',
								path: '/worktrees/one-feature',
							}],
						}],
					},
				},
				{ command: 'setWarmLease', payload: { ownerId: 'mobile-owner', active: false, targets: [] } },
			],
		});
	});

	test('sends remote spaces to the connected remote channel and drops a vscode-remote space from a different authority', async () => {
		const harness = createClient({ remoteAuthority: 'ssh-remote+host' });
		harness.setRepositories([
			repository('one'),
			{ id: 'remote', name: 'Remote', uri: URI.parse('vscode-remote://ssh-remote+host/repository') },
			{ id: 'other-host', name: 'Other host', uri: URI.parse('vscode-remote://ssh-remote+other/repository') },
		]);
		harness.setWorktrees(new Map([
			['one', [worktree('one', 'Feature', '/worktrees/one-feature')]],
			['remote', [{ repositoryId: 'remote', name: 'Remote WT', uri: URI.parse('vscode-remote://ssh-remote+host/worktree') }]],
		]));

		await harness.client.setWarmLease('mobile-owner', true);

		assert.deepStrictEqual({
			channels: harness.channelRequests,
			remoteChannels: harness.remoteChannelRequests,
			local: warmPayload(harness.calls[0]!).targets,
			remote: warmPayload(harness.remoteCalls[0]!).targets,
		}, {
			channels: [PARADIS_SPACE_DISK_CHANNEL],
			remoteChannels: [PARADIS_SPACE_DISK_CHANNEL],
			local: [{ stateKey: 'one', name: 'Repository one', path: '/repositories/one', worktrees: [{ stateKey: 'worktree:file:///worktrees/one-feature', name: 'Feature', path: '/worktrees/one-feature' }] }],
			remote: [{
				stateKey: 'remote', name: 'Remote', path: '/repository',
				worktrees: [{ stateKey: 'worktree:vscode-remote://ssh-remote%2Bhost/worktree', name: 'Remote WT', path: '/worktree' }],
			}],
		});
	});

	test('sends active:false (not active:true with empty targets) to a connected machine with nothing to watch', async () => {
		const harness = createClient({ remoteAuthority: 'ssh-remote+host' });
		// リモート接続はあるが、登録済みリポジトリはすべて手元 → remoteTargets は空になる
		harness.setRepositories([repository('one')]);

		await harness.client.setWarmLease('mobile-owner', true);

		assert.deepStrictEqual({
			local: { active: warmPayload(harness.calls[0]!).active, targetCount: warmPayload(harness.calls[0]!).targets.length },
			remote: { active: warmPayload(harness.remoteCalls[0]!).active, targetCount: warmPayload(harness.remoteCalls[0]!).targets.length },
		}, {
			local: { active: true, targetCount: 1 },
			// targets が空でも active: true のまま送ると、以前そのマシンに向けた（対象がまだ
			// あった頃の）リースが残ってしまう。空バケツには active: false を送る。
			remote: { active: false, targetCount: 0 },
		});
	});

	test('measure merges local and remote spaces into one result', async () => {
		const harness = createClient({ remoteAuthority: 'ssh-remote+host' });
		harness.setRepositories([
			repository('one'),
			{ id: 'remote', name: 'Remote', uri: URI.parse('vscode-remote://ssh-remote+host/repository') },
		]);
		harness.setCallBehaviour(() => Promise.resolve({ spaces: [{ stateKey: 'one', name: 'Repository one', ownBytes: 10, worktrees: [] }], measuredAt: 0, durationMs: 0 }));
		harness.setRemoteCallBehaviour(() => Promise.resolve({ spaces: [{ stateKey: 'remote', name: 'Remote', ownBytes: 20, worktrees: [] }], measuredAt: 0, durationMs: 0 }));

		const result = await harness.client.measure(true);

		assert.deepStrictEqual(result.spaces.map(space => ({ stateKey: space.stateKey, ownBytes: space.ownBytes })), [
			{ stateKey: 'one', ownBytes: 10 },
			{ stateKey: 'remote', ownBytes: 20 },
		]);
	});

	test('awaits initialization and recollects targets on every five-minute heartbeat', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000 });
		const harness = createClient();
		const lease = harness.client.createWarmLease();
		await flushMicrotasks();
		const firstPayload = warmPayload(harness.calls[0]!);

		harness.setRepositories([repository('two', 'Repository Two')]);
		harness.setWorktrees(new Map([
			['two', [worktree('two', 'Updated', '/worktrees/two-updated')]],
		]));
		await clock.tickAsync(WARM_LEASE_RENEW_INTERVAL_MS);
		const secondPayload = warmPayload(harness.calls[1]!);
		lease.dispose();
		await flushMicrotasks();

		assert.deepStrictEqual({
			barrierReads: harness.barrierReads,
			ownerStable: firstPayload.ownerId === secondPayload.ownerId,
			ownerValid: /^space-disk:[A-Za-z0-9._:-]+$/.test(firstPayload.ownerId),
			targets: [firstPayload.targets, secondPayload.targets],
			release: warmPayload(harness.calls[2]!),
		}, {
			barrierReads: 2,
			ownerStable: true,
			ownerValid: true,
			targets: [
				[{ stateKey: 'one', name: 'Repository one', path: '/repositories/one', worktrees: [{ stateKey: 'worktree:file:///worktrees/one-feature', name: 'Feature', path: '/worktrees/one-feature' }] }],
				[{ stateKey: 'two', name: 'Repository Two', path: '/repositories/two', worktrees: [{ stateKey: 'worktree:file:///worktrees/two-updated', name: 'Updated', path: '/worktrees/two-updated' }] }],
			],
			release: { ownerId: firstPayload.ownerId, active: false, targets: [] },
		});
	});

	test('does not send a late acquire when a one-shot owner is released at the initialization barrier', async () => {
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);

		const acquire = harness.client.setWarmLease('mobile-owner', true);
		await flushMicrotasks();
		await harness.client.setWarmLease('mobile-owner', false);
		barrier.resolve(undefined);
		await acquire;

		assert.deepStrictEqual(harness.calls.map(call => warmPayload(call)), [
			{ ownerId: 'mobile-owner', active: false, targets: [] },
		]);
	});

	test('integrates provider release with client barrier cancellation before any acquire is sent', async () => {
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);
		const provider = new ParadisMobileWarmLeaseProvider(
			() => Promise.resolve(),
			(ownerId, active, cancellation) => harness.client.setWarmLease(ownerId, active, cancellation),
		);
		try {
			const acquire = provider.setLease('mobile-a', mobileSpaceWarmRequest(true));
			await flushMicrotasks();
			const release = provider.setLease('mobile-a', mobileSpaceWarmRequest(false));
			await flushMicrotasks();
			const beforeBarrier = harness.calls.map(call => warmPayload(call));
			barrier.resolve(undefined);
			await Promise.all([acquire, release]);

			const ownerId = 'mobile-a:spaceDisk:integration-lease';
			assert.deepStrictEqual({ beforeBarrier, final: harness.calls.map(call => warmPayload(call)) }, {
				beforeBarrier: [{ ownerId, active: false, targets: [] }],
				final: [{ ownerId, active: false, targets: [] }],
			});
		} finally {
			provider.dispose();
		}
	});

	test('does not send an acquire when provider release aborts after the initialization barrier settles but before the send turn', async () => {
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);
		const provider = new ParadisMobileWarmLeaseProvider(
			() => Promise.resolve(),
			(ownerId, active, cancellation) => harness.client.setWarmLease(ownerId, active, cancellation),
		);
		try {
			const acquire = provider.setLease('mobile-a', mobileSpaceWarmRequest(true));
			await flushMicrotasks();
			barrier.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
			const release = provider.setLease('mobile-a', mobileSpaceWarmRequest(false));
			await Promise.all([acquire, release]);

			const ownerId = 'mobile-a:spaceDisk:integration-lease';
			assert.deepStrictEqual(harness.calls.map(call => warmPayload(call)), [
				{ ownerId, active: false, targets: [] },
			]);
		} finally {
			provider.dispose();
		}
	});

	test('lets synchronous provider release win after a ready barrier but before the acquire send turn', async () => {
		const harness = createClient();
		const provider = new ParadisMobileWarmLeaseProvider(
			() => Promise.resolve(),
			(ownerId, active, cancellation) => harness.client.setWarmLease(ownerId, active, cancellation),
		);
		try {
			const acquire = provider.setLease('mobile-a', mobileSpaceWarmRequest(true));
			const release = provider.setLease('mobile-a', mobileSpaceWarmRequest(false));
			await Promise.all([acquire, release]);

			const ownerId = 'mobile-a:spaceDisk:integration-lease';
			assert.deepStrictEqual(harness.calls.map(call => warmPayload(call)), [
				{ ownerId, active: false, targets: [] },
			]);
		} finally {
			provider.dispose();
		}
	});

	test('integrates provider release as a trailing send after the client acquire has started', async () => {
		const harness = createClient();
		const acquireCompletion = deferred<unknown>();
		harness.setCallBehaviour(call => warmPayload(call).active ? acquireCompletion.promise : Promise.resolve(undefined));
		const provider = new ParadisMobileWarmLeaseProvider(
			() => Promise.resolve(),
			(ownerId, active, cancellation) => harness.client.setWarmLease(ownerId, active, cancellation),
		);
		try {
			const acquire = provider.setLease('mobile-a', mobileSpaceWarmRequest(true));
			await flushMicrotasks();
			const release = provider.setLease('mobile-a', mobileSpaceWarmRequest(false));
			await flushMicrotasks();
			const beforeAcquireCompletion = harness.calls.map(call => warmPayload(call));
			acquireCompletion.resolve(undefined);
			await Promise.all([acquire, release]);

			const ownerId = 'mobile-a:spaceDisk:integration-lease';
			assert.deepStrictEqual({ beforeAcquireCompletion, final: harness.calls.map(call => warmPayload(call)) }, {
				beforeAcquireCompletion: [{ ownerId, active: true, targets: [{ stateKey: 'one', name: 'Repository one', path: '/repositories/one', worktrees: [{ stateKey: 'worktree:file:///worktrees/one-feature', name: 'Feature', path: '/worktrees/one-feature' }] }] }],
				final: [
					{ ownerId, active: true, targets: [{ stateKey: 'one', name: 'Repository one', path: '/repositories/one', worktrees: [{ stateKey: 'worktree:file:///worktrees/one-feature', name: 'Feature', path: '/worktrees/one-feature' }] }] },
					{ ownerId, active: false, targets: [] },
				],
			});
		} finally {
			provider.dispose();
		}
	});

	test('shares one cancellable barrier wait for repeated updates of the same owner', async () => {
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);

		for (let index = 0; index < 1_000; index++) {
			void harness.client.setWarmLease('mobile-owner', true);
		}
		await flushMicrotasks();
		assert.strictEqual(harness.barrierReads, 1);

		await harness.client.setWarmLease('mobile-owner', false);
		assert.deepStrictEqual(harness.calls.map(call => warmPayload(call)), [
			{ ownerId: 'mobile-owner', active: false, targets: [] },
		]);
	});

	test('bounds active plus retiring barrier states and reuses a slot immediately after cancellation', async () => {
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);

		for (let index = 0; index < 128; index++) {
			void harness.client.setWarmLease(`owner-${index}`, true);
		}
		await flushMicrotasks();
		void harness.client.setWarmLease('overflow-owner', true);
		await flushMicrotasks();
		assert.strictEqual(harness.barrierReads, 128);

		await harness.client.setWarmLease('owner-0', false);
		void harness.client.setWarmLease('replacement-owner', true);
		await flushMicrotasks();

		assert.deepStrictEqual({
			barrierReads: harness.barrierReads,
			releases: harness.calls.map(call => warmPayload(call)),
		}, {
			barrierReads: 129,
			releases: [{ ownerId: 'owner-0', active: false, targets: [] }],
		});
	});

	test('does not send a late acquire when a desktop lease is disposed at the initialization barrier', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000 });
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);

		const lease = harness.client.createWarmLease();
		await flushMicrotasks();
		lease.dispose();
		barrier.resolve(undefined);
		for (let index = 0; index < 50 && harness.calls.length === 0; index++) {
			await Promise.resolve();
		}

		assert.deepStrictEqual(harness.calls.map(call => ({ command: call.command, payload: warmPayload(call) })), [{
			command: 'setWarmLease',
			payload: { ownerId: warmPayload(harness.calls[0]!).ownerId, active: false, targets: [] },
		}]);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('compensates a slow completed acquire with release after disposal', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000 });
		const harness = createClient();
		const acquireCompletion = deferred<unknown>();
		harness.setCallBehaviour(call => warmPayload(call).active ? acquireCompletion.promise : Promise.resolve(undefined));

		const lease = harness.client.createWarmLease();
		await flushMicrotasks();
		assert.strictEqual(harness.calls.length, 1);
		lease.dispose();
		await flushMicrotasks();
		assert.strictEqual(harness.calls.length, 1);

		acquireCompletion.resolve(undefined);
		await flushMicrotasks();
		const ownerId = warmPayload(harness.calls[0]!).ownerId;

		assert.deepStrictEqual(harness.calls.map(call => warmPayload(call)), [
			{ ownerId, active: true, targets: [{ stateKey: 'one', name: 'Repository one', path: '/repositories/one', worktrees: [{ stateKey: 'worktree:file:///worktrees/one-feature', name: 'Feature', path: '/worktrees/one-feature' }] }] },
			{ ownerId, active: false, targets: [] },
		]);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('cleans up a disposed desktop owner when acquire and trailing release both reject', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000 });
		const harness = createClient();
		const acquireCompletion = deferred<unknown>();
		let callCount = 0;
		harness.setCallBehaviour(() => ++callCount === 1 ? acquireCompletion.promise : Promise.reject(new Error('release failed')));

		const lease = harness.client.createWarmLease();
		await flushMicrotasks();
		lease.dispose();
		acquireCompletion.reject(new Error('acquire response lost'));
		await flushMicrotasks();

		assert.deepStrictEqual(harness.calls.map(call => warmPayload(call).active), [true, false]);
		assert.strictEqual(clock.countTimers(), 0);
	});
});

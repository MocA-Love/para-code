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
import {
	IParadisWorkspaceRepository,
	IParadisWorkspaceSwitchService,
	IParadisWorktree,
	IParadisWorktreeService,
} from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
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
}

type TestSpaceDiskClient = ParadisSpaceDiskClient & {
	setWarmLease(ownerId: string, active: boolean): Promise<void>;
	createWarmLease(): IDisposable;
};

function deferred<T>(): IDeferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolvePromise => resolve = resolvePromise);
	return { promise, resolve };
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

function createClient() {
	let repositories: readonly IParadisWorkspaceRepository[] = [repository('one')];
	let worktrees = new Map<string, readonly IParadisWorktree[]>([
		['one', [worktree('one', 'Feature', '/worktrees/one-feature')]],
	]);
	let barrierFactory: () => Promise<void> = () => Promise.resolve();
	let barrierReads = 0;
	const calls: IChannelCall[] = [];
	const channelRequests: string[] = [];
	let callBehaviour: (call: IChannelCall) => Promise<unknown> = () => Promise.resolve({ spaces: [], measuredAt: 0, durationMs: 0 });
	const channel = {
		call<T>(command: string, args?: unknown): Promise<T> {
			const call = { command, args };
			calls.push(call);
			return callBehaviour(call) as Promise<T>;
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
	const client = new ParadisSpaceDiskClient(workspaceSwitchService, worktreeService, sharedProcessService) as TestSpaceDiskClient;
	return {
		calls,
		channelRequests,
		client,
		get barrierReads() { return barrierReads; },
		setBarrierFactory: (factory: () => Promise<void>) => barrierFactory = factory,
		setCallBehaviour: (behaviour: (call: IChannelCall) => Promise<unknown>) => callBehaviour = behaviour,
		setRepositories: (value: readonly IParadisWorkspaceRepository[]) => repositories = value,
		setWorktrees: (value: Map<string, readonly IParadisWorktree[]>) => worktrees = value,
	};
}

function warmPayload(call: IChannelCall): { readonly ownerId: string; readonly active: boolean; readonly targets: readonly IParadisSpaceDiskTarget[] } {
	return (call.args as readonly [{ readonly ownerId: string; readonly active: boolean; readonly targets: readonly IParadisSpaceDiskTarget[] }])[0];
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

	test('does not send a late acquire when a desktop lease is disposed at the initialization barrier', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000 });
		const harness = createClient();
		const barrier = deferred<void>();
		harness.setBarrierFactory(() => barrier.promise);

		const lease = harness.client.createWarmLease();
		await flushMicrotasks();
		lease.dispose();
		barrier.resolve(undefined);
		await flushMicrotasks();

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
});

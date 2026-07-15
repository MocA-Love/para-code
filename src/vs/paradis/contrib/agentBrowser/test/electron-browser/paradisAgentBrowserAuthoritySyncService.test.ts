/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { paradisCreateBrowserViewInitialization } from '../../../../../workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.js';
import { ITerminalGroupService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisBindingAuthorityManifest } from '../../common/paradisBindingAuthority.js';
import { ParadisAgentBrowserAuthoritySyncService } from '../../electron-browser/paradisAgentBrowserAuthoritySyncService.js';
import { IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, ParadisBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('condition was not reached');
}

suite('ParadisAgentBrowserAuthoritySyncService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture(
		syncManifest?: (manifest: IParadisBindingAuthorityManifest) => Promise<{ accepted: true; revision: number }>,
		browser?: {
			readonly whenInitialized: Promise<boolean>;
			readonly knownViews: Map<string, never>;
			readonly scopes: Map<string, ParadisBindingScope>;
		},
	) {
		const terminalBarrier = new DeferredPromise<void>();
		const browserViewBarrier = new DeferredPromise<boolean>();
		const browserScopeBarrier = new DeferredPromise<void>();
		const paneTokensChanged = store.add(new Emitter<void>());
		const terminalInstancesChanged = store.add(new Emitter<void>());
		const terminalConnectionChanged = store.add(new Emitter<void>());
		const processIdReady = store.add(new Emitter<unknown>());
		const terminalGroupsChanged = store.add(new Emitter<void>());
		const browserViewsChanged = store.add(new Emitter<void>());
		const terminalScopeChanged = store.add(new Emitter<unknown>());
		const browserScopeChanged = store.add(new Emitter<unknown>());
		const willSwitchScope = store.add(new Emitter<string | undefined>());
		const didSwitchScope = store.add(new Emitter<string>());
		const willShutdown = store.add(new Emitter<unknown>());

		const activeInstance = { instanceId: 1, isDisposed: false, processId: 101 };
		const parkedInstance = { instanceId: 2, isDisposed: false, processId: 202 };
		const tokenEntries = [
			{ instanceId: 1, token: 'active-token' },
			{ instanceId: 2, token: 'parked-token' },
			{ instanceId: 3, token: 'pidless-token' },
		];
		const instanceByToken = new Map(tokenEntries.map(entry => [entry.token, entry.instanceId]));
		const tokenByInstance = new Map(tokenEntries.map(entry => [entry.instanceId, entry.token]));
		const terminalScopes = new Map<number, ParadisBindingScope>([
			[1, { kind: 'managed', stateKey: 'space-a' }],
			[2, { kind: 'managed', stateKey: 'space-b' }],
			[3, { kind: 'pending' }],
		]);
		const browserScopes = browser?.scopes ?? new Map<string, ParadisBindingScope>([
			['view-a', { kind: 'managed', stateKey: 'space-a' }],
			['view-z', { kind: 'pending' }],
		]);
		const knownBrowserViews = browser?.knownViews ?? new Map<string, never>([['view-z', undefined as never], ['view-a', undefined as never]]);
		const manifests: IParadisBindingAuthorityManifest[] = [];
		const channel = {
			call: async <T>(command: string, args: unknown[]) => {
				assert.strictEqual(command, 'syncBindingAuthority');
				const manifest = args[0] as IParadisBindingAuthorityManifest;
				manifests.push(manifest);
				return (await (syncManifest?.(manifest) ?? Promise.resolve({ accepted: true as const, revision: manifest.revision }))) as T;
			},
		};
		const service = store.add(new ParadisAgentBrowserAuthoritySyncService(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{
				instances: [activeInstance], whenConnected: terminalBarrier.p,
				onDidChangeInstances: terminalInstancesChanged.event,
				onDidChangeConnectionState: terminalConnectionChanged.event,
				onAnyInstanceProcessIdReady: processIdReady.event,
			} as unknown as ITerminalService,
			{
				paradisParkedGroups: [{ terminalInstances: [parkedInstance] }],
				onDidChangeGroups: terminalGroupsChanged.event,
			} as unknown as ITerminalGroupService,
			{
				listPaneTokens: () => tokenEntries,
				getTokenForInstance: (instanceId: number) => tokenByInstance.get(instanceId),
				getInstanceForToken: (token: string) => instanceByToken.get(token),
				onDidChange: paneTokensChanged.event,
			} as unknown as IParadisPaneTokenService,
			{
				whenInitialized: browser?.whenInitialized ?? browserViewBarrier.p,
				getKnownBrowserViews: () => knownBrowserViews,
				onDidChangeBrowserViews: browserViewsChanged.event,
			} as unknown as IBrowserViewWorkbenchService,
			{
				initializationBarrier: browserScopeBarrier.p,
				resolveScope: (viewId: string) => browserScopes.get(viewId) ?? { kind: 'pending' },
				onDidChangeStableScope: browserScopeChanged.event,
			} as unknown as IParadisBrowserScopeService,
			{
				resolveScope: (instanceId: number) => terminalScopes.get(instanceId) ?? { kind: 'pending' },
				onDidChangeStableScope: terminalScopeChanged.event,
			} as unknown as IParadisTerminalScopeService,
			{
				onWillSwitchScope: willSwitchScope.event,
				onDidSwitchScope: didSwitchScope.event,
			} as unknown as IParadisWorkspaceSwitchService,
			{ willShutdown: false, onWillShutdown: willShutdown.event } as unknown as ILifecycleService,
		));

		return {
			service, manifests, terminalBarrier, browserViewBarrier, browserScopeBarrier,
			paneTokensChanged, terminalInstancesChanged, terminalConnectionChanged, processIdReady,
			terminalGroupsChanged, browserViewsChanged, terminalScopeChanged, browserScopeChanged,
			willSwitchScope, didSwitchScope, willShutdown,
		};
	}

	test('sends all live panes and known BrowserViews incomplete until every restoration barrier settles', async () => {
		const fixture = createFixture();
		const incompleteRevision = await fixture.service.syncNow();
		const incomplete = fixture.manifests.find(manifest => manifest.revision === incompleteRevision);
		assert.ok(incomplete);
		assert.strictEqual(incomplete.complete, false);
		assert.deepStrictEqual(incomplete.panes, [
			{ token: 'active-token', shellPid: 101, scope: { kind: 'managed', stateKey: 'space-a' } },
			{ token: 'parked-token', shellPid: 202, scope: { kind: 'managed', stateKey: 'space-b' } },
			{ token: 'pidless-token', scope: { kind: 'pending' } },
		]);
		assert.deepStrictEqual(incomplete.browserViews, [
			{ viewId: 'view-a', scope: { kind: 'managed', stateKey: 'space-a' } },
			{ viewId: 'view-z', scope: { kind: 'pending' } },
		]);

		await fixture.terminalBarrier.complete();
		await fixture.browserViewBarrier.complete(true);
		await fixture.browserScopeBarrier.complete();
		const completeRevision = await fixture.service.syncNow();
		const complete = fixture.manifests.find(manifest => manifest.revision === completeRevision);
		assert.ok(complete);
		assert.strictEqual(complete.complete, true);
		assert.ok(completeRevision > incompleteRevision);
	});

	test('publishes a complete manifest after a failed initial snapshot later recovers a retained view and scope', async () => {
		const knownViews = new Map<string, never>();
		const scopes = new Map<string, ParadisBindingScope>();
		let retryTimer: (() => void) | undefined;
		let attempts = 0;
		let notifyBrowserViewsChanged: () => void = () => undefined;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => ++attempts < 3 ? Promise.reject(new Error('Main temporarily unavailable')) : Promise.resolve(['retained']),
			viewId => {
				knownViews.set(viewId, undefined as never);
				scopes.set(viewId, { kind: 'managed', stateKey: 'space-a' });
				notifyBrowserViewsChanged();
			},
			() => undefined,
			{
				setTimeout: callback => {
					assert.strictEqual(retryTimer, undefined);
					retryTimer = callback;
					return callback;
				},
				clearTimeout: handle => {
					if (retryTimer === handle) {
						retryTimer = undefined;
					}
				},
			},
		);
		store.add(initialization.listener);
		const fixture = createFixture(undefined, { whenInitialized: initialization.whenInitialized, knownViews, scopes });
		notifyBrowserViewsChanged = () => fixture.browserViewsChanged.fire();
		fixture.terminalBarrier.complete();

		for (let failure = 0; failure < 2; failure++) {
			await Promise.resolve();
			await Promise.resolve();
			assert.ok(retryTimer);
			const retry = retryTimer;
			retryTimer = undefined;
			retry();
		}
		assert.strictEqual(await initialization.whenInitialized, true);
		fixture.browserScopeBarrier.complete();
		await eventually(() => fixture.manifests.some(manifest => manifest.complete));

		const complete = fixture.manifests.findLast(manifest => manifest.complete);
		assert.ok(complete);
		assert.deepStrictEqual(complete.browserViews, [
			{ viewId: 'retained', scope: { kind: 'managed', stateKey: 'space-a' } },
		]);
	});

	test('coalesces queued callers behind one in-flight sync and returns only its exact accepted revision', async () => {
		const gates: DeferredPromise<{ accepted: true; revision: number }>[] = [];
		let activeCalls = 0;
		let maximumActiveCalls = 0;
		const fixture = createFixture(async manifest => {
			activeCalls++;
			maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
			const gate = new DeferredPromise<{ accepted: true; revision: number }>();
			gates.push(gate);
			try {
				return await gate.p;
			} finally {
				activeCalls--;
			}
		});
		await eventually(() => gates.length === 1);

		const first = fixture.service.syncNow();
		const second = fixture.service.syncNow();
		assert.strictEqual(gates.length, 1);
		await gates[0].complete({ accepted: true, revision: fixture.manifests[0].revision });
		await eventually(() => gates.length === 2);
		const coalescedRevision = fixture.manifests[1].revision;
		await gates[1].complete({ accepted: true, revision: coalescedRevision });

		assert.deepStrictEqual(await Promise.all([first, second]), [coalescedRevision, coalescedRevision]);
		assert.strictEqual(fixture.service.acceptedRevision, coalescedRevision);
		assert.strictEqual(maximumActiveCalls, 1);
		assert.deepStrictEqual(fixture.manifests.map(manifest => manifest.revision), [1, 2]);
	});

	test('rejects an inexact acknowledgement and recovers only through a newer manifest revision', async () => {
		let calls = 0;
		const fixture = createFixture(async manifest => {
			calls++;
			return calls === 2
				? { accepted: true, revision: manifest.revision + 1 }
				: { accepted: true, revision: manifest.revision };
		});
		await eventually(() => fixture.service.acceptedRevision === 1);

		await assert.rejects(fixture.service.syncNow(), /acknowledgement was rejected/);
		assert.strictEqual(fixture.service.acceptedRevision, 1);
		const recoveredRevision = await fixture.service.syncNow();

		assert.strictEqual(recoveredRevision, 3);
		assert.strictEqual(fixture.service.acceptedRevision, 3);
		assert.deepStrictEqual(fixture.manifests.map(manifest => manifest.revision), [1, 2, 3]);
	});

	test('does not allocate explicit waiters for a background event storm and bounds explicit callers', async () => {
		const gates: DeferredPromise<{ accepted: true; revision: number }>[] = [];
		const fixture = createFixture(async () => {
			const gate = new DeferredPromise<{ accepted: true; revision: number }>();
			gates.push(gate);
			return gate.p;
		});
		await eventually(() => gates.length === 1);
		for (let index = 0; index < 1_024; index++) {
			fixture.paneTokensChanged.fire();
		}

		const explicit = Array.from({ length: 256 }, () => fixture.service.syncNow());
		await assert.rejects(fixture.service.syncNow(), /waiter capacity/i);
		await gates[0].complete({ accepted: true, revision: fixture.manifests[0].revision });
		await eventually(() => gates.length === 2);
		await gates[1].complete({ accepted: true, revision: fixture.manifests[1].revision });

		assert.deepStrictEqual(new Set(await Promise.all(explicit)), new Set([fixture.manifests[1].revision]));
		assert.strictEqual(fixture.manifests.length, 2);
	});

	test('subscribes directly to every authority input trigger', async () => {
		const fixture = createFixture();
		await fixture.terminalBarrier.complete();
		await fixture.browserViewBarrier.complete(true);
		await fixture.browserScopeBarrier.complete();
		await fixture.service.syncNow();
		const triggers: Array<() => void> = [
			() => fixture.paneTokensChanged.fire(),
			() => fixture.terminalInstancesChanged.fire(),
			() => fixture.terminalConnectionChanged.fire(),
			() => fixture.processIdReady.fire(undefined),
			() => fixture.terminalGroupsChanged.fire(),
			() => fixture.browserViewsChanged.fire(),
			() => fixture.terminalScopeChanged.fire(undefined),
			() => fixture.browserScopeChanged.fire(undefined),
			() => fixture.willSwitchScope.fire('space-a'),
			() => fixture.didSwitchScope.fire('space-b'),
		];
		for (const trigger of triggers) {
			const previousRevision = fixture.service.acceptedRevision;
			trigger();
			await eventually(() => fixture.service.acceptedRevision > previousRevision);
		}
	});

	test('freezes on shutdown before disposal-driven empty snapshots can be sent', async () => {
		const fixture = createFixture();
		await fixture.service.syncNow();
		const sentBeforeShutdown = fixture.manifests.length;

		fixture.willShutdown.fire(undefined);
		fixture.paneTokensChanged.fire();
		fixture.terminalInstancesChanged.fire();
		fixture.browserViewsChanged.fire();
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.strictEqual(fixture.service.isFrozen, true);
		assert.strictEqual(fixture.manifests.length, sentBeforeShutdown);
		await assert.rejects(fixture.service.syncNow(), /shutting down/i);
	});
});

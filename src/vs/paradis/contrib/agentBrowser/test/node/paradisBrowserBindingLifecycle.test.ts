/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExactBrowserViewDescriptor, IParadisPaneBinding } from '../../common/paradisAgentBrowser.js';
import { ParadisBindingAuthority } from '../../common/paradisBindingAuthority.js';
import { ParadisExactViewBackgroundThrottlingCoordinator } from '../../common/paradisExactViewBackgroundThrottling.js';
import { ParadisRemovedBrowserBindingReconciler, ParadisSerializedReconciler, paradisBindingMatchesGeneration, paradisBindingsForMissingPages, paradisBrowserViewIdsWereRemoved } from '../../common/paradisBrowserBindingLifecycle.js';
import { ParadisAgentBrowserChannel } from '../../node/paradisAgentBrowserChannel.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

function binding(token: string, pageId: string, generation: number = 1, boundAt: number = 1): IParadisPaneBinding {
	return {
		token,
		pageId,
		pageInfo: { url: `https://example.test/${pageId}`, title: pageId },
		generation,
		boundAt,
		scope: { kind: 'unscoped' },
	};
}

function rendererManifest(revision: number, windowIds: readonly number[]): {
	readonly revision: number;
	readonly entries: readonly {
		readonly windowId: number;
		readonly rendererGeneration: number;
		readonly windowRevision: number;
		readonly claimed: false;
	}[];
} {
	return {
		revision,
		entries: windowIds.map(windowId => ({ windowId, rendererGeneration: 1, windowRevision: revision, claimed: false })),
	};
}

suite('ParadisBrowserBindingLifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns only bindings whose BrowserView disappeared', () => {
		const bindings = [binding('a', 'page-1'), binding('b', 'page-2')];

		assert.deepStrictEqual(
			paradisBindingsForMissingPages(bindings, new Set(['page-2'])).map(item => item.token),
			['a'],
		);
	});

	test('keeps live BrowserViews including views parked by a space switch', () => {
		const bindings = [binding('active', 'page-active'), binding('parked', 'page-parked')];

		assert.deepStrictEqual(
			paradisBindingsForMissingPages(bindings, new Set(['page-active', 'page-parked'])),
			[],
		);
	});

	test('returns every token when multiple bindings share a missing page', () => {
		const bindings = [binding('a', 'page-1', 1), binding('b', 'page-1', 2), binding('c', 'page-2', 3)];

		assert.deepStrictEqual(
			paradisBindingsForMissingPages(bindings, new Set(['page-2'])).map(item => item.token),
			['a', 'b'],
		);
	});

	test('handles empty bindings and an empty live-page set', () => {
		assert.deepStrictEqual(paradisBindingsForMissingPages([], new Set()), []);
		assert.deepStrictEqual(
			paradisBindingsForMissingPages([binding('a', 'page-1')], new Set()).map(item => item.token),
			['a'],
		);
	});

	test('matches only the exact observed binding generation', () => {
		const current = binding('a', 'page-1', 7);

		assert.strictEqual(paradisBindingMatchesGeneration(undefined, 7), false);
		assert.strictEqual(paradisBindingMatchesGeneration(current, 6), false);
		assert.strictEqual(paradisBindingMatchesGeneration(current, 7), true);
		assert.strictEqual(paradisBindingMatchesGeneration(current, 8), false);
	});

	test('schedules lifecycle reconciliation only when a known BrowserView was removed', () => {
		assert.strictEqual(paradisBrowserViewIdsWereRemoved(new Set(), new Set(['page-1'])), false);
		assert.strictEqual(paradisBrowserViewIdsWereRemoved(new Set(['page-1']), new Set(['page-1', 'page-2'])), false);
		assert.strictEqual(paradisBrowserViewIdsWereRemoved(new Set(['page-1']), new Set(['page-1'])), false);
		assert.strictEqual(paradisBrowserViewIdsWereRemoved(new Set(['page-1', 'page-2']), new Set(['page-2'])), true);
		assert.strictEqual(paradisBrowserViewIdsWereRemoved(new Set(['page-1']), new Set(['page-2'])), true);
	});

	test('reconciles only confirmed removed pages and every token sharing that page', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a-1', 'page-a', 1), binding('a-2', 'page-a', 2), binding('c', 'page-c', 3)];
		const calls: string[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async (token, generation) => {
				calls.push(`${token}:${generation}`);
				bindings = bindings.filter(item => item.token !== token);
				return true;
			},
		});

		livePageIds = new Set();
		assert.strictEqual(reconciler.observeKnownPageIds(livePageIds), true);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(calls, ['a-1:1', 'a-2:2']);
		assert.deepStrictEqual(bindings.map(item => item.token), ['c']);
	});

	test('cancels a pending removal when the page is re-added before unbind', async () => {
		let livePageIds = new Set(['page-a']);
		let releaseList!: () => void;
		let markListStarted!: () => void;
		const listStarted = new Promise<void>(resolve => markListStarted = resolve);
		const listGate = new Promise<void>(resolve => releaseList = resolve);
		const calls: string[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => {
				markListStarted();
				await listGate;
				return [binding('a', 'page-a')];
			},
			unbindIfCurrent: async token => {
				calls.push(token);
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		const reconcile = reconciler.reconcile();
		await listStarted;
		livePageIds = new Set(['page-a']);
		reconciler.observeKnownPageIds(livePageIds);
		releaseList();

		assert.strictEqual(await reconcile, false);
		assert.deepStrictEqual(calls, []);
		assert.strictEqual(reconciler.hasPendingRemovals, false);
	});

	test('rechecks liveness before each token unbind on the same page', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a-1', 'page-a', 1), binding('a-2', 'page-a', 2)];
		const calls: string[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async token => {
				calls.push(token);
				bindings = bindings.filter(item => item.token !== token);
				livePageIds = new Set(['page-a']);
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(calls, ['a-1']);
		assert.deepStrictEqual(bindings.map(item => item.token), ['a-2']);
	});

	test('keeps a removal pending after a transient binding-list failure and retries', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a', 'page-a')];
		let listCalls = 0;
		const calls: string[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => {
				if (++listCalls === 1) {
					throw new Error('shared process unavailable');
				}
				return bindings;
			},
			unbindIfCurrent: async token => {
				calls.push(token);
				bindings = [];
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		assert.deepStrictEqual(calls, []);
		assert.strictEqual(await reconciler.reconcile(), false);
		assert.deepStrictEqual(calls, ['a']);
	});

	test('retries only the failed token when multiple tokens share a removed page', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a-1', 'page-a', 1), binding('a-2', 'page-a', 2)];
		let failedOnce = false;
		const calls: string[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async token => {
				calls.push(token);
				if (token === 'a-2' && !failedOnce) {
					failedOnce = true;
					throw new Error('temporary IPC failure');
				}
				bindings = bindings.filter(item => item.token !== token);
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(calls, ['a-1', 'a-2', 'a-2']);
	});

	test('completes a stale false candidate without promoting the new generation', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a', 'page-a', 1)];
		const generations: number[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async (_token, generation) => {
				generations.push(generation);
				if (generation === 1) {
					bindings = [binding('a', 'page-a', 2)];
					return false;
				}
				bindings = [];
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(generations, [1]);
		assert.deepStrictEqual(bindings, [binding('a', 'page-a', 2)]);
	});

	test('does not adopt a rebind created while the initial binding snapshot was failing', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings: IParadisPaneBinding[] = [];
		let listCalls = 0;
		const generations: number[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			now: () => 100,
			getLivePageIds: () => livePageIds,
			listBindings: async () => {
				if (++listCalls === 1) {
					throw new Error('initial snapshot failed');
				}
				return bindings;
			},
			unbindIfCurrent: async (_token, generation) => {
				generations.push(generation);
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		bindings = [binding('a', 'page-a', 2, 101)];
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(generations, []);
		assert.deepStrictEqual(bindings, [binding('a', 'page-a', 2, 101)]);
	});

	test('conservatively excludes a binding created in the removal observation millisecond', async () => {
		let livePageIds = new Set(['page-a']);
		const bindings = [binding('a', 'page-a', 2, 100)];
		const generations: number[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			now: () => 100,
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async (_token, generation) => {
				generations.push(generation);
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(generations, []);
		assert.deepStrictEqual(bindings, [binding('a', 'page-a', 2, 100)]);
	});

	test('retries an exception with only the original expected generation', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a', 'page-a', 7)];
		const generations: number[] = [];
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			now: () => 100,
			getLivePageIds: () => livePageIds,
			listBindings: async () => bindings,
			unbindIfCurrent: async (_token, generation) => {
				generations.push(generation);
				if (generations.length === 1) {
					throw new Error('temporary IPC failure');
				}
				bindings = [];
				return true;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.deepStrictEqual(generations, [7, 7]);
	});

	test('keeps a removal pending when post-fetch confirmation fails', async () => {
		let livePageIds = new Set(['page-a']);
		let bindings = [binding('a', 'page-a')];
		let listCalls = 0;
		let unbindCalls = 0;
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => {
				listCalls++;
				if (listCalls === 2) {
					throw new Error('post-fetch failed');
				}
				return bindings;
			},
			unbindIfCurrent: async () => {
				unbindCalls++;
				bindings = [];
				throw new Error('outcome unknown after side effect');
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.strictEqual(unbindCalls, 1);
	});

	test('does not perform retry IPC after disposal', async () => {
		let livePageIds = new Set(['page-a']);
		let listCalls = 0;
		let unbindCalls = 0;
		const reconciler = new ParadisRemovedBrowserBindingReconciler(livePageIds, {
			getLivePageIds: () => livePageIds,
			listBindings: async () => {
				listCalls++;
				throw new Error('offline');
			},
			unbindIfCurrent: async () => {
				unbindCalls++;
				return false;
			},
		});

		livePageIds = new Set();
		reconciler.observeKnownPageIds(livePageIds);
		assert.strictEqual(await reconciler.reconcile(), true);
		reconciler.dispose();
		assert.strictEqual(await reconciler.reconcile(), false);

		assert.strictEqual(listCalls, 1);
		assert.strictEqual(unbindCalls, 0);
	});

	test('serializes reconciliation and coalesces requests received while running', async () => {
		let calls = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => markFirstStarted = resolve);
		const firstGate = new Promise<void>(resolve => releaseFirst = resolve);
		const reconciler = new ParadisSerializedReconciler(async () => {
			calls++;
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			if (calls === 1) {
				markFirstStarted();
				await firstGate;
			}
			concurrent--;
		});

		const first = reconciler.request();
		await firstStarted;
		const second = reconciler.request();
		const third = reconciler.request();
		releaseFirst();
		await Promise.all([first, second, third]);

		assert.strictEqual(calls, 2);
		assert.strictEqual(maxConcurrent, 1);
	});

	test('does not start queued or new reconciliation after disposal', async () => {
		let calls = 0;
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => markFirstStarted = resolve);
		const firstGate = new Promise<void>(resolve => releaseFirst = resolve);
		const reconciler = new ParadisSerializedReconciler(async () => {
			calls++;
			markFirstStarted();
			await firstGate;
		});

		const first = reconciler.request();
		await firstStarted;
		void reconciler.request();
		reconciler.dispose();
		releaseFirst();
		await first;
		await reconciler.request();

		assert.strictEqual(calls, 1);
	});

	test('continues a queued reconciliation after an operation error without rejecting', async () => {
		let calls = 0;
		let errors = 0;
		let requestAgain = () => undefined;
		const reconciler = new ParadisSerializedReconciler(async () => {
			calls++;
			if (calls === 1) {
				requestAgain();
				throw new Error('IPC failed');
			}
		}, () => errors++);
		requestAgain = () => { void reconciler.request(); };

		await assert.doesNotReject(reconciler.request());

		assert.strictEqual(calls, 2);
		assert.strictEqual(errors, 1);
	});

	test('runs a request arriving at the operation completion microtask boundary', async () => {
		let calls = 0;
		let releaseGate!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>(resolve => markStarted = resolve);
		const gate = new Promise<void>(resolve => releaseGate = resolve);
		const reconciler = new ParadisSerializedReconciler(() => {
			calls++;
			if (calls === 1) {
				markStarted();
				return gate;
			}
			return Promise.resolve();
		});

		const first = reconciler.request();
		await started;
		let boundaryRequest!: Promise<void>;
		void gate.then(() => boundaryRequest = reconciler.request());
		releaseGate();
		await first;
		await boundaryRequest;

		assert.strictEqual(calls, 2);
	});

	test('conditional unbind has no side effects when the generation is stale', async () => {
		const fixture = createServiceFixture(7);

		assert.strictEqual(await fixture.service.unbindIfCurrent(fixture.connection, 'token', 6), false);
		assert.strictEqual(await fixture.service.unbindIfCurrent(fixture.connection, 'token', 8), false);
		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.deepStrictEqual(fixture.effects, []);
	});

	test('conditional unbind has no side effects when the binding is missing', async () => {
		const fixture = createServiceFixture(7);
		fixture.bindings.clear();

		assert.strictEqual(await fixture.service.unbindIfCurrent(fixture.connection, 'token', 7), false);
		assert.deepStrictEqual(fixture.effects, []);
	});

	test('conditional unbind removes the matching generation and advances its resources', async () => {
		const fixture = createServiceFixture(7);

		assert.strictEqual(await fixture.service.unbindIfCurrent(fixture.connection, 'token', 7), true);
		assert.strictEqual(fixture.bindings.has('token'), false);
		assert.deepStrictEqual(fixture.effects, [
			'generation:101',
			'close:token',
			'retire:token:101',
		]);
	});

	test('lists the generation observed by the renderer', async () => {
		const fixture = createServiceFixture(7);

		assert.deepStrictEqual(await fixture.service.listBindings(fixture.connection), [binding('token', 'page-1', 7)]);
	});

	test('keeps missing pane tokens while a reloading renderer sends an incomplete manifest', async () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });

		await fixture.service.syncBindingAuthority(fixture.connection, { revision: 2, complete: false, panes: [], browserViews: [] });

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), true);
		assert.deepStrictEqual(fixture.effects, []);
	});

	test('retires a missing pane only after the renderer sends an authoritative complete manifest', async () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });

		await fixture.service.syncBindingAuthority(fixture.connection, { revision: 2, complete: true, panes: [], browserViews: [] });

		assert.strictEqual(fixture.bindings.has('token'), false);
		assert.strictEqual(fixture.paneShells.has('token'), false);
		assert.deepStrictEqual(fixture.effects, [
			'generation:101',
			'close:token',
			'retire:token:101',
			'retireGateway:token',
			'forget:token:101',
		]);
	});

	test('keeps a live pane binding while clearing a PID missing from a complete manifest', async () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });

		await fixture.service.syncBindingAuthority(fixture.connection, {
			revision: 2,
			complete: true,
			panes: [{ token: 'token', scope: { kind: 'unscoped' } }],
			browserViews: [],
		});

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), false);
		assert.deepStrictEqual(fixture.effects, ['close:token']);
	});

	test('keeps window state through an IPC reload gap and retires it only after Main omits the destroyed window', () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });
		const observeManifest = (fixture.service as unknown as {
			observeRendererManifest(manifest: { readonly revision: number; readonly entries: readonly { windowId: number }[] }): void;
		}).observeRendererManifest.bind(fixture.service);

		observeManifest(rendererManifest(1, [1]));
		observeManifest(rendererManifest(2, [1]));
		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), true);

		observeManifest(rendererManifest(3, []));
		assert.strictEqual(fixture.bindings.has('token'), false);
		assert.strictEqual(fixture.paneShells.has('token'), false);
	});

	test('ignores a delayed older Main window manifest after a newer reload manifest', () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });
		const observeManifest = (fixture.service as unknown as {
			observeRendererManifest(manifest: { readonly revision: number; readonly entries: readonly { windowId: number }[] }): void;
		}).observeRendererManifest.bind(fixture.service);

		observeManifest(rendererManifest(5, [1]));
		observeManifest(rendererManifest(4, []));

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), true);
	});

	test('ignores a contradictory Main window manifest with the same revision', () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });
		const observeManifest = (fixture.service as unknown as {
			observeRendererManifest(manifest: { readonly revision: number; readonly entries: readonly { windowId: number }[] }): void;
		}).observeRendererManifest.bind(fixture.service);

		observeManifest(rendererManifest(5, [1]));
		observeManifest(rendererManifest(5, []));

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), true);
	});

	test('keeps state on disconnect and rejects the old renderer after a new connection reattaches', async () => {
		const fixture = createServiceFixture(7);
		const oldConnection = fixture.connection;
		const newConnection = {};
		fixture.service.unregisterRendererConnection('window:1', oldConnection);

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.service.isCurrentRendererConnection('window:1', oldConnection), false);

		fixture.service.registerRendererConnection('window:1', newConnection);
		const oldChannel = new ParadisAgentBrowserChannel(fixture.service, oldConnection);
		const newChannel = new ParadisAgentBrowserChannel(fixture.service, newConnection);
		assert.throws(() => oldChannel.call('window:1', 'listBindings'), /protocol/i);
		await assert.rejects(newChannel.call('window:1', 'listBindings'), /protocol/i);
		await newChannel.call('window:1', 'syncBindingAuthority', [{
			revision: 1,
			complete: false,
			panes: [{ token: 'token', scope: { kind: 'unscoped' } }],
			browserViews: [],
		}]);
		assert.deepStrictEqual(await newChannel.call('window:1', 'listBindings'), [binding('token', 'page-1', 7)]);
	});

	test('fails a malformed complete pane manifest closed instead of retiring every pane', async () => {
		const fixture = createServiceFixture(7);
		fixture.paneShells.set('token', { windowCtx: 'window:1', token: 'token', shellPid: 101 });
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		const channel = new ParadisAgentBrowserChannel(fixture.service, connection);

		await assert.rejects(channel.call('window:1', 'syncBindingAuthority', [{ complete: true, entries: 'malformed' }]), /protocol/i);

		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), true);
	});

	test('waits for server startup and returns only the actual gateway port through the renderer channel', async () => {
		const fixture = createServiceFixture(7);
		let completeStartup: (() => void) | undefined;
		const serverStart = new Promise<void>(resolve => completeStartup = resolve);
		Object.assign(fixture.service as object, {
			_serverStartPromise: serverStart,
			_port: undefined,
			_serverDisposed: false,
		});
		const channel = new ParadisAgentBrowserChannel(fixture.service);
		let settled = false;
		const endpoint = channel.call<{ port: number }>('window:1', 'getGatewayEndpoint').then(value => {
			settled = true;
			return value;
		});

		await Promise.resolve();
		assert.strictEqual(settled, false);
		Object.assign(fixture.service as object, { _port: 54321 });
		completeStartup?.();

		assert.deepStrictEqual(await endpoint, { port: 54321 });
	});

	test('does not fall back to the default port when the gateway is unavailable or disposed', async () => {
		const fixture = createServiceFixture(7);
		const channel = new ParadisAgentBrowserChannel(fixture.service);
		Object.assign(fixture.service as object, {
			_serverStartPromise: Promise.resolve(),
			_port: undefined,
			_serverDisposed: false,
		});

		await assert.rejects(channel.call('window:1', 'getGatewayEndpoint'), /gateway.*not available/i);

		Object.assign(fixture.service as object, { _port: 54321, _serverDisposed: true });
		await assert.rejects(channel.call('window:1', 'getGatewayEndpoint'), /gateway.*not available/i);
	});
});

function createServiceFixture(generation: number): {
	readonly service: ParadisAgentBrowserService;
	readonly connection: object;
	readonly bindings: Map<string, object>;
	readonly paneShells: Map<string, object>;
	readonly effects: string[];
} {
	const effects: string[] = [];
	const bindings = new Map<string, object>([[
		'token',
		{
			windowCtx: 'window:1',
			pageId: 'page-1',
			pageInfo: { url: 'https://example.test/page-1', title: 'page-1' },
			generation,
			boundAt: 1,
			exactView: { windowId: 1, viewId: 'page-1', targetId: 'target-1', viewLease: 'lease-1' },
			scope: { kind: 'unscoped' },
		},
	]]);
	const connection = {};
	const authority = new ParadisBindingAuthority<string, object, IParadisExactBrowserViewDescriptor, object>({
		now: () => 0,
		createTicketId: () => 'unused',
		copyDescriptor: descriptor => Object.freeze({ ...descriptor }),
	});
	authority.registerConnection('window:1', connection);
	authority.acceptManifest(connection, {
		revision: 1,
		complete: true,
		panes: [{ token: 'token', scope: { kind: 'unscoped' } }],
		browserViews: [],
	});
	authority.recordBindingMutation('token', bindings.get('token'));
	const paneShells = new Map<string, object>();
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_bindings: bindings,
		_bindingAuthority: authority,
		_backgroundThrottlingCoordinator: new ParadisExactViewBackgroundThrottlingCoordinator(),
		_quarantinedBindings: new Set(),
		_terminalExitedTokens: new Set(),
		_paneShells: paneShells,
		_paneStatuses: new Map(),
		_activityApprovalTokens: new Set(),
		_agentHookTokens: new Set(),
		_seenTokens: new Set(),
		_rendererConnections: new Map([['window:1', connection]]),
		_rendererConnectionContexts: new Map([[connection, 'window:1']]),
		_knownRendererContexts: new Set(['window:1']),
		_mainLiveWindowIds: new Set(),
		_hasMainRendererManifest: false,
		_rendererManifestRevision: -1,
		_authorityFaulted: false,
		_nextBindingGeneration: 100,
		_devtoolsGenerationCoordinator: {
			setGeneration: (_token: string, nextGeneration: number) => effects.push(`generation:${nextGeneration}`),
			forgetWhenIdle: (token: string, nextGeneration: number) => effects.push(`forget:${token}:${nextGeneration}`),
		},
		_cdpGateway: {
			closeConnectionsForToken: (token: string) => effects.push(`close:${token}`),
			retireToken: (token: string) => effects.push(`retireGateway:${token}`),
		},
		_devtoolsProxy: {
			retire: (token: string, nextGeneration: number) => effects.push(`retire:${token}:${nextGeneration}`),
		},
		mainProcessService: {
			getChannel: () => ({
				call: (_command: string, args: readonly [string, boolean]) => {
					effects.push(`throttling:${args[0]}:${args[1]}`);
					return Promise.resolve();
				},
			}),
		},
		logService: { debug: () => undefined, warn: () => undefined },
	}) as unknown as ParadisAgentBrowserService;
	return { service, connection, bindings, paneShells, effects };
}

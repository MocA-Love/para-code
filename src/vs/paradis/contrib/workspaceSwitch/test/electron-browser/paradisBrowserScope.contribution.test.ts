/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewContextualFilter, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { paradisCreateBrowserViewInitialization } from '../../../../../workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';
import { PARADIS_BROWSER_SCOPE_STORAGE_KEY } from '../../common/paradisBrowserScopeState.js';
import { ParadisBrowserScopeService } from '../../electron-browser/paradisBrowserScope.contribution.js';

function fakeInput(id: string, onWillDispose: Event<void> = Event.None, dispose: (force?: boolean) => void = () => undefined): BrowserEditorInput {
	return {
		serialize: () => ({ id }),
		onBeforeDispose: Event.None,
		onWillDispose,
		dispose,
	} as unknown as BrowserEditorInput;
}

suite('ParadisBrowserScopeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('loads storage before subscribing and keeps an initial unknown view pending until the browser barrier', async () => {
		const order: string[] = [];
		const browserBarrier = new DeferredPromise<boolean>();
		const browserChanges = store.add(new Emitter<void>());
		const known = new Map([['view-a', fakeInput('view-a')]]);
		const browserService = {
			get whenInitialized() { return browserBarrier.p; },
			onDidChangeBrowserViews: (listener: () => void) => {
				order.push('hook');
				return browserChanges.event(listener);
			},
			getKnownBrowserViews: () => known,
			getContextualBrowserViews: () => known,
			registerContextualFilter: () => ({ dispose() { } }),
		} as unknown as IBrowserViewWorkbenchService;
		const workspaceChanges = store.add(new Emitter<void>());
		const switchService = {
			activeStateKey: 'space-a',
			isSwitching: false,
			onDidChangeRepositories: workspaceChanges.event,
			onDidRetireScope: Event.None,
			onWillSwitchScope: Event.None,
			onDidSwitchScope: Event.None,
		} as unknown as IParadisWorkspaceSwitchService;
		const storageService = {
			get: (key: string, scope: StorageScope) => {
				assert.strictEqual(key, PARADIS_BROWSER_SCOPE_STORAGE_KEY);
				assert.strictEqual(scope, StorageScope.WORKSPACE);
				order.push('load');
				return undefined;
			},
			store: () => undefined,
		} as never;
		const lifecycleService = {
			willShutdown: false,
			onWillShutdown: Event.None,
		} as unknown as ILifecycleService;

		const service = store.add(new ParadisBrowserScopeService(browserService, switchService, storageService, lifecycleService));
		assert.deepStrictEqual(order, ['load', 'hook']);
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'pending' });

		browserBarrier.complete(true);
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('re-evaluates a retained view recovered by a later snapshot before completing its scope barrier', async () => {
		const browserChanges = store.add(new Emitter<void>());
		const known = new Map<string, BrowserEditorInput>();
		let retryTimer: (() => void) | undefined;
		let attempts = 0;
		const initialization = paradisCreateBrowserViewInitialization<string>(
			() => toDisposable(() => undefined),
			() => ++attempts === 1 ? Promise.reject(new Error('Main temporarily unavailable')) : Promise.resolve(['retained']),
			viewId => {
				known.set(viewId, fakeInput(viewId));
				browserChanges.fire();
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
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: initialization.whenInitialized,
				onDidChangeBrowserViews: browserChanges.event,
				getKnownBrowserViews: () => known,
				getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-a', isSwitching: false, isManagedWorkspaceWindow: true,
				onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
				onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{ get: () => undefined, store: () => undefined } as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));

		await Promise.resolve();
		await Promise.resolve();
		assert.ok(retryTimer);
		const retry = retryTimer;
		retryTimer = undefined;
		retry();
		await service.initializationBarrier;

		assert.strictEqual(attempts, 2);
		assert.deepStrictEqual([...known.keys()], ['retained']);
		assert.deepStrictEqual(service.resolveScope('retained'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('retains a retire tombstone after snapshot failure and disposes a later matching view', async () => {
		const browserChanges = store.add(new Emitter<void>());
		const retiredScopes = store.add(new Emitter<string>());
		const known = new Map<string, BrowserEditorInput>();
		const disposed: (boolean | undefined)[] = [];
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(false), onDidChangeBrowserViews: browserChanges.event,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-b', isSwitching: false,
				onDidChangeRepositories: Event.None, onDidRetireScope: retiredScopes.event,
				onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'late-view', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		retiredScopes.fire('space-a');
		await service.initializationBarrier;

		known.set('late-view', fakeInput('late-view', Event.None, force => {
			disposed.push(force);
			known.delete('late-view');
		}));
		browserChanges.fire();
		assert.deepStrictEqual(disposed, [true]);
	});

	test('keeps a successful-snapshot tombstone while force dispose has not left the known ledger', async () => {
		const browserChanges = store.add(new Emitter<void>());
		const retiredScopes = store.add(new Emitter<string>());
		const disposed: (boolean | undefined)[] = [];
		const input = fakeInput('still-known', Event.None, force => disposed.push(force));
		const known = new Map([['still-known', input]]);
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: browserChanges.event,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-b', isSwitching: false, repositories: [],
				onDidChangeRepositories: Event.None, onDidRetireScope: retiredScopes.event,
				onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'still-known', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		retiredScopes.fire('space-a');
		await service.initializationBarrier;
		const disposeCountBeforeChange = disposed.length;
		browserChanges.fire();
		assert.strictEqual(disposed.length, disposeCountBeforeChange + 1);
		assert.ok(disposed.every(force => force === true));
	});

	test('tags a browser created after a failed initial snapshot instead of globally quarantining new views', async () => {
		const browserChanges = store.add(new Emitter<void>());
		const known = new Map<string, BrowserEditorInput>();
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(false), onDidChangeBrowserViews: browserChanges.event,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-a', isSwitching: false, repositories: [{ id: 'space-a' }],
				onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
				onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{ get: () => undefined, store: () => undefined } as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		known.set('new-view', fakeInput('new-view'));
		browserChanges.fire();
		assert.deepStrictEqual(service.resolveScope('new-view'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('returns pending during a switch without changing the restored stable assignment', async () => {
		let switching = false;
		const known = new Map([['view-a', fakeInput('view-a')]]);
		const switchService = {
			activeStateKey: 'space-a', get isSwitching() { return switching; }, repositories: [{ id: 'space-a' }],
			onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
			onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
		} as unknown as IParadisWorkspaceSwitchService;
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			switchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'view-a', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });
		switching = true;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'pending' });
		switching = false;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('keeps active-key-unknown managed windows pending but allows true normal workspaces to be unscoped', async () => {
		const create = async (managed: boolean) => {
			const known = new Map([['view-a', fakeInput('view-a')]]);
			const service = store.add(new ParadisBrowserScopeService(
				{
					whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
					getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
					registerContextualFilter: () => ({ dispose() { } }),
				} as unknown as IBrowserViewWorkbenchService,
				{
					activeStateKey: undefined, isSwitching: false,
					isManagedWorkspaceWindow: managed,
					// Repository registration is deliberately the inverse: it is not workspace identity.
					repositories: managed ? [] : [{ id: 'space-a' }],
					onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
					onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
				} as unknown as IParadisWorkspaceSwitchService,
				{ get: () => undefined, store: () => undefined } as never,
				{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
			));
			await service.initializationBarrier;
			return service.resolveScope('view-a');
		};
		assert.deepStrictEqual(await create(true), { kind: 'pending' });
		assert.deepStrictEqual(await create(false), { kind: 'unscoped' });
	});

	test('does not retag an inactive persisted view to the active space', async () => {
		const known = new Map([['inactive', fakeInput('inactive')]]);
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-b', isSwitching: false, repositories: [{ id: 'space-b' }],
				onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
				onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'inactive', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('inactive'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('reassigns an unscoped view when a same-URI correction establishes a managed active key', async () => {
		const switched = store.add(new Emitter<string>());
		const known = new Map([['view-a', fakeInput('view-a')]]);
		const switchService = {
			activeStateKey: undefined as string | undefined,
			isSwitching: false,
			repositories: [] as { id: string }[],
			onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
			onWillSwitchScope: Event.None, onDidSwitchScope: switched.event,
		} as unknown as IParadisWorkspaceSwitchService;
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			switchService,
			{ get: () => undefined, store: () => undefined } as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'unscoped' });

		(switchService as unknown as { activeStateKey: string | undefined }).activeStateKey = 'space-a';
		(switchService as unknown as { repositories: { id: string }[] }).repositories = [{ id: 'space-a' }];
		switched.fire('space-a');
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('resolves an absent-storage initial pending view when it later becomes contextual', async () => {
		const switched = store.add(new Emitter<string>());
		const known = new Map([['view-a', fakeInput('view-a')]]);
		const contextual = new Map<string, BrowserEditorInput>();
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => contextual,
				registerContextualFilter: () => ({ dispose() { } }),
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-a', isSwitching: false,
				onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
				onWillSwitchScope: Event.None, onDidSwitchScope: switched.event,
			} as unknown as IParadisWorkspaceSwitchService,
			{ get: () => undefined, store: () => undefined } as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'pending' });

		contextual.set('view-a', known.get('view-a')!);
		switched.fire('space-a');
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('keeps a corrupt initial snapshot pending even when the view is contextual', async () => {
		const browserChanges = store.add(new Emitter<void>());
		const known = new Map([['view-a', fakeInput('view-a')]]);
		const browserService = {
			whenInitialized: Promise.resolve(true),
			onDidChangeBrowserViews: browserChanges.event,
			getKnownBrowserViews: () => known,
			getContextualBrowserViews: () => known,
			registerContextualFilter: () => ({ dispose() { } }),
		} as unknown as IBrowserViewWorkbenchService;
		const switchService = {
			activeStateKey: 'space-a', isSwitching: false,
			onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
			onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
		} as unknown as IParadisWorkspaceSwitchService;
		const service = store.add(new ParadisBrowserScopeService(
			browserService,
			switchService,
			{ get: () => '{', store: () => undefined } as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'pending' });
		browserChanges.fire();
		assert.deepStrictEqual(service.resolveScope('view-a'), { kind: 'pending' });
	});

	test('invalidates the contextual filter immediately and excludes existing views during a switch', async () => {
		let switching = false;
		let contextualFilter: IBrowserViewContextualFilter | undefined;
		const willSwitch = store.add(new Emitter<string | undefined>());
		const input = fakeInput('view-a');
		const known = new Map([['view-a', input]]);
		const service = store.add(new ParadisBrowserScopeService(
			{
				whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
				getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
				registerContextualFilter: (filter: IBrowserViewContextualFilter) => {
					contextualFilter = filter;
					return { dispose() { } };
				},
			} as unknown as IBrowserViewWorkbenchService,
			{
				activeStateKey: 'space-a', get isSwitching() { return switching; },
				isManagedWorkspaceWindow: true,
				onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
				onWillSwitchScope: willSwitch.event, onDidSwitchScope: Event.None,
			} as unknown as IParadisWorkspaceSwitchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'view-a', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));
		await service.initializationBarrier;
		assert.ok(contextualFilter);
		assert.strictEqual(contextualFilter.include(input, {} as never), true);

		let filterChanges = 0;
		store.add(contextualFilter.onDidChange!(() => filterChanges++));
		switching = true;
		willSwitch.fire('space-a');
		assert.strictEqual(filterChanges, 1);
		assert.strictEqual(contextualFilter.include(input, {} as never), false);
	});

	test('uses a retire tombstone to force-dispose a view arriving before the barrier', async () => {
		const browserBarrier = new DeferredPromise<boolean>();
		const browserChanges = store.add(new Emitter<void>());
		const retiredScopes = store.add(new Emitter<string>());
		const known = new Map<string, BrowserEditorInput>();
		const disposed: (boolean | undefined)[] = [];
		const browserService = {
			whenInitialized: browserBarrier.p,
			onDidChangeBrowserViews: browserChanges.event,
			getKnownBrowserViews: () => known,
			getContextualBrowserViews: () => known,
			registerContextualFilter: () => ({ dispose() { } }),
		} as unknown as IBrowserViewWorkbenchService;
		const switchService = {
			activeStateKey: 'space-b', isSwitching: false,
			onDidChangeRepositories: Event.None, onDidRetireScope: retiredScopes.event,
			onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
		} as unknown as IParadisWorkspaceSwitchService;
		const service = store.add(new ParadisBrowserScopeService(
			browserService,
			switchService,
			{
				get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'late-view', stateKey: 'space-a' }] }),
				store: () => undefined,
			} as never,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
		));

		retiredScopes.fire('space-a');
		known.set('late-view', fakeInput('late-view', Event.None, force => {
			disposed.push(force);
			known.delete('late-view');
		}));
		browserChanges.fire();
		assert.deepStrictEqual(disposed, [true]);
		browserBarrier.complete(true);
		await service.initializationBarrier;
		assert.deepStrictEqual(service.resolveScope('late-view'), { kind: 'pending' });
	});

	test('deletes a mapping on user close but preserves it when lifecycle willShutdown is already true', async () => {
		const run = async (willShutdown: boolean): Promise<string[]> => {
			const inputWillDispose = store.add(new Emitter<void>());
			const known = new Map([['view-a', fakeInput('view-a', inputWillDispose.event)]]);
			const stored: string[] = [];
			const service = store.add(new ParadisBrowserScopeService(
				{
					whenInitialized: Promise.resolve(true), onDidChangeBrowserViews: Event.None,
					getKnownBrowserViews: () => known, getContextualBrowserViews: () => known,
					registerContextualFilter: () => ({ dispose() { } }),
				} as unknown as IBrowserViewWorkbenchService,
				{
					activeStateKey: 'space-a', isSwitching: false,
					onDidChangeRepositories: Event.None, onDidRetireScope: Event.None,
					onWillSwitchScope: Event.None, onDidSwitchScope: Event.None,
				} as unknown as IParadisWorkspaceSwitchService,
				{
					get: () => JSON.stringify({ version: 1, entries: [{ viewId: 'view-a', stateKey: 'space-a' }] }),
					store: (_key: string, value: string) => stored.push(value),
				} as never,
				{ willShutdown, onWillShutdown: Event.None } as unknown as ILifecycleService,
			));
			await service.initializationBarrier;
			inputWillDispose.fire();
			return stored;
		};

		const userCloseWrites = await run(false);
		assert.strictEqual(userCloseWrites.length, 1);
		assert.deepStrictEqual(JSON.parse(userCloseWrites[0]), { version: 1, entries: [] });
		assert.deepStrictEqual(await run(true), []);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IEditorIdentifier } from '../../../../../workbench/common/editor.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IParadisBrowserScopeService, ParadisBindingScopeEligibilityError } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisPaneBinding } from '../../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisBrowserShareStateFeature } from '../../electron-browser/paradisBrowserShareState.js';
import { paradisShareButtonCount, paradisShareButtonEntries } from '../../electron-browser/paradisBrowserShareCount.js';
import { IParadisDialogPageCandidate, paradisGetBindingErrorMessage, paradisGetPaneBindingAction, paradisGetPaneQuickPickState, paradisResolveDialogPage, paradisResolveToolbarPage, paradisRunDialogBind } from '../../electron-browser/paradisDialogPageResolver.js';
import { resolveDialogPageModel, resolveToolbarPageModel } from '../../electron-browser/paradisDialogPageModelResolver.js';

/** A candidate whose page model is `page`; `'lazy'` when the tab was never shown and the model is created on resolve. */
function candidate(id: string, page: { id: string } | 'lazy' = { id }): IParadisDialogPageCandidate<{ id: string }> {
	return { id, page: page === 'lazy' ? undefined : page, resolve: async () => page === 'lazy' ? { id } : page };
}

suite('paradisResolveDialogPage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns an exact existing binding first, without waiting for initialization', async () => {
		const barrier = new DeferredPromise<void>();
		const exact = { id: 'exact' };
		const resolved = await paradisResolveDialogPage({
			exactPageId: 'exact',
			getKnownCandidate: id => id === 'exact' ? candidate('exact', exact) : undefined,
			initializationBarrier: barrier.p,
			getVisibleCandidates: () => [candidate('visible')],
			getContextualCandidates: () => [candidate('contextual')],
			getStability: () => 'stable',
		});
		assert.strictEqual(resolved.page, exact);
	});

	test('waits for initialization before choosing a page on screen', async () => {
		const barrier = new DeferredPromise<void>();
		const visible = { id: 'visible' };
		let settled = false;
		const result = paradisResolveDialogPage({
			getKnownCandidate: () => undefined,
			initializationBarrier: barrier.p,
			getVisibleCandidates: () => [candidate('visible', visible)],
			getContextualCandidates: () => [candidate('contextual')],
			getStability: () => 'stable',
		}).then(value => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		assert.strictEqual(settled, false);
		barrier.complete();
		assert.strictEqual((await result).page, visible);
	});

	test('rechecks exact binding after the barrier before the contextual fallback', async () => {
		const barrier = new DeferredPromise<void>();
		const exact = { id: 'exact' };
		let available = false;
		const result = paradisResolveDialogPage({
			exactPageId: 'exact',
			getKnownCandidate: () => available ? candidate('exact', exact) : undefined,
			initializationBarrier: barrier.p,
			getVisibleCandidates: () => [],
			getContextualCandidates: () => [candidate('contextual')],
			getStability: () => 'stable',
		});
		available = true;
		barrier.complete();
		assert.strictEqual((await result).page, exact);
	});

	test('passes over an exact binding that is still being placed', async () => {
		const result = await paradisResolveDialogPage({
			exactPageId: 'exact',
			getKnownCandidate: id => id === 'exact' ? candidate('exact', 'lazy') : undefined,
			initializationBarrier: Promise.resolve(),
			getVisibleCandidates: () => [candidate('visible')],
			getContextualCandidates: () => [],
			getStability: id => id === 'exact' ? 'pending' : 'stable',
		});
		assert.deepStrictEqual(result.page, { id: 'visible' });
	});

	test('does not choose a page whose space changed while its model was created', async () => {
		let switching = false;
		const result = await paradisResolveDialogPage({
			getKnownCandidate: () => undefined,
			initializationBarrier: Promise.resolve(),
			getVisibleCandidates: () => [{ id: 'lazy', page: undefined, resolve: async () => { switching = true; return { id: 'lazy' }; } }],
			getContextualCandidates: () => [],
			getStability: () => switching ? 'pending' : 'stable',
		});
		assert.deepStrictEqual(result, { miss: { exact: 'none', visible: 'pending', contextual: 'none' } });
	});

	test('the toolbar uses the browser editor it belongs to, not the active one', async () => {
		const clicked = { id: 'clicked' };
		assert.deepStrictEqual([
			(await paradisResolveToolbarPage(candidate('clicked', clicked), candidate('active'))).page,
			(await paradisResolveToolbarPage(candidate('clicked', 'lazy'), candidate('active'))).page,
			(await paradisResolveToolbarPage(undefined, candidate('active'))).page,
		], [clicked, { id: 'clicked' }, { id: 'active' }]);
	});

	suite('resolveDialogPageModel', () => {
		const disposables = new DisposableStore();
		let instantiationService: ReturnType<typeof workbenchInstantiationService>;
		setup(() => instantiationService = workbenchInstantiationService(undefined, disposables));
		teardown(() => disposables.clear());

		interface ITab {
			readonly id: string;
			/** Shown at least once in this window, so its page model exists. */
			readonly shown?: boolean;
			readonly visible?: boolean;
			/** In an auxiliary window rather than the window the dialog is opened from. */
			readonly auxiliary?: boolean;
		}

		interface IWorld {
			/** Creation order (the order of `getKnownBrowserViews()`). */
			readonly tabs: readonly ITab[];
			/** Most recently active first. */
			readonly recency: readonly string[];
			/** The active editor is a browser tab; otherwise it is something else (an editor terminal). */
			readonly active?: string;
			readonly pending?: readonly string[];
			/** Tagged to another space. */
			readonly elsewhere?: readonly string[];
			/** The page the clicked pane is already bound to. */
			readonly bound?: string;
		}

		async function resolveIn(world: IWorld): Promise<string | undefined | { readonly miss: object }> {
			const known = new Map<string, BrowserEditorInput>();
			for (const tab of world.tabs) {
				const input = disposables.add(instantiationService.createInstance(BrowserEditorInput, { id: tab.id }, async () => upcastPartial<IBrowserViewModel>({ id: tab.id, dispose: () => { } })));
				if (tab.shown) {
					await input.resolve();
				}
				known.set(tab.id, input);
			}
			const pending = new Set(world.pending);
			const elsewhere = new Set(world.elsewhere);
			const contextual = new Map([...known].filter(([id]) => !pending.has(id) && !elsewhere.has(id)));
			const services = new Map<unknown, unknown>([
				[IBrowserViewWorkbenchService, { getKnownBrowserViews: () => known, getContextualBrowserViews: () => contextual }],
				[IParadisBrowserScopeService, { initializationBarrier: Promise.resolve(), resolveScope: (id: string) => ({ kind: pending.has(id) ? 'pending' : 'unscoped' }) }],
				[IEditorService, {
					activeEditor: world.active !== undefined ? known.get(world.active) : undefined,
					visibleEditors: world.tabs.filter(tab => tab.visible).map(tab => known.get(tab.id)),
					// グループの id は、補助ウィンドウのタブなら 2、それ以外は 1。
					getEditors: () => world.recency.map(id => upcastPartial<IEditorIdentifier>({ editor: known.get(id), groupId: world.tabs.find(tab => tab.id === id)?.auxiliary ? 2 : 1 })),
				}],
				[IEditorGroupsService, { getGroup: (groupId: number) => ({ windowId: groupId === 2 ? mainWindow.vscodeWindowId + 1 : mainWindow.vscodeWindowId }) }],
				[IParadisPaneTokenService, { getTokenForInstance: () => 'pane' }],
				[IParadisAgentBrowserBindingModel, { getBindingForToken: () => world.bound !== undefined ? { pageId: world.bound } : undefined }],
			]);
			const accessor: ServicesAccessor = { get: service => services.get(service) as never };
			const result = await resolveDialogPageModel(accessor, 1);
			return result.page ? result.page.id : { miss: result.miss };
		}

		const three: readonly ITab[] = [{ id: 'A', shown: true }, { id: 'B', shown: true }, { id: 'C', shown: true, visible: true }];

		test('chooses the page the user is looking at, not the first page created', async () => {
			assert.deepStrictEqual([
				// The pane mark of an editor terminal: the active editor is the terminal.
				await resolveIn({ tabs: three, recency: ['C', 'B', 'A'] }),
				// Bound to A: the mark says "shares A, click to manage", so A opens even while the user looks at C.
				await resolveIn({ tabs: three, recency: ['C', 'B', 'A'], bound: 'A' }),
				// A more recent tab on screen in another window loses to the one in the window the mark is in.
				await resolveIn({ tabs: [{ id: 'A', shown: true, visible: true, auxiliary: true }, { id: 'C', shown: true, visible: true }], recency: ['A', 'C'] }),
			], ['C', 'A', 'C']);
		});

		test('falls back to the most recently active page and creates its model when it was never shown', async () => {
			assert.deepStrictEqual([
				await resolveIn({ tabs: [{ id: 'A' }, { id: 'B', shown: true }, { id: 'C' }], recency: ['A', 'C', 'B'] }),
				await resolveIn({ tabs: [{ id: 'B' }, { id: 'C' }], recency: ['C', 'B'] }),
			], ['A', 'C']);
		});

		test('skips a page that is being placed or belongs to another space', async () => {
			assert.deepStrictEqual([
				await resolveIn({ tabs: three.map(tab => ({ ...tab, visible: true })), recency: ['A', 'B', 'C'], active: 'A', pending: ['A'] }),
				await resolveIn({ tabs: three.map(tab => ({ ...tab, visible: true })), recency: ['A', 'B', 'C'], active: 'A', elsewhere: ['A'] }),
			], ['B', 'B']);
		});

		test('captures services synchronously before waiting for browser initialization', async () => {
			const barrier = new DeferredPromise<void>();
			let accessorValid = true;
			const services = new Map<unknown, unknown>([
				[IEditorService, { activeEditor: undefined, visibleEditors: [], getEditors: () => [] }],
				[IEditorGroupsService, { getGroup: () => undefined }],
				[IBrowserViewWorkbenchService, { getKnownBrowserViews: () => new Map(), getContextualBrowserViews: () => new Map() }],
				[IParadisBrowserScopeService, { initializationBarrier: barrier.p, resolveScope: () => ({ kind: 'unscoped' }) }],
			]);
			const accessor: ServicesAccessor = {
				get: service => {
					if (!accessorValid) {
						throw new Error('service accessor expired');
					}
					if (!services.has(service)) {
						throw new Error(`Unexpected service: ${service.toString()}`);
					}
					return services.get(service) as never;
				}
			};

			const result = resolveDialogPageModel(accessor);
			accessorValid = false;
			barrier.complete();
			assert.deepStrictEqual(await result, { miss: { exact: 'none', visible: 'none', contextual: 'none' } });
		});

		test('reports which stage came up empty', async () => {
			assert.deepStrictEqual([
				await resolveIn({ tabs: three, recency: ['C', 'B', 'A'], active: 'C', pending: ['A', 'B', 'C'] }),
				await resolveIn({ tabs: [], recency: [], bound: 'gone' }),
			], [
				{ miss: { exact: 'none', visible: 'pending', contextual: 'pending' } },
				{ miss: { exact: 'missing', visible: 'none', contextual: 'none' } },
			]);
		});

		test('the toolbar share button uses the browser editor it is part of', async () => {
			const known = new Map<string, BrowserEditorInput>();
			for (const id of ['A', 'B']) {
				const input = disposables.add(instantiationService.createInstance(BrowserEditorInput, { id }, async () => upcastPartial<IBrowserViewModel>({ id, dispose: () => { } })));
				await input.resolve();
				known.set(id, input);
			}
			// The toolbar of B passes B's editor while A, touched before, is still the active editor.
			const clickedEditor: BrowserEditor = Object.create(BrowserEditor.prototype);
			Object.defineProperty(clickedEditor, 'input', { value: known.get('B') });
			const accessor: ServicesAccessor = { get: service => (service === IEditorService ? { activeEditor: known.get('A') } : undefined) as never };
			assert.deepStrictEqual([
				(await resolveToolbarPageModel(accessor, clickedEditor)).page?.id,
				// A keybinding passes no editor.
				(await resolveToolbarPageModel(accessor, undefined)).page?.id,
			], ['B', 'A']);
		});
	});

	test('shows whether the page of each browser editor is shared, not the active one', () => {
		const store = new DisposableStore();
		const onDidChangeModel = store.add(new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean }>());
		const onDidChangeBindings = store.add(new Emitter<void>());
		const sharedPages = new Set<string>(['A']);
		const contextKeyService = new MockContextKeyService();
		store.add(new ParadisBrowserShareStateFeature(
			upcastPartial<BrowserEditor>({ onDidChangeModel: onDidChangeModel.event }),
			contextKeyService,
			upcastPartial<IParadisAgentBrowserBindingModel>({
				onDidChange: onDidChangeBindings.event,
				getPageShares: (pageId: string) => sharedPages.has(pageId) ? [{ token: 'pane', kind: 'user' as const }] : [],
			}),
			upcastPartial<IParadisAgentBrowserTabsService>({}),
		));
		const shared = () => contextKeyService.getContextKeyValue('paradisActivePageShared');
		const states: unknown[] = [];
		onDidChangeModel.fire({ model: upcastPartial<IBrowserViewModel>({ id: 'B', onDidChangeSharingState: Event.None }), isNew: true });
		states.push(shared());
		sharedPages.add('B');
		onDidChangeBindings.fire();
		states.push(shared());
		onDidChangeModel.fire({ model: undefined, isNew: false });
		states.push(shared());
		assert.deepStrictEqual(states, [false, true, false]);
		store.dispose();
	});

	// 共有中かどうかはボタンに出す数と同じ数え方: Copilot だけと共有したページも共有中で、共有の印の変化にも追いつく
	test('counts a page shared only with Copilot as shared, and follows changes of the share mark', () => {
		const store = new DisposableStore();
		const onDidChangeModel = store.add(new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean }>());
		const onDidChangeSharingState = store.add(new Emitter<BrowserViewSharingState>());
		const contextKeyService = new MockContextKeyService();
		const model = { id: 'A', sharingState: BrowserViewSharingState.Available, onDidChangeSharingState: onDidChangeSharingState.event };
		store.add(new ParadisBrowserShareStateFeature(
			upcastPartial<BrowserEditor>({ onDidChangeModel: onDidChangeModel.event }),
			contextKeyService,
			upcastPartial<IParadisAgentBrowserBindingModel>({
				onDidChange: Event.None,
				refresh: async () => { },
				getPageShares: () => [],
				getBindingsForPage: () => [],
			}),
			upcastPartial<IParadisAgentBrowserTabsService>({}),
		));
		const shared = () => contextKeyService.getContextKeyValue('paradisActivePageShared');
		const states: unknown[] = [];
		onDidChangeModel.fire({ model: upcastPartial<IBrowserViewModel>(model), isNew: true });
		states.push(shared());
		model.sharingState = BrowserViewSharingState.Shared;
		onDidChangeSharingState.fire(BrowserViewSharingState.Shared);
		states.push(shared());
		model.sharingState = BrowserViewSharingState.Available;
		onDidChangeSharingState.fire(BrowserViewSharingState.Available);
		states.push(shared());
		assert.deepStrictEqual(states, [false, true, false]);
		store.dispose();
	});

	// 共有中のページから共有の印だけが外れたら付け直す。Copilot のチャットが使えないだけ（Unavailable）のときは何もしない
	test('restores the share mark of a shared page when only the mark was removed, but not while sharing is unavailable', async () => {
		const store = new DisposableStore();
		const onDidChangeModel = store.add(new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean }>());
		const onDidChangeSharingState = store.add(new Emitter<BrowserViewSharingState>());
		const model = { id: 'A', sharingState: BrowserViewSharingState.Shared, onDidChangeSharingState: onDidChangeSharingState.event };
		let bound = true;
		const restored: string[] = [];
		store.add(new ParadisBrowserShareStateFeature(
			upcastPartial<BrowserEditor>({ onDidChangeModel: onDidChangeModel.event }),
			new MockContextKeyService(),
			upcastPartial<IParadisAgentBrowserBindingModel>({
				onDidChange: Event.None,
				refresh: async () => { },
				getPageShares: () => [],
				getBindingsForPage: () => bound ? [upcastPartial<IParadisPaneBinding>({ pageId: 'A' })] : [],
			}),
			upcastPartial<IParadisAgentBrowserTabsService>({ restoreShareMark: async (target: IBrowserViewModel) => { restored.push(target.id); } }),
		));
		onDidChangeModel.fire({ model: upcastPartial<IBrowserViewModel>(model), isNew: true });
		for (const [state, isBound] of [[BrowserViewSharingState.Unavailable, true], [BrowserViewSharingState.Available, true], [BrowserViewSharingState.Available, false]] as const) {
			bound = isBound;
			model.sharingState = state;
			onDidChangeSharingState.fire(state);
			await timeout(0);
		}
		assert.deepStrictEqual(restored, ['A']);
		store.dispose();
	});

	// ボタンの数: 台帳のペイン。台帳に無いのに共有の印があれば Copilot だけと共有（1 件）。印が付かない状態では数えない
	test('counts the panes of the ledger, and a page shared only with Copilot as one entry', () => {
		const pane = { token: 'pane', kind: 'user' as const };
		const cases = [
			paradisShareButtonEntries([pane], BrowserViewSharingState.Shared),
			paradisShareButtonEntries([], BrowserViewSharingState.Shared),
			paradisShareButtonEntries([], BrowserViewSharingState.Available),
			paradisShareButtonEntries([], BrowserViewSharingState.Unavailable),
		];
		assert.deepStrictEqual(cases.map(entries => ({ copilot: entries.copilot, count: paradisShareButtonCount(entries) })), [
			{ copilot: false, count: 1 },
			{ copilot: true, count: 1 },
			{ copilot: false, count: 0 },
			{ copilot: false, count: 0 },
		]);
	});

	test('catches dialog bind failures and reports them without rejecting', async () => {
		let error: unknown;
		assert.strictEqual(await paradisRunDialogBind(
			() => Promise.reject(new Error('bind failed')),
			value => error = value,
		), false);
		assert.ok(error instanceof Error);
	});

	test('maps typed scope errors to localized QuickPick and Dialog text without exposing internal retry strings', () => {
		const quickPickMessages = {
			pending: 'quick: syncing',
			differentScope: 'quick: different space',
			generic: (detail: string) => `quick: failed: ${detail}`,
		};
		const dialogMessages = {
			pending: 'dialog: syncing',
			differentScope: 'dialog: different space',
			generic: (detail: string) => `dialog: failed: ${detail}`,
		};
		for (const reason of ['pending', 'differentScope'] as const) {
			const error = new ParadisBindingScopeEligibilityError(reason);
			const quickPick = paradisGetBindingErrorMessage(error, quickPickMessages);
			const dialog = paradisGetBindingErrorMessage(error, dialogMessages);
			assert.strictEqual(quickPick, quickPickMessages[reason]);
			assert.strictEqual(dialog, dialogMessages[reason]);
			assert.ok(!quickPick.includes('PARA_BROWSER_RETRYABLE'));
			assert.ok(!dialog.includes('PARA_BROWSER_RETRYABLE'));
		}
		assert.strictEqual(
			paradisGetBindingErrorMessage(new Error('ipc offline'), quickPickMessages),
			'quick: failed: ipc offline',
		);
	});

	test('keeps existing ineligible bindings unbindable while blocking new/rebind actions', () => {
		assert.strictEqual(paradisGetPaneBindingAction('other-page', 'current-page', { eligible: false, reason: 'differentScope' }), 'unbind');
		assert.strictEqual(paradisGetPaneBindingAction(undefined, 'current-page', { eligible: false, reason: 'pending' }), 'disabled');
		assert.strictEqual(paradisGetPaneBindingAction(undefined, 'current-page', { eligible: true }), 'bind');
		assert.strictEqual(paradisGetPaneBindingAction('current-page', 'current-page', { eligible: false, reason: 'pending' }), 'unbind');
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: false, reason: 'pending' }), { pickable: false, disabled: true });
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: false, reason: 'differentScope' }), { pickable: false, disabled: true });
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: true }), { pickable: true, disabled: false });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewEditorOpenOptions, IBrowserViewOwner } from '../../../../../platform/browserView/common/browserView.js';
import { BrowserViewSharingState, IBrowserViewOpenHandler, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisAuxiliaryWindowScopeService, IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { ParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';

const TOKEN = 'pane-token';
/** ペインのスペース（ユーザーは別のスペース space-a を見ている）。 */
const PANE_SPACE = 'space-b';

interface IFakeTab {
	readonly input: BrowserEditorInput;
	readonly disposals: (boolean | undefined)[];
	readonly layouts: { width: number; height: number }[];
}

function createHarness(store: DisposableStore, options: { readonly layoutGate?: Promise<void>; readonly failOpen?: boolean } = {}) {
	const switchState = { activeStateKey: 'space-a', isSwitching: false };
	const onDidSwitchScope = store.add(new Emitter<string>());
	const onWillShutdown = store.add(new Emitter<void>());
	const known = new Map<string, BrowserEditorInput>();
	const tabs: IFakeTab[] = [];
	const assigned: [string, string][] = [];
	const opened: { id: string; inactive: boolean | undefined; preserveFocus: boolean | undefined; group: number }[] = [];
	const handlers: IBrowserViewOpenHandler[] = [];
	const group = { id: 1, editors: [] as BrowserEditorInput[], contains: (editor: BrowserEditorInput) => group.editors.includes(editor), isEmpty: true };
	const part = {
		getSize: () => ({ width: 1600, height: 900 }),
		findGroup: () => undefined,
		activeGroup: group,
		contentDimension: { width: 1600, height: 900 },
	};

	const createTab = (id: string): IFakeTab => {
		const onWillDispose = store.add(new Emitter<void>());
		const disposals: (boolean | undefined)[] = [];
		const layouts: { width: number; height: number }[] = [];
		let disposed = false;
		const model = {
			id,
			url: 'about:blank',
			title: '',
			sharingState: BrowserViewSharingState.Shared,
			isDirectlyShareable: true,
			onDidChangeSharingState: Event.None,
			layout: async (bounds: { width: number; height: number }) => {
				layouts.push({ width: bounds.width, height: bounds.height });
				await options.layoutGate;
			},
		};
		const input = {
			id,
			url: 'about:blank',
			title: '',
			getName: () => id,
			resolve: async () => model,
			onDidResolveModel: Event.None,
			onWillDispose: onWillDispose.event,
			isDisposed: () => disposed,
			dispose: (force?: boolean) => {
				disposals.push(force);
				if (!disposed) {
					disposed = true;
					known.delete(id);
					onWillDispose.fire();
				}
			},
		} as unknown as BrowserEditorInput;
		known.set(id, input);
		const tab = { input, disposals, layouts };
		tabs.push(tab);
		return tab;
	};

	const service = store.add(new ParadisAgentBrowserTabsService(
		{
			createBrowserView: async () => createTab(`view-${tabs.length + 1}`).input,
			getKnownBrowserViews: () => known,
			registerOpenHandler: (handler: IBrowserViewOpenHandler) => {
				handlers.push(handler);
				return { dispose: () => handlers.splice(handlers.indexOf(handler), 1) };
			},
		} as unknown as IBrowserViewWorkbenchService,
		{
			openEditor: async (input: BrowserEditorInput, editorOptions: { inactive?: boolean; preserveFocus?: boolean }, target: typeof group) => {
				if (options.failOpen) {
					throw new Error('cannot open');
				}
				opened.push({ id: input.id, inactive: editorOptions.inactive, preserveFocus: editorOptions.preserveFocus, group: target.id });
				target.editors.push(input);
				target.isEmpty = false;
				return undefined;
			},
		} as unknown as IEditorService,
		{
			getGroups: () => [group],
			getPart: () => part,
			get groups() { return [group]; },
			mainPart: part,
		} as unknown as IEditorGroupsService,
		{
			onDidChange: Event.None,
			getBindingsForToken: () => [],
			getAgentTabsForToken: () => [],
			grantAgentTab: async () => true,
			revokeAgentTab: async () => undefined,
		} as unknown as IParadisAgentBrowserBindingModel,
		{ getInstanceForToken: () => 7 } as unknown as IParadisPaneTokenService,
		{ getStateKeyForInstance: () => PANE_SPACE } as unknown as IParadisTerminalScopeService,
		{
			resolveScope: () => ({ kind: 'managed', stateKey: PANE_SPACE }),
			assignNewViewToScope: (viewId: string, stateKey: string) => {
				assigned.push([viewId, stateKey]);
				return true;
			},
		} as unknown as IParadisBrowserScopeService,
		{
			get activeStateKey() { return switchState.activeStateKey; },
			get isSwitching() { return switchState.isSwitching; },
			repositories: [{ id: 'space-a', name: 'a' }, { id: PANE_SPACE, name: 'b' }],
			onDidSwitchScope: onDidSwitchScope.event,
		} as unknown as IParadisWorkspaceSwitchService,
		{ getWorktrees: () => [] } as unknown as IParadisWorktreeService,
		{ getPinnedParts: () => [] } as unknown as IParadisAuxiliaryWindowScopeService,
		{} as IDialogService,
		{} as IQuickInputService,
		new NullLogService(),
		{ getChannel: () => ({ call: async () => undefined, listen: () => Event.None }) } as unknown as IMainProcessService,
		{ onDidFocusMainOrAuxiliaryWindow: Event.None, onDidBlurMainOrAuxiliaryWindow: Event.None } as unknown as INativeHostService,
		{ getValue: () => undefined } as unknown as IConfigurationService,
		{ onWillShutdown: onWillShutdown.event } as unknown as ILifecycleService,
		{ getContainer: () => undefined } as unknown as IWorkbenchLayoutService,
	));

	/** ユーザーがペインのスペースへ戻る（切り替えの完了を通知し、置く処理が走るのを待つ）。 */
	const switchBack = async () => {
		switchState.activeStateKey = PANE_SPACE;
		onDidSwitchScope.fire(PANE_SPACE);
		await timeout(5);
	};
	const openChild = (parentId: string) => {
		const base = `child-of-${parentId}`;
		const child = createTab(known.has(base) || tabs.some(tab => tab.input.id === base) ? `${base}-${tabs.length}` : base);
		const editorOptions: IBrowserViewEditorOpenOptions = { pinned: true, parentViewId: parentId, auxiliaryWindow: { x: 0, y: 0, width: 400, height: 300 } };
		const allowed = handlers.every(handler => handler.shouldOpenEditor(child.input, { type: 'user' } as IBrowserViewOwner, editorOptions));
		return { child, allowed };
	};
	return { service, switchState, tabs, assigned, opened, handlers, onWillShutdown, switchBack, openChild };
}

suite('ParadisAgentBrowserTabsService tabs for a space that is not on screen', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the tab hidden in the pane\'s space and places it beside the terminal when the user switches back', async () => {
		const harness = createHarness(store.add(new DisposableStore()));
		const result = await harness.service.openTab(TOKEN, undefined, false);
		const beforeReturn = [...harness.opened];
		await harness.switchBack();
		assert.deepStrictEqual({
			result: result.ok ? { bound: result.bound, spaceNotVisible: result.spaceNotVisible, tabId: result.tab.tabId } : result,
			assigned: harness.assigned,
			layouts: harness.tabs[0].layouts,
			beforeReturn,
			afterReturn: harness.opened,
		}, {
			result: { bound: true, spaceNotVisible: true, tabId: 'view-1' },
			assigned: [['view-1', PANE_SPACE]],
			// 分割できる幅なので、エディタ領域の半分で見積もる
			layouts: [{ width: 800, height: 900 }],
			beforeReturn: [],
			afterReturn: [{ id: 'view-1', inactive: false, preserveFocus: true, group: 1 }],
		});
	});

	test('places the tab right away when the user switched back while the hidden layout was still running', async () => {
		const gate = new DeferredPromise<void>();
		const harness = createHarness(store.add(new DisposableStore()), { layoutGate: gate.p });
		const opening = harness.service.openTab(TOKEN, undefined, false);
		await timeout(0);
		// 戻ったのは待たせる途中（layout の最中）。完了の通知はここでは聞けないので、通知なしで戻った状態にする
		harness.switchState.activeStateKey = PANE_SPACE;
		gate.complete();
		await opening;
		await timeout(5);
		assert.deepStrictEqual(harness.opened.map(entry => entry.id), ['view-1']);
	});

	test('closes a tab it could not place instead of leaving it nowhere', async () => {
		const harness = createHarness(store.add(new DisposableStore()), { failOpen: true });
		await harness.service.openTab(TOKEN, undefined, false);
		await harness.switchBack();
		harness.onWillShutdown.fire();
		assert.deepStrictEqual({ disposals: harness.tabs[0].disposals, listed: harness.service.listTabs(TOKEN) }, {
			disposals: [true],
			listed: { ok: true, tabs: [], openedCount: 0 },
		});
	});

	test('close_browser_tab closes a waiting tab, and shutting down closes the tabs still waiting', async () => {
		const harness = createHarness(store.add(new DisposableStore()));
		await harness.service.openTab(TOKEN, undefined, false);
		await harness.service.openTab(TOKEN, undefined, false);
		const closed = await harness.service.closeTab(TOKEN, 'view-1');
		harness.onWillShutdown.fire();
		await harness.switchBack();
		assert.deepStrictEqual({
			closed,
			disposals: harness.tabs.map(tab => tab.disposals),
			opened: harness.opened,
			handlers: harness.handlers.length,
		}, {
			closed: { ok: true, openedCount: 1 },
			disposals: [[true], [true]],
			opened: [],
			// 待っているタブが無くなったら見張りを外す
			handlers: 0,
		});
	});

	test('keeps a page opened from a waiting tab in the same space, without an editor or auxiliary window, and places it with its parent', async () => {
		const harness = createHarness(store.add(new DisposableStore()));
		await harness.service.openTab(TOKEN, undefined, false);
		const { allowed } = harness.openChild('view-1');
		const unrelated = harness.openChild('someone-else');
		await timeout(0);
		const beforeReturn = [...harness.opened];
		await harness.switchBack();
		assert.deepStrictEqual({
			allowed,
			unrelatedAllowed: unrelated.allowed,
			assigned: harness.assigned,
			childLayouts: harness.tabs[1].layouts.length,
			beforeReturn,
			afterReturn: harness.opened,
		}, {
			allowed: false,
			unrelatedAllowed: true,
			assigned: [['view-1', PANE_SPACE], ['child-of-view-1', PANE_SPACE]],
			childLayouts: 1,
			beforeReturn: [],
			afterReturn: [
				{ id: 'view-1', inactive: false, preserveFocus: true, group: 1 },
				{ id: 'child-of-view-1', inactive: true, preserveFocus: true, group: 1 },
			],
		});
	});

	test('closes pages beyond the limit that a waiting tab opens, and tells the agent in the next tab list', async () => {
		const harness = createHarness(store.add(new DisposableStore()));
		await harness.service.openTab(TOKEN, undefined, false);
		const children = [];
		for (let index = 0; index < 7; index++) {
			// 子が開いた孫も、同じ元のタブの分として数える
			children.push(harness.openChild(index === 0 || index % 2 === 1 ? 'view-1' : 'child-of-view-1'));
		}
		const listed = harness.service.listTabs(TOKEN);
		const listedAgain = harness.service.listTabs(TOKEN);
		assert.deepStrictEqual({
			allowed: children.map(entry => entry.allowed),
			closed: children.map(entry => entry.child.disposals.length > 0),
			closedWaitingPages: listed.ok ? listed.closedWaitingPages : undefined,
			again: listedAgain.ok ? listedAgain.closedWaitingPages : undefined,
		}, {
			allowed: [false, false, false, false, false, false, false],
			closed: [false, false, false, false, false, true, true],
			closedWaitingPages: 2,
			again: undefined,
		});
	});
});

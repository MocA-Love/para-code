/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { BrowserWindow, WebContentsView } from 'electron';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSetExtensionPageHold } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisExtensionApiCaller, IParadisExtensionApiNamespace, ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { IParadisSidePanelExtension, ParadisBrowserExtensionSidePanel } from '../../electron-main/paradisBrowserExtensionSidePanel.js';
import type { IParadisTabView, ParadisBrowserExtensionTabs } from '../../electron-main/paradisBrowserExtensionTabs.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

function outcome(run: () => unknown): unknown {
	try {
		return run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionSidePanel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-side-panel-'));
		const namespaces = new Map<string, IParadisExtensionApiNamespace>();
		const emitted: unknown[][] = [];
		const host = {
			registerNamespace: (name: string, namespace: IParadisExtensionApiNamespace) => namespaces.set(name, namespace),
			onDidCloseContext: () => ({ dispose: () => { } }),
			emit: (_target: unknown, _namespace: string, event: string, args: unknown[]) => emitted.push([event, ...args]),
		} as unknown as ParadisExtensionApiHost;
		const session = { storagePath: '/tmp/profile' } as unknown as ParadisApiSession;
		const extension: IParadisSidePanelExtension = { id: ID, version: '1', name: 'Panel', manifest: { manifest_version: 3, permissions: ['sidePanel'], side_panel: { default_path: 'panel.html' } } };
		const closeEmitters: Emitter<void>[] = [];
		const makeView = (id: number, windowId = 1): IParadisTabView & { agent: boolean; close(): void } => {
			const onDidClose = new Emitter<void>();
			closeEmitters.push(onDidClose);
			const view = {
				id: `view-${id}`, windowId, agent: false,
				webContents: { id, isDestroyed: () => false, session } as unknown as IParadisTabView['webContents'],
				isAgentTab: () => view.agent, isVisible: () => true, onDidClose: onDidClose.event, onDidChangeVisibility: Event.None,
				close: () => onDidClose.fire(),
			};
			return view;
		};
		const tab1 = makeView(11);
		const tab2 = makeView(12);
		const views = [tab1, tab2];
		const active = new Map<number, IParadisTabView>([[1, tab1]]);
		const onDidChangeActiveTab = new Emitter<number>();
		const onDidBecomeAgentTab = new Emitter<unknown>();
		const tabs = {
			activeTabOf: (windowId: number) => active.get(windowId),
			onDidChangeActiveTab: onDidChangeActiveTab.event,
			onDidBecomeAgentTab: onDidBecomeAgentTab.event,
			visibleViewsIn: (windowId: number) => [...active.values()].filter(view => view.windowId === windowId),
			userViewOf: (_caller: unknown, tabId: number) => views.find(view => view.webContents.id === tabId && !view.agent),
			currentWindowId: () => 1,
			openTabFor: async () => { },
		} as unknown as ParadisBrowserExtensionTabs;
		const created: { bounds: unknown[]; visible: boolean[]; loaded: string[]; closed: boolean; navigate?: (event: { preventDefault(): void }, url: string) => void; open?: (details: { url: string }) => unknown } = { bounds: [], visible: [], loaded: [], closed: false };
		let gesture = false;
		const window = { isDestroyed: () => false, contentView: { addChildView: () => { }, removeChildView: () => { } }, once: () => { }, removeListener: () => { } } as unknown as BrowserWindow;
		const panel = new ParadisBrowserExtensionSidePanel(host, tabs, {
			findView: viewId => views.find(view => view.id === viewId),
			windowById: () => window,
			sessionOf: () => ({ session, place: 'default', extensions: [extension] }),
			hasUserGesture: () => gesture,
			nameOf: candidate => candidate.name,
			createView: () => ({
				webContents: {
					isDestroyed: () => created.closed,
					close: () => { created.closed = true; },
					on: (event: string, listener: (event: { preventDefault(): void }, url: string) => void) => { if (event === 'will-navigate') { created.navigate = listener; } },
					setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => { created.open = handler; },
					loadURL: async (url: string) => { created.loaded.push(url); },
				},
				setBounds: (bounds: unknown) => created.bounds.push(bounds),
				setVisible: (visible: boolean) => created.visible.push(visible),
			}) as unknown as WebContentsView,
		}, join(root, 'side-panel.json'), { warn: () => { } });
		const caller: IParadisExtensionApiCaller = { extension, session, place: 'default', connection: 'worker', fromWorker: true };
		const call = (method: string, ...args: unknown[]) => namespaces.get('sidePanel')!.methods[method].invoke(caller, args);
		return { root, panel, call, emitted, created, tab1, tab2, active, onDidChangeActiveTab, onDidBecomeAgentTab, setGesture: (value: boolean) => { gesture = value; }, dispose: () => { panel.dispose(); onDidChangeActiveTab.dispose(); onDidBecomeAgentTab.dispose(); closeEmitters.forEach(emitter => emitter.dispose()); } };
	}

	test('keeps options like Chromium: the manifest first, then the default, then per tab', async () => {
		const { root, call, dispose } = await setup();
		try {
			const manifest = call('getOptions', {});
			call('setOptions', { tabId: 12, path: 'tab.html' });
			const afterTab = [call('getOptions', {}), call('getOptions', { tabId: 12 }), call('getOptions', { tabId: 11 })];
			call('setOptions', { enabled: false });
			const afterDefault = [call('getOptions', {}), call('getOptions', { tabId: 11 }), call('getOptions', { tabId: 12 })];
			await call('setPanelBehavior', { openPanelOnActionClick: true });
			assert.deepStrictEqual({ manifest, afterTab, afterDefault, behavior: call('getPanelBehavior'), layout: call('getLayout'), saved: JSON.parse(await fs.readFile(join(root, 'side-panel.json'), 'utf8')) }, {
				manifest: { path: 'panel.html', enabled: true },
				afterTab: [{ path: 'panel.html', enabled: true }, { tabId: 12, path: 'tab.html', enabled: true }, { tabId: 11, path: 'panel.html', enabled: true }],
				afterDefault: [{ path: 'panel.html', enabled: false }, { tabId: 11, path: 'panel.html', enabled: false }, { tabId: 12, path: 'tab.html', enabled: true }],
				behavior: { openPanelOnActionClick: true },
				layout: { side: 'right' },
				saved: { default: { [ID]: true } },
			});
		} finally {
			dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('opens only on a user gesture, shows next to the window\'s front tab, and closes when that tab is shared or turns out to be an agent\'s', async () => {
		const { root, panel, call, emitted, created, tab1, tab2, active, onDidChangeActiveTab, setGesture, dispose } = await setup();
		try {
			const noGesture = outcome(() => call('open', { windowId: -2 }));
			setGesture(true);
			const noTarget = outcome(() => call('open', {}));
			const unknownTab = outcome(() => call('open', { tabId: 99 }));
			call('open', { windowId: -2 });
			const shown = panel.panelFor(tab1.id);
			const otherTab = panel.panelFor(tab2.id);
			panel.layout(tab1.id, { x: 100, y: 50, width: 300, height: 400, zoomFactor: 1.5 });
			// target=_blank はタブで開き、拡張機能の外へは移らない
			let prevented = false;
			created.navigate?.({ preventDefault: () => { prevented = true; } }, 'https://example.com/');
			const openResult = created.open?.({ url: 'https://example.com/' });
			// 前のタブが共有中のタブになった: 閉じる
			active.set(1, tab2);
			paradisSetExtensionPageHold(tab2.webContents, true);
			onDidChangeActiveTab.fire(1);
			paradisSetExtensionPageHold(tab2.webContents, false);
			const afterShare = panel.panelFor(tab2.id);
			const closedView = created.closed;
			// エージェントのタブの横には開けない
			tab2.agent = true;
			const nextToAgent = outcome(() => call('open', { tabId: 12 }));
			tab2.agent = false;
			const closeMissing = outcome(() => call('close', { windowId: 1 }));
			assert.deepStrictEqual({ noGesture, noTarget, unknownTab, shown, otherTab, bounds: created.bounds, loaded: created.loaded, prevented, openResult, afterShare, closedView, nextToAgent, closeMissing, emitted }, {
				noGesture: '`sidePanel.open()` may only be called in response to a user gesture.',
				noTarget: 'At least one of `tabId` and `windowId` must be provided',
				unknownTab: 'No tab with id: 99.',
				shown: { extensionId: ID, name: 'Panel', width: 360 },
				otherTab: undefined,
				bounds: [{ x: 150, y: 75, width: 450, height: 600 }],
				loaded: [`chrome-extension://${ID}/panel.html`],
				prevented: true,
				openResult: { action: 'deny' },
				afterShare: undefined,
				closedView: true,
				nextToAgent: 'No tab with id: 12.',
				closeMissing: 'No active side panel for windowId: 1',
				emitted: [['onOpened', { windowId: 1, path: 'panel.html' }], ['onClosed', { windowId: 1, path: 'panel.html' }]],
			});
		} finally {
			dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('hides the panel when the tab it was shown for asks, even after that tab left the editor, and ignores hides from other tabs', async () => {
		const { root, panel, call, created, tab1, tab2, setGesture, dispose } = await setup();
		try {
			setGesture(true);
			call('open', { windowId: -2 });
			panel.layout(tab1.id, { x: 0, y: 0, width: 300, height: 400, zoomFactor: 1 });
			// 最初の false は作ったときに隠したもの。前のタブではないタブのエディタから遅れて届いた「隠す」は捨てる
			panel.layout(tab2.id, undefined);
			const afterOtherHide = [...created.visible];
			panel.layout(tab1.id, undefined);
			// 二度目の「隠す」は何もしない
			panel.layout(tab1.id, undefined);
			assert.deepStrictEqual({ afterOtherHide, visible: created.visible }, { afterOtherHide: [false, true], visible: [false, true, false] });
		} finally {
			dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('hides the panel when the tab it was shown for closes without the renderer asking', async () => {
		const { root, panel, call, created, tab1, setGesture, dispose } = await setup();
		try {
			setGesture(true);
			call('open', { windowId: -2 });
			panel.layout(tab1.id, { x: 0, y: 0, width: 300, height: 400, zoomFactor: 1 });
			tab1.close();
			// 閉じた後に遅れて届く「隠す」は何もしない
			panel.layout(tab1.id, undefined);
			assert.deepStrictEqual(created.visible, [false, true, false]);
		} finally {
			dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('the toolbar button toggles the panel before the popup when the extension asks for it', async () => {
		const { root, panel, call, tab1, dispose } = await setup();
		try {
			const session = (tab1.webContents as unknown as { session: ParadisApiSession }).session;
			const extension = { id: ID, version: '1', name: 'Panel', manifest: { side_panel: { default_path: 'panel.html' } } };
			const before = panel.toggleFromAction(tab1, session, 'default', extension);
			await call('setPanelBehavior', { openPanelOnActionClick: true });
			const opened = panel.toggleFromAction(tab1, session, 'default', extension);
			const shown = panel.panelFor(tab1.id)?.extensionId;
			const closed = panel.toggleFromAction(tab1, session, 'default', extension);
			assert.deepStrictEqual({ before, opened, shown, closed, after: panel.panelFor(tab1.id) }, { before: false, opened: true, shown: ID, closed: true, after: undefined });
		} finally {
			dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

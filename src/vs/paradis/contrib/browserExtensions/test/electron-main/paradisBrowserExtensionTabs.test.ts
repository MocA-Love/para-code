/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions, Session, WebContents } from 'electron';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { PARADIS_EXTENSION_API_CALL_URL, PARADIS_EXTENSION_API_EVENTS_URL, paradisDecodeExtensionWire, paradisEncodeExtensionWire, paradisExtensionApiUrl } from '../../common/paradisBrowserExtensionApiWire.js';
import { PARADIS_SHIM_SURFACE } from '../../common/paradisBrowserExtensionShim.js';
import { IParadisApiExtension, ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { paradisRegisterRuntimeApis } from '../../electron-main/paradisBrowserExtensionRuntime.js';
import { paradisRegisterStorageApis, ParadisBrowserExtensionSyncStore } from '../../electron-main/paradisBrowserExtensionStorageApis.js';
import { paradisRegisterBrowsingDataApis } from '../../electron-main/paradisBrowserExtensionBrowsingData.js';
import { ParadisBrowserExtensionSidePanel } from '../../electron-main/paradisBrowserExtensionSidePanel.js';
import { IParadisTabEnvironment, IParadisTabView, ParadisBrowserExtensionTabs, paradisCanSeeTabUrl, paradisMatchesUrlPattern } from '../../electron-main/paradisBrowserExtensionTabs.js';
import { IParadisActionsEnvironment, ParadisBrowserExtensionActions } from '../../electron-main/paradisBrowserExtensionActions.js';
import { ParadisBrowserExtensionMenus } from '../../electron-main/paradisBrowserExtensionMenus.js';
import { IParadisPermissionPrompt, ParadisBrowserExtensionPermissions, paradisOriginPatternCovers, paradisPlanPermissionRequest } from '../../electron-main/paradisBrowserExtensionPermissions.js';
import { IParadisExtensionNotification, IParadisManagedExtension, IParadisServicesEnvironment, ParadisBrowserExtensionServices, paradisDownloadFilename, paradisDownloadHeaders, paradisExtensionDownloadsFolder, paradisNotificationIconPath } from '../../electron-main/paradisBrowserExtensionServices.js';
import { paradisGestureExtensionId } from '../../electron-main/paradisBrowserExtensionWindows.js';
import { EventEmitter } from 'events';
import { paradisSetExtensionPageHold } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const silentLog = { warn: () => { } };

let nextContentsId = 100;

/** タブの中身の偽物（`emit` でイベントを出せる）。 */
function fakeContents(session: object, url: string, title: string): WebContents & { emit(event: string, ...args: unknown[]): void } {
	const id = nextContentsId++;
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	return {
		id, session,
		getURL: () => url,
		getTitle: () => title,
		isLoading: () => false,
		isCurrentlyAudible: () => false,
		isAudioMuted: () => false,
		isDestroyed: () => false,
		on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
		off: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener)); },
		emit: (event: string, ...args: unknown[]) => (listeners.get(event) ?? []).forEach(listener => listener(...args)),
		mainFrame: { framesInSubtree: [] },
		loadURL: async () => { },
	} as unknown as WebContents & { emit(event: string, ...args: unknown[]): void };
}

interface IFakeView extends IParadisTabView {
	agent: boolean;
	visible: boolean;
	readonly close: Emitter<void>;
	readonly visibility: Emitter<boolean>;
}

function fakeView(id: string, contents: WebContents, windowId: number, agent = false): IFakeView {
	const close = new Emitter<void>();
	const visibility = new Emitter<boolean>();
	const view: IFakeView = {
		id, webContents: contents, windowId, agent, visible: false, close, visibility,
		isAgentTab: () => view.agent,
		isVisible: () => view.visible,
		onDidClose: close.event,
		onDidChangeVisibility: visibility.event,
	};
	return view;
}

function fakeWindow(id: number): BrowserWindow {
	return {
		id,
		isDestroyed: () => false,
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		isFullScreen: () => false,
		isMinimized: () => false,
		isMaximized: () => false,
		isFocused: () => true,
		isAlwaysOnTop: () => false,
	} as unknown as BrowserWindow;
}

function setup(extensionManifest: Record<string, unknown>) {
	const electronSession = {} as Session;
	const otherSession = {} as Session;
	let handler: ((request: Request) => Promise<Response>) | undefined;
	const extension: IParadisApiExtension = { id: ID, version: '1', manifest: extensionManifest };
	const apiSession = {
		storagePath: '/tmp/x',
		protocol: { handle: (_scheme: string, next: (request: Request) => Promise<Response>) => { handler = next; }, unhandle: () => { handler = undefined; } },
		extensions: { getExtension: (id: string) => id === ID ? extension : null, getAllExtensions: () => [extension], on: () => undefined, removeListener: () => undefined },
		serviceWorkers: { startWorkerForScope: async () => { throw new Error('none'); }, getWorkerFromVersionID: () => undefined, on: () => undefined, removeListener: () => undefined },
	} as unknown as ParadisApiSession & { readonly extensions: { getAllExtensions(): readonly IParadisApiExtension[] } };
	const created = new Emitter<{ readonly view: IParadisTabView; readonly existing: boolean }>();
	const focus = new Emitter<number>();
	const views: IFakeView[] = [];
	const activated: string[] = [];
	const environment: IParadisTabEnvironment = {
		listViews: () => views,
		onDidCreateView: created.event,
		listWindows: () => [fakeWindow(1), fakeWindow(2)],
		lastActiveWindowId: () => 1,
		createTab: async (url, _sessionId, windowId) => {
			const view = fakeView(`new-${views.length}`, fakeContents(electronSession, url, 'New'), windowId);
			views.push(view);
			return view;
		},
		closeTab: async viewId => {
			views.splice(views.findIndex(view => view.id === viewId), 1);
		},
		activateTab: (_windowId, viewId) => activated.push(viewId),
		onDidFocusWindow: focus.event,
	};
	const host = new ParadisExtensionApiHost(silentLog);
	const tabs = new ParadisBrowserExtensionTabs(host, environment, silentLog, () => { throw new Error('no popouts in this test'); });
	paradisRegisterRuntimeApis(host, caller => tabs.openOptionsPage(caller));
	const attached = [host.attachSession(apiSession, 'default'), tabs.attachSession({ session: apiSession, electronSession, browserSessionId: 'global' })];
	const token = host.tokenFor(ID);
	const call = async (namespace: string, method: string, args: unknown[]) => {
		const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, token, 'worker'), { method: 'POST', body: paradisEncodeExtensionWire({ request: { type: 'call', namespace, method, args } }) });
		Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
		return paradisDecodeExtensionWire(await (await handler!(request)).text());
	};
	/** 拡張機能のページから呼ぶ（`userGesture` は本文に書く偽の申告。main は読まない）。 */
	const callPage = async (namespace: string, method: string, args: unknown[], userGesture = false) => {
		const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, token, 'page-test'), { method: 'POST', body: paradisEncodeExtensionWire({ request: { type: 'call', namespace, method, args, userGesture } }) });
		Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
		return paradisDecodeExtensionWire(await (await handler!(request)).text());
	};
	const openEvents = async () => {
		const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_EVENTS_URL, token, 'worker'), { method: 'POST', body: '{}' });
		Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
		return handler!(request);
	};
	const listen = async (namespace: string, event: string) => {
		const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, token, 'worker'), { method: 'POST', body: paradisEncodeExtensionWire({ request: { type: 'listen', namespace, event, active: true } }) });
		Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
		await handler!(request);
	};
	/** タブを足し、エージェントのタブかが分かるまでの待ちを過ぎさせる（偽の時計の中で使う）。 */
	const addTabs = async (...added: IFakeView[]) => {
		for (const view of added) {
			views.push(view);
			created.fire({ view, existing: true });
		}
		await new Promise(resolve => setTimeout(resolve, 3_100));
	};
	const dispose = () => {
		attached.forEach(disposable => disposable.dispose());
		tabs.dispose();
		host.dispose();
		created.dispose();
		focus.dispose();
		views.forEach(view => { view.close.dispose(); view.visibility.dispose(); });
	};
	return { electronSession, otherSession, views, created, activated, call, callPage, openEvents, listen, dispose, host, addTabs, focus, tabs, apiSession, extension };
}

suite('ParadisBrowserExtensionTabs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists only the tabs of the caller\'s session, never an agent\'s', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, otherSession, addTabs, call, dispose } = setup({ permissions: ['tabs'] });
		try {
			const user = fakeView('user', fakeContents(electronSession, 'https://example.com/', 'Example'), 1);
			const agent = fakeView('agent', fakeContents(electronSession, 'https://agent.example/', 'Agent'), 1, true);
			const profile = fakeView('profile', fakeContents(otherSession, 'https://work.example/', 'Work'), 1);
			await addTabs(user, agent, profile);
			const query = await call('tabs', 'query', [{}]) as { ok: true; value: { id: number; url?: string }[] };
			assert.deepStrictEqual({
				query: query.value.map(tab => [tab.id, tab.url]),
				getAgent: await call('tabs', 'get', [agent.webContents.id]),
				getOther: await call('tabs', 'get', [profile.webContents.id]),
			}, {
				query: [[user.webContents.id, 'https://example.com/']],
				getAgent: { ok: false, error: `No tab with id: ${agent.webContents.id}.` },
				getOther: { ok: false, error: `No tab with id: ${profile.webContents.id}.` },
			});
		} finally {
			dispose();
		}
	}));

	test('shows the URL and title only with the tabs permission or a matching host permission', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const withHost = setup({ host_permissions: ['https://*.example.com/*'] });
		try {
			await withHost.addTabs(
				fakeView('a', fakeContents(withHost.electronSession, 'https://mail.example.com/inbox', 'Mail'), 1),
				fakeView('b', fakeContents(withHost.electronSession, 'https://other.test/', 'Other'), 1),
			);
			const tabs = (await withHost.call('tabs', 'query', [{}]) as { value: { url?: string; title?: string }[] }).value;
			const byUrl = (await withHost.call('tabs', 'query', [{ url: 'https://*/*' }]) as { value: unknown[] }).value;
			assert.deepStrictEqual({ seen: tabs.map(tab => tab.url ?? '(hidden)'), titles: tabs.map(tab => tab.title ?? '(hidden)'), byUrl: byUrl.length }, {
				seen: ['https://mail.example.com/inbox', '(hidden)'],
				titles: ['Mail', '(hidden)'],
				// URL で探せるのは URL を見てよいタブだけ
				byUrl: 1,
			});
		} finally {
			withHost.dispose();
		}
	}));

	test('opens, activates and closes tabs, and refuses what an extension must not do', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, views, activated, call, dispose, addTabs, focus } = setup({ permissions: ['tabs'], options_page: 'options.html' });
		try {
			const user = fakeView('user', fakeContents(electronSession, 'https://example.com/', 'Example'), 1);
			await addTabs(user);
			// エディタの無い窓（拡張機能のポップアップ・DevTools）にフォーカスがあっても、新しいタブは Para Code のウィンドウに置く
			focus.fire(99);
			const created = await call('tabs', 'create', [{ url: 'https://news.example/' }]) as { ok: true; value: { id: number; url: string; windowId: number } };
			await call('tabs', 'update', [user.webContents.id, { active: true }]);
			await call('runtime', 'openOptionsPage', []);
			const options = views.find(view => view.webContents.getURL() === `chrome-extension://${ID}/options.html`);
			await call('tabs', 'remove', [user.webContents.id]);
			assert.deepStrictEqual({
				createdUrl: created.value.url,
				createdWindow: created.value.windowId,
				activated,
				options: options !== undefined,
				otherExtension: await call('tabs', 'create', [{ url: `chrome-extension://${'b'.repeat(32)}/page.html` }]),
				file: await call('tabs', 'create', [{ url: 'file:///etc/passwd' }]),
				closeWindow: await call('windows', 'remove', [1]),
				removed: views.some(view => view.id === 'user'),
			}, {
				createdUrl: 'https://news.example/',
				createdWindow: 1,
				activated: ['new-1', 'user', 'new-2'],
				options: true,
				otherExtension: { ok: false, error: `Cannot open URL: chrome-extension://${'b'.repeat(32)}/page.html` },
				file: { ok: false, error: 'Cannot open URL: file:///etc/passwd' },
				closeWindow: { ok: false, error: 'Extensions cannot close Para Code windows' },
				removed: false,
			});
		} finally {
			dispose();
		}
	}));

	test('announces a new tab only once it is known not to be an agent\'s', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, views, created, openEvents, listen, dispose } = setup({ permissions: ['tabs'] });
		try {
			const stream = await openEvents();
			await listen('tabs', 'onCreated');
			const user = fakeView('user', fakeContents(electronSession, 'https://example.com/', 'Example'), 1);
			const agent = fakeView('agent', fakeContents(electronSession, 'https://agent.example/', 'Agent'), 1);
			views.push(user, agent);
			created.fire({ view: user, existing: false });
			created.fire({ view: agent, existing: false });
			// workbench の台帳が少し後に、エージェントのタブだと知らせる
			agent.agent = true;
			await new Promise(resolve => setTimeout(resolve, 3_500));
			const reader = stream.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			const lines = new TextDecoder().decode(value).trim().split('\n').map(line => paradisDecodeExtensionWire(line) as { args: [{ id: number; url?: string }] });
			// onCreated には URL を入れない（目印が遅れたエージェントのタブの URL を最初の知らせで漏らさない）
			assert.deepStrictEqual(lines.map(line => [line.args[0].id, line.args[0].url]), [[user.webContents.id, undefined]]);
		} finally {
			dispose();
		}
	}));

	test('drops a tab from the list once a late agent mark arrives', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, dispose } = setup({ permissions: ['tabs'] });
		try {
			const late = fakeView('late', fakeContents(electronSession, 'https://agent.example/', 'Agent'), 1);
			// 目印が待ち時間（3 秒）より遅れて届いた
			await addTabs(late);
			const before = (await call('tabs', 'query', [{}]) as { value: { id: number }[] }).value.map(tab => tab.id);
			late.agent = true;
			const after = (await call('tabs', 'query', [{}]) as { value: unknown[] }).value;
			assert.deepStrictEqual({ before, after, get: await call('tabs', 'get', [late.webContents.id]) }, {
				before: [late.webContents.id],
				after: [],
				get: { ok: false, error: `No tab with id: ${late.webContents.id}.` },
			});
		} finally {
			dispose();
		}
	}));

	test('matches Chrome URL patterns', () => {
		assert.deepStrictEqual([
			paradisMatchesUrlPattern('<all_urls>', 'https://a.test/x'),
			paradisMatchesUrlPattern('*://*.example.com/*', 'https://example.com/'),
			paradisMatchesUrlPattern('*://*.example.com/*', 'https://evil-example.com/'),
			paradisMatchesUrlPattern('https://example.com/path*', 'https://example.com/pathname?q=1'),
			paradisMatchesUrlPattern('http://example.com/*', 'https://example.com/'),
			paradisCanSeeTabUrl({ id: ID, version: '1', manifest: {} }, `chrome-extension://${ID}/popup.html`),
			paradisCanSeeTabUrl({ id: ID, version: '1', manifest: {} }, 'https://example.com/'),
		], [true, true, false, true, false, true, false]);
	});

	test('the shim offers exactly what main registers', () => {
		// 詰め物が足す関数・イベントと、main が受ける関数・イベントがずれると、呼んでも「無い」と断られる
		const host = new ParadisExtensionApiHost(silentLog);
		const environment = { listViews: () => [], onDidCreateView: Event.None as Event<{ readonly view: IParadisTabView; readonly existing: boolean }>, listWindows: () => [], lastActiveWindowId: () => undefined, createTab: async () => { throw new Error(); }, closeTab: async () => { }, activateTab: () => { }, onDidFocusWindow: Event.None };
		const tabs = new ParadisBrowserExtensionTabs(host, environment, silentLog, () => { throw new Error(); });
		paradisRegisterRuntimeApis(host, async () => { });
		paradisRegisterStorageApis(host, new ParadisBrowserExtensionSyncStore('/tmp/unused', silentLog));
		const actions = new ParadisBrowserExtensionActions(host, tabs, unusedActionsEnvironment, silentLog);
		const menus = new ParadisBrowserExtensionMenus(host, tabs, { findView: () => undefined, sessionOf: () => undefined, allLoaded: () => [], nameOf: extension => extension.name }, '/tmp/unused-menus.json', silentLog);
		const permissions = new ParadisBrowserExtensionPermissions(host, '/tmp/unused-grants.json', silentLog, async () => false, extension => extension.id);
		new ParadisBrowserExtensionServices(host, tabs, permissions, unusedServicesEnvironment);
		paradisRegisterBrowsingDataApis(host, () => []);
		const sidePanel = new ParadisBrowserExtensionSidePanel(host, tabs, { findView: () => undefined, windowById: () => undefined, sessionOf: () => undefined, hasUserGesture: () => false, nameOf: extension => extension.name }, '/tmp/unused-side-panel.json', silentLog);
		try {
			const registered = (host as unknown as { _namespaces: Map<string, { methods: Record<string, unknown>; events: readonly string[]; permission?: unknown }> })._namespaces;
			for (const [name, surface] of Object.entries(PARADIS_SHIM_SURFACE)) {
				const namespace = registered.get(name);
				assert.ok(namespace, name);
				assert.deepStrictEqual({ methods: [...surface.methods].sort(), events: [...surface.events].sort(), permission: surface.permission }, { methods: Object.keys(namespace.methods).sort(), events: [...namespace.events].sort(), permission: namespace.permission }, name);
			}
		} finally {
			sidePanel.dispose();
			menus.dispose();
			actions.dispose();
			tabs.dispose();
			host.dispose();
		}
	});
});

const unusedServicesEnvironment: IParadisServicesEnvironment = {
	createNotification: () => undefined,
	chooseSavePath: async () => undefined,
	renameDownload: () => { },
	listInstalled: () => [],
	setEnabled: async () => { },
	loadedIn: () => undefined,
};

const unusedActionsEnvironment: IParadisActionsEnvironment = {
	findView: () => undefined,
	sessionOf: () => undefined,
	pinnedIn: () => [],
	setPinned: async () => { },
	nameOf: extension => extension.name,
	windowById: () => undefined,
	createPopupWindow: () => { throw new Error('no popups in this test'); },
	workAreaFor: rect => rect,
};

suite('ParadisBrowserExtensionActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setupActions(manifest: Record<string, unknown>) {
		const tabsSetup = setup(manifest);
		const pinned: string[] = [];
		const environment: IParadisActionsEnvironment = {
			...unusedActionsEnvironment,
			findView: viewId => tabsSetup.views.find(view => view.id === viewId),
			sessionOf: contents => contents.session === tabsSetup.electronSession
				? { session: tabsSetup.apiSession, place: 'default', extensions: [{ ...tabsSetup.extension, name: 'Sample', path: '/nonexistent' }] }
				: undefined,
			pinnedIn: () => pinned,
			setPinned: async (_place, id, pin) => {
				pinned.splice(0, pinned.length, ...(pin ? [...pinned.filter(existing => existing !== id), id] : pinned.filter(existing => existing !== id)));
			},
			windowById: windowId => windowId === 1 ? fakeWindow(1) : undefined,
		};
		const actions = new ParadisBrowserExtensionActions(tabsSetup.host, tabsSetup.tabs, environment, silentLog);
		return { ...tabsSetup, actions, pinned, dispose: () => { actions.dispose(); tabsSetup.dispose(); } };
	}

	const anchor = { windowId: 1, x: 10, y: 10, width: 22, height: 22 };

	test('keeps a tab\'s badge over the global one until the tab navigates', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, actions, dispose } = setupActions({ manifest_version: 3, name: 'Sample', action: { default_title: 'Hello' } });
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			const view = fakeView('user', contents, 1);
			await addTabs(view);
			await call('action', 'setBadgeText', [{ text: 'all' }]);
			await call('action', 'setBadgeText', [{ text: '7', tabId: contents.id }]);
			const before = (await actions.getToolbar('user'))?.actions[0].badgeText;
			const tabValue = await call('action', 'getBadgeText', [{ tabId: contents.id }]);
			contents.emit('did-navigate', {}, 'https://example.com/next');
			const afterNavigate = (await actions.getToolbar('user'))?.actions[0];
			await call('action', 'setBadgeText', [{ text: null, tabId: contents.id }]);
			assert.deepStrictEqual({
				before, tabValue, afterNavigate: [afterNavigate?.badgeText, afterNavigate?.title],
				badTab: await call('action', 'setBadgeText', [{ text: 'x', tabId: 9999 }]),
				badColor: await call('action', 'setBadgeBackgroundColor', [{ color: 'nope' }]),
			}, {
				before: '7',
				tabValue: { ok: true, value: '7' },
				afterNavigate: ['all', 'Hello'],
				badTab: { ok: false, error: 'No tab with id: 9999.' },
				badColor: { ok: false, error: 'The color specification could not be parsed.' },
			});
		} finally {
			dispose();
		}
	}));

	test('a click without a popup fires onClicked with the tab, and activeTab shows its URL', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, actions, openEvents, listen, dispose } = setupActions({ manifest_version: 3, name: 'Sample', permissions: ['activeTab'], action: {} });
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			await addTabs(fakeView('user', contents, 1));
			const hiddenBefore = (await call('tabs', 'get', [contents.id]) as { value: { url?: string } }).value.url;
			const stream = await openEvents();
			await listen('action', 'onClicked');
			const result = await actions.activateAction('user', ID, anchor, false);
			const reader = stream.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			const event = paradisDecodeExtensionWire(new TextDecoder().decode(value).trim().split('\n')[0]) as { event: string; args: [{ id: number; url?: string }] };
			contents.emit('did-navigate', {}, 'https://other.example/');
			assert.deepStrictEqual({
				hiddenBefore, result, event: [event.event, event.args[0].id, event.args[0].url],
				shownAfterClick: (await call('tabs', 'get', [contents.id]) as { value: { url?: string } }).value.url,
				wrongWindow: await actions.activateAction('user', ID, { ...anchor, windowId: 5 }, false),
				popupOnly: await actions.activateAction('user', ID, anchor, true),
			}, {
				hiddenBefore: undefined,
				result: { ok: true },
				event: ['onClicked', contents.id, 'https://example.com/'],
				// 別の文書へ移ると activeTab は切れる
				shownAfterClick: undefined,
				wrongWindow: { ok: false, error: 'Para Code has no window to show the popup in' },
				popupOnly: { ok: false, error: 'This extension has no popup' },
			});
		} finally {
			dispose();
		}
	}));

	test('openPopup asks the workbench for the active tab\'s button and gives up after a while', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, actions, dispose } = setupActions({ manifest_version: 3, name: 'Sample', action: { default_popup: 'popup.html' } });
		try {
			const view = fakeView('user', fakeContents(electronSession, 'https://example.com/', 'Example'), 1);
			view.visible = true;
			await addTabs(view);
			const requests: { viewId: string; extensionId: string }[] = [];
			const listener = actions.onDidRequestPopup(request => requests.push({ viewId: request.viewId, extensionId: request.extensionId }));
			const reply = await call('action', 'openPopup', []);
			listener.dispose();
			assert.deepStrictEqual({ requests, reply, popup: await call('action', 'getPopup', [{}]) }, {
				requests: [{ viewId: 'user', extensionId: ID }],
				reply: { ok: false, error: 'Could not show the popup' },
				popup: { ok: true, value: `chrome-extension://${ID}/popup.html` },
			});
		} finally {
			dispose();
		}
	}));

	test('pins per place and tells the extension', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, actions, pinned, dispose } = setupActions({ manifest_version: 3, name: 'Sample', action: {} });
		try {
			await addTabs(fakeView('user', fakeContents(electronSession, 'https://example.com/', 'Example'), 1));
			const before = await call('action', 'getUserSettings', []);
			await actions.setPinned('user', ID, true);
			const toolbar = await actions.getToolbar('user');
			assert.deepStrictEqual({ before, pinned: [...pinned], toolbarPinned: toolbar?.actions[0].pinned, after: await call('action', 'getUserSettings', []), agentlessMissing: await actions.getToolbar('missing') }, {
				before: { ok: true, value: { isOnToolbar: false } },
				pinned: [ID],
				toolbarPinned: true,
				after: { ok: true, value: { isOnToolbar: true } },
				agentlessMissing: undefined,
			});
		} finally {
			dispose();
		}
	}));
});

suite('ParadisBrowserExtensionMenus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let nextFile = 0;

	function setupMenus(manifest: Record<string, unknown>, platform: NodeJS.Platform = 'linux') {
		const tabsSetup = setup(manifest);
		const path = join(tmpdir(), `paradis-menus-test-${process.pid}-${nextFile++}.json`);
		const menus = new ParadisBrowserExtensionMenus(tabsSetup.host, tabsSetup.tabs, {
			findView: viewId => tabsSetup.views.find(view => view.id === viewId),
			sessionOf: contents => contents.session === tabsSetup.electronSession ? { session: tabsSetup.apiSession, extensions: [{ ...tabsSetup.extension, name: 'Sample', path: '/nonexistent' }] } : undefined,
			allLoaded: () => [{ ...tabsSetup.extension, name: 'Sample', path: '/nonexistent' }],
			nameOf: extension => extension.name,
			isAgentTab: contents => tabsSetup.views.find(view => view.webContents === contents)?.isAgentTab() === true,
		}, path, silentLog, platform);
		/** 次の 1 件のイベント。 */
		const nextEvent = async (stream: Response) => {
			const reader = stream.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			return paradisDecodeExtensionWire(new TextDecoder().decode(value).trim().split('\n')[0]) as { event: string; args: unknown[] };
		};
		return { ...tabsSetup, menus, path, nextEvent, dispose: () => { menus.dispose(); tabsSetup.dispose(); } };
	}

	const pageParams = { isEditable: false, mediaType: 'none', linkURL: '', srcURL: '', selectionText: '', frameURL: '' } as unknown as ContextMenuParams;

	test('adds the extension items to a page right-click and reports the click with the tab', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, menus, openEvents, listen, nextEvent, dispose } = setupMenus({ manifest_version: 3, permissions: ['contextMenus', 'tabs'] });
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			await addTabs(fakeView('user', contents, 1));
			const created = await call('contextMenus', 'create', [{ id: 'fill', title: 'Fill %s', contexts: ['page', 'selection'] }]);
			await call('contextMenus', 'create', [{ id: 'mode', title: 'Strict', type: 'checkbox', contexts: ['all'] }]);
			const items = menus.buildPageMenu(contents, pageParams);
			const submenu = items[0].submenu as MenuItemConstructorOptions[];
			const stream = await openEvents();
			await listen('contextMenus', 'onClicked');
			submenu[1].click!(undefined as never, undefined, undefined as never);
			const event = await nextEvent(stream);
			const after = menus.buildPageMenu(contents, pageParams)[0].submenu as MenuItemConstructorOptions[];
			assert.deepStrictEqual({
				created,
				menu: items.map(item => item.label),
				submenu: submenu.map(item => [item.label, item.type ?? 'normal', item.checked]),
				event: [event.event, event.args[0], (event.args[1] as { id: number; url: string }).url],
				checkedAfterClick: after[1].checked,
				otherTab: menus.buildPageMenu(fakeContents({}, 'https://x.test/', 'X'), pageParams),
				agentTab: await (async () => {
					const agentContents = fakeContents(electronSession, 'https://agent.test/', 'Agent');
					await addTabs(fakeView('agent', agentContents, 1, true));
					return menus.buildPageMenu(agentContents, pageParams);
				})(),
			}, {
				created: { ok: true, value: 'fill' },
				menu: ['Sample'],
				submenu: [['Fill ', 'normal', undefined], ['Strict', 'checkbox', false]],
				event: ['onClicked', { menuItemId: 'mode', pageUrl: 'https://example.com/', frameId: 0, editable: false, wasChecked: false, checked: true }, 'https://example.com/'],
				checkedAfterClick: true,
				otherTab: [],
				agentTab: [],
			});
		} finally {
			dispose();
		}
	}));

	test('needs the contextMenus permission and keeps the items across a restart', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const without = setupMenus({ manifest_version: 3 });
		const withPermission = setupMenus({ manifest_version: 3, permissions: ['contextMenus'] });
		try {
			const refused = await without.call('contextMenus', 'create', [{ id: 'x', title: 'X' }]);
			await withPermission.call('contextMenus', 'create', [{ id: 'kept', title: 'Kept' }]);
			await withPermission.call('contextMenus', 'create', [{ id: 'gone', title: 'Gone' }]);
			await withPermission.call('contextMenus', 'remove', ['gone']);
			// 書き終えるのを待つ（別の拡張機能を忘れる書き込みは、前の書き込みの後に並ぶ）
			await withPermission.menus.forgetExtension('b'.repeat(32));
			const reloaded = new ParadisBrowserExtensionMenus(withPermission.host, withPermission.tabs, { findView: () => undefined, sessionOf: () => undefined, allLoaded: () => [], nameOf: extension => extension.name }, withPermission.path, silentLog);
			await reloaded.load();
			const contents = fakeContents(withPermission.electronSession, 'https://example.com/', 'Example');
			const restored = (reloaded as unknown as { _items(session: unknown, id: string): { id: string }[] })._items(withPermission.apiSession, ID).map(item => item.id);
			reloaded.dispose();
			assert.deepStrictEqual({ refused, restored, removeMissing: await withPermission.call('contextMenus', 'remove', ['gone']), page: withPermission.menus.buildPageMenu(contents, pageParams).map(item => item.label) }, {
				refused: { ok: false, error: 'This API requires the "contextMenus" permission' },
				restored: ['kept'],
				removeMissing: { ok: false, error: 'Cannot find menu item with id gone' },
				page: ['Kept'],
			});
		} finally {
			without.dispose();
			withPermission.dispose();
		}
	}));

	test('runs a toolbar button menu item once, and not after the tab moved to another document', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, menus, dispose } = setupMenus({ manifest_version: 3, permissions: ['contextMenus'] });
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			const frame = { frameTreeNodeId: 5, processId: 1, routingId: 2, parent: null, isDestroyed: () => false };
			Object.assign(contents, { mainFrame: { ...frame, framesInSubtree: [frame] } });
			Object.assign(contents.mainFrame.framesInSubtree, [contents.mainFrame]);
			await addTabs(fakeView('user', contents, 1));
			await call('contextMenus', 'create', [{ id: 'act', title: 'From the button', contexts: ['action'] }]);
			await call('contextMenus', 'create', [{ id: 'page', title: 'Page only' }]);
			const first = menus.getActionMenu('user', ID)!;
			const once = [menus.runActionMenuItem(first.token, ID, '"act"'), menus.runActionMenuItem(first.token, ID, '"act"')];
			const second = menus.getActionMenu('user', ID)!;
			contents.emit('did-frame-navigate', {}, 'https://example.com/next', 200, 'OK', true, 1, 2);
			assert.deepStrictEqual({ items: first.items.map(item => item.title), once, afterNavigate: menus.runActionMenuItem(second.token, ID, '"act"'), noItems: menus.getActionMenu('missing', ID) }, {
				items: ['From the button'],
				once: [true, false],
				afterNavigate: false,
				noItems: undefined,
			});
		} finally {
			dispose();
		}
	}));

	test('lists the shortcuts and fires onCommand with the tab, but not _execute_action', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, menus, openEvents, listen, nextEvent, dispose } = setupMenus({
			manifest_version: 3, name: 'Sample', permissions: ['tabs'],
			commands: { '_execute_action': { suggested_key: { default: 'Ctrl+Shift+Y' } }, 'fill': { description: 'Fill', suggested_key: { default: 'Ctrl+Shift+L' } }, 'none': { description: 'No key' } },
		});
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			await addTabs(fakeView('user', contents, 1));
			const stream = await openEvents();
			await listen('commands', 'onCommand');
			const run = menus.runCommand('user', ID, 'fill');
			const event = await nextEvent(stream);
			assert.deepStrictEqual({
				getAll: await call('commands', 'getAll', []),
				listed: menus.getCommands().map(command => [command.name, command.shortcut]),
				run,
				event: [event.event, event.args[0], (event.args[1] as { url: string }).url],
				executeAction: menus.runCommand('user', ID, '_execute_action'),
				unassigned: menus.runCommand('user', ID, 'none'),
			}, {
				getAll: { ok: true, value: [{ name: '_execute_action', description: '', shortcut: 'Ctrl+Shift+Y' }, { name: 'fill', description: 'Fill', shortcut: 'Ctrl+Shift+L' }, { name: 'none', description: 'No key', shortcut: '' }] },
				listed: [['_execute_action', 'Ctrl+Shift+Y'], ['fill', 'Ctrl+Shift+L']],
				run: { ok: true },
				event: ['onCommand', 'fill', 'https://example.com/'],
				executeAction: { ok: false, error: 'This shortcut is not on for this tab' },
				unassigned: { ok: false, error: 'This shortcut is not on for this tab' },
			});
		} finally {
			dispose();
		}
	}));
});

suite('ParadisBrowserExtensionServices', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let nextFile = 0;

	function setupServices(manifest: Record<string, unknown>, options: { readonly answer?: boolean; readonly installed?: IParadisManagedExtension[] } = {}) {
		const tabsSetup = setup(manifest);
		const prompts: IParadisPermissionPrompt[] = [];
		let now = 1_000_000;
		const permissions = new ParadisBrowserExtensionPermissions(tabsSetup.host, join(tmpdir(), `paradis-grants-test-${process.pid}-${nextFile++}.json`), silentLog, async prompt => {
			prompts.push(prompt);
			return options.answer ?? true;
		}, () => 'Sample', () => now);
		tabsSetup.tabs.setGrantedOriginsLookup(extension => permissions.granted(extension.id, 'default').origins);
		const cookieJar: { name: string; value: string; domain: string; path: string; secure: boolean }[] = [
			{ name: 'sid', value: 'mail-secret', domain: 'mail.example.com', path: '/', secure: true },
			{ name: 'other', value: 'other-secret', domain: 'other.test', path: '/', secure: true },
		];
		const cookieEvents = new EventEmitter();
		Object.assign(tabsSetup.electronSession, {
			cookies: {
				get: async (filter: { url?: string; name?: string }) => cookieJar.filter(cookie => (!filter.name || cookie.name === filter.name) && (!filter.url || new URL(filter.url).hostname === cookie.domain)),
				on: (event: string, listener: (...args: unknown[]) => void) => cookieEvents.on(event, listener),
			},
			extensions: { getAllExtensions: () => [tabsSetup.extension] },
		});
		const notifications: { title: string; listeners: Map<string, (index?: number) => void> }[] = [];
		const enabledChanges: [string, string, boolean][] = [];
		const environment: IParadisServicesEnvironment = {
			...unusedServicesEnvironment,
			createNotification: notificationOptions => {
				const listeners = new Map<string, (index?: number) => void>();
				notifications.push({ title: notificationOptions.title, listeners });
				return { on: (event: string, listener: (index?: number) => void) => listeners.set(event, listener), show: () => { }, close: () => { }, removeAllListeners: () => listeners.clear() } as unknown as IParadisExtensionNotification;
			},
			listInstalled: () => options.installed ?? [],
			setEnabled: async (id, place, enabled) => { enabledChanges.push([id, place, enabled]); },
		};
		tabsSetup.tabs.setUserGestureLookup(caller => permissions.hasUserGesture(caller));
		const services = new ParadisBrowserExtensionServices(tabsSetup.host, tabsSetup.tabs, permissions, environment);
		return { ...tabsSetup, permissions, services, prompts, notifications, enabledChanges, cookieEvents, advance: (ms: number) => now += ms };
	}

	test('permissions.request needs a user gesture and asks the user; granted APIs and sites then work', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { call, callPage, prompts, permissions, apiSession, dispose } = setupServices({ manifest_version: 3, optional_permissions: ['cookies'], optional_host_permissions: ['https://*.example.com/*'] });
		try {
			const wanted = { permissions: ['cookies'], origins: ['https://mail.example.com/*'] };
			const fromWorker = await call('permissions', 'request', [wanted]);
			const withoutGesture = await callPage('permissions', 'request', [wanted]);
			const cookiesBefore = await call('cookies', 'getAll', [{}]);
			// 拡張機能が本文で「利用者の操作の中」と申告しても信じない
			const forged = await callPage('permissions', 'request', [wanted], true);
			// 拡張機能自身のページへの本物の入力（paradisBrowserExtensionWindows.ts の input-event が記録する）
			permissions.noteUserGesture(apiSession, ID);
			const granted = await callPage('permissions', 'request', [wanted]);
			const notInManifest = await callPage('permissions', 'request', [{ permissions: ['history'] }], true);
			const cookiesAfter = await call('cookies', 'getAll', [{}]) as { value: { name: string }[] };
			assert.deepStrictEqual({
				fromWorker, withoutGesture, cookiesBefore, forged, granted, notInManifest,
				prompts: prompts.map(prompt => [prompt.extensionName, prompt.add]),
				cookiesAfter: cookiesAfter.value.map(cookie => cookie.name),
				contains: await call('permissions', 'contains', [wanted]),
				removeRequired: await call('permissions', 'remove', [{ permissions: ['storage'] }]),
			}, {
				fromWorker: { ok: false, error: 'This function must be called during a user gesture' },
				withoutGesture: { ok: false, error: 'This function must be called during a user gesture' },
				cookiesBefore: { ok: false, error: 'This API requires the "cookies" permission' },
				forged: { ok: false, error: 'This function must be called during a user gesture' },
				granted: { ok: true, value: true },
				notInManifest: { ok: false, error: 'Only permissions specified in the manifest may be requested.' },
				prompts: [['Sample', { permissions: ['cookies'], origins: ['https://mail.example.com/*'] }]],
				// サイトの権限のある cookie だけ（other.test は渡さない）
				cookiesAfter: ['sid'],
				contains: { ok: true, value: true },
				removeRequired: { ok: true, value: true },
			});
		} finally {
			dispose();
		}
	}));

	test('a Para Code gesture (button, menu, notification click) counts for five seconds', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { callPage, permissions, apiSession, advance, dispose } = setupServices({ manifest_version: 3, optional_permissions: ['downloads'] });
		try {
			permissions.noteUserGesture(apiSession, ID);
			advance(5_001);
			const late = await callPage('permissions', 'request', [{ permissions: ['downloads'] }]);
			permissions.noteUserGesture(apiSession, ID);
			advance(1_000);
			const inTime = await callPage('permissions', 'request', [{ permissions: ['downloads'] }]);
			assert.deepStrictEqual({ late, inTime }, {
				late: { ok: false, error: 'This function must be called during a user gesture' },
				inTime: { ok: true, value: true },
			});
		} finally {
			dispose();
		}
	}));

	test('captureVisibleTab needs <all_urls> or activeTab, and never captures a tab an agent holds', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, addTabs, call, callPage, tabs, extension, dispose } = setupServices({ manifest_version: 3, permissions: ['activeTab'] });
		try {
			const contents = fakeContents(electronSession, 'https://example.com/', 'Example');
			let moveWhileCapturing = false;
			Object.assign(contents, {
				capturePage: async () => {
					if (moveWhileCapturing) {
						Object.assign(contents, { getURL: () => 'https://bank.example/' });
					}
					return { isEmpty: () => false, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') };
				},
			});
			const view = fakeView('user', contents, 1);
			view.visible = true;
			await addTabs(view);
			const withoutGrant = await call('tabs', 'captureVisibleTab', []);
			tabs.grantActiveTab(extension, contents.id);
			const png = await call('tabs', 'captureVisibleTab', [{ format: 'png' }]);
			const jpeg = await call('tabs', 'captureVisibleTab', [null, { quality: 50 }]);
			// 本文の申告では回数の上限を外せない
			const overQuota = await callPage('tabs', 'captureVisibleTab', [], true);
			paradisSetExtensionPageHold(contents, true);
			await new Promise(resolve => setTimeout(resolve, 1_100));
			const held = await call('tabs', 'captureVisibleTab', []);
			paradisSetExtensionPageHold(contents, false);
			await new Promise(resolve => setTimeout(resolve, 1_100));
			moveWhileCapturing = true;
			const moved = await call('tabs', 'captureVisibleTab', []);
			assert.deepStrictEqual({ withoutGrant, png, jpeg, overQuota, held, moved, badFormat: await call('tabs', 'captureVisibleTab', [{ format: 'gif' }]) }, {
				withoutGrant: { ok: false, error: 'Either the \'<all_urls>\' or \'activeTab\' permission is required.' },
				png: { ok: true, value: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
				jpeg: { ok: true, value: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}` },
				overQuota: { ok: false, error: 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.' },
				held: { ok: false, error: 'Para Code does not let extensions capture a tab that is shared with an agent' },
				// 撮っている間に別のページへ移ったら捨てる
				moved: { ok: false, error: 'The tab changed while it was being captured' },
				badFormat: { ok: false, error: 'Invalid image details' },
			});
		} finally {
			dispose();
		}
	}));

	test('management lists the place and toggles other extensions only, enabling only in a gesture', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const other = 'b'.repeat(32);
		const { call, callPage, enabledChanges, permissions, apiSession, dispose } = setupServices({ manifest_version: 3, permissions: ['management'] }, {
			installed: [
				{ id: ID, name: 'Self', version: '1', source: 'unpacked', enabled: true, permissions: ['management'], hostPermissions: [] },
				{ id: other, name: 'Other', version: '2', source: 'unpacked', enabled: false, permissions: [], hostPermissions: [] },
			],
		});
		try {
			const list = await call('management', 'getAll', []) as { value: { id: string; enabled: boolean; installType: string }[] };
			assert.deepStrictEqual({
				list: list.value.map(entry => [entry.id === ID ? 'self' : 'other', entry.enabled, entry.installType]),
				self: await call('management', 'setEnabled', [ID, false]),
				enableWithoutGesture: await call('management', 'setEnabled', [other, true]),
				// 拡張機能の申告では、利用者が無効にしたほかの拡張機能を有効に戻せない
				forged: await callPage('management', 'setEnabled', [other, true], true),
				enableInGesture: await (async () => {
					permissions.noteUserGesture(apiSession, ID);
					return callPage('management', 'setEnabled', [other, true]);
				})(),
				missing: await call('management', 'get', ['c'.repeat(32)]),
				enabledChanges,
			}, {
				list: [['self', true, 'development'], ['other', false, 'development']],
				self: { ok: false, error: 'An extension cannot enable or disable itself' },
				enableWithoutGesture: { ok: false, error: 'This function must be called during a user gesture' },
				forged: { ok: false, error: 'This function must be called during a user gesture' },
				enableInGesture: { ok: true },
				missing: { ok: false, error: `Failed to find extension with id ${'c'.repeat(32)}.` },
				enabledChanges: [[other, 'default', true]],
			});
		} finally {
			dispose();
		}
	}));

	test('notifications show an OS notification and report clicks', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { call, notifications, openEvents, listen, dispose } = setupServices({ manifest_version: 3, permissions: ['notifications'] });
		try {
			const created = await call('notifications', 'create', ['n1', { type: 'basic', title: 'Hello', message: 'World', iconUrl: 'icon.png' }]);
			const missing = await call('notifications', 'create', [{ type: 'basic', title: 'No message' }]);
			const stream = await openEvents();
			await listen('notifications', 'onClicked');
			notifications[0].listeners.get('click')!();
			const reader = stream.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			const event = paradisDecodeExtensionWire(new TextDecoder().decode(value).trim().split('\n')[0]) as { event: string; args: unknown[] };
			assert.deepStrictEqual({ created, missing, titles: notifications.map(entry => entry.title), event: [event.event, event.args], all: await call('notifications', 'getAll', []) }, {
				created: { ok: true, value: 'n1' },
				missing: { ok: false, error: 'Some of the required properties are missing: type, title and message.' },
				titles: ['Hello'],
				event: ['onClicked', ['n1']],
				all: { ok: true, value: {} },
			});
		} finally {
			dispose();
		}
	}));

	test('counts only real input to the extension\'s own top-level page as a user gesture', () => {
		assert.deepStrictEqual([
			paradisGestureExtensionId(`chrome-extension://${ID}/popup.html`, 'mouseDown'),
			paradisGestureExtensionId(`chrome-extension://${ID}/options.html`, 'rawKeyDown'),
			paradisGestureExtensionId(`chrome-extension://${ID}/popup.html`, 'mouseMove'),
			paradisGestureExtensionId('https://example.com/', 'mouseDown'),
		], [ID, ID, undefined, undefined]);
	});

	test('cookies.onChanged reaches a listener without a get or set first', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { electronSession, apiSession, openEvents, listen, services, cookieEvents, dispose } = setupServices({ manifest_version: 3, permissions: ['cookies'], host_permissions: ['https://mail.example.com/*'] });
		try {
			services.observeCookies(electronSession, apiSession, 'default');
			const stream = await openEvents();
			await listen('cookies', 'onChanged');
			cookieEvents.emit('changed', {}, { name: 'other', value: 'x', domain: 'other.test', path: '/', secure: true }, 'explicit', false);
			cookieEvents.emit('changed', {}, { name: 'sid', value: 'y', domain: 'mail.example.com', path: '/', secure: true }, 'overwrite', true);
			const reader = stream.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			const events = new TextDecoder().decode(value).trim().split('\n').map(line => paradisDecodeExtensionWire(line) as { args: [{ cookie: { name: string }; cause: string; removed: boolean }] });
			assert.deepStrictEqual(events.map(event => [event.args[0].cookie.name, event.args[0].cause, event.args[0].removed]), [['sid', 'overwrite', true]]);
		} finally {
			dispose();
		}
	}));

	test('keeps paths, names and patterns inside what an extension may touch', () => {
		const errorOf = (run: () => unknown) => {
			try {
				return run();
			} catch (error) {
				return (error as Error).message;
			}
		};
		assert.deepStrictEqual({
			icon: paradisNotificationIconPath({ id: ID, path: '/ext/copy' }, 'icons/a.png'),
			iconOutside: paradisNotificationIconPath({ id: ID, path: '/ext/copy' }, '%2E%2E%2Fsecret.png'),
			iconOther: paradisNotificationIconPath({ id: ID, path: '/ext/copy' }, `chrome-extension://${'b'.repeat(32)}/a.png`),
			iconWeb: paradisNotificationIconPath({ id: ID, path: '/ext/copy' }, 'https://evil.test/a.png'),
			names: [paradisDownloadFilename('report.pdf'), paradisDownloadFilename(undefined), errorOf(() => paradisDownloadFilename('../x')), errorOf(() => paradisDownloadFilename('/etc/passwd')), errorOf(() => paradisDownloadFilename('C:\\x'))],
			covers: [paradisOriginPatternCovers('https://*.example.com/*', 'https://mail.example.com/*'), paradisOriginPatternCovers('https://mail.example.com/*', 'https://*.example.com/*'), paradisOriginPatternCovers('<all_urls>', 'https://x.test/*')],
			headers: [paradisDownloadHeaders([{ name: 'X-Token', value: 'a' }]), errorOf(() => paradisDownloadHeaders([{ name: 'Cookie', value: 'a=b' }])), errorOf(() => paradisDownloadHeaders([{ name: 'Sec-Fetch-Site', value: 'none' }])), errorOf(() => paradisDownloadHeaders([{ name: 'Proxy-Authorization', value: 'x' }])), errorOf(() => paradisDownloadHeaders([{ name: 'X', value: 'a\r\nb' }]))],
			folder: paradisExtensionDownloadsFolder('/home/me/Downloads/Paracode'),
			plan: paradisPlanPermissionRequest({ permissions: ['tabs'], optional_permissions: ['cookies'] }, { permissions: [], origins: [] }, { permissions: ['tabs'] }),
		}, {
			icon: '/ext/copy/icons/a.png',
			iconOutside: undefined,
			iconOther: undefined,
			iconWeb: undefined,
			names: ['report.pdf', undefined, 'Invalid filename', 'Invalid filename', 'Invalid filename'],
			covers: [true, false, true],
			headers: [{ 'X-Token': 'a' }, 'Unsafe request header name: Cookie', 'Unsafe request header name: Sec-Fetch-Site', 'Unsafe request header name: Proxy-Authorization', 'Invalid headers'],
			// read_download が読む自動保存のフォルダの外（隣）
			folder: '/home/me/Downloads/Paracode (extensions)',
			plan: { kind: 'already-granted' },
		});
	});
});

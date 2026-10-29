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
import { IParadisTabEnvironment, IParadisTabView, ParadisBrowserExtensionTabs, paradisCanSeeTabUrl, paradisMatchesUrlPattern } from '../../electron-main/paradisBrowserExtensionTabs.js';
import { IParadisActionsEnvironment, ParadisBrowserExtensionActions } from '../../electron-main/paradisBrowserExtensionActions.js';
import { ParadisBrowserExtensionMenus } from '../../electron-main/paradisBrowserExtensionMenus.js';
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
	return { electronSession, otherSession, views, created, activated, call, openEvents, listen, dispose, host, addTabs, focus, tabs, apiSession, extension };
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
		try {
			const registered = (host as unknown as { _namespaces: Map<string, { methods: Record<string, unknown>; events: readonly string[]; permission?: unknown }> })._namespaces;
			for (const [name, surface] of Object.entries(PARADIS_SHIM_SURFACE)) {
				const namespace = registered.get(name);
				assert.ok(namespace, name);
				assert.deepStrictEqual({ methods: [...surface.methods].sort(), events: [...surface.events].sort(), permission: surface.permission }, { methods: Object.keys(namespace.methods).sort(), events: [...namespace.events].sort(), permission: namespace.permission }, name);
			}
		} finally {
			menus.dispose();
			actions.dispose();
			tabs.dispose();
			host.dispose();
		}
	});
});

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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { PARADIS_EXTENSION_API_CALL_URL, PARADIS_EXTENSION_API_EVENTS_URL, paradisDecodeExtensionWire, paradisEncodeExtensionWire, paradisExtensionApiUrl } from '../../common/paradisBrowserExtensionApiWire.js';
import { PARADIS_SHIM_SURFACE } from '../../common/paradisBrowserExtensionShim.js';
import { IParadisApiExtension, ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { paradisRegisterRuntimeApis } from '../../electron-main/paradisBrowserExtensionRuntime.js';
import { paradisRegisterStorageApis, ParadisBrowserExtensionSyncStore } from '../../electron-main/paradisBrowserExtensionStorageApis.js';
import { IParadisTabEnvironment, IParadisTabView, ParadisBrowserExtensionTabs, paradisCanSeeTabUrl, paradisMatchesUrlPattern } from '../../electron-main/paradisBrowserExtensionTabs.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const silentLog = { warn: () => { } };

let nextContentsId = 100;

/** タブの中身の偽物。 */
function fakeContents(session: object, url: string, title: string): WebContents {
	const id = nextContentsId++;
	return {
		id, session,
		getURL: () => url,
		getTitle: () => title,
		isLoading: () => false,
		isCurrentlyAudible: () => false,
		isAudioMuted: () => false,
		isDestroyed: () => false,
		on: () => undefined,
		off: () => undefined,
		mainFrame: { framesInSubtree: [] },
		loadURL: async () => { },
	} as unknown as WebContents;
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
	return { electronSession, otherSession, views, created, activated, call, openEvents, listen, dispose, host, addTabs, focus };
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
		try {
			const registered = (host as unknown as { _namespaces: Map<string, { methods: Record<string, unknown>; events: readonly string[]; permission?: unknown }> })._namespaces;
			for (const [name, surface] of Object.entries(PARADIS_SHIM_SURFACE)) {
				const namespace = registered.get(name);
				assert.ok(namespace, name);
				assert.deepStrictEqual({ methods: [...surface.methods].sort(), events: [...surface.events].sort(), permission: surface.permission }, { methods: Object.keys(namespace.methods).sort(), events: [...namespace.events].sort(), permission: namespace.permission }, name);
			}
		} finally {
			tabs.dispose();
			host.dispose();
		}
	});
});

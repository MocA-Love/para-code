/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAllowsDisplayCapture } from '../../../../../platform/browserView/common/paradisDisplayCaptureGate.js';
import { paradisSetExtensionPageHold } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisShimBridge, PARADIS_CAPTURE_STREAM_ID_PREFIX, PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, paradisInstallCapture } from '../../common/paradisBrowserExtensionShim.js';
import { IParadisExtensionApiCaller, IParadisExtensionApiNamespace, ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { IParadisCaptureEnvironment, ParadisBrowserExtensionCapture } from '../../electron-main/paradisBrowserExtensionCapture.js';
import type { IParadisCaptureTab, IParadisTabView, ParadisBrowserExtensionTabs } from '../../electron-main/paradisBrowserExtensionTabs.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';

async function outcome(run: () => unknown): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionCapture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(platform = 'darwin', picks: (number | undefined)[] = []) {
		const namespaces = new Map<string, IParadisExtensionApiNamespace>();
		const emitted: unknown[][] = [];
		const host = {
			registerNamespace: (name: string, namespace: IParadisExtensionApiNamespace) => namespaces.set(name, namespace),
			onDidCloseContext: () => ({ dispose: () => { } }),
			emit: (_target: unknown, namespace: string, event: string, args: unknown[]) => emitted.push([namespace, event, ...args]),
		} as unknown as ParadisExtensionApiHost;
		const session = { storagePath: '/tmp/profile' } as unknown as ParadisApiSession;
		const makeTab = (id: number, active: boolean, agent = false) => {
			const listeners = new Set<() => void>();
			const contents = {
				id, mainFrame: { name: `frame-${id}` }, isDestroyed: () => false, getURL: () => `https://site${id}.example/`,
				once: (_event: string, listener: () => void) => listeners.add(listener), removeListener: (_event: string, listener: () => void) => listeners.delete(listener),
			};
			const view = { id: `view-${id}`, windowId: 1, webContents: contents, isAgentTab: () => agent } as unknown as IParadisTabView;
			return { tabId: id, windowId: 1, active, title: `Site ${id}`, view } satisfies IParadisCaptureTab;
		};
		const tab1 = makeTab(11, true);
		const tab2 = makeTab(12, false);
		const tabs = [tab1, tab2];
		const grants = new Set<number>([11]);
		const onDidBecomeAgentTab = new Emitter<object>();
		const tabsApi = {
			captureTabsFor: () => tabs.filter(tab => !tab.view.isAgentTab()),
			hasTabCaptureGrant: (_extensionId: string, tabId: number) => grants.has(tabId),
			currentWindowIdFor: () => 1,
			viewOfContents: (contents: object) => tabs.find(tab => tab.view.webContents === contents)?.view,
			onDidBecomeAgentTab: onDidBecomeAgentTab.event,
		} as unknown as ParadisBrowserExtensionTabs;
		const prompts: unknown[] = [];
		let now = 1_000;
		const environment: IParadisCaptureEnvironment = {
			platform,
			getWindowSources: async () => [{ id: 'window:100:0', name: 'Para Code' }, { id: 'window:200:0', name: 'Slides' }, { id: 'screen:1:0', name: 'Entire screen' }],
			ownWindowSourceIds: () => ['window:100:0'],
			screenAccess: () => 'granted',
			pick: async prompt => {
				prompts.push({ choices: prompt.choices.map(choice => choice.label), note: prompt.note });
				return picks.shift();
			},
			nameOf: () => 'Recorder',
			now: () => now,
		};
		const capture = new ParadisBrowserExtensionCapture(host, tabsApi, environment);
		const caller = (extensionId = ID, fromWorker = false): IParadisExtensionApiCaller => ({ extension: { id: extensionId, version: '1', manifest: { permissions: ['desktopCapture', 'tabCapture'] } }, session, place: 'default', connection: 'page-1', fromWorker });
		const call = (namespace: string, method: string, args: unknown[], from = caller()) => namespaces.get(namespace)!.methods[method].invoke(from, args);
		const frame = (url: string) => ({ url });
		const request = (url = `chrome-extension://${ID}/recorder.html`, audioRequested = false) => ({ frame: frame(url), videoRequested: true, audioRequested });
		return {
			capture, session, call, caller, request, emitted, prompts, tab1, tab2, grants, onDidBecomeAgentTab,
			advance: (ms: number) => { now += ms; },
			dispose: () => { capture.dispose(); onDidBecomeAgentTab.dispose(); },
		};
	}

	test('chooseDesktopMedia offers allowed tabs and other apps\' windows, never Para Code or the whole screen, and the stream id works once for that extension\'s page only', async () => {
		const { capture, session, call, caller, request, prompts, tab1, dispose } = setup('darwin', [0, 0]);
		try {
			const tab = await call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [1, ['screen', 'window', 'tab', 'audio'], undefined]) as { streamId: string; options: unknown };
			const notArmed = capture.resolveDisplayMedia(session, request());
			const page = `chrome-extension://${ID}/recorder.html`;
			const gateBefore = paradisAllowsDisplayCapture('media', page, []);
			const armedByOther = call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'arm', [tab.streamId], caller(OTHER));
			const armed = call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'arm', [tab.streamId]);
			// 内蔵ブラウザのセッションの権限に通すのは、構えた拡張機能のページの画面の取得だけ（カメラ・ほかのページは通さない）
			const gate = { display: paradisAllowsDisplayCapture('media', page, []), camera: paradisAllowsDisplayCapture('media', page, ['video']), web: paradisAllowsDisplayCapture('media', 'https://evil.example/', []), other: paradisAllowsDisplayCapture('media', `chrome-extension://${OTHER}/page.html`, []) };
			const fromWebPage = capture.resolveDisplayMedia(session, request('https://evil.example/'));
			const fromOtherExtension = capture.resolveDisplayMedia(session, request(`chrome-extension://${OTHER}/page.html`));
			const streams = capture.resolveDisplayMedia(session, request(undefined, true));
			const again = capture.resolveDisplayMedia(session, request());
			const window = await call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [2, ['window'], undefined]) as { streamId: string };
			call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'arm', [window.streamId]);
			const windowStreams = capture.resolveDisplayMedia(session, request(undefined, true));
			assert.deepStrictEqual({
				prefixed: tab.streamId.startsWith(PARADIS_CAPTURE_STREAM_ID_PREFIX), options: tab.options, prompts, notArmed, gateBefore, gate, armedByOther, armed, fromWebPage, fromOtherExtension,
				streams: { video: streams.video === tab1.view.webContents.mainFrame, audio: streams.audio === tab1.view.webContents.mainFrame, enableLocalEcho: streams.enableLocalEcho },
				again, windowStreams,
			}, {
				prefixed: true,
				options: { canRequestAudioTrack: true },
				prompts: [
					{ choices: ['タブ: Site 11', 'タブ: Site 12', '窓: Slides'], note: undefined },
					{ choices: ['窓: Slides'], note: undefined },
				],
				notArmed: {}, gateBefore: false, gate: { display: true, camera: false, web: false, other: false }, armedByOther: false, armed: true, fromWebPage: {}, fromOtherExtension: {},
				streams: { video: true, audio: true, enableLocalEcho: true },
				again: {},
				// 窓の音は撮らない
				windowStreams: { video: { id: 'window:200:0', name: 'Slides' } },
			});
		} finally {
			dispose();
		}
	});

	test('offers no windows where the OS does not confirm screen recording, and refuses what Chrome refuses', async () => {
		const { call, caller, prompts, dispose } = setup('linux', [undefined]);
		try {
			const cancelled = await call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [1, ['screen', 'window'], undefined]);
			assert.deepStrictEqual({
				cancelled,
				prompts,
				badSource: await outcome(() => call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [2, ['camera'], undefined])),
				fromWorker: await outcome(() => call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [3, ['tab'], undefined], caller(ID, true))),
				targetTab: await outcome(() => call(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'choose', [4, ['tab'], { id: 11, url: 'https://site11.example/' }])),
			}, {
				cancelled: { streamId: '', options: { canRequestAudioTrack: false } },
				prompts: [{ choices: [], note: 'この OS では、ほかのアプリの窓と画面全体は撮れません（Para Code の画面が写るのを防ぐため）。' }],
				badSource: 'Invalid source type specified.',
				fromWorker: 'A target tab is required when called from a service worker context.',
				targetTab: 'Para Code does not support targetTab for desktopCapture.chooseDesktopMedia; call it from an extension page',
			});
		} finally {
			dispose();
		}
	});

	test('tabCapture needs the toolbar button on that tab, refuses a tab already captured, and stops when the tab is shared with an agent', async () => {
		const { capture, session, call, request, emitted, tab1, tab2, dispose } = setup();
		try {
			const notInvoked = await outcome(() => call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [{ targetTabId: tab2.tabId }]));
			const unknownTab = await outcome(() => call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [{ targetTabId: 99 }]));
			const nothing = await outcome(() => call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'capture', [{ audio: false, video: false }]));
			const id = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [undefined]) as string;
			call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'arm', [id]);
			const streams = capture.resolveDisplayMedia(session, request());
			const captured = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getCapturedTabs', []);
			const sameTab = await outcome(() => call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [{ targetTabId: tab1.tabId }]));
			paradisSetExtensionPageHold(tab1.view.webContents, true);
			paradisSetExtensionPageHold(tab1.view.webContents, false);
			const afterShare = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getCapturedTabs', []);
			assert.deepStrictEqual({ notInvoked, unknownTab, nothing, video: streams.video === tab1.view.webContents.mainFrame, captured, sameTab, afterShare, emitted }, {
				notInvoked: 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.',
				unknownTab: 'Invalid tab specified.',
				nothing: 'Capture failed. No audio or video requested.',
				video: true,
				captured: [{ tabId: 11, status: 'active', fullscreen: false }],
				sameTab: 'Cannot capture a tab with an active stream.',
				afterShare: [],
				emitted: [
					[PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'onStatusChanged', { tabId: 11, status: 'active', fullscreen: false }],
					[PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'onStop', id],
					[PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'onStatusChanged', { tabId: 11, status: 'stopped', fullscreen: false }],
				],
			});
		} finally {
			dispose();
		}
	});

	test('a stream id expires, a worker cannot use it, and a tab that became an agent\'s is not captured', async () => {
		const { capture, session, call, caller, request, advance, tab1, onDidBecomeAgentTab, emitted, dispose } = setup();
		try {
			const late = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [undefined]) as string;
			advance(31_000);
			const expired = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'arm', [late]);
			const id = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [undefined]) as string;
			const fromWorker = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'arm', [id], caller(ID, true));
			call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'arm', [id]);
			advance(6_000);
			const armExpired = capture.resolveDisplayMedia(session, request());
			const next = call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'getMediaStreamId', [undefined]) as string;
			call(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'arm', [next]);
			capture.resolveDisplayMedia(session, request());
			onDidBecomeAgentTab.fire(tab1.view.webContents);
			assert.deepStrictEqual({ expired, fromWorker, armExpired, events: emitted.map(entry => entry[1]) }, {
				expired: false, fromWorker: false, armExpired: {},
				events: ['onStatusChanged', 'onStop', 'onStatusChanged'],
			});
		} finally {
			dispose();
		}
	});

	test('the shim turns a getUserMedia with a Para Code stream id into an armed getDisplayMedia, and passes other calls through', async () => {
		const calls: unknown[][] = [];
		let handler: ((namespace: string, event: string, args: unknown[]) => void) | undefined;
		const bridge: IParadisShimBridge = {
			call: async (namespace, method, args) => {
				calls.push([`${namespace}.${method}`, ...args]);
				if (method === 'choose') {
					return { ok: true, value: { streamId: `${PARADIS_CAPTURE_STREAM_ID_PREFIX}one`, options: { canRequestAudioTrack: false } } };
				}
				return { ok: true, value: method === 'arm' ? true : undefined };
			},
			listen: () => { },
			onEvent: next => { handler = next; },
		};
		const ended: string[] = [];
		const makeTrack = (kind: string) => {
			const listeners: (() => void)[] = [];
			const track = {
				kind, readyState: 'live',
				stop: () => { track.readyState = 'ended'; },
				addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
				dispatchEvent: () => { ended.push(kind); listeners.forEach(listener => listener()); return true; },
			};
			return track;
		};
		const display: unknown[] = [];
		const user: unknown[] = [];
		const mediaDevices = {
			getDisplayMedia: async (constraints: unknown) => {
				display.push(constraints);
				const tracks = [makeTrack('video')];
				return { getTracks: () => tracks, getVideoTracks: () => tracks.filter(track => track.kind === 'video'), removeTrack: () => { } };
			},
			getUserMedia: async (constraints: unknown) => {
				user.push(constraints);
				return 'camera';
			},
		};
		const page = { chrome: { runtime: { getManifest: () => ({ permissions: ['desktopCapture'] }) } } as Record<string, unknown>, navigator: { mediaDevices } };
		new Function('globalThis', 'bridge', 'desktop', 'tab', 'prefix', `(${paradisInstallCapture.toString()})(bridge, desktop, tab, prefix);`)(page, bridge, PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, PARADIS_CAPTURE_STREAM_ID_PREFIX);
		const desktop = page.chrome.desktopCapture as Record<string, (...args: unknown[]) => unknown>;
		const streamId = await new Promise<string>(resolve => desktop.chooseDesktopMedia(['window'], (id: string) => resolve(id)));
		const stream = await mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } } }) as unknown as { getTracks(): { readyState: string }[] };
		const camera = await mediaDevices.getUserMedia({ video: true });
		handler?.(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, 'onStop', [streamId]);
		await Promise.resolve();
		assert.deepStrictEqual({ calls, display, user, camera, ended, state: stream.getTracks()[0].readyState, tabCapture: page.chrome.tabCapture }, {
			calls: [
				[`${PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE}.choose`, 1, ['window'], undefined],
				[`${PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE}.arm`, `${PARADIS_CAPTURE_STREAM_ID_PREFIX}one`],
			],
			display: [{ video: true, audio: false }],
			user: [{ video: true }],
			camera: 'camera',
			// main が止めたら、Chrome と同じく ended が届く
			ended: ['video'],
			state: 'ended',
			// manifest に無いものは足さない
			tabCapture: undefined,
		});
	});
});

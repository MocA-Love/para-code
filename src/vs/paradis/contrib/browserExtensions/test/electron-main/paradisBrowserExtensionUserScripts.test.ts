/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { WebContents } from 'electron';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSetExtensionPageHold } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisShimBridge, PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, paradisInstallUserScripts } from '../../common/paradisBrowserExtensionShim.js';
import {
	IParadisRegisteredUserScript,
	ParadisUserScriptsError,
	paradisConfigureUserScriptWorld,
	paradisEffectiveUserScriptWorld,
	paradisIsUserScriptTargetUrl,
	paradisMatchesUserScriptGlob,
	paradisParseUserScriptRegistrations,
	paradisRegisterUserScripts,
	paradisUpdateUserScripts,
	paradisUserScriptApplies,
} from '../../common/paradisBrowserExtensionUserScripts.js';
import { IParadisExtensionApiCaller, IParadisExtensionApiNamespace, ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { paradisMatchesUrlPattern } from '../../electron-main/paradisBrowserExtensionTabs.js';
import { IParadisUserScriptsEnvironment, ParadisBrowserExtensionUserScripts } from '../../electron-main/paradisBrowserExtensionUserScripts.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';

function outcome(run: () => unknown): unknown {
	try {
		return run();
	} catch (error) {
		return error instanceof ParadisUserScriptsError || error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionUserScripts rules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers, updates and refuses like Chromium', () => {
		const one = paradisRegisterUserScripts([], [{ id: 'a', matches: ['https://*.example.com/*'], js: [{ code: 'x' }] }]);
		assert.deepStrictEqual({
			defaults: one,
			duplicate: outcome(() => paradisRegisterUserScripts(one, [{ id: 'a', matches: ['<all_urls>'], js: [{ code: 'y' }] }])),
			duplicateInCall: outcome(() => paradisRegisterUserScripts([], [{ id: 'b', matches: ['<all_urls>'], js: [{ code: 'y' }] }, { id: 'b', matches: ['<all_urls>'], js: [{ code: 'y' }] }])),
			underscore: outcome(() => paradisRegisterUserScripts([], [{ id: '_a', matches: ['<all_urls>'], js: [{ code: 'y' }] }])),
			noMatches: outcome(() => paradisRegisterUserScripts([], [{ id: 'c', matches: [], js: [{ code: 'y' }] }])),
			noJs: outcome(() => paradisRegisterUserScripts([], [{ id: 'c', matches: ['<all_urls>'], js: [] }])),
			bothSources: outcome(() => paradisRegisterUserScripts([], [{ id: 'c', matches: ['<all_urls>'], js: [{ code: 'y', file: 'z.js' }] }])),
			badPattern: outcome(() => paradisRegisterUserScripts([], [{ id: 'c', matches: ['example.com'], js: [{ code: 'y' }] }])),
			mainWithWorldId: outcome(() => paradisRegisterUserScripts([], [{ id: 'c', matches: ['<all_urls>'], js: [{ code: 'y' }], world: 'MAIN', worldId: 'w' }])),
			update: paradisUpdateUserScripts(one, [{ id: 'a', runAt: 'document_start', allFrames: true }]),
			updateMissing: outcome(() => paradisUpdateUserScripts(one, [{ id: 'nope', runAt: 'document_start' }])),
			updateToMain: outcome(() => paradisUpdateUserScripts(paradisRegisterUserScripts([], [{ id: 'w', matches: ['<all_urls>'], js: [{ code: 'y' }], worldId: 'w1' }]), [{ id: 'w', world: 'MAIN' }])),
		}, {
			defaults: [{ id: 'a', matches: ['https://*.example.com/*'], js: [{ code: 'x' }], runAt: 'document_idle', allFrames: false, world: 'USER_SCRIPT' }],
			duplicate: 'Duplicate script ID \'a\'',
			duplicateInCall: 'Duplicate script ID \'b\'',
			underscore: 'Script\'s ID \'_a\' must not start with \'_\'',
			noMatches: 'Script with ID \'c\' must specify at least one match.',
			noJs: 'Script with ID \'c\' must specify at least one js source.',
			bothSources: 'User script with ID \'c\' must specify exactly one of \'code\' or \'file\' as a js source.',
			badPattern: 'Script with ID \'c\' has invalid value for matches[0]: Invalid scheme or missing path.',
			mainWithWorldId: 'Script with ID \'c\': worldId can only be used with the USER_SCRIPT world.',
			update: [{ id: 'a', matches: ['https://*.example.com/*'], js: [{ code: 'x' }], runAt: 'document_start', allFrames: true, world: 'USER_SCRIPT' }],
			updateMissing: 'Script with ID \'nope\' does not exist or is not fully registered',
			updateToMain: 'Script with ID \'w\': worldId can only be used with the USER_SCRIPT world.',
		});
	});

	test('matches URLs with match patterns, globs and frames, and never targets non-web pages or the store', () => {
		const [script] = paradisRegisterUserScripts([], [{ id: 'a', matches: ['*://*.example.com/*'], excludeMatches: ['https://admin.example.com/*'], includeGlobs: ['*/docs/*'], excludeGlobs: ['*?private=*'], js: [{ code: 'x' }] }]);
		const applies = (url: string, top = true, target: IParadisRegisteredUserScript = script) => paradisUserScriptApplies(target, url, top, paradisMatchesUrlPattern);
		const worlds = paradisConfigureUserScriptWorld(paradisConfigureUserScriptWorld([], { messaging: true, csp: 'script-src \'unsafe-eval\'' }), { worldId: 'w1', messaging: false });
		assert.deepStrictEqual({
			docs: applies('https://www.example.com/docs/a'),
			notDocs: applies('https://www.example.com/blog/a'),
			excludedHost: applies('https://admin.example.com/docs/a'),
			excludedGlob: applies('https://www.example.com/docs/a?private=1'),
			iframe: applies('https://www.example.com/docs/a', false),
			glob: [paradisMatchesUserScriptGlob('https://a?c/*', 'https://abc/x'), paradisMatchesUserScriptGlob('https://a?c/*', 'https://abbc/x')],
			targets: ['https://example.com/', 'http://127.0.0.1/', 'chrome-extension://abc/page.html', 'file:///etc/passwd', 'data:text/html,x', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x', 'https://chrome.google.com/search', 'https://chromewebstore.google.com./detail/x', 'https://CHROMEWEBSTORE.google.com/', 'https://chrome.google.com../webstore'].map(paradisIsUserScriptTargetUrl),
			defaultWorld: paradisEffectiveUserScriptWorld(worlds, undefined),
			namedWorld: paradisEffectiveUserScriptWorld(worlds, 'w1'),
			unconfiguredNamedWorld: paradisEffectiveUserScriptWorld(worlds, 'w2'),
			nothingConfigured: paradisEffectiveUserScriptWorld([], undefined),
			corrupted: paradisParseUserScriptRegistrations({ scripts: [{ id: '_bad' }], worlds: [{ worldId: '_x' }, { messaging: true }] }),
		}, {
			docs: true,
			notDocs: false,
			excludedHost: false,
			excludedGlob: false,
			iframe: false,
			glob: [true, false],
			targets: [true, true, false, false, false, false, false, true, false, false, false],
			defaultWorld: { csp: 'script-src \'unsafe-eval\'', messaging: true },
			namedWorld: { csp: 'script-src \'self\' \'wasm-unsafe-eval\'; object-src \'self\';', messaging: false },
			unconfiguredNamedWorld: { csp: 'script-src \'unsafe-eval\'', messaging: true },
			nothingConfigured: { csp: 'script-src \'self\' \'wasm-unsafe-eval\'; object-src \'self\';', messaging: false },
			corrupted: { scripts: [], worlds: [{ messaging: true }] },
		});
	});
});

interface IFakeFrame {
	url: string;
	parent: IFakeFrame | null;
	frameTreeNodeId: number;
	processId: number;
	routingId: number;
}

suite('ParadisBrowserExtensionUserScripts main', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-user-scripts-'));
		const extensionPath = join(root, 'ext');
		await fs.mkdir(extensionPath, { recursive: true });
		await fs.writeFile(join(extensionPath, 'inject.js'), 'fileCode();');
		await fs.writeFile(join(root, 'secret.js'), 'secret();');
		const namespaces = new Map<string, IParadisExtensionApiNamespace>();
		const emitted: unknown[][] = [];
		const closeListeners: ((session: ParadisApiSession, extensionId: string, connection: string | undefined) => void)[] = [];
		const host = {
			registerNamespace: (name: string, namespace: IParadisExtensionApiNamespace) => namespaces.set(name, namespace),
			onDidCloseContext: (listener: (session: ParadisApiSession, extensionId: string, connection: string | undefined) => void) => { closeListeners.push(listener); return { dispose: () => { } }; },
			emitToWorkerWhenListening: (_session: unknown, extensionId: string, _namespace: string, event: string, args: unknown[]) => emitted.push([extensionId, event, ...args]),
			emitToPlace: (place: string, extensionId: string, _namespace: string, event: string, args: unknown[]) => emitted.push([place, extensionId, event, ...args]),
		} as unknown as ParadisExtensionApiHost;
		const manifest = { manifest_version: 3, permissions: ['userScripts'] };
		const loaded = new Map([[ID, { id: ID, version: '1', manifest, name: 'Scripts', path: extensionPath }], [OTHER, { id: OTHER, version: '1', manifest: { manifest_version: 3 }, name: 'No permission', path: extensionPath }]]);
		const session = { storagePath: '/tmp/profile', extensions: { getExtension: (id: string) => loaded.get(id) ?? null } } as unknown as ParadisApiSession;
		const state = { userTab: true, enabled: true };
		const environment: IParadisUserScriptsEnvironment = {
			placeOfSession: value => value === session ? 'default' : undefined,
			isUserTab: () => state.userTab,
			isEnabledIn: () => state.enabled,
			hasPermission: (_place, extension) => Array.isArray(extension.manifest.permissions) && extension.manifest.permissions.includes('userScripts'),
			describeTab: () => ({ id: 7 }),
		};
		const userScripts = new ParadisBrowserExtensionUserScripts(host, join(root, 'user-scripts.json'), { warn: () => { } }, environment);
		const contents = { session, id: 7, isDestroyed: () => false } as unknown as WebContents;
		const top: IFakeFrame = { url: 'https://site.example/page', parent: null, frameTreeNodeId: 1, processId: 3, routingId: 10 };
		const caller = (extensionId = ID): IParadisExtensionApiCaller => ({ extension: loaded.get(extensionId)!, session, place: 'default', connection: 'worker', fromWorker: true });
		const call = (method: string, ...args: unknown[]) => namespaces.get(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE)!.methods[method].invoke(caller(), args);
		const answer = (frame: IFakeFrame = top) => userScripts.answer(contents, frame as never);
		return { root, userScripts, contents, top, call, answer, emitted, state, namespaces, caller, closeListeners, session };
	}

	test('injects only for extensions the person allowed, into user tabs that are not shared, from files inside the extension', async () => {
		const { root, userScripts, contents, top, call, answer, state, namespaces } = await setup();
		try {
			const notAllowed = await Promise.resolve().then(() => call('getScripts')).then(() => 'ok', (error: Error) => error.message);
			await userScripts.setAllowed('default', ID, true);
			await call('configureWorld', { messaging: true, csp: 'script-src \'unsafe-eval\'' });
			await call('register', [
				{ id: 'start', matches: ['https://site.example/*'], runAt: 'document_start', js: [{ code: 'startCode();' }, { file: 'inject.js' }, { file: '../secret.js' }] },
				{ id: 'main', matches: ['https://site.example/*'], world: 'MAIN', runAt: 'document_end', js: [{ code: 'mainCode();' }] },
				{ id: 'frames', matches: ['https://frame.example/*'], allFrames: true, worldId: 'w', js: [{ code: 'frameCode();' }] },
			]);
			const allowed = answer() as { worlds: { world: number }[]; scripts: { world: unknown; code: string; runAt: string }[] };
			const childFrame = answer({ url: 'https://frame.example/x', parent: top, frameTreeNodeId: 2, processId: 3, routingId: 11 }) as { worlds: { world: number; worldId?: string; messaging: boolean }[] };
			const otherOrigin = answer({ ...top, url: 'https://frame.example/x' }) as { worlds: { world: number }[] };
			paradisSetExtensionPageHold(contents, true);
			const held = answer();
			paradisSetExtensionPageHold(contents, false);
			state.userTab = false;
			const agentOrUnannounced = answer();
			state.userTab = true;
			state.enabled = false;
			const disabled = answer();
			state.enabled = true;
			const store = answer({ ...top, url: 'https://chromewebstore.google.com/detail/x' });
			// 権限の無い拡張機能は、許可しても呼べない（main の登録の権限）
			const permission = namespaces.get(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE)!.permission;
			await userScripts.setAllowed('default', ID, false);
			const afterDisallow = answer();
			assert.deepStrictEqual({
				notAllowed,
				scripts: allowed.scripts.map(script => [script.runAt, script.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT', script.code]),
				oneWorld: allowed.worlds.length,
				childFrameWorlds: childFrame.worlds.map(world => [world.worldId, world.messaging]),
				worldPerOrigin: otherOrigin.worlds[0].world !== allowed.worlds[0].world,
				held, agentOrUnannounced, disabled, store, permission, afterDisallow,
				state: await call('state'),
			}, {
				notAllowed: 'The userScripts API is only available when "Allow User Scripts" is turned on for this extension in Para Code.',
				scripts: [['document_start', 'USER_SCRIPT', 'startCode();'], ['document_start', 'USER_SCRIPT', 'fileCode();'], ['document_end', 'MAIN', 'mainCode();']],
				oneWorld: 1,
				childFrameWorlds: [['w', true]],
				worldPerOrigin: true,
				held: undefined, agentOrUnannounced: undefined, disabled: undefined, store: undefined, permission: 'userScripts', afterDisallow: undefined,
				state: { allowed: false },
			});
		} finally {
			userScripts.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('reloads a tab it injected into when the tab turns out to be an agent tab, and leaves other tabs alone', async () => {
		const { root, userScripts, contents, call, answer } = await setup();
		try {
			let reloads = 0;
			(contents as unknown as { reload(): void }).reload = () => { reloads++; };
			const other = { session: (contents as unknown as { session: unknown }).session, id: 8, isDestroyed: () => false, reload: () => { reloads += 100; } } as unknown as WebContents;
			await userScripts.setAllowed('default', ID, true);
			await call('register', [{ id: 'a', matches: ['https://site.example/*'], js: [{ code: 'x' }] }]);
			answer();
			userScripts.noteAgentTab(other);
			userScripts.noteAgentTab(contents);
			userScripts.noteAgentTab(contents);
			assert.strictEqual(reloads, 1);
		} finally {
			userScripts.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('relays messages and ports only from a world that may message, and keeps registrations across restarts', async () => {
		const { root, userScripts, contents, top, call, answer, emitted, namespaces, caller, closeListeners, session } = await setup();
		try {
			await userScripts.setAllowed('default', ID, true);
			await call('configureWorld', { messaging: true });
			await call('register', [{ id: 'a', matches: ['https://site.example/*'], js: [{ code: 'x' }] }, { id: 'quiet', matches: ['https://quiet.example/*'], worldId: 'q', js: [{ code: 'y' }] }]);
			await call('configureWorld', { worldId: 'q', messaging: false });
			const world = (answer() as { worlds: { world: number }[] }).worlds[0].world;
			emitted.length = 0;
			const reply = userScripts.handleCall(contents, top as never, { op: 'sendMessage', world, extensionId: ID, message: { hi: 1 } });
			const [, , kind, requestId, message, sender] = emitted[0] as [string, string, string, string, unknown, unknown];
			// 別の拡張機能の返事は受けない
			namespaces.get(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE)!.methods.respond.invoke(caller(OTHER), [requestId, { value: 'forged' }]);
			namespaces.get(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE)!.methods.respond.invoke(caller(), [requestId, { value: { ok: true } }]);
			const wrongWorld = await userScripts.handleCall(contents, top as never, { op: 'sendMessage', world: world + 1000, extensionId: ID, message: 1 });
			const forgedExtension = await userScripts.handleCall(contents, top as never, { op: 'sendMessage', world, extensionId: OTHER, message: 1 });
			const quietWorld = (answer({ ...top, url: 'https://quiet.example/' }) as { worlds: { world: number; messaging: boolean }[] }).worlds[0];
			const quiet = await userScripts.handleCall(contents, { ...top, url: 'https://quiet.example/' } as never, { op: 'sendMessage', world: quietWorld.world, worldId: 'q', extensionId: ID, message: 1 });
			paradisSetExtensionPageHold(contents, true);
			const whileShared = await userScripts.handleCall(contents, top as never, { op: 'sendMessage', world, extensionId: ID, message: 1 });
			paradisSetExtensionPageHold(contents, false);
			emitted.length = 0;
			await userScripts.handleCall(contents, top as never, { op: 'connect', world, extensionId: ID, portId: 'p1', name: 'n' });
			await userScripts.handleCall(contents, top as never, { op: 'postMessage', world, extensionId: ID, portId: 'p1', message: { ping: 1 } });
			await userScripts.handleCall(contents, { ...top, routingId: 99 } as never, { op: 'postMessage', world, extensionId: ID, portId: 'p1', message: 'other frame' });
			// worker が止まった: ポートを切る
			for (const listener of closeListeners) {
				listener(session, ID, 'worker');
			}
			const portEvents = emitted.map(entry => entry.slice(1, 4));
			const restarted = new ParadisBrowserExtensionUserScripts({ registerNamespace: () => { }, onDidCloseContext: () => ({ dispose: () => { } }) } as unknown as ParadisExtensionApiHost, join(root, 'user-scripts.json'), { warn: () => { } }, { placeOfSession: () => 'default', isUserTab: () => true, isEnabledIn: () => true, hasPermission: () => true, describeTab: () => undefined });
			await restarted.load();
			assert.deepStrictEqual({
				kind, message, sender,
				reply: await reply,
				wrongWorld, forgedExtension, quietMessaging: quietWorld.messaging, quiet, whileShared,
				portEvents,
				restarted: { allowed: restarted.isAllowed('default', ID), scripts: (restarted.answer(contents, top as never) as { scripts: unknown[] }).scripts.length },
			}, {
				kind: 'message', message: { hi: 1 }, sender: { id: ID, url: 'https://site.example/page', origin: 'https://site.example', frameId: 0, tab: { id: 7 } },
				reply: { value: { ok: true } },
				wrongWorld: { error: 'Could not establish connection. Receiving end does not exist.' },
				forgedExtension: { error: 'Could not establish connection. Receiving end does not exist.' },
				quietMessaging: false,
				quiet: { error: 'Could not establish connection. Receiving end does not exist.' },
				whileShared: { error: 'Could not establish connection. Receiving end does not exist.' },
				portEvents: [
					['onUserScriptEvent', 'connect', 'p1'],
					['onUserScriptEvent', 'portMessage', 'p1'],
					['onUserScriptEvent', 'portDisconnect', 'p1'],
				],
				restarted: { allowed: true, scripts: 1 },
			});
			restarted.dispose();
		} finally {
			userScripts.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('ParadisBrowserExtensionUserScripts shim', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows chrome.userScripts only while allowed, and answers user script messages and ports in the worker', async () => {
		const calls: [string, unknown[]][] = [];
		const listened: string[] = [];
		let handler: ((namespace: string, event: string, args: unknown[]) => void) | undefined;
		const bridge: IParadisShimBridge = {
			call: async (_namespace, method, args) => {
				calls.push([method, args]);
				return { ok: true, value: method === 'state' ? { allowed: false } : method === 'getScripts' ? [{ id: 'a' }] : undefined };
			},
			listen: (_namespace, event) => listened.push(event),
			onEvent: next => { handler = next; },
		};
		const page = { chrome: { runtime: { getManifest: () => ({ permissions: ['userScripts'] }) } } as Record<string, unknown> };
		new Function('globalThis', 'bridge', 'namespace', `(${paradisInstallUserScripts.toString()})(bridge, namespace);`)(page, bridge, PARADIS_SHIM_USER_SCRIPTS_NAMESPACE);
		const chromeApi = page.chrome as Record<string, unknown>;
		const runtime = chromeApi.runtime as Record<string, { addListener(listener: unknown): void }>;
		await Promise.resolve();
		const before = chromeApi.userScripts;
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onAllowedChanged', [true]);
		const api = chromeApi.userScripts as Record<string, (...args: unknown[]) => Promise<unknown>>;
		const scripts = await api.getScripts();
		// 受け手が無い: 「受け手が無い」と答える
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['message', 'r0', 1, {}]);
		runtime.onUserScriptMessage.addListener((message: unknown, _sender: unknown, sendResponse: (value: unknown) => void) => { sendResponse({ echo: message }); });
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['message', 'r1', { hi: 1 }, { id: 'x' }]);
		const portMessages: unknown[] = [];
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['connect', 'p0', 'n', {}]);
		runtime.onUserScriptConnect.addListener((port: { name: string; onMessage: { addListener(listener: unknown): void }; postMessage(message: unknown): void }) => {
			port.onMessage.addListener((message: unknown) => { portMessages.push(message); port.postMessage({ pong: message }); });
		});
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['connect', 'p1', 'n', {}]);
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['portMessage', 'p1', { ping: 1 }]);
		handler?.(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onAllowedChanged', [false]);
		assert.deepStrictEqual({
			before, after: chromeApi.userScripts, scripts, listened, portMessages,
			calls: calls.filter(([method]) => method !== 'state'),
		}, {
			before: undefined, after: undefined, scripts: [{ id: 'a' }],
			listened: ['onAllowedChanged', 'onUserScriptEvent'],
			portMessages: [{ ping: 1 }],
			calls: [
				['getScripts', []],
				['respond', ['r0', { error: 'Could not establish connection. Receiving end does not exist.' }]],
				['respond', ['r1', { value: { echo: { hi: 1 } } }]],
				['portDisconnect', ['p0', 'Could not establish connection. Receiving end does not exist.']],
				['portPost', ['p1', { pong: { ping: 1 } }]],
			],
		});
	});
});

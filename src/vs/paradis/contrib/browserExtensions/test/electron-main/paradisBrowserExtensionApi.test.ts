/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../../../base/common/network.js';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_EXTENSION_API_CALL_URL,
	PARADIS_EXTENSION_API_EVENTS_URL,
	PARADIS_EXTENSION_API_SCHEME,
	paradisDecodeExtensionWire,
	paradisEncodeExtensionWire,
	paradisExtensionApiUrl,
} from '../../common/paradisBrowserExtensionApiWire.js';
import { PARADIS_SHIM_CONTENT_SCRIPT_RELAY_KEY, PARADIS_SHIM_STORAGE_RELAY_NAMESPACE, PARADIS_SHIM_STORAGE_SYNC_NAMESPACE } from '../../common/paradisBrowserExtensionShim.js';
import { paradisBrowserExtensionContentScriptSource, paradisBrowserExtensionShimSource } from '../../common/paradisBrowserExtensionShimSource.js';
import { ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { paradisInjectShimIntoHtml, paradisPrepareExtensionCopy, paradisWithContentScriptShim, paradisWithStaticWebAccessibleResources, paradisReadableHtml, paradisRewriteManifestForShim, paradisWithApiConnectSource, paradisWithPrivateFilesHidden } from '../../electron-main/paradisBrowserExtensionCopyRewrite.js';
import { paradisDecideRuntimeLifecycleEvents } from '../../electron-main/paradisBrowserExtensionRuntime.js';
import { ParadisBrowserExtensionSyncStore, paradisRegisterStorageApis } from '../../electron-main/paradisBrowserExtensionStorageApis.js';
import { paradisPlanExtensionCopy } from '../../electron-main/paradisBrowserExtensionsMain.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const silentLog = { warn: () => { } };

/** 受け手を覚えておく偽のセッション。 */
function fakeSession(extensionIds: readonly string[]) {
	let handler: ((request: Request) => Promise<Response>) | undefined;
	const session: ParadisApiSession = {
		storagePath: '/tmp/session',
		protocol: { handle: (_scheme: string, next: (request: Request) => Promise<Response>) => { handler = next; }, unhandle: () => { handler = undefined; } } as unknown as ParadisApiSession['protocol'],
		extensions: {
			getExtension: (id: string) => extensionIds.includes(id) ? { id, version: '1.0', manifest: { permissions: ['storage'] }, name: 'E', path: '/x', url: `chrome-extension://${id}/` } : null,
			on: () => undefined,
			removeListener: () => undefined,
		} as unknown as ParadisApiSession['extensions'],
		serviceWorkers: { startWorkerForScope: async () => { throw new Error('none'); }, getWorkerFromVersionID: () => undefined, on: () => undefined, removeListener: () => undefined } as unknown as ParadisApiSession['serviceWorkers'],
	};
	/** 詰め物と同じ形で送る（トークンと文脈の名前は URL、呼び出しは本文）。 */
	const send = async (url: string, initiator: string, body: { readonly token: string; readonly connection: string; readonly request?: unknown }, rawBody?: string): Promise<Response> => {
		const request = new Request(paradisExtensionApiUrl(url, body.token, body.connection), { method: 'POST', body: rawBody ?? paradisEncodeExtensionWire({ request: body.request }) });
		Object.defineProperty(request, 'initiatorOrigin', { value: initiator });
		return handler!(request);
	};
	return { session, send, handled: () => handler !== undefined };
}

/** 1 行ずつ届くイベントを読む。 */
async function readEvents(response: Response, count: number): Promise<unknown[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	const events: unknown[] = [];
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffered += decoder.decode(value, { stream: true });
		let newline = buffered.indexOf('\n');
		while (newline >= 0) {
			events.push(paradisDecodeExtensionWire(buffered.slice(0, newline)));
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf('\n');
		}
	}
	await reader.cancel();
	return events;
}

suite('ParadisBrowserExtensionApi', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps undefined across the wire', () => {
		// 省略した引数（タプルの undefined）を保つ。印で始まる本物の文字列は印に読まれない
		const decoded = paradisDecodeExtensionWire(paradisEncodeExtensionWire([1, undefined, '\u0000text'])) as unknown[];
		assert.deepStrictEqual([decoded.length, decoded[0], decoded[1], decoded[2]], [3, 1, undefined, '\u0000text']);
	});

	test('runs the shim with nothing but what an extension worker has', async () => {
		// 詰め物は toString() で写しへ書くので、本体の外を参照していれば ReferenceError になる
		const area = () => {
			const data: Record<string, unknown> = {};
			return {
				get: (_keys: unknown, callback: (value: unknown) => void) => callback({ ...data }),
				set: (items: Record<string, unknown>, callback?: () => void) => { Object.assign(data, items); callback?.(); },
				remove: (_keys: unknown, callback?: () => void) => callback?.(),
				clear: (callback?: () => void) => callback?.(),
			};
		};
		const chrome = { runtime: { getManifest: () => ({ permissions: ['storage'] }), onInstalled: {} as Record<string, unknown> }, storage: { local: area(), session: area(), onChanged: { addListener() { }, removeListener() { } } } as Record<string, unknown> };
		const requests: { url: string; body?: unknown }[] = [];
		class ServiceWorkerGlobalScope { }
		const context = Object.setPrototypeOf({
			chrome, console, setTimeout, TextDecoder,
			ServiceWorkerGlobalScope,
			fetch: async (url: string, init?: { body?: string }) => {
				requests.push({ url, body: init?.body === undefined ? undefined : paradisDecodeExtensionWire(init.body) });
				if (url.endsWith('token.json')) {
					return { ok: true, json: async () => ({ token: 'secret' }) };
				}
				if (url.startsWith(PARADIS_EXTENSION_API_EVENTS_URL)) {
					return { ok: false };
				}
				return { ok: true, text: async () => paradisEncodeExtensionWire({ ok: true, value: { a: 1 } }) };
			},
		}, ServiceWorkerGlobalScope.prototype);
		// globalThis を偽物に差し替えて実行する。モジュールの中の名前は大域に無いので、参照していれば落ちる
		const run = new Function('globalThis', paradisBrowserExtensionShimSource());
		run(context);
		const sync = chrome.storage.sync as { get(key: string): Promise<unknown> };
		const value = await sync.get('a');
		const call = requests.find(request => request.url.startsWith(PARADIS_EXTENSION_API_CALL_URL));
		assert.deepStrictEqual({
			onInstalled: typeof (chrome.runtime.onInstalled as { addListener?: unknown }).addListener,
			value,
			call,
		}, {
			onInstalled: 'function',
			value: { a: 1 },
			call: { url: paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, 'secret', 'worker'), body: { request: { type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: ['a'] } } },
		});
	});

	test('relays a content script\'s storage calls through the worker, and hides the relay from onMessage', async () => {
		// content script: storage.sync と storage.local の書き込みの知らせは、runtime のメッセージで worker へ
		const sent: unknown[] = [];
		const nativeListeners: ((...args: unknown[]) => unknown)[] = [];
		const area = () => {
			const data: Record<string, unknown> = {};
			return {
				get: (_keys: unknown, callback: (value: unknown) => void) => callback({ ...data }),
				set: (items: Record<string, unknown>, callback?: () => void) => { Object.assign(data, items); callback?.(); },
				remove: (_keys: unknown, callback?: () => void) => callback?.(),
				clear: (callback?: () => void) => callback?.(),
			};
		};
		const chrome = {
			runtime: {
				id: 'abcdefghijklmnopabcdefghijklmnop',
				getManifest: () => ({ background: { service_worker: 'bg.js' }, permissions: ['storage'] }),
				sendMessage: async (message: Record<string, unknown>) => {
					sent.push(message);
					return { ok: true, value: { a: 1 } };
				},
				onMessage: { addListener: (listener: (...args: unknown[]) => unknown) => nativeListeners.push(listener), removeListener: () => { } },
			},
			storage: { local: area(), session: area(), onChanged: { addListener() { }, removeListener() { } } } as Record<string, unknown>,
		};
		const context: Record<string, unknown> = { chrome, console, setTimeout };
		new Function('globalThis', paradisBrowserExtensionContentScriptSource())(context);
		const value = await (chrome.storage.sync as { get(key: string): Promise<unknown> }).get('a');
		await (chrome.storage.local as { set(items: object): Promise<void> }).set({ b: 2 });
		const seenByExtension: unknown[] = [];
		(chrome.runtime.onMessage as unknown as { addListener(listener: (message: unknown) => void): void }).addListener(message => seenByExtension.push(message));
		for (const listener of nativeListeners) {
			listener({ [PARADIS_SHIM_CONTENT_SCRIPT_RELAY_KEY]: { changes: {} } }, { id: chrome.runtime.id });
			listener({ hello: 1 }, { id: chrome.runtime.id });
		}
		const strip = (message: unknown) => {
			const relayed = (message as Record<string, { namespace: string; method: string; args: unknown[] }>)[PARADIS_SHIM_CONTENT_SCRIPT_RELAY_KEY];
			return [relayed.namespace, relayed.method, relayed.args];
		};
		assert.deepStrictEqual({ value, sent: sent.map(strip), seenByExtension }, {
			value: { a: 1 },
			sent: [
				[PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, 'get', ['a']],
				[PARADIS_SHIM_STORAGE_RELAY_NAMESPACE, 'report', ['local', { b: { newValue: 2 } }]],
			],
			seenByExtension: [{ hello: 1 }],
		});
	});

	test('puts the content-script shim first in isolated-world content scripts and turns off dynamic resource URLs', () => {
		assert.deepStrictEqual(paradisWithStaticWebAccessibleResources(paradisWithContentScriptShim({
			content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }, { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }, { matches: ['<all_urls>'], css: ['x.css'] }],
			web_accessible_resources: [{ resources: ['menu.html'], matches: ['<all_urls>'], use_dynamic_url: true }, { resources: ['b.png'], matches: ['<all_urls>'] }],
		})), {
			content_scripts: [{ matches: ['<all_urls>'], js: ['paracode-content-script-api.js', 'a.js'] }, { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }, { matches: ['<all_urls>'], css: ['x.css'] }],
			web_accessible_resources: [{ resources: ['menu.html'], matches: ['<all_urls>'], use_dynamic_url: false }, { resources: ['b.png'], matches: ['<all_urls>'] }],
		});
	});

	test('rewrites the manifest so the worker loads the shim first', () => {
		const rewritten = paradisRewriteManifestForShim({
			manifest_version: 3,
			background: { service_worker: 'js/bg.js', type: 'module', scripts: ['firefox.js'] },
			content_security_policy: { extension_pages: 'script-src \'self\'; connect-src https://api.example.com' },
		});
		assert.deepStrictEqual(rewritten, {
			manifest: {
				manifest_version: 3,
				background: { service_worker: 'js/paracode-background.js', type: 'module' },
				content_security_policy: { extension_pages: `script-src 'self'; connect-src https://api.example.com 'self' ${PARADIS_EXTENSION_API_SCHEME}:` },
			},
			wrapper: { path: 'js/paracode-background.js', source: '// Written by Para Code: its chrome.* additions, then this extension\'s own worker.\nimport "/paracode-extension-api.js";\nimport "/js/bg.js";\n' },
		});
		assert.deepStrictEqual([
			paradisWithApiConnectSource('default-src \'self\''),
			paradisWithApiConnectSource('script-src \'self\''),
		], [`default-src 'self'; connect-src 'self' ${PARADIS_EXTENSION_API_SCHEME}:`, 'script-src \'self\'']);
		assert.throws(() => paradisRewriteManifestForShim({ manifest_version: 3, background: { service_worker: '../outside.js' } }));
	});

	test('hides Para Code files from web pages even behind a catch-all pattern', () => {
		const files = ['bg.js', 'paracode-extension-api-token.json', 'paracode-extension-api.js', 'js/paracode-background.js', 'page.html'];
		assert.deepStrictEqual(paradisWithPrivateFilesHidden({ web_accessible_resources: [{ resources: ['*'], matches: ['<all_urls>'] }, { resources: ['/PARACODE-EXTENSION-API-TOKEN.JSON', 'page.html', '%70aracode-extension-api-token.json', 'paracode-extension-api-token%2Ejson', '%2570aracode-extension-api-token.json', '%252570aracode-extension-api-token.json', '%E0%A4%A', 'p%61ge.html'], matches: ['<all_urls>'] }, 'legacy.js'] }, files), {
			// 二重・三重の % でも外し、残すものは元の書き方のまま残す
			web_accessible_resources: [{ resources: ['bg.js', 'page.html'], matches: ['<all_urls>'] }, { resources: ['page.html', 'p%61ge.html'], matches: ['<all_urls>'] }, 'legacy.js'],
		});
	});

	test('injects the shim before the first script of an extension page, once', () => {
		const tag = '<script src="/paracode-extension-api.js" data-paracode-extension-api></script>';
		assert.deepStrictEqual([
			paradisInjectShimIntoHtml('<html><head><SCRIPT src="a.js"></SCRIPT></head></html>'),
			paradisInjectShimIntoHtml('<html><head><title>x</title></head><body></body></html>'),
			paradisInjectShimIntoHtml('<p>bare</p>'),
			paradisInjectShimIntoHtml(paradisInjectShimIntoHtml('<script></script>')),
			paradisInjectShimIntoHtml('<!-- <script src="old.js"></script> --><head></head><script src="a.js"></script>'),
		], [
			`<html><head>${tag}<SCRIPT src="a.js"></SCRIPT></head></html>`,
			`<html><head><title>x</title>${tag}</head><body></body></html>`,
			`${tag}<p>bare</p>`,
			`${tag}<script></script>`,
			`<!-- <script src="old.js"></script> --><head></head>${tag}<script src="a.js"></script>`,
		]);
		assert.deepStrictEqual([
			paradisReadableHtml(new TextEncoder().encode('<meta charset="utf-8"><p>ok</p>')),
			paradisReadableHtml(new Uint8Array([0x3c, 0x70, 0x3e, 0x82, 0xa0])),
			paradisReadableHtml(new TextEncoder().encode('<meta charset="Shift_JIS"><p>x</p>')),
		], ['<meta charset="utf-8"><p>ok</p>', undefined, undefined]);
	});

	test('injects the shim into XHTML and scripted SVG pages, and reports pages it cannot change', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-xml-'));
		try {
			const copy = join(root, 'v3');
			await fs.mkdir(copy);
			await fs.writeFile(join(copy, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'X', version: '1' }));
			await fs.writeFile(join(copy, 'page.xhtml'), '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><script src="p.js"/></head></html>');
			await fs.writeFile(join(copy, 'app.svg'), '<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b"><script href="s.js"/></svg>');
			await fs.writeFile(join(copy, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
			await fs.writeFile(join(copy, 'feed.xml'), '<root><script xmlns="http://www.w3.org/1999/xhtml">x()</script></root>');
			await fs.writeFile(join(copy, 'legacy.xhtml'), '<?xml version="1.0" encoding="Shift_JIS"?><html/>');
			const prepared = await paradisPrepareExtensionCopy(copy, 'token', '// shim');
			const read = (name: string) => fs.readFile(join(copy, name), 'utf8');
			assert.deepStrictEqual({
				xhtml: await read('page.xhtml'),
				svg: await read('app.svg'),
				icon: await read('icon.svg'),
				skipped: [...prepared.skippedPages].sort(),
			}, {
				xhtml: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><script src="/paracode-extension-api.js" data-paracode-extension-api="1"></script><script src="p.js"/></head></html>',
				svg: '<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b"><script href="/paracode-extension-api.js" data-paracode-extension-api="1"></script><script href="s.js"/></svg>',
				icon: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
				skipped: ['feed.xml', 'legacy.xhtml'],
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('prepares a copy from its original manifest every run, and leaves Manifest V2 alone', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-copy-'));
		try {
			const copy = join(root, 'v3');
			await fs.mkdir(join(copy, 'sandboxed'), { recursive: true });
			await fs.writeFile(join(copy, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'V3', version: '1', background: { service_worker: 'bg.js' }, sandbox: { pages: ['sandboxed/page.html'] } }));
			await fs.writeFile(join(copy, 'bg.js'), '');
			await fs.writeFile(join(copy, 'popup.html'), '<script src="p.js"></script>');
			await fs.writeFile(join(copy, 'sandboxed', 'page.html'), '<script src="s.js"></script>');
			await paradisPrepareExtensionCopy(copy, 'token-1', '// shim 1');
			await paradisPrepareExtensionCopy(copy, 'token-2', '// shim 2');
			const v2 = join(root, 'v2');
			await fs.mkdir(v2);
			const v2Manifest = JSON.stringify({ manifest_version: 2, name: 'V2', version: '1', background: { scripts: ['bg.js'] } });
			await fs.writeFile(join(v2, 'manifest.json'), v2Manifest);
			await paradisPrepareExtensionCopy(v2, 'token', '// shim');
			const read = (path: string) => fs.readFile(path, 'utf8');
			assert.deepStrictEqual({
				worker: JSON.parse(await read(join(copy, 'manifest.json'))).background,
				token: JSON.parse(await read(join(copy, 'paracode-extension-api-token.json'))),
				shim: await read(join(copy, 'paracode-extension-api.js')),
				original: JSON.parse(await read(join(copy, 'paracode-original-manifest.json'))).background,
				popup: await read(join(copy, 'popup.html')),
				sandboxed: await read(join(copy, 'sandboxed', 'page.html')),
				v2: await read(join(v2, 'manifest.json')),
			}, {
				worker: { service_worker: 'paracode-background.js' },
				token: { token: 'token-2' },
				shim: '// shim 2',
				original: { service_worker: 'bg.js' },
				popup: '<script src="/paracode-extension-api.js" data-paracode-extension-api></script><script src="p.js"></script>',
				sandboxed: '<script src="s.js"></script>',
				v2: v2Manifest,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('refuses an extension that ships a file named like a Para Code file', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-reserved-'));
		try {
			await fs.mkdir(join(root, 'lib'));
			await fs.writeFile(join(root, 'manifest.json'), '{}');
			await fs.writeFile(join(root, 'lib', 'Paracode-Extension-Api.js'), '');
			assert.deepStrictEqual(await paradisPlanExtensionCopy(await fs.realpath(root)), { ok: false, reason: 'reservedName', detail: 'lib/Paracode-Extension-Api.js' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('answers only the extension that owns the token, and refuses web pages before reading', async () => {
		const host = new ParadisExtensionApiHost(silentLog);
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-sync-'));
		const store = new ParadisBrowserExtensionSyncStore(root, silentLog);
		paradisRegisterStorageApis(host, store);
		const { session, send } = fakeSession([ID]);
		const attached = host.attachSession(session, 'default');
		try {
			const token = host.tokenFor(ID);
			const origin = `chrome-extension://${ID}`;
			const call = (request: unknown, connection = 'worker', initiator = origin, withToken = token) => send(PARADIS_EXTENSION_API_CALL_URL, initiator, { token: withToken, connection, request });
			const status = async (response: Promise<Response>) => (await response).status;
			const json = async (response: Promise<Response>) => paradisDecodeExtensionWire(await (await response).text());
			// ページが sync の変化を待つ
			const pageEvents = await send(PARADIS_EXTENSION_API_EVENTS_URL, origin, { token, connection: 'page-one' });
			await json(call({ type: 'listen', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, event: 'onChanged', active: true }, 'page-one'));
			const set = await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'set', args: [{ theme: 'dark' }] }));
			const events = await readEvents(pageEvents, 1);
			assert.deepStrictEqual({
				webPage: await status(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: [] }, 'worker', 'https://example.com')),
				otherExtension: await status(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: [] }, 'worker', `chrome-extension://${'b'.repeat(32)}`)),
				wrongToken: await status(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: [] }, 'worker', origin, 'guess')),
				set,
				get: await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: ['theme'] })),
				events,
				quota: await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'set', args: [{ big: 'x'.repeat(9000) }] })),
				unknown: await json(call({ type: 'call', namespace: 'tabs', method: 'query', args: [] })),
				// トークンが違えば本文を読まずに断る（大きな本文でも 403）。正しいトークンで大きすぎれば 413
				hugeWithWrongToken: (await send(PARADIS_EXTENSION_API_CALL_URL, origin, { token: 'guess', connection: 'worker' }, 'x'.repeat(3 * 1024 * 1024))).status,
				hugeWithToken: (await send(PARADIS_EXTENSION_API_CALL_URL, origin, { token, connection: 'worker' }, 'x'.repeat(3 * 1024 * 1024))).status,
				// __proto__ などの鍵も、ただの項目として持つ
				proto: [
					await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'set', args: [JSON.parse('{"__proto__":{"polluted":1},"constructor":2}')] })),
					await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'get', args: [['__proto__', 'constructor']] })),
					({} as { polluted?: unknown }).polluted,
				],
				badArgs: await json(call({ type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'set', args: ['not items'] })),
			}, {
				webPage: 403,
				otherExtension: 403,
				wrongToken: 403,
				set: { ok: true, value: { theme: { newValue: 'dark' } } },
				get: { ok: true, value: { theme: 'dark' } },
				events: [{ namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, event: 'onChanged', args: [{ theme: { newValue: 'dark' } }] }],
				quota: { ok: false, error: 'QUOTA_BYTES_PER_ITEM quota exceeded' },
				unknown: { ok: false, error: 'chrome.tabs is not available' },
				hugeWithWrongToken: 403,
				hugeWithToken: 413,
				proto: [
					{ ok: true, value: JSON.parse('{"__proto__":{"newValue":{"polluted":1}},"constructor":{"newValue":2}}') },
					{ ok: true, value: JSON.parse('{"__proto__":{"polluted":1},"constructor":2}') },
					undefined,
				],
				badArgs: { ok: false, error: 'Invalid arguments' },
			});
		} finally {
			attached.dispose();
			host.dispose();
			await store.flush();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('tells the other sessions of the same place about a sync change', async () => {
		const host = new ParadisExtensionApiHost(silentLog);
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-sync-place-'));
		const store = new ParadisBrowserExtensionSyncStore(root, silentLog);
		paradisRegisterStorageApis(host, store);
		const global = fakeSession([ID]);
		const workspace = fakeSession([ID]);
		const profile = fakeSession([ID]);
		const attached = [host.attachSession(global.session, 'default'), host.attachSession(workspace.session, 'default'), host.attachSession(profile.session, 'profile:0123456789ab')];
		try {
			const token = host.tokenFor(ID);
			const origin = `chrome-extension://${ID}`;
			const listen = async (target: ReturnType<typeof fakeSession>) => {
				const stream = await target.send(PARADIS_EXTENSION_API_EVENTS_URL, origin, { token, connection: 'worker' });
				await target.send(PARADIS_EXTENSION_API_CALL_URL, origin, { token, connection: 'worker', request: { type: 'listen', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, event: 'onChanged', active: true } });
				return stream;
			};
			const globalStream = await listen(global);
			const profileStream = await listen(profile);
			await workspace.send(PARADIS_EXTENSION_API_CALL_URL, origin, { token, connection: 'worker', request: { type: 'call', namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, method: 'set', args: [{ a: 1 }] } });
			const profileReader = profileStream.body!.getReader();
			const profileRead = await Promise.race([profileReader.read().then(() => 'event'), new Promise(resolve => setTimeout(() => resolve('nothing'), 50))]);
			await profileReader.cancel();
			assert.deepStrictEqual({ global: await readEvents(globalStream, 1), profile: profileRead }, {
				global: [{ namespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, event: 'onChanged', args: [{ a: { newValue: 1 } }] }],
				profile: 'nothing',
			});
		} finally {
			attached.forEach(disposable => disposable.dispose());
			host.dispose();
			await store.flush();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('does not write back the sync items of an extension removed while a write was pending', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-extension-sync-forget-'));
		try {
			const store = new ParadisBrowserExtensionSyncStore(root, silentLog);
			store.write('default', ID, { a: 1 });
			const removing = store.forgetExtension(ID);
			// 削除と同時に走った書き込み（storage.sync.set の途中など）
			store.write('default', ID, { a: 2 });
			await removing;
			await store.flush();
			const exists = await fs.stat(join(root, 'default', `${ID}.json`)).then(() => true, () => false);
			assert.deepStrictEqual({ exists, read: await store.read('default', ID) }, { exists: false, read: Object.create(null) });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('keeps a worker start event until the worker listens', async () => {
		const host = new ParadisExtensionApiHost(silentLog);
		host.registerNamespace('runtime', { methods: {}, events: ['onInstalled', 'onStartup'] });
		const { session, send } = fakeSession([ID]);
		const attached = host.attachSession(session, 'default');
		try {
			const token = host.tokenFor(ID);
			const origin = `chrome-extension://${ID}`;
			host.emitToWorkerWhenListening(session, ID, 'runtime', 'onInstalled', [{ reason: 'install' }]);
			const stream = await send(PARADIS_EXTENSION_API_EVENTS_URL, origin, { token, connection: 'worker' });
			await send(PARADIS_EXTENSION_API_CALL_URL, origin, { token, connection: 'worker', request: { type: 'listen', namespace: 'runtime', event: 'onInstalled', active: true } });
			assert.deepStrictEqual(await readEvents(stream, 1), [{ namespace: 'runtime', event: 'onInstalled', args: [{ reason: 'install' }] }]);
		} finally {
			attached.dispose();
			host.dispose();
		}
	});

	test('decides runtime.onInstalled and onStartup like Chrome', () => {
		const v1 = { extensionVersion: '1.0', chromiumVersion: '140' };
		assert.deepStrictEqual([
			paradisDecideRuntimeLifecycleEvents(undefined, v1, 'startup'),
			paradisDecideRuntimeLifecycleEvents(v1, v1, 'startup'),
			paradisDecideRuntimeLifecycleEvents(v1, { ...v1, extensionVersion: '1.1' }, 'other'),
			paradisDecideRuntimeLifecycleEvents(v1, v1, 'reload'),
			paradisDecideRuntimeLifecycleEvents(v1, { ...v1, chromiumVersion: '141' }, 'other'),
		], [
			[{ event: 'onInstalled', args: [{ reason: 'install' }] }],
			[{ event: 'onStartup', args: [] }],
			[{ event: 'onInstalled', args: [{ reason: 'update', previousVersion: '1.0' }] }],
			[{ event: 'onInstalled', args: [{ reason: 'update', previousVersion: '1.0' }] }],
			[{ event: 'onInstalled', args: [{ reason: 'chrome_update' }] }],
		]);
	});

	test('registers the API scheme with the other privileged schemes at startup', () => {
		// 登録は ready の前の 1 回だけが効く（mainImpl.ts）。名前がずれると worker の fetch が届かない
		const mainImpl = readFileSync(join(dirname(FileAccess.asFileUri('vs/../../src').fsPath), 'src', 'mainImpl.ts'), 'utf8');
		assert.ok(mainImpl.includes(`scheme: '${PARADIS_EXTENSION_API_SCHEME}'`));
	});
});

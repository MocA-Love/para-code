/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_API_CALL_URL, PARADIS_EXTENSION_API_EVENTS_URL, paradisDecodeExtensionWire, paradisEncodeExtensionWire, paradisExtensionApiUrl } from '../../common/paradisBrowserExtensionApiWire.js';
import { paradisBrowserExtensionShimSource } from '../../common/paradisBrowserExtensionShimSource.js';
import { ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { PARADIS_NATIVE_MESSAGING_NAMESPACE, ParadisNativeHostSpawner, ParadisNativeMessaging, paradisNativeHostCommand, paradisNativeHostEnvironment } from '../../electron-main/paradisNativeMessaging.js';
import {
	IParadisNativeHostLookup,
	PARADIS_NATIVE_HOST_ERRORS,
	paradisCreateNativeMessageReader,
	paradisEncodeNativeMessage,
	paradisExpandWindowsEnvironment,
	paradisNativeHostSources,
	paradisParseNativeHostManifest,
	paradisResolveNativeHost,
} from '../../electron-main/paradisNativeMessagingHosts.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'b'.repeat(32);
const silentLog = { warn: () => { } };

/** ホストの manifest（Chrome の形）。 */
function manifest(name: string, path: string, origins: readonly string[]): string {
	return JSON.stringify({ name, description: 'Test host', type: 'stdio', path, allowed_origins: origins });
}

/** 偽の場所（フォルダ → ファイル）。 */
function fakeLookup(files: Record<string, string>, programs: readonly string[], platform: NodeJS.Platform = 'linux', registry: Record<string, string> = {}): IParadisNativeHostLookup {
	return {
		platform,
		sources: platform === 'win32'
			? [{ kind: 'folder', folder: 'C:\\Users\\me\\AppData\\Roaming\\Para Code\\NativeMessagingHosts' }, { kind: 'registry', root: 'HKCU', key: 'Software\\Google\\Chrome\\NativeMessagingHosts' }]
			: [{ kind: 'folder', folder: '/para/NativeMessagingHosts' }, { kind: 'folder', folder: '/chrome/NativeMessagingHosts' }, { kind: 'folder', folder: '/brave/NativeMessagingHosts' }],
		readFile: async path => files[path],
		isFile: async path => programs.includes(path),
		readRegistryDefault: async (_root, key) => registry[key],
	};
}

suite('ParadisNativeMessaging hosts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks in Para Code\'s folder first, then Chrome and the other browsers', () => {
		const mac = paradisNativeHostSources({ platform: 'darwin', homeDir: '/Users/example', userDataDir: '/Users/example/Library/Application Support/Para Code' });
		const linux = paradisNativeHostSources({ platform: 'linux', homeDir: '/home/example', userDataDir: '/home/example/.config/Para Code', xdgConfigHome: '/home/example/.xdg' });
		const windows = paradisNativeHostSources({ platform: 'win32', homeDir: 'C:\\Users\\example', userDataDir: 'C:\\Users\\example\\AppData\\Roaming\\Para Code' });
		const describe = (source: (typeof mac)[number]) => source.kind === 'folder' ? source.folder : `${source.root}\\${source.key}`;
		assert.deepStrictEqual({ mac: mac.slice(0, 3).map(describe), macCount: mac.length, linux: linux.slice(0, 3).map(describe), windows: windows.slice(0, 3).map(describe) }, {
			mac: ['/Users/example/Library/Application Support/Para Code/NativeMessagingHosts', '/Users/example/Library/Application Support/Google/Chrome/NativeMessagingHosts', '/Users/example/Library/Application Support/Chromium/NativeMessagingHosts'],
			macCount: 11,
			linux: ['/home/example/.config/Para Code/NativeMessagingHosts', '/home/example/.xdg/google-chrome/NativeMessagingHosts', '/home/example/.xdg/chromium/NativeMessagingHosts'],
			windows: ['C:\\Users\\example\\AppData\\Roaming\\Para Code\\NativeMessagingHosts', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts', 'HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\NativeMessagingHosts'],
		});
	});

	test('checks the manifest like Chrome and refuses wildcard origins', () => {
		const parse = (text: string) => paradisParseNativeHostManifest(text)?.allowedOrigins.map(pattern => pattern.host);
		assert.deepStrictEqual([
			parse(manifest('com.example.host', '/bin/host', [`chrome-extension://${ID}/`])),
			parse(manifest('com.example.host', '/bin/host', ['chrome-extension://*/'])),
			parse(manifest('Com.Example', '/bin/host', [`chrome-extension://${ID}/`])),
			parse(JSON.stringify({ name: 'com.example.host', description: 'x', type: 'socket', path: '/bin/host', allowed_origins: [] })),
			parse(manifest('com.example.host', '', [`chrome-extension://${ID}/`])),
			parse('not json'),
		], [[ID], undefined, undefined, undefined, undefined, undefined]);
	});

	test('starts only a host whose allowed_origins names the extension, and falls through broken or other manifests', async () => {
		const files = {
			'/para/NativeMessagingHosts/com.example.forbidden.json': manifest('com.example.forbidden', '/bin/forbidden', [`chrome-extension://${OTHER}/`]),
			'/para/NativeMessagingHosts/com.example.host.json': 'broken',
			'/chrome/NativeMessagingHosts/com.example.host.json': manifest('com.example.host', '/bin/missing', [`chrome-extension://${ID}/`]),
			'/brave/NativeMessagingHosts/com.example.host.json': manifest('com.example.host', '/bin/../bin/host', [`chrome-extension://${ID}/`]),
			'/chrome/NativeMessagingHosts/com.example.relative.json': manifest('com.example.relative', 'host', [`chrome-extension://${ID}/`]),
			'/chrome/NativeMessagingHosts/com.example.renamed.json': manifest('com.example.other', '/bin/host', [`chrome-extension://${ID}/`]),
		};
		const lookup = fakeLookup(files, ['/bin/host', '/bin/forbidden']);
		const windows = fakeLookup({ 'C:\\hosts\\com.example.host.json': manifest('com.example.host', 'host.exe', [`chrome-extension://${ID}/`]) }, ['C:\\hosts\\host.exe'], 'win32', { 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.example.host': 'C:\\hosts\\com.example.host.json' });
		assert.deepStrictEqual({
			found: await paradisResolveNativeHost('com.example.host', ID, lookup),
			forbidden: await paradisResolveNativeHost('com.example.forbidden', ID, lookup),
			// 相対のパスは Windows だけ
			relative: await paradisResolveNativeHost('com.example.relative', ID, lookup),
			renamed: await paradisResolveNativeHost('com.example.renamed', ID, lookup),
			badName: await paradisResolveNativeHost('../evil', ID, lookup),
			windowsRelative: await paradisResolveNativeHost('com.example.host', ID, windows),
			expanded: paradisExpandWindowsEnvironment('%LocalAppData%\\x\\%MISSING%', { LOCALAPPDATA: 'C:\\L' }),
		}, {
			found: { ok: true, program: '/bin/host', manifestPath: '/brave/NativeMessagingHosts/com.example.host.json' },
			forbidden: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.forbidden },
			relative: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.notFound },
			renamed: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.notFound },
			badName: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.invalidName },
			windowsRelative: { ok: true, program: 'C:\\hosts\\host.exe', manifestPath: 'C:\\hosts\\com.example.host.json' },
			expanded: 'C:\\L\\x\\%MISSING%',
		});
	});

	test('reads framed messages across chunks and stops on an oversized or broken one', () => {
		const messages: string[] = [];
		const errors: string[] = [];
		const reader = paradisCreateNativeMessageReader(json => messages.push(json), reason => errors.push(reason));
		const frame = Buffer.concat([paradisEncodeNativeMessage('{"a":1}'), paradisEncodeNativeMessage('"two"')]);
		reader.push(frame.subarray(0, 2));
		reader.push(frame.subarray(2, 9));
		reader.push(frame.subarray(9));
		const big = Buffer.alloc(4);
		big.writeUInt32LE(2 * 1024 * 1024, 0);
		const second = paradisCreateNativeMessageReader(() => { }, reason => errors.push(reason));
		second.push(big);
		const third = paradisCreateNativeMessageReader(() => { }, reason => errors.push(reason));
		third.push(paradisEncodeNativeMessage('{oops'));
		assert.deepStrictEqual({ messages, errors }, { messages: ['{"a":1}', '"two"'], errors: ['message of 2097152 bytes is over the 1 MB limit', 'message is not valid JSON'] });
	});

	test('starts the host without a shell, with a clean environment, and refuses paths cmd.exe would interpret', () => {
		assert.deepStrictEqual({
			posix: paradisNativeHostCommand('linux', '/opt/host dir/host', [`chrome-extension://${ID}/`], undefined),
			windows: paradisNativeHostCommand('win32', 'C:\\Program Files\\Host\\host.exe', [`chrome-extension://${ID}/`, '--parent-window=0'], 'C:\\Windows\\System32\\cmd.exe'),
			percent: paradisNativeHostCommand('win32', 'C:\\%TEMP%\\host.exe', [], 'C:\\Windows\\System32\\cmd.exe'),
			quote: paradisNativeHostCommand('win32', 'C:\\a"b\\host.exe', [], undefined),
			environment: paradisNativeHostEnvironment({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', VSCODE_PID: '1', PARA_CODE_TERMINAL_PANE_ID: 'secret', HOME: '/home/me' }),
		}, {
			posix: { file: '/opt/host dir/host', args: [`chrome-extension://${ID}/`], verbatim: false },
			windows: { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `""C:\\Program Files\\Host\\host.exe" chrome-extension://${ID}/ --parent-window=0"`], verbatim: true },
			percent: undefined,
			quote: undefined,
			environment: { PATH: '/bin', HOME: '/home/me' },
		});
	});
});

suite('ParadisNativeMessaging shim', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 詰め物を、拡張機能の worker にあるものだけで動かす（toString() で並べた本体が外を参照していれば落ちる）。 */
	async function runShim(permissions: readonly string[]) {
		const calls: unknown[] = [];
		const chrome = { runtime: { getManifest: () => ({ manifest_version: 3, permissions }), onInstalled: {} as Record<string, unknown> } as Record<string, unknown> };
		class ServiceWorkerGlobalScope { }
		const context = Object.setPrototypeOf({
			chrome, console, setTimeout, TextDecoder,
			ServiceWorkerGlobalScope,
			fetch: async (url: string, init?: { body?: string }) => {
				if (url.endsWith('token.json')) {
					return { ok: true, json: async () => ({ token: 'secret' }) };
				}
				if (url.startsWith(PARADIS_EXTENSION_API_EVENTS_URL)) {
					return { ok: false };
				}
				const request = (paradisDecodeExtensionWire(init?.body ?? '{}') as { request?: { type: string; namespace: string; method?: string; event?: string } }).request;
				if (request?.namespace === PARADIS_NATIVE_MESSAGING_NAMESPACE) {
					calls.push(request.type === 'call' ? `${request.method}` : `listen ${request.event}`);
				}
				const value = request?.method === 'sendNativeMessage' ? JSON.stringify({ pong: true }) : undefined;
				return { ok: true, text: async () => paradisEncodeExtensionWire({ ok: true, value }) };
			},
		}, ServiceWorkerGlobalScope.prototype);
		new Function('globalThis', paradisBrowserExtensionShimSource())(context);
		return { runtime: chrome.runtime, calls };
	}

	test('adds connectNative and sendNativeMessage only for nativeMessaging extensions, and talks to main through its namespace', async () => {
		const without = await runShim(['storage']);
		const { runtime, calls } = await runShim(['nativeMessaging']);
		const connectNative = runtime.connectNative as (name: string) => { postMessage(message: unknown): void };
		const sendNativeMessage = runtime.sendNativeMessage as (name: string, message: unknown) => Promise<unknown>;
		const port = connectNative('com.example.echo');
		port.postMessage({ hello: 1 });
		const reply = await sendNativeMessage('com.example.echo', { ping: true });
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepStrictEqual({ without: typeof without.runtime.connectNative, reply, calls: [...calls].sort() }, {
			without: 'undefined',
			reply: { pong: true },
			// 開くのを待ってから送る（開く前の postMessage は溜めておく）
			calls: ['connect', 'listen onPortEvent', 'postMessage', 'sendNativeMessage'],
		});
	});
});

/** 偽のホスト（標準入力のメッセージに、受け取ったものと起動の引数を付けて返す。{"exit":true} で終わる）。 */
const FAKE_HOST = `
const origin = process.argv[2];
let buffered = Buffer.alloc(0);
const send = value => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0); process.stdout.write(Buffer.concat([head, body])); };
process.stdin.on('data', chunk => {
	buffered = Buffer.concat([buffered, chunk]);
	while (buffered.length >= 4) {
		const size = buffered.readUInt32LE(0);
		if (buffered.length < 4 + size) return;
		const message = JSON.parse(buffered.subarray(4, 4 + size).toString());
		buffered = buffered.subarray(4 + size);
		if (message.exit) { process.exit(0); }
		send({ echo: message, origin, secret: process.env.PARA_CODE_TEST_SECRET === undefined ? 'clean' : 'leaked' });
	}
});
process.stdin.on('end', () => process.exit(0));
`;

suite('ParadisNativeMessaging ports', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(permissions: readonly string[]) {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-native-'));
		const hostScript = join(root, 'host.js');
		await fs.writeFile(hostScript, FAKE_HOST);
		await fs.writeFile(join(root, 'com.example.echo.json'), manifest('com.example.echo', hostScript, [`chrome-extension://${ID}/`]));
		await fs.writeFile(join(root, 'com.example.other.json'), manifest('com.example.other', hostScript, [`chrome-extension://${OTHER}/`]));
		let handler: ((request: Request) => Promise<Response>) | undefined;
		const session = {
			storagePath: '/tmp/session',
			protocol: { handle: (_scheme: string, next: (request: Request) => Promise<Response>) => { handler = next; }, unhandle: () => { handler = undefined; } },
			extensions: { getExtension: (id: string) => id === ID ? { id, version: '1.0', manifest: { manifest_version: 3, permissions }, name: 'E', path: '/x' } : null, on: () => undefined, removeListener: () => undefined },
			serviceWorkers: {
				startWorkerForScope: async () => { throw new Error('none'); },
				getWorkerFromVersionID: () => worker,
				on: (_event: string, listener: (details: { versionId: number; runningStatus: string }) => void) => { onStatus = listener; },
				removeListener: () => undefined,
			},
		} as unknown as ParadisApiSession;
		// 動いている worker（Electron 43.7.7 と同じく、止まった・入れ替わった後の end() は投げる）
		const tasks: string[] = [];
		let onStatus: ((details: { versionId: number; runningStatus: string }) => void) | undefined;
		const worker = {
			scope: `chrome-extension://${ID}/`, versionId: 1, isDestroyed: () => false,
			startTask: () => {
				tasks.push('start');
				return { end: () => { tasks.push('end'); throw new TypeError('Service worker was not found'); } };
			},
		};
		const runWorker = () => onStatus?.({ versionId: 1, runningStatus: 'running' });
		const host = new ParadisExtensionApiHost(silentLog);
		const lookup: IParadisNativeHostLookup = {
			platform: 'linux', sources: [{ kind: 'folder', folder: root }],
			readFile: path => fs.readFile(path, 'utf8').catch(() => undefined),
			isFile: path => fs.stat(path).then(stat => stat.isFile(), () => false),
			readRegistryDefault: async () => undefined,
		};
		const spawned: { program: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		// 偽のホストは JS なので、このテストの Electron を Node として動かす（本物はホストを直接起動する）
		const spawner: ParadisNativeHostSpawner = (program, args, options) => {
			spawned.push({ program, args, env: options.env });
			return spawn(process.execPath, [program, ...args], { cwd: options.cwd, detached: options.detached, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
		};
		process.env.PARA_CODE_TEST_SECRET = '1';
		const native = new ParadisNativeMessaging(host, () => lookup, silentLog, spawner, 'linux');
		const attached = host.attachSession(session, 'default');
		const token = host.tokenFor(ID);
		const post = (endpoint: string, connection: string, request?: unknown) => {
			const value = new Request(paradisExtensionApiUrl(endpoint, token, connection), { method: 'POST', body: paradisEncodeExtensionWire({ request }) });
			Object.defineProperty(value, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
			return handler!(value);
		};
		const call = async (connection: string, method: string, args: unknown[]) => paradisDecodeExtensionWire(await (await post(PARADIS_EXTENSION_API_CALL_URL, connection, { type: 'call', namespace: PARADIS_NATIVE_MESSAGING_NAMESPACE, method, args })).text());
		const events = async (connection: string) => {
			const stream = await post(PARADIS_EXTENSION_API_EVENTS_URL, connection);
			await post(PARADIS_EXTENSION_API_CALL_URL, connection, { type: 'listen', namespace: PARADIS_NATIVE_MESSAGING_NAMESPACE, event: 'onPortEvent', active: true });
			const reader = stream.body!.getReader();
			let buffered = '';
			return {
				next: async () => {
					for (; ;) {
						const newline = buffered.indexOf('\n');
						if (newline >= 0) {
							const line = buffered.slice(0, newline);
							buffered = buffered.slice(newline + 1);
							return (paradisDecodeExtensionWire(line) as { args: unknown[] }).args;
						}
						const { value, done } = await reader.read();
						if (done) {
							return undefined;
						}
						buffered += new TextDecoder().decode(value);
					}
				},
				cancel: () => reader.cancel(),
			};
		};
		const dispose = async () => {
			native.dispose();
			attached.dispose();
			host.dispose();
			delete process.env.PARA_CODE_TEST_SECRET;
			await fs.rm(root, { recursive: true, force: true });
		};
		return { call, events, native, spawned, host, session, dispose, runWorker, tasks };
	}

	test('round-trips through a real host process, which gets only the origin and a clean environment', async () => {
		const { call, events, native, spawned, dispose } = await setup(['nativeMessaging']);
		try {
			const page = await events('page-one');
			const connected = await call('page-one', 'connect', ['p1', 'com.example.echo']);
			await call('page-one', 'postMessage', ['p1', JSON.stringify({ hello: 'host' })]);
			const reply = await page.next();
			const oneShot = await call('worker', 'sendNativeMessage', ['com.example.echo', JSON.stringify({ once: true })]);
			const forbidden = await call('page-one', 'connect', ['p2', 'com.example.other']);
			const missing = await call('page-one', 'connect', ['p3', 'com.example.missing']);
			await call('page-one', 'postMessage', ['p1', JSON.stringify({ exit: true })]);
			const exited = await page.next();
			await page.cancel();
			assert.deepStrictEqual({
				connected, reply, oneShot, forbidden, missing, exited,
				spawnedArgs: spawned.map(entry => entry.args),
				secretLeaked: spawned.some(entry => entry.env.PARA_CODE_TEST_SECRET !== undefined),
				openPorts: native.openPortCount,
			}, {
				connected: { ok: true },
				reply: ['p1', 'message', JSON.stringify({ echo: { hello: 'host' }, origin: `chrome-extension://${ID}/`, secret: 'clean' })],
				oneShot: { ok: true, value: JSON.stringify({ echo: { once: true }, origin: `chrome-extension://${ID}/`, secret: 'clean' }) },
				// allowed_origins に無い拡張機能のホストは起動しない
				forbidden: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.forbidden },
				missing: { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.notFound },
				exited: ['p1', 'disconnect', PARADIS_NATIVE_HOST_ERRORS.exited],
				spawnedArgs: [[`chrome-extension://${ID}/`], [`chrome-extension://${ID}/`]],
				secretLeaked: false,
				openPorts: 0,
			});
		} finally {
			await dispose();
		}
	});

	test('answers a worker even when ending its task throws, keeps the worker alive while a port is open, and refuses a reused or odd port id', async () => {
		const { call, native, runWorker, tasks, dispose } = await setup(['nativeMessaging']);
		try {
			runWorker();
			const oneShot = await call('worker', 'sendNativeMessage', ['com.example.echo', JSON.stringify({ once: true })]);
			const afterOneShot = tasks.length;
			const connected = await call('worker', 'connect', ['w1', 'com.example.echo']);
			const reused = await call('worker', 'connect', ['w1', 'com.example.echo']);
			const odd = await call('worker', 'connect', ['w1|x', 'com.example.echo']);
			const openWhileConnected = native.openPortCount;
			const disconnected = await call('worker', 'disconnect', ['w1']);
			assert.deepStrictEqual({ oneShot: (oneShot as { ok: boolean }).ok, afterOneShot, connected, reused, odd, openWhileConnected, disconnected, openAfter: native.openPortCount }, {
				oneShot: true,
				// 呼び出しの間の 1 つと、ポートの間の 1 つ。どちらの end() も投げたが答えは返った
				afterOneShot: 4,
				connected: { ok: true },
				reused: { ok: false, error: 'This port is already open' },
				odd: { ok: false, error: 'Invalid arguments' },
				openWhileConnected: 1,
				disconnected: { ok: true },
				openAfter: 0,
			});
		} finally {
			await dispose();
		}
	});

	test('needs the nativeMessaging permission, and closes a page\'s ports when the page goes away', async () => {
		const without = await setup([]);
		const withPermission = await setup(['nativeMessaging']);
		try {
			const refused = await without.call('worker', 'connect', ['p1', 'com.example.echo']);
			const page = await withPermission.events('page-two');
			await withPermission.call('page-two', 'connect', ['p1', 'com.example.echo']);
			const openWhileThere = withPermission.native.openPortCount;
			// ページが閉じた（イベントの応答が取り消された）
			await page.cancel();
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual({ refused, openWhileThere, openAfter: withPermission.native.openPortCount }, {
				refused: { ok: false, error: 'This API requires the "nativeMessaging" permission' },
				openWhileThere: 1,
				openAfter: 0,
			});
		} finally {
			await without.dispose();
			await withPermission.dispose();
		}
	});
});

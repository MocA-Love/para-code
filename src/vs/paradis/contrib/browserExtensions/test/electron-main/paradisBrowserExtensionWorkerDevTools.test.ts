/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSummarizeManifest } from '../../electron-main/paradisBrowserExtensionsMain.js';
import { connect, createServer, Server, Socket } from 'net';
import { IParadisDevToolsWindow, IParadisWorkerDevToolsEnvironment, ParadisBrowserExtensionWorkerDevTools, paradisPickWorkerTarget, paradisRewriteDevToolsHandshake } from '../../electron-main/paradisBrowserExtensionWorkerDevTools.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'a'.repeat(64);

suite('ParadisBrowserExtensionWorkerDevTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the service worker target of the extension from /json/list', () => {
		const list = [
			{ id: 'AA01', type: 'page', url: `chrome-extension://${ID}/popup.html` },
			{ id: 'BB00', type: 'service_worker', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/bg.js' },
			{ id: 'CC01', type: 'service_worker', url: `chrome-extension://${ID}/paracode-background.js` },
		];
		assert.deepStrictEqual([paradisPickWorkerTarget(list, ID), paradisPickWorkerTarget(list.slice(0, 2), ID), paradisPickWorkerTarget({}, ID)], ['CC01', undefined, undefined]);
	});

	test('relays only the DevTools window\'s own WebSocket upgrade, and drops its Origin and Host for the debugging port', () => {
		const tokens = new Map([[TOKEN, 'ABC123']]);
		const head = (path: string, origin: string | undefined, upgrade = true) => [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1:5555', ...(origin !== undefined ? [`Origin: ${origin}`] : []), ...(upgrade ? ['Upgrade: websocket', 'Connection: Upgrade'] : []), 'Sec-WebSocket-Key: k'].join('\r\n');
		assert.deepStrictEqual([
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, 'devtools://devtools'), 9222, tokens),
			// a web page (other Origin), no Origin, an unknown token, another target and a plain request are refused
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, 'https://example.com'), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, undefined), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${'b'.repeat(64)}/devtools/page/ABC123`, 'devtools://devtools'), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/DEF456`, 'devtools://devtools'), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, 'devtools://devtools', false), 9222, tokens),
		], [
			{ token: TOKEN, request: 'GET /devtools/page/ABC123 HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\n\r\n' },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('does not pass a second request to the debugging port when the first one was not upgraded', async () => {
		const harness = await createHarness('reject');
		try {
			const result = await harness.devtools.open(ID, 'E', async () => true);
			const { port, path } = harness.relayOf(0);
			const answer = await exchange(port, [handshake(path), 'GET /devtools/page/FFFF HTTP/1.1\r\nHost: x\r\n\r\n'].join(''));
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual({ result, answer: answer.split('\r\n')[0], upstream: harness.received().match(/^GET \S+/gm) }, {
				result: { ok: true },
				answer: 'HTTP/1.1 404 Not Found',
				upstream: ['GET /devtools/page/ABC1'],
			});
		} finally {
			await harness.dispose();
		}
	});

	test('opens one window for clicks in a row, and stops the relay and its connections when the windows close', async () => {
		const harness = await createHarness('upgrade');
		try {
			const [first, second] = await Promise.all([harness.devtools.open(ID, 'E', async () => true), harness.devtools.open(ID, 'E', async () => true)]);
			const { port, path } = harness.relayOf(0);
			const socket = connect(port, '127.0.0.1');
			await new Promise(resolve => socket.once('connect', resolve));
			const closed = new Promise(resolve => socket.once('close', resolve));
			socket.write(handshake(path));
			await new Promise(resolve => socket.once('data', resolve));
			harness.windows[0].close();
			await closed;
			const refused = await new Promise(resolve => connect(port, '127.0.0.1').once('error', error => resolve((error as NodeJS.ErrnoException).code)).once('connect', () => resolve('connected')));
			assert.deepStrictEqual({ first, second, windows: harness.windows.length, refused, open: harness.devtools.openWindowCount }, {
				first: { ok: true }, second: { ok: true }, windows: 1, refused: 'ECONNREFUSED', open: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	test('closes the DevTools windows when the last work window closes', async () => {
		const harness = await createHarness('upgrade');
		try {
			await harness.devtools.open(ID, 'E', async () => true);
			harness.closeLastWorkWindow();
			assert.deepStrictEqual({ destroyed: harness.windows.map(window => window.isDestroyed()), open: harness.devtools.openWindowCount }, { destroyed: [true], open: 0 });
		} finally {
			await harness.dispose();
		}
	});

	test('summarizes the permissions, sites and service worker of a manifest for the manager screen', () => {
		assert.deepStrictEqual(paradisSummarizeManifest({
			permissions: ['storage', 'tabs', '<all_urls>'],
			optional_permissions: ['tabs', 'debugger'],
			host_permissions: ['https://example.com/*'],
			content_scripts: [{ matches: ['https://example.com/*', 'https://a.test/*'] }, null],
			background: { service_worker: 'bg.js' },
		}), {
			manifest: {
				permissions: ['storage', 'tabs', '<all_urls>'],
				optional_permissions: ['tabs', 'debugger'],
				host_permissions: ['https://example.com/*'],
				content_scripts: [{ matches: ['https://example.com/*', 'https://a.test/*'] }, null],
				background: { service_worker: 'bg.js' },
			},
			permissions: ['storage', 'tabs', 'debugger'],
			hostPermissions: ['<all_urls>', 'https://example.com/*', 'https://a.test/*'],
			hasWorker: true,
		});
	});
});

/** 中継の先に置く偽の remote-debugging のポート。`upgrade` なら 101 で切り替え、`reject` なら 404 を返す。 */
async function createHarness(mode: 'upgrade' | 'reject') {
	let received = '';
	const sockets = new Set<Socket>();
	const upstream: Server = createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => undefined);
		let answered = false;
		socket.on('data', chunk => {
			received += chunk.toString('latin1');
			if (!answered && received.includes('\r\n\r\n')) {
				answered = true;
				socket.write(mode === 'upgrade' ? 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' : 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
			}
		});
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
	const upstreamPort = (upstream.address() as { port: number }).port;
	const windows: Array<IParadisDevToolsWindow & { readonly url: () => string }> = [];
	let lastWorkWindowClosed: (() => void) | undefined;
	const environment: IParadisWorkerDevToolsEnvironment = {
		resolvePort: async () => upstreamPort,
		fetchTargets: async () => [{ id: 'ABC1', type: 'service_worker', url: `chrome-extension://${ID}/bg.js` }],
		createWindow: () => {
			let url = '';
			let destroyed = false;
			const listeners: Array<() => void> = [];
			const window = {
				load: async (next: string) => { url = next; },
				show: () => undefined,
				isDestroyed: () => destroyed,
				close: () => {
					if (!destroyed) {
						destroyed = true;
						listeners.forEach(listener => listener());
					}
				},
				onDidClose: (listener: () => void) => { listeners.push(listener); },
				url: () => url,
			};
			windows.push(window);
			return window;
		},
		onDidCloseLastOtherWindow: (_isDevToolsWindow, listener) => {
			lastWorkWindowClosed = listener;
			return { dispose: () => { lastWorkWindowClosed = undefined; } };
		},
	};
	const devtools = new ParadisBrowserExtensionWorkerDevTools({ warn: () => undefined }, environment);
	return {
		devtools,
		windows,
		received: () => received,
		closeLastWorkWindow: () => lastWorkWindowClosed?.(),
		relayOf: (index: number) => {
			const ws = new URL(windows[index].url()).searchParams.get('ws')!;
			const match = /^127\.0\.0\.1:(?<port>\d+)(?<path>\/.*)$/.exec(ws)!;
			return { port: Number(match.groups!.port), path: match.groups!.path };
		},
		dispose: async () => {
			devtools.dispose();
			sockets.forEach(socket => socket.destroy());
			await new Promise(resolve => upstream.close(resolve));
		},
	};
}

function handshake(path: string): string {
	return [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Origin: devtools://devtools', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: k', '', ''].join('\r\n');
}

/** 送って、閉じられるまでに返ってきたものを読む。 */
function exchange(port: number, data: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let answer = '';
		const socket = connect(port, '127.0.0.1', () => socket.write(data));
		socket.on('data', chunk => answer += chunk.toString('latin1'));
		socket.on('close', () => resolve(answer));
		socket.on('error', reject);
	});
}

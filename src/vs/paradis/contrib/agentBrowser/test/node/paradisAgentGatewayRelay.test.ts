/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type * as http from 'http';
import type * as net from 'net';
import type { AddressInfo, Socket } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_GATEWAY_PROBE_PATH, PARADIS_AGENT_GATEWAY_REQUEST_HEADER, PARADIS_AGENT_GATEWAY_TIMEOUT_CODE, PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER, PARADIS_AGENT_GATEWAY_UNSYNCED_HEADER } from '../../common/paradisAgentGateway.js';
import { IParadisAgentGatewaySource, ParadisAgentGatewayRelay, paradisIsLiveWindowProbe } from '../../node/paradisAgentGatewayRelay.js';
import { PARADIS_MCP_HEALTH_PATH } from '../../node/paradisBrowserMcpShimCore.js';

interface IReceived {
	readonly method: string;
	readonly url: string;
	readonly body: string;
	readonly gateway: string | undefined;
	readonly authorization: string | undefined;
}

type Responder = (received: IReceived, res: http.ServerResponse) => void;

const NOT_MINE: Responder = (_received, res) => {
	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Para Browser endpoint unavailable.' }));
};

suite('ParadisAgentGatewayRelay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const cleanups: Array<() => Promise<void> | void> = [];
	let httpModule: typeof http;
	let netModule: typeof net;

	suiteSetup(async () => {
		httpModule = await import('http');
		netModule = await import('net');
	});

	teardown(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) {
			await cleanup();
		}
	});

	function closeServer(server: http.Server | net.Server, sockets: Set<Socket>): Promise<void> {
		return new Promise(resolve => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close(() => resolve());
		});
	}

	/** 手元の Para Code の HTTP の代わり。health には答え、それ以外は渡された答え方で答える。 */
	async function fakeWindow(respond: Responder, port = 0, health?: Responder): Promise<{ readonly port: number; readonly received: IReceived[]; close(): Promise<void> }> {
		const received: IReceived[] = [];
		const sockets = new Set<Socket>();
		const server = httpModule.createServer((req, res) => {
			if (req.method === 'GET' && req.url === PARADIS_AGENT_GATEWAY_PROBE_PATH && health === undefined) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ protocolVersion: 1, instanceId: 'test-instance', serviceStartedAt: 1 }));
				return;
			}
			if (req.method === 'GET' && req.url === PARADIS_AGENT_GATEWAY_PROBE_PATH && health !== undefined) {
				health({ method: 'GET', url: req.url, body: '', gateway: undefined, authorization: req.headers.authorization }, res);
				return;
			}
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const entry: IReceived = {
					method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'),
					gateway: req.headers[PARADIS_AGENT_GATEWAY_REQUEST_HEADER] as string | undefined,
					authorization: req.headers.authorization,
				};
				received.push(entry);
				respond(entry, res);
			});
		});
		server.on('connection', socket => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});
		await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()));
		let closed = false;
		const close = async () => {
			if (!closed) {
				closed = true;
				await closeServer(server, sockets);
			}
		};
		cleanups.push(close);
		return { port: (server.address() as AddressInfo).port, received, close };
	}

	/** 誰も待っていない番号（接続拒否になる）。 */
	async function unusedPort(): Promise<number> {
		const server = netModule.createServer();
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>(resolve => server.close(() => resolve()));
		return port;
	}

	async function gateway(sources: () => readonly IParadisAgentGatewaySource[], options: { waitLimitMs?: number; unknownTokenWaitMs?: number; probeTimeoutMs?: number } = {}): Promise<number> {
		const relay = new ParadisAgentGatewayRelay({
			readSources: async () => sources(),
			waitLimitMs: options.waitLimitMs ?? 5000,
			retryDelayMs: 20,
			probeTimeoutMs: options.probeTimeoutMs ?? 300,
			probeFreshMs: 0,
			unknownTokenWaitMs: options.unknownTokenWaitMs ?? 5000,
		});
		const sockets = new Set<Socket>();
		const server = httpModule.createServer((req, res) => void relay.handle(req, res));
		server.on('connection', socket => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		cleanups.push(async () => {
			relay.dispose();
			await closeServer(server, sockets);
		});
		return (server.address() as AddressInfo).port;
	}

	function call(port: number, options: { method?: string; path?: string; body?: string; token?: string; headers?: Record<string, string> } = {}): Promise<{ readonly status: number; readonly body: string; readonly headers: http.IncomingHttpHeaders }> {
		return new Promise((resolve, reject) => {
			const request = httpModule.request({
				host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/', agent: false,
				headers: { 'content-type': 'application/json', ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
			}, response => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
				response.on('error', reject);
			});
			request.on('error', reject);
			request.end(options.body ?? '');
		});
	}

	const ok: Responder = (received, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json', 'X-From-Window': 'yes' });
		res.end(JSON.stringify({ echoed: received.body }));
	};

	test('the probe path is the health path of the window', () => {
		assert.strictEqual(PARADIS_AGENT_GATEWAY_PROBE_PATH, PARADIS_MCP_HEALTH_PATH);
	});

	test('passes the method, path, token and body through and marks the request as coming from the gateway', async () => {
		const window = await fakeWindow(ok);
		const port = await gateway(() => [{ id: 'a', port: window.port }]);

		const response = await call(port, { path: '/some/path?x=1', body: '{"jsonrpc":"2.0"}', token: 'pane-token' });

		assert.deepStrictEqual(
			{ status: response.status, body: response.body, header: response.headers['x-from-window'], received: window.received },
			{
				status: 200, body: '{"echoed":"{\\"jsonrpc\\":\\"2.0\\"}"}', header: 'yes',
				received: [{ method: 'POST', url: '/some/path?x=1', body: '{"jsonrpc":"2.0"}', gateway: '1', authorization: 'Bearer pane-token' }],
			},
		);
	});

	test('holds a request while the return tunnel is down and delivers it once on the new port', async () => {
		const deadPort = await unusedPort();
		let sources: IParadisAgentGatewaySource[] = [{ id: 'a', port: deadPort }];
		const port = await gateway(() => sources);

		const pending = call(port, { body: 'held', token: 't' });
		await new Promise(resolve => setTimeout(resolve, 150));
		// 戻りトンネルが別の番号で張り直され、ポートファイルが書き換わった
		const window = await fakeWindow(ok);
		sources = [{ id: 'a', port: window.port }];
		const response = await pending;

		assert.deepStrictEqual({ status: response.status, bodies: window.received.map(entry => entry.body) }, { status: 200, bodies: ['held'] });
	});

	test('gives up with 503 and a code when the window does not come back in time', async () => {
		const deadPort = await unusedPort();
		const port = await gateway(() => [{ id: 'a', port: deadPort }], { waitLimitMs: 200 });

		const response = await call(port, { token: 't' });

		assert.deepStrictEqual({ status: response.status, code: JSON.parse(response.body).code }, { status: 503, code: PARADIS_AGENT_GATEWAY_TIMEOUT_CODE });
	});

	test('gives up sooner when the request names a shorter wait, and never later than its own limit', async () => {
		const deadPort = await unusedPort();
		const patient = await gateway(() => [{ id: 'a', port: deadPort }], { waitLimitMs: 60_000 });
		const impatient = await gateway(() => [{ id: 'a', port: deadPort }], { waitLimitMs: 200 });

		const short = await call(patient, { token: 't', headers: { [PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER]: '0.2' } });
		const startedAt = Date.now();
		const capped = await call(impatient, { token: 't', headers: { [PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER]: '600' } });

		assert.deepStrictEqual({ short: [short.status, JSON.parse(short.body).code], capped: capped.status, cappedInTime: Date.now() - startedAt < 5000 }, { short: [503, PARADIS_AGENT_GATEWAY_TIMEOUT_CODE], capped: 503, cappedInTime: true });
	});

	test('treats a missing or unreadable port file as not yet, and waits', async () => {
		let sources: IParadisAgentGatewaySource[] = [];
		const port = await gateway(() => sources);

		const pending = call(port, { body: 'first', token: 't' });
		await new Promise(resolve => setTimeout(resolve, 100));
		const window = await fakeWindow(ok);
		sources = [{ id: 'a', port: window.port }];

		assert.deepStrictEqual({ status: (await pending).status, count: window.received.length }, { status: 200, count: 1 });
	});

	test('does not send the request to a tunnel that accepts but never answers', async () => {
		// sshd の -R の待ち受けは、手元の ssh が無言で死んでいる間も接続を受ける
		const sockets = new Set<Socket>();
		let bytes = 0;
		const silent = netModule.createServer(socket => {
			sockets.add(socket);
			socket.on('data', chunk => { bytes += chunk.length; });
			socket.on('error', () => { });
		});
		await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', () => resolve()));
		cleanups.push(() => closeServer(silent, sockets));
		const silentPort = (silent.address() as AddressInfo).port;
		let sources: IParadisAgentGatewaySource[] = [{ id: 'a', port: silentPort }];
		const port = await gateway(() => sources, { probeTimeoutMs: 100 });

		const pending = call(port, { body: 'SECRET-BODY-MARKER'.repeat(200), token: 't' });
		await new Promise(resolve => setTimeout(resolve, 250));
		const window = await fakeWindow(ok);
		sources = [{ id: 'a', port: window.port }];
		const response = await pending;

		// 死んだトンネルへ届いたのは生存確認の GET だけ（本文の長さより十分短い）
		assert.deepStrictEqual({ status: response.status, delivered: window.received.length, onlyProbes: bytes < 1000 }, { status: 200, delivered: 1, onlyProbes: true });
	});

	test('does not replay a request that failed after it reached the window', async () => {
		let attempts = 0;
		const window = await fakeWindow((_received, res) => {
			attempts++;
			res.socket?.destroy();
		});
		const port = await gateway(() => [{ id: 'a', port: window.port }]);

		const response = await call(port, { body: 'click', token: 't' });

		assert.deepStrictEqual({ status: response.status, attempts }, { status: 502, attempts: 1 });
	});

	test('tries the next PC when the first one does not know the token, and remembers which one did', async () => {
		const first = await fakeWindow(NOT_MINE);
		const second = await fakeWindow(ok);
		const port = await gateway(() => [{ id: 'first', port: first.port }, { id: 'second', port: second.port }]);

		const responses = [await call(port, { body: 'one', token: 't' }), await call(port, { body: 'two', token: 't' })];

		assert.deepStrictEqual(
			{ statuses: responses.map(response => response.status), first: first.received.map(entry => entry.body), second: second.received.map(entry => entry.body) },
			{ statuses: [200, 200], first: ['one'], second: ['one', 'two'] },
		);
	});

	test('keeps asking the PC that served a pane before when it suddenly says it does not know it, across a restart of the app', async () => {
		// アプリの終了中は、health にも要求にも「知らない」の 404 が返り、その後に接続拒否になる
		let phase: 'running' | 'window-closing' | 'app-quitting' = 'running';
		const before = await fakeWindow(
			(received, res) => phase === 'running' ? ok(received, res) : NOT_MINE(received, res),
			0,
			(received, res) => {
				if (phase === 'app-quitting') {
					NOT_MINE(received, res);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ instanceId: 'before' }));
			},
		);
		let sources: IParadisAgentGatewaySource[] = [{ id: 'a', port: before.port }];
		const port = await gateway(() => sources);

		const first = await call(port, { body: 'first', token: 't' });
		phase = 'window-closing';
		const pending = call(port, { body: 'during-restart', token: 't' });
		await new Promise(resolve => setTimeout(resolve, 100));
		phase = 'app-quitting';
		await new Promise(resolve => setTimeout(resolve, 100));
		await before.close();
		await new Promise(resolve => setTimeout(resolve, 100));
		const after = await fakeWindow(ok);
		sources = [{ id: 'a', port: after.port }];
		const response = await pending;

		assert.deepStrictEqual(
			{ first: first.status, status: response.status, delivered: after.received.map(entry => entry.body) },
			{ first: 200, status: 200, delivered: ['during-restart'] },
		);
	});

	test('gives the 404 back after a short while when the PC that served a pane keeps saying it does not know it', async () => {
		let known = true;
		const window = await fakeWindow((received, res) => known ? ok(received, res) : NOT_MINE(received, res));
		const port = await gateway(() => [{ id: 'a', port: window.port }], { waitLimitMs: 60_000, unknownTokenWaitMs: 150 });

		const first = await call(port, { token: 't' });
		known = false;
		const startedAt = Date.now();
		const second = await call(port, { token: 't' });

		assert.deepStrictEqual({ first: first.status, second: second.status, askedAgain: window.received.length > 2, waited: Date.now() - startedAt >= 150 }, { first: 200, second: 404, askedAgain: true, waited: true });
	});

	test('does not send the token or the body to a port that is not a Para Code window', async () => {
		// もう繋いでこない PC のポートファイルの番号を、関係の無い HTTP サーバーが取っていた
		const stranger = await fakeWindow(ok, 0, (_received, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello'); });
		const window = await fakeWindow(ok);
		const port = await gateway(() => [{ id: 'stale', port: stranger.port }, { id: 'a', port: window.port }]);

		const response = await call(port, { body: 'secret', token: 't' });

		assert.deepStrictEqual({ status: response.status, stranger: stranger.received, delivered: window.received.length }, { status: 200, stranger: [], delivered: 1 });
	});

	test('accepts only a Para Code window as alive', () => {
		assert.deepStrictEqual(
			{
				current: paradisIsLiveWindowProbe(200, '{"protocolVersion":1,"instanceId":"abc","serviceStartedAt":1}'),
				olderWithoutHealth: paradisIsLiveWindowProbe(405, '{"error":"Method not allowed. This is a Para Code MCP endpoint (Streamable HTTP, POST only) with a CDP gateway under /cdp."}'),
				quitting: paradisIsLiveWindowProbe(404, '{"error":"Para Browser endpoint unavailable."}'),
				otherServer: [paradisIsLiveWindowProbe(200, 'hello'), paradisIsLiveWindowProbe(200, '{}'), paradisIsLiveWindowProbe(405, 'Method Not Allowed'), paradisIsLiveWindowProbe(undefined, '')],
			},
			{ current: true, olderWithoutHealth: true, quitting: false, otherServer: [false, false, false, false] },
		);
	});

	test('returns the 404 at once when every connected PC says it does not know the token', async () => {
		const first = await fakeWindow(NOT_MINE);
		const second = await fakeWindow(NOT_MINE);
		const port = await gateway(() => [{ id: 'first', port: first.port }, { id: 'second', port: second.port }]);

		const startedAt = Date.now();
		const response = await call(port, { token: 'gone' });

		assert.deepStrictEqual({ status: response.status, quick: Date.now() - startedAt < 2000 }, { status: 404, quick: true });
	});

	test('waits only briefly for a dead port file when a connected PC does not know a token it has never seen', async () => {
		const alive = await fakeWindow(NOT_MINE);
		const deadPort = await unusedPort();
		const port = await gateway(() => [{ id: 'alive', port: alive.port }, { id: 'stale', port: deadPort }], { waitLimitMs: 60_000, unknownTokenWaitMs: 150 });

		const response = await call(port, { token: 'gone' });

		assert.strictEqual(response.status, 404);
	});

	test('keeps asking while the window says the pane is not synced yet', async () => {
		let calls = 0;
		const window = await fakeWindow((received, res) => {
			calls++;
			if (calls < 3) {
				res.writeHead(503, { 'Content-Type': 'application/json', [PARADIS_AGENT_GATEWAY_UNSYNCED_HEADER]: '1' });
				res.end(JSON.stringify({ error: 'Pane not synced yet.' }));
				return;
			}
			ok(received, res);
		});
		const port = await gateway(() => [{ id: 'a', port: window.port }]);

		const response = await call(port, { body: 'x', token: 't' });

		assert.deepStrictEqual({ status: response.status, calls }, { status: 200, calls: 3 });
	});

	test('passes other 404 and 503 answers through unchanged', async () => {
		const window = await fakeWindow((_received, res) => {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'busy' }));
		});
		const port = await gateway(() => [{ id: 'a', port: window.port }]);

		const response = await call(port, { token: 't' });

		assert.deepStrictEqual({ status: response.status, body: response.body, calls: window.received.length }, { status: 503, body: '{"error":"busy"}', calls: 1 });
	});

	test('streams the answer as it arrives', async () => {
		const window = await fakeWindow((_received, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: one\n\n');
			setTimeout(() => res.end('data: two\n\n'), 150);
		});
		const port = await gateway(() => [{ id: 'a', port: window.port }]);

		const firstChunk = await new Promise<string>((resolve, reject) => {
			const request = httpModule.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false }, response => {
				response.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
				response.resume();
			});
			request.on('error', reject);
			request.end();
		});

		// ためてから返していれば、最初のかたまりに 2 つ目の行も入る
		assert.strictEqual(firstChunk, 'data: one\n\n');
	});
});

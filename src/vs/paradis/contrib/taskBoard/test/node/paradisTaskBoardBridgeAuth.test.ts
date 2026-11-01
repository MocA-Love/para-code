/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisTaskBoardWindowMethod } from '../../common/paradisTaskBoardBridge.js';
import { IParadisTaskBoardAuditEntry } from '../../common/paradisTaskBoardRelay.js';
import { ParadisTaskBoardBoardAuth } from '../../node/paradisTaskBoardBoardAuth.js';
import { ParadisTaskBoardBridgeServer } from '../../node/paradisTaskBoardBridgeServer.js';
import { IParadisTaskBoardWindowRouter, ParadisTaskBoardBridgeService } from '../../node/paradisTaskBoardBridgeService.js';
import { ParadisTaskBoardRelayRouter } from '../../node/paradisTaskBoardRelayRouter.js';

const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);
const SESSION = 'session-0123456789abcdef';

class FakeRouter implements IParadisTaskBoardWindowRouter {
	readonly calls: { ctx: string; method: ParadisTaskBoardWindowMethod; arg: unknown }[] = [];
	windows(): readonly string[] {
		return ['window:1', 'window:2'];
	}
	async call<T>(ctx: string, method: ParadisTaskBoardWindowMethod, arg: unknown): Promise<T> {
		this.calls.push({ ctx, method, arg });
		if (method === 'describe') {
			return { focused: true, repositories: [], spaces: [] } as T;
		}
		if (method === 'relay') {
			return { ok: true, value: { code: 0, stdout: 'ok', stderr: '', timedOut: false } } as T;
		}
		return { ok: false, code: 'not-found', message: 'none' } as T;
	}
}

suite('Paradis task board bridge - board key and caller', function () {

	this.timeout(20_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let token: string;
	let port: number;
	let router: FakeRouter;
	let peerIsBoard: boolean | undefined;
	let audit: Omit<IParadisTaskBoardAuditEntry, 'time'>[];
	let auth: ParadisTaskBoardBoardAuth;
	let relay: ParadisTaskBoardRelayRouter;

	setup(async () => {
		dir = await fsp.mkdtemp(join(tmpdir(), 'paradis-tb-auth-'));
		router = new FakeRouter();
		peerIsBoard = true;
		audit = [];
		const log = new NullLogService();
		const service = store.add(new ParadisTaskBoardBridgeService(router, { directoryExists: async () => true, ignorePathCase: false, newId: () => 'id' }, log));
		// pid の照合は lsof / ss を起こさず差し替える（このテストのプロセス自身が pid 4242 のボードのふりをする）
		auth = new ParadisTaskBoardBoardAuth(async () => peerIsBoard, pid => pid === 4242);
		relay = new ParadisTaskBoardRelayRouter(router, { append: entry => audit.push(entry) }, log);
		const server = store.add(new ParadisTaskBoardBridgeServer(service, join(dir, 'bridge.json'), log, auth, relay));
		await server.start();
		const discovery = JSON.parse(await fsp.readFile(join(dir, 'bridge.json'), 'utf8')) as { port: number; token: string };
		token = discovery.token;
		port = discovery.port;
		auth.register({ pid: 4242, key: KEY_A });
	});

	teardown(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	async function request(route: string, method: 'GET' | 'POST', key: string | undefined, body?: unknown): Promise<number> {
		const abort = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}${route}`, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(key ? { 'x-para-board-key': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: abort.signal,
		});
		// SSE は流れ続けるので、頭を見たら切る
		abort.abort();
		return res.status;
	}

	const ROUTES: readonly [string, 'GET' | 'POST', unknown?][] = [
		['/v1/health', 'GET'], ['/v1/terminals', 'GET'], ['/v1/screen?terminal=t_x', 'GET'], ['/v1/events', 'GET'],
		['/v1/launch', 'POST', {}], ['/v1/send', 'POST', {}], ['/v1/key', 'POST', {}], ['/v1/answer', 'POST', {}], ['/v1/close', 'POST', {}], ['/v1/reply', 'POST', {}],
		['/v1/relay', 'POST', { sessionId: SESSION, op: { kind: 'git', git: { kind: 'status' } } }],
	];

	test('every route refuses the discovery token alone, a wrong board key, and a process that is not the board', async () => {
		const results: string[] = [];
		for (const [route, method, body] of ROUTES) {
			peerIsBoard = true;
			const tokenOnly = await request(route, method, undefined, body);
			const wrongKey = await request(route, method, KEY_B, body);
			peerIsBoard = false;
			const otherProcess = await request(route, method, KEY_A, body);
			results.push(`${route} ${tokenOnly} ${wrongKey} ${otherProcess}`);
		}
		assert.deepStrictEqual(results, ROUTES.map(([route]) => `${route} 403 403 403`));
		// 断った中継の依頼は監査ログに残る
		assert.deepStrictEqual(audit.map(entry => `${entry.operation} ${entry.outcome} ${entry.reason}`), ['relay denied key-missing', 'relay denied key-mismatch', 'relay denied peer-mismatch']);
		assert.strictEqual(router.calls.length, 0);
	});

	test('the body of a request is not read before the board is verified', async () => {
		// 1 MiB を超える本文でも、鍵が無ければ本文を読まずに 403（読んでいれば 413）
		assert.strictEqual(await request('/v1/launch', 'POST', undefined, { prompt: 'x'.repeat(2 * 1024 * 1024) }), 403);
	});

	test('denied relay requests are logged up to 60 lines a minute, then only counted', () => {
		let now = 0;
		const lines: Omit<IParadisTaskBoardAuditEntry, 'time'>[] = [];
		const limited = new ParadisTaskBoardRelayRouter(router, { append: entry => lines.push(entry) }, new NullLogService(), () => now);
		for (let i = 0; i < 70; i++) {
			limited.denied('key-missing');
		}
		now = 60_000;
		limited.denied('key-missing');
		assert.deepStrictEqual([lines.length, lines[60].reason, lines[60].detail, lines[61].reason], [62, 'suppressed', '10 more denied requests were not logged', 'key-missing']);
	});

	test('the board that Para Code started is let through, and an exited board is not', async () => {
		assert.strictEqual(await request('/v1/health', 'GET', KEY_A), 200);
		auth.register({ pid: 9999, key: KEY_B });
		// 9999 は死んでいる（processAlive が false）ので、その鍵は使えない
		assert.strictEqual(await request('/v1/health', 'GET', KEY_B), 403);
	});

	test('a relay session is used only by its board and goes only to the window that opened it', async () => {
		assert.deepStrictEqual([
			relay.register('window:2', { sessionId: SESSION, boardKey: KEY_A, authority: 'ssh-remote+host', repository: '/home/u/repo' }),
			// ほかの窓は同じ ID を上書きできない
			relay.register('window:1', { sessionId: SESSION, boardKey: KEY_B }),
		], [true, false]);
		const body = { sessionId: SESSION, op: { kind: 'git', git: { kind: 'status' } } };
		const ownBoard = await request('/v1/relay', 'POST', KEY_A, body);
		auth.register({ pid: 4242, key: KEY_B });
		const otherBoard = await request('/v1/relay', 'POST', KEY_B, body);
		relay.onWindowDisconnected('window:2');
		auth.register({ pid: 4242, key: KEY_A });
		const afterClose = await request('/v1/relay', 'POST', KEY_A, body);
		assert.deepStrictEqual({
			statuses: [ownBoard, otherBoard, afterClose],
			routed: router.calls.filter(call => call.method === 'relay').map(call => call.ctx),
			audit: audit.map(entry => `${entry.operation} ${entry.outcome} ${entry.reason ?? ''} ${entry.authority ?? ''}`),
		}, {
			statuses: [200, 404, 404],
			routed: ['window:2'],
			audit: ['git.status allowed  ssh-remote+host', 'git.status denied session-of-another-board ssh-remote+host', 'git.status denied unknown-session '],
		});
	});
});

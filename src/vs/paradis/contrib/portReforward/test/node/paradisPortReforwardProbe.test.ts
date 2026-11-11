/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as net from 'net';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParaTunnelHandshake } from '../../../../../platform/tunnel/common/paraTunnelConnect.js';
import { paradisProbeLocalForward } from '../../node/paradisPortReforwardProbe.js';

/** 手元の受け口の代わり。つながった接続を `onConnection` で扱う。 */
async function listen(onConnection: (socket: net.Socket) => void): Promise<{ readonly port: number; close(): Promise<void> }> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('error', () => { });
		socket.on('close', () => sockets.delete(socket));
		onConnection(socket);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		close: () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			return new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

suite('paradisProbeLocalForward', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('follows the handshake of its own connection, waits past a first timeout for the retry, and answers timeout only when nothing decides', async () => {
		const handshakes = store.add(new Emitter<IParaTunnelHandshake>());
		// 手元の受け口の代わり: 受け付けたら読まずに待ち（tunnelService.ts の localSocket.pause()）、handshake の結果を順に知らせる
		const plans: (readonly IParaTunnelHandshake['outcome'][] | 'reset')[] = [];
		const tunnel = await listen(socket => {
			socket.pause();
			const plan = plans.shift();
			setTimeout(() => {
				if (plan === 'reset') {
					socket.resetAndDestroy();
					return;
				}
				for (const outcome of plan ?? []) {
					// ほかのポート・同じポートへのほかの接続の handshake は見ない
					handshakes.fire({ target: 'localhost:9999', clientPort: socket.remotePort, outcome: 'connected' });
					handshakes.fire({ target: 'localhost:4545', clientPort: socket.remotePort! + 1, outcome: outcome === 'connected' ? 'failed' : 'connected' });
					handshakes.fire({ target: 'localhost:4545', outcome: outcome === 'connected' ? 'failed' : 'connected' });
					handshakes.fire({ target: 'localhost:4545', clientPort: socket.remotePort, outcome });
				}
			}, 10);
		});
		const closed = await listen(() => { });
		const closedPort = closed.port;
		await closed.close();
		try {
			const results = [];
			for (const [plan, timeoutMs] of [
				[['connected'], 2000],
				[['failed'], 2000],
				// 遅いだけ: 最初は時間切れ、やり直しで繋がる
				[['timedOut', 'connected'], 2000],
				[['timedOut', 'failed'], 2000],
				// やり直しの結果が上限までに来ない
				[['timedOut'], 200],
				['reset', 2000],
				[[], 100],
			] as const) {
				plans.push(plan);
				results.push(await paradisProbeLocalForward(tunnel.port, 4545, timeoutMs, handshakes.event));
			}
			results.push(await paradisProbeLocalForward(closedPort, 4545, 2000, handshakes.event));
			assert.deepStrictEqual(results, ['reachable', 'reset', 'reachable', 'reset', 'timeout', 'reset', 'timeout', 'refused']);
		} finally {
			await tunnel.close();
		}
	});
});

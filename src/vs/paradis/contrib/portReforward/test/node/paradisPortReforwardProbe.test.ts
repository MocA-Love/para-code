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

	test('follows the handshake of its own connection: connected, failed, timed out; a reset or nothing listening also count as not reached', async () => {
		const handshakes = store.add(new Emitter<IParaTunnelHandshake>());
		// 手元の受け口の代わり: 受け付けたら読まずに待ち（tunnelService.ts の localSocket.pause()）、handshake の結果を知らせる
		const outcomes: (IParaTunnelHandshake['outcome'] | 'reset' | 'none')[] = [];
		const tunnel = await listen(socket => {
			socket.pause();
			const outcome = outcomes.shift();
			setTimeout(() => {
				if (outcome === 'reset') {
					socket.resetAndDestroy();
				} else if (outcome !== 'none' && outcome !== undefined) {
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
		const probe = (timeoutMs = 2000) => paradisProbeLocalForward(tunnel.port, 4545, timeoutMs, handshakes.event);
		try {
			const results = [];
			for (const outcome of ['connected', 'failed', 'timedOut', 'reset'] as const) {
				outcomes.push(outcome);
				results.push(await probe());
			}
			outcomes.push('none');
			results.push(await probe(100));
			results.push(await paradisProbeLocalForward(closedPort, 4545, 2000, handshakes.event));
			assert.deepStrictEqual(results, ['reachable', 'reset', 'timeout', 'reset', 'timeout', 'refused']);
		} finally {
			await tunnel.close();
		}
	});
});

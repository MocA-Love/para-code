/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 張り直した転送を、手元の受け口から 1 回つないで確かめる。
//
// 手元の受け口（platform/tunnel/node/tunnelService.ts の NodeRemoteTunnel、この shared process の中にある）は TCP の
// 接続を先に受け付け、その後で SSH 先へ転送を作る（handshake）。作れなければ手元の接続をリセットし、詰まっていると
// 20 秒の時間切れを 1 回やり直す。手元の側からは「つながった」だけでは何も分からないので、同じプロセスで起きた
// handshake の結果（paraTunnelConnect.ts の onParaTunnelHandshake）のうち、この接続のもの（手元の番号で見分ける）を見る。何も送らないので、SSH 先のサーバーに要求は届かない。

import * as net from 'net';
import { Event } from '../../../../base/common/event.js';
import { IParaTunnelHandshake, onParaTunnelHandshake } from '../../../../platform/tunnel/common/paraTunnelConnect.js';
import { ParadisPortReforwardProbeResult } from '../common/paradisPortReforward.js';

/**
 * 答えを待つ上限。SSH 先へ転送を作る 1 回の時間切れ（20 秒、platform/tunnel/common/paraTunnelConnect.ts）より
 * 少し長くし、詰まっているなら最初の時間切れ（timedOut）を受け取れるようにする。
 */
export const PARADIS_PORT_REFORWARD_PROBE_TIMEOUT_MS = 25_000;

/**
 * 手元の 127.0.0.1:localPort に 1 回つないで、SSH 先の remotePort まで届くか確かめる。
 * @param handshakes テストで差し替える。既定はこのプロセスの転送の handshake
 */
export function paradisProbeLocalForward(localPort: number, remotePort: number, timeoutMs: number = PARADIS_PORT_REFORWARD_PROBE_TIMEOUT_MS, handshakes: Event<IParaTunnelHandshake> = onParaTunnelHandshake): Promise<ParadisPortReforwardProbeResult> {
	return new Promise(resolve => {
		let connected = false;
		let done = false;
		/** この接続の手元の番号。受け口から見た相手の番号なので、自分の handshake だけを見分けられる。 */
		let clientPort: number | undefined;
		const target = `localhost:${remotePort}`;
		const finish = (result: ParadisPortReforwardProbeResult) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			listener.dispose();
			socket.destroy();
			resolve(result);
		};
		const listener = handshakes(handshake => {
			// 同じポートへのほかの接続（ブラウザ・別の SSH 先の窓）の結果は使わない
			if (connected && handshake.target === target && handshake.clientPort !== undefined && handshake.clientPort === clientPort) {
				finish(handshake.outcome === 'connected' ? 'reachable' : handshake.outcome === 'timedOut' ? 'timeout' : 'reset');
			}
		});
		const timer = setTimeout(() => finish('timeout'), timeoutMs);
		const socket = net.connect({ host: '127.0.0.1', port: localPort });
		socket.on('connect', () => {
			connected = true;
			clientPort = socket.localPort;
		});
		// 向こうから何か届いたなら、SSH 先まで繋がっている
		socket.on('data', () => finish('reachable'));
		socket.on('error', () => finish(connected ? 'reset' : 'refused'));
		// handshake の結果より先に閉じられたなら、転送を作れなかった
		socket.on('close', () => finish(connected ? 'reset' : 'refused'));
	});
}

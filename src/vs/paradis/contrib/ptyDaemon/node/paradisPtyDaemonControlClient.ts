/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐の制御用の口を開く。繋ぐ・名乗り合う・話し相手を作る、の3つをここに集める。
//
// **開いた結果は必ず入れ物に入れて返す。中の話し相手を裸で返してはいけない。**
//
// 話し相手は `ProxyChannel.toService` が作る `Proxy` で、**どんな名前のプロパティにも関数を
// 返す**。`then` も例外ではない。そのため `Promise` がこれを解決値として受け取ると、JavaScript
// は「thenable だ」と判断して `then(resolve, reject)` を呼ぶ。すると `then` という名前の呼び出しが
// 常駐へ送られ、引数は関数2つ。関数は `JSON.stringify` すると `undefined` になるので、送信側の
// 直列化が `TypeError` で落ちる。**そして `resolve` も `reject` も呼ばれない**。
//
// つまり `async function f(): Promise<Proxy>` の形にした時点で、`await f()` は
// **永久に返ってこない**。しかも例外は待っている側の try/catch には入らず、main の
// uncaught として出るだけなので、呼び出し側からは「ただ静かに固まった」ようにしか見えない。
// 実機でこれを踏み、状態パネルが最初の一瞬の値のまま何時間も凍った。

import { createConnection } from 'net';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { IParadisPtyDaemonControl, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../common/paradisPtyDaemonControl.js';
import { paradisAuthenticateDaemon } from './paradisPtyDaemonAuth.js';

/** 繋ぐのを待つ上限。応答しない相手をいつまでも待たない。 */
const CONNECT_TIMEOUT = 2_000;

/** 常駐のソケットへ繋ぐ。応答しなければ undefined。 */
export function paradisConnectToDaemon(socketPath: string): Promise<NodeSocket | undefined> {
	return new Promise<NodeSocket | undefined>(resolve => {
		let settled = false;
		const done = (result: NodeSocket | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (!result) {
				socket.destroy();
			}
			resolve(result);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => done(undefined), CONNECT_TIMEOUT);
		socket.once('connect', () => done(new NodeSocket(socket, 'paradis-daemon-control')));
		socket.once('error', () => done(undefined));
	});
}

/** 口を開けたか、開けなかったならなぜか。 */
export type ParadisControlOpen =
	| {
		readonly ok: true;
		/** 畳むのは開けた側の仕事。閉じると進行中の要求は取り消される。 */
		readonly client: SocketClient<string>;
		readonly control: IParadisPtyDaemonControl;
	}
	| {
		readonly ok: false;
		/** 誰も答えない。名前だけ残っているか、既に終わっている。 */
		readonly reason: 'unreachable';
	}
	| {
		readonly ok: false;
		/** 名乗り合いを通らない。その名前を持っているのが誰なのか分からない。 */
		readonly reason: 'not-ours';
	};

/**
 * 制御用の口を開く。繋がることは身元の証明にならないので、毎回名乗り合いを通す。
 *
 * 戻り値が入れ物なのは整理のためではない。冒頭に書いたとおり、**話し相手を `Promise` の
 * 解決値にしないため**の形。
 */
export async function paradisOpenDaemonControl(socketPath: string, token: string): Promise<ParadisControlOpen> {
	const socket = await paradisConnectToDaemon(socketPath);
	if (!socket) {
		return { ok: false, reason: 'unreachable' };
	}
	const client = SocketClient.fromSocket(socket, 'paradis-daemon-control');
	if (!await paradisAuthenticateDaemon(client, token)) {
		client.dispose();
		return { ok: false, reason: 'not-ours' };
	}
	return {
		ok: true,
		client,
		control: ProxyChannel.toService<IParadisPtyDaemonControl>(client.getChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL)),
	};
}

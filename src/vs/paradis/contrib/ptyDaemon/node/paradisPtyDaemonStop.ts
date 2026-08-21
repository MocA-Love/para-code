/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐に「終わってくれ」と頼むところ。
//
// **投げっぱなしにしてはいけない。** 最初の実装は要求を送った直後に接続を畳んでいて、押しても
// 何も起きなかった。`ChannelClient` は dispose のときに進行中の要求を取り消すので、同じ tick で
// 畳むと要求は送られる前に消える（実測: 届いた要求 0 件）。それでいてログには「頼んだ」と
// 書いていたので、効いていないことが誰にも分からなかった。
//
// 返事は返らない。常駐は台帳とソケットを片付けてから `process.exit` するので、応答の前に接続が
// 切れる。**その切断こそが届いた合図**なので、拒否も成功として扱う。
//
// サービスから切り出してあるのは、ここだけを本物のソケット相手に確かめられるようにするため。

import { createConnection } from 'net';
import { raceTimeout } from '../../../../base/common/async.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { IParadisPtyDaemonControl, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../common/paradisPtyDaemonControl.js';
import { paradisAuthenticateDaemon } from './paradisPtyDaemonAuth.js';

/** 繋ぐのを待つ上限。応答しない相手をいつまでも待たない。 */
const CONNECT_TIMEOUT = 2_000;

/**
 * 頼んでから相手が消えるのを待つ上限。
 *
 * 待つのは返事のためではなく、**要求が送り出されるまで接続を保つため**。
 */
const STOP_TIMEOUT = 3_000;

export type ParadisStopOutcome =
	/** 届いた。相手は片付けて終わる。 */
	| 'stopped'
	/** 誰も答えない。名前だけ残っているか、既に終わっている。 */
	| 'unreachable'
	/** 名乗り合いを通らない。その名前を持っているのが誰なのか分からないので、手を出さない。 */
	| 'not-ours'
	/** 届いたかどうか分からないまま時間切れ。 */
	| 'timeout';

/** 常駐のソケットへ繋ぐ。応答しなければ undefined。状態を聞く側とも共有する。 */
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

/**
 * 常駐へ終了を頼む。**繋いで頼む。番号で殺さない。**
 *
 * 応答しない相手には何もしない。固まっているのか、番号が使い回されたのか区別できないものを
 * 殺してよい理由が無い（`paradisJudgeUnreachableDaemon` と同じ立場）。
 */
export async function paradisAskDaemonToStop(socketPath: string, token: string): Promise<ParadisStopOutcome> {
	const socket = await paradisConnectToDaemon(socketPath);
	if (!socket) {
		return 'unreachable';
	}
	const client = SocketClient.fromSocket(socket, 'paradis-daemon-control');
	try {
		if (!await paradisAuthenticateDaemon(client, token)) {
			return 'not-ours';
		}
		const control = ProxyChannel.toService<IParadisPtyDaemonControl>(client.getChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL));
		const outcome = await raceTimeout(
			control.shutdown().then(() => 'stopped' as const, () => 'stopped' as const),
			STOP_TIMEOUT,
		);
		return outcome ?? 'timeout';
	} finally {
		client.dispose();
	}
}

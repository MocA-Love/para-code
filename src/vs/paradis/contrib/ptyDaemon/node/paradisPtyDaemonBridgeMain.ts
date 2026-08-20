/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウと常駐ターミナルの間に立つ、バイト列を流すだけのプロセス。
//
// なぜ要るのか。ウィンドウ(renderer)はサンドボックスの中に居るのでソケットを開けない。一方
// 常駐はアプリの外に居るので、Electron の MessagePort を渡してもらえない。両方に手が届くのは
// アプリの中で動く Node のプロセスだけで、それがここ。
//
// **なぜ main プロセスにやらせないのか。** できないわけではない。実際 `PtyHostService` は
// main に居て、常駐へは main から繋いでいる。ただしそちらを通るのは低頻度の呼び出しだけで、
// ターミナルの出力そのものは通らない。出力を main に通すと、ビルドのログが流れている間ずっと
// main の JS スレッドが取られ、ウィンドウの操作やメニューが引っかかる。upstream が MessagePort
// 直結にしたのも同じ理由で、そこは崩さない。
//
// **中身を読まない。** ここが解釈するのはフレームの切れ目だけで、その中の呼び出しや
// ターミナルの出力には触れない。MessagePort 側はメッセージの境界を保つので、そのまま
// ソケット側の `Protocol` に渡せば長さ付きの枠に入り、逆も同じ。つまりこのプロセスは
// 「デシリアライズしない中継」で、直結との差は memcpy 1回ぶんしかない。
//
// 状態を持たないので、アプリと一緒に死んでよい。抱えているものはすべて常駐の側にある。

import { createConnection } from 'net';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Protocol as SocketProtocol } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { MessageEvent, MessagePortMain, isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { PARADIS_PTY_DAEMON_SOCKET } from '../common/paradisPtyDaemonEnv.js';

/**
 * ポート1本と、それに対応するソケット1本を繋ぐ。
 *
 * 片側が閉じたらもう片側も閉じる。片方だけ残すと、ウィンドウが閉じたあとも常駐から見ると
 * クライアントが繋がったままになり、**何も抱えていないのに終われない常駐**ができる。
 */
function paradisPipePortToDaemon(port: MessagePortMain, socketPath: string): void {
	const socket = createConnection({ path: socketPath });
	const protocol = new SocketProtocol(new NodeSocket(socket, 'paradis-pty-daemon-bridge'));

	let closed = false;
	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		protocol.dispose();
		socket.destroy();
		port.close();
	};

	// 空のフレームは流さない。接続の後始末で来ることがあり、そのまま渡すと受け手が中身の無い
	// ヘッダーを読もうとして落ちる (`ipc.mp` の Protocol も同じ理由で捨てている)。
	protocol.onMessage(message => {
		if (!closed && message.byteLength > 0) {
			port.postMessage(message.buffer);
		}
	});
	port.on('message', (e: MessageEvent) => {
		const data = e.data as Uint8Array | undefined;
		if (!closed && data && data.byteLength > 0) {
			protocol.send(VSBuffer.wrap(data));
		}
	});

	port.on('close', close);
	socket.on('close', close);
	socket.on('error', close);
	port.start();
}

function paradisStartBridge(): void {
	if (!isUtilityProcess(process)) {
		throw new Error('the pty daemon bridge only runs as an Electron utility process');
	}
	const socketPath = process.env[PARADIS_PTY_DAEMON_SOCKET];
	if (!socketPath) {
		throw new Error(`${PARADIS_PTY_DAEMON_SOCKET} is required to reach the pty daemon`);
	}
	process.parentPort.on('message', (e: MessageEvent) => {
		const port = e.ports.at(0);
		if (port) {
			paradisPipePortToDaemon(port, socketPath);
		}
	});
}

paradisStartBridge();

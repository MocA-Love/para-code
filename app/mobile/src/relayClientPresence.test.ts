/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC の presence が offline→online へ戻ったときに、モバイルが接続を張り直すかどうか。
 *
 * ここを間違えると、**PCから何も知らせる術が無いまま片方向で不通になる**。本番で起きていた
 * 並びは次のとおり: ①モバイルが hello を送る ②PCが response を送出（まだ在空中）
 * ③PCのリレーソケットが 1006 で落ちてPC側セッションが消える ④offline→online のフラップが届く
 * ⑤②の response が届いてハンドシェイクは成功したように見える ⑥直後の requestState が、
 * セッションを失ったPCから hello と誤解されて以降すべて捨てられる。
 * ④で張り直していれば⑥まで進まない。
 */

import { describe, expect, it } from 'vitest';
import { encodeRelayControl, generateIdentity } from '@para/protocol';
import { RelayClient, type PairedCredentials, type SocketLike, type Timers } from './relayClient.js';

class FakeSocket implements SocketLike {
	onopen: (() => void) | null = null;
	onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
	binaryType = 'arraybuffer';
	readonly sent: (string | ArrayBufferView | ArrayBuffer)[] = [];
	readonly closes: { code?: number; reason?: string }[] = [];

	send(data: string | ArrayBufferView | ArrayBuffer): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
		// 本物の WebSocket と同じく、閉じたら onclose が返る。RN はローカル発の close code を
		// 0 に潰すので、テストでもその形に合わせる（再接続の判断がここに乗っている）。
		this.onclose?.({ code: 0 });
	}

	/** リレーからの制御メッセージを流し込む。 */
	deliverPresence(online: boolean): void {
		this.onmessage?.({ data: encodeRelayControl({ type: 'presence', peer: 'pc', online }) });
	}
}

/**
 * 予約されたタイマーを溜めておき、テストが選んで発火させる時計。
 *
 * 素朴に「即実行」にすると、再接続の待ちと一緒に接続タイムアウトまで走ってしまい、
 * 検証したい presence の判断より先にソケットが閉じられる。何を進めるかはテストが決める。
 */
class ManualTimers implements Timers {
	private next = 1;
	private readonly pending = new Map<number, () => void>();

	setTimeout(handler: () => void): ReturnType<typeof setTimeout> {
		const id = this.next++;
		this.pending.set(id, handler);
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void {
		if (handle !== undefined) {
			this.pending.delete(handle as unknown as number);
		}
	}

	/** いちばん古い予約を1つだけ実行する（再接続だけを進めたいときに使う）。 */
	runOldest(): void {
		const entry = this.pending.entries().next();
		if (!entry.done) {
			this.pending.delete(entry.value[0]);
			entry.value[1]();
		}
	}
}

async function connectedClient(timers: Timers = new ManualTimers()): Promise<{ sockets: FakeSocket[]; presence: boolean[] }> {
	const sockets: FakeSocket[] = [];
	const presence: boolean[] = [];
	const credentials: PairedCredentials = {
		relayUrl: 'wss://relay.test',
		deviceId: 'device',
		mobileId: 'mobile',
		mobileToken: 'token',
		pcPublicKey: (await generateIdentity()).publicKey,
	};
	const client = new RelayClient(
		await generateIdentity(),
		credentials,
		() => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		{ onPcPresence: online => presence.push(online) },
		timers,
	);
	client.connect();
	return { sockets, presence };
}

function requireSocket(sockets: readonly FakeSocket[], index: number): FakeSocket {
	const socket = sockets[index];
	if (!socket) {
		throw new Error(`Expected relay socket ${index}, found ${sockets.length}`);
	}
	return socket;
}

describe('RelayClient presence handling', () => {
	it('reconnects when the PC comes back, even while the handshake is still in flight', async () => {
		// mux が無い＝ハンドシェイク中でも張り直すこと。PCは「捨てたセッションの応答」を
		// 送れてしまうので、「muxが無いなら壊れようがない」という前提は成り立たない。
		const { sockets } = await connectedClient();
		const socket = requireSocket(sockets, 0);
		socket.deliverPresence(true);
		socket.deliverPresence(false);
		socket.deliverPresence(true);

		expect(socket.closes).toEqual([{ code: 4002, reason: 'pc restarted' }]);
	});

	it('leaves a freshly opened socket alone when the first presence says the PC is online', async () => {
		// 判定はソケット単位。接続をまたいで持ち越した presence を offline→online と読み違えると、
		// 開いたばかりのソケットを毎回無駄に閉じることになる。
		const { sockets } = await connectedClient();
		const socket = requireSocket(sockets, 0);
		socket.deliverPresence(true);
		socket.deliverPresence(true);

		expect(socket.closes).toEqual([]);
	});

	it('does not carry an offline PC across a reconnect and close the new socket at once', async () => {
		// ソケット1で「PC不在」を見たあと繋ぎ直すと、ソケット2の最初の presence は online で届く。
		// 接続をまたぐ値で判断していると、ここで開いたばかりのソケットを閉じてしまう。
		const timers = new ManualTimers();
		const { sockets } = await connectedClient(timers);
		const firstSocket = requireSocket(sockets, 0);
		firstSocket.deliverPresence(false);
		firstSocket.onclose?.({ code: 1006 });
		// 予約された再接続だけを進める（接続タイムアウトは進めない）。
		timers.runOldest();

		expect(sockets.length).toBeGreaterThan(1);
		const secondSocket = requireSocket(sockets, 1);
		secondSocket.deliverPresence(true);
		expect(secondSocket.closes).toEqual([]);
	});

	it('reports every presence change to the caller', async () => {
		const { sockets, presence } = await connectedClient();
		const socket = requireSocket(sockets, 0);
		socket.deliverPresence(false);
		socket.deliverPresence(true);

		expect(presence).toEqual([false, true]);
	});
});

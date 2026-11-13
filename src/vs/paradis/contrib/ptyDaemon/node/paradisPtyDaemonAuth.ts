/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐と、繋ぎに来た側が名乗り合うところ。

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createConnection, Socket } from 'net';
import { raceTimeout } from '../../../../base/common/async.js';
import { IChannelClient, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { IParadisPtyDaemonAuth, PARADIS_PTY_DAEMON_AUTH_CHANNEL } from '../common/paradisPtyDaemonControl.js';
import { ParadisDaemonCheck } from '../common/paradisPtyDaemonBridgeProtocol.js';
import { paradisReadDaemonRecords } from './paradisPtyDaemonLedger.js';

/** 身元の長さ。総当たりを問題にしない量があればよい。 */
const TOKEN_BYTES = 32;

/** 使い捨ての値の長さ。 */
const NONCE_BYTES = 16;

export function paradisCreateDaemonToken(): string {
	return randomBytes(TOKEN_BYTES).toString('hex');
}

export function paradisCreateNonce(): string {
	return randomBytes(NONCE_BYTES).toString('hex');
}

/**
 * 証明を作る。
 *
 * `role` で向きを分ける。分けないと、**サーバーが返した証明をそのまま次の接続で
 * クライアントの証明として使い回せる**（偽物が本物へ一度繋いで答えをもらい、それを別の
 * 相手に見せる）。同じ nonce でも向きが違えば別の値になるようにしておく。
 */
export function paradisProveDaemonToken(token: string, role: 'client' | 'daemon', nonce: string): string {
	return createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
}

/**
 * 証明を照合する。長さが違えば即座に false、同じなら時間の差が出ない比較を使う。
 *
 * 素直な `===` にしないのは、1文字ずつ比べて違ったところで止まるため、**合っている先頭の
 * 長さが時間に出る**から。1バイトずつ当てていけば総当たりが現実的な回数まで落ちる。
 */
export function paradisProofMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== 'string' || actual.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

/** 常駐の側。繋ぎに来た相手を確かめ、こちらも証明を返す。 */
export class ParadisPtyDaemonAuth implements IParadisPtyDaemonAuth {

	constructor(private readonly token: string) { }

	async authenticate(nonce: string, clientProof: string): Promise<string> {
		if (typeof nonce !== 'string' || nonce.length === 0) {
			throw new Error('the pty daemon needs a nonce to answer with');
		}
		if (!paradisProofMatches(paradisProveDaemonToken(this.token, 'client', nonce), clientProof)) {
			// 何が違ったかは返さない。返すと、当てるための手がかりになる。
			throw new Error('the pty daemon does not know this caller');
		}
		return paradisProveDaemonToken(this.token, 'daemon', nonce);
	}
}

/**
 * 繋ぎに来た側。相手が本物かを確かめる。
 *
 * 失敗したらその接続を使ってはいけない。**名前が取られていた**という意味なので、
 * 繋ぎ直しても同じ相手に当たる。
 */
export async function paradisAuthenticateDaemon(client: IChannelClient, token: string): Promise<boolean> {
	const nonce = paradisCreateNonce();
	try {
		const auth = ProxyChannel.toService<IParadisPtyDaemonAuth>(client.getChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL));
		const daemonProof = await auth.authenticate(nonce, paradisProveDaemonToken(token, 'client', nonce));
		return paradisProofMatches(paradisProveDaemonToken(token, 'daemon', nonce), daemonProof);
	} catch {
		// 答えられない・チャネルが無い・こちらの証明を拒まれた。どれも「本物ではない」で足りる。
		return false;
	}
}

/**
 * {@link paradisAuthenticateDaemon} に期限を付けたもの。
 *
 * 接続は受けるが答えない常駐（イベントループが詰まった、SIGSTOP された等）を待ち続けると、
 * 繋ぎに来た側がそこで止まる。期限切れの `timeout` は「本物ではない」とは分けて返す（呼び出し側は
 * 待ち方を変える）。期限切れでも元の問い合わせは止まらないので、呼び出し側が接続を閉じること。
 */
export async function paradisAuthenticateDaemonWithin(client: IChannelClient, token: string, timeoutMs: number): Promise<ParadisDaemonCheck> {
	const genuine = await raceTimeout(paradisAuthenticateDaemon(client, token), timeoutMs);
	return genuine === undefined ? 'timeout' : genuine ? 'genuine' : 'refused';
}

/**
 * `socketPath` で待ち受けている相手が、台帳（`ledgerDir`）にある常駐の本物かを確かめる。
 *
 * 使い捨ての接続で確かめ、終わったら閉じる。接続から名乗りまでの全体に期限を付け、期限切れでは
 * 開いたものを全部閉じて `timeout` を返す。
 */
export async function paradisCheckDaemonAt(socketPath: string, ledgerDir: string, timeoutMs: number): Promise<ParadisDaemonCheck> {
	let raw: Socket | undefined;
	let client: SocketClient<string> | undefined;
	// 期限を過ぎてから開いたものは、下の finally が閉じ終えた後なので自分で閉じる。
	let abandoned = false;
	const check = async (): Promise<ParadisDaemonCheck> => {
		const records = await paradisReadDaemonRecords(ledgerDir);
		if (abandoned) {
			return 'timeout';
		}
		const socket = await new Promise<NodeSocket | undefined>(resolve => {
			const opened = createConnection({ path: socketPath });
			raw = opened;
			opened.once('connect', () => resolve(new NodeSocket(opened, 'paradis-pty-daemon-auth')));
			opened.once('error', () => { opened.destroy(); resolve(undefined); });
		});
		if (!socket) {
			return 'refused';
		}
		if (abandoned) {
			socket.dispose();
			return 'timeout';
		}
		const opened = SocketClient.fromSocket(socket, 'paradis-bridge');
		client = opened;
		for (const record of records) {
			if (record.socketPath === socketPath && await paradisAuthenticateDaemon(opened, record.token)) {
				return 'genuine';
			}
		}
		return 'refused';
	};
	try {
		return await raceTimeout(check(), timeoutMs) ?? 'timeout';
	} finally {
		// 期限切れのときは名乗りの途中で閉じることになる。待っている問い合わせは失敗し、上の
		// `paradisAuthenticateDaemon` の catch で false になる（結果はもう誰も読まない）。
		abandoned = true;
		client?.dispose();
		raw?.destroy();
	}
}

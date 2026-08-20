/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐と、繋ぎに来た側が名乗り合うところ。

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { IChannelClient, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisPtyDaemonAuth, PARADIS_PTY_DAEMON_AUTH_CHANNEL } from '../common/paradisPtyDaemonControl.js';

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

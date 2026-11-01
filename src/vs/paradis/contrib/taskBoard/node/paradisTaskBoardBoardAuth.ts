/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口の、ボードの確かめ方（shared process。設計書 G1・G2）。
//
// 発見ファイルの Bearer は同じ PC のどのプロセスでも読めるので、それだけでは通さない。要求ごとに
//  1. ボードの鍵（main がボードを起動するたびに作り、ipc で渡したもの）が、窓の登録したものと同じこと
//  2. TCP の相手のプロセスが、その鍵と組で登録されたボードの pid であること（lsof / ss で確かめる。重ねがけ）
// を確かめる。2 は接続ごとに覚える（SSE は長く続き、fetch は keep-alive で接続を使い回すため）。
//
// ボードの登録は、それを開いた窓を閉じても消さない（ボードは窓より長く動く）。新しい登録が来たら置き換え、
// pid が死んでいれば捨てる。

import { createHash, timingSafeEqual } from 'crypto';
import type { Socket } from 'net';
import { IParadisTaskBoardBoardRegistration, paradisTaskBoardIsBoardKey } from '../common/paradisTaskBoardRelay.js';

/** 接続の相手が `pids` のどれかか。確かめられなければ undefined（通さない）。 */
export type ParadisTaskBoardPeerCheck = (clientPort: number, serverPort: number, pids: readonly number[]) => Promise<boolean | undefined>;

/** 確かめた結果。断るときは理由（監査ログ用）。 */
export type ParadisTaskBoardBoardVerdict =
	| { readonly ok: true; readonly keyHash: string; readonly remote: boolean }
	| { readonly ok: false; readonly reason: 'no-board' | 'key-missing' | 'key-mismatch' | 'board-exited' | 'peer-mismatch' | 'peer-unknown' };

interface IRegisteredBoard {
	readonly pid: number;
	readonly keyHash: Buffer;
	/** SSH の窓のボード（main が付けた印）。 */
	readonly remote: boolean;
}

/** 覚えておくボードの数（ボードのホストは 1 つのボードしか持たない。開き直しの重なりの分だけ余裕を持つ）。 */
const MAX_BOARDS = 4;

export function paradisTaskBoardKeyHash(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

export class ParadisTaskBoardBoardAuth {

	/** 新しい順。 */
	private boards: IRegisteredBoard[] = [];
	/** 接続ごとの、確かめ済みの (鍵の hash, pid)。 */
	private readonly verified = new WeakMap<Socket, { readonly keyHash: string; readonly pid: number }>();

	constructor(
		private readonly peerCheck: ParadisTaskBoardPeerCheck,
		private readonly processAlive: (pid: number) => boolean = paradisProcessAlive,
	) { }

	/** 窓から、main の open() が返したボードを登録する。同じ pid の古い登録は置き換える。 */
	register(board: IParadisTaskBoardBoardRegistration): void {
		const keyHash = Buffer.from(paradisTaskBoardKeyHash(board.key), 'hex');
		this.boards = [{ pid: board.pid, keyHash, remote: board.remote === true }, ...this.boards.filter(entry => entry.pid !== board.pid)].slice(0, MAX_BOARDS);
	}

	/** 要求を確かめる。`key` は鍵のヘッダーの値。 */
	async verify(key: string | undefined, socket: Socket, serverPort: number): Promise<ParadisTaskBoardBoardVerdict> {
		this.boards = this.boards.filter(entry => this.processAlive(entry.pid));
		if (this.boards.length === 0) {
			return { ok: false, reason: 'no-board' };
		}
		if (!paradisTaskBoardIsBoardKey(key)) {
			return { ok: false, reason: 'key-missing' };
		}
		const given = Buffer.from(paradisTaskBoardKeyHash(key), 'hex');
		const board = this.boards.find(entry => entry.keyHash.length === given.length && timingSafeEqual(entry.keyHash, given));
		if (!board) {
			return { ok: false, reason: 'key-mismatch' };
		}
		const keyHash = given.toString('hex');
		const cached = this.verified.get(socket);
		if (cached && cached.keyHash === keyHash && cached.pid === board.pid) {
			return { ok: true, keyHash, remote: board.remote };
		}
		const clientPort = socket.remotePort;
		if (typeof clientPort !== 'number' || socket.localPort !== serverPort) {
			return { ok: false, reason: 'peer-unknown' };
		}
		const isBoard = await this.peerCheck(clientPort, serverPort, [board.pid]);
		if (isBoard === undefined) {
			return { ok: false, reason: 'peer-unknown' };
		}
		if (!isBoard) {
			return { ok: false, reason: 'peer-mismatch' };
		}
		this.verified.set(socket, { keyHash, pid: board.pid });
		return { ok: true, keyHash, remote: board.remote };
	}
}

export function paradisProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// EPERM はほかのユーザーのプロセス。ボードは自分のプロセスなので、番号が振り直されたものとして扱う
		return false;
	}
}

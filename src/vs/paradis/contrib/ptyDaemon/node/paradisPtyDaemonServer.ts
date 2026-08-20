/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルが、自分のソケットを開くところ。
//
// ここだけ他と毛色が違うのは、**同じ名前を2人が同時に取りに来る**からで、その扱いを間違えると
// 常駐が2つ立ち上がる。2つ立つと、後から来たウィンドウがどちらに繋がるかで見えるターミナルが
// 変わり、しかもどちらも「正常に動いている」ように見えるので、まず気づけない。
//
// 取り合いの決着は単純に「先に bind できた方が勝ち」。負けた側は**自分を終わらせる**
// (`Taken`)。起こした側は勝った方へ繋ぎ直せばよい。
//
// ややこしいのは unix のソケットファイルが**プロセスが死んでも残る**こと。残骸が残っていると
// bind は `EADDRINUSE` で失敗するが、これは「他人が居る」とは限らない。そこで繋いでみて、
// 応答が無ければ残骸と判断して消してから取り直す。逆に応答があれば本物の先客なので、消しては
// いけない (消すと先客が誰からも見つけられなくなり、抱えているターミナルごと迷子になる)。
//
// Windows の名前付きパイプは持ち主が死ぬと消えるので、この後始末は要らない。

import { createConnection } from 'net';
import { promises as fs } from 'fs';
import { Server as SocketServer, serve } from '../../../../base/parts/ipc/node/ipc.net.js';

/** 先客が居るかを確かめるのに待つ時間。応答しない相手をいつまでも待たない。 */
const PROBE_TIMEOUT = 1000;

export type ParadisServeResult =
	/** 自分が持ち主になれた。 */
	| { readonly outcome: 'bound'; readonly server: SocketServer; readonly notes: readonly string[] }
	/** 生きている先客が居た。自分は退く。 */
	| { readonly outcome: 'taken'; readonly notes: readonly string[] };

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

/**
 * ソケットに誰か居るか。
 *
 * 繋がるかどうかしか見ない。相手が Para Code の常駐かどうかまでは確かめられないが、確かめる
 * 必要も無い。**誰かが待ち受けている名前を横取りしない**ことがここでの目的なので、
 * 「居る」と分かれば十分。
 */
function paradisProbeSocket(socketPath: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let settled = false;
		const done = (alive: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(alive);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => done(false), PROBE_TIMEOUT);
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/**
 * 常駐のソケットを開く。
 *
 * 開けなかった理由が「生きている先客」なら `taken` を返す。呼び出し側はそこで常駐を諦めること
 * (無理に開き直すと、先客のターミナルを奪うことになる)。
 *
 * 記録は `notes` で返す。ここは**ログの仕組みが立ち上がる前**に走るため
 * (`ptyHostMain.ts` は、ログのチャネルを登録する相手であるサーバーをまず作る)、
 * その場では書けない。呼び出し側が logService を作った時点で流し込むこと。取り合いに負けた・
 * 残骸を消した、はどちらも後から原因を追うときに要る情報なので、捨ててはいけない。
 */
export async function paradisServePtyDaemon(socketPath: string): Promise<ParadisServeResult> {
	const notes: string[] = [];
	try {
		return { outcome: 'bound', server: await serve(socketPath), notes };
	} catch (error) {
		if (errorCode(error) !== 'EADDRINUSE') {
			throw error;
		}
	}

	if (await paradisProbeSocket(socketPath)) {
		notes.push(`[ParadisPtyDaemon] another daemon already owns ${socketPath}; standing down`);
		return { outcome: 'taken', notes };
	}

	// 応答が無い＝残骸。消して取り直す。ここで失敗したら、消した直後に他人が入った可能性が
	// あるので、もう一度は試さずに退く (取り合いを繰り返しても勝者は増えない)。
	notes.push(`[ParadisPtyDaemon] clearing a stale socket at ${socketPath}`);
	try {
		await fs.unlink(socketPath);
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') {
			throw error;
		}
	}
	try {
		return { outcome: 'bound', server: await serve(socketPath), notes };
	} catch (error) {
		if (errorCode(error) === 'EADDRINUSE') {
			notes.push(`[ParadisPtyDaemon] lost the race for ${socketPath}; standing down`);
			return { outcome: 'taken', notes };
		}
		throw error;
	}
}

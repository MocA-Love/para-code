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
//
// **残骸の掃除そのものが取り合いになる。** 残骸が残った状態で2つが同時に起きると、両方が
// 「応答なし＝残骸」と判断し、片方が消してから bind し、もう片方が**その新しいソケットを
// 消して**自分の物を置く。負けた側は誰からも届かないソケットで待ち受け続け、自分が外れている
// ことにも気づかない。だから掃除の間だけ札を置いて、1人ずつ通す。

import { createConnection } from 'net';
import { promises as fs } from 'fs';
import { Server as SocketServer, serve } from '../../../../base/parts/ipc/node/ipc.net.js';
import { IParadisBindLock, paradisIsBindLockStale, paradisParseBindLock } from '../common/paradisPtyDaemonPolicy.js';
import { paradisEnsurePtyDaemonDir } from './paradisPtyDaemonLedger.js';
import { dirname } from '../../../../base/common/path.js';

/** 先客が居るかを確かめるのに待つ時間。応答しない相手をいつまでも待たない。 */
const PROBE_TIMEOUT = 1000;

/** 取り合いをやり直す回数。増やしても勝者は増えないので、少なくてよい。 */
const BIND_ATTEMPTS = 3;

/** 掃除中の相手を待つ時間。掃除は unlink と bind だけなので、これで足りる。 */
const BIND_LOCK_WAIT = 200;

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

	// **bind より先に置き場所を作る。** ソケットは台帳と同じ 0700 のディレクトリに置くので
	// (権限を1箇所で守るため)、そこが無いと `listen` は `ENOENT` で落ちる。台帳を書くときにも
	// 作っているが、そちらは bind に成功した後なので間に合わない。
	//
	// 初回起動では必ずこの順で通る。ここを抜かすと**常駐は一度も起動できない**が、標準出力は
	// 捨てられ、ログの仕組みはこの後にしか立たないので、症状は「ターミナルが開かない」だけに
	// なって原因に辿り着けない (実際にそうなった)。
	await paradisEnsurePtyDaemonDir(dirname(socketPath));

	for (let attempt = 1; attempt <= BIND_ATTEMPTS; attempt++) {
		// 素直に取れるなら取る。ほとんどの起動はここで終わる。
		const bound = await paradisTryServe(socketPath);
		if (bound) {
			return { outcome: 'bound', server: bound, notes };
		}

		// 名前は埋まっている。応答があれば本物の先客なので退く。**消してはいけない**
		// (消すと先客が誰からも見つけられなくなり、抱えているターミナルごと迷子になる)。
		if (await paradisProbeSocket(socketPath)) {
			notes.push(`[ParadisPtyDaemon] another daemon already owns ${socketPath}; standing down`);
			return { outcome: 'taken', notes };
		}

		// 応答が無い＝残骸。掃除は1人ずつ通す。
		const lockPath = await paradisAcquireBindLock(socketPath, notes);
		if (!lockPath) {
			// 誰かが掃除中。少し待てば、その相手が先客として応答するようになる。
			await paradisDelay(BIND_LOCK_WAIT);
			continue;
		}
		try {
			// 待っている間に勝者が現れたかもしれない。札を取ってからもう一度確かめる。
			if (await paradisProbeSocket(socketPath)) {
				notes.push(`[ParadisPtyDaemon] another daemon took ${socketPath} while we waited; standing down`);
				return { outcome: 'taken', notes };
			}
			notes.push(`[ParadisPtyDaemon] clearing a stale socket at ${socketPath}`);
			await paradisUnlinkIfPresent(socketPath);
			const rebound = await paradisTryServe(socketPath);
			if (rebound) {
				return { outcome: 'bound', server: rebound, notes };
			}
		} finally {
			await paradisUnlinkIfPresent(lockPath);
		}
	}

	// 札を取っても bind できない状態が続く。原因は分からないが、無理に取り続けても勝者は増えない。
	notes.push(`[ParadisPtyDaemon] could not take ${socketPath} after ${BIND_ATTEMPTS} attempts; standing down`);
	return { outcome: 'taken', notes };
}

/** 取れたらサーバー、名前が埋まっていれば undefined。それ以外の失敗は投げる。 */
async function paradisTryServe(socketPath: string): Promise<SocketServer | undefined> {
	try {
		return await serve(socketPath);
	} catch (error) {
		if (errorCode(error) === 'EADDRINUSE') {
			return undefined;
		}
		throw error;
	}
}

async function paradisUnlinkIfPresent(path: string): Promise<void> {
	try {
		await fs.unlink(path);
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') {
			throw error;
		}
	}
}

function paradisDelay(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function paradisIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === 'EPERM';
	}
}

/**
 * 掃除の札を取る。取れなければ undefined (誰かが掃除中)。
 *
 * 札は `wx` (既にあれば失敗) で作る。「見てから作る」と、見た直後に相手が作る隙間が残る。
 */
async function paradisAcquireBindLock(socketPath: string, notes: string[]): Promise<string | undefined> {
	const lockPath = `${socketPath}.lock`;
	// 1回目で取れなければ、古い札を捨ててもう1回だけ試す。捨てた直後に他人が取ることは
	// あるが、そのときは掃除中の相手が居るということなので、待って出直せばよい。
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(lockPath, 'wx', 0o600);
			try {
				const lock: IParadisBindLock = { pid: process.pid, createdAt: Date.now() };
				await handle.writeFile(JSON.stringify(lock), 'utf8');
			} finally {
				await handle.close();
			}
			return lockPath;
		} catch (error) {
			if (errorCode(error) !== 'EEXIST') {
				throw error;
			}
		}

		const existing = await paradisReadBindLock(lockPath);
		if (!paradisIsBindLockStale(existing, existing !== undefined && paradisIsProcessAlive(existing.pid), Date.now())) {
			return undefined;
		}
		notes.push(`[ParadisPtyDaemon] clearing a stale bind lock at ${lockPath}`);
		await paradisUnlinkIfPresent(lockPath);
	}
	return undefined;
}

async function paradisReadBindLock(lockPath: string): Promise<IParadisBindLock | undefined> {
	try {
		return paradisParseBindLock(JSON.parse(await fs.readFile(lockPath, 'utf8')));
	} catch {
		// 読めない・壊れている札は無いものとして扱う (`paradisIsBindLockStale` が古いと答える)。
		return undefined;
	}
}

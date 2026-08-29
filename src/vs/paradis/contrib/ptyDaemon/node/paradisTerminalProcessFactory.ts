/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナル1本を、常駐に持たせるか自分の中で持つかを決める。**差し替え口の実体。**
//
// `ptyService.ts` の `new TerminalProcess(...)` 1行をここへ向ける。upstream 側の変更は
// その1行と、抱える器の引数の型1行だけで済む。
//
// **プロセスに1つの状態を置いている。** 常駐への接続はこのプロセスに1本あればよく、
// `PtyService` へ引き回すと upstream 側の変更が増える。置き場所を1箇所に決めて、
// そこだけが可変であることを明示しておく。
//
// **常駐が使えないことは、ターミナルが使えないことではない。** 繋げなければ黙って今までどおり
// 自分の中で起こす。ここで諦めずに投げると、常駐まわりの些細な不調がターミナル全滅になる。

import { raceTimeout } from '../../../../base/common/async.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../platform/terminal/common/terminal.js';
import { TerminalProcess } from '../../../../platform/terminal/node/terminalProcess.js';
import { IParadisTerminalProcessLike } from '../common/paradisTerminalProcessLike.js';
import { IParadisPtyHostConnection } from './paradisEnsurePtyHost.js';
import { IParadisTerminalOrigin, ParadisDaemonTerminalProcess } from './paradisDaemonTerminalProcess.js';
import { ParadisPtyDispatch } from './paradisPtyDispatch.js';

/** 引き取る相手。常駐が抱えている1本を名指しする。 */
export interface IParadisAdoptTarget {
	readonly handle: number;
	readonly pid: number;
	readonly title: string;
	/**
	 * すでに終わっていたなら、その終わり方。
	 *
	 * **イベントを待っても来ない。** 閉じている間に走り切ったものは、繋ぎ直したときには
	 * とっくに終わっている。これを渡さないと、器は生きているつもりのまま終了を一度も出さず、
	 * **戻ってきて結果を読むというこの機能の主目的の経路で、肝心の答えが落ちる**。
	 */
	readonly exited: { readonly code: number | undefined } | undefined;
}

/**
 * 常駐への接続。**このプロセスに1つ。**
 *
 * 立ててあるときだけ常駐に持たせる。立っていなければ今までどおり。
 */
let connection: IParadisPtyHostConnection | undefined;

/**
 * 常駐に繋ぐ作業。**進行中はここに居る。**
 *
 * 待つのをターミナルを作るときだけに閉じ込めるための番人。起動そのものを待たせてはいけない:
 * pty ホストのチャネルが登録されるまで、窓から来た要求は `ChannelServer` に溜まるが、
 * **1秒で「Unknown channel」として失敗する**。常駐を起こすのに10秒かかり得る以上、
 * 起動の途中で待つと、常駐を初めて有効にした起動が必ず壊れる。
 */
let arriving: Promise<unknown> | undefined;

/** 接続の生死の見張り。**預け替えたら畳む**（畳まないと購読が積み上がる）。 */
let watching: IDisposable | undefined;

/**
 * 常駐から流れてくるものを配る人。**接続に1つ。**
 *
 * 端末ごとに作ると常駐への購読が端末の数だけ増え、全端末の全出力が本数ぶんソケットを通る
 * （`paradisPtyDispatch.ts`）。
 */
let dispatch: ParadisPtyDispatch | undefined;

/**
 * 常駐を使うと決まったときに、繋いだものをここへ預ける。
 *
 * **切れたら手放す。** 常駐が落ちた後も掴んだままだと、以後に作るターミナルが全部そこへ行こうと
 * して失敗し続ける。手放しておけば、次からは今までどおりこのプロセスの中で起こせる——
 * 常駐が使えないことを、ターミナルが使えないことにしない。
 */
export function paradisUsePtyDaemon(value: IParadisPtyHostConnection | undefined): void {
	watching?.dispose();
	watching = undefined;
	dispatch?.dispose();
	dispatch = undefined;
	connection = value;
	if (!value) {
		return;
	}
	watching = value.client.onDidDispose(() => {
		if (connection !== value) {
			return;
		}
		connection = undefined;
		arriving = undefined;
		dispatch?.dispose();
		dispatch = undefined;
		watching?.dispose();
		watching = undefined;
	});
}

/** 常駐へ繋ぐ作業を預ける。ターミナルを作るときだけ、これの完了を待つ。 */
export function paradisAwaitPtyDaemon(work: Promise<unknown> | undefined): void {
	arriving = work;
}

/**
 * 引き取りが終わるまでの待ち。
 *
 * **配置を聞かれたときに待つためのもの。** 窓は配置を見て繋ぎ先を決めるので、引き取りの途中で
 * 聞かれて空を返すと、その窓は**引き取ったターミナルを一度も見ないまま**進む。あとから終わっても
 * 知らせる手立てが無いので、聞かれた側で待つのが唯一の噛み合わせ方になる。
 */
let settling: Promise<unknown> | undefined;

export function paradisAwaitAdoption(work: Promise<unknown> | undefined): void {
	settling = work;
	settleBy = work === undefined ? undefined : Date.now() + ADOPTION_TIMEOUT;
	// 済んだら待ちを外す。**この待ちは一度きりの口だけを通らない** —— 繋ぎ直しも一覧も毎回
	// ここを通るので、外しておかないと以後ずっと呼ばれるたびにタイマーを1つ起こすことになる。
	// 失敗しても外す（待つ相手がもう居ない点は同じ）。
	work?.then(clear, clear);
	function clear(): void {
		if (settling === work) {
			settling = undefined;
			settleBy = undefined;
		}
	}
}

/**
 * 待つのをやめる時刻。**呼び出しごとではなく、引き取りを預けた時点から数える。**
 *
 * 呼び出しごとに数えると、遅れて来た口がそのつど上限いっぱい待ち直すので、起動が止まる時間は
 * 上限ではなく「上限×口の数」になる。逆に最初の1人が使い切ったところで待ちを捨ててしまうと、
 * **その直後に配置を聞きに来た窓が一切待たずに空を受け取る** —— いちばん待たせたい相手が
 * いちばん待たなくなる。期限を1本にすれば、期限内の全員が待ち、期限を過ぎたら全員が通る。
 */
let settleBy: number | undefined;

/**
 * 引き取りが終わるのを待つ上限。
 *
 * 待つ鎖には常駐の起動待ち（最大10秒）が含まれる。**初めて常駐を起こす起動で、ターミナルの
 * 復元がそれだけ止まるのは重い。** 間に合わなければ諦めて先へ進む — 引き取ったぶんは次に
 * 配置を聞かれたときに出る。
 */
const ADOPTION_TIMEOUT = 3_000;

/** 引き取りが終わるのを待つ。常駐を使っていなければ即座に戻る。 */
export async function paradisAdoptionSettled(): Promise<void> {
	const work = settling;
	if (!work) {
		return;
	}
	const remaining = (settleBy ?? 0) - Date.now();
	if (remaining <= 0) {
		// 期限切れ。**以後は誰も待たない。** 外さないと、常駐が応答しないまま固まったときに
		// **この pty ホストが生きている限り、繋ぎ直しも一覧も毎回待つ**ことになり、「常駐が不調」が
		// 「アプリ全体が重い」に化ける。
		if (settling === work) {
			settling = undefined;
			settleBy = undefined;
		}
		return;
	}
	// 拒否は飲む。引き取れなかったことを、配置を答えられないことにしない。
	await raceTimeout(work.catch(() => { }), remaining);
}

/** いま常駐に持たせているか。引き取りや状態表示が同じ答えを見るための唯一の口。 */
export function paradisPtyDaemonConnection(): IParadisPtyHostConnection | undefined {
	return connection;
}

/**
 * ターミナルの番号と、常駐側の handle の対応。
 *
 * 配置を預けるときに要る。番号はアプリを起こすたびに振り直されるので、**そのまま預けても
 * 次の起動では何も指さない**（`paradisTerminalLayout.ts`）。
 */
const handles = new Map<number, number>();

/** 番号に handle を結び付ける。器ができた時点で呼ぶ。 */
export function paradisRememberHandle(id: number, handle: number): void {
	handles.set(id, handle);
}

export function paradisForgetHandle(id: number): void {
	handles.delete(id);
}

export function paradisHandleOf(id: number): number | undefined {
	return handles.get(id);
}

/**
 * ターミナル1本を作る。`ptyService.ts` の唯一の生成点から呼ばれる。
 *
 * 引数は `TerminalProcess` のコンストラクタと同じ並びにしてある。**呼び出し側の1行を
 * 置き換えるだけで済ませる**ため。
 */
export async function paradisCreateTerminalProcess(
	shellLaunchConfig: IShellLaunchConfig,
	cwd: string,
	cols: number,
	rows: number,
	env: IProcessEnvironment,
	executableEnv: IProcessEnvironment,
	options: ITerminalProcessOptions,
	logService: ILogService,
	productService: IProductService,
	/** 誰のターミナルか。常駐へ預けて、引き取るときに読み戻す。 */
	origin?: IParadisTerminalOrigin,
	/**
	 * 常駐がすでに抱えているものを引き取る場合の相手。
	 *
	 * **常駐に繋がっていないのにこれが渡ってきたら、作れない。** 引き取り先が居ないのに
	 * 新しく起こすと、残っているプロセスは行方不明のまま二重に増えるので、投げて気づかせる。
	 */
	adoptTarget?: IParadisAdoptTarget,
): Promise<IParadisTerminalProcessLike> {
	if (arriving) {
		// 繋ぎ終わるまで待つ。**ここで待つのは安全**で、この時点ではチャネルは登録済み。
		// 拒否は飲む。常駐に繋げなかったことを、ターミナルを作れないことにしない。
		await arriving.catch(() => { });
	}
	if (connection) {
		// 配る人はこの接続に1つ。端末ごとに作ると、常駐への購読が端末の数だけ増える。
		dispatch ??= new ParadisPtyDispatch(connection.host);
		return new ParadisDaemonTerminalProcess(
			connection.host, shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, logService, productService, connection.viewer, origin, connection.client, dispatch, adoptTarget,
		);
	}
	if (adoptTarget) {
		throw new Error('cannot adopt a terminal without a daemon to adopt it from');
	}
	return new TerminalProcess(shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, logService, productService);
}

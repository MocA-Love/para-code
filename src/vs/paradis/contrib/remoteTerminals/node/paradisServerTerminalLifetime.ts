/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拾い直せるターミナルが残っている間は、接続先のサーバーを終了させない。
//
// なぜ要るのか: SSH の起動スクリプトは常に `--enable-remote-auto-shutdown` を付けており、サーバーを
// 生かしている数え上げの対象は拡張ホスト（と実行中のエージェント）だけになっている。ウィンドウを
// 閉じると拡張ホストはその場で終了するので、数が 0 になり **5分でサーバーごと終了する**。
// ターミナルの猶予時間を伸ばしても、その前にサーバーが消えては意味がない。
//
// やり方: 一定間隔で「誰も掴んでいない永続ターミナル」が残っているかを見て、残っていれば
// 終了までのタイマーを延ばす。`delay()` はタイマーが動いているときだけ効くので、ウィンドウが
// 繋がっている間は何もしない。
//
// 数えるのに `listProcesses()` を使うのは、これが「今どの画面にも繋がっていないもの」だけを
// 返すため（＝拾い直しを待っている実体そのもの）。ただし繋がっている画面がある状態で呼ぶと、
// 孤児かどうかを画面へ問い合わせて返事を待つぶん安くない。だから**サーバーが終了へ向かって
// いないときは一切呼ばない**。
//
// 失敗したら延ばさない。判断できないまま延ばし続けると、共有マシンでサーバーが二度と終了しない
// 状態を作ってしまう。延ばせなかったときの実害は「今までどおり終了する」だけで済む。
//
// 延ばし続けるのにも上限を置く。「誰にも掴まれていない」ことは、猶予タイマーが動いていることを
// 意味しない。クライアントが強制終了された、閉じる合図が届かなかった、といった場合のプロセスは
// タイマーを持たないまま残り、自分では消えない。それを理由に延ばし続けると、まさにここで避けたい
// 「サーバーが二度と終了しない」に別の入口から到達する。正しく切り離されたプロセスは猶予時間で
// 自分から片付くので、それを過ぎても残っているものは守る価値が無い、と切れる。
//
// 上限を数えるのに壁時計を使ってはいけない。ターミナル側の猶予は「プロセスが動いていた時間」で
// 数えるので、接続先のマシンがスリープすると壁時計では猶予の方が長くなる。壁時計で上限を測ると、
// まだ猶予の残っている——つまり正しく切り離された——ターミナルを先に見捨てることになる。
//
// ここで守っているターミナルが**もう誰にも拾えない**場合がある。クライアントを更新すると、
// 接続先には別の commit の（＝別ディレクトリ・別プロセスの）サーバーが立ち、そちらへ繋がる。
// 更新前に残したターミナルはこのサーバーの pty host の中にあり、新しいサーバーからは開けない。
// 詳しい理由と、なぜ自動で片付けないのかは common/paradisRemoteTerminalShutdown.ts の
// 「アプリを更新すると、残したターミナルは取り残される」に書いてある。
//
// それを**このサーバー側からは判別できない**。判断に要るのは「クライアントが今どの版を使って
// いるか」で、繋がっていない相手のことは分からない。同じマシンで別 commit のサーバーが動いて
// いるのを見ても足りない——まだ更新していない別のクライアントが、ここへ拾い直しに戻ってくる
// ことがあり、そちらから見れば生きたターミナルだから。見分けられないまま切り上げると、
// このファイルが守ろうとしている「実行中の作業を失わない」を自分で壊すことになる。
// したがってここは何も変えず、取り残された側はクライアントがユーザーへ伝える
// （electron-browser/paradisRemoteTerminalShutdown.contribution.ts）。上限の 24h+5min が
// 過ぎれば、どちらの場合も最後はこのサーバーが自分で終了する。

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPtyService } from '../../../../platform/terminal/common/terminal.js';

/**
 * 見に行く間隔。終了までの猶予（5分）より十分短くする。1回取りこぼしても次で間に合うよう、
 * 猶予のあいだに2回以上は回るようにしておく。
 */
const PARADIS_TERMINAL_LIFETIME_POLL_MS = 2 * 60 * 1000;

/** 終了タイマーを延ばせる相手（サーバーの寿命サービスのうち、ここで使う分だけ）。 */
export interface IParadisServerLifetime {
	/**
	 * 終了タイマーが動いていれば、それを引き直す。動いていなければ何もしない。
	 * ただし「遅延なしで終了する」構成では、その場で終了する意味になる。取り付ける側が
	 * その構成を弾くこと（`registerParadisServerTerminalLifetime` の呼び出し箇所を参照）。
	 */
	delay(): void;
	/** サーバーを生かしている利用者が居るか（＝終了へ向かっていないか）。 */
	readonly hasActiveConsumers: boolean;
}

/** 延ばし続けてよい上限に足す余裕（猶予時間ちょうどだと、片付く直前に切り上げてしまう）。 */
const PARADIS_TERMINAL_LIFETIME_MARGIN_MS = 5 * 60 * 1000;

/** ターミナル側の猶予と同じ数え方（プロセスが動いていた時間）。 */
function processUptimeMs(): number {
	return process.uptime() * 1000;
}

/** ターミナルの生き残りを見て終了タイマーを延ばす役を、サーバーへ取り付ける。 */
export function registerParadisServerTerminalLifetime(
	ptyService: Pick<IPtyService, 'listProcesses'> & { readonly onPtyHostStart: Event<void>; readonly onPtyHostExit: Event<number> },
	lifetime: IParadisServerLifetime,
	terminalGraceTime: number,
	logService: ILogService,
): IDisposable {
	const store = new DisposableStore();
	const maxExtension = terminalGraceTime + PARADIS_TERMINAL_LIFETIME_MARGIN_MS;
	let checking = false;
	let extendingSince: number | undefined;
	let gaveUp = false;
	// ターミナルを扱う相手がまだ起きていないなら、守るべきものはゼロ。ここを見ずに問い合わせると、
	// 一度もターミナルを使っていないサーバーでも、そのためだけに相手を起動してしまう
	// （`listProcesses` は問い合わせ先が居なければ起動する）。
	let ptyHostRunning = false;
	store.add(ptyService.onPtyHostStart(() => { ptyHostRunning = true; }));
	store.add(ptyService.onPtyHostExit(() => { ptyHostRunning = false; }));

	const check = async (): Promise<void> => {
		if (lifetime.hasActiveConsumers) {
			// 繋がっている＝終了へ向かっていない。次に独りになったときは数え直す。
			extendingSince = undefined;
			gaveUp = false;
			return;
		}
		// いずれも「延ばさない」で正しい。前回の問い合わせが返っていない（判断できない）、
		// ターミナルを扱う相手がまだ起きていない（守るものが無い）、一度見捨てた（下記）。
		// 見捨てた後は、直前に引き直した5分のタイマーがそのまま満了して終了する。
		if (checking || !ptyHostRunning || gaveUp) {
			return;
		}
		checking = true;
		try {
			const waiting = await ptyService.listProcesses();
			if (waiting.length === 0) {
				if (extendingSince !== undefined) {
					extendingSince = undefined;
					logService.info('[paradisServerTerminalLifetime] no terminals are waiting to be reclaimed; letting the server shut down');
				}
				return;
			}
			if (extendingSince === undefined) {
				extendingSince = processUptimeMs();
				logService.info(`[paradisServerTerminalLifetime] keeping the server up while ${waiting.length} terminal(s) wait to be reclaimed`);
			} else if (processUptimeMs() - extendingSince > maxExtension) {
				// ここまで残っているのは、切り離しの合図が届かず猶予タイマーを持たないプロセス。
				// 自分では消えないので、これを理由に延ばし続けるとサーバーが永久に終了しない。
				gaveUp = true;
				logService.warn(`[paradisServerTerminalLifetime] ${waiting.length} terminal(s) have outlived the reconnection grace period without a timer of their own; letting the server shut down (this is the only thing that reclaims them, and it can only happen while nobody is connected)`);
				return;
			}
			lifetime.delay();
		} catch (error) {
			// 延ばさない（判断できないまま生かし続けない）。
			onUnexpectedError(error);
		} finally {
			checking = false;
		}
	};

	const timer = setInterval(() => void check(), PARADIS_TERMINAL_LIFETIME_POLL_MS);
	store.add(toDisposable(() => clearInterval(timer)));
	return store;
}

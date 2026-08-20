/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウを閉じるときに、ターミナルのプロセスを残すかどうかの判断を差し込む口。
//
// upstream は「リロードのときだけ残す」と決め打ちしている（`terminalService` の
// `_onBeforeShutdownAsync` と `_onWillShutdown`）。接続先を開いているウィンドウでは、閉じても
// プロセスは接続先のサーバーに残せるので、そこを上書きできるようにする。
//
// 判断の中身（設定を読む、ユーザーに尋ねる）は `src/vs/paradis/` 側に置く。ここに置くのは
// 「聞かれたら答える」という口だけで、upstream 側の変更を import 1行と条件式2か所に抑えるため。
//
// 尋ねるのは非同期なので、閉じる処理の前段（veto できる `onBeforeShutdown`）で `prepare` を
// 済ませ、実際にプロセスを畳む段（同期の `onWillShutdown`）では答えを読むだけにする。

import { Promises, raceTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';

/**
 * 端末のうち、残せるかどうかの判断に要る部分だけ。`ITerminalInstance` を持ち込まないのは、
 * 型の入り口を1つ増やすと import の向きが増えるため（ここは口だけの置き場にしておく）。
 */
export interface IParadisShutdownTerminal {
	/** 接続先の端末か。同じウィンドウの中にも手元の端末は混ざる。 */
	readonly hasRemoteAuthority: boolean;
	/** そもそも残せる端末か（タスク端末などは残せない）。 */
	readonly shouldPersist: boolean;
}

/**
 * 残すかどうかを答える役。**複数居てよい**（接続先のサーバー用と、この PC の常駐用）。
 *
 * 複数居るときの決まりは2つ。
 *
 * 1. **自分が引き受けられない端末には `false` を答えること** (`shouldKeepProcessAlive`)。
 *    全員の答えを OR で束ねるので、引き受けられない端末にうっかり `true` と答えると、
 *    誰も繋ぎ直せない端末が「残す」扱いになり、猶予時間ぶん孤児として残るだけになる。
 * 2. **自分が引き受けるバックエンドについてしか `true` を答えないこと**
 *    (`shouldKeepProcessesAlive`)。こちらの答えは端末ごとではなく `_primaryBackend` 全体に
 *    効く。`true` になると、そのウィンドウでは終了させる側の端末のバッファ保存
 *    (`persistTerminalState`) が飛び、レイアウト情報も消されずに残る。担当外のウィンドウで
 *    `true` を返すと、**自分が一切関わっていない端末の復元を壊す**。
 */
export interface IParadisTerminalShutdownPolicy {
	/**
	 * 閉じる前に一度だけ呼ばれる。ここで設定を読み、必要ならユーザーに尋ねて答えを決めておく。
	 * 閉じる処理を止めないよう、失敗しても投げないこと。
	 */
	prepare(reason: ShutdownReason): Promise<void>;
	/** このウィンドウについて `prepare` で決まった答え。同期で読めること。 */
	shouldKeepProcessesAlive(reason: ShutdownReason): boolean;
	/** その端末を残すか。ウィンドウの答えに加えて、端末ごとの条件を見る。 */
	shouldKeepProcessAlive(reason: ShutdownReason, terminal: IParadisShutdownTerminal): boolean;
	/** 残せなかったことを記録する。閉じた後のウィンドウには何も残らないので、ここだけが手掛かり。 */
	warn(message: string): void;
}

const policies = new Set<IParadisTerminalShutdownPolicy>();

export function paradisRegisterTerminalShutdownPolicy(value: IParadisTerminalShutdownPolicy): IDisposable {
	policies.add(value);
	return toDisposable(() => {
		policies.delete(value);
	});
}

/**
 * 答えを用意する。判断役が居ない・失敗した場合は「残さない」（＝upstream の従来どおり）に倒れる。
 *
 * 例外を外へ出さない。ここは閉じる処理の直列パス上で、投げるとその後の確認や保存まで
 * 巻き添えで飛ぶ。判断できないことの実害は「今までどおりプロセスが終了する」だけ。
 */
export async function paradisPrepareTerminalShutdown(reason: ShutdownReason): Promise<void> {
	// 1つずつ、順に待つ。
	//
	// 並行に走らせると、**画面に出ていないダイアログの待ち時間だけが減る**。ダイアログ自体は
	// 1つずつしか出ない (`DialogHandlerContribution.processDialogs`) ので、後ろに並んだ役は
	// 表示される前から自分の上限を消費し、表示された頃には残りが尽きていて、押した答えが
	// 捨てられることになる。
	//
	// 1つずつ包むのは、投げた1つで残りの `prepare` を止めないため。止めると、尋ねてもいない
	// 答えで端末を畳むことになる。
	for (const current of policies) {
		try {
			await current.prepare(reason);
		} catch (error) {
			onUnexpectedError(error);
		}
	}
}

/**
 * このウィンドウについて用意した答え。`paradisPrepareTerminalShutdown` を通っていなければ false。
 * 端末を1本ずつ畳むかどうかではなく、レイアウトや復元の扱いを決めるのに使う。
 */
export function paradisShouldKeepTerminalProcessesAlive(reason: ShutdownReason): boolean {
	return paradisAnyPolicy(current => current.shouldKeepProcessesAlive(reason));
}

/**
 * その端末を残すか。
 *
 * ウィンドウ単位の答えだけで畳み方を変えてはいけない。接続先を開いているウィンドウの中にも
 * 手元の端末は混ざり得るが、そちらを残しても次に開いたときに繋ぎ直す相手が居ない
 * （手元の pty host に、誰も復元しない孤児として猶予時間ぶん残るだけになる）。
 */
export function paradisShouldKeepTerminalProcessAlive(reason: ShutdownReason, terminal: IParadisShutdownTerminal): boolean {
	return paradisAnyPolicy(current => current.shouldKeepProcessAlive(reason, terminal));
}

/**
 * 1人でも「残す」と答えたら残す。
 *
 * OR で束ねてよいのは、各自が自分の引き受けられる端末にしか `true` を答えないという決まりが
 * あるから（{@link IParadisTerminalShutdownPolicy}）。投げた1人のせいで他の答えを落とさない。
 */
function paradisAnyPolicy(ask: (policy: IParadisTerminalShutdownPolicy) => boolean): boolean {
	let keep = false;
	for (const current of policies) {
		try {
			keep = ask(current) || keep;
		} catch (error) {
			onUnexpectedError(error);
		}
	}
	return keep;
}

/** 「残す」の合図が届くのを待つ上限。生きている接続なら1往復で済むので、これで十分足りる。 */
const PARADIS_KEEP_DETACH_TIMEOUT_MS = 5_000;

/**
 * 「残す」の合図が接続先へ届くのを待つ。閉じる処理へ `join` するのはこれ。
 *
 * **必ず上限を付ける。** 閉じる処理の待ち合わせには打ち切りが無く（打ち切る `force()` を呼ぶ側が
 * どこにも居ない）、`RemotePty.detach` は起動に失敗した端末では最初の待ちから進まないし、接続が
 * 切れていれば返事も返らない。上限が無いと、そのままウィンドウが永久に閉じない。
 *
 * 1本の失敗で他を見捨てない。閉じている最中にシェルが終了した端末は「そんな pty は無い」で失敗
 * するが、それに巻き込んで他の端末の合図を送らずに閉じると、送れなかったぶんが猶予タイマーを
 * 持たないまま接続先に残る。
 *
 * 届かなかったぶんは接続先に残るが、猶予タイマーが動かない。片付くのは**サーバーが終了するとき
 * だけ**で、それは誰も繋いでいない時間ができて初めて起きる。毎日使う接続先ではそのまま残り続ける
 * （そこは受け入れている。上限を外して待ち続け、ウィンドウが閉じなくなる方が悪い）。
 */
export function paradisJoinKeptDetaches(detaches: readonly Promise<void>[]): Promise<void> {
	// 全員に配る。どの役の端末が届かなかったかまでは分けられない (待っているのは
	// `detachProcessAndDispose` の約束の束で、そこに出どころは残っていない)。だから文言に
	// 行き先を書かない。「接続先へ伝えられなかった」と書くと、常駐へ残した端末の話にも
	// 同じ文が出て、ログを読む側を誤らせる。
	const warn = (message: string) => {
		for (const current of policies) {
			try {
				current.warn(message);
			} catch (error) {
				onUnexpectedError(error);
			}
		}
	};
	return raceTimeout(
		Promises.settled(detaches.slice()).then(() => undefined, error => warn(`Para Code could not ask for every terminal to be kept: ${error}`)),
		PARADIS_KEEP_DETACH_TIMEOUT_MS,
		() => warn('Para Code could not ask for its terminals to be kept in time; closing anyway'),
	).then(() => undefined);
}

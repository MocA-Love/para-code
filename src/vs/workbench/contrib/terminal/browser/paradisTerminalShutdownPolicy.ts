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

let policy: IParadisTerminalShutdownPolicy | undefined;

export function paradisRegisterTerminalShutdownPolicy(value: IParadisTerminalShutdownPolicy): IDisposable {
	policy = value;
	return toDisposable(() => {
		if (policy === value) {
			policy = undefined;
		}
	});
}

/**
 * 答えを用意する。判断役が居ない・失敗した場合は「残さない」（＝upstream の従来どおり）に倒れる。
 *
 * 例外を外へ出さない。ここは閉じる処理の直列パス上で、投げるとその後の確認や保存まで
 * 巻き添えで飛ぶ。判断できないことの実害は「今までどおりプロセスが終了する」だけ。
 */
export async function paradisPrepareTerminalShutdown(reason: ShutdownReason): Promise<void> {
	try {
		await policy?.prepare(reason);
	} catch (error) {
		onUnexpectedError(error);
	}
}

/**
 * このウィンドウについて用意した答え。`paradisPrepareTerminalShutdown` を通っていなければ false。
 * 端末を1本ずつ畳むかどうかではなく、レイアウトや復元の扱いを決めるのに使う。
 */
export function paradisShouldKeepTerminalProcessesAlive(reason: ShutdownReason): boolean {
	try {
		return policy?.shouldKeepProcessesAlive(reason) === true;
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}

/**
 * その端末を残すか。
 *
 * ウィンドウ単位の答えだけで畳み方を変えてはいけない。接続先を開いているウィンドウの中にも
 * 手元の端末は混ざり得るが、そちらを残しても次に開いたときに繋ぎ直す相手が居ない
 * （手元の pty host に、誰も復元しない孤児として猶予時間ぶん残るだけになる）。
 */
export function paradisShouldKeepTerminalProcessAlive(reason: ShutdownReason, terminal: IParadisShutdownTerminal): boolean {
	try {
		return policy?.shouldKeepProcessAlive(reason, terminal) === true;
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
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
	const warn = (message: string) => {
		try {
			policy?.warn(message);
		} catch (error) {
			onUnexpectedError(error);
		}
	};
	return raceTimeout(
		Promises.settled(detaches.slice()).then(() => undefined, error => warn(`Para Code could not tell the remote to keep every terminal: ${error}`)),
		PARADIS_KEEP_DETACH_TIMEOUT_MS,
		() => warn('Para Code could not tell the remote to keep its terminals in time; closing anyway'),
	).then(() => undefined);
}

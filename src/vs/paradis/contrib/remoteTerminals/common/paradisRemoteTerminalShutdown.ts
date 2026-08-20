/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウを閉じるときに、接続先のターミナルを残すかどうかの判断（純粋な部分）。
//
// 尋ねる・設定を書く・端末を数えるといった副作用は呼び出し側に置き、ここには「どういうときに
// 残す／終える／尋ねる」だけを書く。閉じる処理の直列パス上にある判断なので、条件が1つ抜けても
// 気づきにくく（実機で確かめるには毎回ウィンドウを閉じることになる）、ここだけは単体で
// 確かめられるようにしておく。

import { ParadisKeepTerminalsChoice, ParadisTerminalKeepPlan, paradisParseKeepTerminalsChoice, paradisPlanTerminalKeep, paradisRememberedKeepChoice } from '../../../common/paradisTerminalKeepPlan.js';

/**
 * 閉じたときに接続先のターミナルをどうするか、というユーザーの設定。
 *
 * 判断そのものは `vs/paradis/common/paradisTerminalKeepPlan.ts` に移してある。同じ判断を
 * この PC の常駐 (pty デーモン) 側でも使うためで、ここに残っているのは接続先向けの名前と、
 * 「接続先か」を「残せる置き場所があるか」へ読み替える部分だけ。
 */
export type ParadisKeepRemoteTerminalsChoice = ParadisKeepTerminalsChoice;

export interface IParadisRemoteTerminalShutdownInput {
	/** 接続先（SSH など）を開いているウィンドウか。ローカルのウィンドウには関わらない。 */
	readonly hasRemoteAuthority: boolean;
	readonly isReload: boolean;
	readonly isQuit: boolean;
	readonly choice: ParadisKeepRemoteTerminalsChoice;
	/** 残せるターミナルの本数（表示中・背面・別スペースへ待避中を合わせた数）。 */
	readonly persistentTerminalCount: number;
}

export type ParadisRemoteTerminalShutdownPlan = ParadisTerminalKeepPlan;

export function paradisPlanRemoteTerminalShutdown(input: IParadisRemoteTerminalShutdownInput): ParadisRemoteTerminalShutdownPlan {
	return paradisPlanTerminalKeep({
		// 接続先を開いていることが、ここでの「残せる置き場所がある」。
		canOutliveWindow: input.hasRemoteAuthority,
		isReload: input.isReload,
		isQuit: input.isQuit,
		choice: input.choice,
		persistentTerminalCount: input.persistentTerminalCount,
	});
}

/** 覚えておく選択（尋ねた結果を設定へ書き戻すときの値）。 */
export function paradisRememberedChoice(keep: boolean): ParadisKeepRemoteTerminalsChoice {
	return paradisRememberedKeepChoice(keep);
}

/** 設定値を読む。想定外の値は既定（毎回尋ねる）へ倒す。 */
export function paradisParseKeepRemoteTerminalsChoice(value: unknown): ParadisKeepRemoteTerminalsChoice {
	return paradisParseKeepTerminalsChoice(value);
}


// --- アプリを更新すると、残したターミナルは取り残される ----------------------------------------
//
// 接続先のサーバーは版ごとに別物として入る。`product.json` の serverDownloadUrlTemplate が
// `${commit}` を含むため、置き場所は `~/.para-code-server/bin/<commit>/` と版ごとに分かれ、
// 起動されるのも版ごとに別プロセスになる（これは意図した作りで、クライアントとサーバーの
// 版ずれを原理的に防いでいる）。
//
// その結果、「残す」と「更新」が噛み合わない:
//
//   1. ターミナルを残してウィンドウを閉じる → 前の版のサーバーがそれを抱えたまま生き続ける
//   2. Para Code を更新する
//   3. 同じ接続先へ繋ぎ直す → 新しい版のサーバーが立ち上がり、そちらへ繋がる
//
// 3 のサーバーは 1 のサーバーの pty host を知らない。残したターミナルは前の版のプロセスの中に
// あり、新しい版からは**二度と開けない**。
//
// 直せないのはなぜか: 拾い直しの経路は「同じサーバーの pty host に繋ぎ直す」しかなく、これは
// 版が変わった時点で成立しない。前の版のサーバーを新しい版から乗っ取ることもできない
// （pty host はそのサーバーの子プロセスで、外から引き継ぐ口が無い）。前の版のサーバーを
// 自動で終了させるのも避けている——同じ接続先へ、まだ更新していない別のクライアントが
// 繋ぎに戻ってくることがあり、そちらから見れば拾い直せるターミナルだから。**取り残された
// ものは、猶予時間が尽きて自分から片付くのを待つしかない。**
//
// できるのは、そうなったと分かった時点でユーザーへ伝えることだけ。判断に要るのは
// 「残したときの版」と「今の版」の2つで、どちらもクライアント側が知っている。前の版の
// サーバーへ問い合わせる必要は無い（問い合わせられもしない）。

/** ターミナルを残したまま閉じたときに、クライアント側へ控えておく記録。 */
export interface IParadisKeptRemoteTerminals {
	/** 残したときに動いていた Para Code の版（`product.commit`）。これが変わると回収できない。 */
	readonly commit: string;
	/** 残したときの時刻。猶予が尽きたあとの遅い通知を抑えるのに使う。 */
	readonly at: number;
	/** 残した本数。最後に閉じたウィンドウのぶんで、ログの手掛かり用。 */
	readonly count: number;
}

export interface IParadisStrandedTerminalNoticeInput {
	/** 控えてあった記録（無ければ undefined）。 */
	readonly record: IParadisKeptRemoteTerminals | undefined;
	/** 今の Para Code の版。ソースから動かしている場合は undefined。 */
	readonly commit: string | undefined;
	readonly now: number;
	/** ターミナルへ与えている猶予時間。これを過ぎた記録は、更新の有無に関わらず意味が無い。 */
	readonly graceTime: number;
}

/**
 * 「前の版で残したターミナルは引き継げない」と伝えるべきか。
 *
 * 版が同じなら伝えない（拾い直せるので何も起きていない）。版が分からない
 * （ソースから動かしている）ときも伝えない——版で区切られた置き場所そのものが無く、
 * 判断の根拠が無いため。
 */
export function paradisShouldReportStrandedTerminals(input: IParadisStrandedTerminalNoticeInput): boolean {
	const { record, commit, now, graceTime } = input;
	if (record === undefined || typeof record.commit !== 'string' || record.commit.length === 0) {
		return false;
	}
	if (typeof commit !== 'string' || commit.length === 0 || record.commit === commit) {
		return false;
	}
	if (!(record.count > 0)) {
		return false;
	}
	// 猶予が尽きていれば、更新していなくても同じように消えている。更新のせいだと伝えると
	// かえって誤解させる。時計が巻き戻った場合 (now < at) も、判断できないので黙る。
	const elapsed = now - record.at;
	return elapsed >= 0 && elapsed <= graceTime;
}

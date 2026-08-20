/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウを閉じるときに、ターミナルのプロセスを残すか終わらせるかの判断。
//
// この判断が要るのは「閉じてもプロセスが生き残れる置き場所がある」場合だけで、Para Code には
// それが2つある。接続先 (SSH) のサーバーと、この PC の常駐 (pty デーモン)。**どちらも
// 判断の中身は同じ**なので、ここに1つ置いて両方から使う。
//
// 別々に書くと必ずずれる。ずれ方は「片方だけ尋ねる」「片方だけ残る」で、どちらもユーザーから
// 見ると挙動が説明できなくなる。置き場所が違うのは実装の都合で、利用者にとっては
// 「閉じたらターミナルを残すか」の1問でしかない。

/** 閉じたときにターミナルをどうするか、というユーザーの設定。 */
export type ParadisKeepTerminalsChoice = 'ask' | 'always' | 'never';

export interface IParadisTerminalKeepInput {
	/**
	 * そもそも残せる置き場所があるか。接続先を開いていない・常駐が動いていないウィンドウには
	 * 関わらない。残しても繋ぎ直す相手が居ないので、孤児を作るだけになる。
	 */
	readonly canOutliveWindow: boolean;
	/**
	 * 閉じる理由がリロードか。リロードは upstream が既にプロセスを残すので、ここは何もしない
	 * （重ねて尋ねると、リロードのたびにダイアログが出るだけになる）。
	 */
	readonly isReload: boolean;
	/**
	 * アプリごと終了しようとしているか。
	 *
	 * ここでは尋ねない。終了は開いているウィンドウすべてで同時に起きるので、尋ねるとウィンドウの
	 * 数だけダイアログが並び、しかも背面のウィンドウのダイアログは見えないまま終了できなくなる。
	 * 覚えている選択があればそれに従い、無ければ残す側へ倒す（残したものは猶予時間で片付くが、
	 * 終わらせた作業は戻らない）。
	 */
	readonly isQuit: boolean;
	readonly choice: ParadisKeepTerminalsChoice;
	/** 残せるターミナルの本数（表示中・背面・別スペースへ待避中を合わせた数）。 */
	readonly persistentTerminalCount: number;
}

/** `end` = 今までどおりプロセスを終える / `keep` = 残す / `ask` = ユーザーに尋ねる。 */
export type ParadisTerminalKeepPlan = 'end' | 'keep' | 'ask';

export function paradisPlanTerminalKeep(input: IParadisTerminalKeepInput): ParadisTerminalKeepPlan {
	if (!input.canOutliveWindow || input.isReload || input.choice === 'never') {
		return 'end';
	}
	// 残す相手が居ないなら尋ねない。数えるのは待避中も含めた全部なので、「見えている端末が
	// 無いだけ」と「本当に1本も無い」を取り違えない。
	if (input.persistentTerminalCount === 0) {
		return 'end';
	}
	if (input.choice === 'always') {
		return 'keep';
	}
	return input.isQuit ? 'keep' : 'ask';
}

/** 覚えておく選択（尋ねた結果を設定へ書き戻すときの値）。 */
export function paradisRememberedKeepChoice(keep: boolean): ParadisKeepTerminalsChoice {
	return keep ? 'always' : 'never';
}

/** 設定値を読む。想定外の値は既定（毎回尋ねる）へ倒す。 */
export function paradisParseKeepTerminalsChoice(value: unknown): ParadisKeepTerminalsChoice {
	return value === 'always' || value === 'never' ? value : 'ask';
}

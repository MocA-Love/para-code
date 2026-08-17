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

/** 閉じたときに接続先のターミナルをどうするか、というユーザーの設定。 */
export type ParadisKeepRemoteTerminalsChoice = 'ask' | 'always' | 'never';

export interface IParadisRemoteTerminalShutdownInput {
	/** 接続先（SSH など）を開いているウィンドウか。ローカルのウィンドウには関わらない。 */
	readonly hasRemoteAuthority: boolean;
	/**
	 * 閉じる理由がリロードか。リロードは upstream が既にプロセスを残すので、ここは何もしない
	 * （重ねて尋ねると、リロードのたびにダイアログが出るだけになる）。
	 */
	readonly isReload: boolean;
	/**
	 * アプリごと終了しようとしているか。
	 *
	 * ここでは尋ねない。終了は開いているウィンドウすべてで同時に起きるので、尋ねると接続先の
	 * ウィンドウの数だけダイアログが並び、しかも背面のウィンドウのダイアログは見えないまま
	 * 終了できなくなる。覚えている選択があればそれに従い、無ければ残す側へ倒す
	 * （残したものは猶予時間で片付くが、終わらせた作業は戻らない）。
	 */
	readonly isQuit: boolean;
	readonly choice: ParadisKeepRemoteTerminalsChoice;
	/** 残せるターミナルの本数（表示中・背面・別スペースへ待避中を合わせた数）。 */
	readonly persistentTerminalCount: number;
}

/**
 * `end` = 今までどおりプロセスを終える / `keep` = 接続先へ残す / `ask` = ユーザーに尋ねる。
 */
export type ParadisRemoteTerminalShutdownPlan = 'end' | 'keep' | 'ask';

export function paradisPlanRemoteTerminalShutdown(input: IParadisRemoteTerminalShutdownInput): ParadisRemoteTerminalShutdownPlan {
	if (!input.hasRemoteAuthority || input.isReload || input.choice === 'never') {
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
export function paradisRememberedChoice(keep: boolean): ParadisKeepRemoteTerminalsChoice {
	return keep ? 'always' : 'never';
}

/** 設定値を読む。想定外の値は既定（毎回尋ねる）へ倒す。 */
export function paradisParseKeepRemoteTerminalsChoice(value: unknown): ParadisKeepRemoteTerminalsChoice {
	return value === 'always' || value === 'never' ? value : 'ask';
}

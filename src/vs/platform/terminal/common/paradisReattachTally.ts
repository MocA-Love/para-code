/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したときの繋ぎ直しの結果（pty ホストが数え、ウィンドウが Sentry へ送る）。
// 数えるのは `vs/paradis/contrib/ptyDaemon/node/paradisReattachTally.ts`、送るのは同じ場所の
// `electron-browser/paradisReattachDiagnostics.contribution.ts`。`IPtyService` の形に出てくるので、
// platform から paradis を読まずに済むようここに置く。

export interface IParadisReattachTally {
	/** この起動で最初に聞かれたか。引き取りの数はこのときだけ入る。 */
	readonly firstTake: boolean;
	/** 常駐に問い合わせられたか。false なら引き取りの数は 0 のまま意味を持たない。 */
	readonly reachable: boolean;
	/** 常駐から引き取った本数。 */
	readonly adopted: number;
	/** 引き取れず常駐に残った本数。 */
	readonly leftBehind: number;
	/** このワークスペースで、保存した画面から起こし直した本数（前に渡してからの分）。 */
	readonly revived: number;
	/** そのうち、誰も繋ぎに来なかった本数（画面が戻らず、見えない複製になったもの）。 */
	readonly revivedUnclaimed: number;
}

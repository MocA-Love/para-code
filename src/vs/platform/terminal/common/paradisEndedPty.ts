/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「その端末はもう終わっている」と pty host が言い切れたときの番号。
//
// `PARADIS_UNRESOLVABLE_PTY_ID`（-1）は「正体が確かめられないので繋がない」。こちらは「nonce の
// 端末がこの pty host のどこにも無く、常駐の側にも残っていないと確かめられた」。どちらも存在しない
// 番号なので、繋ごうとすれば失敗し、upstream は新しいシェルを起こす（`terminalProcessManager.ts`）。
// 違いは窓の側の扱いで、こちらはスペースの保存状態から戻すタブなら、空のシェルにせず閉じる
// （`workspaceSwitch/browser/paradisEndedTerminalRestore.contribution.ts`）。

/** nonce の端末が終わっていると確かめられたときに `getRevivedPtyNewId` が返す番号。 */
export const PARADIS_ENDED_PTY_ID = -2;

/**
 * fork がわざと返す「存在しない番号」か。これらへの attach の失敗は、繋ぎ直しの失敗として数えない
 * （取り違えを避けるため、または終わっていると分かっているために、繋がないと決めた結果）。
 */
export function paradisIsIntentionalMissingPtyId(id: number): boolean {
	return id < 0;
}

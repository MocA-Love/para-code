/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use が「コマンドを打てるアプリ」（ターミナル類・スクリプトエディタなど。paradisComputerUse.ts の
// PARADIS_COMPUTER_USE_COMMAND_APPS）へ入力を送った時刻を、ウィンドウごとに覚える。
//
// Computer Use は Para Code 自身を操作できない（常に断る一覧）。ただ、利用者が操作を許したターミナルへ
// `osascript` を打たせれば、そのスクリプトが Para Code の承認の画面（ページの共有・端末の割り当て・Computer Use の
// アプリの許可）のボタンを押せる。承認の画面は、この時計を見て、そういう入力の最中と直後の承認を確定させずに聞き直す
// （agentBrowser/electron-browser/paradisAgentBrowserTabsService.ts の `_promptApproval`）。
//
// 塞ぎ切れない: スクリプトが待ってから押せば、この時間の外になる。承認の画面は、合成の入力かどうかを見分けられない
// （NOTES.md の「Computer Use の間接の経路」）。

/** コマンドを打てるアプリへの入力から、承認を確定させない時間。 */
export const PARADIS_COMPUTER_USE_COMMAND_INPUT_GUARD_MS = 10_000;

let lastCommandInputAt: number | undefined;

/** コマンドを打てるアプリへ入力を送った（shared process の知らせを受けた）。 */
export function paradisNoteComputerUseCommandInput(now: number = Date.now()): void {
	lastCommandInputAt = now;
}

/** コマンドを打てるアプリへの入力が、`since`（承認の画面を出した時刻）より後か、今から `guardMs` 以内にあったか。 */
export function paradisComputerUseCommandInputNear(since: number, now: number = Date.now(), guardMs: number = PARADIS_COMPUTER_USE_COMMAND_INPUT_GUARD_MS): boolean {
	return lastCommandInputAt !== undefined && (lastCommandInputAt >= since || now - lastCommandInputAt < guardMs);
}

/** 覚えた時刻を消す（テスト用）。 */
export function paradisResetComputerUseCommandInput(): void {
	lastCommandInputAt = undefined;
}

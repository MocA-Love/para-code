/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Codex の承認のカードと通知を出すまで待つ時間。
 *
 * Codex は PermissionRequest の hook を自動の審査（`approvals_reviewer = "auto_review"`）より前に呼ぶので、hook を受けた
 * 瞬間にカードを出すと、審査が数秒で許可する承認まで毎回カードとプッシュになる（モバイルからは答えられない）。審査の
 * 9 割は 7 秒以内に終わる（実データ 7667 件。中央値 2.8 秒）ので、この間に許可・拒否・ターンの終わりで決着した承認は
 * 出さない。Claude Code の承認は待たない。
 */
export const PARADIS_CODEX_APPROVAL_HOLD_MS = 8_000;

/** 待っている承認の通知を、待ち終わってから確かめるまでの余裕（カードを出す処理が先に済むように）。 */
export const PARADIS_CODEX_APPROVAL_NOTIFY_SLACK_MS = 300;

/**
 * 待たせた承認の通知を、待ち終えた後に出すか。カードが出ていれば出す。出す前に承認が決着した（自動の審査が許可・拒否した、
 * ターンが終わった）なら捨てる。どちらでもない（カードを作らなかった承認など）は今までどおり出す。
 */
export function paradisShouldSendHeldApprovalNotify(state: { readonly cardShown: boolean; readonly settledWhileHeld: boolean }): boolean {
	return state.cardShown || !state.settledWhileHeld;
}

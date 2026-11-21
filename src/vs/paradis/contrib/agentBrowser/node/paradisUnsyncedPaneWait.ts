/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// まだ同期していないだけかもしれないペインからの MCP の要求を、断らずに待つ。
//
// 窓の再読み込みやアプリの起動の直後は、窓の一覧（どのトークンがどのペインか）が shared process へ
// 届くまで、受け口はそのトークンを知らない。以前はここで即 404 を返していたので、エージェントの
// 道具の呼び出しが「para-browser が無い」で失敗していた。
//
// 待つのは直結の要求（接続先に受け口の無い古い REH と、手元のペイン）だけ。接続先の受け口から来た
// 要求にはすぐ「同期前かも」と答え、待つのは受け口に任せる（受け口は PC が 2 台あるときに次の PC を
// 試すので、こちらが知らないトークンを抱えて待つと止まる）。

/**
 * 待つ上限。本文を受け取りきるまでの守り（30 秒）より短くする（待っている間は本文を読まない）。
 */
export const PARADIS_UNSYNCED_PANE_WAIT_LIMIT_MS = 25_000;

const STEP_MS = 250;

/**
 * ペインが同期されるまで待つ。
 *
 * @param capture 同期済みなら値を返す（受け口の lease）。まだなら undefined
 * @param stillPossible 「同期前かも」と言える間は true。終わったペイン・猶予を過ぎたら false
 * @param isGone 相手が切れたら true（待つのをやめる）
 * @returns 同期されたらその値。待っても来なかったら undefined
 */
export async function paradisWaitForUnsyncedPane<T>(
	capture: () => T | undefined,
	stillPossible: () => boolean,
	isGone: () => boolean,
	limitMs = PARADIS_UNSYNCED_PANE_WAIT_LIMIT_MS,
	sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
	now: () => number = Date.now,
): Promise<T | undefined> {
	const deadline = now() + limitMs;
	for (; ;) {
		const value = capture();
		if (value !== undefined) {
			return value;
		}
		if (isGone() || !stillPossible() || now() >= deadline) {
			return undefined;
		}
		await sleep(STEP_MS);
	}
}

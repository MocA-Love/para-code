/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続が切れたあと、ターミナルのプロセスをどれだけ待つか。
//
// upstream はこれを「接続の猶予時間」と同じ値にしている（既定3時間）。1つの値で足りていたのは
// 「切断＝一時的な回線の途切れ」を想定しているためで、ウィンドウを閉じて翌日また繋ぐ、という
// 使い方は想定に無い。
//
// 2つを分けるのは、待たせるものの重さが違うから。接続の猶予が抱えているのは拡張ホスト
// （プロセス1つぶんの実体）で、戻ってこない人のぶんを何時間も抱え続けるのは高くつく。しかも
// 期限切れで失うのは繋ぎ直しの速さだけで、次に接続すれば作り直される。一方ターミナルの側は、
// 期限が切れると実行中の作業ごと消える——取り返しがつかない。だから待つ長さを変える。
//
// `--reconnection-grace-time` が明示されていればそれに従う（利用者が決めた値を上書きしない）。

/** 明示指定が無いときにターミナルへ与える猶予時間。翌日戻ってくる使い方を想定した長さ。 */
export const PARADIS_TERMINAL_RECONNECTION_GRACE_TIME = 24 * 60 * 60 * 1000; // 24hrs

/**
 * ターミナル（永続プロセス）の猶予時間を決める。
 *
 * @param rawArgument `--reconnection-grace-time` の生の値。指定されていれば、そちらを尊重する。
 * @param connectionGraceTime 接続に使う猶予時間（上の引数を解釈した結果）。
 */
export function paradisTerminalReconnectionGraceTime(rawArgument: string | undefined, connectionGraceTime: number): number {
	// 明示指定は素通し。0（＝残さない）も意図的な指定なので、こちらで伸ばさない。
	if (paradisHasExplicitGraceTime(rawArgument)) {
		return connectionGraceTime;
	}
	// 既定どうしの比較。接続側の既定の方が長い構成になっても、短くしない。
	return Math.max(connectionGraceTime, PARADIS_TERMINAL_RECONNECTION_GRACE_TIME);
}

/**
 * `--reconnection-grace-time` が「採用された」と言えるか。
 *
 * 判定は `serverEnvironmentService` の `parseGraceTime` と同じでなければならない。片方だけが
 * 「採用された」と見ると、既定へ落ちたはずの値を明示指定として扱い、伸ばすべき場面で伸ばさない
 * （あるいはその逆）になる。あちらは値を返し、こちらは採否だけを返すので、条件をここに写している。
 */
function paradisHasExplicitGraceTime(rawArgument: string | undefined): boolean {
	if (typeof rawArgument !== 'string' || rawArgument.trim().length === 0) {
		return false;
	}
	const parsedSeconds = Number(rawArgument);
	if (!isFinite(parsedSeconds) || parsedSeconds < 0) {
		return false;
	}
	const millis = Math.floor(parsedSeconds * 1000);
	return isFinite(millis) && millis <= Number.MAX_SAFE_INTEGER;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC からリレーへの再接続の間隔（Orca `mobile/src/transport/mobile-relay-retry-delays.ts` と同じ式）。
//
// 以前はジッタ無しの `500*2^n`（上限30秒）だったので、リレーの更新で全 PC が同時に切れると
// 全員が同じ時刻に張り直しに来ていた。さらに onopen で回数を 0 に戻していたため、繋がった直後に
// 落ちる経路では 0.5 秒間隔の張り直しが続いた。いまは完全ジッタ（[0, 上限) の一様乱数）にし、
// 回数を戻すのは接続が一定時間続いてからにする。

/** 張り直しの間隔の下限。0 に近い値が続いて空回りしないため。 */
export const PARADIS_RELAY_RETRY_MIN_MS = 250;
/** 1回目の上限。回数ごとに倍になる。 */
export const PARADIS_RELAY_RETRY_BASE_MS = 500;
/** 上限の上限。 */
export const PARADIS_RELAY_RETRY_CEILING_MS = 30_000;
/** 繋がってからこの時間続いたら、失敗の回数を 0 に戻す。 */
export const PARADIS_RELAY_STABLE_CONNECTION_MS = PARADIS_RELAY_RETRY_CEILING_MS;

/**
 * 連続失敗 `consecutiveFailures` 回目（1 始まり）の後に待つ時間。完全ジッタで、下限は
 * {@link PARADIS_RELAY_RETRY_MIN_MS}。
 * @param random [0, 1) の乱数（テストで差し替える）
 */
export function paradisRelayReconnectDelayMs(consecutiveFailures: number, random: () => number = Math.random): number {
	const exponent = Math.max(0, consecutiveFailures - 1);
	const cap = Math.min(PARADIS_RELAY_RETRY_CEILING_MS, PARADIS_RELAY_RETRY_BASE_MS * 2 ** exponent);
	return Math.max(PARADIS_RELAY_RETRY_MIN_MS, Math.floor(cap * random()));
}

/**
 * 認証切れが確定しているときの遅い再試行（基準の 0.75〜1.25 倍）。全 PC が同じ周期で
 * リレーを叩き続けないよう、ここにも揺らぎを入れる。
 */
export function paradisRelayJitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
	return Math.floor(baseMs * (0.75 + 0.5 * random()));
}

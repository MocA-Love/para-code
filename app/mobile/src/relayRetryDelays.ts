// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { PARADIS_RELAY_CLOSE_CODE } from '@para/protocol';

/**
 * リレーへの再接続の間隔を1か所で決める（W2-06。Orca の mobile-relay-retry-delays.ts に倣った）。
 * 純関数にしてあるので、揺らぎの幅と上限をテストで固定できる。
 *
 * - 通常の切断: 完全ジッタ（0〜上限の一様分布）の指数バックオフ。上限は 0.5秒×2^n を 30秒で頭打ち、
 *   下限 0.25秒。以前はジッタ無しの `500*2^n` だったので、リレーの更新やPCの再起動で全端末が
 *   同じ瞬間に繋ぎ直し、同じ間隔で揃って再試行していた
 * - 認証拒否（リレーが 4401 / 4404 で閉じた）: 1〜15分の遅い再確認。資格は待っても戻らないので
 *   頻繁に叩く意味は無いが、止めてしまうとリレー側の一時的な不整合から二度と戻れなくなる
 *   （Orca: "gates must slow recovery down, never end it"）
 */

const BACKOFF_MIN_MS = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CEILING_MS = 30_000;

/**
 * この時間より長く繋がっていた接続が切れたときだけ、再試行の回数を 0 に戻す。
 * E2Eが確立した瞬間に戻すと、繋がってはすぐ切れる往復（セルラーのNAT張り替え、リレー側の
 * superseded）が毎回最短の間隔で繰り返される。
 */
export const RELAY_STABLE_CONNECTION_MS = BACKOFF_CEILING_MS;

const AUTH_GATE_BASE_MS = 60_000;
const AUTH_GATE_CEILING_MS = 15 * 60_000;

/**
 * 通常の再接続までの待ち時間。
 * @param attempt これまでに再試行した回数（最初の再試行は 0）
 * @param random 0以上1未満の乱数
 */
export function relayReconnectDelayMs(attempt: number, random: number): number {
	const cap = Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
	return Math.max(BACKOFF_MIN_MS, Math.floor(cap * random));
}

/**
 * 認証拒否のあとの再確認までの待ち時間（1分→2分→…→15分、±25%で揺らす。1〜15分に収める）。
 * @param streak これまでに続けて拒否された回数から1を引いた値（最初の拒否のあとは 0）
 */
export function relayAuthGateDelayMs(streak: number, random: number): number {
	const base = Math.min(AUTH_GATE_CEILING_MS, AUTH_GATE_BASE_MS * 2 ** Math.min(Math.max(0, streak), 8));
	const jittered = Math.floor(base * (0.75 + 0.5 * random));
	return Math.min(AUTH_GATE_CEILING_MS, Math.max(AUTH_GATE_BASE_MS, jittered));
}

/**
 * リレーが「この端末の資格を認めない」と言って閉じたか。
 * 旧リレーは upgrade 前の HTTP 401 で断るので、ここには来ない（1006 に見える）。
 */
export function isRelayAuthRejection(code: number | undefined): boolean {
	return code === PARADIS_RELAY_CLOSE_CODE.CREDENTIAL_REFUSED || code === PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE;
}

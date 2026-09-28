// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * APNsへの再送の間隔（W2-07）。純関数にしてテストで固定する。
 *
 * 最初の送信が一時的な失敗（429 / 5xx / 通信失敗）だったとき、最大 PUSH_MAX_RETRIES 回まで
 * 送り直す。間隔は 1秒→2秒→4秒 を上限に半分だけ揺らす（equal jitter。0 に寄らないので
 * APNs を連打しない）。APNs が Retry-After を返したら、それより早くは送らない。
 * ただし1本のヘッダで長く止められないよう上限を置く（それより先は有効期限の判定に任せる）。
 */

/** 最初の送信のあとに送り直す最大回数。 */
export const PUSH_MAX_RETRIES = 3;

const PUSH_RETRY_BASE_MS = 1_000;
const PUSH_RETRY_CEILING_MS = 30_000;
/** Retry-After を尊重する上限。 */
export const PUSH_RETRY_AFTER_MAX_MS = 10 * 60_000;

/**
 * @param failedAttempts これまでに失敗した回数（1 = 最初の送信だけ失敗した）
 * @param retryAfterMs APNs の Retry-After（無ければ undefined）
 * @param random 0以上1未満の乱数
 */
export function pushRetryDelayMs(failedAttempts: number, retryAfterMs: number | undefined, random: number): number {
	const exponent = Math.max(0, failedAttempts - 1);
	const cap = Math.min(PUSH_RETRY_CEILING_MS, PUSH_RETRY_BASE_MS * 2 ** exponent);
	const jittered = Math.floor(cap / 2 + (cap / 2) * random);
	const floor = retryAfterMs === undefined ? 0 : Math.min(PUSH_RETRY_AFTER_MAX_MS, retryAfterMs);
	return Math.max(jittered, floor);
}

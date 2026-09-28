/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC の「デバイスの管理」でスマホを外したとき、リレーの資格を確実に取り消す（W2-35、Q127 A。
// Orca の relay-revoke-outbox.ts に倣った）。
//
// 以前は台帳から消した後にリレーへ1回だけ送り、`fetch` が返れば成功とみなしていた。401 や 5xx でも
// 例外にならないので、失敗に気づかず、送り直しもしなかった（リレーにはそのスマホの資格が残り、
// 接続もプッシュの宛先の差し替えもできたまま）。取り消しは台帳のファイルに積み、リレーが受け取ったと
// 確かめるまで送り直す。流すのは、リレーへつながったときと、積んだものごとの指数的な間隔（最大10分）。
//
// 取り消しの宛先はそのときの登録（deviceId）で、PC が登録し直した（新しい deviceId）後は古い登録の
// 取り消しを捨てる（古い登録には PC がもうつながらないので、残った資格では何もできない）。

/** 1件の取り消し待ち（台帳ファイルの `pendingRelayRevokes`）。 */
export interface IParadisRelayRevokeEntry {
	/** 取り消す資格の登録先（リレー上の deviceId）。 */
	readonly deviceId: string;
	readonly mobileId: string;
	/** 積んだ時刻（epoch ms）。 */
	readonly since: number;
	/** 送って失敗した回数。 */
	readonly attempts: number;
	/** 次に送ってよい時刻（epoch ms）。 */
	readonly nextAt: number;
}

/** 積んでおく数の上限（古いものから捨てる）。 */
export const PARADIS_RELAY_REVOKE_OUTBOX_LIMIT = 64;
const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 10 * 60_000;

/** 台帳ファイルから読んだ値を検証する（形の合わない項目は捨てる）。 */
export function paradisSanitizeRevokeOutbox(raw: unknown): IParadisRelayRevokeEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: IParadisRelayRevokeEntry[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const entry = item as Record<string, unknown>;
		if (typeof entry.deviceId !== 'string' || entry.deviceId.length === 0 || typeof entry.mobileId !== 'string' || entry.mobileId.length === 0
			|| typeof entry.since !== 'number' || !Number.isFinite(entry.since)) {
			continue;
		}
		const attempts = typeof entry.attempts === 'number' && Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0;
		const nextAt = typeof entry.nextAt === 'number' && Number.isFinite(entry.nextAt) ? entry.nextAt : 0;
		entries.push({ deviceId: entry.deviceId, mobileId: entry.mobileId, since: entry.since, attempts, nextAt });
	}
	return entries.slice(-PARADIS_RELAY_REVOKE_OUTBOX_LIMIT);
}

/** 取り消しを積む（同じ登録・同じスマホがもう積まれていれば積み直さない）。 */
export function paradisEnqueueRevoke(outbox: readonly IParadisRelayRevokeEntry[], deviceId: string, mobileId: string, now: number): IParadisRelayRevokeEntry[] {
	if (outbox.some(entry => entry.deviceId === deviceId && entry.mobileId === mobileId)) {
		return [...outbox];
	}
	return [...outbox, { deviceId, mobileId, since: now, attempts: 0, nextAt: now }].slice(-PARADIS_RELAY_REVOKE_OUTBOX_LIMIT);
}

export type ParadisRelayRevokeOutcome = 'done' | 'retry' | 'drop';

/**
 * リレーの応答から、取り消しが済んだかを決める。`status` が undefined なら通信が失敗した。
 * - 2xx: 済んだ（リレーは行が無くても 200 を返す）
 * - 404: 登録そのものがリレーに無い。取り消すものが無い
 * - 400: 形が悪い（壊れた deviceId など）。送り直しても変わらないので捨てる
 * - 401 / 403: PC の資格が拒まれた。認証切れは PC 側の別の仕組みが扱うので、ゆっくり送り直す
 * - 408 / 425 / 429 / 5xx / 通信の失敗: 一時的。送り直す
 * - それ以外の 4xx: 送り直しても変わらないので捨てる
 */
export function paradisClassifyRevokeResponse(status: number | undefined): ParadisRelayRevokeOutcome {
	if (status === undefined) {
		return 'retry';
	}
	if (status >= 200 && status < 300) {
		return 'done';
	}
	if (status === 404) {
		return 'done';
	}
	if (status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
		return 'retry';
	}
	return 'drop';
}

/** n 回失敗した後の待ち（30秒×2^(n-1)、上限10分、±25% の揺らぎ）。 */
export function paradisRevokeRetryDelayMs(attempts: number, random: number): number {
	const base = Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
	return Math.round(base * (0.75 + 0.5 * random));
}

/** 失敗を1回数えて、次に送る時刻を決める。 */
export function paradisRevokeRetried(entry: IParadisRelayRevokeEntry, now: number, random: number): IParadisRelayRevokeEntry {
	const attempts = entry.attempts + 1;
	return { ...entry, attempts, nextAt: now + paradisRevokeRetryDelayMs(attempts, random) };
}

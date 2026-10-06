/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルから PC のおやすみモードを切り替える（`notify.dnd-remote.v1`、Q253〜Q256）のワイヤの形。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import する。
 *
 * - PC → アプリ: Desktop State の任意項目 `doNotDisturb`（{@link IParadisMobileDoNotDisturbState}）。PC の状態が
 *   変わったときだけ revision を進めて送り直す（PC で切り替えた・期限が来た・スマホから切り替えた）
 * - アプリ → PC: fs の `dndSet`（{@link IParadisMobileDoNotDisturbSetRequest}）。ウィンドウを名指しして送り、
 *   shared process がウィンドウの lease を確かめてから renderer の通知設定へ書く。応答は適用後の状態
 *
 * 期限の選択肢と解除予定時刻の計算は PC が持つ（「朝まで」は PC の時計とタイムゾーンで 7:00 にする）。
 * アプリは選択肢の id だけを送る。
 */

/** fs の要求の種類。 */
export const PARADIS_MOBILE_DND_SET_KIND = 'dndSet';

/** `opId` の長さの上限。 */
const MAX_OP_ID_LENGTH = 100;

/** PC のおやすみモードの状態（Desktop State の `doNotDisturb`）。 */
export interface IParadisMobileDoNotDisturbState {
	readonly enabled: boolean;
	/** 解除予定時刻（PC の時計の epoch ms）。無ければ「自分でオフにするまで」。`enabled: false` では載せない。 */
	readonly until?: number;
}

/** アプリ → PC の切り替えの要求（`id`・`protocolVersion` などの宛先の項目は除く）。 */
export interface IParadisMobileDoNotDisturbSetRequest {
	readonly t: typeof PARADIS_MOBILE_DND_SET_KIND;
	/** 利用者の一操作で 1 回だけ作る。同じ操作の送り直しは同じ値を使う（PC は 2 回目を適用しない）。 */
	readonly opId: string;
	readonly enabled: boolean;
	/** `enabled: true` のとき必須。`minutes30` / `hours1` / `morning` / `manual`（`paradisDoNotDisturbRules.ts`）。 */
	readonly duration?: string;
}

/** PC → アプリの応答（成功）。`state` は適用した後の PC の状態。 */
export interface IParadisMobileDoNotDisturbSetReply {
	readonly t: typeof PARADIS_MOBILE_DND_SET_KIND;
	readonly state: IParadisMobileDoNotDisturbState;
	/** 同じ `opId` の 2 回目だった（適用はせず、今の状態を返した）。 */
	readonly duplicate?: true;
}

function isEpochMs(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 状態を正規化する（PC が送る形・アプリが受け取った形の両方に使う）。形が合わなければ undefined。 */
export function paradisParseMobileDoNotDisturbState(value: unknown): IParadisMobileDoNotDisturbState | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { enabled?: unknown; until?: unknown };
	if (typeof candidate.enabled !== 'boolean') {
		return undefined;
	}
	if (!candidate.enabled) {
		return { enabled: false };
	}
	if (candidate.until !== undefined && !isEpochMs(candidate.until)) {
		return undefined;
	}
	return candidate.until !== undefined ? { enabled: true, until: candidate.until } : { enabled: true };
}

/** 2 つの状態が同じか（PC が送り直しを判断するのに使う）。 */
export function paradisSameMobileDoNotDisturbState(a: IParadisMobileDoNotDisturbState | undefined, b: IParadisMobileDoNotDisturbState | undefined): boolean {
	return a?.enabled === b?.enabled && a?.until === b?.until;
}

/**
 * アプリから届いた切り替えの要求を読む。形が合わなければ undefined（PC は `invalid` で断る）。
 * `duration` が選択肢の id かは、計算を持つ PC 側が確かめる。
 */
export function paradisParseMobileDoNotDisturbSetRequest(value: unknown): IParadisMobileDoNotDisturbSetRequest | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { t?: unknown; opId?: unknown; enabled?: unknown; duration?: unknown };
	if (candidate.t !== PARADIS_MOBILE_DND_SET_KIND || typeof candidate.opId !== 'string' || candidate.opId.length === 0
		|| candidate.opId.length > MAX_OP_ID_LENGTH || typeof candidate.enabled !== 'boolean') {
		return undefined;
	}
	if (!candidate.enabled) {
		return { t: PARADIS_MOBILE_DND_SET_KIND, opId: candidate.opId, enabled: false };
	}
	if (typeof candidate.duration !== 'string' || candidate.duration.length === 0 || candidate.duration.length > 32) {
		return undefined;
	}
	return { t: PARADIS_MOBILE_DND_SET_KIND, opId: candidate.opId, enabled: true, duration: candidate.duration };
}

/** 終わった操作の `opId` を覚える数（モバイルごとではなく合計）。 */
export const PARADIS_MOBILE_DND_OP_LEDGER_SIZE = 64;

/**
 * 適用済みの `opId` の台帳（送り直しで同じ操作を 2 回適用しないため）。古いものから捨てる。
 * 「ちょうど 1 回」は約束しない（台帳はウィンドウのメモリにあり、ウィンドウを閉じれば消える）。
 */
export class ParadisMobileDoNotDisturbOpLedger {
	private readonly seen = new Set<string>();

	constructor(private readonly size = PARADIS_MOBILE_DND_OP_LEDGER_SIZE) { }

	/** 初めての操作なら覚えて true、覚えている操作なら false。 */
	claim(mobileId: string, opId: string): boolean {
		const key = `${mobileId}\u0000${opId}`;
		if (this.seen.has(key)) {
			return false;
		}
		this.seen.add(key);
		while (this.seen.size > this.size) {
			const oldest = this.seen.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.seen.delete(oldest);
		}
		return true;
	}
}

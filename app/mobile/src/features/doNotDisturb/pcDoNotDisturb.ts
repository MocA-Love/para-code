// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC のおやすみモードをスマホから切り替える（`notify.dnd-remote.v1`、Q253〜Q256）の見え方と送り方。
 *
 * 期限の選択肢・残り時間の文言・解除予定時刻の計算は PC と同じ関数（`paradisDoNotDisturbRules.ts`）を使う。
 * アプリは選択肢の id だけを送り、解除予定時刻は PC が自分の時計で決める（「朝まで」は PC の 7:00）。
 * 止まるのは PC の音・デスクトップ通知・読み上げだけで、この端末へのプッシュは止まらない（Q228 A）。
 */

import {
	PARADIS_DO_NOT_DISTURB_DURATION_IDS,
	PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA,
	paradisFormatDoNotDisturbRemainingJa,
	type ParadisDoNotDisturbDurationId,
} from '../../../../../src/vs/paradis/contrib/notifications/common/paradisDoNotDisturbRules.js';
import {
	PARADIS_MOBILE_DND_SET_KIND,
	paradisParseMobileDoNotDisturbState,
	type IParadisMobileDoNotDisturbState,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDoNotDisturb.js';

export type PcDoNotDisturb = IParadisMobileDoNotDisturbState;
export type DoNotDisturbDuration = ParadisDoNotDisturbDurationId;

/** Desktop State の `doNotDisturb` を読む（形が合わなければ undefined）。 */
export const parsePcDoNotDisturb = paradisParseMobileDoNotDisturbState;

/** 期限の選択肢（PC と同じ並び・同じ文言）。 */
export const DO_NOT_DISTURB_DURATION_OPTIONS: readonly { readonly value: DoNotDisturbDuration; readonly label: string }[] =
	PARADIS_DO_NOT_DISTURB_DURATION_IDS.map(id => ({ value: id, label: PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA[id] }));

export function doNotDisturbDurationLabel(duration: DoNotDisturbDuration): string {
	return PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA[duration];
}

/** 期限が過ぎていればオフとして扱う（PC の送り直しが届くまでの間も、表示を先に合わせる）。 */
export function isDoNotDisturbOn(state: PcDoNotDisturb | undefined, now: number): boolean {
	return state?.enabled === true && (state.until === undefined || state.until > now);
}

/** 1 台ぶんの行を決める材料。 */
export interface PcDoNotDisturbRowInput {
	/** PC が `notify.dnd-remote.v1` を広告している（切断中は最後に届いた広告）。 */
	readonly supported: boolean;
	/** いまその PC とつながっていて、操作を送れる。 */
	readonly connected: boolean;
	/** PC から届いた最新の状態（PC がまだ報告していなければ undefined）。 */
	readonly state: PcDoNotDisturb | undefined;
	/** 切り替えを送って、PC の応答を待っている。 */
	readonly pending: boolean;
}

/** 1 台ぶんの行の見え方。 */
export interface PcDoNotDisturbRow {
	readonly hint: string | undefined;
	/** 右端の文字（スイッチを出さないとき）。 */
	readonly value: string | undefined;
	/** スイッチを出すか。出さないときは `value` を出す。 */
	readonly showSwitch: boolean;
	readonly on: boolean;
	/** スイッチを押せない。 */
	readonly disabled: boolean;
}

/** 残り時間の補足（「あと 42分で解除」「自分でオフにするまで」）。 */
export function doNotDisturbRemainingHint(state: PcDoNotDisturb | undefined, now: number): string | undefined {
	if (!isDoNotDisturbOn(state, now)) {
		return undefined;
	}
	const remaining = paradisFormatDoNotDisturbRemainingJa(state?.until, now);
	return remaining === undefined ? '自分でオフにするまで' : `あと ${remaining}で解除`;
}

export function pcDoNotDisturbRow(input: PcDoNotDisturbRowInput, now: number): PcDoNotDisturbRow {
	const on = isDoNotDisturbOn(input.state, now);
	if (!input.supported) {
		return { hint: 'この PC は更新すると、ここから切り替えられます', value: undefined, showSwitch: false, on: false, disabled: true };
	}
	if (input.pending) {
		return { hint: '設定中…', value: undefined, showSwitch: true, on, disabled: true };
	}
	if (!input.connected) {
		return { hint: 'オフラインのため変えられません', value: input.state === undefined ? '不明' : on ? 'オン' : 'オフ', showSwitch: false, on, disabled: true };
	}
	if (input.state === undefined) {
		return { hint: 'PC の状態を確かめています', value: undefined, showSwitch: true, on: false, disabled: true };
	}
	return { hint: doNotDisturbRemainingHint(input.state, now), value: undefined, showSwitch: true, on, disabled: false };
}

/** PC へ送る切り替えの要求（`id`・宛先は送る側が足す）。`opId` は利用者の一操作で 1 回だけ作る。 */
export function doNotDisturbSetRequest(opId: string, duration: DoNotDisturbDuration | undefined): { readonly t: typeof PARADIS_MOBILE_DND_SET_KIND; readonly opId: string; readonly enabled: boolean; readonly duration?: DoNotDisturbDuration } {
	return duration === undefined
		? { t: PARADIS_MOBILE_DND_SET_KIND, opId, enabled: false }
		: { t: PARADIS_MOBILE_DND_SET_KIND, opId, enabled: true, duration };
}

/** PC の応答から、適用後の状態を読む（形が合わなければ undefined）。 */
export function doNotDisturbSetReplyState(reply: unknown): PcDoNotDisturb | undefined {
	return reply !== null && typeof reply === 'object' ? parsePcDoNotDisturb((reply as { state?: unknown }).state) : undefined;
}

let opCounter = 0;

/** 利用者の一操作の id（同じ操作の送り直しで使い回す。この画面は自動では送り直さない）。 */
export function newDoNotDisturbOpId(now: number = Date.now()): string {
	opCounter = (opCounter + 1) % 1_000_000;
	return `dnd-${now.toString(36)}-${opCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 「7:00」のような解除時刻（この端末の時計で表示する）。 */
export function doNotDisturbUntilClock(until: number): string {
	const date = new Date(until);
	return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 切り替えが成功したときのお知らせの文。 */
export function doNotDisturbResultText(pcName: string, state: PcDoNotDisturb, now: number): { readonly text: string; readonly sub?: string } {
	if (!isDoNotDisturbOn(state, now)) {
		return { text: `${pcName} のおやすみモードを解除しました` };
	}
	return {
		text: `${pcName} をおやすみモードにしました`,
		sub: state.until === undefined ? '自分でオフにするまで' : `${doNotDisturbUntilClock(state.until)} に解除`,
	};
}

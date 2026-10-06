/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * おやすみモードの期限の選択肢と、解除予定時刻・残り時間の計算（PC とモバイルアプリで共通）。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、
 * PC のステータスバー・通知設定と同じ選択肢・同じ計算を使う。PC の表示文言は
 * `paradisDoNotDisturb.ts` が `localize` で持ち、ここの日本語の文言（アプリ用）と同じ文にする
 * （`paradisDoNotDisturb.test.ts` が一致を検査する）。
 */

/** 期限の選択肢。並びは PC の Quick Pick・アプリのシートの表示順。 */
export const PARADIS_DO_NOT_DISTURB_DURATION_IDS = ['minutes30', 'hours1', 'morning', 'manual'] as const;

export type ParadisDoNotDisturbDurationId = typeof PARADIS_DO_NOT_DISTURB_DURATION_IDS[number];

/** 「朝まで」の朝の定義（ローカル時刻）。 */
export const PARADIS_DO_NOT_DISTURB_MORNING_HOUR = 7;

export function paradisIsDoNotDisturbDurationId(value: unknown): value is ParadisDoNotDisturbDurationId {
	return typeof value === 'string' && (PARADIS_DO_NOT_DISTURB_DURATION_IDS as readonly string[]).includes(value);
}

/**
 * `now` から見て次に訪れる朝 7 時の epoch ms（この関数を呼んだ機械のローカル時刻）。
 * 深夜（0時〜7時）にオンにした場合はその日の朝、それ以外は翌日の朝になる。
 */
export function paradisNextMorning(now: number): number {
	const target = new Date(now);
	target.setHours(PARADIS_DO_NOT_DISTURB_MORNING_HOUR, 0, 0, 0);
	if (target.getTime() <= now) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

/** 解除予定時刻（epoch ms）。`manual`（自分でオフにするまで）は undefined。 */
export function paradisResolveDoNotDisturbUntil(id: ParadisDoNotDisturbDurationId, now: number): number | undefined {
	switch (id) {
		case 'minutes30': return now + 30 * 60 * 1000;
		case 'hours1': return now + 60 * 60 * 1000;
		case 'morning': return paradisNextMorning(now);
		case 'manual': return undefined;
	}
}

/** 残り時間の区切り。文言は表示する側が決める（PC は localize、アプリは下の日本語）。 */
export type ParadisDoNotDisturbRemaining =
	| { readonly kind: 'soon' }
	| { readonly kind: 'minutes'; readonly minutes: number }
	| { readonly kind: 'hours'; readonly hours: number }
	| { readonly kind: 'hoursMinutes'; readonly hours: number; readonly minutes: number };

/** 残り時間を区切る。1 分未満は `soon`。`until` が undefined（自分でオフにするまで）なら undefined。 */
export function paradisDoNotDisturbRemaining(until: number | undefined, now: number): ParadisDoNotDisturbRemaining | undefined {
	if (until === undefined) {
		return undefined;
	}
	const minutes = Math.ceil((until - now) / 60000);
	if (minutes <= 0) {
		return { kind: 'soon' };
	}
	if (minutes < 60) {
		return { kind: 'minutes', minutes };
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? { kind: 'hours', hours } : { kind: 'hoursMinutes', hours, minutes: rest };
}

/** アプリの表示文言（PC の localize の既定の文と同じ）。 */
export const PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA: Readonly<Record<ParadisDoNotDisturbDurationId, string>> = {
	// allow-any-unicode-next-line
	minutes30: '30分',
	// allow-any-unicode-next-line
	hours1: '1時間',
	// allow-any-unicode-next-line
	morning: '朝まで（7:00）',
	// allow-any-unicode-next-line
	manual: '自分でオフにするまで',
};

/** 残り時間を「2時間5分」「30分」「まもなく」にする（アプリ用。PC の `paradisFormatDoNotDisturbRemaining` と同じ文）。 */
export function paradisFormatDoNotDisturbRemainingJa(until: number | undefined, now: number): string | undefined {
	const remaining = paradisDoNotDisturbRemaining(until, now);
	switch (remaining?.kind) {
		case undefined: return undefined;
		// allow-any-unicode-next-line
		case 'soon': return 'まもなく';
		// allow-any-unicode-next-line
		case 'minutes': return `${remaining.minutes}分`;
		// allow-any-unicode-next-line
		case 'hours': return `${remaining.hours}時間`;
		// allow-any-unicode-next-line
		case 'hoursMinutes': return `${remaining.hours}時間${remaining.minutes}分`;
	}
}

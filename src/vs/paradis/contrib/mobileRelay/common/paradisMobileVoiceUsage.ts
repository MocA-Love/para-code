/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StringSHA1 } from '../../../../base/common/hash.js';
import { IParadisElevenLabsUsageBreakdownEntry, IParadisElevenLabsUsageResult, ParadisElevenLabsSubscriptionResult } from '../../notifications/common/paradisElevenLabs.js';
import { IParadisAivisMeResult, IParadisAivisUsageDayEntry, IParadisAivisUsageResult } from '../../notifications/common/paradisNotifications.js';

/**
 * モバイルの「読み上げの使用量」（fs の `voiceUsage`、capability `usage.voice.v1`）の形と、組み立ての純関数。
 *
 * PC の「通知の設定 → 使用量 (日別)」と同じ API（shared process の `getAivisUsageDaily` など）の結果を、モバイルで
 * 7 日・30 日のどちらでも出せる形にまとめる。**API キーそのものは送らない。** 代わりに、PC をまたいで同じキーを
 * 1 つにまとめるための短い印（{@link paradisMobileVoiceKeyId}）を付ける。
 *
 * 要求: `{ t: 'voiceUsage', id, bypassCache? }`。応答: `{ t: 'voiceUsage', data: IParadisMobileVoiceUsage }`。
 * 古い PC はこの種類を知らない（capability を広告しない）ので、アプリは送らずに「PC を更新すると出ます」と出す。
 */

/** fs の要求の種類。 */
export const PARADIS_MOBILE_VOICE_USAGE_KIND = 'voiceUsage';

/** モバイルへ送る日数（7 日はこの末尾から切り出す）。 */
export const PARADIS_MOBILE_VOICE_USAGE_DAYS = 30;
/** 短い期間。日別は 30 日の末尾から切り出し、内訳は同じ取得の日別の内訳から PC が作って別に送る。 */
export const PARADIS_MOBILE_VOICE_USAGE_SHORT_DAYS = 7;

/** 同じキーの結果を覚えておく時間。これより新しければ API を叩かずに返す。 */
export const PARADIS_MOBILE_VOICE_USAGE_TTL_MS = 5 * 60_000;
/** 引っ張って更新（`bypassCache`）でも、これより新しい結果は使い回す（連打で API を叩きすぎない）。 */
export const PARADIS_MOBILE_VOICE_USAGE_MIN_REFRESH_MS = 30_000;

export type ParadisMobileVoiceEngine = 'aivis' | 'elevenlabs';

export interface IParadisMobileAivisDay {
	/** PC の日付（YYYY-MM-DD）。 */
	readonly date: string;
	readonly requests: number;
	readonly chars: number;
	readonly credits: number;
}

export interface IParadisMobileAivisKeyRow {
	/** Aivis に登録した API キーの名前（キーそのものではない）。 */
	readonly name: string;
	readonly requests: number;
	readonly chars: number;
	readonly credits: number;
}

export interface IParadisMobileAivisUsage {
	/** キーの印（{@link paradisMobileVoiceKeyId}）。 */
	readonly keyId: string;
	readonly fetchedAt: number;
	/** 取れなかったときの理由（キーは伏せ字にしてある）。このときは日別などを省く。 */
	readonly error?: string;
	/** 古い順に 30 日。集計に出てこない日は 0。 */
	readonly days?: readonly IParadisMobileAivisDay[];
	readonly byApiKey7?: readonly IParadisMobileAivisKeyRow[];
	readonly byApiKey30?: readonly IParadisMobileAivisKeyRow[];
	/** クレジットの残高。取れなければ null。 */
	readonly creditBalance?: number | null;
}

export interface IParadisMobileElevenLabsDay {
	/** UTC の日付（YYYY-MM-DD。ElevenLabs は UTC で区切る）。 */
	readonly date: string;
	readonly chars: number;
}

export interface IParadisMobileElevenLabsRow {
	/** モデル名（引けなければ model_id）・声の名前。 */
	readonly label: string;
	readonly chars: number;
}

export interface IParadisMobileElevenLabsUsage {
	readonly keyId: string;
	readonly fetchedAt: number;
	readonly error?: string;
	readonly days?: readonly IParadisMobileElevenLabsDay[];
	readonly byModel7?: readonly IParadisMobileElevenLabsRow[];
	readonly byModel30?: readonly IParadisMobileElevenLabsRow[];
	readonly byVoice7?: readonly IParadisMobileElevenLabsRow[];
	readonly byVoice30?: readonly IParadisMobileElevenLabsRow[];
	/** プランの上限と今の期間の使用量。取れなければ省き、{@link subscriptionUnavailable} に理由を書く。 */
	readonly subscription?: { readonly used: number; readonly limit: number; readonly resetAt: number | null; readonly tier: string | null };
	readonly subscriptionUnavailable?: 'missing-permissions' | 'error';
}

export interface IParadisMobileVoiceUsage {
	readonly fetchedAt: number;
	/** PC でいま使っている読み上げのエンジン（アプリの最初の切り替えに使う）。 */
	readonly engine: ParadisMobileVoiceEngine;
	/** キーが入っているときだけ。 */
	readonly aivis?: IParadisMobileAivisUsage;
	readonly elevenLabs?: IParadisMobileElevenLabsUsage;
}

/**
 * API キーの印。PC をまたいで同じキーかを見分けるためだけのもので、キーへは戻せない
 * （用途の印と混ぜた SHA-1 の先頭 12 桁）。
 */
export function paradisMobileVoiceKeyId(engine: ParadisMobileVoiceEngine, apiKey: string): string {
	const sha = new StringSHA1();
	sha.update(`para-code.voice-usage-key\u0000${engine}\u0000${apiKey}`);
	return sha.digest().slice(0, 12);
}

/** エラーの文からキーを伏せる（API の応答にキーが混ざっても、そのままモバイルへ送らない）。長さも抑える。 */
export function paradisRedactVoiceUsageError(error: unknown, apiKeys: readonly string[]): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const key of apiKeys) {
		if (key.length > 0) {
			message = message.split(key).join('***');
		}
	}
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function toIsoDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

/** Aivis に頼む範囲（PC の日付で今日を含む 30 日）。PC の画面（`paradisAivisUsageSection.ts`）と同じ数え方。 */
export function paradisMobileAivisUsageRange(now: number): { readonly start: string; readonly end: string } {
	const end = new Date(now);
	const start = new Date(now);
	start.setDate(end.getDate() - (PARADIS_MOBILE_VOICE_USAGE_DAYS - 1));
	return { start: toIsoDate(start), end: toIsoDate(end) };
}

function fillAivisDays(days: readonly IParadisAivisUsageDayEntry[], start: string, end: string): IParadisAivisUsageDayEntry[] {
	const result: IParadisAivisUsageDayEntry[] = [];
	const byDate = new Map(days.map(day => [day.date, day]));
	const last = new Date(`${end}T00:00:00`);
	for (let date = new Date(`${start}T00:00:00`); date <= last; date.setDate(date.getDate() + 1)) {
		const key = toIsoDate(date);
		result.push(byDate.get(key) ?? { date: key, requestCount: 0, characterCount: 0, creditConsumed: 0, byApiKey: {} });
	}
	return result;
}

function finite(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 日別の API キー別を、期間の合計にする（クレジットの多い順、同じなら回数の多い順）。 */
function aivisKeyRows(days: readonly IParadisAivisUsageDayEntry[]): IParadisMobileAivisKeyRow[] {
	const byId = new Map<string, { name: string; requests: number; chars: number; credits: number }>();
	for (const day of days) {
		for (const [id, bucket] of Object.entries(day.byApiKey ?? {})) {
			const row = byId.get(id) ?? { name: typeof bucket.name === 'string' && bucket.name.length > 0 ? bucket.name : '—', requests: 0, chars: 0, credits: 0 };
			row.requests += finite(bucket.requestCount);
			row.chars += finite(bucket.characterCount);
			row.credits += finite(bucket.creditConsumed);
			byId.set(id, row);
		}
	}
	return [...byId.values()].sort((a, b) => b.credits - a.credits || b.requests - a.requests || a.name.localeCompare(b.name));
}

/** Aivis の結果をモバイルへ送る形にする。 */
export function paradisBuildMobileAivisUsage(keyId: string, usage: IParadisAivisUsageResult, me: IParadisAivisMeResult | null, range: { readonly start: string; readonly end: string }, fetchedAt: number): IParadisMobileAivisUsage {
	const filled = fillAivisDays(usage.days, range.start, range.end);
	return {
		keyId,
		fetchedAt,
		days: filled.map(day => ({ date: day.date, requests: finite(day.requestCount), chars: finite(day.characterCount), credits: finite(day.creditConsumed) })),
		byApiKey7: aivisKeyRows(filled.slice(-PARADIS_MOBILE_VOICE_USAGE_SHORT_DAYS)),
		byApiKey30: aivisKeyRows(filled),
		creditBalance: me !== null && typeof me.creditBalance === 'number' && Number.isFinite(me.creditBalance) ? me.creditBalance : null,
	};
}

function elevenLabsRows(entries: readonly IParadisElevenLabsUsageBreakdownEntry[], names: ReadonlyMap<string, string>): IParadisMobileElevenLabsRow[] {
	return entries.map(entry => ({ label: names.get(entry.key) ?? entry.key, chars: finite(entry.characterCount) }));
}

/**
 * ElevenLabs の 30 日の結果・プランを、モバイルへ送る形にする。モデル名は `modelNames` で引き当てる。
 * 7 日の内訳は同じ取得の `recent`（`getElevenLabsUsage` の 3 つ目の引数）から作る。無ければ省く（アプリは 30 日の内訳を出す）。
 */
export function paradisBuildMobileElevenLabsUsage(
	keyId: string,
	usage: IParadisElevenLabsUsageResult,
	subscription: ParadisElevenLabsSubscriptionResult | { readonly kind: 'error' },
	modelNames: ReadonlyMap<string, string>,
	fetchedAt: number,
): IParadisMobileElevenLabsUsage {
	const noNames = new Map<string, string>();
	const recent = usage.recent?.days === PARADIS_MOBILE_VOICE_USAGE_SHORT_DAYS ? usage.recent : undefined;
	return {
		keyId,
		fetchedAt,
		days: usage.days.map(day => ({ date: day.date, chars: finite(day.characterCount) })),
		...(recent !== undefined ? { byModel7: elevenLabsRows(recent.byModel, modelNames) } : {}),
		byModel30: elevenLabsRows(usage.byModel, modelNames),
		// 声別は API が声の名前で返すので、そのまま出す（PC の画面と同じ）。
		...(recent !== undefined ? { byVoice7: elevenLabsRows(recent.byVoice, noNames) } : {}),
		byVoice30: elevenLabsRows(usage.byVoice, noNames),
		...(subscription.kind === 'ok'
			? { subscription: { used: finite(subscription.subscription.characterCount), limit: finite(subscription.subscription.characterLimit), resetAt: subscription.subscription.nextResetAt, tier: subscription.subscription.tier } }
			: { subscriptionUnavailable: subscription.kind === 'missing-permissions' ? 'missing-permissions' as const : 'error' as const }),
	};
}

/**
 * 取得に失敗したときに返す形。前に取れた値（`lastGood`）があれば、その値に失敗の理由を添えて返す
 * （片方のエンジンの一時的な失敗で、モバイルの前回の値を消さない）。無ければ理由だけ。
 */
export function paradisMobileVoiceUsageFailure<T extends { readonly keyId: string; readonly fetchedAt: number; readonly error?: string }>(lastGood: T | undefined, keyId: string, error: string, now: number): T | { readonly keyId: string; readonly fetchedAt: number; readonly error: string } {
	return lastGood !== undefined && lastGood.keyId === keyId ? { ...lastGood, error } : { keyId, fetchedAt: now, error };
}

/**
 * 同じキーの結果を数分覚えておく表（エンジンとキーの印ごと）。同時に来た要求は 1 回の取得にまとめる。
 * 失敗した取得は覚えないが、最後に取れた値（{@link lastGood}）は期限が切れても残す（失敗の応答に添えるため）。
 */
export class ParadisMobileVoiceUsageCache<T> {
	private readonly entries = new Map<string, { readonly at: number; readonly value: T }>();
	private readonly inFlight = new Map<string, Promise<T>>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = PARADIS_MOBILE_VOICE_USAGE_TTL_MS,
		private readonly minRefreshMs: number = PARADIS_MOBILE_VOICE_USAGE_MIN_REFRESH_MS,
	) { }

	/** `key` の値。覚えている値が新しければそれを、無ければ `load` で取る。`bypass` でも {@link minRefreshMs} 以内なら使い回す。 */
	get(key: string, bypass: boolean, load: () => Promise<T>): Promise<T> {
		const cached = this.entries.get(key);
		const age = cached !== undefined ? this.now() - cached.at : undefined;
		if (cached !== undefined && age !== undefined && age >= 0 && age < (bypass ? this.minRefreshMs : this.ttlMs)) {
			return Promise.resolve(cached.value);
		}
		const running = this.inFlight.get(key);
		if (running !== undefined) {
			return running;
		}
		const job: Promise<T> = load().then(value => {
			// 取得中に prune で外されたキーの結果は覚えない（キーを入れ替えた後に古いキーの値を残さない）
			if (this.inFlight.get(key) === job) {
				this.entries.set(key, { at: this.now(), value });
			}
			return value;
		}).finally(() => {
			if (this.inFlight.get(key) === job) {
				this.inFlight.delete(key);
			}
		});
		this.inFlight.set(key, job);
		return job;
	}

	/** 最後に取れた値（期限切れでも返す）。 */
	lastGood(key: string): T | undefined {
		return this.entries.get(key)?.value;
	}

	/** 覚えている値の数（古いキーの値は {@link prune} で消す）。 */
	get size(): number {
		return this.entries.size;
	}

	/** いま使っているキー以外の値と取得中の印を消す（キーを入れ替えたあとに古いキーの結果を持ち続けない）。 */
	prune(keep: ReadonlySet<string>): void {
		for (const map of [this.entries, this.inFlight]) {
			for (const key of [...map.keys()]) {
				if (!keep.has(key)) {
					map.delete(key);
				}
			}
		}
	}
}

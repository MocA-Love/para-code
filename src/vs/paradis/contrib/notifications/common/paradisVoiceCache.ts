/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げ（ElevenLabs）の音声キャッシュの、renderer と shared process で共有する型と純関数。
// 実体（ディスクへの読み書き）は node/paradisVoiceSynthesisCache.ts。

/** 1 日分の数（日付は UTC。ElevenLabs の使用量の表と同じ区切り）。 */
export interface IParadisVoiceCacheDay {
	/** YYYY-MM-DD（UTC） */
	readonly date: string;
	/** キャッシュから鳴らした回数 */
	readonly hits: number;
	/** キャッシュから鳴らした文の文字数の合計（API に送らずに済んだ文字数） */
	readonly hitCharacters: number;
	/** API で合成した回数 */
	readonly calls: number;
	/** API で合成した文の文字数の合計 */
	readonly callCharacters: number;
}

/** 設定画面に出すキャッシュの状態。 */
export interface IParadisVoiceCacheInfo {
	/** 保存している音声の件数 */
	readonly entries: number;
	/** 保存している音声の合計バイト数 */
	readonly bytes: number;
	/** 日別の数（古い順。数の無い日は含まない） */
	readonly days: readonly IParadisVoiceCacheDay[];
}

/** 直近 `days` 日（今日を含む）の合計。 */
export interface IParadisVoiceCacheTotals {
	readonly hits: number;
	readonly hitCharacters: number;
	readonly calls: number;
	readonly callCharacters: number;
}

/** 日別の数を残す日数。 */
export const PARADIS_VOICE_CACHE_STATS_DAYS = 31;

/** epoch ms を UTC の YYYY-MM-DD にする。 */
export function paradisVoiceCacheDate(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * 日別の数に 1 回分を足し、{@link PARADIS_VOICE_CACHE_STATS_DAYS} 日より古い日を落とした新しい表を返す。
 */
export function paradisAddVoiceCacheCount(days: readonly IParadisVoiceCacheDay[], now: number, kind: 'hit' | 'call', characters: number): IParadisVoiceCacheDay[] {
	const date = paradisVoiceCacheDate(now);
	const oldest = paradisVoiceCacheDate(now - (PARADIS_VOICE_CACHE_STATS_DAYS - 1) * 86_400_000);
	const chars = Math.max(0, Math.floor(characters));
	const result = days.filter(day => day.date >= oldest && day.date !== date);
	const today = days.find(day => day.date === date) ?? { date, hits: 0, hitCharacters: 0, calls: 0, callCharacters: 0 };
	result.push(kind === 'hit'
		? { ...today, hits: today.hits + 1, hitCharacters: today.hitCharacters + chars }
		: { ...today, calls: today.calls + 1, callCharacters: today.callCharacters + chars });
	return result.sort((a, b) => a.date.localeCompare(b.date));
}

/** 保存した日別の数を読み直す（壊れた項目は捨てる）。 */
export function paradisParseVoiceCacheDays(raw: unknown): IParadisVoiceCacheDay[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
	const days: IParadisVoiceCacheDay[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== 'object') {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || days.some(day => day.date === record.date)) {
			continue;
		}
		days.push({ date: record.date, hits: count(record.hits), hitCharacters: count(record.hitCharacters), calls: count(record.calls), callCharacters: count(record.callCharacters) });
	}
	return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** 直近 `days` 日（今日を含む、UTC）の合計。 */
export function paradisVoiceCacheTotals(entries: readonly IParadisVoiceCacheDay[], now: number, days: number): IParadisVoiceCacheTotals {
	const oldest = paradisVoiceCacheDate(now - (Math.max(1, days) - 1) * 86_400_000);
	let hits = 0, hitCharacters = 0, calls = 0, callCharacters = 0;
	for (const day of entries) {
		if (day.date >= oldest) {
			hits += day.hits;
			hitCharacters += day.hitCharacters;
			calls += day.calls;
			callCharacters += day.callCharacters;
		}
	}
	return { hits, hitCharacters, calls, callCharacters };
}

/**
 * キャッシュの鍵の元になる文字列。オブジェクトのキーを並べ替えて JSON にするので、項目の順番が違っても同じになる。
 * undefined の項目は含めない（JSON.stringify と同じ）。
 */
export function paradisStableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => item === undefined ? 'null' : paradisStableStringify(item)).join(',')}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${paradisStableStringify(record[key])}`).join(',')}}`;
}

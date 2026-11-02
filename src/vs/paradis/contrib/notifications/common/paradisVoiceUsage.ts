/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声の使用量の画面（PC の設定ダイアログとモバイル）が共有する、期間の数え方と小さなキャッシュ。

import { IParadisAivisUsageDayEntry } from './paradisNotifications.js';

/** PC の暦の日付（YYYY-MM-DD）。 */
function toIsoDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

/** 今日を含む `days` 日の範囲（PC の日付）。 */
export function paradisVoiceUsageRange(now: number, days: number): { readonly start: string; readonly end: string } {
	const end = new Date(now);
	const start = new Date(now);
	start.setDate(end.getDate() - (days - 1));
	return { start: toIsoDate(start), end: toIsoDate(end) };
}

/** Aivis の日別を、`start` から `end` まで（両端を含む）の毎日に並べ直す。無い日は 0 にする。 */
export function paradisFillAivisUsageDays(days: readonly IParadisAivisUsageDayEntry[], start: string, end: string): IParadisAivisUsageDayEntry[] {
	const result: IParadisAivisUsageDayEntry[] = [];
	const byDate = new Map(days.map(day => [day.date, day]));
	const last = new Date(`${end}T00:00:00`);
	for (let date = new Date(`${start}T00:00:00`); date <= last; date.setDate(date.getDate() + 1)) {
		const key = toIsoDate(date);
		result.push(byDate.get(key) ?? { date: key, requestCount: 0, characterCount: 0, creditConsumed: 0, byApiKey: {} });
	}
	return result;
}

/** 鍵（API キーなど）ごとに 1 つの値を覚える小さな表。 */
export class ParadisPerKeyCache<T> {
	private entries = new Map<string, T>();

	get(key: string): T | undefined {
		return this.entries.get(key);
	}

	set(key: string, value: T): void {
		this.entries.set(key, value);
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries = new Map();
	}
}

/** 同じ鍵の取得を、描き直しのたびにやり直さない（進行中・済んだものを使い回す）。失敗した取得は覚えない。 */
export class ParadisRequestCache<T> {
	private readonly entries = new Map<string, Promise<T>>();

	getOrCreate(key: string, factory: () => Promise<T>): Promise<T> {
		const existing = this.entries.get(key);
		if (existing) {
			return existing;
		}
		const created = factory().catch(error => {
			if (this.entries.get(key) === created) {
				this.entries.delete(key);
			}
			throw error;
		});
		this.entries.set(key, created);
		return created;
	}

	clear(): void {
		this.entries.clear();
	}
}

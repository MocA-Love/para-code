/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの期限の書き方（Codex の枠のリセットと Claude のリミットリセットで共通）。
// 期限が今年でないとき（Claude の券は翌年まで持つことがある）だけ年を添える。

import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';

/**
 * `target` が `now` から見て暦の上で何日後か（ローカル時刻。今日は 0、明日は 1、過ぎた日は負）。
 * 「今日」「明日」「N 日後」の表示と、近い期限の色分けに使う。
 */
export function paradisLimitsCalendarDayOffset(target: number, now: number): number {
	const day = (epochMs: number) => {
		const date = new Date(epochMs);
		return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
	};
	return Math.round((day(target) - day(now)) / 86_400_000);
}

/** 「11/20 09:00」。`now` と年が違うときだけ「2027/3/9 16:59」のように年を添える。 */
export function paradisFormatLimitsDateTime(epochMs: number, now: number): string {
	const withYear = new Date(epochMs).getFullYear() !== new Date(now).getFullYear();
	const options: Intl.DateTimeFormatOptions = { ...(withYear ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
	try {
		return new Date(epochMs).toLocaleString(language, options);
	} catch {
		return new Date(epochMs).toLocaleString(undefined, options);
	}
}

function formatTime(epochMs: number): string {
	try {
		return new Date(epochMs).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
	} catch {
		return new Date(epochMs).toLocaleTimeString();
	}
}

/** 期限の「今日 11:12」「明日 08:00」「10/9 08:00」（今日・明日だけ言葉にする。年が違えば年を添える）。 */
export function paradisLimitsExpiryWhen(epochMs: number, now: number): string {
	const days = paradisLimitsCalendarDayOffset(epochMs, now);
	if (days === 0) {
		return localize('paradis.limitsMonitor.expiryToday', "今日 {0}", formatTime(epochMs));
	}
	if (days === 1) {
		return localize('paradis.limitsMonitor.expiryTomorrow', "明日 {0}", formatTime(epochMs));
	}
	return paradisFormatLimitsDateTime(epochMs, now);
}

/** 期限が暦の上で何日後か（「今日」「明日」「N日後」。過ぎていれば「期限切れ」）。 */
export function paradisLimitsRelativeDayLabel(days: number): string {
	if (days < 0) {
		return localize('paradis.limitsMonitor.expiryExpired', "期限切れ");
	}
	if (days === 0) {
		return localize('paradis.limitsMonitor.expiryTodayShort', "今日");
	}
	if (days === 1) {
		return localize('paradis.limitsMonitor.expiryTomorrowShort', "明日");
	}
	return localize('paradis.limitsMonitor.expiryInDays', "{0}日後", days);
}

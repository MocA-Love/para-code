/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisClaudePolicyUsage,
	paradisClaudeFailureBackoffS,
	paradisClaudePlanAfterFetch,
	paradisClaudeRecent429
} from '../../common/paradisClaudePollPolicy.js';

const NOW = 1_800_000_000_000;
/** 揺らぎを 0 にする乱数（2 * 0.5 - 1 = 0）。 */
const NO_JITTER = () => 0.5;

function usage(percent: number, resetInMinutes = 600): IParadisClaudePolicyUsage {
	return { fiveHour: { usedPercent: percent, resetsAt: NOW + resetInMinutes * 60_000 }, sevenDay: { usedPercent: 10, resetsAt: NOW + 7 * 24 * 3600_000 } };
}

function plan(options: { previousIntervalS?: number; previous?: IParadisClaudePolicyUsage; next?: IParadisClaudePolicyUsage; isActive: boolean; recent429?: boolean; fetchesInLastHour?: number }): { intervalS: number; waitS: number } {
	const result = paradisClaudePlanAfterFetch({
		previousIntervalS: options.previousIntervalS,
		previousUsage: options.previous,
		newUsage: options.next,
		isActive: options.isActive,
		recent429: options.recent429 ?? false,
		fetchesInLastHour: options.fetchesInLastHour,
		now: NOW,
		random: NO_JITTER,
	});
	return { intervalS: result.intervalS, waitS: Math.round((result.nextPollAt - NOW) / 1000) };
}

suite('ParadisClaudePollPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adapts the interval to movement, activity, the urgent band and exhaustion', () => {
		assert.deepStrictEqual({
			// 初回（前回の値が無い）: 使用中 3 分、控え 5 分
			firstActive: plan({ next: usage(20), isActive: true }),
			firstCandidate: plan({ next: usage(20), isActive: false }),
			// 動いていない: 1.5 倍で、使用中は 5 分・控えは 10 分まで
			idleActive: plan({ previousIntervalS: 240, previous: usage(20), next: usage(20), isActive: true }),
			idleCandidate: plan({ previousIntervalS: 500, previous: usage(20), next: usage(20), isActive: false }),
			// 動いている: 半分（下限 3 分）
			moving: plan({ previousIntervalS: 300, previous: usage(20), next: usage(30), isActive: true }),
			// 使用中が上限の近く（85% 以上）で動いている: 1 分
			urgent: plan({ previousIntervalS: 180, previous: usage(80), next: usage(88), isActive: true }),
			// 控えは上限の近くでも緊急にしない
			urgentCandidate: plan({ previousIntervalS: 300, previous: usage(80), next: usage(88), isActive: false }),
			// 緊急の 60 秒から、動きが止まったら 90 秒ではなく 3 分に戻す
			urgentSettles: plan({ previousIntervalS: 60, previous: usage(88), next: usage(88), isActive: true }),
			// 使い切った: 10 分ごと（リセットがそれより早ければリセット + 60 秒）
			exhausted: plan({ previousIntervalS: 180, previous: usage(95), next: usage(100), isActive: true }),
			exhaustedResetSoon: plan({ previousIntervalS: 180, previous: usage(95), next: usage(100, 4), isActive: true }),
			// リセットが近ければ、予定はリセット + 60 秒より後にしない
			resetSoon: plan({ previousIntervalS: 300, previous: usage(20), next: usage(20, 2), isActive: false }),
		}, {
			firstActive: { intervalS: 180, waitS: 180 },
			firstCandidate: { intervalS: 300, waitS: 300 },
			idleActive: { intervalS: 300, waitS: 300 },
			idleCandidate: { intervalS: 600, waitS: 600 },
			moving: { intervalS: 180, waitS: 180 },
			urgent: { intervalS: 60, waitS: 60 },
			urgentCandidate: { intervalS: 180, waitS: 180 },
			urgentSettles: { intervalS: 180, waitS: 180 },
			exhausted: { intervalS: 600, waitS: 600 },
			exhaustedResetSoon: { intervalS: 600, waitS: 300 },
			resetSoon: { intervalS: 450, waitS: 180 },
		});
	});

	test('after a 429 the interval stays at 6 minutes or more and grows by 1.5x up to 30 minutes', () => {
		assert.deepStrictEqual({
			first: plan({ previousIntervalS: 180, previous: usage(20), next: usage(30), isActive: true, recent429: true }),
			grows: plan({ previousIntervalS: 600, previous: usage(20), next: usage(20), isActive: true, recent429: true }),
			capped: plan({ previousIntervalS: 1500, previous: usage(20), next: usage(20), isActive: true, recent429: true }),
			// 429 の後は緊急の 1 分にしない
			noUrgent: plan({ previousIntervalS: 180, previous: usage(80), next: usage(90), isActive: true, recent429: true }),
		}, {
			first: { intervalS: 360, waitS: 360 },
			grows: { intervalS: 900, waitS: 900 },
			capped: { intervalS: 1800, waitS: 1800 },
			noUrgent: { intervalS: 360, waitS: 360 },
		});
	});

	test('the urgent 1-minute interval stops once the hourly budget is spent, and 429 keeps its floor near a reset', () => {
		assert.deepStrictEqual({
			withinBudget: plan({ previousIntervalS: 180, previous: usage(80), next: usage(88), isActive: true, fetchesInLastHour: 19 }),
			// 直近 1 時間に 20 回取ったら緊急をやめる（上限は約 28〜30 回）
			budgetSpent: plan({ previousIntervalS: 180, previous: usage(80), next: usage(88), isActive: true, fetchesInLastHour: 20 }),
			// 429 の後はリセットが 2 分後でも 6 分より詰めない
			resetSoonAfter429: plan({ previousIntervalS: 300, previous: usage(20), next: usage(20, 2), isActive: true, recent429: true }),
		}, {
			withinBudget: { intervalS: 60, waitS: 60 },
			budgetSpent: { intervalS: 180, waitS: 180 },
			resetSoonAfter429: { intervalS: 450, waitS: 360 },
		});
	});

	test('failure backoff honours Retry-After with a margin for hour-scale blocks', () => {
		assert.deepStrictEqual({
			// 429 で Retry-After が無い・0: 少なくとも 5 分
			noHeader: paradisClaudeFailureBackoffS(1, undefined, true),
			zero: paradisClaudeFailureBackoffS(1, 0, true),
			// 短い指定はそのまま（30 秒の最小待ちより長ければ）
			short: paradisClaudeFailureBackoffS(1, 120, true),
			// 1 時間規模の指定には 15 分の余裕を足す。上限は 75 分
			hour: paradisClaudeFailureBackoffS(1, 3600, true),
			hostile: paradisClaudeFailureBackoffS(1, 86_400, true),
			// 429 以外は 30 秒から倍々で 10 分まで
			network1: paradisClaudeFailureBackoffS(1, undefined, false),
			network3: paradisClaudeFailureBackoffS(3, undefined, false),
			network9: paradisClaudeFailureBackoffS(9, undefined, false),
		}, {
			noHeader: 300,
			zero: 300,
			short: 120,
			hour: 4500,
			hostile: 4500,
			network1: 30,
			network3: 120,
			network9: 600,
		});
	});

	test('recent 429 is measured from the end of its backoff', () => {
		const hour = 3600_000;
		assert.deepStrictEqual({
			never: paradisClaudeRecent429(undefined, undefined, NOW),
			justNow: paradisClaudeRecent429(NOW - 1000, undefined, NOW),
			old: paradisClaudeRecent429(NOW - 2 * hour, undefined, NOW),
			// 1 時間 15 分待った直後の最初の成功でも「最近」のまま
			afterLongBackoff: paradisClaudeRecent429(NOW - 75 * 60_000, NOW - 1000, NOW),
		}, {
			never: false,
			justNow: true,
			old: false,
			afterLongBackoff: true,
		});
	});
});

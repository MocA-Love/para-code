/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisCronMinimumGapMinutes,
	paradisCronOccurrencesBetween,
	paradisCronToSchedulePreset,
	paradisDescribeCron,
	paradisLastCronOccurrence,
	paradisNextCronOccurrence,
	paradisParseCron,
	paradisSchedulePresetToCron,
} from '../../common/paradisScheduleCron.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunRecord,
	paradisCheckRunGuards,
	paradisCleanupCandidateSpaces,
	paradisDecideDue,
	paradisSanitizeScheduledRunPrompt,
	paradisScheduledRunLaunchPrompt,
	paradisValidateScheduledRunDraft,
} from '../../common/paradisScheduledRuns.js';
import { paradisSanitizeScheduledRunDraft, paradisSanitizeScheduledRunReport } from '../../common/paradisScheduledRunsSanitize.js';

/** ローカル時刻で日時を作る（テストはマシンのタイムゾーンに依存させない）。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

function cron(expression: string) {
	const parsed = paradisParseCron(expression);
	assert.ok(parsed.schedule, parsed.error);
	return parsed.schedule;
}

const HOUR = 60 * 60_000;

function definition(overrides: Partial<IParadisScheduledRunDefinition> = {}): IParadisScheduledRunDefinition {
	return {
		id: 'd1', name: 'n', enabled: true, schedule: '0 9 * * *',
		target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
		agentId: 'claude', prompt: 'p', dailyLimit: 3, createdAt: 0, updatedAt: 0,
		...overrides,
	};
}

function run(overrides: Partial<IParadisScheduledRunRecord>): IParadisScheduledRunRecord {
	return { id: 'r', definitionId: 'd1', trigger: 'schedule', status: 'completed', createdAt: 0, ...overrides };
}

suite('paradisScheduleCron', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses fields and rejects malformed expressions', () => {
		const schedule = cron('0,30 9-10 * * 1-5');
		assert.deepStrictEqual({ minutes: schedule.minutes, hours: schedule.hours, dow: [...schedule.daysOfWeek] }, { minutes: [0, 30], hours: [9, 10], dow: [1, 2, 3, 4, 5] });
		assert.strictEqual(cron('0 0 * * 7').daysOfWeek.has(0), true);
		for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', 'a * * * *', '5-1 * * * *', '*/0 * * * *']) {
			assert.ok(paradisParseCron(bad).error, bad);
		}
	});

	test('finds the next occurrence, including weekdays and month ends', () => {
		// 2026-09-25 は金曜
		const weekdays = cron('0 9 * * 1-5');
		assert.strictEqual(paradisNextCronOccurrence(weekdays, at(2026, 9, 25, 9, 0)), at(2026, 9, 28, 9, 0));
		assert.strictEqual(paradisNextCronOccurrence(weekdays, at(2026, 9, 25, 8, 59)), at(2026, 9, 25, 9, 0));
		assert.strictEqual(paradisNextCronOccurrence(cron('0 0 31 * *'), at(2026, 9, 1)), at(2026, 10, 31));
		assert.strictEqual(paradisNextCronOccurrence(cron('0 0 29 2 *'), at(2026, 3, 1)), at(2028, 2, 29));
		// 日と曜日の両方を指定したら「どちらか」
		assert.strictEqual(paradisNextCronOccurrence(cron('0 0 1 * 1'), at(2026, 9, 25)), at(2026, 9, 28));
	});

	test('computes the minimum gap and the last occurrence', () => {
		assert.deepStrictEqual(
			['*/15 * * * *', '*/10 * * * *', '0 9 * * *', '0 23,0 * * *', '0 */2 * * *'].map(expression => paradisCronMinimumGapMinutes(cron(expression))),
			[15, 10, 1440, 60, 120],
		);
		assert.strictEqual(paradisLastCronOccurrence(cron('0 9 1 * *'), at(2026, 1, 1), at(2026, 9, 25)), at(2026, 9, 1, 9, 0));
		const between = paradisCronOccurrencesBetween(cron('*/15 * * * *'), at(2026, 9, 1), at(2026, 9, 25), 10);
		assert.deepStrictEqual({ count: between.count, truncated: between.truncated, last: between.last }, { count: 10, truncated: true, last: at(2026, 9, 25) });
	});

	test('round-trips presets and describes them', () => {
		const presets = ['0 9 * * *', '0 9 * * 1-5', '30 18 * * 5', '0 * * * *', '5 */3 * * *', '0 9 1 * *'];
		assert.deepStrictEqual(presets.map(expression => paradisSchedulePresetToCron(paradisCronToSchedulePreset(expression))), presets);
		assert.deepStrictEqual(presets.map(paradisDescribeCron), ['毎日 9:00', '平日 9:00', '毎週金曜 18:30', '毎時 0 分', '3 時間ごと（5 分）', '0 9 1 * *']);
	});
});

suite('paradisScheduledRuns decisions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs an on-time occurrence as scheduled', () => {
		assert.deepStrictEqual(paradisDecideDue(cron('0 9 * * *'), at(2026, 9, 25, 8, 59), at(2026, 9, 25, 9, 0) + 30_000), {
			run: { scheduledFor: at(2026, 9, 25, 9, 0), trigger: 'schedule', coalesced: 0 },
		});
	});

	test('catches up once within 12 hours and records older occurrences as skipped', () => {
		// 8:00 から 14:00 まで寝ていた。毎時の 9〜14 時のうち一番新しい 14:00 は時刻どおり、他はまとめる
		assert.deepStrictEqual(paradisDecideDue(cron('0 * * * *'), at(2026, 9, 25, 8, 0), at(2026, 9, 25, 14, 30)), {
			run: { scheduledFor: at(2026, 9, 25, 14, 0), trigger: 'catchUp', coalesced: 5 },
		});
		// 3 日閉じていた。毎日 9:00 のうち今日の分（1 時間前）だけ実行し、それより前の 2 回はスキップ
		assert.deepStrictEqual(paradisDecideDue(cron('0 9 * * *'), at(2026, 9, 22, 10, 0), at(2026, 9, 25, 10, 0)), {
			run: { scheduledFor: at(2026, 9, 25, 9, 0), trigger: 'catchUp', coalesced: 0 },
			skipped: { count: 2, first: at(2026, 9, 23, 9, 0), last: at(2026, 9, 24, 9, 0), truncated: false },
		});
		// 一番新しい時刻でも 12 時間より前なら実行しない
		assert.deepStrictEqual(paradisDecideDue(cron('0 9 * * *'), at(2026, 9, 24, 10, 0), at(2026, 9, 25, 22, 0)), {
			skipped: { count: 1, first: at(2026, 9, 25, 9, 0), last: at(2026, 9, 25, 9, 0), truncated: false },
		});
		assert.deepStrictEqual(paradisDecideDue(cron('0 9 * * *'), at(2026, 9, 25, 9, 1), at(2026, 9, 25, 10, 0)), {});
	});

	test('applies the overlap, daily limit and minimum interval guards', () => {
		const now = at(2026, 9, 25, 12, 0);
		const d = definition({ dailyLimit: 2 });
		assert.deepStrictEqual([
			paradisCheckRunGuards(d, [run({ status: 'running', createdAt: now - HOUR })], 'schedule', now),
			paradisCheckRunGuards(d, [run({ status: 'running', createdAt: now - HOUR })], 'manual', now),
			paradisCheckRunGuards(d, [run({ createdAt: now - HOUR }), run({ createdAt: now - 2 * HOUR })], 'schedule', now),
			paradisCheckRunGuards(d, [run({ createdAt: now - HOUR }), run({ createdAt: now - 2 * HOUR })], 'manual', now),
			paradisCheckRunGuards(d, [run({ createdAt: now - 5 * 60_000 })], 'schedule', now),
			paradisCheckRunGuards(d, [run({ status: 'skipped', createdAt: now - 60_000 }), run({ createdAt: now - 13 * HOUR })], 'schedule', now),
		], ['overlap', 'overlap', 'dailyLimit', undefined, 'tooSoon', undefined]);
	});

	test('compares scheduled times for the minimum interval, and counts late runs on their scheduled day', () => {
		const d = definition({ schedule: '*/15 * * * *', dailyLimit: 1 });
		// 前の回は判定が遅れて 25 秒後に作られ、今回は 2 秒後。予定どうしならちょうど 15 分
		const previous = run({ scheduledFor: at(2026, 9, 25, 9, 0), createdAt: at(2026, 9, 25, 9, 0) + 25_000 });
		assert.strictEqual(paradisCheckRunGuards(definition({ schedule: '*/15 * * * *' }), [previous], 'schedule', at(2026, 9, 25, 9, 15) + 2_000, at(2026, 9, 25, 9, 15)), undefined);
		// 23:50 の回を 0:05 に後から実行しても、翌日の回数には数えない
		const late = run({ scheduledFor: at(2026, 9, 25, 23, 50), createdAt: at(2026, 9, 26, 0, 5) });
		assert.strictEqual(paradisCheckRunGuards(d, [late], 'schedule', at(2026, 9, 26, 9, 0), at(2026, 9, 26, 9, 0)), undefined);
	});

	test('limits concurrent runs and the daily total across all schedules', () => {
		const now = at(2026, 9, 25, 12, 0);
		const others = (status: IParadisScheduledRunRecord['status'], count: number) => Array.from({ length: count }, (_, index) => run({ id: `o${index}`, definitionId: `other${index}`, status, createdAt: now - HOUR, scheduledFor: now - HOUR }));
		assert.deepStrictEqual([
			paradisCheckRunGuards(definition(), others('running', 3), 'manual', now),
			paradisCheckRunGuards(definition(), others('completed', 30), 'schedule', now, now),
			paradisCheckRunGuards(definition(), others('completed', 30), 'manual', now),
		], ['globalConcurrency', 'globalDailyLimit', undefined]);
	});

	test('strips control characters from prompts', () => {
		assert.deepStrictEqual([
			paradisSanitizeScheduledRunPrompt('a\x03b\x15c\x1bd\r\ne\tf\x9b'),
			paradisScheduledRunLaunchPrompt('line 1\nline 2\t\x03end '),
		], ['abcd\ne\tf', 'line 1 line 2 end']);
	});

	test('lists spaces older than the newest five as cleanup candidates', () => {
		const runs = Array.from({ length: 8 }, (_, index) => run({
			id: `r${index}`, createdAt: index,
			status: index === 1 ? 'running' : 'completed',
			space: { stateKey: `worktree:${index}`, name: `s${index}`, branch: `b${index}`, uri: `file:///w${index}` },
		}));
		assert.deepStrictEqual(paradisCleanupCandidateSpaces('d1', runs).map(candidate => candidate.id), ['r2', 'r0']);
		// 新しい 5 件のうち 3 件が消えていれば、残りは 5 件に満たないので候補は無い
		assert.deepStrictEqual(paradisCleanupCandidateSpaces('d1', runs, space => !['worktree:7', 'worktree:6', 'worktree:5'].includes(space.stateKey)).map(candidate => candidate.id), []);
	});

	test('validates drafts', () => {
		const base = { name: 'n', schedule: '0 9 * * *', target: { kind: 'repository' as const, repositoryUri: 'file:///r', repositoryName: 'r' }, agentId: 'claude', prompt: 'p', dailyLimit: 3 };
		assert.deepStrictEqual([
			paradisValidateScheduledRunDraft(base),
			paradisValidateScheduledRunDraft({ ...base, schedule: '*/5 * * * *' }) !== undefined,
			paradisValidateScheduledRunDraft({ ...base, dailyLimit: 0 }) !== undefined,
			paradisValidateScheduledRunDraft({ ...base, agentId: 'none' }) !== undefined,
			paradisValidateScheduledRunDraft({ ...base, prompt: '  ' }) !== undefined,
		], [undefined, true, true, true, true]);
	});

	test('sanitizes values coming over the channel', () => {
		assert.strictEqual(paradisSanitizeScheduledRunDraft({ name: 1 }), undefined);
		assert.strictEqual(paradisSanitizeScheduledRunDraft({ name: 'n', schedule: 's', agentId: 'a', prompt: 'p', dailyLimit: 1, target: { kind: 'other', repositoryUri: 'x', repositoryName: 'x' } }), undefined);
		assert.deepStrictEqual(paradisSanitizeScheduledRunReport({ runId: 'r', status: 'completed', detail: 'x'.repeat(600), extra: 1 }), { runId: 'r', status: 'completed', detail: 'x'.repeat(500) });
		assert.strictEqual(paradisSanitizeScheduledRunReport({ runId: 'r', status: 'pending' }), undefined);
		assert.strictEqual(paradisSanitizeScheduledRunReport({ runId: 'r', status: 'failed', reason: 'bogus' }), undefined);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotPatrolHeadline, paradisBotPatrolLastRun, paradisBotPatrolScheduleLabel } from '../../common/paradisBotPatrolModel.js';

suite('Paradis bot patrol model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const now = new Date(2026, 10, 27, 10, 5).getTime();
	const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
	const base = { definitionId: 'd', enabled: true, schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true }, cron: '0 8-20/4 * * 1-5', lookFor: '', gate: 'ok' as const };

	test('時刻の形・1 行目・前回', () => {
		assert.deepStrictEqual([
			paradisBotPatrolScheduleLabel({ everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true }),
			paradisBotPatrolScheduleLabel({ everyHours: 4, fromHour: 9, toHour: 9, weekdaysOnly: false }),
			paradisBotPatrolHeadline({ enabled: false, lookFor: '' }, now),
			paradisBotPatrolHeadline({ ...base, nextRunAt: at(27, 12) }, now),
			paradisBotPatrolHeadline({ ...base, nextRunAt: at(30, 8) }, now),
			paradisBotPatrolHeadline({ ...base, enabled: false }, now),
			paradisBotPatrolHeadline({ ...base, gate: 'paused' }, now),
			paradisBotPatrolHeadline({ ...base, activeRunId: 'r' }, now),
			paradisBotPatrolHeadline({ ...base, schedule: undefined, cron: '*/5 * * * *' }, now),
			paradisBotPatrolLastRun(base, now),
			paradisBotPatrolLastRun({ ...base, lastRun: { id: 'r', status: 'completed', trigger: 'schedule', finishedAt: at(27, 8) } }, now),
		], [
			'平日 8〜20 時・4 時間ごと',
			'毎日 9 時',
			'見回りはまだ決めていません',
			'平日 8〜20 時・4 時間ごと。次は 12:00',
			'平日 8〜20 時・4 時間ごと。次は 11/30 8:00',
			'見回りはオフです（平日 8〜20 時・4 時間ごと）',
			'一時停止中のため見回りません',
			'見回り中（平日 8〜20 時・4 時間ごと）',
			'*/5 * * * *',
			undefined,
			'前回 8:00: 完了',
		]);
	});
});

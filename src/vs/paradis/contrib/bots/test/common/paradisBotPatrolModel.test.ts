/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotPatrolHeadline, paradisBotPatrolLastRun, paradisBotPatrolScheduleCheck, paradisBotPatrolScheduleLabel } from '../../common/paradisBotPatrolModel.js';
import { paradisBotPatrolFieldsFromCron } from '../../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';

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

	test('時刻の欄: 種類ごとの式と次の時刻、断る理由', () => {
		// 11/27（金）10:05
		const window = paradisBotPatrolFieldsFromCron(undefined);
		const check = (expression: string) => paradisBotPatrolScheduleCheck(paradisBotPatrolFieldsFromCron(expression), now);
		assert.deepStrictEqual([
			paradisBotPatrolScheduleCheck(window, now),
			paradisBotPatrolScheduleCheck({ ...window, minute: 30 }, now),
			check('30 9 * * *'),
			check('30 9 * * 1-5'),
			check('15 18 * * 3'),
			check('20 */3 * * *'),
			check('0 9,13 * * 1-5'),
			paradisBotPatrolScheduleCheck({ ...window, fromHour: 21 }, now),
			check('*/15 * * * *'),
			check('0 25 * * *').problem !== undefined,
		], [
			{ cron: '0 8-20/4 * * 1-5', summary: '平日 8〜20 時・4 時間ごと（0 8-20/4 * * 1-5） · 有効なら次は 12:00' },
			{ cron: '30 8-20/4 * * 1-5', summary: '平日 8:30〜20:30・4 時間ごと（30 8-20/4 * * 1-5） · 有効なら次は 12:30' },
			{ cron: '30 9 * * *', summary: '毎日 9:30（30 9 * * *） · 有効なら次は 11/28 9:30' },
			{ cron: '30 9 * * 1-5', summary: '平日 9:30（30 9 * * 1-5） · 有効なら次は 11/30 9:30' },
			{ cron: '15 18 * * 3', summary: '毎週水曜 18:15（15 18 * * 3） · 有効なら次は 12/2 18:15' },
			{ cron: '20 */3 * * *', summary: '3 時間ごと（20 分）（20 */3 * * *） · 有効なら次は 12:20' },
			{ cron: '0 9,13 * * 1-5', summary: '0 9,13 * * 1-5 · 有効なら次は 13:00' },
			{ problem: '時間帯の終わりは始め以降にしてください', summary: '' },
			{ cron: '*/15 * * * *', problem: '見回りの間隔は 60 分以上あけてください。', summary: '' },
			true,
		]);
	});
});

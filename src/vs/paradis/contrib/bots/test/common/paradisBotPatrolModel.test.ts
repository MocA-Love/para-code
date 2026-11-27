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
			{ cron: '0 8-20/4 * * 1-5', runsPerDay: 4, summary: '平日 8〜20 時・4 時間ごと（0 8-20/4 * * 1-5） · 1 日 4 回 · 有効なら次は 12:00' },
			{ cron: '30 8-20/4 * * 1-5', runsPerDay: 4, summary: '平日 8:30〜20:30・4 時間ごと（30 8-20/4 * * 1-5） · 1 日 4 回 · 有効なら次は 12:30' },
			{ cron: '30 9 * * *', runsPerDay: 1, summary: '毎日 9:30（30 9 * * *） · 1 日 1 回 · 有効なら次は 11/28 9:30' },
			{ cron: '30 9 * * 1-5', runsPerDay: 1, summary: '平日 9:30（30 9 * * 1-5） · 1 日 1 回 · 有効なら次は 11/30 9:30' },
			{ cron: '15 18 * * 3', runsPerDay: 1, summary: '毎週水曜 18:15（15 18 * * 3） · 1 日 1 回 · 有効なら次は 12/2 18:15' },
			{ cron: '20 */3 * * *', runsPerDay: 8, summary: '3 時間ごと（20 分）（20 */3 * * *） · 1 日 8 回 · 有効なら次は 12:20' },
			{ cron: '0 9,13 * * 1-5', runsPerDay: 2, summary: '0 9,13 * * 1-5 · 1 日 2 回 · 有効なら次は 13:00' },
			{ problem: '時間帯の終わりは始め以降にしてください', summary: '' },
			{ cron: '*/15 * * * *', problem: '見回りの間隔は 60 分以上あけてください。', summary: '' },
			true,
		]);
	});

	test('時刻の欄: n 分ごと・分の範囲・走る日の無い式・cron の大きすぎる間隔・全体の枠', () => {
		const window = paradisBotPatrolFieldsFromCron(undefined);
		const short = (result: { problem?: string; overall?: string; cron?: string }) => result.problem ?? result.overall ?? result.cron;
		assert.deepStrictEqual([
			short(paradisBotPatrolScheduleCheck({ ...window, scheduleKind: 'minutes', everyMinutes: 120, minute: 10 }, now)),
			short(paradisBotPatrolScheduleCheck({ ...window, scheduleKind: 'minutes', everyMinutes: 90 }, now)),
			short(paradisBotPatrolScheduleCheck({ ...window, minute: 75 }, now)),
			short(paradisBotPatrolScheduleCheck(paradisBotPatrolFieldsFromCron('0 0 30 2 *'), now)),
			short(paradisBotPatrolScheduleCheck(paradisBotPatrolFieldsFromCron('*/90 * * * *'), now)),
			short(paradisBotPatrolScheduleCheck(paradisBotPatrolFieldsFromCron('0 * * * *'), now, 76)),
			paradisBotPatrolScheduleCheck(paradisBotPatrolFieldsFromCron('0 * * * *'), now, 77).overall,
		], [
			'10 */2 * * *',
			'n 分ごとは 60・120・180・240・360・480・720 分のどれかにしてください（1 日を割り切れない間隔は時刻の式で書けません）',
			'分は 0〜59 で指定してください',
			'この式では見回る日がありません',
			'分の間隔「*/90」は 59 以下にしてください（cron 式の間隔は分の中でだけ繰り返します）。',
			'0 * * * *',
			'ほかの Bot と合わせて 1 日 101 回になり、見回り全体の上限（100 回）を超えます。超えた回は見送ります',
		]);
	});
});

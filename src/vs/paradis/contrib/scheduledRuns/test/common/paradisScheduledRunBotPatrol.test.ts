/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisScheduledRunDefinition, IParadisScheduledRunRecord, paradisValidateScheduledRunDraft } from '../../common/paradisScheduledRuns.js';
import {
	paradisBotPatrolCron,
	paradisBotPatrolDue,
	paradisBotPatrolPrompt,
	paradisBotPatrolScheduleFromCron,
	paradisBotPatrolView,
	paradisSanitizeBotPatrolLookFor,
	paradisSanitizeBotPatrolSchedule,
	PARADIS_BOT_PATROL_DEFAULT_SCHEDULE,
} from '../../common/paradisScheduledRunBotPatrol.js';

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

const DEFINITION: IParadisScheduledRunDefinition = {
	id: 'p1',
	name: 'リリース係 の見回り',
	enabled: true,
	schedule: '0 8-20/4 * * 1-5',
	target: { kind: 'bot', repositoryUri: '', repositoryName: 'リリース係', botId: 'b1' },
	agentId: '',
	prompt: '止まっている PR',
	dailyLimit: 4,
	createdAt: 0,
	updatedAt: 0,
};

suite('Paradis bot patrol schedule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('時刻の形と cron 式の行き来', () => {
		const shapes = [
			PARADIS_BOT_PATROL_DEFAULT_SCHEDULE,
			{ everyHours: 3, fromHour: 9, toHour: 18, weekdaysOnly: false },
			{ everyHours: 4, fromHour: 9, toHour: 9, weekdaysOnly: true },
		];
		assert.deepStrictEqual({
			cron: shapes.map(paradisBotPatrolCron),
			back: shapes.map(shape => paradisBotPatrolScheduleFromCron(paradisBotPatrolCron(shape))),
			foreign: [paradisBotPatrolScheduleFromCron('*/30 * * * *'), paradisBotPatrolScheduleFromCron('0 8-20/5 * * 1-5')],
			bad: [
				paradisSanitizeBotPatrolSchedule({ everyHours: 5, fromHour: 8, toHour: 20, weekdaysOnly: true }),
				paradisSanitizeBotPatrolSchedule({ everyHours: 4, fromHour: 20, toHour: 8, weekdaysOnly: true }),
				paradisSanitizeBotPatrolSchedule({ everyHours: 4, fromHour: 8, toHour: 24, weekdaysOnly: true }),
				paradisSanitizeBotPatrolSchedule({ everyHours: 4, fromHour: 8.5, toHour: 20, weekdaysOnly: true }),
				paradisSanitizeBotPatrolSchedule('0 8 * * *'),
			],
		}, {
			cron: ['0 8-20/4 * * 1-5', '0 9-18/3 * * *', '0 9 * * 1-5'],
			back: [
				{ everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true },
				{ everyHours: 3, fromHour: 9, toHour: 18, weekdaysOnly: false },
				{ everyHours: 4, fromHour: 9, toHour: 9, weekdaysOnly: true },
			],
			foreign: [undefined, undefined],
			bad: [undefined, undefined, undefined, undefined, undefined],
		});
	});

	test('探すものと起動の指示', () => {
		assert.deepStrictEqual({
			lookFor: [paradisSanitizeBotPatrolLookFor(undefined), paradisSanitizeBotPatrolLookFor(' 止まった PR\x1b[2J\n'), paradisSanitizeBotPatrolLookFor('x'.repeat(1001)), paradisSanitizeBotPatrolLookFor(7)],
			prompt: [paradisBotPatrolPrompt(''), paradisBotPatrolPrompt('止まった PR\nと CI')],
		}, {
			lookFor: ['', '止まった PR[2J', undefined, undefined],
			prompt: [
				'This is a look-around that Para Code started on your schedule. Follow the look-around rules in AGENTS.md: only read, check your "waiting" items, and offer what is worth doing with bot_suggest. Then end your turn.',
				'This is a look-around that Para Code started on your schedule. Follow the look-around rules in AGENTS.md: only read, check your "waiting" items, and offer what is worth doing with bot_suggest. Then end your turn. Your owner asked you to look for: 止まった PR と CI',
			],
		});
	});

	test('時刻どおりの回だけ走らせ、後から実行になる回と古い回は「逃した」にまとめる', () => {
		assert.deepStrictEqual([
			paradisBotPatrolDue({}),
			paradisBotPatrolDue({ run: { scheduledFor: 100, trigger: 'schedule', coalesced: 0 } }),
			paradisBotPatrolDue({ run: { scheduledFor: 100, trigger: 'catchUp', coalesced: 2 } }),
			paradisBotPatrolDue({ run: { scheduledFor: 100, trigger: 'catchUp', coalesced: 0 }, skipped: { count: 5, last: 50 } }),
			paradisBotPatrolDue({ skipped: { count: 3, last: 40 } }),
		], [
			{},
			{ run: { scheduledFor: 100, coalesced: 0 } },
			{ missed: { count: 3, last: 100 } },
			{ missed: { count: 6, last: 100 } },
			{ missed: { count: 3, last: 40 } },
		]);
	});

	test('画面が読む形: 次の時刻は有効で門が通るときだけ。最後に終わった回と動いている回', () => {
		const now = at(2026, 11, 27, 9, 0);
		const runs: IParadisScheduledRunRecord[] = [
			{ id: 'r1', definitionId: 'p1', trigger: 'schedule', status: 'completed', scheduledFor: at(2026, 11, 26, 16), createdAt: at(2026, 11, 26, 16), finishedAt: at(2026, 11, 26, 16, 10), lastMessage: '提案を 2 件出しました' },
			{ id: 'r2', definitionId: 'p1', trigger: 'catchUp', status: 'skipped', reason: 'botMissed', scheduledFor: at(2026, 11, 26, 20), createdAt: at(2026, 11, 27, 8, 30), finishedAt: at(2026, 11, 27, 8, 30), skippedCount: 1 },
			{ id: 'r3', definitionId: 'other', trigger: 'manual', status: 'completed', createdAt: at(2026, 11, 27, 8, 50), finishedAt: at(2026, 11, 27, 8, 55) },
		];
		const running: IParadisScheduledRunRecord = { id: 'r4', definitionId: 'p1', trigger: 'manual', status: 'running', createdAt: at(2026, 11, 27, 8, 58) };
		assert.deepStrictEqual({
			none: paradisBotPatrolView(undefined, runs, 'ok', now),
			ok: paradisBotPatrolView(DEFINITION, [...runs, running], 'ok', now),
			paused: paradisBotPatrolView(DEFINITION, [], 'paused', now).nextRunAt,
			disabled: paradisBotPatrolView({ ...DEFINITION, enabled: false }, [], 'ok', now).nextRunAt,
			unknown: paradisBotPatrolView(DEFINITION, [], undefined, now),
		}, {
			none: { enabled: false, lookFor: '', gate: 'ok' },
			ok: {
				definitionId: 'p1', enabled: true,
				schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true },
				cron: '0 8-20/4 * * 1-5', lookFor: '止まっている PR',
				nextRunAt: at(2026, 11, 27, 12, 0), gate: 'ok', activeRunId: 'r4',
				lastRun: { id: 'r2', status: 'skipped', trigger: 'catchUp', reason: 'botMissed', scheduledFor: at(2026, 11, 26, 20), finishedAt: at(2026, 11, 27, 8, 30), skippedCount: 1 },
			},
			paused: undefined,
			disabled: undefined,
			unknown: {
				definitionId: 'p1', enabled: true,
				schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true },
				cron: '0 8-20/4 * * 1-5', lookFor: '止まっている PR',
			},
		});
	});

	test('検証: Bot の見回りは指示・エージェント・リポジトリを要らず、Bot と回数と事前確認なしを要る', () => {
		const { id: _id, enabled: _enabled, createdAt: _c, updatedAt: _u, ...draft } = DEFINITION;
		assert.deepStrictEqual([
			paradisValidateScheduledRunDraft({ ...draft, prompt: '' }),
			paradisValidateScheduledRunDraft({ ...draft, target: { ...draft.target, botId: '' } }) !== undefined,
			paradisValidateScheduledRunDraft({ ...draft, target: { ...draft.target, repositoryUri: 'file:///repo' } }) !== undefined,
			paradisValidateScheduledRunDraft({ ...draft, precheck: { command: 'true', timeoutSeconds: 30 } }) !== undefined,
			paradisValidateScheduledRunDraft({ ...draft, schedule: '*/5 * * * *' }) !== undefined,
			paradisValidateScheduledRunDraft({ ...draft, dailyLimit: 0 }) !== undefined,
		], [undefined, true, true, true, true, true]);
	});
});

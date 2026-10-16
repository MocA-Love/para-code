/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBrowserDownloadItem, ParadisBrowserDownloadState, paradisAggregateDownloadProgress, paradisDownloadDayKey, paradisFormatDownloadClock, paradisFormatDownloadDay, paradisFormatDownloadStart, paradisHasNewlyFinished } from '../../common/paradisBrowserDownloads.js';

function item(id: string, state: ParadisBrowserDownloadState, receivedBytes = 0, totalBytes = 100): IParadisBrowserDownloadItem {
	return { id, filename: `${id}.bin`, savePath: `/dl/${id}.bin`, url: '', state, receivedBytes, totalBytes, openable: true, fromAgent: false, startTime: 0 };
}

suite('ParadisBrowserDownloads (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates progress over running downloads only', () => {
		assert.deepStrictEqual([
			paradisAggregateDownloadProgress([]),
			paradisAggregateDownloadProgress([item('a', 'completed')]),
			paradisAggregateDownloadProgress([item('a', 'progressing', 25, 100), item('b', 'progressing', 75, 100), item('c', 'completed', 0, 1000)]),
			paradisAggregateDownloadProgress([item('a', 'progressing', 25, 100), item('b', 'progressing', 10, 0)]),
		], ['idle', 'idle', 0.5, undefined]);
	});

	test('marks completions and failures as unseen, but not cancellations', () => {
		const running = [item('a', 'progressing'), item('b', 'progressing')];
		assert.deepStrictEqual([
			paradisHasNewlyFinished(running, [item('a', 'completed'), item('b', 'progressing')]),
			paradisHasNewlyFinished(running, [item('a', 'cancelled'), item('b', 'progressing')]),
			paradisHasNewlyFinished(running, [item('a', 'progressing'), item('b', 'interrupted')]),
			paradisHasNewlyFinished([item('a', 'completed')], [item('a', 'completed')]),
			paradisHasNewlyFinished([], [item('fast', 'completed')]),
		], [true, false, true, false, true]);
	});
	test('labels the day of a download relative to when the list was opened, in local time', () => {
		const at = (year: number, month: number, day: number, hours = 12, minutes = 0, seconds = 0) => new Date(year, month - 1, day, hours, minutes, seconds).getTime();
		const now = at(2026, 10, 16, 0, 30);
		const newMonth = at(2026, 11, 1, 8);
		const newYear = at(2027, 1, 1, 8);
		assert.deepStrictEqual({
			today: paradisFormatDownloadDay(at(2026, 10, 16, 0, 0), now),
			yesterdayLate: paradisFormatDownloadDay(at(2026, 10, 15, 23, 59, 59), now),
			twoDaysAgo: paradisFormatDownloadDay(at(2026, 10, 14, 14, 32), now),
			yesterdayAcrossMonth: paradisFormatDownloadDay(at(2026, 10, 31, 22), newMonth),
			yesterdayAcrossYear: paradisFormatDownloadDay(at(2026, 12, 31, 22), newYear),
			otherYear: paradisFormatDownloadDay(at(2025, 3, 7, 9), now),
			sameDayKey: paradisDownloadDayKey(at(2026, 10, 16, 0, 0)) === paradisDownloadDayKey(at(2026, 10, 16, 23, 59)),
			clock: [paradisFormatDownloadClock(at(2026, 10, 16, 9, 5)), paradisFormatDownloadClock(at(2026, 10, 16, 14, 32)), paradisFormatDownloadClock(at(2026, 10, 16, 0, 0))],
			start: paradisFormatDownloadStart(at(2026, 1, 2, 3, 4, 5)),
		}, {
			today: '今日',
			yesterdayLate: '昨日',
			twoDaysAgo: '10月14日',
			yesterdayAcrossMonth: '昨日',
			yesterdayAcrossYear: '昨日',
			otherYear: '2025年3月7日',
			sameDayKey: true,
			clock: ['09:05', '14:32', '00:00'],
			start: '2026/01/02 03:04:05',
		});
	});
});

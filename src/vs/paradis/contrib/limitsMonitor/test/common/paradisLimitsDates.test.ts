/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFormatLimitsDateTime, paradisLimitsCalendarDayOffset } from '../../common/paradisLimitsDates.js';

suite('Paradis limits dates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts calendar days in local time', () => {
		const now = new Date(2026, 9, 4, 23, 30).getTime();
		assert.deepStrictEqual([
			paradisLimitsCalendarDayOffset(new Date(2026, 9, 4, 0, 5).getTime(), now),
			paradisLimitsCalendarDayOffset(new Date(2026, 9, 5, 0, 5).getTime(), now),
			paradisLimitsCalendarDayOffset(new Date(2026, 10, 1, 18, 30).getTime(), now),
			paradisLimitsCalendarDayOffset(new Date(2026, 9, 3, 23, 0).getTime(), now),
		], [0, 1, 28, -1]);
	});

	// 年はロケールで位置が変わるので、年の数字が入るかどうかだけを見る。
	test('adds the year only when it is not this year (also across December and January)', () => {
		const now = new Date(2026, 10, 15, 12, 0).getTime();
		const december = new Date(2026, 11, 31, 23, 0).getTime();
		const january = new Date(2027, 0, 1, 1, 0).getTime();
		const lateNow = new Date(2026, 11, 31, 23, 30).getTime();
		assert.deepStrictEqual([
			paradisFormatLimitsDateTime(new Date(2026, 11, 10, 7, 0).getTime(), now).includes('2026'),
			paradisFormatLimitsDateTime(new Date(2027, 2, 9, 16, 59).getTime(), now).includes('2027'),
			paradisFormatLimitsDateTime(december, lateNow).includes('2026'),
			paradisFormatLimitsDateTime(january, lateNow).includes('2027'),
		], [false, true, false, true]);
	});
});

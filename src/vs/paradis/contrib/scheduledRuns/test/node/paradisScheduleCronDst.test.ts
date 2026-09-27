/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 夏時間の切り替わる日の時刻の計算。Node はテストの途中で `process.env.TZ` を変えると
// ローカル時刻の計算に反映するので、夏時間のあるタイムゾーンに固定して確かめる。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNextCronOccurrence, paradisParseCron } from '../../common/paradisScheduleCron.js';

suite('paradisScheduleCron (daylight saving time)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let previousTz: string | undefined;
	setup(() => {
		previousTz = process.env.TZ;
		process.env.TZ = 'America/New_York';
	});
	teardown(() => {
		if (previousTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTz;
		}
	});

	function iso(time: number | undefined): string | undefined {
		return time === undefined ? undefined : new Date(time).toISOString();
	}

	test('a time skipped by spring forward runs once, an hour later', () => {
		// 2026-03-08 2:00 EST → 3:00 EDT。2:30 は存在しない
		const schedule = paradisParseCron('30 2 * * *').schedule!;
		const first = paradisNextCronOccurrence(schedule, Date.UTC(2026, 2, 8, 5, 0));
		assert.deepStrictEqual([iso(first), iso(paradisNextCronOccurrence(schedule, first!))], ['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
	});

	test('a time repeated by fall back runs only the first time', () => {
		// 2026-11-01 2:00 EDT → 1:00 EST。1:30 が 2 回来る
		const schedule = paradisParseCron('30 1 * * *').schedule!;
		const first = paradisNextCronOccurrence(schedule, Date.UTC(2026, 10, 1, 4, 0));
		assert.deepStrictEqual([iso(first), iso(paradisNextCronOccurrence(schedule, first!))], ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
	});
});

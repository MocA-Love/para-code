/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAddVoiceCacheCount, paradisParseVoiceCacheDays, paradisStableStringify, paradisVoiceCacheTotals } from '../../common/paradisVoiceCache.js';

suite('paradisVoiceCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts hits and calls per UTC day, drops days older than 31 days and sums the recent days', () => {
		const day = (offset: number) => Date.UTC(2026, 9, 9, 23, 30) - offset * 86_400_000;
		let days = paradisAddVoiceCacheCount([], day(40), 'call', 9);
		days = paradisAddVoiceCacheCount(days, day(10), 'call', 4);
		days = paradisAddVoiceCacheCount(days, day(0), 'hit', 6);
		days = paradisAddVoiceCacheCount(days, day(0), 'hit', 6);
		days = paradisAddVoiceCacheCount(days, day(0), 'call', 6.7);

		assert.deepStrictEqual({ days, last7: paradisVoiceCacheTotals(days, day(0), 7), last30: paradisVoiceCacheTotals(days, day(0), 30) }, {
			days: [
				{ date: '2026-09-29', hits: 0, hitCharacters: 0, calls: 1, callCharacters: 4 },
				{ date: '2026-10-09', hits: 2, hitCharacters: 12, calls: 1, callCharacters: 6 },
			],
			last7: { hits: 2, hitCharacters: 12, calls: 1, callCharacters: 6 },
			last30: { hits: 2, hitCharacters: 12, calls: 2, callCharacters: 10 },
		});
	});

	test('reads back saved counts and skips broken or duplicated days', () => {
		assert.deepStrictEqual(paradisParseVoiceCacheDays([
			{ date: '2026-10-08', hits: 1, hitCharacters: 3, calls: -1, callCharacters: 'x' },
			{ date: 'yesterday', hits: 1 },
			null,
			{ date: '2026-10-08', hits: 9 },
			{ date: '2026-10-01', calls: 2, callCharacters: 8 },
		]), [
			{ date: '2026-10-01', hits: 0, hitCharacters: 0, calls: 2, callCharacters: 8 },
			{ date: '2026-10-08', hits: 1, hitCharacters: 3, calls: 0, callCharacters: 0 },
		]);
		assert.deepStrictEqual(paradisParseVoiceCacheDays('nope'), []);
	});

	test('stringifies objects with sorted keys and without undefined members', () => {
		assert.strictEqual(paradisStableStringify({ b: [1, { d: 2, c: undefined }], a: 'x', z: undefined }), '{"a":"x","b":[1,{"d":2}]}');
	});
});

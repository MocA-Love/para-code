/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisReattachSpanAttributes } from '../../common/paradisReattachDiagnostics.js';
import { paradisNoteAttached, paradisNoteRevived, paradisRecordAdoption, paradisResetReattachTally, paradisTakeReattachTally } from '../../node/paradisReattachTally.js';

suite('ParadisReattachTally', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => paradisResetReattachTally());
	teardown(() => paradisResetReattachTally());

	test('hands the adoption to the first window only, and each workspace its own revives', () => {
		const withoutDaemon = paradisTakeReattachTally('a');
		paradisRecordAdoption({ reachable: true, adopted: 12, skipped: 1 });
		paradisNoteRevived('a', 6);
		paradisNoteRevived('a', 7);
		paradisNoteRevived('b', 8);
		// 6 だけタブが繋ぎに来た。7 は誰も来ない複製
		paradisNoteAttached(6);
		assert.deepStrictEqual({
			withoutDaemon,
			first: paradisTakeReattachTally('a'),
			again: paradisTakeReattachTally('a'),
			other: paradisTakeReattachTally('b'),
		}, {
			withoutDaemon: undefined,
			first: { firstTake: true, reachable: true, adopted: 12, leftBehind: 1, revived: 2, revivedUnclaimed: 1 },
			again: { firstTake: false, reachable: true, adopted: 0, leftBehind: 0, revived: 0, revivedUnclaimed: 0 },
			other: { firstTake: false, reachable: true, adopted: 0, leftBehind: 0, revived: 1, revivedUnclaimed: 1 },
		});
	});

	test('sends only what is worth a span, under keys Sentry keeps', () => {
		const first = paradisReattachSpanAttributes({ firstTake: true, reachable: true, adopted: 3, leftBehind: 0, revived: 0, revivedUnclaimed: 0 });
		assert.deepStrictEqual({
			first,
			nothingNew: paradisReattachSpanAttributes({ firstTake: false, reachable: true, adopted: 0, leftBehind: 0, revived: 0, revivedUnclaimed: 0 }),
			noDaemon: paradisReattachSpanAttributes(undefined),
			scrubbedKeys: Object.keys(first ?? {}).filter(isParadisSentryScrubbedWord),
		}, {
			first: { safe_first_take: true, safe_reachable: true, safe_adopted: 3, safe_left_behind: 0, safe_revived: 0, safe_revived_unclaimed: 0 },
			nothingNew: undefined,
			noDaemon: undefined,
			scrubbedKeys: [],
		});
	});
});

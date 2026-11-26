/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskEntry } from '../../../humanAsk/common/paradisHumanAsk.js';
import { paradisInboxBadgeCounts } from '../../common/paradisNotificationInboxCounts.js';

type Ask = Pick<IParadisHumanAskEntry, 'state' | 'foldedInto' | 'source' | 'paneKey'>;

suite('Paradis notification inbox badge counts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('bell counts every waiting ask, the Tasks button the board ones, and each window its own panes for the Dock', () => {
		const asks: Ask[] = [
			{ source: 'pane', state: 'waiting', paneKey: 'a' },
			{ source: 'pane', state: 'waiting', paneKey: 'b' },
			{ source: 'board', state: 'waiting', paneKey: 'c' },
			// ペインを持たない 1 件: ベルと「タスク」には数え、Dock はどのウィンドウも数えない
			{ source: 'board', state: 'waiting' },
			{ source: 'bot', state: 'waiting' },
			// 数えないもの: 回答済み・取り下げ・ほかの 1 件に寄せたもの
			{ source: 'pane', state: 'answered', paneKey: 'a' },
			{ source: 'pane', state: 'withdrawn', paneKey: 'b' },
			{ source: 'pane', state: 'waiting', paneKey: 'a', foldedInto: 'board:x' },
		];
		assert.deepStrictEqual([
			paradisInboxBadgeCounts(asks, 3, new Set(['a'])),
			paradisInboxBadgeCounts(asks, 3, new Set(['b', 'c'])),
		], [
			{ bell: 5, bellDot: false, board: 2, dock: 1 },
			{ bell: 5, bellDot: false, board: 2, dock: 2 },
		]);
	});

	test('unread notifications alone show a dot on the bell, never a number', () => {
		const answered: Ask[] = [{ source: 'pane', state: 'answered', paneKey: 'a' }];
		assert.deepStrictEqual([
			paradisInboxBadgeCounts(answered, 4, new Set(['a'])),
			paradisInboxBadgeCounts([], 0, new Set()),
		], [
			{ bell: 0, bellDot: true, board: 0, dock: 0 },
			{ bell: 0, bellDot: false, board: 0, dock: 0 },
		]);
	});
});

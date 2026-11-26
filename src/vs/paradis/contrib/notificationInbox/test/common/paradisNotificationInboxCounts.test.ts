/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskEntry } from '../../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxEntry } from '../../common/paradisNotificationInbox.js';
import { paradisInboxBadgeCounts } from '../../common/paradisNotificationInboxCounts.js';

type Ask = Pick<IParadisHumanAskEntry, 'state' | 'foldedInto' | 'source' | 'paneKey'>;
type Note = Pick<IParadisInboxEntry, 'kind' | 'paneKey' | 'read' | 'live'>;

function inbox(entries: Note[]) {
	return { entries, unreadCount: entries.filter(entry => !entry.read).length };
}

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
			{ source: 'pane', state: 'answered', paneKey: 'd' },
			{ source: 'pane', state: 'withdrawn', paneKey: 'b' },
			{ source: 'pane', state: 'waiting', paneKey: 'c', foldedInto: 'board:x' },
		];
		const notes = inbox([{ kind: 'review', paneKey: 'a', read: false, live: true }]);
		assert.deepStrictEqual([
			paradisInboxBadgeCounts(asks, notes, new Set(['a'])),
			paradisInboxBadgeCounts(asks, notes, new Set(['b', 'c'])),
		], [
			{ bell: 5, bellDot: false, board: 2, dock: 1 },
			{ bell: 5, bellDot: false, board: 2, dock: 2 },
		]);
	});

	test('an unread permission or question the ledger does not carry counts once per pane, never on top of the ledger one', () => {
		const asks: Ask[] = [{ source: 'pane', state: 'waiting', paneKey: 'a' }];
		const notes = inbox([
			// 台帳に載っているペインの通知: 重ねない
			{ kind: 'permission', paneKey: 'a', read: false, live: true },
			// 台帳に載っていないペイン: 1 ペイン 1 件（同じペインの 2 件目は数えない）
			{ kind: 'permission', paneKey: 'e', read: false, live: true },
			{ kind: 'question', paneKey: 'e', read: false, live: true },
			{ kind: 'question', paneKey: 'f', read: false, live: true },
			// 数えないもの: 完了・既読・閉じたペイン
			{ kind: 'review', paneKey: 'g', read: false, live: true },
			{ kind: 'permission', paneKey: 'h', read: true, live: true },
			{ kind: 'permission', paneKey: 'i', read: false, live: false },
		]);
		assert.deepStrictEqual([
			paradisInboxBadgeCounts(asks, notes, new Set(['a', 'e'])),
			paradisInboxBadgeCounts(asks, notes, new Set(['f', 'g', 'i'])),
		], [
			{ bell: 3, bellDot: false, board: 0, dock: 2 },
			{ bell: 3, bellDot: false, board: 0, dock: 1 },
		]);
	});

	test('unread completions alone show a dot on the bell, never a number', () => {
		const answered: Ask[] = [{ source: 'pane', state: 'answered', paneKey: 'a' }];
		assert.deepStrictEqual([
			paradisInboxBadgeCounts(answered, inbox([{ kind: 'review', paneKey: 'a', read: false, live: true }]), new Set(['a'])),
			paradisInboxBadgeCounts([], inbox([]), new Set()),
		], [
			{ bell: 0, bellDot: true, board: 0, dock: 0 },
			{ bell: 0, bellDot: false, board: 0, dock: 0 },
		]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisInboxRecordInput,
	paradisInboxAttentionEntries,
	paradisInboxAttentionPaneCount,
	paradisInboxEntryLocation,
	paradisNotificationBody,
	paradisNotificationPreview,
} from '../../common/paradisNotificationInbox.js';
import { ParadisNotificationInboxLedger } from '../../common/paradisNotificationInboxLedger.js';

function input(paneKey: string, kind: IParadisInboxRecordInput['kind'], extra: Partial<IParadisInboxRecordInput> = {}): IParadisInboxRecordInput {
	return { kind, paneKey, instanceId: 1, windowId: 1, space: 'para-code', delivery: 'notified', ...extra };
}

function view(ledger: ParadisNotificationInboxLedger) {
	const snapshot = ledger.snapshot();
	return {
		entries: snapshot.entries.map(entry => `${entry.id}:${entry.paneKey}:${entry.kind}:${entry.read ? 'read' : 'unread'}:${entry.live ? 'live' : 'closed'}`),
		attentionPaneCount: snapshot.attentionPaneCount,
		unreadCount: snapshot.unreadCount,
	};
}

suite('Paradis notification inbox ledger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts panes that need attention, not notifications, and only open panes', () => {
		const ledger = new ParadisNotificationInboxLedger(() => 1000);
		ledger.setLivePanes('window:1', ['a', 'b']);
		ledger.record(input('a', 'review'));
		ledger.record(input('a', 'review'));
		ledger.record(input('b', 'permission'));
		ledger.record(input('c', 'question'));
		ledger.record(input('b', 'review', { delivery: 'focused', read: true }));

		assert.deepStrictEqual(view(ledger), {
			entries: ['5:b:review:read:live', '4:c:question:unread:closed', '3:b:permission:unread:live', '2:a:review:unread:live', '1:a:review:unread:live'],
			attentionPaneCount: 2,
			unreadCount: 4,
		});
	});

	test('marks entries read when the pane moves on, and forgets the panes of a closed window', () => {
		const ledger = new ParadisNotificationInboxLedger(() => 1000);
		ledger.setLivePanes('window:1', ['a', 'b']);
		ledger.setLivePanes('window:2', ['c']);
		ledger.record(input('a', 'permission'));
		ledger.record(input('b', 'review'));
		ledger.record(input('c', 'question'));

		// a は答えて作業を再開した、b はまだ完了のまま（確認していない）
		const changedByStatus = ledger.syncPaneStatuses([{ paneKey: 'a', status: 'working' }, { paneKey: 'b', status: 'review' }]);
		const changedByClose = ledger.removeClient('window:2');

		assert.deepStrictEqual({ changedByStatus, changedByClose, ...view(ledger) }, {
			changedByStatus: true,
			changedByClose: true,
			entries: ['3:c:question:unread:closed', '2:b:review:unread:live', '1:a:permission:read:live'],
			attentionPaneCount: 1,
			unreadCount: 2,
		});
	});

	test('records an entry as read when the pane already moved on before the record arrived', () => {
		const ledger = new ParadisNotificationInboxLedger(() => 1000);
		ledger.setLivePanes('window:1', ['a', 'b']);
		// 本文を待っている間に、a は確認済み（待機中）になり、b はまだ完了のまま
		ledger.syncPaneStatuses([{ paneKey: 'a', status: undefined }, { paneKey: 'b', status: 'review' }]);
		ledger.record(input('a', 'review'));
		ledger.record(input('b', 'review'));
		ledger.record(input('c', 'review'));

		assert.deepStrictEqual(view(ledger).entries, ['3:c:review:unread:closed', '2:b:review:unread:live', '1:a:review:read:live']);
	});

	test('supports read, unread, read all, remove and the size limit', () => {
		const ledger = new ParadisNotificationInboxLedger(() => 1000, 3);
		ledger.setLivePanes('window:1', ['a', 'b']);
		ledger.record(input('a', 'review'));
		ledger.record(input('b', 'review'));
		ledger.record(input('a', 'question'));
		ledger.record(input('b', 'permission'));

		const steps = [
			ledger.markPanesRead(['a']),
			ledger.markUnread('3'),
			ledger.remove('2'),
			ledger.remove('2'),
		];
		const afterSteps = view(ledger);
		ledger.markAllRead();

		assert.deepStrictEqual({ steps, afterSteps, afterReadAll: view(ledger) }, {
			steps: [true, true, true, false],
			afterSteps: { entries: ['4:b:permission:unread:live', '3:a:question:unread:live'], attentionPaneCount: 2, unreadCount: 2 },
			afterReadAll: { entries: ['4:b:permission:read:live', '3:a:question:read:live'], attentionPaneCount: 0, unreadCount: 0 },
		});
	});

	test('formats the OS notification body and the menu entries', () => {
		const ledger = new ParadisNotificationInboxLedger(() => 1000);
		ledger.setLivePanes('window:1', ['a', 'b']);
		ledger.record(input('a', 'review'));
		ledger.record(input('b', 'permission'));
		ledger.record(input('a', 'question'));
		const snapshot = ledger.snapshot();

		assert.deepStrictEqual({
			preview: paradisNotificationPreview(`${'型エラーを直しました。'.repeat(10)}\n次へ`),
			empty: paradisNotificationPreview(' \n '),
			body: paradisNotificationBody('main', 'ビルドが通りました'),
			bodyWithoutPreview: paradisNotificationBody('main', undefined),
			location: paradisInboxEntryLocation({ space: 'api', worktree: 'fix-login', tab: 'claude' }),
			attentionEntries: paradisInboxAttentionEntries(snapshot, 5).map(entry => entry.id),
			windowCount: paradisInboxAttentionPaneCount(snapshot, new Set(['b'])),
		}, {
			preview: `${'型エラーを直しました。'.repeat(8).slice(0, 79)}…`,
			empty: undefined,
			body: 'main: ビルドが通りました',
			bodyWithoutPreview: 'main',
			location: 'api (fix-login) ／ claude',
			attentionEntries: ['3', '2'],
			windowCount: 1,
		});
	});
});

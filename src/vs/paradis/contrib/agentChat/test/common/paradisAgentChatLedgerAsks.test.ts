/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskEntry } from '../../../humanAsk/common/paradisHumanAsk.js';
import { paradisInboxPaneKey } from '../../../notificationInbox/common/paradisNotificationInbox.js';
import { paradisAgentChatLedgerAsks } from '../../common/paradisAgentChatLedgerAsks.js';

suite('paradisAgentChatLedgerAsks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const paneKey = paradisInboxPaneKey('pane');
	const entry = (id: string, extra: Partial<IParadisHumanAskEntry>): IParadisHumanAskEntry => ({
		key: id, owner: 'o', source: 'board', id, kind: 'question', from: { title: id }, questions: [], actions: [], canSkip: false, askedAt: 1, state: 'waiting', paneKey, ...extra,
	});

	test('takes the waiting board and Bot asks of this pane, oldest first, without permissions, pane-owned asks or folded ones', () => {
		const entries = [
			entry('bot-question', { source: 'bot', askedAt: 3 }),
			entry('board-approval', { kind: 'approval', askedAt: 2 }),
			// ask_human（#1225）は Bot・ボードの出どころの質問として台帳に入る。形が同じなら、そのまま出る
			entry('ask-human', { source: 'bot', askedAt: 4, questions: [{ id: '0', text: '日付は?', options: [], allowText: true }] }),
			entry('permission', { kind: 'permission', source: 'bot' }),
			entry('pane-question', { source: 'pane' }),
			entry('answered', { state: 'answered' }),
			entry('folded', { foldedInto: 'board-approval' }),
			entry('other-pane', { paneKey: 'x' }),
		];
		assert.deepStrictEqual({
			shown: paradisAgentChatLedgerAsks(entries, 'pane', false).map(item => item.key),
			// ペインが自分の質問を待っている間は出さない（同じ待ちはボード・Bot の 1 件に寄せられる）
			paneAsking: paradisAgentChatLedgerAsks(entries, 'pane', true).map(item => item.key),
		}, {
			shown: ['board-approval', 'bot-question', 'ask-human'],
			paneAsking: [],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { paradisBotItemEventLabel, paradisBotItemGroups, paradisBotItemStatusLabel } from '../../common/paradisBotPageModel.js';

function item(number: number, patch: Partial<IParadisBotItem> = {}): IParadisBotItem {
	return {
		uid: `u${number}`, number, botId: 'b', title: `t${number}`, status: 'working', links: [], events: [], lastEventId: 0,
		lastActivityAt: number, createdAt: 1, updatedAt: 1,
		...patch,
	};
}

const ASK = { eventId: 3, questions: [{ prompt: 'p', options: [{ label: 'A' }, { label: 'B' }] }] };

suite('Paradis bots page', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('項目の群', () => {
		const groups = paradisBotItemGroups([
			item(1, { status: 'needs_you', ask: ASK }),
			item(2, { status: 'needs_you' }),
			item(3, { status: 'planned' }),
			item(4, { status: 'working', snoozedUntil: 2000 }),
			item(5, { status: 'done' }),
			item(6, { status: 'canceled' }),
			item(7, { status: 'needs_you', ask: ASK, snoozedUntil: 2000 }),
			item(8),
			item(9, { status: 'waiting' }),
		], 1000);
		const ids = (list: readonly IParadisBotItem[]) => list.map(entry => entry.number);
		assert.deepStrictEqual([ids(groups.you), ids(groups.working), ids(groups.planned), ids(groups.snoozed), ids(groups.closed)], [[1], [9, 8, 2], [3], [7, 4], [6, 5]]);
	});

	test('状態と記録の文', () => {
		assert.deepStrictEqual([
			['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled', 'later'].map(status => paradisBotItemStatusLabel({ status })),
			paradisBotItemEventLabel({ id: 1, kind: 'made', actor: 'bot', at: 0 }, 'リリース係'),
			paradisBotItemEventLabel({ id: 2, kind: 'status', actor: 'owner', at: 0, from: 'working', to: 'done' }, 'x'),
			paradisBotItemEventLabel({ id: 3, kind: 'commented', actor: 'owner', at: 0, text: 'A', answers: 2 }, 'x'),
			paradisBotItemEventLabel({ id: 4, kind: 'commented', actor: 'owner', at: 0, skipped: true }, 'x'),
		], [
			['予定', '進行中', '外の返事待ち', 'あなたの番', '完了', '取りやめ', 'later'],
			'リリース係が作りました',
			'あなたが「完了」にしました',
			'あなたが答えました: A',
			'あなたが問いを飛ばしました',
		]);
	});
});

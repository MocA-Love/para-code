/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { paradisMobileBotItemPage, paradisMobileBotItemRow, paradisMobileBotSuggestion, paradisParseMobileBotItemAct, paradisParseMobileBotUpdate } from '../../common/paradisBotsMobileProtocol.js';

const ITEM: IParadisBotItem = {
	uid: 'u1', number: 42, botId: 'b', title: 'Safari でログインが切れる', status: 'needs_you',
	ask: { eventId: 3, questions: [{ prompt: 'p', options: [{ label: 'A' }] }] },
	links: [], events: Array.from({ length: 120 }, (_, index) => ({ id: index + 1, kind: 'commented', actor: 'bot' as const, at: index })),
	lastEventId: 120, lastActivityAt: 5, createdAt: 1, updatedAt: 5,
};

suite('Paradis bots mobile protocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('一覧の行・項目のページ・提案は送ってよい欄だけ', () => {
		const page = paradisMobileBotItemPage({ ...ITEM, preserved: { secret: 1 } });
		assert.deepStrictEqual([
			paradisMobileBotItemRow(ITEM, 10),
			[page.events.length, page.events[0].id, Object.keys(page).includes('preserved'), page.locked],
			paradisMobileBotSuggestion({ id: 's', botId: 'b', title: 't', request: 'r', run: 'hash', state: 'open', createdAt: 1 }),
		], [
			{ uid: 'u1', number: 42, title: 'Safari でログインが切れる', status: 'needs_you', waits: true, lastActivityAt: 5 },
			[100, 21, false, true],
			{ id: 's', title: 't', request: 'r', state: 'open', createdAt: 1 },
		]);
	});

	test('項目の操作の検め（コメントは問いの答えにしない）', () => {
		const parse = (request: Record<string, unknown>) => paradisParseMobileBotItemAct({ opId: 'o', uid: 'u1', ...request }, 1000)?.act;
		assert.deepStrictEqual([
			parse({ action: 'comment', text: '見ました' }),
			parse({ action: 'comment', text: '  ' }),
			parse({ action: 'done' }),
			parse({ action: 'snooze', until: 500 }),
			parse({ action: 'snooze', until: 2000 }),
			parse({ action: 'answer' }),
			paradisParseMobileBotItemAct({ uid: 'u1', action: 'done' }, 1000),
		], [
			{ action: 'comment', text: '見ました' },
			undefined,
			{ action: 'done' },
			undefined,
			{ action: 'snooze', until: 2000 },
			undefined,
			undefined,
		]);
	});

	test('設定の変更は update_bot と同じ形と同じ確かめる規則', () => {
		const parse = (request: Record<string, unknown>) => {
			const parsed = paradisParseMobileBotUpdate(request);
			return parsed.ok ? [parsed.args.patch, parsed.args.role, parsed.args.needsConfirmation, parsed.confirmed] : parsed.ok;
		};
		assert.deepStrictEqual([
			parse({ botId: 'b', changes: { pinned: true } }),
			parse({ botId: 'b', changes: { permission: 'skip-permissions' } }),
			parse({ botId: 'b', changes: { role: '# 役割' }, confirmed: true }),
			parse({ botId: 'b', changes: { bot: 'other', pinned: true } }),
			parse({ botId: 'b', changes: { unknown: 1 } }),
			parse({ changes: { pinned: true } }),
		], [
			[{ pinned: true }, undefined, false, false],
			[{ permissionId: 'skip-permissions' }, undefined, true, false],
			[{}, '# 役割', true, true],
			false,
			false,
			false,
		]);
	});
});

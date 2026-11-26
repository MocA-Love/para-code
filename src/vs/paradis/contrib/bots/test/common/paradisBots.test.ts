/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EMPTY_PARADIS_BOTS_STATE,
	IParadisBotsState,
	PARADIS_BOT_LIMITS,
	paradisBotCreate,
	paradisBotDefaultFace,
	paradisBotFolderName,
	paradisBotHomeRelativePath,
	paradisBotRemove,
	paradisBotUpdate,
	paradisIsBotFolderName,
	paradisParseBotsState,
	paradisReserveBotFolder,
	paradisSanitizeBotName,
} from '../../common/paradisBots.js';

function created(state: IParadisBotsState, id: string, name: string, now = 1000): IParadisBotsState {
	const result = paradisBotCreate(state, { id, name, agent: 'claude' }, now);
	assert.ok(result.ok);
	return result.state;
}

suite('Paradis bots', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('名前の検め', () => {
		assert.deepStrictEqual(
			['  Release bot ', '', '   ', 'a\nb', 'x'.repeat(64), 'x'.repeat(65), 42].map(paradisSanitizeBotName),
			['Release bot', undefined, undefined, undefined, 'x'.repeat(64), undefined, undefined]);
	});

	test('フォルダ名は英数字とハイフンだけになる', () => {
		assert.deepStrictEqual(
			['Release bot', 'Café  Réview!!', 'リリース係', 'PR のレビュー係', 'con', '../../etc', 'a'.repeat(60), '-x-'].map(paradisBotFolderName),
			['release-bot', 'cafe-review', 'bot', 'pr', 'con-bot', 'etc', 'a'.repeat(40), 'x']);
	});

	test('フォルダ名は重なったら連番で予約する', () => {
		assert.deepStrictEqual(
			[paradisReserveBotFolder('リリース係', []), paradisReserveBotFolder('レビュー係', ['bot']), paradisReserveBotFolder('見回り', ['bot', 'bot-2']), paradisReserveBotFolder('Release', ['bot'])],
			['bot', 'bot-2', 'bot-3', 'release']);
	});

	test('フォルダ名として通るもの', () => {
		assert.deepStrictEqual(
			['release-bot', 'bot-2', '..', 'a/b', 'A', '', 'con', '-a', 'a--b', 7].map(paradisIsBotFolderName),
			[true, true, false, false, false, false, false, false, false, false]);
	});

	test('専用フォルダの外を指すパスを断る', () => {
		assert.deepStrictEqual(
			['SOUL.md', 'memory/topic.md', './memory//x.md', 'memory\\win.md', '../other/SOUL.md', 'memory/../../x', '/etc/passwd', 'C:\\Users\\x', '~/x', '', '.', 'a\0b', 5].map(paradisBotHomeRelativePath),
			['SOUL.md', 'memory/topic.md', undefined, 'memory/win.md', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('作成・更新・削除', () => {
		let state = created(EMPTY_PARADIS_BOTS_STATE, 'b1', 'リリース係');
		state = created(state, 'b2', 'レビュー係', 2000);
		const renamed = paradisBotUpdate(state, 'b2', { name: 'Reviewer', agent: 'codex', modelId: 'gpt', paused: true, pinned: true, faceColor: 'amber' }, 3000);
		assert.ok(renamed.ok);
		const cleared = paradisBotUpdate(renamed.state, 'b2', { modelId: null }, 4000);
		assert.ok(cleared.ok);
		const removed = paradisBotRemove(cleared.state, 'b1');
		assert.ok(removed.ok);
		assert.deepStrictEqual({ afterCreate: state.bots, renamed: renamed.bot, afterRemove: removed.state.bots }, {
			afterCreate: [
				{ id: 'b1', name: 'リリース係', folder: 'bot', agent: 'claude', paused: false, pinned: false, faceColor: 'pink', faceShape: 'blob', createdAt: 1000, updatedAt: 1000 },
				{ id: 'b2', name: 'レビュー係', folder: 'bot-2', agent: 'claude', paused: false, pinned: false, faceColor: 'teal', faceShape: 'blob', createdAt: 2000, updatedAt: 2000 },
			],
			// 名前を変えてもフォルダと顔は変えない（顔の既定は作ったときの名前から決まる）
			renamed: { id: 'b2', name: 'Reviewer', folder: 'bot-2', agent: 'codex', modelId: 'gpt', paused: true, pinned: true, faceColor: 'amber', faceShape: 'blob', createdAt: 2000, updatedAt: 3000 },
			afterRemove: [{ id: 'b2', name: 'Reviewer', folder: 'bot-2', agent: 'codex', paused: true, pinned: true, faceColor: 'amber', faceShape: 'blob', createdAt: 2000, updatedAt: 4000 }],
		});
	});

	test('断るもの', () => {
		const state = created(EMPTY_PARADIS_BOTS_STATE, 'b1', 'A');
		let full = EMPTY_PARADIS_BOTS_STATE;
		for (let index = 0; index < PARADIS_BOT_LIMITS.bots; index++) {
			full = created(full, `b${index}`, `Bot ${index}`);
		}
		const code = (result: { ok: boolean; code?: string }) => result.ok ? 'ok' : result.code;
		assert.deepStrictEqual([
			code(paradisBotCreate(state, { id: 'b1', name: 'B', agent: 'claude' }, 1)),
			code(paradisBotCreate(state, { id: 'b2', name: '', agent: 'claude' }, 1)),
			code(paradisBotCreate(state, { id: 'b2', name: 'B', agent: 'grok' }, 1)),
			code(paradisBotCreate(state, { id: 'b2', name: 'B', agent: 'claude', modelId: 7 }, 1)),
			code(paradisBotCreate(full, { id: 'new', name: 'B', agent: 'claude' }, 1)),
			code(paradisBotUpdate(state, 'none', { name: 'B' }, 1)),
			code(paradisBotUpdate(state, 'b1', { paused: 'yes' }, 1)),
			code(paradisBotUpdate(state, 'b1', { pinned: 1 }, 1)),
			code(paradisBotUpdate(state, 'b1', { faceColor: '#ff0000' }, 1)),
			code(paradisBotCreate(state, { id: 'b2', name: 'B', agent: 'claude', faceShape: 'star' }, 1)),
			code(paradisBotRemove(state, 'none')),
			code(paradisBotCreate({ ...state, version: 2 }, { id: 'b2', name: 'B', agent: 'claude' }, 1)),
			code(paradisBotUpdate({ ...state, version: 2 }, 'b1', { name: 'B' }, 1)),
			code(paradisBotRemove({ ...state, version: 2 }, 'b1')),
		], ['invalid_argument', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'limit', 'not_found', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'not_found', 'read_only', 'read_only', 'read_only']);
	});

	test('保存した値の読み込み: 形の違う 1 件だけを捨てる', () => {
		// ピン留めの欄の無い古い保存
		const good = { id: 'b1', name: 'A', folder: 'a', agent: 'claude', paused: false, createdAt: 1, updatedAt: 2 };
		// 欄の無い古い保存は、ピン留めなし・名前（A）から決まる既定の顔として読む
		const read = { ...good, pinned: false, faceColor: 'pink', faceShape: 'squircle' };
		assert.deepStrictEqual([
			paradisParseBotsState({ version: 1, bots: [good, { ...good, id: 'b2', folder: '../x' }, { ...good, id: 'b3', folder: 'c', agent: 'grok' }, { ...good, id: 'b1', folder: 'd' }, { ...good, id: 'b4' }, 'x', { ...good, id: 'b5', folder: 'e', modelId: 'm' }, { ...good, id: 'b6', folder: 'f', pinned: true }, { ...good, id: 'b7', folder: 'g', pinned: 'yes' }, { ...good, id: 'b8', folder: 'h', faceColor: 'red', faceShape: 'star' }] }),
			paradisParseBotsState({ version: 3, bots: [good] }),
			paradisParseBotsState({ version: 1 }),
			paradisParseBotsState({ bots: [] }),
			paradisParseBotsState([]),
			paradisParseBotsState(null),
		], [
			{ version: 1, bots: [read, { ...read, id: 'b5', folder: 'e', modelId: 'm' }, { ...read, id: 'b6', folder: 'f', pinned: true }, { ...read, id: 'b7', folder: 'g' }, { ...read, id: 'b8', folder: 'h', faceColor: 'red' }] },
			{ version: 3, bots: [read] },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('顔の既定は名前から決まり、同じ名前なら毎回同じ', () => {
		assert.deepStrictEqual(['リリース係', 'リリース係', 'レビュー係', 'A'].map(paradisBotDefaultFace), [
			{ faceColor: 'pink', faceShape: 'blob' },
			{ faceColor: 'pink', faceShape: 'blob' },
			{ faceColor: 'teal', faceShape: 'blob' },
			{ faceColor: 'pink', faceShape: 'squircle' },
		]);
	});
});

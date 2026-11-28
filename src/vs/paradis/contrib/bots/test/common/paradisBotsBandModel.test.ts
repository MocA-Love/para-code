/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotSummary } from '../../common/paradisBotsApi.js';
import {
	paradisBotCreateSoul,
	paradisBotFace,
	paradisBotRowMenu,
	paradisBotsBandDraggedHeight,
	paradisBotsBandListHeight,
	paradisBotsBandRows,
	paradisBotStatusDetail,
	paradisBotStatusLine,
	paradisBotsNeedsYouTotal,
	paradisParseBotsBandState,
	paradisSerializeBotsBandState,
	paradisValidateBotName,
} from '../../common/paradisBotsBandModel.js';

function bot(id: string, name: string, patch: Partial<IParadisBotSummary> = {}): IParadisBotSummary {
	return {
		id, name, folder: id, agent: 'claude', paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop', createdAt: 1, updatedAt: 1,
		needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'stopped', lastActivityAt: 1,
		...patch,
	};
}

suite('Paradis bots band', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('開閉と高さの保存', () => {
		assert.deepStrictEqual([
			paradisParseBotsBandState(undefined),
			paradisParseBotsBandState('not json'),
			paradisParseBotsBandState('{"open":false}'),
			paradisParseBotsBandState('{"open":false,"listHeight":200}'),
			paradisParseBotsBandState('{"open":true,"listHeight":5}'),
			paradisParseBotsBandState('{"open":true,"listHeight":9999}'),
			paradisParseBotsBandState(paradisSerializeBotsBandState({ open: false, listHeight: 150.4 })),
			paradisSerializeBotsBandState({ open: true, listHeight: undefined }),
		], [
			{ open: true, listHeight: undefined },
			{ open: true, listHeight: undefined },
			{ open: false, listHeight: undefined },
			{ open: false, listHeight: 200 },
			{ open: true, listHeight: 32 },
			{ open: true, listHeight: 420 },
			{ open: false, listHeight: 150 },
			'{"open":true}',
		]);
	});

	test('境の線で変えた高さは 32〜420 に挟む', () => {
		assert.deepStrictEqual([paradisBotsBandDraggedHeight(116, 40), paradisBotsBandDraggedHeight(116, -200), paradisBotsBandDraggedHeight(400, 100)], [156, 32, 420]);
	});

	test('閉じるとピン留めの行だけ残る', () => {
		const bots = [bot('a', 'リリース係'), bot('b', 'レビュー係', { pinned: true }), bot('c', '翻訳係')];
		assert.deepStrictEqual([
			paradisBotsBandRows(bots, true).map(b => b.id),
			paradisBotsBandRows(bots, false).map(b => b.id),
			paradisBotsBandRows([bot('a', 'x')], false).map(b => b.id),
		], [['a', 'b', 'c'], ['b'], []]);
	});

	test('一覧の高さ', () => {
		assert.deepStrictEqual([
			// 開いて既定（4 行分）。行が少なければ縮む
			paradisBotsBandListHeight({ open: true, listHeight: undefined }, 6, 1000),
			paradisBotsBandListHeight({ open: true, listHeight: undefined }, 2, 1000),
			// 覚えた高さ
			paradisBotsBandListHeight({ open: true, listHeight: 200 }, 10, 1000),
			// ビューの 4 割まで
			paradisBotsBandListHeight({ open: true, listHeight: 400 }, 20, 500),
			// 空なら案内の 1 行
			paradisBotsBandListHeight({ open: true, listHeight: undefined }, 0, 1000),
			// 閉じたらピン留めの行の分だけ、無ければ 0
			paradisBotsBandListHeight({ open: false, listHeight: 300 }, 2, 1000),
			paradisBotsBandListHeight({ open: false, listHeight: 300 }, 0, 1000),
		], [116, 60, 200, 200, 32, 60, 0]);
	});

	test('あなたの番の数と行の文', () => {
		const bots = [
			bot('a', 'リリース係', { needsYou: 1 }),
			bot('b', 'レビュー係', { needsYou: 2, activity: 'working' }),
			bot('c', '見回り係', { activity: 'patrolling' }),
			bot('d', '翻訳係', { paused: true }),
			bot('e', '待ち係', { activity: 'idle' }),
			bot('f', '起動前'),
		];
		assert.deepStrictEqual([paradisBotsNeedsYouTotal(bots), bots.map(paradisBotStatusLine)], [
			3,
			['1 件があなたの番', '2 件があなたの番', '見回り中', '停止中', '待機中', '起動していません'],
		]);
	});

	test('待機中のうち、エージェントが見つからない・終わった・操作が要るときはその様子を出す', () => {
		assert.deepStrictEqual([
			bot('x', 'x', { activity: 'idle', halt: { kind: 'notFound' } }),
			bot('x', 'x', { activity: 'idle', halt: { kind: 'exited', exitCode: 1 } }),
			bot('x', 'x', { activity: 'idle', halt: { kind: 'exited', exitCode: 0 } }),
			bot('x', 'x', { activity: 'idle', halt: { kind: 'needsUser' } }),
			bot('x', 'x', { activity: 'idle' }),
		].map(paradisBotStatusLine).concat(paradisBotStatusDetail(bot('x', 'x', { activity: 'idle', halt: { kind: 'notFound' } }))), ['見つかりません', '終了しました（コード 1）', '終了しました', '操作が要ります', '待機中', 'エージェントのコマンドが見つかりません']);
	});

	test('会話のペインが無く前の会話が残っていれば、見回りのペインが動いていても会話の状態（眠っています）を主にする', () => {
		assert.deepStrictEqual([
			bot('x', 'x', { activity: 'idle', sleeping: true }),
			bot('x', 'x', { activity: 'patrolling', sleeping: true }),
			bot('x', 'x', { activity: 'stopped', sleeping: true }),
			bot('x', 'x', { activity: 'idle' }),
			bot('x', 'x', { activity: 'patrolling' }),
		].map(paradisBotStatusLine), ['眠っています', '眠っています・見回り中', '眠っています', '待機中', '見回り中']);
	});

	test('顔は台帳の形と色、動きは様子から', () => {
		assert.deepStrictEqual([
			paradisBotFace(bot('x', 'x', { faceColor: 'pink', faceShape: 'hex', needsYou: 1 })),
			paradisBotFace(bot('x', 'x', { activity: 'working' })).state,
			paradisBotFace(bot('x', 'x', { activity: 'patrolling' })).state,
			paradisBotFace(bot('x', 'x', { paused: true, needsYou: 1 })).state,
			paradisBotFace(bot('x', 'x')).state,
		], [{ shape: 'hex', color: 'pink', state: 'ask' }, 'work', 'work', 'paused', 'idle']);
	});

	test('作成と名前の変更の入力の検査', () => {
		const bots = [bot('a', 'リリース係'), bot('b', 'Review')];
		assert.deepStrictEqual([
			paradisValidateBotName('  CI の見張り ', bots),
			paradisValidateBotName('   ', bots),
			paradisValidateBotName('a\nb', bots),
			paradisValidateBotName('x'.repeat(65), bots),
			paradisValidateBotName('リリース係', bots),
			paradisValidateBotName('ｒｅｖｉｅｗ', bots),
			paradisValidateBotName('リリース係', bots, 'a'),
		], [
			{ ok: true, name: 'CI の見張り' },
			{ ok: false, problem: 'empty' },
			{ ok: false, problem: 'invalid' },
			{ ok: false, problem: 'invalid' },
			{ ok: false, problem: 'duplicate' },
			{ ok: false, problem: 'duplicate' },
			{ ok: true, name: 'リリース係' },
		]);
		assert.deepStrictEqual([paradisBotCreateSoul('CI の見張り', ' 落ちたチェックを調べる。 '), paradisBotCreateSoul('x', '  ')], ['# CI の見張り\n\n落ちたチェックを調べる。\n', undefined]);
	});

	test('行の右クリックのメニュー', () => {
		assert.deepStrictEqual([
			paradisBotRowMenu(bot('a', 'x')),
			paradisBotRowMenu(bot('a', 'x', { pinned: true, paused: true })),
		], [
			['pin', '-', 'rename', 'pause', '-', 'remove'],
			['unpin', '-', 'rename', 'resume', '-', 'remove'],
		]);
	});
});

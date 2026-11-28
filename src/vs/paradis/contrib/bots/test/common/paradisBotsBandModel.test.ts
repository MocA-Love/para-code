/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotSummary } from '../../common/paradisBotsApi.js';
import { PARADIS_BOT_FACE_COLORS, PARADIS_BOT_FACE_SHAPES, paradisBotDefaultFace } from '../../common/paradisBots.js';
import {
	PARADIS_BOT_FACE_TRANSITION_MS,
	paradisBotCreateFace,
	paradisBotCreateSoul,
	paradisBotFace,
	paradisBotFaceColorLabel,
	paradisBotFacePhaseSeconds,
	paradisBotFaceShapeLabel,
	ParadisBotFaceState,
	paradisBotFaceState,
	paradisBotFaceTransition,
	ParadisBotFaceTransitionLedger,
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

	test('顔は台帳の形と色、様子は帯の文と同じ順（停止中 → あなたの番 → 活動 → 止まっている理由）で決める', () => {
		const states = [
			{ paused: true, needsYou: 1, activity: 'working' },
			{ needsYou: 2, activity: 'working' },
			{ activity: 'working' },
			{ activity: 'patrolling' },
			{ activity: 'patrolling', sleeping: true },
			{ activity: 'idle' },
			{ activity: 'idle', halt: { kind: 'needsUser' } },
			{ activity: 'idle', halt: { kind: 'exited', exitCode: 1 } },
			{ activity: 'idle', halt: { kind: 'notFound' } },
			{ activity: 'idle', sleeping: true },
			{ activity: 'stopped', sleeping: true },
			{ activity: 'stopped' },
		] as const;
		assert.deepStrictEqual({
			face: paradisBotFace(bot('x', 'x', { faceColor: 'pink', faceShape: 'hex', needsYou: 1 })),
			states: states.map(patch => [paradisBotStatusLine(bot('x', 'x', patch)), paradisBotFaceState(bot('x', 'x', patch))]),
		}, {
			face: { shape: 'hex', color: 'pink', state: 'ask', id: 'x' },
			states: [
				['停止中', 'paused'],
				['2 件があなたの番', 'ask'],
				['作業中', 'work'],
				['見回り中', 'patrol'],
				['眠っています・見回り中', 'patrol'],
				['待機中', 'idle'],
				['操作が要ります', 'need'],
				['終了しました（コード 1）', 'halt'],
				['見つかりません', 'halt'],
				['眠っています', 'sleep'],
				['眠っています', 'sleep'],
				['起動していません', 'off'],
			],
		});
	});

	test('様子の変わり目のつなぎ: 起きる・できた・震える・跳ねる。初めて描くとき・同じ様子のままでは出さない', () => {
		const pairs: readonly [ParadisBotFaceState | undefined, ParadisBotFaceState][] = [
			[undefined, 'need'], ['idle', 'idle'],
			['sleep', 'idle'], ['off', 'work'], ['sleep', 'patrol'], ['sleep', 'ask'], ['sleep', 'paused'],
			['work', 'idle'], ['patrol', 'idle'],
			['idle', 'need'], ['work', 'halt'], ['need', 'halt'],
			['idle', 'ask'], ['work', 'ask'],
			['idle', 'work'], ['ask', 'idle'],
		];
		assert.deepStrictEqual(pairs.map(([from, to]) => `${from ?? '-'}>${to}:${paradisBotFaceTransition(from, to) ?? ''}`), [
			'->need:', 'idle>idle:',
			'sleep>idle:wake', 'off>work:wake', 'sleep>patrol:wake', 'sleep>ask:wake', 'sleep>paused:',
			'work>idle:done', 'patrol>idle:',
			'idle>need:shiver', 'work>halt:shiver', 'need>halt:',
			'idle>ask:hop', 'work>ask:hop',
			'idle>work:', 'ask>idle:',
		]);
	});

	test('つなぎは Bot ごとに 1 回だけ始まり、描き直しても同じ時刻から続け、長さを過ぎたら出さない', () => {
		const ledger = new ParadisBotFaceTransitionLedger();
		assert.deepStrictEqual([
			ledger.observe('a', 'work', 0),
			ledger.observe('b', 'idle', 0),
			ledger.observe('a', 'idle', 1000),
			// 帯と見出しの 2 か所で描いても、同じつなぎの続き
			ledger.observe('a', 'idle', 1500),
			ledger.observe('a', 'idle', 1000 + PARADIS_BOT_FACE_TRANSITION_MS.done),
			ledger.observe('b', 'need', 3000),
		], [undefined, undefined, { kind: 'done', elapsedMs: 0 }, { kind: 'done', elapsedMs: 500 }, undefined, { kind: 'shiver', elapsedMs: 0 }]);
	});

	test('位相は id から 0〜3.9 秒に決まり、Bot ごとにずれる', () => {
		const phases = ['release', 'review', 'ci', 'docs', 'triage', 'deps', 'perf'].map(paradisBotFacePhaseSeconds);
		assert.deepStrictEqual({
			inRange: phases.every(phase => phase >= 0 && phase < 4 && Math.round(phase * 10) === phase * 10),
			stable: paradisBotFacePhaseSeconds('release') === phases[0],
			distinct: new Set(phases).size > 1,
		}, { inRange: true, stable: true, distinct: true });
	});

	test('作成の画面の顔: 手で選んだ方はそのまま、選んでいない方は名前に追従する。色と形には日本語の名前がある', () => {
		const byName = paradisBotDefaultFace('CI の見張り');
		const seed = paradisBotDefaultFace('新');
		assert.deepStrictEqual({
			none: paradisBotCreateFace(' CI の見張り ', '新', {}),
			empty: paradisBotCreateFace('  ', '新', {}),
			color: paradisBotCreateFace('CI の見張り', '新', { color: 'red' }),
			shape: paradisBotCreateFace('CI の見張り', '新', { shape: 'penta' }),
			colors: PARADIS_BOT_FACE_COLORS.map(paradisBotFaceColorLabel).join('・'),
			shapes: PARADIS_BOT_FACE_SHAPES.map(paradisBotFaceShapeLabel).join('・'),
		}, {
			none: byName,
			empty: seed,
			color: { faceColor: 'red', faceShape: byName.faceShape },
			shape: { faceColor: byName.faceColor, faceShape: 'penta' },
			colors: '青・青緑・緑・山吹・桃・紫・赤・橙',
			shapes: '丸・角丸・六角・もち・しずく・五角',
		});
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

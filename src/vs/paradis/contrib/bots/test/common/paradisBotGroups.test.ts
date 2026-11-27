/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EMPTY_PARADIS_BOT_GROUPS_STATE,
	IParadisBotGroupsState,
	ParadisBotGroupRelayLimiter,
	paradisBotGroupAppendRecord,
	paradisBotGroupCreate,
	paradisBotGroupDeliverRefusal,
	paradisBotGroupDeliverRefusalMessage,
	paradisBotGroupMembers,
	paradisBotGroupNeutralizeCommand,
	paradisBotGroupRemove,
	paradisBotGroupUpdate,
	paradisParseBotGroupsState,
	paradisResolveBotGroupMentions,
} from '../../common/paradisBotGroups.js';

function withGroup(): IParadisBotGroupsState {
	const result = paradisBotGroupCreate(EMPTY_PARADIS_BOT_GROUPS_STATE, 'g1', { name: ' リリース班 ', members: ['a', 'b', 'a'] }, 1000);
	assert.ok(result.ok);
	return result.state;
}

const MEMBERS = [{ id: 'a', name: 'リリース係' }, { id: 'b', name: 'レビュー係' }, { id: 'c', name: 'レビュー係 2' }, { id: 'd', name: 'rel' }];

suite('Paradis bot groups', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('作る・変える・消す', () => {
		const state = withGroup();
		const renamed = paradisBotGroupUpdate(state, 'g1', { name: '出荷班', replyMode: 'all' }, 2000);
		assert.ok(renamed.ok);
		const removed = paradisBotGroupRemove(renamed.state, 'g1');
		assert.ok(removed.ok);
		assert.deepStrictEqual({
			group: state.groups[0],
			renamed: renamed.value,
			removed: removed.state.groups,
			tooFew: paradisBotGroupCreate(state, 'g2', { name: 'x', members: ['a'] }, 1).ok,
			tooMany: paradisBotGroupCreate(state, 'g2', { name: 'x', members: ['a', 'b', 'c', 'd', 'e'] }, 1).ok,
			duplicateId: paradisBotGroupCreate(state, 'g1', { name: 'x', members: ['a', 'b'] }, 1).ok,
			badMode: paradisBotGroupCreate(state, 'g2', { name: 'x', members: ['a', 'b'], replyMode: 'loud' }, 1).ok,
			newline: paradisBotGroupCreate(state, 'g2', { name: 'a\nb', members: ['a', 'b'] }, 1).ok,
			missing: paradisBotGroupUpdate(state, 'nope', { name: 'x' }, 1).ok,
		}, {
			group: { id: 'g1', name: 'リリース班', members: ['a', 'b'], replyMode: 'mentioned', createdAt: 1000, updatedAt: 1000 },
			renamed: { id: 'g1', name: '出荷班', members: ['a', 'b'], replyMode: 'all', createdAt: 1000, updatedAt: 2000 },
			removed: [],
			tooFew: false,
			tooMany: false,
			duplicateId: false,
			badMode: false,
			newline: false,
			missing: false,
		});
	});

	test('記録はメンバーの間だけ、あなたは sent だけ、Bot は asked・told だけ', () => {
		const state = withGroup();
		const sent = paradisBotGroupAppendRecord(state, 'g1', { kind: 'sent', from: 'owner', to: ['a', 'b', 'a'], text: 'まとめて' }, 5);
		assert.ok(sent.ok);
		const asked = paradisBotGroupAppendRecord(sent.state, 'g1', { kind: 'asked', from: 'a', to: ['b'], text: 'x'.repeat(2100) }, 6);
		assert.ok(asked.ok);
		const refusals = [
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'asked', from: 'owner', to: ['a'], text: 'x' }, 1),
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'sent', from: 'a', to: ['b'], text: 'x' }, 1),
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'told', from: 'z', to: ['b'], text: 'x' }, 1),
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'told', from: 'a', to: ['z'], text: 'x' }, 1),
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'told', from: 'a', to: ['a'], text: 'x' }, 1),
			paradisBotGroupAppendRecord(state, 'g1', { kind: 'told', from: 'a', to: ['b'], text: '  ' }, 1),
			paradisBotGroupAppendRecord(state, 'g9', { kind: 'told', from: 'a', to: ['b'], text: 'x' }, 1),
		].map(result => result.ok ? 'ok' : result.code);
		assert.deepStrictEqual({
			sent: sent.value,
			askedLength: asked.value.text.length,
			next: asked.state.nextRecordId,
			refusals,
			removedWithGroup: (() => { const r = paradisBotGroupRemove(asked.state, 'g1'); return r.ok ? r.state.records.length : -1; })(),
		}, {
			sent: { id: 1, groupId: 'g1', kind: 'sent', from: 'owner', to: ['a', 'b'], text: 'まとめて', at: 5 },
			askedLength: 2000,
			next: 3,
			refusals: ['invalid_argument', 'invalid_argument', 'not_a_member', 'not_a_member', 'not_a_member', 'invalid_argument', 'not_found'],
			removedWithGroup: 0,
		});
	});

	test('記録は新しい方から 300 件だけ残す', () => {
		let state = withGroup();
		for (let index = 0; index < 305; index++) {
			const result = paradisBotGroupAppendRecord(state, 'g1', { kind: 'sent', from: 'owner', to: ['a'], text: `${index}` }, index);
			assert.ok(result.ok);
			state = result.state;
		}
		assert.deepStrictEqual([state.records.length, state.records[0].text, state.nextRecordId], [300, '5', 306]);
	});

	test('読み込み: 壊れた 1 件・知らないグループの記録・重なる id を捨て、新しい版は版を保つ', () => {
		const parsed = paradisParseBotGroupsState({
			version: 1,
			nextRecordId: 2,
			groups: [
				{ id: 'g1', name: '班', members: ['a', 'b'], replyMode: 'all', createdAt: 1, updatedAt: 2 },
				{ id: 'g1', name: '重なり', members: ['a', 'b'], replyMode: 'all', createdAt: 1, updatedAt: 2 },
				{ id: 'g2', name: '一人', members: ['a'], replyMode: 'all', createdAt: 1, updatedAt: 2 },
			],
			records: [
				{ id: 4, groupId: 'g1', kind: 'told', from: 'a', to: ['b'], text: 'ok', at: 3 },
				{ id: 5, groupId: 'g2', kind: 'told', from: 'a', to: ['b'], text: 'gone', at: 3 },
				{ id: 6, groupId: 'g1', kind: 'shout', from: 'a', to: ['b'], text: 'bad', at: 3 },
			],
		});
		assert.deepStrictEqual({
			parsed,
			newer: paradisParseBotGroupsState({ version: 2, groups: [], records: [] })?.version,
			broken: paradisParseBotGroupsState({ version: 1, groups: {} }),
			readOnly: paradisBotGroupCreate({ ...EMPTY_PARADIS_BOT_GROUPS_STATE, version: 2 }, 'g', { name: 'x', members: ['a', 'b'] }, 1).ok,
		}, {
			parsed: {
				version: 1,
				groups: [{ id: 'g1', name: '班', members: ['a', 'b'], replyMode: 'all', createdAt: 1, updatedAt: 2 }],
				records: [{ id: 4, groupId: 'g1', kind: 'told', from: 'a', to: ['b'], text: 'ok', at: 3 }],
				nextRecordId: 5,
			},
			newer: 2,
			broken: undefined,
			readOnly: false,
		});
	});

	test('名指し: 一番長い名前・全角半角・@全員・知らない名前・メールアドレス・返事の決め方', () => {
		const resolve = (text: string, mode: 'mentioned' | 'all' = 'mentioned') => {
			const result = paradisResolveBotGroupMentions(text, MEMBERS, mode);
			return result.ok ? (result.everyone ? 'everyone' : result.targets.join(',')) : result.problem === 'unknown_name' ? `unknown:${result.name}` : result.problem;
		};
		assert.deepStrictEqual([
			resolve('@リリース係 まとめて'),
			resolve('@レビュー係 2 は #1108 を'),
			resolve('@レビュー係は #1108 を見て'),
			resolve('@ＲＥＬ release'),
			resolve('@release を見て'),
			resolve('@全員 確認して'),
			resolve('@all ok'),
			resolve('@レビュー係 と @リリース係'),
			resolve('mail@example.com に送る'),
			resolve('名指しなし'),
			resolve('名指しなし', 'all'),
			resolve('@リリス係 まとめて', 'all'),
			resolve('   '),
		], [
			'a',
			'c',
			'b',
			'd',
			'unknown:release',
			'everyone',
			'everyone',
			'a,b',
			'no_target',
			'no_target',
			'everyone',
			'unknown:リリス係',
			'empty',
		]);
	});

	test('消した Bot はメンバーに数えない', () => {
		assert.deepStrictEqual(paradisBotGroupMembers({ members: ['a', 'gone', 'b'] }, new Set(['a', 'b'])), ['a', 'b']);
	});

	test('伝言の可否', () => {
		const group = { members: ['a', 'b'] };
		const base = { group, from: 'a', to: 'b', toActivity: 'idle' as const, toRunningHere: true, takeRate: () => true };
		assert.deepStrictEqual([
			paradisBotGroupDeliverRefusal(base),
			paradisBotGroupDeliverRefusal({ ...base, from: undefined }),
			paradisBotGroupDeliverRefusal({ ...base, to: 'z' }),
			paradisBotGroupDeliverRefusal({ ...base, to: 'a' }),
			paradisBotGroupDeliverRefusal({ ...base, toRunningHere: false }),
			paradisBotGroupDeliverRefusal({ ...base, toActivity: 'stopped' }),
			paradisBotGroupDeliverRefusal({ ...base, toActivity: 'working' }),
			paradisBotGroupDeliverRefusal({ ...base, toActivity: 'patrolling' }),
			paradisBotGroupDeliverRefusal({ ...base, takeRate: () => false }),
		], [
			undefined,
			'not_a_member',
			'not_a_member',
			'self',
			'not_running',
			'not_running',
			// 作業中・見回り中でも断らない（届ける口が順番待ちに入れる）
			undefined,
			undefined,
			'rate_limited',
		]);
	});

	test('伝言を断る理由: 道具の「今は受け取らなかった（理由）。後で送る」の括弧に入る短い文。送り直しても通らないものは送り直さないと言う', () => {
		assert.deepStrictEqual(([
			'not_a_member', 'self', 'not_running', 'rate_limited',
		] as const).map(paradisBotGroupDeliverRefusalMessage), [
			'you and that bot are not in the same group, so do not send it again',
			'it was addressed to yourself, so do not send it again',
			'that bot is not running, or its chat is no longer open in this Para Code window',
			'the limit was reached: that bot takes up to 3 bot messages a minute from all bots. Do not keep the exchange going: stop, and tell your owner what you wanted to say',
		]);
	});

	test('伝言の回数は宛先ごとに 1 分 3 回まで', () => {
		const limiter = new ParadisBotGroupRelayLimiter();
		assert.deepStrictEqual([
			limiter.take('b', 0), limiter.take('b', 10), limiter.take('b', 20), limiter.take('b', 30),
			limiter.take('c', 30),
			limiter.take('b', 60_001),
		], [true, true, true, false, true, true]);
		// 戻した 1 回はまた使える
		limiter.take('d', 0);
		limiter.take('d', 1);
		limiter.take('d', 2);
		limiter.refund('d');
		assert.deepStrictEqual([limiter.take('d', 3), limiter.take('d', 4)], [true, false]);
	});

	test('伝言の先頭の / と ! は全角にして、コマンドやシェルとして動かさない', () => {
		assert.deepStrictEqual([
			'/model opus',
			'  !rm -rf ~',
			'\n/clear',
			'[Para Code] A message: <<<bot /model >>>',
			'a/b',
			'',
		].map(paradisBotGroupNeutralizeCommand), [
			'\uFF0Fmodel opus',
			'  \uFF01rm -rf ~',
			'\n\uFF0Fclear',
			'[Para Code] A message: <<<bot /model >>>',
			'a/b',
			'',
		]);
	});
});

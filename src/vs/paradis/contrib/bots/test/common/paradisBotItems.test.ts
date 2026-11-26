/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EMPTY_PARADIS_BOT_ITEMS_STATE,
	IParadisBotItem,
	IParadisBotItemChanges,
	IParadisBotItemsState,
	PARADIS_BOT_ITEM_LIMITS,
	PARADIS_BOT_ITEM_STATUSES,
	ParadisBotItemsResult,
	ParadisBotItemStatus,
	paradisBotItemAdd,
	paradisBotItemCounts,
	paradisBotItemOwnerComment,
	paradisBotItemOwnerSnooze,
	paradisBotItemOwnerStatus,
	paradisBotItemsMarkDelivered,
	paradisBotItemsOf,
	paradisBotItemsPendingMail,
	paradisBotItemsRemoveBot,
	paradisBotItemsToStored,
	paradisBotItemUpdate,
	paradisBotItemWaitsForOwner,
	paradisIsBotItemLocked,
	paradisParseBotItemsState,
	paradisSanitizeBotItemLink,
	paradisSanitizeBotItemQuestions,
} from '../../common/paradisBotItems.js';

function ok(result: ParadisBotItemsResult): { state: IParadisBotItemsState; item: IParadisBotItem; eventId?: number } {
	assert.ok(result.ok, result.ok ? '' : `${result.code}: ${result.message}`);
	return result;
}

function code(result: ParadisBotItemsResult): string {
	return result.ok ? (result.unchanged ? 'unchanged' : 'ok') : result.code;
}

/** Bot `b1` の項目 #1（uid `u1`）を 1 つ持つ台帳。 */
function one(status: 'planned' | 'working' = 'working'): IParadisBotItemsState {
	return ok(paradisBotItemAdd(EMPTY_PARADIS_BOT_ITEMS_STATE, { uid: 'u1', botId: 'b1', title: 'ログインの不具合を直す', status }, 1000)).state;
}

function update(state: IParadisBotItemsState, changes: IParadisBotItemChanges, now = 2000): IParadisBotItemsState {
	return ok(paradisBotItemUpdate(state, 'b1', 1, changes, now)).state;
}

/** 項目 #1 を、決まった状態まで進めた台帳。 */
function at(status: ParadisBotItemStatus): IParadisBotItemsState {
	switch (status) {
		case 'planned': return one('planned');
		case 'working': return one();
		case 'waiting': return update(one(), { status: 'waiting' });
		case 'needs_you': return update(one(), { status: 'needs_you', questions: [{ prompt: '残しますか?', options: [{ label: '残す' }, { label: '消す' }] }] });
		case 'done': return update(one(), { status: 'done' });
		case 'canceled': return update(one(), { status: 'canceled', reason: '不要になった' });
	}
}

const QUESTIONS = [{ prompt: '全員をログアウトさせますか?', options: [{ label: 'させる' }, { label: '残す', detail: '今のセッションだけ' }], recommended: 1 }];

suite('Paradis bot items', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('追加: 番号は通しで振り、作成のイベントを 1 件持つ', () => {
		const first = ok(paradisBotItemAdd(EMPTY_PARADIS_BOT_ITEMS_STATE, { uid: 'u1', botId: 'b1', title: ' 題 ', description: '説明', doneMeans: 'テストが通る', links: [{ kind: 'pr', ref: 'a/b#1' }] }, 1000));
		const second = ok(paradisBotItemAdd(first.state, { uid: 'u2', botId: 'b2', title: '次', status: 'planned' }, 2000));
		assert.deepStrictEqual(second.state, {
			version: 1,
			nextNumber: 3,
			items: [
				{
					uid: 'u1', number: 1, botId: 'b1', title: '題', description: '説明', doneMeans: 'テストが通る', status: 'working',
					links: [{ kind: 'pr', ref: 'a/b#1' }], events: [{ id: 1, kind: 'made', actor: 'bot', at: 1000, to: 'working' }],
					lastEventId: 1, lastActivityAt: 1000, createdAt: 1000, updatedAt: 1000,
				},
				{
					uid: 'u2', number: 2, botId: 'b2', title: '次', status: 'planned',
					links: [], events: [{ id: 1, kind: 'made', actor: 'bot', at: 2000, to: 'planned' }],
					lastEventId: 1, lastActivityAt: 2000, createdAt: 2000, updatedAt: 2000,
				},
			],
		});
	});

	test('Bot の状態の遷移（6 × 6 の全部）', () => {
		const table: Record<string, string[]> = {};
		for (const from of PARADIS_BOT_ITEM_STATUSES) {
			table[from] = PARADIS_BOT_ITEM_STATUSES.map(to => code(paradisBotItemUpdate(at(from), 'b1', 1, { status: to, ...(to === 'canceled' ? { reason: 'やめた' } : {}) }, 3000)));
		}
		assert.deepStrictEqual(table, {
			//           planned      working      waiting      needs_you    done           canceled
			planned: ['unchanged', 'ok', 'ok', 'ok', 'ok', 'ok'],
			working: ['ok', 'unchanged', 'ok', 'ok', 'ok', 'ok'],
			waiting: ['ok', 'ok', 'unchanged', 'ok', 'ok', 'ok'],
			needs_you: ['ok', 'ok', 'ok', 'unchanged', 'ok', 'ok'],
			// 閉じた項目は、開いている状態へ戻すときだけ書ける
			done: ['ok', 'ok', 'ok', 'ok', 'unchanged', 'item_closed'],
			canceled: ['ok', 'ok', 'ok', 'ok', 'item_closed', 'item_closed'],
		});
	});

	test('持ち主の状態の遷移（6 × 6 の全部）', () => {
		const table: Record<string, string[]> = {};
		for (const from of PARADIS_BOT_ITEM_STATUSES) {
			table[from] = PARADIS_BOT_ITEM_STATUSES.map(to => code(paradisBotItemOwnerStatus(at(from), 'u1', to, undefined, 3000)));
		}
		assert.deepStrictEqual(table, {
			planned: ['unchanged', 'ok', 'ok', 'ok', 'ok', 'ok'],
			working: ['ok', 'unchanged', 'ok', 'ok', 'ok', 'ok'],
			waiting: ['ok', 'ok', 'unchanged', 'ok', 'ok', 'ok'],
			needs_you: ['ok', 'ok', 'ok', 'unchanged', 'ok', 'ok'],
			done: ['ok', 'ok', 'ok', 'ok', 'unchanged', 'ok'],
			canceled: ['ok', 'ok', 'ok', 'ok', 'ok', 'unchanged'],
		});
	});

	test('Needs you: 問いを付け、持ち主の答えで作業中へ戻る', () => {
		const asked = ok(paradisBotItemUpdate(one(), 'b1', 1, { status: 'needs_you', comment: 'セッションの扱いを決めてください', questions: QUESTIONS }, 2000));
		const answered = ok(paradisBotItemOwnerComment(asked.state, 'u1', { text: '残す', askEventId: 2 }, 3000));
		assert.deepStrictEqual({ asked: { status: asked.item.status, ask: asked.item.ask, eventId: asked.eventId }, answered: answered.item }, {
			asked: { status: 'needs_you', ask: { eventId: 2, context: 'セッションの扱いを決めてください', questions: QUESTIONS }, eventId: 3 },
			answered: {
				uid: 'u1', number: 1, botId: 'b1', title: 'ログインの不具合を直す', status: 'working', links: [],
				events: [
					{ id: 1, kind: 'made', actor: 'bot', at: 1000, to: 'working' },
					{ id: 2, kind: 'commented', actor: 'bot', at: 2000, text: 'セッションの扱いを決めてください' },
					{ id: 3, kind: 'status', actor: 'bot', at: 2000, from: 'working', to: 'needs_you' },
					{ id: 4, kind: 'commented', actor: 'owner', at: 3000, text: '残す', answers: 2, toBot: true },
					{ id: 5, kind: 'status', actor: 'owner', at: 3000, from: 'needs_you', to: 'working' },
				],
				lastEventId: 5, lastActivityAt: 3000, createdAt: 1000, updatedAt: 3000,
			},
		});
	});

	test('Needs you: 聞き直すと問いの id が変わり、古い問いへの答えは断る', () => {
		const first = update(one(), { status: 'needs_you', questions: QUESTIONS });
		const again = ok(paradisBotItemUpdate(first, 'b1', 1, { status: 'needs_you', comment: '聞き直します', questions: [{ prompt: 'A と B のどちらですか?', options: [] }] }, 3000));
		const same = paradisBotItemUpdate(again.state, 'b1', 1, { status: 'needs_you' }, 4000);
		assert.deepStrictEqual({
			firstAsk: first.items[0].ask?.eventId,
			againAsk: again.item.ask,
			stale: code(paradisBotItemOwnerComment(again.state, 'u1', { text: '残す', askEventId: 2 }, 5000)),
			current: code(paradisBotItemOwnerComment(again.state, 'u1', { text: 'A', askEventId: 3 }, 5000)),
			same: code(same),
		}, {
			firstAsk: 2,
			againAsk: { eventId: 3, context: '聞き直します', questions: [{ prompt: 'A と B のどちらですか?', options: [] }] },
			stale: 'item_changed',
			current: 'ok',
			same: 'unchanged',
		});
	});

	test('Needs you: ただのコメントは待たせたまま、飛ばすと作業中へ戻る', () => {
		const asked = at('needs_you');
		const plain = ok(paradisBotItemOwnerComment(asked, 'u1', { text: '少し待って', plain: true }, 3000));
		const skipped = ok(paradisBotItemOwnerComment(plain.state, 'u1', { text: '', skipped: true }, 4000));
		assert.deepStrictEqual({
			plain: [plain.item.status, plain.item.events.at(-1)],
			skipped: [skipped.item.status, skipped.item.ask, skipped.item.events.slice(-2)],
			skipWithoutAsk: code(paradisBotItemOwnerComment(one(), 'u1', { text: '', skipped: true }, 3000)),
			emptyComment: code(paradisBotItemOwnerComment(one(), 'u1', { text: '  ' }, 3000)),
		}, {
			plain: ['needs_you', { id: 3, kind: 'commented', actor: 'owner', at: 3000, text: '少し待って', toBot: true }],
			skipped: ['working', undefined, [
				{ id: 4, kind: 'commented', actor: 'owner', at: 4000, answers: 2, skipped: true, toBot: true },
				{ id: 5, kind: 'status', actor: 'owner', at: 4000, from: 'needs_you', to: 'working' },
			]],
			skipWithoutAsk: 'item_changed',
			emptyComment: 'invalid_argument',
		});
	});

	test('Bot の書き換え: 欄・リンク・コメント・完了', () => {
		const edited = ok(paradisBotItemUpdate(one(), 'b1', 1, {
			title: '新しい題', description: '説明', comment: '半分終わった',
			links: [{ kind: 'pr', ref: 'a/b#7' }, { kind: 'pr', ref: 'a/b#7' }, { kind: 'file', ref: 'memory/report.md' }],
		}, 2000));
		const done = ok(paradisBotItemUpdate(edited.state, 'b1', 1, { status: 'done', note: 'マージ済み', description: '' }, 3000));
		const reopened = ok(paradisBotItemUpdate(done.state, 'b1', 1, { status: 'working', comment: 'まだ残りがあった' }, 4000));
		assert.deepStrictEqual({
			edited: { title: edited.item.title, links: edited.item.links, events: edited.item.events.slice(1) },
			done: { status: done.item.status, description: done.item.description, closeNote: done.item.closeNote, closedAt: done.item.closedAt, last: done.item.events.slice(-2) },
			reopened: { status: reopened.item.status, closeNote: reopened.item.closeNote, closedAt: reopened.item.closedAt, last: reopened.item.events.slice(-2) },
		}, {
			edited: {
				title: '新しい題',
				links: [{ kind: 'pr', ref: 'a/b#7' }, { kind: 'file', ref: 'memory/report.md' }],
				events: [
					{ id: 2, kind: 'edited', actor: 'bot', at: 2000, fields: ['title', 'description'] },
					{ id: 3, kind: 'linked', actor: 'bot', at: 2000, refs: ['a/b#7', 'memory/report.md'] },
					{ id: 4, kind: 'commented', actor: 'bot', at: 2000, text: '半分終わった' },
				],
			},
			done: {
				status: 'done', description: undefined, closeNote: 'マージ済み', closedAt: 3000,
				last: [{ id: 5, kind: 'edited', actor: 'bot', at: 3000, fields: ['description'] }, { id: 6, kind: 'status', actor: 'bot', at: 3000, from: 'working', to: 'done', note: 'マージ済み' }],
			},
			reopened: {
				status: 'working', closeNote: undefined, closedAt: undefined,
				last: [{ id: 7, kind: 'status', actor: 'bot', at: 4000, from: 'done', to: 'working' }, { id: 8, kind: 'commented', actor: 'bot', at: 4000, text: 'まだ残りがあった' }],
			},
		});
	});

	test('Bot の書き換えで断るもの', () => {
		const state = one();
		const long = 'x'.repeat(PARADIS_BOT_ITEM_LIMITS.text + 1);
		assert.deepStrictEqual([
			code(paradisBotItemUpdate(state, 'b2', 1, { comment: '横取り' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 9, { comment: 'x' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { status: 'canceled' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { status: 'done', reason: 'x' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { questions: QUESTIONS }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { title: '  ' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { comment: long }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, {}, 2000)),
			code(paradisBotItemUpdate(at('done'), 'b1', 1, { comment: '閉じた後のコメント' }, 3000)),
			code(paradisBotItemUpdate({ ...state, version: 2 }, 'b1', 1, { comment: 'x' }, 2000)),
			code(paradisBotItemAdd(state, { uid: 'u1', botId: 'b1', title: '同じ uid' }, 2000)),
			code(paradisBotItemAdd(state, { uid: 'u2', botId: 'b1', title: '' }, 2000)),
			code(paradisBotItemAdd({ ...state, version: 2 }, { uid: 'u2', botId: 'b1', title: 'x' }, 2000)),
		], ['not_owner', 'not_found', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'invalid_argument', 'unchanged', 'item_closed', 'read_only', 'invalid_argument', 'invalid_argument', 'read_only']);
	});

	test('上限: 開いている項目・イベント・リンク', () => {
		let state = EMPTY_PARADIS_BOT_ITEMS_STATE;
		for (let index = 0; index < PARADIS_BOT_ITEM_LIMITS.openPerBot; index++) {
			state = ok(paradisBotItemAdd(state, { uid: `u${index + 1}`, botId: 'b1', title: `項目 ${index}` }, 1000)).state;
		}
		let busy = one();
		for (let index = 1; index < PARADIS_BOT_ITEM_LIMITS.events; index++) {
			busy = update(busy, { comment: `報告 ${index}` });
		}
		const closedOnFull = paradisBotItemUpdate(busy, 'b1', 1, { status: 'done', comment: '残りは次の項目で' }, 3000);
		const ownerOnFull = ok(paradisBotItemOwnerComment(busy, 'u1', { text: '持ち主は書ける' }, 3000));
		const links = Array.from({ length: PARADIS_BOT_ITEM_LIMITS.links + 1 }, (_, index) => ({ kind: 'url' as const, ref: `https://example.com/${index}` }));
		assert.deepStrictEqual({
			open: code(paradisBotItemAdd(state, { uid: 'more', botId: 'b1', title: '201 個目' }, 2000)),
			otherBot: code(paradisBotItemAdd(state, { uid: 'more', botId: 'b2', title: 'ほかの Bot は足せる' }, 2000)),
			afterClose: code(paradisBotItemAdd(update(state, { status: 'done' }), { uid: 'more', botId: 'b1', title: '閉じれば足せる' }, 2000)),
			events: code(paradisBotItemUpdate(busy, 'b1', 1, { comment: '501 件目' }, 3000)),
			// いっぱいになった項目も、Bot は閉じられる
			closeOnFull: [code(closedOnFull), closedOnFull.ok ? closedOnFull.item.events.length : 0, closedOnFull.ok ? closedOnFull.item.status : ''],
			// 持ち主の書き込みは通し、作成の 1 件を残して古いものから落とす
			ownerOnFull: [ownerOnFull.item.events.length, ownerOnFull.item.events[0].kind, ownerOnFull.item.events[1].id, ownerOnFull.item.events.at(-1)?.text],
			links: code(paradisBotItemUpdate(one(), 'b1', 1, { links }, 2000)),
		}, {
			open: 'limit',
			otherBot: 'ok',
			afterClose: 'ok',
			events: 'limit',
			closeOnFull: ['ok', 500, 'done'],
			ownerOnFull: [500, 'made', 3, '持ち主は書ける'],
			links: 'limit',
		});
	});

	test('上限: 台帳がいっぱいなら閉じた古い項目から落とす', () => {
		const item = (index: number, status: string, closedAt?: number): IParadisBotItem => ({
			uid: `u${index}`, number: index, botId: `b${index % 20}`, title: 't', status, links: [], events: [], lastEventId: 0,
			lastActivityAt: 1, createdAt: 1, updatedAt: 1, ...(closedAt !== undefined ? { closedAt } : {}),
		});
		const items = Array.from({ length: PARADIS_BOT_ITEM_LIMITS.items }, (_, index) => item(index + 1, index === 5 ? 'done' : index === 6 ? 'canceled' : 'working', index === 5 ? 900 : index === 6 ? 800 : undefined));
		const full: IParadisBotItemsState = { version: 1, nextNumber: 2001, items };
		const added = ok(paradisBotItemAdd(full, { uid: 'new', botId: 'x', title: '新しい' }, 1000));
		const allOpen: IParadisBotItemsState = { ...full, items: items.map(existing => ({ ...existing, status: 'working' })) };
		assert.deepStrictEqual({
			length: added.state.items.length,
			droppedOldestClosed: [added.state.items.some(existing => existing.uid === 'u7'), added.state.items.some(existing => existing.uid === 'u6')],
			allOpen: code(paradisBotItemAdd(allOpen, { uid: 'new', botId: 'x', title: '新しい' }, 1000)),
		}, { length: 2000, droppedOldestClosed: [false, true], allOpen: 'limit' });
	});

	test('後回し: 状態を変えず、コメントで解ける', () => {
		const asked = at('needs_you');
		const snoozed = ok(paradisBotItemOwnerSnooze(asked, 'u1', 9000, 3000));
		const back = ok(paradisBotItemOwnerComment(snoozed.state, 'u1', { text: '見ました', plain: true }, 4000));
		assert.deepStrictEqual({
			snoozed: [snoozed.item.status, snoozed.item.snoozedUntil, snoozed.item.lastActivityAt, snoozed.item.events.at(-1)],
			countsWhileSnoozed: paradisBotItemCounts(snoozed.state, 'b1', 5000),
			countsAfterWake: paradisBotItemCounts(snoozed.state, 'b1', 9000),
			back: back.item.snoozedUntil,
			past: code(paradisBotItemOwnerSnooze(asked, 'u1', 2000, 3000)),
			closed: code(paradisBotItemOwnerSnooze(at('done'), 'u1', 9000, 3000)),
			clearUnchanged: code(paradisBotItemOwnerSnooze(asked, 'u1', undefined, 3000)),
		}, {
			snoozed: ['needs_you', 9000, 2000, { id: 3, kind: 'snoozed', actor: 'owner', at: 3000, until: 9000 }],
			countsWhileSnoozed: { open: 1, needsYou: 0, lastActivityAt: 2000 },
			countsAfterWake: { open: 1, needsYou: 1, lastActivityAt: 2000 },
			back: undefined,
			past: 'invalid_argument',
			closed: 'item_closed',
			clearUnchanged: 'unchanged',
		});
	});

	test('あなたの番: 持ち主が自分で Needs you にした項目（問いなし）は数えない', () => {
		const ownerSet = ok(paradisBotItemOwnerStatus(one(), 'u1', 'needs_you', undefined, 2000));
		const botAsked = ok(paradisBotItemUpdate(one(), 'b1', 1, { status: 'needs_you' }, 2000));
		assert.deepStrictEqual({
			ownerSet: [ownerSet.item.status, ownerSet.item.ask, paradisBotItemWaitsForOwner(ownerSet.item, 3000), paradisBotItemCounts(ownerSet.state, 'b1', 3000).needsYou],
			botAsked: [botAsked.item.status, botAsked.item.ask?.eventId, paradisBotItemWaitsForOwner(botAsked.item, 3000), paradisBotItemCounts(botAsked.state, 'b1', 3000).needsYou],
		}, {
			ownerSet: ['needs_you', undefined, false, 0],
			botAsked: ['needs_you', 2, true, 1],
		});
	});

	test('Bot へ届ける印: 持ち主の書き込みに付き、届けたら外れる', () => {
		const commented = ok(paradisBotItemOwnerComment(one(), 'u1', { text: 'これも見て' }, 2000)).state;
		const closed = ok(paradisBotItemOwnerStatus(commented, 'u1', 'canceled', 'やめます', 3000)).state;
		const pending = paradisBotItemsPendingMail(closed, 'b1');
		const delivered = paradisBotItemsMarkDelivered(closed, 'u1', [2]);
		assert.deepStrictEqual({
			pending: pending.map(entry => [entry.item.number, entry.events.map(event => event.id)]),
			otherBot: paradisBotItemsPendingMail(closed, 'b2'),
			afterDelivery: paradisBotItemsPendingMail(delivered, 'b1').map(entry => entry.events),
			nothingToMark: paradisBotItemsMarkDelivered(delivered, 'u1', [2]) === delivered,
		}, {
			pending: [[1, [2, 3]]],
			otherBot: [],
			afterDelivery: [[{ id: 3, kind: 'status', actor: 'owner', at: 3000, from: 'working', to: 'canceled', note: 'やめます', toBot: true }]],
			nothingToMark: true,
		});
	});

	test('一覧と Bot の削除', () => {
		let state = one();
		state = ok(paradisBotItemAdd(state, { uid: 'u2', botId: 'b1', title: '二つ目' }, 5000)).state;
		state = ok(paradisBotItemAdd(state, { uid: 'u3', botId: 'b2', title: 'ほかの Bot' }, 6000)).state;
		state = ok(paradisBotItemUpdate(state, 'b1', 2, { status: 'done' }, 7000)).state;
		assert.deepStrictEqual({
			all: paradisBotItemsOf(state).map(item => item.number),
			open: paradisBotItemsOf(state, { botId: 'b1', open: true }).map(item => item.number),
			closed: paradisBotItemsOf(state, { botId: 'b1', open: false }).map(item => item.number),
			removed: paradisBotItemsRemoveBot(state, 'b1').items.map(item => item.number),
			removedNone: paradisBotItemsRemoveBot(state, 'none') === state,
		}, { all: [2, 3, 1], open: [1], closed: [2], removed: [3], removedNone: true });
	});

	test('問いの検め', () => {
		const options = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `選択肢 ${index}` }));
		const message = (value: unknown) => {
			const result = paradisSanitizeBotItemQuestions(value);
			return typeof result === 'string' ? 'refused' : result;
		};
		assert.deepStrictEqual([
			message([{ prompt: ' どれにしますか? ', options: [{ label: ' A ', detail: ' 速い ' }, { label: 'B', detail: '' }], recommended: 0, multi: true }]),
			message([{ prompt: '選択肢なし?' }]),
			message(Array.from({ length: 6 }, (_, index) => ({ prompt: `問い ${index}?` }))),
			message([{ prompt: '多すぎ?', options: options(9) }]),
			message([{ prompt: '8 個は通る?', options: options(8) }]).length,
			message([{ prompt: '同じラベル?', options: [{ label: 'A' }, { label: 'A' }] }]),
			message([{ prompt: 'おすすめが範囲外?', options: options(2), recommended: 2 }]),
			message([{ prompt: '同じ問い?' }, { prompt: '同じ問い?' }]),
			message([{ prompt: '2 行\nの問い?' }]),
			message([{ prompt: 'x'.repeat(501) }]),
			message([{ options: [] }]),
			message('問い'),
		], [
			[{ prompt: 'どれにしますか?', options: [{ label: 'A', detail: '速い' }, { label: 'B' }], recommended: 0, multi: true }],
			[{ prompt: '選択肢なし?', options: [] }],
			'refused', 'refused', 1, 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused',
		]);
	});

	test('リンクの検め: 専用フォルダの外のファイルを断る', () => {
		assert.deepStrictEqual([
			{ kind: 'pr', ref: 'MocA-Love/para-code#1179' },
			{ kind: 'pr', ref: 'https://github.com/MocA-Love/para-code/pull/1179/files' },
			{ kind: 'pr', ref: 'not a pr' },
			{ kind: 'url', ref: 'https://example.com/a?b=1' },
			{ kind: 'url', ref: 'javascript:alert(1)' },
			{ kind: 'url', ref: 'file:///etc/passwd' },
			{ kind: 'file', ref: 'memory/report.md' },
			{ kind: 'file', ref: '../../.ssh/id_ed25519' },
			{ kind: 'file', ref: '/etc/passwd' },
			{ kind: 'dispatch', ref: 'x' },
			'x',
		].map(paradisSanitizeBotItemLink), [
			{ kind: 'pr', ref: 'MocA-Love/para-code#1179' },
			{ kind: 'pr', ref: 'MocA-Love/para-code#1179' },
			undefined,
			{ kind: 'url', ref: 'https://example.com/a?b=1' },
			undefined,
			undefined,
			{ kind: 'file', ref: 'memory/report.md' },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('読み込み: 形の違う 1 件だけを捨て、番号の続きを守る', () => {
		const good = ok(paradisBotItemOwnerComment(at('needs_you'), 'u1', { text: '少し待って', plain: true }, 3000)).state;
		const stored = JSON.parse(JSON.stringify(paradisBotItemsToStored(good)));
		const parsed = paradisParseBotItemsState({ ...stored, nextNumber: 1, items: [...stored.items, { ...stored.items[0], uid: 'dup-number' }, { ...stored.items[0], uid: 'u9', number: 9, title: '' }, { uid: 'u8' }, 'x'] });
		assert.deepStrictEqual([
			parsed,
			paradisParseBotItemsState({ version: 1 }),
			paradisParseBotItemsState({ version: 0, items: [] }),
			paradisParseBotItemsState('x'),
		], [{ ...good, nextNumber: 2 }, undefined, undefined, undefined]);
	});

	test('読み込み: 知らない状態の項目は壊さず、その項目だけ読み取り専用にする', () => {
		const base = JSON.parse(JSON.stringify(paradisBotItemsToStored(one())));
		// この版の知らない状態 `blocked` を、新しい Para Code が書いた形（知らない欄 `block` 付き）
		// 新しい版で持ち主がコメントした（Bot へ届ける印 toBot が付いた）まま
		const blocked = { ...base.items[0], uid: 'u2', number: 2, status: 'blocked', block: { text: 'CI の完了', at: 5 }, events: [...base.items[0].events, { id: 2, kind: 'commented', actor: 'owner', at: 3, text: '見て', toBot: true }], lastEventId: 2 };
		const stored = { version: 1, nextNumber: 3, items: [base.items[0], blocked] };
		const state = paradisParseBotItemsState(stored);
		assert.ok(state);
		const added = ok(paradisBotItemAdd(state, { uid: 'u3', botId: 'b1', title: '三つ目' }, 4000)).state;
		assert.deepStrictEqual({
			locked: state.items.map(paradisIsBotItemLocked),
			known: code(paradisBotItemUpdate(state, 'b1', 1, { comment: '知っている項目は書ける' }, 4000)),
			botWrite: code(paradisBotItemUpdate(state, 'b1', 2, { status: 'working' }, 4000)),
			ownerComment: code(paradisBotItemOwnerComment(state, 'u2', { text: 'x' }, 4000)),
			ownerStatus: code(paradisBotItemOwnerStatus(state, 'u2', 'done', undefined, 4000)),
			ownerSnooze: code(paradisBotItemOwnerSnooze(state, 'u2', 9000, 4000)),
			delivered: paradisBotItemsMarkDelivered(state, 'u2', [2]) === state,
			// 読み取り専用の項目は印を外せないので、未配達にも数えない（古い版で開くたびに出続けないように）
			pending: paradisBotItemsPendingMail(state, 'b1'),
			pendingInNewerLedger: paradisBotItemsPendingMail({ ...state, version: 2 }, 'b1'),
			counts: paradisBotItemCounts(state, 'b1', 4000),
			// 書き戻しても、読んだ値（知らない欄を含む）がそのまま残る
			roundTrip: JSON.parse(JSON.stringify(paradisBotItemsToStored(added))).items[1],
		}, {
			locked: [false, true],
			known: 'ok',
			botWrite: 'read_only',
			ownerComment: 'read_only',
			ownerStatus: 'read_only',
			ownerSnooze: 'read_only',
			delivered: true,
			pending: [],
			pendingInNewerLedger: [],
			counts: { open: 2, needsYou: 0, lastActivityAt: 1000 },
			roundTrip: blocked,
		});
	});

	test('読み込み: 新しい版の台帳は中身を読めるが、どの書き込みも断る', () => {
		const stored = JSON.parse(JSON.stringify(paradisBotItemsToStored(one())));
		const state = paradisParseBotItemsState({ ...stored, version: 2 });
		assert.ok(state);
		assert.deepStrictEqual([
			state.items.map(item => item.title),
			code(paradisBotItemAdd(state, { uid: 'u2', botId: 'b1', title: 'x' }, 2000)),
			code(paradisBotItemUpdate(state, 'b1', 1, { comment: 'x' }, 2000)),
			code(paradisBotItemOwnerComment(state, 'u1', { text: 'x' }, 2000)),
			code(paradisBotItemOwnerStatus(state, 'u1', 'done', undefined, 2000)),
			code(paradisBotItemOwnerSnooze(state, 'u1', 9000, 2000)),
			paradisBotItemsRemoveBot(state, 'b1') === state,
		], [['ログインの不具合を直す'], 'read_only', 'read_only', 'read_only', 'read_only', 'read_only', true]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskInput } from '../../../humanAsk/common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { paradisMobileHumanAskSummary, paradisMobileHumanAsks, paradisParseMobileHumanAskAnswerRequest, paradisParseMobileHumanAskSummary } from '../../common/paradisMobileHumanAsks.js';

const QUESTION = [{ id: 'q0', text: '残しますか?', options: [{ id: '0', label: '残す' }], allowText: true }];

function input(source: IParadisHumanAskInput['source'], id: string, kind: IParadisHumanAskInput['kind'], extra: Partial<IParadisHumanAskInput> = {}): IParadisHumanAskInput {
	return { source, id, kind, from: { title: 'api' }, questions: kind === 'question' ? QUESTION : [], actions: kind === 'question' ? [] : [{ id: 'yes', label: '許可' }], canSkip: false, askedAt: 5, ...extra };
}

suite('Paradis mobile human asks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the phone gets only what it has no card for: no permissions, no pane questions, no fold targets', () => {
		const ledger = new ParadisHumanAskLedger(() => 10);
		ledger.upsert('panes', input('pane', 'p1', 'question', { paneKey: 'k1' }));
		ledger.upsert('panes', input('pane', 'p2', 'permission', { paneKey: 'k2' }));
		ledger.upsert('askHuman', input('pane', 'ask:1', 'question', { paneKey: 'k3' }));
		// ボードの質問が、ペイン k1 の質問の寄せ先（スマホはペインの要対応として出している）
		ledger.upsert('board:1', input('board', 'b1', 'question', { paneKey: 'k1' }));
		ledger.upsert('board:1', input('board', 'b2', 'approval', { actions: [{ id: 'sendBack', label: '差し戻す', allowText: true, confirm: { title: '差し戻しますか', ok: '差し戻す' } }] }));
		ledger.upsert('bot', input('bot', 'item1.ev1', 'question'));
		const asks = paradisMobileHumanAsks(ledger.snapshot());
		assert.deepStrictEqual(asks.map(ask => [ask.key, ask.kind, ask.actions.map(action => [action.id, action.confirm?.ok ?? null, action.allowText ?? false])]), [
			['bot:item1.ev1', 'question', []],
			['board:b2', 'approval', [['sendBack', '差し戻す', true]]],
			['pane:ask:1', 'question', []],
		]);
	});

	test('the State summary changes only when the phone-visible list changes', () => {
		let now = 10;
		const ledger = new ParadisHumanAskLedger(() => now);
		const empty = paradisMobileHumanAskSummary(ledger.snapshot());
		ledger.upsert('board:1', input('board', 'b1', 'question'));
		const one = paradisMobileHumanAskSummary(ledger.snapshot());
		// ペインの許可が増えても変わらない
		ledger.upsert('panes', input('pane', 'p2', 'permission', { paneKey: 'k2' }));
		const withPermission = paradisMobileHumanAskSummary(ledger.snapshot());
		// ほかの場所で答えて届けている最中は変わる（スマホのボタンを止める）
		now = 20;
		ledger.claim('board:b1', { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['0'] }] }, 'inbox');
		const busy = paradisMobileHumanAskSummary(ledger.snapshot());
		assert.deepStrictEqual({
			counts: [empty.count, one.count, withPermission.count, busy.count],
			sameAfterPermission: one.signature === withPermission.signature,
			changedWhenBusy: busy.signature !== one.signature,
			changedWhenAdded: empty.signature !== one.signature,
		}, { counts: [0, 1, 1, 1], sameAfterPermission: true, changedWhenBusy: true, changedWhenAdded: true });
	});

	test('the State summary changes on every failed delivery, even when the list looks the same as before the answer', () => {
		let now = 10;
		const ledger = new ParadisHumanAskLedger(() => now);
		ledger.upsert('board:1', input('board', 'b1', 'question'));
		const answer = { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['0'] }] };
		const fail = () => {
			const claim = ledger.claim('board:b1', answer, 'mobile');
			assert.ok(claim.ok);
			now += 10;
			ledger.reject('board:1', 'board:b1', claim.request.claim);
		};
		const waiting = paradisMobileHumanAskSummary(ledger.snapshot());
		fail();
		const firstFailure = paradisMobileHumanAskSummary(ledger.snapshot());
		const firstList = JSON.stringify(paradisMobileHumanAsks(ledger.snapshot()));
		// 答え直してまた失敗: 一覧は 1 回目の失敗と同じだが、印は変わる（スマホが取り直す）
		fail();
		const secondFailure = paradisMobileHumanAskSummary(ledger.snapshot());
		assert.deepStrictEqual({
			sameListAsFirstFailure: JSON.stringify(paradisMobileHumanAsks(ledger.snapshot())) === firstList,
			changedOnFirstFailure: firstFailure.signature !== waiting.signature,
			changedOnSecondFailure: secondFailure.signature !== firstFailure.signature,
		}, { sameListAsFirstFailure: true, changedOnFirstFailure: true, changedOnSecondFailure: true });
	});

	test('reads the summary and the answer request strictly', () => {
		assert.deepStrictEqual({
			summary: paradisParseMobileHumanAskSummary({ count: 2, signature: 'abc' }),
			badSummary: [paradisParseMobileHumanAskSummary({ count: -1, signature: 'a' }), paradisParseMobileHumanAskSummary({ count: 1, signature: '' }), paradisParseMobileHumanAskSummary(null)],
			request: paradisParseMobileHumanAskAnswerRequest({ t: 'humanAskAnswer', id: 'r', opId: 'op', key: 'bot:i.e', answer: { type: 'skip' } }),
			badRequests: [
				paradisParseMobileHumanAskAnswerRequest({ opId: '', key: 'k', answer: {} }),
				paradisParseMobileHumanAskAnswerRequest({ opId: 'op', key: 'x'.repeat(451), answer: {} }),
				paradisParseMobileHumanAskAnswerRequest({ opId: 'op', key: 'k', answer: [] }),
			],
		}, {
			summary: { count: 2, signature: 'abc' },
			badSummary: [undefined, undefined, undefined],
			request: { opId: 'op', key: 'bot:i.e', answer: { type: 'skip' } },
			badRequests: [undefined, undefined, undefined],
		});
	});
});

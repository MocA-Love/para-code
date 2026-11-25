/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisHumanAskInput,
	PARADIS_HUMAN_ASK_BOARD_OPTION_LIMIT,
	PARADIS_HUMAN_ASK_OPTION_LIMIT,
	PARADIS_HUMAN_ASK_QUESTION_LIMIT,
	ParadisHumanAskAnswer,
	paradisHumanAskAnswerable,
	paradisSanitizeHumanAskAnswer,
	paradisSanitizeHumanAskInput,
} from '../../common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../common/paradisHumanAskLedger.js';

function ask(source: IParadisHumanAskInput['source'], id: string, extra: Partial<IParadisHumanAskInput> = {}): IParadisHumanAskInput {
	return {
		source,
		id,
		kind: 'question',
		from: { title: 'para-code' },
		questions: [{ id: 'q1', text: 'どちらにしますか?', options: [{ id: 'a', label: '残す', recommended: true }, { id: 'b', label: 'ログアウトさせる' }], allowText: true }],
		actions: [],
		canSkip: false,
		...extra,
	};
}

function permission(source: IParadisHumanAskInput['source'], id: string, extra: Partial<IParadisHumanAskInput> = {}): IParadisHumanAskInput {
	return ask(source, id, { kind: 'permission', questions: [], actions: [{ id: 'allow', label: '許可' }, { id: 'deny', label: '拒否' }], ...extra });
}

const pick = (optionId: string): ParadisHumanAskAnswer => ({ type: 'answers', answers: [{ questionId: 'q1', optionIds: [optionId] }] });

function view(ledger: ParadisHumanAskLedger) {
	const snapshot = ledger.snapshot();
	return {
		entries: snapshot.entries.map(entry => [
			entry.key,
			entry.state,
			...(entry.pending ? [`pending@${entry.pending.surface}`] : []),
			...(entry.failedAt !== undefined ? ['failed'] : []),
			...(entry.foldedInto ? [`in ${entry.foldedInto}`] : []),
			...(entry.resolution?.surface ? [`by ${entry.resolution.surface}`] : []),
			...(entry.resolution?.summary ? [entry.resolution.summary] : []),
		].join(' ')),
		counts: snapshot.counts,
	};
}

/** 動かせる時計。 */
function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
}

suite('Paradis human ask ledger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps one entry per source and id, newest first, and the total is the sum of the three sources', () => {
		const time = clock();
		const ledger = new ParadisHumanAskLedger(time.now);
		ledger.sync('panes', [ask('pane', 'p1'), permission('pane', 'p2')]);
		time.advance(10);
		ledger.sync('board', [ask('board', 't1:q1'), ask('board', 't2:approval', { kind: 'approval', questions: [], actions: [{ id: 'approve', label: '承認して次へ' }] })]);
		time.advance(10);
		ledger.upsert('bots', ask('bot', 'item-42'));
		// 同じ鍵を知らせ直しても増えない
		assert.strictEqual(ledger.upsert('bots', ask('bot', 'item-42')), false);

		assert.deepStrictEqual(view(ledger), {
			entries: ['bot:item-42 waiting', 'board:t2:approval waiting', 'board:t1:q1 waiting', 'pane:p2 waiting', 'pane:p1 waiting'],
			counts: { total: 5, pane: 2, board: 2, bot: 1 },
		});
	});

	test('an answer from one place claims the entry, a second place is refused, and the owner settles it for everyone', () => {
		const time = clock();
		const ledger = new ParadisHumanAskLedger(time.now);
		ledger.sync('board', [ask('board', 't1:q1')]);

		const first = ledger.claim('board:t1:q1', pick('a'), 'mobile');
		const second = ledger.claim('board:t1:q1', pick('b'), 'inbox');
		assert.deepStrictEqual(
			{ first: first.ok && { owner: first.request.owner, source: first.request.source, id: first.request.id, answer: first.request.answer, surface: first.request.surface }, second },
			{ first: { owner: 'board', source: 'board', id: 't1:q1', answer: pick('a'), surface: 'mobile' }, second: { ok: false, reason: 'busy' } },
		);
		assert.deepStrictEqual(view(ledger), { entries: ['board:t1:q1 waiting pending@mobile'], counts: { total: 1, pane: 0, board: 1, bot: 0 } });

		// 持ち主が届け終えた。答えた場所と中身が残り、件数から消える
		assert.strictEqual(ledger.resolve('board', 'board:t1:q1'), true);
		assert.deepStrictEqual(view(ledger), { entries: ['board:t1:q1 answered by mobile 残す'], counts: { total: 0, pane: 0, board: 0, bot: 0 } });
		assert.deepStrictEqual(ledger.claim('board:t1:q1', pick('b'), 'inbox'), { ok: false, reason: 'gone' });

		// 少し前の回答済みは、残しておく時間を過ぎたら出さない
		time.advance(60_000);
		assert.deepStrictEqual(view(ledger).entries, []);
	});

	test('a failed delivery returns the entry to waiting, and a late result of an older claim is ignored', () => {
		const ledger = new ParadisHumanAskLedger(clock().now);
		ledger.sync('panes', [permission('pane', 'p1')]);
		const first = ledger.claim('pane:p1', { type: 'action', actionId: 'allow' }, 'inbox');
		assert.ok(first.ok);
		assert.strictEqual(ledger.reject('panes', 'pane:p1', first.request.claim), true);
		assert.deepStrictEqual(view(ledger).entries, ['pane:p1 waiting failed']);

		const second = ledger.claim('pane:p1', { type: 'action', actionId: 'deny' }, 'mobile');
		assert.ok(second.ok);
		// 1 回目の依頼の「届かなかった」が遅れて届いても、2 回目の依頼は外さない。別の持ち主の知らせも受けない
		assert.deepStrictEqual(
			[ledger.reject('panes', 'pane:p1', first.request.claim), ledger.reject('board', 'pane:p1', second.request.claim), ledger.resolve('board', 'pane:p1')],
			[false, false, false],
		);
		assert.deepStrictEqual(view(ledger).entries, ['pane:p1 waiting pending@mobile']);
	});

	test('a claim that timed out stays claimed until the owner lists its entries again', () => {
		const time = clock();
		const ledger = new ParadisHumanAskLedger(time.now, { claimTimeoutMs: 20_000 });
		ledger.sync('panes', [permission('pane', 'kept'), permission('pane', 'moved-on')]);
		assert.ok(ledger.claim('pane:kept', { type: 'action', actionId: 'allow' }, 'inbox').ok);
		assert.ok(ledger.claim('pane:moved-on', { type: 'action', actionId: 'allow' }, 'mobile').ok);

		// 時間切れの前の一覧では、届けている最中のまま
		time.advance(5_000);
		ledger.sync('panes', [permission('pane', 'kept'), permission('pane', 'moved-on')]);
		time.advance(20_000);
		// 時間切れだけでは戻さない（キーは届いたのに結果の知らせだけ落ちたのかもしれない）
		assert.deepStrictEqual(ledger.claim('pane:kept', { type: 'action', actionId: 'deny' }, 'mobile'), { ok: false, reason: 'busy' });

		// 持ち主の次の一覧で決まる: まだ出ていれば届かなかった、消えていれば答えが届いた
		ledger.sync('panes', [permission('pane', 'kept')]);
		assert.deepStrictEqual(view(ledger), {
			entries: ['pane:kept waiting failed', 'pane:moved-on answered by mobile 許可'],
			counts: { total: 1, pane: 1, board: 0, bot: 0 },
		});
	});

	test('a stale list right after an answer does not bring the entry back, but a later list does', () => {
		const time = clock();
		const ledger = new ParadisHumanAskLedger(time.now, { reviveGuardMs: 10_000 });
		ledger.sync('board', [ask('board', 't1:q1'), ask('board', 't2:q1')]);
		ledger.resolve('board', 'board:t1:q1', { surface: 'board', summary: 'ボードで答えた' });
		ledger.withdraw('board', 'board:t2:q1');

		// 答える前に作られた一覧が遅れて届いた
		time.advance(1_000);
		assert.strictEqual(ledger.sync('board', [ask('board', 't1:q1'), ask('board', 't2:q1')]), false);
		assert.deepStrictEqual(view(ledger), {
			entries: ['board:t2:q1 withdrawn', 'board:t1:q1 answered by board ボードで答えた'],
			counts: { total: 0, pane: 0, board: 0, bot: 0 },
		});

		// しばらく経ってもまだ出ているなら、持ち主の側では待ったまま
		time.advance(10_000);
		ledger.sync('board', [ask('board', 't1:q1')]);
		assert.deepStrictEqual(view(ledger), { entries: ['board:t1:q1 waiting', 'board:t2:q1 withdrawn'], counts: { total: 1, pane: 0, board: 1, bot: 0 } });
	});

	test('entries missing from the owner\'s list are withdrawn, and an owner that comes back gets its entries back at once', () => {
		const time = clock();
		const ledger = new ParadisHumanAskLedger(time.now);
		ledger.sync('panes', [ask('pane', 'p1'), ask('pane', 'p2')]);
		ledger.sync('board', [ask('board', 't1:q1')]);
		ledger.sync('panes', [ask('pane', 'p2')]);
		assert.deepStrictEqual(view(ledger).entries, ['board:t1:q1 waiting', 'pane:p2 waiting', 'pane:p1 withdrawn']);

		// ボードが止まった。ほかの持ち主の分はそのまま
		ledger.removeOwner('board');
		assert.deepStrictEqual(view(ledger).counts, { total: 1, pane: 1, board: 0, bot: 0 });
		// 戻ってきたら、待たずに元へ戻す（ボードの台帳には残っている）
		time.advance(100);
		ledger.sync('board', [ask('board', 't1:q1')]);
		assert.deepStrictEqual(view(ledger).counts, { total: 2, pane: 1, board: 1, bot: 0 });
	});

	test('folds the pane entry into the board or bot entry of the same pane and kind, and shows it again when that one is gone', () => {
		const ledger = new ParadisHumanAskLedger(clock().now);
		ledger.sync('panes', [
			permission('pane', 'k1-permission', { paneKey: 'k1' }),
			permission('pane', 'k2-permission', { paneKey: 'k2' }),
			ask('pane', 'k3-question', { paneKey: 'k3' }),
		]);
		ledger.sync('board', [
			// 同じペインの同じ許可をボードも拾った → ボードの 1 件に寄せる
			permission('board', 't1:permission', { paneKey: 'k1' }),
			// ボードは「止まった」と見ているが、ペインは許可を待っている → 別の用件なので両方出す
			ask('board', 't2:stalled', { kind: 'stalled', paneKey: 'k2', questions: [], actions: [{ id: 'nudge', label: '報告を促す' }] }),
		]);
		ledger.sync('bots', [ask('bot', 'item-7', { paneKey: 'k3' })]);

		assert.deepStrictEqual(view(ledger), {
			entries: [
				'bot:item-7 waiting',
				'board:t2:stalled waiting',
				'board:t1:permission waiting',
				'pane:k3-question waiting in bot:item-7',
				'pane:k2-permission waiting',
				'pane:k1-permission waiting in board:t1:permission',
			],
			counts: { total: 4, pane: 1, board: 2, bot: 1 },
		});

		// 寄せ先が先に消えたら、ペインの 1 件がそのまま出てくる
		ledger.withdraw('board', 'board:t1:permission');
		assert.deepStrictEqual(view(ledger).counts, { total: 4, pane: 2, board: 1, bot: 1 });
	});

	test('does not let another owner take over a waiting key, and stops taking entries at the limit', () => {
		const ledger = new ParadisHumanAskLedger(clock().now, { waitingLimit: 2 });
		ledger.sync('board', [ask('board', 't1:q1')]);
		assert.strictEqual(ledger.upsert('other', ask('board', 't1:q1', { from: { title: '偽物' } })), false);
		ledger.upsert('panes', ask('pane', 'p1'));
		assert.strictEqual(ledger.upsert('panes', ask('pane', 'p2')), false);
		assert.deepStrictEqual(ledger.snapshot().entries.map(entry => `${entry.key} ${entry.owner} ${entry.from.title}`), ['pane:p1 panes para-code', 'board:t1:q1 board para-code']);
	});

	test('accepts up to 5 questions and 8 options (10 from the board), keeps one recommendation, and redacts what is shown', () => {
		const options = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `o${index}`, label: `選択肢 ${index}`, recommended: index < 2 }));
		const questions = (count: number, optionCount: number) => Array.from({ length: count }, (_, index) => ({ id: `q${index}`, text: `問い ${index}`, options: options(optionCount), allowText: false }));
		const input = (source: string, questionCount: number, optionCount: number) => paradisSanitizeHumanAskInput({ source, id: 'x', kind: 'question', from: { title: 'リリース係' }, questions: questions(questionCount, optionCount) });
		const full = input('bot', PARADIS_HUMAN_ASK_QUESTION_LIMIT, PARADIS_HUMAN_ASK_OPTION_LIMIT);
		const secret = paradisSanitizeHumanAskInput({
			source: 'pane', id: 'p', kind: 'permission', windowId: 3, paneKey: 'k', stateKey: 's', canSkip: true,
			from: { title: 'api', detail: 'main / Codex' },
			preface: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://example.com',
			questions: [{ id: 'q', text: '自由に書いてください' }],
			actions: [{ id: 'allow', label: '許可' }, { id: 'deny', label: '拒否', allowText: true }],
		});

		assert.deepStrictEqual({
			full: full && [full.questions.length, full.questions[0].options.length, full.questions[0].options.filter(option => option.recommended).map(option => option.id)],
			sixQuestions: input('bot', PARADIS_HUMAN_ASK_QUESTION_LIMIT + 1, 2),
			nineOptions: input('bot', 1, PARADIS_HUMAN_ASK_OPTION_LIMIT + 1),
			boardTenOptions: input('board', 1, PARADIS_HUMAN_ASK_BOARD_OPTION_LIMIT)?.questions[0].options.length,
			boardElevenOptions: input('board', 1, PARADIS_HUMAN_ASK_BOARD_OPTION_LIMIT + 1),
			unknownSource: input('window', 1, 2),
			noTitle: paradisSanitizeHumanAskInput({ source: 'pane', id: 'p', kind: 'question', from: {} }),
			secretShown: secret?.preface?.includes('abcdefghijklmnopqrstuvwxyz0123456789'),
			secret: secret && { ...secret, preface: undefined },
			paneOnly: paradisHumanAskAnswerable({ questions: [], actions: [] }),
		}, {
			full: [5, 8, ['o0']],
			sixQuestions: undefined,
			nineOptions: undefined,
			boardTenOptions: 10,
			boardElevenOptions: undefined,
			unknownSource: undefined,
			noTitle: undefined,
			secretShown: false,
			secret: {
				source: 'pane', id: 'p', kind: 'permission',
				from: { title: 'api', detail: 'main / Codex' },
				preface: undefined,
				// 選択肢の無い問いは、自由入力で答えられるようにする
				questions: [{ id: 'q', text: '自由に書いてください', options: [], allowText: true }],
				actions: [{ id: 'allow', label: '許可' }, { id: 'deny', label: '拒否', allowText: true }],
				canSkip: true, paneKey: 'k', windowId: 3, stateKey: 's',
			},
			paneOnly: false,
		});
	});

	test('checks an answer against the questions, options and actions of its entry', () => {
		const entry: Pick<IParadisHumanAskInput, 'questions' | 'actions' | 'canSkip'> = {
			questions: [
				{ id: 'single', text: '1 つ選ぶ', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowText: false },
				{ id: 'multi', text: '複数選ぶ', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowText: true, multiSelect: true },
			],
			actions: [{ id: 'approve', label: '承認して次へ' }, { id: 'sendBack', label: '差し戻す', allowText: true }],
			canSkip: false,
		};
		const check = (value: unknown) => paradisSanitizeHumanAskAnswer(entry, value);

		assert.deepStrictEqual([
			// 答えなかった問いは入れなくてよい。複数選んだものは問いの選択肢の順に並べ直す
			check({ type: 'answers', answers: [{ questionId: 'multi', optionIds: ['b', 'a'], text: 'どちらも' }] }),
			check({ type: 'answers', answers: [{ questionId: 'single', optionIds: ['a', 'b'] }] }),
			check({ type: 'answers', answers: [{ questionId: 'single', optionIds: ['zzz'] }] }),
			check({ type: 'answers', answers: [{ questionId: 'single', text: '書けない問い' }] }),
			check({ type: 'answers', answers: [{ questionId: 'single', optionIds: ['a'] }, { questionId: 'single', optionIds: ['b'] }] }),
			check({ type: 'answers', answers: [] }),
			check({ type: 'action', actionId: 'sendBack', text: '計測キーの名前を直して' }),
			check({ type: 'action', actionId: 'approve', text: '理由を書けないボタン' }),
			check({ type: 'action', actionId: 'merge' }),
			check({ type: 'skip' }),
			paradisSanitizeHumanAskAnswer({ ...entry, canSkip: true }, { type: 'skip' }),
		], [
			{ type: 'answers', answers: [{ questionId: 'multi', optionIds: ['a', 'b'], text: 'どちらも' }] },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ type: 'action', actionId: 'sendBack', text: '計測キーの名前を直して' },
			undefined,
			undefined,
			undefined,
			{ type: 'skip' },
		]);
	});
});

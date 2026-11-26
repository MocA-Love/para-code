/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskEntry, IParadisHumanAskQuestion } from '../../../humanAsk/common/paradisHumanAsk.js';
import {
	IParadisInboxAskDraft,
	paradisInboxAskAnswerFromDrafts,
	paradisInboxAskDangerLabels,
	paradisInboxAskLayout,
	paradisInboxAskSendsOnPick,
	paradisInboxAskSettledText,
} from '../../common/paradisNotificationInboxAsk.js';

function question(id: string, optionCount: number, extra: Partial<IParadisHumanAskQuestion> = {}): IParadisHumanAskQuestion {
	return { id, text: `問い ${id}`, options: Array.from({ length: optionCount }, (_, index) => ({ id: String(index), label: `選択肢 ${index}` })), allowText: true, ...extra };
}

function entry(extra: Partial<IParadisHumanAskEntry>): IParadisHumanAskEntry {
	return { key: 'pane:1', owner: 'panes', source: 'pane', id: '1', kind: 'question', from: { title: 'api' }, questions: [], actions: [], canSkip: false, askedAt: 1, state: 'waiting', ...extra };
}

const ALLOW_DENY = [{ id: 'yes', label: '許可' }, { id: 'no', label: '拒否' }];

suite('Paradis notification inbox: your turn cards', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('small asks are answered in the row, large ones in the dialog', () => {
		assert.deepStrictEqual([
			// 問い 1 つ・選択肢 4 つまで: 行の中
			paradisInboxAskLayout(entry({ questions: [question('a', 2)] })),
			paradisInboxAskLayout(entry({ questions: [question('a', 4)] })),
			// 選択肢 5 つ以上・2 問以上・複数選ぶ問い・選択肢の無い問い: モーダル
			paradisInboxAskLayout(entry({ questions: [question('a', 5)] })),
			paradisInboxAskLayout(entry({ questions: [question('a', 2), question('b', 2)] })),
			paradisInboxAskLayout(entry({ questions: [question('a', 3, { multiSelect: true })] })),
			paradisInboxAskLayout(entry({ questions: [question('a', 0)] })),
			// 行の中では切れてしまう長い選択肢
			paradisInboxAskLayout(entry({ questions: [{ ...question('a', 2), options: [{ id: '0', label: '受信箱のカードとボードの既定のフローを確かめてから出す' }, { id: '1', label: '出す' }] }] })),
			// 許可: 短くて危険の札が無ければ行の中
			paradisInboxAskLayout(entry({ kind: 'permission', preface: 'Bash: npm run typecheck-client', actions: ALLOW_DENY })),
			// 危険な操作を含む・中身が 6 行に収まらない許可は、行の中に「許可」を出さない
			paradisInboxAskLayout(entry({ kind: 'permission', preface: 'Bash: rm -rf build && npm run build', actions: ALLOW_DENY })),
			paradisInboxAskLayout(entry({ kind: 'permission', preface: `Write: ${'長い中身 '.repeat(100)}`, actions: ALLOW_DENY })),
			// 押す前に確認が要るボタン（ボードの「完了扱いにする」）がある: 1 押しで送らずモーダルへ
			paradisInboxAskLayout(entry({ source: 'board', kind: 'stalled', actions: [{ id: 'nudge', label: '報告を促す' }, { id: 'complete', label: '完了扱いにする', confirm: { title: '完了にしますか', ok: '完了にする' } }] })),
			// 問いもボタンも無い: ペインへ移動だけ
			paradisInboxAskLayout(entry({ kind: 'permission', preface: 'MCP: db.run' })),
			// 待ちでなくなった
			paradisInboxAskLayout(entry({ state: 'answered', questions: [question('a', 2)] })),
		], ['inline-options', 'inline-options', 'dialog', 'dialog', 'dialog', 'dialog', 'dialog', 'inline-actions', 'dialog', 'dialog', 'dialog', 'unanswerable', 'settled']);
	});

	test('one single-choice question sends on pick; anything else is chosen first and then sent', () => {
		const drafts = (values: Record<string, Partial<IParadisInboxAskDraft>>) => new Map(Object.entries(values).map(([id, draft]) => [id, { optionIds: [], text: '', ...draft }]));
		const two = entry({ questions: [question('a', 2), question('b', 5)] });
		assert.deepStrictEqual({
			sendsOnPick: [
				paradisInboxAskSendsOnPick(entry({ questions: [question('a', 6)] })),
				paradisInboxAskSendsOnPick(entry({ questions: [question('a', 3, { multiSelect: true })] })),
				paradisInboxAskSendsOnPick(two),
			],
			// ペインの質問は全問に答えるまで送れない
			paneHalf: paradisInboxAskAnswerFromDrafts(two, drafts({ a: { optionIds: ['1'] } })),
			paneAll: paradisInboxAskAnswerFromDrafts(two, drafts({ a: { optionIds: ['1'] }, b: { text: ' 自分で書いた答え ' } })),
			// ほかの出どころは、答えた問いだけ送れる。選択肢を選んだ問いでは書いた文を送らない
			botHalf: paradisInboxAskAnswerFromDrafts({ ...two, source: 'bot' }, drafts({ a: { optionIds: ['1'], text: 'メモ' } })),
			nothing: paradisInboxAskAnswerFromDrafts({ ...two, source: 'bot' }, drafts({ a: { text: '   ' } })),
			// 書けない問いに書いた文は答えに数えない
			noText: paradisInboxAskAnswerFromDrafts(entry({ source: 'bot', questions: [question('a', 2, { allowText: false })] }), drafts({ a: { text: '書いた' } })),
		}, {
			sendsOnPick: [true, false, false],
			paneHalf: undefined,
			paneAll: { type: 'answers', answers: [{ questionId: 'a', optionIds: ['1'] }, { questionId: 'b', text: '自分で書いた答え' }] },
			botHalf: { type: 'answers', answers: [{ questionId: 'a', optionIds: ['1'] }] },
			nothing: undefined,
			noText: undefined,
		});
	});

	test('an ask settled elsewhere says where and what only when the ledger knows', () => {
		assert.deepStrictEqual([
			paradisInboxAskSettledText({ state: 'answered', resolution: { at: 1, surface: 'mobile', summary: '今のセッションを残す' } }),
			paradisInboxAskSettledText({ state: 'answered', resolution: { at: 1, surface: 'board' } }),
			// ターミナルで答えた・エージェントが先へ進んだ（取り下げ）は、答えたとは言い切らない
			paradisInboxAskSettledText({ state: 'withdrawn', resolution: { at: 1 } }),
			paradisInboxAskSettledText({ state: 'answered', resolution: { at: 1 } }),
		], [
			'スマホで回答済み: 「今のセッションを残す」',
			'ボードで回答済み',
			'ほかの場所で対応済みか、対象外になりました',
			'ほかの場所で対応済みか、対象外になりました',
		]);
	});

	test('dangerous operations in a permission are labelled like on the mobile card', () => {
		assert.deepStrictEqual([
			paradisInboxAskDangerLabels('Bash: rm -rf node_modules && sudo make install'),
			paradisInboxAskDangerLabels('Bash: git push --force origin main; git reset --hard HEAD~1'),
			paradisInboxAskDangerLabels('Bash: docker run --rm alpine echo ok > /dev/null'),
			paradisInboxAskDangerLabels(undefined),
		], [
			['削除を含む', '管理者権限'],
			['強制 push', '履歴を書き換える'],
			[],
			[],
		]);
	});
});

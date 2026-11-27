/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotGroupDialogProblem, paradisBotGroupMentionProblem, paradisBotGroupRecordHead, paradisBotGroupRecordMark, paradisBotGroupSendSummary } from '../../common/paradisBotGroupRoomModel.js';

suite('Paradis bot group room model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('記録の頭・名指しの断り・送った結果の文', () => {
		const names: Record<string, string> = { a: 'リリース係', b: 'レビュー係' };
		const nameOf = (id: string) => names[id] ?? '?';
		assert.deepStrictEqual([
			paradisBotGroupRecordHead({ kind: 'sent', from: 'owner', to: ['a', 'b'] }, nameOf),
			paradisBotGroupRecordHead({ kind: 'asked', from: 'a', to: ['b'] }, nameOf),
			paradisBotGroupRecordHead({ kind: 'told', from: 'b', to: ['a'] }, nameOf),
			paradisBotGroupRecordMark({ queued: true }),
			paradisBotGroupRecordMark({ undelivered: 'refused' }),
			paradisBotGroupRecordMark({ undelivered: 'unreachable' }),
			paradisBotGroupRecordMark({ undelivered: 'unknown' }),
			paradisBotGroupRecordMark({}),
			paradisBotGroupMentionProblem({ ok: true, targets: ['a'], everyone: false }),
			paradisBotGroupMentionProblem({ ok: false, problem: 'empty' }),
			paradisBotGroupMentionProblem({ ok: false, problem: 'no_target' }),
			paradisBotGroupMentionProblem({ ok: false, problem: 'unknown_name', name: 'リリス係' }),
			paradisBotGroupSendSummary(['リリース係', 'レビュー係'], []),
			paradisBotGroupSendSummary(['リリース係'], [{ name: 'レビュー係', reason: '起動していません' }]),
			paradisBotGroupSendSummary([], [{ name: 'レビュー係', reason: '停止中' }]),
		], [
			'あなた → リリース係・レビュー係',
			'リリース係がレビュー係に聞きました',
			'レビュー係がリリース係に伝えました',
			'順番待ちに入れました',
			'宛先が受け取らなかった',
			'届けられなかった',
			'届いたか分からない',
			undefined,
			undefined,
			'送る文を入れてください',
			'「@名前」か「@全員」で送り先を選んでください（このグループは名指しのときだけ返事をします）',
			'「@リリス係」はこのグループにいません',
			'リリース係・レビュー係 に送りました',
			'リリース係 に送りました。送れなかった Bot: レビュー係（起動していません）',
			'送れませんでした: レビュー係（停止中）',
		]);
	});

	test('グループのモーダルの検め', () => {
		const groups = [{ id: 'g1', name: 'リリース班' }];
		assert.deepStrictEqual([
			paradisBotGroupDialogProblem('', 2, groups),
			paradisBotGroupDialogProblem('a\nb', 2, groups),
			paradisBotGroupDialogProblem('リリース班', 2, groups),
			paradisBotGroupDialogProblem('リリース班', 2, groups, 'g1'),
			paradisBotGroupDialogProblem('出荷班', 1, groups),
			paradisBotGroupDialogProblem('出荷班', 5, groups),
			paradisBotGroupDialogProblem('出荷班', 4, groups),
		], [
			'名前を入れてください',
			'名前は 64 字までで、改行は入れられません',
			'同じ名前のグループがあります',
			undefined,
			'Bot は 2〜4 人選んでください',
			'Bot は 2〜4 人選んでください',
			undefined,
		]);
	});
});

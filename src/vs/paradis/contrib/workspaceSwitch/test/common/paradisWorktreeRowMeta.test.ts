/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisWorktreeMetaEntry,
	IParadisWorktreeMetaPresence,
	PARADIS_DEFAULT_WORKTREE_ROW_META,
	PARADIS_WORKTREE_META_IDS,
	PARADIS_WORKTREE_ROW_HEIGHT,
	PARADIS_WORKTREE_ROW_HEIGHT_WITH_META,
	paradisCanMoveWorktreeMeta,
	paradisMoveWorktreeMeta,
	paradisNormalizeWorktreeRowMeta,
	paradisSetWorktreeMetaAlign,
	paradisSetWorktreeMetaVisible,
	paradisWorktreeMetaOrder,
	paradisWorktreeRowHeight,
} from '../../common/paradisWorktreeRowMeta.js';

suite('ParadisWorktreeRowMeta', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const presence = (overrides: Partial<IParadisWorktreeMetaPresence> = {}): IParadisWorktreeMetaPresence =>
		({ pr: false, issues: false, diff: false, notes: false, ...overrides });

	test('row height follows whether a visible meta item is actually present', () => {
		const defaults = PARADIS_DEFAULT_WORKTREE_ROW_META;
		// メモだけを非表示にした設定 (他はそのまま)
		const notesHidden = paradisSetWorktreeMetaVisible(defaults, 'notes', false);
		// 4項目すべて非表示 =「今までどおりに戻せる出口」
		const allHidden = PARADIS_WORKTREE_META_IDS.reduce<readonly IParadisWorktreeMetaEntry[]>(
			(entries, id) => paradisSetWorktreeMetaVisible(entries, id, false), defaults);

		assert.deepStrictEqual([
			// メタ情報を1つも持たない行は従来どおりの2段
			paradisWorktreeRowHeight(defaults, presence()),
			// 表示中の情報を1つでも持てば3段
			paradisWorktreeRowHeight(defaults, presence({ diff: true })),
			paradisWorktreeRowHeight(defaults, presence({ pr: true, notes: true })),
			// 持っている情報が非表示にされていれば2段のまま
			paradisWorktreeRowHeight(notesHidden, presence({ notes: true })),
			// すべて非表示なら、どれだけ情報を持っていても2段
			paradisWorktreeRowHeight(allHidden, presence({ pr: true, issues: true, diff: true, notes: true })),
		], [
			PARADIS_WORKTREE_ROW_HEIGHT,
			PARADIS_WORKTREE_ROW_HEIGHT_WITH_META,
			PARADIS_WORKTREE_ROW_HEIGHT_WITH_META,
			PARADIS_WORKTREE_ROW_HEIGHT,
			PARADIS_WORKTREE_ROW_HEIGHT,
		]);
	});

	test('normalizes broken settings and keeps every item exactly once', () => {
		assert.deepStrictEqual(paradisNormalizeWorktreeRowMeta([
			// 知らない id は捨てる
			{ id: 'bogus', visible: true, align: 'left' },
			// 型が違う値は既定で補う
			{ id: 'diff', visible: 'yes', align: 'middle' },
			// 重複は最初の1件だけ残す
			{ id: 'diff', visible: false, align: 'left' },
			{ id: 'notes', visible: false, align: 'left' },
			// pr / issues は書かれていないので既定の順序のまま末尾へ足される
		]), [
			{ id: 'diff', visible: true, align: 'right' },
			{ id: 'notes', visible: false, align: 'left' },
			{ id: 'pr', visible: true, align: 'left' },
			{ id: 'issues', visible: true, align: 'left' },
		]);
	});

	test('moving an item changes the left/right layout order', () => {
		const moved = paradisMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'issues', -1);
		assert.deepStrictEqual([
			paradisWorktreeMetaOrder(PARADIS_DEFAULT_WORKTREE_ROW_META),
			paradisWorktreeMetaOrder(moved),
			// 端では並びが変わらない
			paradisWorktreeMetaOrder(paradisMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'pr', -1)),
		], [
			{ left: ['pr', 'issues'], right: ['diff', 'notes'] },
			{ left: ['issues', 'pr'], right: ['diff', 'notes'] },
			{ left: ['pr', 'issues'], right: ['diff', 'notes'] },
		]);
	});

	test('a move only ever swaps within the same side, so an enabled menu item always changes something', () => {
		// 既定は [pr(左), issues(左), diff(右), notes(右)]。issues を「下へ」は、素朴に配列の隣と
		// 入れ替えると [pr, diff, issues, notes] になるが、左群も右群も並びは元のまま =
		// 押しても見た目が変わらない。同じ寄せの中を探すので、ここでは相手がおらず動かない
		const acrossSides = paradisMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'issues', 1);
		assert.deepStrictEqual([
			acrossSides === PARADIS_DEFAULT_WORKTREE_ROW_META,
			paradisCanMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'issues', 1),
			paradisCanMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'issues', -1),
			paradisCanMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'pr', -1),
			paradisCanMoveWorktreeMeta(PARADIS_DEFAULT_WORKTREE_ROW_META, 'diff', 1),
		], [true, false, true, false, true]);

		// 間に別の寄せの項目が挟まっていても、同じ寄せの相手まで飛んで入れ替える
		const interleaved = [
			{ id: 'pr', visible: true, align: 'left' },
			{ id: 'diff', visible: true, align: 'right' },
			{ id: 'issues', visible: true, align: 'left' },
			{ id: 'notes', visible: true, align: 'right' },
		] as const;
		assert.deepStrictEqual(
			paradisWorktreeMetaOrder(paradisMoveWorktreeMeta(interleaved, 'issues', -1)),
			{ left: ['issues', 'pr'], right: ['diff', 'notes'] });
	});

	test('falls back to the defaults for values that are not an array at all', () => {
		// 設定ファイルを手で壊してもビューが落ちないことが、この正規化の存在理由
		assert.deepStrictEqual([
			paradisNormalizeWorktreeRowMeta(undefined),
			paradisNormalizeWorktreeRowMeta(null),
			paradisNormalizeWorktreeRowMeta('pr'),
			paradisNormalizeWorktreeRowMeta({ pr: true }),
			// 空配列は「全部消す」ではなく「何も指定していない」= 既定
			paradisNormalizeWorktreeRowMeta([]),
		], [
			PARADIS_DEFAULT_WORKTREE_ROW_META,
			PARADIS_DEFAULT_WORKTREE_ROW_META,
			PARADIS_DEFAULT_WORKTREE_ROW_META,
			PARADIS_DEFAULT_WORKTREE_ROW_META,
			PARADIS_DEFAULT_WORKTREE_ROW_META,
		].map(entries => [...entries]));
	});

	test('changing an alignment moves the item to the other side', () => {
		const moved = paradisSetWorktreeMetaAlign(PARADIS_DEFAULT_WORKTREE_ROW_META, 'issues', 'right');
		assert.deepStrictEqual(
			paradisWorktreeMetaOrder(moved),
			{ left: ['pr'], right: ['issues', 'diff', 'notes'] });
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_QUICK_REPLIES,
	QUICK_REPLY_MAX_COUNT,
	QUICK_REPLY_MAX_LENGTH,
	addQuickReply,
	canAddQuickReply,
	moveQuickReply,
	parseQuickReplies,
	quickReplyProblem,
	quickReplyProblemMessage,
	removeQuickReply,
	serializeQuickReplies,
	updateQuickReply,
} from './quickReplies.js';

const full = Array.from({ length: QUICK_REPLY_MAX_COUNT }, (_v, i) => `返信${i}`);

describe('quickReplyProblem', () => {
	test('空・空白だけは入れられない', () => {
		expect(quickReplyProblem([], '')).toBe('empty');
		expect(quickReplyProblem([], '   ')).toBe('empty');
	});

	test('文字数の上限ちょうどまでは入れられ、超えると入れられない', () => {
		expect(quickReplyProblem([], 'あ'.repeat(QUICK_REPLY_MAX_LENGTH))).toBeUndefined();
		expect(quickReplyProblem([], 'あ'.repeat(QUICK_REPLY_MAX_LENGTH + 1))).toBe('tooLong');
	});

	test('前後の空白は数えない', () => {
		expect(quickReplyProblem([], `  ${'あ'.repeat(QUICK_REPLY_MAX_LENGTH)}  `)).toBeUndefined();
	});

	test('同じ文は2つ入れられない（編集中の自分自身とは比べない）', () => {
		expect(quickReplyProblem(['続けて'], ' 続けて ')).toBe('duplicate');
		expect(quickReplyProblem(['続けて', 'テスト'], '続けて', 0)).toBeUndefined();
		expect(quickReplyProblem(['続けて', 'テスト'], '続けて', 1)).toBe('duplicate');
	});

	test('件数の上限に達したら追加できないが、編集はできる', () => {
		expect(canAddQuickReply(full)).toBe(false);
		expect(canAddQuickReply(full.slice(1))).toBe(true);
		expect(quickReplyProblem(full, '新しい返信')).toBe('full');
		expect(quickReplyProblem(full, '新しい返信', 0)).toBeUndefined();
	});

	test('どの問題にも利用者向けの文がある', () => {
		for (const problem of ['empty', 'tooLong', 'duplicate', 'full'] as const) {
			expect(quickReplyProblemMessage(problem).length).toBeGreaterThan(0);
		}
	});
});

describe('一覧の操作', () => {
	test('追加は末尾に前後の空白を落として足す', () => {
		expect(addQuickReply(['続けて'], '  要約して ')).toEqual(['続けて', '要約して']);
	});

	test('追加できないときは元の一覧のまま', () => {
		const list = ['続けて'];
		expect(addQuickReply(list, '')).toBe(list);
		expect(addQuickReply(list, '続けて')).toBe(list);
		expect(addQuickReply(full, '新しい返信')).toBe(full);
	});

	test('編集はその行だけを書き換える', () => {
		expect(updateQuickReply(['a', 'b', 'c'], 1, ' B ')).toEqual(['a', 'B', 'c']);
		const list = ['a', 'b'];
		expect(updateQuickReply(list, 5, 'x')).toBe(list);
		expect(updateQuickReply(list, 0, 'b')).toBe(list);
	});

	test('削除はその行だけを消す', () => {
		expect(removeQuickReply(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
		expect(removeQuickReply(['a'], 0)).toEqual([]);
		const list = ['a'];
		expect(removeQuickReply(list, 3)).toBe(list);
	});

	test('並び替えは隣と入れ替え、端は越えない', () => {
		expect(moveQuickReply(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
		expect(moveQuickReply(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
		const list = ['a', 'b'];
		expect(moveQuickReply(list, 0, -1)).toBe(list);
		expect(moveQuickReply(list, 1, 1)).toBe(list);
	});

	test('元の一覧は書き換えない', () => {
		const list = ['a', 'b'];
		moveQuickReply(list, 0, 1);
		removeQuickReply(list, 0);
		updateQuickReply(list, 0, 'z');
		addQuickReply(list, 'c');
		expect(list).toEqual(['a', 'b']);
	});
});

describe('保存の形', () => {
	test('保存したものを読み戻せる（0件も保存できる）', () => {
		expect(parseQuickReplies(serializeQuickReplies(['続けて', '要約して']))).toEqual(['続けて', '要約して']);
		expect(parseQuickReplies(serializeQuickReplies([]))).toEqual([]);
	});

	test('保存が無い・壊れているときは undefined（既定に倒す）', () => {
		expect(parseQuickReplies(null)).toBeUndefined();
		expect(parseQuickReplies('{')).toBeUndefined();
		expect(parseQuickReplies('{"a":1}')).toBeUndefined();
	});

	test('空・長すぎ・重複・文字列以外・上限を超える分は落とす', () => {
		const raw = JSON.stringify(['a', '', 'a', 3, 'あ'.repeat(QUICK_REPLY_MAX_LENGTH + 1), ...full]);
		const list = parseQuickReplies(raw);
		expect(list).toHaveLength(QUICK_REPLY_MAX_COUNT);
		expect(list?.[0]).toBe('a');
	});

	test('既定の一覧は上限の中に収まっている', () => {
		expect(DEFAULT_QUICK_REPLIES.length).toBeLessThanOrEqual(QUICK_REPLY_MAX_COUNT);
		expect(parseQuickReplies(serializeQuickReplies(DEFAULT_QUICK_REPLIES))).toEqual(DEFAULT_QUICK_REPLIES);
	});
});

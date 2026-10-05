// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../components/diffParser.js';
import { canAnnotateRow, clearNotesConfirmMessage, newReviewNoteId, noteAnchorOf, noteCountsByPath, noteLocationLabel, parseReviewNotes, placeReviewNotes, reviewFailureTitle, reviewSendTargets, selectedExistingNotes, unsentNoteIds, type ReviewNote } from './reviewNotes.js';

function note(id: string, line: number, lineText: string, extra: Partial<ReviewNote> = {}): ReviewNote {
	return { id, path: 'a.ts', line, lineText, body: `note ${id}`, createdAt: 1, updatedAt: 1, ...extra };
}

const rows = parseUnifiedDiff([
	'@@ -1,3 +1,4 @@',
	' keep',
	'-old',
	'+new',
	'+more',
	' tail',
	'',
].join('\n'));

describe('placeReviewNotes', () => {
	it('付いた行の下に置き、行が動いても中身で追いかけ、見つからなければ古いメモにする', () => {
		const placed = placeReviewNotes(rows, [
			note('same', 2, 'new'),
			note('moved', 1, 'more'),
			note('gone', 2, 'rewritten'),
			{ ...note('other', 1, 'keep'), path: 'b.ts' },
		], 'a.ts');
		expect({
			items: placed.items.map(item => item.kind === 'row' ? `${item.row.kind}:${item.row.text}` : `note:${item.note.id}`),
			stale: placed.stale.map(item => item.id),
		}).toEqual({
			items: ['hunk:@@ -1,3 +1,4 @@', 'ctx:keep', 'del:old', 'add:new', 'note:same', 'add:more', 'note:moved', 'ctx:tail'],
			stale: ['gone'],
		});
	});

	it('動いたメモは、いまの行と書いた時の行を並べて出す', () => {
		const moved = note('moved', 1, 'more');
		const placed = placeReviewNotes(rows, [moved, note('same', 2, 'new')], 'a.ts');
		expect({
			lines: [...placed.currentLines],
			moved: noteLocationLabel(moved, placed.currentLines.get('moved'), 'a.ts'),
			same: noteLocationLabel(note('same', 2, 'new'), placed.currentLines.get('same'), 'a.ts'),
			unknown: noteLocationLabel(moved, undefined, 'a.ts'),
		}).toEqual({
			lines: [['moved', 3], ['same', 2]],
			moved: 'a.ts:3（書いた時は 1 行目）',
			same: 'a.ts:2',
			unknown: 'a.ts:1',
		});
	});

	it('削除行と見出しにはメモを付けない', () => {
		expect(rows.map(row => canAnnotateRow(row))).toEqual([false, true, false, true, true, true]);
		const added = rows[3]!;
		expect(canAnnotateRow(added) ? noteAnchorOf(added) : undefined).toEqual({ line: 2, lineText: 'new' });
	});
});

describe('メモの一覧', () => {
	it('PC から届いたメモのうち形の合うものだけを読む', () => {
		expect(parseReviewNotes([note('a', 1, 'x', { sentAt: 5 }), { id: 'b' }, null])).toEqual([note('a', 1, 'x', { sentAt: 5 })]);
		expect(parseReviewNotes({})).toEqual([]);
	});

	it('送っていないメモを選び、ファイルごとに数える', () => {
		const notes = [note('a', 1, 'x'), note('b', 2, 'y', { sentAt: 3 }), { ...note('c', 1, 'z'), path: 'b.ts' }];
		expect({ unsent: unsentNoteIds(notes), counts: [...noteCountsByPath(notes)] }).toEqual({ unsent: ['a', 'c'], counts: [['a.ts', 2], ['b.ts', 1]] });
	});

	it('片付けの確かめに、送信済みの件数と未送信のメモがあるかを出す', () => {
		expect([
			clearNotesConfirmMessage([note('a', 1, 'x'), note('b', 2, 'y', { sentAt: 3 }), note('c', 3, 'z', { sentAt: 4 })]).split('\n'),
			clearNotesConfirmMessage([note('b', 2, 'y', { sentAt: 3 })]).split('\n'),
			clearNotesConfirmMessage([note('a', 1, 'x')]).split('\n'),
		]).toEqual([
			['送信済みのメモ 2 件を消します。', '未送信のメモ 1 件のうち、コミットされたものと行が見つからなくなったものも消えます。', '消したメモは戻せません。'],
			['送信済みのメモ 1 件を消します。', '未送信のメモはありません。', '消したメモは戻せません。'],
			['送信済みのメモはありません。', '未送信のメモ 1 件のうち、コミットされたものと行が見つからなくなったものも消えます。', '消したメモは戻せません。'],
		]);
	});

	it('片付けで消えたメモは選択から落とす', () => {
		const selected = new Set(['a', 'gone']);
		const notes = [note('a', 1, 'x'), note('b', 2, 'y')];
		expect([...selectedExistingNotes(selected, notes)]).toEqual(['a']);
		const unchanged = new Set(['a']);
		expect(selectedExistingNotes(unchanged, notes)).toBe(unchanged);
	});

	it('送り先はそのスペースのエージェントだけで、作業中・確認待ちは送れない', () => {
		const targets = reviewSendTargets([
			{ terminalKey: 't1', title: 'claude', ws: '1:repo', agent: true, agentStatus: 'review' },
			{ terminalKey: 't2', title: 'codex', ws: '1:repo', agent: true, agentStatus: 'working' },
			{ terminalKey: 't3', title: 'zsh', ws: '1:repo' },
			{ terminalKey: 't4', title: 'claude', ws: '1:other', agent: true },
		], '1:repo');
		expect(targets.map(target => [target.terminalKey, target.ready])).toEqual([['t1', true], ['t2', false]]);
	});
});

describe('reviewFailureTitle', () => {
	it('ステージはしたが確かめられなかったときだけ見出しを変える', () => {
		expect([reviewFailureTitle('ステージできませんでした', 'staged-unverified'), reviewFailureTitle('ステージできませんでした', 'no-response'), reviewFailureTitle('ステージできませんでした', undefined)])
			.toEqual(['ステージを確かめられませんでした', 'ステージできませんでした', 'ステージできませんでした']);
	});
});

describe('newReviewNoteId', () => {
	it('UUID v4 の形で、PC のメモの id の形（英数字とハイフン 64 文字まで）に収まる', () => {
		const id = newReviewNoteId(bytes => bytes.fill(0xff));
		expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
		expect(/^[0-9A-Za-z-]{1,64}$/.test(newReviewNoteId())).toBe(true);
		expect(newReviewNoteId()).not.toBe(newReviewNoteId());
	});
});

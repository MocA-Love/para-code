// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { appendNoteChange, editNoteChange, removeNoteChange, replaceNoteChange, restoreLineIndex, restoreNoteChange, spaceNoteConflictKind, spaceNoteConflictMessage, spaceNoteKeepsDraft, spaceNoteMissingBase, spaceNoteSetOptions, toggleNoteChange } from './spaceNoteSave.js';

describe('spaceNoteSave', () => {
	it('チェックの切り替えは、切り替えた行とその中身と読んだ本文を操作として持つ', () => {
		expect(toggleNoteChange('# 見出し\n- [ ] a', 1)).toEqual({ next: '# 見出し\n- [x] a', op: { kind: 'toggle', line: 1, lineText: '- [ ] a', baseText: '# 見出し\n- [ ] a' } });
		expect(toggleNoteChange('# 見出し', 0)).toBeUndefined();
	});

	it('追加は足す行だけを操作として持つ（継続行も含める）', () => {
		expect(appendNoteChange('- [ ] a\n', 'b\n補足', 'task')).toEqual({ next: '- [ ] a\n- [ ] b\n  補足', op: { kind: 'append', entry: '- [ ] b\n  補足' } });
		expect(appendNoteChange('- [ ] a', '  ', 'task')).toBeUndefined();
	});

	it('PC が扱えるときだけ、操作か版を付ける', () => {
		const toggle = toggleNoteChange('- [ ] a', 0)!;
		expect({
			oldPc: spaceNoteSetOptions(toggle, 5, false),
			op: spaceNoteSetOptions(toggle, 5, true),
			replace: spaceNoteSetOptions(replaceNoteChange('x'), 5, true),
			replaceWithoutVersion: spaceNoteSetOptions(replaceNoteChange('x'), undefined, true),
		}).toEqual({
			oldPc: undefined,
			op: { op: { kind: 'toggle', line: 0, lineText: '- [ ] a', baseText: '- [ ] a' } },
			replace: { base: 5 },
			replaceWithoutVersion: undefined,
		});
	});

	it('書かれなかった変更の種類', () => {
		expect([
			spaceNoteConflictKind(toggleNoteChange('- [ ] a', 0)!, false),
			spaceNoteConflictKind(replaceNoteChange('x'), true),
			spaceNoteConflictKind(replaceNoteChange('x'), false),
		]).toEqual(['op', 'replaceCopied', 'replace']);
	});

	it('削除と文言の書き換えは、行とその中身を操作として持つ（note.task-ops.v1）', () => {
		const text = '- [ ] a\n- [x] b\n  detail';
		const removed = removeNoteChange(text, 1)!;
		expect({
			removed,
			edited: editNoteChange(text, 0, 'A'),
			editUnchanged: editNoteChange(text, 0, 'a'),
			removeNotTask: removeNoteChange('# h', 0),
			undo: restoreNoteChange(removed.next, 1, removed.removed, 7),
			// 全文を作った時点の版（7）を使う。送る直前に版が 9 へ進んでいても 9 は付けない（その間の変更を消さない）
			undoOptions: spaceNoteSetOptions(restoreNoteChange(removed.next, 1, removed.removed, 7), 9, true),
		}).toEqual({
			removed: { next: '- [ ] a', op: { kind: 'remove', line: 1, lineText: '- [x] b', baseText: text }, removed: ['- [x] b', '  detail'] },
			edited: { next: '- [ ] A\n- [x] b\n  detail', op: { kind: 'edit', line: 0, lineText: '- [ ] a', text: 'A', baseText: text } },
			editUnchanged: undefined,
			removeNotTask: undefined,
			// 元に戻すは全文を版付きで送る（PC に挿し直す操作は無い。消した後に PC で変わっていれば書かれない）
			undo: { next: text, restore: true, base: 7 },
			undoOptions: { base: 7 },
		});
	});

	it('「元に戻す」が書かれなかったときは全文をクリップボードへ入れず、専用の文言を出す', () => {
		const restore = restoreNoteChange('- [ ] a', 1, ['- [ ] b'], 3);
		expect({
			keepsRestore: spaceNoteKeepsDraft(restore),
			keepsReplace: spaceNoteKeepsDraft(replaceNoteChange('x')),
			keepsOp: spaceNoteKeepsDraft(toggleNoteChange('- [ ] a', 0)!),
			kind: spaceNoteConflictKind(restore, false),
			message: spaceNoteConflictMessage(spaceNoteConflictKind(restore, false)),
		}).toEqual({ keepsRestore: false, keepsReplace: true, keepsOp: false, kind: 'restore', message: 'メモが変わったため元に戻せませんでした。最新を読み込みました。' });
	});

	it('版を比べられる PC で版の無い全文の書き換えは送らない', () => {
		expect({
			missing: spaceNoteMissingBase(replaceNoteChange('x'), undefined, true),
			explicit: spaceNoteMissingBase({ next: 'x', base: 3 }, undefined, true),
			fromRead: spaceNoteMissingBase(replaceNoteChange('x'), 3, true),
			oldPc: spaceNoteMissingBase(replaceNoteChange('x'), undefined, false),
			op: spaceNoteMissingBase(toggleNoteChange('- [ ] a', 0)!, undefined, true),
		}).toEqual({ missing: true, explicit: false, fromRead: false, oldPc: false, op: false });
	});

	it('元に戻す位置は PC が消した位置を、その後の変更に合わせて写す', () => {
		const removedText = '- [ ] a\n- [ ] c';
		expect({
			same: restoreLineIndex(removedText, 1, removedText),
			// 消した後に先頭へ 1 行足された: 直前の行（a）の次
			shifted: restoreLineIndex(removedText, 1, `- [ ] new\n${removedText}`),
			// 直前の行が消えていれば同じ行番号
			anchorGone: restoreLineIndex(removedText, 1, '- [ ] c'),
			top: restoreLineIndex(removedText, 0, `- [ ] new\n${removedText}`),
			empty: restoreLineIndex('', 0, ''),
		}).toEqual({ same: 1, shifted: 2, anchorGone: 1, top: 0, empty: 0 });
	});
});

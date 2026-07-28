// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { appendSpaceNoteEntry, applySpaceNotePrefix, continueSpaceNoteChecklist, parseSpaceNote, spaceNoteSummary, toggleSpaceNoteTask, trimSpaceNoteTrailingEmptyTask } from './spaceNote.js';

describe('spaceNote', () => {
	it('parses headings, checklists and plain text', () => {
		expect(parseSpaceNote('## いまここ\n- [x] 済み\n- [ ] やること\n\nメモ')).toEqual([
			{ index: 0, kind: 'heading', text: 'いまここ', done: false },
			{ index: 1, kind: 'task', text: '済み', done: true },
			{ index: 2, kind: 'task', text: 'やること', done: false },
			{ index: 3, kind: 'blank', text: '', done: false },
			{ index: 4, kind: 'text', text: 'メモ', done: false },
		]);
	});

	it('counts open and done tasks', () => {
		expect(spaceNoteSummary('- [ ] a\n- [x] b\n- [ ] c')).toEqual({ open: 2, done: 1 });
		expect(spaceNoteSummary('')).toEqual({ open: 0, done: 0 });
	});

	it('toggles only the addressed checklist line', () => {
		const note = '- [ ] a\nただの行\n- [x] b';
		expect(toggleSpaceNoteTask(note, 0)).toBe('- [x] a\nただの行\n- [x] b');
		expect(toggleSpaceNoteTask(note, 2)).toBe('- [ ] a\nただの行\n- [ ] b');
		expect(toggleSpaceNoteTask(note, 1)).toBeUndefined();
		expect(toggleSpaceNoteTask(note, 9)).toBeUndefined();
	});

	it('matches the desktop parser on the shapes people actually type', () => {
		expect(parseSpaceNote('  - [X] 大文字\n* [ ] アスタリスク\n- [] 未対応').map(line => `${line.kind}:${line.done}`)).toEqual([
			'task:true',
			'task:false',
			'text:false',
		]);
	});
});

describe('applySpaceNotePrefix', () => {
	it('swaps the marker on the cursor line instead of stacking markers', () => {
		// 真ん中の「やること」の行末にカーソルがある状態で各ボタンを押す
		const note = 'まえの行\nやること\nつぎの行';
		const task = applySpaceNotePrefix(note, 9, 'task');
		expect(task).toEqual({ text: 'まえの行\n- [ ] やること\nつぎの行', selection: 15 });
		// 続けて押しても記号は増えず、直前の記号だけが置き換わる
		expect(applySpaceNotePrefix(task.text, task.selection, 'heading')).toEqual({ text: 'まえの行\n# やること\nつぎの行', selection: 11 });
		expect(applySpaceNotePrefix(task.text, task.selection, 'none')).toEqual({ text: 'まえの行\nやること\nつぎの行', selection: 9 });
	});

	it('keeps the indent and works on the first and last line', () => {
		// 記号が短くなったぶんカーソルも詰める（本文に対する位置は変わらない）
		expect(applySpaceNotePrefix('  - [x] 済み', 9, 'bullet')).toEqual({ text: '  - 済み', selection: 5 });
		expect(applySpaceNotePrefix('さいご', 3, 'task')).toEqual({ text: '- [ ] さいご', selection: 9 });
		// ボックス後のスペースがない書き方（一覧ではチェック項目として描かれる）も記号として剥がす
		expect(applySpaceNotePrefix('- [ ]あ', 6, 'task')).toEqual({ text: '- [ ] あ', selection: 7 });
	});
});

describe('continueSpaceNoteChecklist', () => {
	/** `text` の `caret` 位置で改行キーを押したときの、入力欄の差分を再現する。 */
	const enter = (text: string, caret: number) => continueSpaceNoteChecklist(text, `${text.slice(0, caret)}\n${text.slice(caret)}`);

	it('continues the list on newline and leaves it on an empty item', () => {
		expect(enter('- [ ] やること', 10)).toEqual({ text: '- [ ] やること\n- [ ] ', selection: 17 });
		// 本文が空のチェック行で改行したら、記号ごと消してリストから抜ける
		expect(enter('- [x] 済み\n- [ ] ', 15)).toEqual({ text: '- [x] 済み\n', selection: 9 });
		// インデントは引き継ぐ
		expect(enter('  * [ ] ネスト', 11)).toEqual({ text: '  * [ ] ネスト\n  - [ ] ', selection: 20 });
	});

	it('continues the line the caret is on, not the one after it', () => {
		// 末尾以外の行末で改行したときに、次の行を対象にして本文を壊さないこと（回帰）
		expect(enter('- [ ] あ\n- [ ] い', 7)).toEqual({ text: '- [ ] あ\n- [ ] \n- [ ] い', selection: 14 });
		expect(enter('- [ ] あ\n- [ ] ', 7)).toEqual({ text: '- [ ] あ\n- [ ] \n- [ ] ', selection: 14 });
		expect(enter('- [ ] あ\nふつうの行', 7)).toEqual({ text: '- [ ] あ\n- [ ] \nふつうの行', selection: 14 });
		// 行の途中で改行したら項目が2つに割れる。カーソルの後ろに残った本文は消さない
		expect(enter('- [ ] あ', 6)).toEqual({ text: '- [ ] \n- [ ] あ', selection: 13 });
	});

	it('does nothing unless a single newline was inserted into a checklist line', () => {
		// 変換中の文字の揺れ・貼り付け・見出し行の改行では入力欄を書き換えない（IME保護の要）
		expect(continueSpaceNoteChecklist('- [ ] かい', '- [ ] 開い')).toBeUndefined();
		expect(continueSpaceNoteChecklist('- [ ] やること', '- [ ] やること\n- [ ] つぎ')).toBeUndefined();
		expect(enter('# 見出し', 5)).toBeUndefined();
		expect(enter('ただの行', 4)).toBeUndefined();
		// 行頭での改行は「空行を上に足す」操作なので継続しない
		expect(enter('- [ ] あ', 0)).toBeUndefined();
	});
});

describe('trimSpaceNoteTrailingEmptyTask', () => {
	it('drops only a trailing empty checkbox', () => {
		expect(trimSpaceNoteTrailingEmptyTask('- [ ] a\n- [ ] ')).toBe('- [ ] a');
		expect(trimSpaceNoteTrailingEmptyTask('- [ ] ')).toBe('');
		expect(trimSpaceNoteTrailingEmptyTask('- [ ] a')).toBe('- [ ] a');
		expect(trimSpaceNoteTrailingEmptyTask('- [ ] \n- [ ] a')).toBe('- [ ] \n- [ ] a');
	});
});

describe('appendSpaceNoteEntry', () => {
	it('appends one entry without opening up blank lines', () => {
		expect(appendSpaceNoteEntry('', 'さいしょ', 'task')).toBe('- [ ] さいしょ');
		expect(appendSpaceNoteEntry('- [ ] a\n', 'b', 'task')).toBe('- [ ] a\n- [ ] b');
		expect(appendSpaceNoteEntry('- [ ] a\n\n  ', 'b', 'task')).toBe('- [ ] a\n- [ ] b');
		expect(appendSpaceNoteEntry('- [ ] a', 'ただのメモ', 'text')).toBe('- [ ] a\nただのメモ');
	});

	it('keeps a multi-line label as one item and rejects an empty one', () => {
		// 改行を含む貼り付けでチェックボックスが増えないよう、2行目以降はぶら下げる（PC側と同じ）
		expect(appendSpaceNoteEntry('- [ ] a', '一行目\n二行目\n\n三行目', 'task')).toBe('- [ ] a\n- [ ] 一行目\n  二行目\n  三行目');
		expect(appendSpaceNoteEntry('- [ ] a', '   ', 'task')).toBeUndefined();
	});
});

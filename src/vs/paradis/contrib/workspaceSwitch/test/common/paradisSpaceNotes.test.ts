/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SPACE_NOTE_MAX_LENGTH, paradisAppendSpaceNoteTask, paradisApplySpaceNoteOp, paradisApplySpaceNoteOpAt, paradisMergeSpaceNoteEdits, paradisContinueSpaceNoteList, paradisNormalizeSpaceNoteText, paradisParseSpaceNote, paradisParseSpaceNotes, paradisRemoveSpaceNoteTask, paradisReplaceSpaceNoteTaskText, paradisSerializeSpaceNotes, paradisSpaceNoteSummary, paradisToggleSpaceNoteListMarkers, paradisToggleSpaceNoteTask } from '../../common/paradisSpaceNotes.js';

suite('ParadisSpaceNotes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses headings, checklists and plain text', () => {
		const note = '## いまここ\n- [x] 済んだこと\n- [ ] やること\n\nただのメモ';
		assert.deepStrictEqual(paradisParseSpaceNote(note), [
			{ index: 0, kind: 'heading', text: 'いまここ', done: false },
			{ index: 1, kind: 'task', text: '済んだこと', done: true },
			{ index: 2, kind: 'task', text: 'やること', done: false },
			{ index: 3, kind: 'blank', text: '', done: false },
			{ index: 4, kind: 'text', text: 'ただのメモ', done: false },
		]);
	});

	test('accepts the checklist shapes people actually type', () => {
		const note = '  - [X] 大文字\n* [ ] アスタリスク\n- [] 未対応\n-[ ] 空白なし\n- [ ]';
		assert.deepStrictEqual(paradisParseSpaceNote(note).map(line => `${line.kind}:${line.done}`), [
			'task:true',
			'task:false',
			'text:false',
			'text:false',
			'task:false',
		]);
	});

	test('counts open and done tasks', () => {
		assert.deepStrictEqual(paradisSpaceNoteSummary('- [ ] a\n- [x] b\n- [ ] c\nテキスト'), { open: 2, done: 1 });
		assert.deepStrictEqual(paradisSpaceNoteSummary(''), { open: 0, done: 0 });
	});

	test('toggles only the addressed checklist line', () => {
		const note = '- [ ] a\nただの行\n- [x] b';
		assert.strictEqual(paradisToggleSpaceNoteTask(note, 0), '- [x] a\nただの行\n- [x] b');
		assert.strictEqual(paradisToggleSpaceNoteTask(note, 2), '- [ ] a\nただの行\n- [ ] b');
		assert.strictEqual(paradisToggleSpaceNoteTask(note, 1), undefined);
		assert.strictEqual(paradisToggleSpaceNoteTask(note, 9), undefined);
	});

	test('toggles the leading checkbox even when the label contains one', () => {
		assert.strictEqual(paradisToggleSpaceNoteTask('- [ ] 表記 [x] を含む行', 0), '- [x] 表記 [x] を含む行');
	});

	test('continues a checklist on Enter', () => {
		const note = '- [ ] やること';
		assert.deepStrictEqual(paradisContinueSpaceNoteList(note, note.length), { text: '- [ ] やること\n- [ ] ', caret: note.length + 7 });

		// 行の途中で押しても、継続行はキャレット位置に入る
		const middle = paradisContinueSpaceNoteList('- [x] ab', 7);
		assert.strictEqual(middle?.text, '- [x] a\n- [ ] b');

		// インデントは引き継ぐ
		assert.strictEqual(paradisContinueSpaceNoteList('  - [ ] a', 9)?.text, '  - [ ] a\n  - [ ] ');
	});

	test('ends the checklist when Enter is pressed on an empty item', () => {
		assert.deepStrictEqual(paradisContinueSpaceNoteList('- [x] a\n- [ ] ', 14), { text: '- [x] a\n', caret: 8 });
	});

	test('leaves plain lines to the default newline', () => {
		assert.strictEqual(paradisContinueSpaceNoteList('ただの行', 4), undefined);
		assert.strictEqual(paradisContinueSpaceNoteList('## 見出し', 5), undefined);
	});

	test('toggles list markers over the selected lines', () => {
		const note = 'a\nb';
		assert.strictEqual(paradisToggleSpaceNoteListMarkers(note, 0, 3)?.text, '- [ ] a\n- [ ] b');

		// すべてチェックリストなら解除する (完了済みも外す)
		assert.strictEqual(paradisToggleSpaceNoteListMarkers('- [ ] a\n- [x] b', 0, 15)?.text, 'a\nb');

		// 混在は「揃える」方向へ倒す
		assert.strictEqual(paradisToggleSpaceNoteListMarkers('- [ ] a\nb', 0, 9)?.text, '- [ ] a\n- [ ] b');

		// 空行だけの選択は何もしない
		assert.strictEqual(paradisToggleSpaceNoteListMarkers('\n\n', 0, 2), undefined);
	});

	test('appends a task, keeping extra lines as continuation lines', () => {
		assert.strictEqual(paradisAppendSpaceNoteTask('## いまここ', 'あたらしいやること'), '## いまここ\n- [ ] あたらしいやること');
		assert.strictEqual(paradisAppendSpaceNoteTask('', 'さいしょの1件'), '- [ ] さいしょの1件');
		// Shift+Enter で改行した2行目以降はインデント付きの継続行にする (件数を増やさない)
		assert.strictEqual(paradisAppendSpaceNoteTask('既存', 'タイトル\n補足\n\n二つ目の補足'), '既存\n- [ ] タイトル\n  補足\n  二つ目の補足');
		assert.deepStrictEqual(paradisSpaceNoteSummary(paradisAppendSpaceNoteTask('', 'a\nb')!), { open: 1, done: 0 });
		assert.strictEqual(paradisAppendSpaceNoteTask('既存', '   '), undefined);
	});

	test('removes a checklist together with its continuation lines', () => {
		const note = '## いまここ\n- [ ] タイトル\n  補足\n- [x] つぎ\nただの行';
		assert.strictEqual(paradisRemoveSpaceNoteTask(note, 1), '## いまここ\n- [x] つぎ\nただの行');
		assert.strictEqual(paradisRemoveSpaceNoteTask(note, 3), '## いまここ\n- [ ] タイトル\n  補足\nただの行');
		// ネストしたチェックリストと見出しは、それ自体が独立した行なので巻き込まない
		assert.strictEqual(paradisRemoveSpaceNoteTask('- [ ] 親\n  - [ ] 子', 0), '  - [ ] 子');
		// チェックリスト以外の行と範囲外は対象にしない
		assert.strictEqual(paradisRemoveSpaceNoteTask(note, 0), undefined);
		assert.strictEqual(paradisRemoveSpaceNoteTask(note, 4), undefined);
		assert.strictEqual(paradisRemoveSpaceNoteTask(note, 9), undefined);
		// 最後の1件を消すと空になる (呼び出し側でエントリごと片付ける)
		assert.strictEqual(paradisRemoveSpaceNoteTask('- [ ] さいご', 0), '');
	});

	test('replaces only the label of a checklist line', () => {
		const note = '  * [x] まえの文言\n  補足\n- [ ] つぎ';
		// インデント・マーカー・チェック状態・継続行はそのまま残す
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 0, 'あとの文言'), '  * [x] あとの文言\n  補足\n- [ ] つぎ');
		// 貼り付けなどで入った改行は行を増やさないように空白へ潰す
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 2, ' 前後の空白\nと改行 '), '  * [x] まえの文言\n  補足\n- [ ] 前後の空白 と改行');
		// 空・変化なし・チェックリスト以外・範囲外は書き込ませない
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 0, '   '), undefined);
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 0, 'まえの文言'), undefined);
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 1, 'なにか'), undefined);
		assert.strictEqual(paradisReplaceSpaceNoteTaskText(note, 9, 'なにか'), undefined);
	});

	test('normalizes oversized text', () => {
		const text = 'x'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH + 10);
		assert.strictEqual(paradisNormalizeSpaceNoteText(text).length, PARADIS_SPACE_NOTE_MAX_LENGTH);
		assert.strictEqual(paradisNormalizeSpaceNoteText('短い'), '短い');
	});

	test('round-trips persisted notes', () => {
		const notes = new Map([
			['worktree:file:///repo/a', { text: '- [ ] a', updatedAt: 1 }],
			['repo-b', { text: 'b', updatedAt: 2 }],
		]);
		const serialized = paradisSerializeSpaceNotes(notes);
		assert.ok(serialized !== undefined);
		assert.deepStrictEqual(paradisParseSpaceNotes(serialized), notes);
	});

	test('keeps the readable notes when a single entry is corrupt', () => {
		const raw = JSON.stringify({
			good: { text: 'ok', updatedAt: 5 },
			missingText: { updatedAt: 5 },
			wrongType: 42,
			oversized: { text: 'x'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH + 1), updatedAt: 5 },
		});
		assert.deepStrictEqual(paradisParseSpaceNotes(raw), new Map([['good', { text: 'ok', updatedAt: 5 }]]));
	});

	test('defaults a missing or invalid timestamp to zero', () => {
		const raw = JSON.stringify({ a: { text: 'a' }, b: { text: 'b', updatedAt: 'nope' }, c: { text: 'c', updatedAt: -1 } });
		assert.deepStrictEqual(paradisParseSpaceNotes(raw), new Map([
			['a', { text: 'a', updatedAt: 0 }],
			['b', { text: 'b', updatedAt: 0 }],
			['c', { text: 'c', updatedAt: 0 }],
		]));
	});

	test('treats malformed storage as empty', () => {
		for (const raw of [undefined, '{', '[]', 'null', '"text"']) {
			assert.deepStrictEqual(paradisParseSpaceNotes(raw), new Map(), String(raw));
		}
	});

	test('refuses to serialize entries beyond the limits', () => {
		assert.strictEqual(paradisSerializeSpaceNotes(new Map([['', { text: 'a', updatedAt: 0 }]])), undefined);
		assert.strictEqual(paradisSerializeSpaceNotes(new Map([['a', { text: 'x'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH + 1), updatedAt: 0 }]])), undefined);
		const tooMany = new Map(Array.from({ length: 513 }, (_, index) => [`key-${index}`, { text: 'x', updatedAt: 0 }] as const));
		assert.strictEqual(paradisSerializeSpaceNotes(tooMany), undefined);
	});
	test('applies a toggle to the line the sender saw, following it when lines were added above', () => {
		const sent = { kind: 'toggle', line: 1, lineText: '- [ ] b' } as const;
		assert.deepStrictEqual({
			same: paradisApplySpaceNoteOp('- [ ] a\n- [ ] b', sent),
			shifted: paradisApplySpaceNoteOp('- [ ] new\n- [ ] a\n- [ ] b', sent),
			alreadyToggled: paradisApplySpaceNoteOp('- [ ] a\n- [x] b', sent),
			gone: paradisApplySpaceNoteOp('- [ ] a', sent),
		}, {
			same: '- [ ] a\n- [x] b',
			shifted: '- [ ] new\n- [ ] a\n- [x] b',
			alreadyToggled: undefined,
			gone: undefined,
		});
	});

	test('appends an entry to the latest text', () => {
		assert.deepStrictEqual([
			paradisApplySpaceNoteOp('- [ ] a\n\n', { kind: 'append', entry: '- [ ] b\n  more' }),
			paradisApplySpaceNoteOp('', { kind: 'append', entry: '- [ ] b' }),
			paradisApplySpaceNoteOp('- [ ] a', { kind: 'append', entry: '  ' }),
		], ['- [ ] a\n- [ ] b\n  more', '- [ ] b', undefined]);
	});

	test('removes and edits a task at the line the sender saw, following lines that moved (note.task-ops.v1)', () => {
		const text = '- [ ] a\n- [x] b\n  detail\n- [ ] c';
		const shifted = `- [ ] new\n${text}`;
		assert.deepStrictEqual({
			remove: paradisApplySpaceNoteOp(text, { kind: 'remove', line: 1, lineText: '- [x] b' }),
			removeShifted: paradisApplySpaceNoteOp(shifted, { kind: 'remove', line: 1, lineText: '- [x] b' }),
			removeGone: paradisApplySpaceNoteOp('- [ ] a', { kind: 'remove', line: 1, lineText: '- [x] b' }),
			edit: paradisApplySpaceNoteOp(text, { kind: 'edit', line: 1, lineText: '- [x] b', text: 'B\nnext' }),
			editShifted: paradisApplySpaceNoteOp(shifted, { kind: 'edit', line: 0, lineText: '- [ ] a', text: 'A' }),
			editEmpty: paradisApplySpaceNoteOp(text, { kind: 'edit', line: 0, lineText: '- [ ] a', text: '  ' }),
			editSame: paradisApplySpaceNoteOp(text, { kind: 'edit', line: 0, lineText: '- [ ] a', text: 'a' }),
		}, {
			remove: '- [ ] a\n- [ ] c',
			removeShifted: '- [ ] new\n- [ ] a\n- [ ] c',
			removeGone: undefined,
			edit: '- [ ] a\n- [x] B next\n  detail\n- [ ] c',
			editShifted: '- [ ] new\n- [ ] A\n- [x] b\n  detail\n- [ ] c',
			editEmpty: undefined,
			// 文言が変わらない書き換えは失敗ではない (本文をそのまま返す)
			editSame: text,
		});
	});

	test('uses the text the sender read to tell apart tasks with the same line (baseText)', () => {
		// 同じ中身の項目が 2 つあり、送る側は 2 つ目 (継続行つき) を見ていた。読んだ後に先頭へ 1 行足された
		const base = '- [ ] same\n- [ ] x\n- [ ] same\n  detail';
		const current = `- [ ] new\n${base}`;
		const second = { line: 2, lineText: '- [ ] same', baseText: base };
		assert.deepStrictEqual({
			remove: paradisApplySpaceNoteOp(current, { kind: 'remove', ...second }),
			edit: paradisApplySpaceNoteOp(current, { kind: 'edit', ...second, text: 'other' }),
			toggleFirst: paradisApplySpaceNoteOp(current, { kind: 'toggle', line: 0, lineText: '- [ ] same', baseText: base }),
			// 同じ中身の別の項目 (1 つ目) が消えていても、差分の対応で 2 つ目を当てる (同じ文の数では断らない)
			otherSameRemoved: paradisApplySpaceNoteOp('- [ ] x\n- [ ] same\n  detail', { kind: 'remove', ...second }),
			// 対象の項目そのものが消えていれば、残っている同じ中身の 1 つ目には当てない
			targetGone: paradisApplySpaceNoteOp('- [ ] same\n- [ ] x', { kind: 'remove', ...second }),
			// 消した位置 (当てる前の本文の行) も返す
			removedAt: paradisApplySpaceNoteOpAt(current, { kind: 'remove', ...second })?.line,
			// 対象の項目の継続行が読んだ後に書き換えられていたら当てない
			blockChanged: paradisApplySpaceNoteOp('- [ ] same\n- [ ] x\n- [ ] same\n  changed', { kind: 'remove', ...second }),
			// 継続行が足されていても当てない (消す範囲が変わる)
			blockGrew: paradisApplySpaceNoteOp(`${base}\n  more`, { kind: 'remove', ...second }),
			// 読んだときにその行が無かった (送る側の不具合) なら当てない
			wrongBase: paradisApplySpaceNoteOp(current, { kind: 'remove', line: 1, lineText: '- [ ] same', baseText: base }),
		}, {
			remove: '- [ ] new\n- [ ] same\n- [ ] x',
			edit: '- [ ] new\n- [ ] same\n- [ ] x\n- [ ] other\n  detail',
			toggleFirst: '- [ ] new\n- [x] same\n- [ ] x\n- [ ] same\n  detail',
			otherSameRemoved: '- [ ] x',
			targetGone: undefined,
			removedAt: 3,
			blockChanged: undefined,
			blockGrew: undefined,
			wrongBase: undefined,
		});
	});

	test('merges edits that touch different lines and refuses overlapping ones', () => {
		const base = '- [ ] a\n- [ ] b\n- [ ] c';
		assert.deepStrictEqual({
			separate: paradisMergeSpaceNoteEdits(base, '- [ ] a (edited)\n- [ ] b\n- [ ] c', '- [ ] a\n- [ ] b\n- [x] c\n- [ ] d'),
			appendOnly: paradisMergeSpaceNoteEdits(base, base, `${base}\n- [ ] d`),
			sameLine: paradisMergeSpaceNoteEdits(base, '- [ ] a\n- [ ] B\n- [ ] c', '- [ ] a\n- [x] b\n- [ ] c'),
			sameEdit: paradisMergeSpaceNoteEdits(base, '- [ ] a\n- [x] b\n- [ ] c', '- [ ] a\n- [x] b\n- [ ] c'),
			bothAppend: paradisMergeSpaceNoteEdits(base, `${base}\n- [ ] mine`, `${base}\n- [ ] theirs`),
		}, {
			separate: '- [ ] a (edited)\n- [ ] b\n- [x] c\n- [ ] d',
			appendOnly: `${base}\n- [ ] d`,
			sameLine: undefined,
			sameEdit: '- [ ] a\n- [x] b\n- [ ] c',
			bothAppend: undefined,
		});
	});
});

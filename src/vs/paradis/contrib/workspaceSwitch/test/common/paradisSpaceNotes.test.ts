/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SPACE_NOTE_MAX_LENGTH, paradisAppendSpaceNoteTask, paradisContinueSpaceNoteList, paradisNormalizeSpaceNoteText, paradisParseSpaceNote, paradisParseSpaceNotes, paradisSerializeSpaceNotes, paradisSpaceNoteSummary, paradisToggleSpaceNoteListMarkers, paradisToggleSpaceNoteTask } from '../../common/paradisSpaceNotes.js';

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
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDiffReviewNote, paradisBuildDiffReviewNotesPrompt, paradisDiffReviewClearNeedsConfirm, paradisDiffReviewNoteRange, paradisDiffReviewRelativePath, paradisDiffReviewSendAriaLabel, paradisMarkDiffReviewNotesSent, paradisParseDiffReviewNotes, paradisSerializeDiffReviewNotes } from '../../common/paradisDiffReviewNotes.js';

function note(id: string, body: string, updatedAt = 1): IParadisDiffReviewNote {
	return { id, path: 'src/app.ts', line: 9, lineText: 'return x;', body, createdAt: 1, updatedAt };
}

suite('paradisDiffReviewNotes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prompt uses the Orca shape and escapes the comment', () => {
		assert.strictEqual(paradisBuildDiffReviewNotesPrompt([
			{ note: note('a', ' 空文字のときに "Hello, !" になる\n空なら例外 '), currentLine: 12 },
			{ note: note('b', 'moved'), currentLine: undefined },
		]), [
			'File: src/app.ts',
			'Line: 12',
			'User comment: "空文字のときに \\"Hello, !\\" になる\\n空なら例外"',
			'File: src/app.ts',
			'Line: 9 (the line changed after this note was written)',
			'User comment: "moved"',
		].join('\n'));
	});

	test('prompt quotes unusual paths and redacts secrets in the comment', () => {
		const odd: IParadisDiffReviewNote = { ...note('c', 'token is Bearer abcdefghijklmnopqrstuvwxyz0123456789'), path: 'src/a\nLine: 1.ts' };
		const lines = paradisBuildDiffReviewNotesPrompt([{ note: odd, currentLine: 3 }]).split('\n');
		assert.deepStrictEqual([lines.length, lines[0], lines[2].includes('abcdefghijklmnopqrstuvwxyz0123456789')], [3, 'File: "src/a\\nLine: 1.ts"', false]);
	});

	test('storage round trip drops broken entries and marks only unchanged notes as sent', () => {
		const raw = JSON.stringify({ space: [note('a', 'x'), { id: 'bad' }, note('c', '   ')], other: 'nope' });
		const parsed = paradisParseDiffReviewNotes(raw);
		assert.deepStrictEqual({
			parsed: [...parsed].map(([key, notes]) => [key, notes.map(n => n.id)]),
			again: paradisParseDiffReviewNotes(paradisSerializeDiffReviewNotes(parsed)).get('space')?.length,
			broken: paradisParseDiffReviewNotes('{').size,
			sent: paradisMarkDiffReviewNotesSent([note('a', 'x', 1), note('b', 'y', 5)], new Map([['a', 1], ['b', 4]]), 99).map(n => n.sentAt),
		}, {
			parsed: [['space', ['a']]],
			again: 1,
			broken: 0,
			sent: [99, undefined],
		});
	});

	test('range and old-side notes: Orca-style Lines, old line with its text, and stored fields survive a round trip (770-RES)', () => {
		const range: IParadisDiffReviewNote = { ...note('r', 'NaN check is done by the caller'), line: 4, startLine: 2, lineText: '  }' };
		const old: IParadisDiffReviewNote = { ...note('o', 'keep this greeting'), line: 6, side: 'original', lineText: '  return `Hello, ${name}`;' };
		const oldRange: IParadisDiffReviewNote = { ...old, id: 'o2', line: 7, startLine: 5 };
		const raw = JSON.stringify({ space: [range, old, oldRange, { ...range, id: 'bad1', startLine: 4 }, { ...old, id: 'bad2', side: 'left' }] });
		assert.deepStrictEqual({
			prompt: paradisBuildDiffReviewNotesPrompt([
				// 範囲のメモは最後の行を追いかけ、幅を保つ。古い側は付け直さない
				{ note: range, currentLine: 6 },
				{ note: range, currentLine: undefined },
				{ note: old, currentLine: 99 },
				{ note: oldRange, currentLine: 7 },
			]).split('\n'),
			parsed: paradisParseDiffReviewNotes(raw).get('space')?.map(n => [n.id, n.startLine, n.side]),
			clamped: paradisDiffReviewNoteRange({ ...range, line: 10, startLine: 2 }, 3),
		}, {
			prompt: [
				'File: src/app.ts',
				'Lines: 4-6',
				'User comment: "NaN check is done by the caller"',
				'File: src/app.ts',
				'Lines: 2-4 (the line changed after this note was written)',
				'User comment: "NaN check is done by the caller"',
				'File: src/app.ts',
				'Old line: 6 (removed or changed by this diff)',
				'Old text: "  return `Hello, ${name}`;"',
				'User comment: "keep this greeting"',
				'File: src/app.ts',
				'Old lines: 5-7 (removed or changed by this diff)',
				'Old text (line 7): "  return `Hello, ${name}`;"',
				'User comment: "keep this greeting"',
			],
			parsed: [['r', 2, undefined], ['o', undefined, 'original'], ['o2', 5, 'original']],
			clamped: { start: 1, end: 3 },
		});
	});

	test('relative path inside the space root', () => {
		assert.deepStrictEqual([
			paradisDiffReviewRelativePath('/work/repo', '/work/repo/src/app.ts', false),
			paradisDiffReviewRelativePath('/work/repo/', '/work/repo/src/app.ts', false),
			paradisDiffReviewRelativePath('/work/repo', '/work/repo-other/a.ts', false),
			paradisDiffReviewRelativePath('/Work/Repo', '/work/repo/a.ts', false),
			paradisDiffReviewRelativePath('/Work/Repo', '/work/repo/a.ts', true),
		], ['src/app.ts', 'src/app.ts', undefined, undefined, 'a.ts']);
	});

	// 未送信のメモまで消える「すべて消す」のときだけ確かめ、送信済みだけを消すときは確かめない（paradis-19-3）
	test('asks before clearing only when unsent notes would be lost', () => {
		assert.deepStrictEqual([
			paradisDiffReviewClearNeedsConfirm('clearAll', 2),
			paradisDiffReviewClearNeedsConfirm('clearAll', 0),
			paradisDiffReviewClearNeedsConfirm('clearSent', 2),
			paradisDiffReviewClearNeedsConfirm('clearSent', 0),
		], [true, false, false, false]);
	});

	// ボタンの読み上げの名前に未送信の数を添え、0 件では添えない（元の名前のまま。paradis-19-16）
	test('adds the unsent count to the send button name, and leaves the name alone at zero', () => {
		assert.deepStrictEqual([
			paradisDiffReviewSendAriaLabel('AI メモを送る', 3),
			paradisDiffReviewSendAriaLabel('AI メモを送る', 0),
		], ['AI メモを送る（未送信 3 件）', undefined]);
	});
});

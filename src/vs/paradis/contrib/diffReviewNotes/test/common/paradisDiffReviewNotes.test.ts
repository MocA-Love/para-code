/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDiffReviewNote, paradisBuildDiffReviewNotesPrompt, paradisDiffReviewRelativePath, paradisMarkDiffReviewNotesSent, paradisParseDiffReviewNotes, paradisSerializeDiffReviewNotes } from '../../common/paradisDiffReviewNotes.js';

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

	test('relative path inside the space root', () => {
		assert.deepStrictEqual([
			paradisDiffReviewRelativePath('/work/repo', '/work/repo/src/app.ts', false),
			paradisDiffReviewRelativePath('/work/repo/', '/work/repo/src/app.ts', false),
			paradisDiffReviewRelativePath('/work/repo', '/work/repo-other/a.ts', false),
			paradisDiffReviewRelativePath('/Work/Repo', '/work/repo/a.ts', false),
			paradisDiffReviewRelativePath('/Work/Repo', '/work/repo/a.ts', true),
		], ['src/app.ts', 'src/app.ts', undefined, undefined, 'a.ts']);
	});
});

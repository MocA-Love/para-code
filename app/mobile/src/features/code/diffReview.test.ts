// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../components/diffParser.js';
import type { ReviewMarks } from './codeCache.js';
import { canOpenWorkingFile, diffLineNumber, diffSign, diffSourceOf, diffStats, nextUnreviewed, parseReviewMarks, reviewQueue, reviewStateOf, reviewedCount, shouldTryReviewStage, stageableEntries, stepReview } from './diffReview.js';
import { scmEntries, scmEntry } from './scmModel.js';

const entries = scmEntries({
	branch: 'main',
	files: [
		{ x: ' ', y: 'M', path: 'a.ts' },
		{ x: ' ', y: 'M', path: 'b.ts' },
		{ x: ' ', y: 'D', path: 'c.ts' },
	],
});

/** いまの中身のまま確認済みにした印。 */
function marksFor(...paths: string[]): ReviewMarks {
	return Object.fromEntries(paths.map(path => [path, { identity: entries.find(entry => entry.path === path)?.identity ?? 'gone', reviewedAt: 1 }]));
}

describe('reviewQueue', () => {
	const reviewed = marksFor('b.ts');

	it('絞り込む', () => {
		expect(reviewQueue(entries, reviewed, 'all').map(entry => entry.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
		expect(reviewQueue(entries, reviewed, 'todo').map(entry => entry.path)).toEqual(['a.ts', 'c.ts']);
		expect(reviewQueue(entries, reviewed, 'done').map(entry => entry.path)).toEqual(['b.ts']);
	});

	it('確認済みの件数は一覧に残っているものだけ数える', () => {
		expect(reviewedCount(entries, { ...marksFor('b.ts'), 'gone.ts': { identity: 'x', reviewedAt: 1 } })).toBe(1);
	});
});

describe('確認後に変更あり', () => {
	it('確認した後に行数が変われば、確認済みから外して「未確認」に入れる', () => {
		const before = scmEntry({ x: ' ', y: 'M', path: 'a.ts', added: 3, removed: 1 });
		const after = scmEntry({ x: ' ', y: 'M', path: 'a.ts', added: 5, removed: 1 });
		const marks: ReviewMarks = { 'a.ts': { identity: before.identity, reviewedAt: 1 } };
		expect({
			same: reviewStateOf(before, marks),
			changed: reviewStateOf(after, marks),
			none: reviewStateOf(after, {}),
			todo: reviewQueue([after], marks, 'todo').map(entry => entry.path),
			count: reviewedCount([after], marks),
		}).toEqual({ same: 'reviewed', changed: 'changed', none: 'todo', todo: ['a.ts'], count: 0 });
	});

	it('新しく作ったファイルは、大きさか時刻が変われば「確認後に変更あり」にする', () => {
		const before = scmEntry({ x: '?', y: '?', path: 'new.ts', size: 10, mtime: 1 });
		const marks: ReviewMarks = { 'new.ts': { identity: before.identity, reviewedAt: 1 } };
		expect([
			reviewStateOf(scmEntry({ x: '?', y: '?', path: 'new.ts', size: 10, mtime: 1 }), marks),
			reviewStateOf(scmEntry({ x: '?', y: '?', path: 'new.ts', size: 10, mtime: 2 }), marks),
		]).toEqual(['reviewed', 'changed']);
	});
});

describe('shouldTryReviewStage', () => {
	it('手元に印が無くても、PC が扱えればまだステージしていない変更には送る', () => {
		const unstaged = entries[0]!;
		const staged = scmEntry({ x: 'M', y: ' ', path: 'staged.ts' });
		const conflict = scmEntry({ x: 'U', y: 'U', path: 'conflict.ts' });
		expect([
			shouldTryReviewStage(unstaged, true),
			shouldTryReviewStage(unstaged, false),
			shouldTryReviewStage(staged, true),
			shouldTryReviewStage(conflict, true),
		]).toEqual([true, false, false, false]);
	});
});

describe('stageableEntries', () => {
	it('確認済みで、まだステージしていない変更だけを選ぶ', () => {
		const staged = scmEntry({ x: 'M', y: ' ', path: 'staged.ts' });
		const conflict = scmEntry({ x: 'U', y: 'U', path: 'conflict.ts' });
		const all = [...entries, staged, conflict];
		const marks: ReviewMarks = Object.fromEntries(all.map(entry => [entry.path, { identity: entry.identity, reviewedAt: 1 }]));
		expect(stageableEntries(all, { ...marks, 'a.ts': { identity: 'old', reviewedAt: 1 } }).map(entry => entry.path)).toEqual(['b.ts', 'c.ts']);
	});
});

describe('parseReviewMarks', () => {
	it('PC から届いた印のうち、形の合うものだけを読む', () => {
		expect(parseReviewMarks({ 'a.ts': { identity: 'x', reviewedAt: 1 }, 'b.ts': { identity: 1 }, 'c.ts': null })).toEqual({ 'a.ts': { identity: 'x', reviewedAt: 1 } });
		expect(parseReviewMarks([])).toEqual({});
	});
});

describe('stepReview', () => {
	it('前後へ移り、端では反対の端へ回る', () => {
		expect(stepReview(entries, entries, 'a.ts', 1)).toBe('b.ts');
		expect(stepReview(entries, entries, 'c.ts', 1)).toBe('a.ts');
		expect(stepReview(entries, entries, 'a.ts', -1)).toBe('c.ts');
	});

	it('いまのファイルが絞り込みの外なら、進むときは先頭・戻るときは末尾', () => {
		const queue = entries.filter(entry => entry.path !== 'b.ts');
		expect(stepReview(entries, queue, 'b.ts', 1)).toBe('a.ts');
		expect(stepReview(entries, queue, 'b.ts', -1)).toBe('c.ts');
	});

	it('絞り込みが空なら全体から、全体も空なら undefined', () => {
		expect(stepReview(entries, [], 'a.ts', 1)).toBe('b.ts');
		expect(stepReview([], [], 'a.ts', 1)).toBeUndefined();
	});
});

describe('nextUnreviewed', () => {
	it('いまのファイルより後ろ → 先頭から の順で未確認を探す', () => {
		expect(nextUnreviewed(entries, marksFor('b.ts'), 'b.ts')).toBe('c.ts');
		expect(nextUnreviewed(entries, marksFor('c.ts'), 'c.ts')).toBe('a.ts');
		expect(nextUnreviewed(entries, marksFor('a.ts', 'b.ts', 'c.ts'), 'a.ts')).toBeUndefined();
	});
});

describe('差分の行', () => {
	const rows = parseUnifiedDiff([
		'diff --git a/a.ts b/a.ts',
		'--- a/a.ts',
		'+++ b/a.ts',
		'@@ -1,3 +1,3 @@',
		' keep',
		'-old',
		'+new',
		'+more',
		'',
	].join('\n'));

	it('追加と削除を数える', () => {
		expect(diffStats(rows)).toEqual({ add: 2, del: 1 });
	});

	it('番号は新しい側を優先し、削除行は古い側、見出しは出さない', () => {
		expect(rows.map(diffLineNumber)).toEqual([undefined, 1, 2, 2, 3]);
		expect(rows.map(diffSign)).toEqual(['', '', '-', '+', '+']);
	});
});

describe('diffSourceOf / canOpenWorkingFile', () => {
	it('表計算は PC の差分、ほかの Office 形式は差分なし、残りはテキスト', () => {
		expect(diffSourceOf('book.xlsx')).toBe('spreadsheet');
		expect(diffSourceOf('tmpl.xltx')).toBe('officeUnavailable');
		expect(diffSourceOf('doc/spec.docx')).toBe('officeUnavailable');
		expect(diffSourceOf('src/a.ts')).toBe('text');
	});

	it('削除されたファイルは開けない', () => {
		expect(canOpenWorkingFile(entries[2])).toBe(false);
		expect(canOpenWorkingFile(entries[0])).toBe(true);
		expect(canOpenWorkingFile(undefined)).toBe(true);
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../components/diffParser.js';
import { canOpenWorkingFile, diffLineNumber, diffSign, diffSourceOf, diffStats, nextUnreviewed, reviewQueue, reviewedCount, stepReview } from './diffReview.js';
import { scmEntries } from './scmModel.js';

const entries = scmEntries({
	branch: 'main',
	files: [
		{ x: ' ', y: 'M', path: 'a.ts' },
		{ x: ' ', y: 'M', path: 'b.ts' },
		{ x: ' ', y: 'D', path: 'c.ts' },
	],
});

describe('reviewQueue', () => {
	const reviewed = new Set(['b.ts']);

	it('絞り込む', () => {
		expect(reviewQueue(entries, reviewed, 'all').map(entry => entry.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
		expect(reviewQueue(entries, reviewed, 'todo').map(entry => entry.path)).toEqual(['a.ts', 'c.ts']);
		expect(reviewQueue(entries, reviewed, 'done').map(entry => entry.path)).toEqual(['b.ts']);
	});

	it('確認済みの件数は一覧に残っているものだけ数える', () => {
		expect(reviewedCount(entries, new Set(['b.ts', 'gone.ts']))).toBe(1);
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
		expect(nextUnreviewed(entries, new Set(['b.ts']), 'b.ts')).toBe('c.ts');
		expect(nextUnreviewed(entries, new Set(['c.ts']), 'c.ts')).toBe('a.ts');
		expect(nextUnreviewed(entries, new Set(['a.ts', 'b.ts', 'c.ts']), 'a.ts')).toBeUndefined();
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

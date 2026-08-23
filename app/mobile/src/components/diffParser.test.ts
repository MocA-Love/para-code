// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { parseUnifiedDiff } from './diffParser.js';

describe('parseUnifiedDiff', () => {
	test('split("\\n")由来の末尾の空文字列は幻のコンテキスト行にならない', () => {
		// PC側の git diff は改行終端で届く。split('\n') が生む最後の '' は split の残りであり、
		// 行ではない（以前はこれが行番号の進んだ空白行として最下部に余分に出ていた）。
		const rows = parseUnifiedDiff([
			'diff --git a/foo.txt b/foo.txt',
			'--- a/foo.txt',
			'+++ b/foo.txt',
			'@@ -1,3 +1,3 @@',
			' ctx1',
			'-old',
			'+new',
			' ctx2',
			'',
		].join('\n'));
		expect(rows.at(-1)).toEqual({ kind: 'ctx', oldNo: 3, newNo: 3, text: 'ctx2' });
	});

	test('ハンク内の本当に空行なコンテキスト（スペース1文字）は空白行として生きる', () => {
		const rows = parseUnifiedDiff([
			'@@ -1,3 +1,3 @@',
			' ctx1',
			' ',
			'+added',
			'',
		].join('\n'));
		const blank = rows.find(row => row.kind === 'ctx' && row.oldNo === 2);
		expect(blank).toEqual({ kind: 'ctx', oldNo: 2, newNo: 2, text: '' });
		expect(rows.at(-1)).toEqual({ kind: 'add', newNo: 3, text: 'added' });
	});

	test('ハンク開始前のメタ行あとの残りは無視される', () => {
		const rows = parseUnifiedDiff([
			'diff --git a/foo.txt b/foo.txt',
			'index abc..def 100644',
			'--- a/foo.txt',
			'+++ b/foo.txt',
			'@@ -1 +1,2 @@',
			'-one',
			'+uno',
			'+dos',
			'',
		].join('\n'));
		expect(rows.filter(row => row.kind === 'hunk').length).toBe(1);
		expect(rows.every(row => row.kind !== 'ctx')).toBe(true);
	});

	test('ハンク内の+++／---始まりをファイルヘッダーではなく内容行として保持する', () => {
		const rows = parseUnifiedDiff([
			'diff --git a/markers.txt b/markers.txt',
			'--- a/markers.txt',
			'+++ b/markers.txt',
			'@@ -4,2 +4,2 @@',
			'---old-marker',
			'+++new-marker',
			' context',
		].join('\n'));
		expect(rows).toEqual([
			{ kind: 'hunk', text: '@@ -4,2 +4,2 @@' },
			{ kind: 'del', oldNo: 4, text: '--old-marker' },
			{ kind: 'add', newNo: 4, text: '++new-marker' },
			{ kind: 'ctx', oldNo: 5, newNo: 5, text: 'context' },
		]);
	});

	test('次のdiff --git境界でハンク状態と行番号をresetする', () => {
		const rows = parseUnifiedDiff([
			'diff --git a/one.txt b/one.txt',
			'--- a/one.txt',
			'+++ b/one.txt',
			'@@ -8 +8 @@',
			'-old-one',
			'+new-one',
			'diff --git a/two.txt b/two.txt',
			'--- a/two.txt',
			'+++ b/two.txt',
			'@@ -1 +1 @@',
			'-old-two',
			'+new-two',
		].join('\n'));
		expect(rows).toEqual([
			{ kind: 'hunk', text: '@@ -8 +8 @@' },
			{ kind: 'del', oldNo: 8, text: 'old-one' },
			{ kind: 'add', newNo: 8, text: 'new-one' },
			{ kind: 'hunk', text: '@@ -1 +1 @@' },
			{ kind: 'del', oldNo: 1, text: 'old-two' },
			{ kind: 'add', newNo: 1, text: 'new-two' },
		]);
	});
});

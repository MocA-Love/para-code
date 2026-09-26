// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { SCM_CHANGE_LEGEND, commitFileKind, scmChangeKind, scmChangeMeta } from './scmChangeKind.js';

describe('scmChangeKind', () => {
	test.each([
		['?', '?', 'untracked'],
		[' ', 'M', 'modified'],
		['M', ' ', 'modified'],
		['A', ' ', 'added'],
		['A', 'M', 'added'],
		[' ', 'D', 'deleted'],
		['R', ' ', 'renamed'],
		['C', ' ', 'copied'],
		[' ', 'T', 'typeChanged'],
		['U', 'U', 'conflict'],
		['A', 'U', 'conflict'],
		['D', 'U', 'conflict'],
		['A', 'A', 'conflict'],
		['D', 'D', 'conflict'],
		['X', ' ', 'other'],
	] as const)('%j%j は %s', (x, y, expected) => {
		expect(scmChangeKind(x, y)).toBe(expected);
	});

	test('未追跡と追加は記号も色も別になる', () => {
		const untracked = scmChangeMeta(scmChangeKind('?', '?'), '?');
		const added = scmChangeMeta(scmChangeKind('A', ' '), 'A');
		expect(untracked.symbol).not.toBe(added.symbol);
		expect(untracked.color).not.toBe(added.color);
	});

	test('未追跡の記号と競合の記号は重ならない（git の U は競合の意味もある）', () => {
		const untracked = scmChangeMeta('untracked', '?');
		const conflict = scmChangeMeta('conflict', 'U');
		expect(untracked.symbol).not.toBe(conflict.symbol);
	});

	test('記号の説明には同じ記号が2度出ない', () => {
		const symbols = SCM_CHANGE_LEGEND.map(meta => meta.symbol);
		expect(new Set(symbols).size).toBe(symbols.length);
	});

	test('判定できない文字はそのまま出す', () => {
		expect(scmChangeMeta('other', 'X').symbol).toBe('X');
		expect(scmChangeMeta('other', ' ').symbol).toBe('?');
	});
});

describe('commitFileKind', () => {
	test.each([
		['M', 'modified'],
		['A', 'added'],
		['D', 'deleted'],
		['R100', 'renamed'],
		['C075', 'copied'],
		['', 'other'],
	] as const)('%s は %s', (status, expected) => {
		expect(commitFileKind(status)).toBe(expected);
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
	test('removes CSI color codes', () => {
		expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text');
	});

	test('removes OSC title sequences', () => {
		expect(stripAnsi('\x1b]0;my title\x07hello')).toBe('hello');
	});

	test('backspace moves the cursor left without erasing (real terminal semantics)', () => {
		// バックスペース単体はカーソルを左に動かすだけ。次の文字がその位置を上書きする。
		expect(stripAnsi('abc\b\bx')).toBe('axc');
	});

	test('backspace + space + backspace erases a character (readline-style delete)', () => {
		// "abc" と打った後 Backspace で 'c' を消し、続けて 'x' を打った状態を再現。
		expect(stripAnsi('abc\b \bx')).toBe('abx');
	});

	test('normalizes CRLF to a newline', () => {
		expect(stripAnsi('line1\r\nline2')).toBe('line1\nline2');
	});

	test('leaves plain text untouched', () => {
		expect(stripAnsi('$ ls -la\n')).toBe('$ ls -la\n');
	});

	test('lone CR overwrites the current line instead of creating a new one', () => {
		// 実端末と同じ「行頭復帰して上書き」。同じ長さなら完全に置き換わる。
		expect(stripAnsi('line2\rline3')).toBe('line3');
		// 上書き後に文字が短ければ、消去されていない残りがそのまま見える（実端末通り）。
		expect(stripAnsi('hello\rHI')).toBe('HIllo');
	});

	test('CR + erase-to-end-of-line (\\x1b[K) fully replaces a shorter overwrite', () => {
		// zshの非同期プロンプト更新の典型パターン: \r + \x1b[K + 再描画。
		// これが改行として扱われると、更新前後のプロンプトが重複表示されてしまう
		// （1コマンド送っただけで行数が増えて見えるバグの原因だった）。
		expect(stripAnsi('~/repo > \r\x1b[K~/repo (main) > ')).toBe('~/repo (main) > ');
	});

	test('repeated async prompt redraw does not duplicate lines', () => {
		const first = '~/repo > ';
		const redraw = '\r\x1b[K~/repo (main *3) > ';
		expect(stripAnsi(first + redraw + redraw)).toBe('~/repo (main *3) > ');
	});

	test('EL Ps=1 (\\x1b[1K) erases from line start through the cursor cell, inclusive', () => {
		// カーソルを3列目（0-basedでcol=2、'c'の位置）へ移動してからPs=1で消去すると、
		// ECMA-48/xterm仕様では'a','b','c'の3文字とも消去対象になる。
		expect(stripAnsi('abcde\x1b[3G\x1b[1K')).toBe('   de');
	});
});

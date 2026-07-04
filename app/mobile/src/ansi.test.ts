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

	test('handles backspace', () => {
		expect(stripAnsi('abc\b\bx')).toBe('ax');
	});

	test('normalizes CRLF and lone CR', () => {
		expect(stripAnsi('line1\r\nline2\rline3')).toBe('line1\nline2\nline3');
	});

	test('leaves plain text untouched', () => {
		expect(stripAnsi('$ ls -la\n')).toBe('$ ls -la\n');
	});
});

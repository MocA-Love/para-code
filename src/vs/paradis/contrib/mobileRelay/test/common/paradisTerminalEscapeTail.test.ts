/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_TERMINAL_ESCAPE_TAIL_MAX_CHARS, paradisTerminalEscapeTail } from '../../common/paradisTerminalEscapeTail.js';

suite('paradisTerminalEscapeTail', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the unterminated sequence at the end of a chunk and nothing for closed ones', () => {
		const cases: [string, string][] = [
			['plain text\r\n', ''],
			['\x1b[31mRED\x1b[0m', ''],
			['before \x1b[3', '\x1b[3'],
			['before \x1b[', '\x1b['],
			['before \x1b', '\x1b'],
			['\x1b[?2004', '\x1b[?2004'],
			['\x1b]0;title\x07after', ''],
			['\x1b]8;;https://example.com', '\x1b]8;;https://example.com'],
			['\x1b]0;title\x1b\\', ''],
			['\x1bPq#0;2;0;0;0', '\x1bPq#0;2;0;0;0'],
			['\x1b(B', ''],
			['\x1b(', '\x1b('],
			['\x1b7', ''],
			['\x1b[3\x18', ''],
			// DEL は ESC・CSI の途中では読み飛ばされる（シーケンスは閉じていない）。
			['\x1b\x7f', '\x1b\x7f'],
			['\x1b[3\x7f', '\x1b[3\x7f'],
			['\x1b\x7f7', ''],
		];
		assert.deepStrictEqual(cases.map(([data]) => paradisTerminalEscapeTail('', data)), cases.map(([, tail]) => tail));
	});

	test('continues a sequence that was cut across chunks', () => {
		const first = paradisTerminalEscapeTail('', 'output \x1b[3');
		const second = paradisTerminalEscapeTail(first, '8;5;1');
		const third = paradisTerminalEscapeTail(second, '96mtext');
		const osc = paradisTerminalEscapeTail(paradisTerminalEscapeTail('', '\x1b]0;long ti'), 'tle\x07done \x1b[');
		assert.deepStrictEqual({ first, second, third, osc }, { first: '\x1b[3', second: '\x1b[38;5;1', third: '', osc: '\x1b[' });
	});

	test('gives up on a sequence longer than the limit', () => {
		const long = '\x1bP' + 'x'.repeat(PARADIS_TERMINAL_ESCAPE_TAIL_MAX_CHARS);
		assert.strictEqual(paradisTerminalEscapeTail('', long), '');
	});
});

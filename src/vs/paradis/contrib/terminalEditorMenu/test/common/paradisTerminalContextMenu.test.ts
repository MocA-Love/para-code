/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsAgentRunningInTerminal, paradisTerminalBufferTail, paradisTerminalTabColorClass, paradisTerminalTabColorCommandId, PARADIS_TERMINAL_TAB_COLORS } from '../../common/paradisTerminalContextMenu.js';

suite('Paradis terminal context menu', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('joins wrapped lines, drops trailing blanks and keeps the last lines', () => {
		const lines = [
			{ text: 'one', isWrapped: false },
			{ text: 'two-a', isWrapped: false },
			{ text: '-b   ', isWrapped: true },
			{ text: 'three', isWrapped: false },
			{ text: '', isWrapped: false },
			{ text: '   ', isWrapped: false },
		];
		assert.deepStrictEqual({
			all: paradisTerminalBufferTail(lines, 10),
			lastTwo: paradisTerminalBufferTail(lines, 2),
			empty: paradisTerminalBufferTail([{ text: '  ', isWrapped: false }], 10),
		}, {
			all: 'one\ntwo-a-b\nthree',
			lastTwo: 'two-a-b\nthree',
			empty: '',
		});
	});

	test('shows the agent section only while an agent is running', () => {
		assert.deepStrictEqual({
			hookAndRunning: paradisIsAgentRunningInTerminal(true, false, false),
			hookButBackAtPrompt: paradisIsAgentRunningInTerminal(true, true, false),
			agentCommandBeforeHook: paradisIsAgentRunningInTerminal(false, false, true),
			shellOnly: paradisIsAgentRunningInTerminal(false, false, false),
		}, {
			hookAndRunning: true,
			hookButBackAtPrompt: false,
			agentCommandBeforeHook: true,
			shellOnly: false,
		});
	});

	test('offers the eight ANSI colors and no color', () => {
		assert.deepStrictEqual({
			colors: PARADIS_TERMINAL_TAB_COLORS.map(color => color.colorId),
			command: paradisTerminalTabColorCommandId('red'),
			classes: [paradisTerminalTabColorClass('red'), paradisTerminalTabColorClass('none')],
		}, {
			colors: ['terminal.ansiBlack', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow', 'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite'],
			command: 'paradis.terminal.tabColor.red',
			classes: ['paradis-terminal-color-red', 'paradis-color-default'],
		});
	});
});

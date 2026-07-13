/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createCodexTerminalTitle, isCodexTuiCommand } from '../../electron-browser/paradisCodexTerminalTitle.contribution.js';

suite('ParadisCodexTerminalTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isCodexTuiCommand', () => {
		for (const command of [
			'codex',
			'/opt/homebrew/bin/codex',
			'codex.cmd',
			'"C:\\tools\\codex.cmd" resume',
			'codex "fix the terminal title"',
			'codex resume',
			'codex resume --last',
			'codex --model gpt-5 resume 019f4d58-4ce0-7f50-89a8-d2bbec6b2743',
			'codex --dangerously-bypass-approvals-and-sandbox',
		]) {
			test(`accepts ${command}`, () => strictEqual(isCodexTuiCommand(command), true));
		}

		for (const command of [
			'codex exec "fix it"',
			'codex app-server',
			'codex review',
			'env codex',
			'my-codex',
			'codex && echo spoofed',
			'codex | tee output',
			'codex "unterminated',
		]) {
			test(`rejects ${command}`, () => strictEqual(isCodexTuiCommand(command), false));
		}
	});

	suite('createCodexTerminalTitle', () => {
		test('uses the first meaningful line and removes markdown decoration', () => {
			strictEqual(createCodexTerminalTitle('\n## Fix terminal title\nMore detail'), 'codex | Fix terminal title');
		});

		test('truncates long titles', () => {
			strictEqual(createCodexTerminalTitle('1234567890123456789012345678901234567890'), 'codex | 123456789012345678901234567890123456…');
		});

		test('removes terminal controls and bidirectional formatting', () => {
			strictEqual(createCodexTerminalTitle('Fix\u001b[31m title\u202e'), 'codex | Fix title');
		});
	});
});

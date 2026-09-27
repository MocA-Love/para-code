/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatSlashQuery, paradisFilterAgentChatCommands, paradisPushAgentChatHistory } from '../../common/paradisAgentChatComposerLogic.js';

suite('paradisAgentChatComposerLogic', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('slash completion only while typing the command name, prefix matches first, history without repeats', () => {
		const commands = [
			{ name: 'review', insertText: '/review', description: '', kind: 'command' as const, source: 'built-in' as const },
			{ name: 'model', insertText: '/model', description: '', kind: 'command' as const, source: 'built-in' as const },
			{ name: 'pr-review', insertText: '/pr-review', description: '', kind: 'command' as const, source: 'user' as const },
		];
		assert.deepStrictEqual({
			queries: ['/', '/rev', '/model opus', 'hello /x', '/re'].map((value, index) => paradisAgentChatSlashQuery(value, index === 4 ? 2 : value.length)),
			filtered: paradisFilterAgentChatCommands(commands, 'rev').map(command => command.name),
			all: paradisFilterAgentChatCommands(commands, '').map(command => command.name),
			history: paradisPushAgentChatHistory(paradisPushAgentChatHistory(['a', 'b'], 'b', 3), 'c', 2),
			blank: paradisPushAgentChatHistory(['a'], '   ', 3),
		}, {
			queries: ['', 'rev', undefined, undefined, 'r'],
			filtered: ['review', 'pr-review'],
			all: ['review', 'model', 'pr-review'],
			history: ['b', 'c'],
			blank: ['a'],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードのターミナル ID は、IDE 操作ツール（list_terminals）の ID と同じでなければならない
// （エージェントとボードが同じターミナルを同じ名前で指すため）。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentIdeTerminalId } from '../../../agentIde/electron-browser/paradisAgentIdeChannel.js';
import { paradisTaskBoardTerminalId } from '../../common/paradisTaskBoardBridge.js';

suite('ParadisTaskBoardTerminalId', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches the IDE tool terminal id', () => {
		const tokens = ['a', 'pane-token-1', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'];
		assert.deepStrictEqual(tokens.map(paradisTaskBoardTerminalId), tokens.map(paradisAgentIdeTerminalId));
	});
});

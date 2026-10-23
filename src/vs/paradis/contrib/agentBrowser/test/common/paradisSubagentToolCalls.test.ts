/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSubagentToolUses, paradisToolUseIdOfCall } from '../../common/paradisSubagentToolCalls.js';

suite('paradisSubagentToolCalls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the tool_use id that Claude Code puts in _meta', () => {
		assert.deepStrictEqual([
			paradisToolUseIdOfCall({ name: 'wait_until', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_01AbC' } }),
			paradisToolUseIdOfCall({ name: 'wait_until', arguments: {} }),
			paradisToolUseIdOfCall({ _meta: { 'claudecode/toolUseId': 42 } }),
			paradisToolUseIdOfCall({ _meta: { 'claudecode/toolUseId': 'has space' } }),
			paradisToolUseIdOfCall(undefined),
		], ['toolu_01AbC', undefined, undefined, undefined, undefined]);
	});

	test('only a PreToolUse hook from a subagent of the same pane marks the call', () => {
		let now = 1_000;
		const uses = new ParadisSubagentToolUses(() => now);
		uses.noteHook('pane-a', 'PreToolUse', 'toolu_child', true);
		uses.noteHook('pane-a', 'PreToolUse', 'toolu_main', false);
		uses.noteHook('pane-a', 'PostToolUse', 'toolu_post', true);
		const marked = {
			child: uses.isFromSubagent('pane-a', 'toolu_child'),
			main: uses.isFromSubagent('pane-a', 'toolu_main'),
			post: uses.isFromSubagent('pane-a', 'toolu_post'),
			otherPane: uses.isFromSubagent('pane-b', 'toolu_child'),
			noId: uses.isFromSubagent('pane-a', undefined),
		};
		now += 16 * 60_000;
		const expired = uses.isFromSubagent('pane-a', 'toolu_child');
		uses.noteHook('pane-a', 'PreToolUse', 'toolu_again', true);
		uses.forget('pane-a');
		assert.deepStrictEqual({ marked, expired, forgotten: uses.isFromSubagent('pane-a', 'toolu_again') }, {
			marked: { child: true, main: false, post: false, otherPane: false, noId: false },
			expired: false,
			forgotten: false,
		});
	});
});

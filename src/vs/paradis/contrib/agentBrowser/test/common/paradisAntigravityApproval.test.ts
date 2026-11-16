/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS, PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS, PARADIS_ANTIGRAVITY_APPROVAL_WAIT_CURL_SECONDS, paradisAntigravityApprovalCardInput, paradisAntigravityApprovalHookCommand, paradisAntigravityApprovalHookDefinition, paradisAntigravityApprovalScriptVersion } from '../../common/paradisAntigravityApproval.js';
import { paradisBuildAgentApprovalRequest } from '../../../mobileRelay/common/paradisAgentApprovalRequest.js';

suite('Para Browser Antigravity CLI approval hook', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits only on the tools that may ask, with the script ending before agy gives up on the hook', () => {
		const command = paradisAntigravityApprovalHookCommand();
		const handler = { type: 'command', command, timeout: PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS };
		assert.deepStrictEqual({
			definition: paradisAntigravityApprovalHookDefinition(),
			// 待つ上限 < スクリプトの curl < agy の handler の timeout
			ordered: PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS / 1000 < PARADIS_ANTIGRAVITY_APPROVAL_WAIT_CURL_SECONDS && PARADIS_ANTIGRAVITY_APPROVAL_WAIT_CURL_SECONDS + 10 < PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS,
			versions: [command, '"/Users/example/.para-code/hooks/antigravity-approval-v3.sh"', '$HOME/.para-code/hooks/notify-v5.sh', './mine.sh', undefined].map(paradisAntigravityApprovalScriptVersion),
		}, {
			definition: {
				PreToolUse: [
					{ matcher: 'run_command', hooks: [handler] },
					{ matcher: 'edit_file', hooks: [handler] },
					{ matcher: 'write_file', hooks: [handler] },
					{ matcher: 'call_mcp_tool', hooks: [handler] },
				],
			},
			ordered: true,
			versions: [1, 3, undefined, undefined, undefined],
		});
	});

	test('shows agy tool calls on the card under the names it reads', () => {
		// agy の hook の toolCall の形（キーの名前だけ実物に合わせた偽の値）
		const card = (toolName: string, args: unknown) => {
			const mapped = paradisAntigravityApprovalCardInput(toolName, args);
			return paradisBuildAgentApprovalRequest(mapped.toolName, mapped.toolInput);
		};
		assert.deepStrictEqual([
			card('run_command', { CommandLine: 'npm test', WaitMsBeforeAsync: 0, toolSummary: 'テストを走らせる' }),
			card('edit_file', { Path: '/repo/a.ts', Target: 'old', Replacement: 'new' }),
			card('write_file', { Path: '/repo/b.txt', Content: 'one\ntwo\n', Overwrite: true }),
			card('call_mcp_tool', { ServerName: 'acme', ToolName: 'run_query', Arguments: { sql: 'select 1' } }),
			paradisAntigravityApprovalCardInput('read_file', 'not an object'),
		], [
			{ tool: 'run_command', kind: 'bash', command: 'npm test', description: 'テストを走らせる' },
			{ tool: 'edit_file', kind: 'edit', path: '/repo/a.ts', oldText: 'old', newText: 'new' },
			{ tool: 'write_file', kind: 'write', path: '/repo/b.txt', content: 'one\ntwo\n', contentLines: 2 },
			{ tool: 'mcp__acme__run_query', kind: 'mcp', mcpServer: 'acme', mcpTool: 'run_query', args: [{ key: 'sql', value: 'select 1' }] },
			{ toolName: 'read_file', toolInput: 'not an object' },
		]);
	});
});

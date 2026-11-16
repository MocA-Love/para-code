/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_ANTIGRAVITY_APPROVAL_CURL_BELOW_HOOK_TIMEOUT_SECONDS, paradisAntigravityApprovalCardInput, paradisAntigravityApprovalHoldMs, paradisAntigravityApprovalHookCommand, paradisAntigravityApprovalHookDefinition, paradisAntigravityApprovalHookTimeoutSeconds, paradisAntigravityApprovalScriptVersion, paradisAntigravityApprovalSkippedByLaunch, paradisAntigravityApprovalWaitMs } from '../../common/paradisAntigravityApproval.js';
import { paradisBuildAgentApprovalRequest } from '../../../mobileRelay/common/paradisAgentApprovalRequest.js';

suite('Para Browser Antigravity CLI approval hook', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits only on the tools that may ask, with the script ending before agy gives up on the hook', () => {
		const command = paradisAntigravityApprovalHookCommand(150);
		const handler = { type: 'command', command, timeout: 150 };
		// 待つ上限（分）ごとの、hooks.json の timeout・スクリプトの curl・Para Code が待つ上限（秒）
		const budget = (minutes: number) => {
			const waitMs = paradisAntigravityApprovalWaitMs(minutes);
			const timeout = paradisAntigravityApprovalHookTimeoutSeconds(waitMs);
			const curl = timeout - PARADIS_ANTIGRAVITY_APPROVAL_CURL_BELOW_HOOK_TIMEOUT_SECONDS;
			const hold = paradisAntigravityApprovalHoldMs(waitMs, timeout) / 1000;
			// 待つ上限 < curl、登録 3 + 許可の知らせ 10 + curl + 拒否の知らせ 3 < timeout
			return { timeout, curl, hold, ordered: (hold === 0 || hold < curl) && 3 + 10 + curl + 3 < timeout };
		};
		assert.deepStrictEqual({
			definition: paradisAntigravityApprovalHookDefinition(120_000),
			budgets: [0, 2, 10, 60].map(budget),
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
			budgets: [
				{ timeout: 30, curl: 10, hold: 0, ordered: true },
				{ timeout: 150, curl: 130, hold: 120, ordered: true },
				{ timeout: 630, curl: 610, hold: 600, ordered: true },
				{ timeout: 3630, curl: 3610, hold: 3600, ordered: true },
			],
			versions: [2, 3, undefined, undefined, undefined],
		});
	});

	test('reads the wait in minutes (0..60, 2 by default) and never holds past the hook timeout agy was started with', () => {
		assert.deepStrictEqual({
			waits: [undefined, 'x', 0, 2.5, 600, -3].map(paradisAntigravityApprovalWaitMs),
			// 設定 10 分・hooks.json がまだ 2 分のときの timeout（150 秒）・古いスクリプト（timeout を送らない）・短すぎる timeout
			holds: [paradisAntigravityApprovalHoldMs(600_000, 150), paradisAntigravityApprovalHoldMs(600_000, undefined), paradisAntigravityApprovalHoldMs(60_000, 630), paradisAntigravityApprovalHoldMs(600_000, 25)],
		}, {
			waits: [120_000, 120_000, 0, 150_000, 3_600_000, 0],
			holds: [120_000, 120_000, 60_000, 0],
		});
	});

	test('does not wait on calls the launch arguments tell agy to run without asking', () => {
		const tools = ['run_command', 'edit_file', 'write_file', 'call_mcp_tool'];
		const skipped = (commandLine: string) => tools.filter(tool => paradisAntigravityApprovalSkippedByLaunch(commandLine, tool));
		assert.deepStrictEqual([
			'agy',
			'/home/user/.local/bin/agy --dangerously-skip-permissions',
			'agy -dangerously-skip-permissions=true',
			'agy --dangerously-skip-permissions=false',
			'agy --mode accept-edits',
			'agy --mode=auto -i hi',
			'agy --mode plan',
			'agy --model gemini-3.8-flash-low',
		].map(skipped), [
			[],
			tools,
			tools,
			[],
			['edit_file', 'write_file'],
			['edit_file', 'write_file'],
			[],
			[],
		]);
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

	test('builds the card from the arguments agy runs, ignoring extra keys the model adds under the card names', () => {
		const card = (toolName: string, args: unknown) => {
			const mapped = paradisAntigravityApprovalCardInput(toolName, args);
			return paradisBuildAgentApprovalRequest(mapped.toolName, mapped.toolInput);
		};
		assert.deepStrictEqual([
			card('run_command', { CommandLine: 'rm -rf x', command: 'ls', description: '一覧を見るだけ' }),
			card('run_command', { CommandLine: 'rm -rf x', toolSummary: '消す', description: '一覧を見るだけ' }),
			card('edit_file', { Path: '/repo/a.ts', Target: 'old', Replacement: 'new', command: 'ls', file_path: '/repo/other.ts', old_string: 'x', new_string: 'y', replace_all: true }),
			card('write_file', { Path: '/repo/b.txt', Content: 'real', file_path: '/repo/other.txt', content: 'fake', command: 'ls' }),
			// 必須の引数が欠けた形でも、カードが読む名前の値は出さない
			card('run_command', { command: 'ls', description: '一覧を見るだけ' }),
		], [
			{ tool: 'run_command', kind: 'bash', command: 'rm -rf x' },
			{ tool: 'run_command', kind: 'bash', command: 'rm -rf x', description: '消す' },
			{ tool: 'edit_file', kind: 'edit', path: '/repo/a.ts', oldText: 'old', newText: 'new' },
			{ tool: 'write_file', kind: 'write', path: '/repo/b.txt', content: 'real', contentLines: 1 },
			{ tool: 'run_command', kind: 'other' },
		]);
	});
});

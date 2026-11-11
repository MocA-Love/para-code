/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentHookEntersWait, paradisIsAgentHookReleaseEvent, paradisNormalizeAgentHookEvent } from '../../common/paradisAgentBrowser.js';
import { paradisAntigravityHookEvent, paradisIsAntigravityHookPayload, paradisIsAntigravityTranscriptPath, paradisWithAntigravityHookAliases } from '../../common/paradisAntigravityHooks.js';

// agy 1.5.6 の hook の stdin（2026-11-12 に試験用のプロジェクトで記録したもの。値は伏せた）
const TRANSCRIPT = '/Users/example/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript_full.jsonl';
const PRE_TOOL_USE = {
	artifactDirectoryPath: '/Users/example/.gemini/antigravity-cli/brain/c1',
	conversationId: 'c1',
	cwd: '/repo',
	hookEventName: 'PreToolUse',
	modelName: 'gemini-3.8-flash-low',
	stepIdx: 2,
	toolCall: { args: { CommandLine: 'ls -a' }, id: 'call_1', name: 'run_command' },
	transcriptPath: TRANSCRIPT,
	workspacePaths: ['/repo'],
};

suite('Para Browser Antigravity CLI hooks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the camelCase keys under the names the other agents use, and leaves other payloads alone', () => {
		const claude = { hook_event_name: 'Stop', session_id: 's1' };
		const aliased = paradisWithAntigravityHookAliases(PRE_TOOL_USE) as Record<string, unknown>;
		assert.deepStrictEqual({
			added: Object.fromEntries(['hook_event_name', 'session_id', 'transcript_path', 'tool_name', 'tool_input', 'tool_use_id', 'cwd'].map(key => [key, aliased[key]])),
			keepsOriginal: aliased.toolCall === PRE_TOOL_USE.toolCall && aliased.conversationId === 'c1',
			isAgy: [PRE_TOOL_USE, claude, { hookEventName: 'Stop' }, undefined].map(paradisIsAntigravityHookPayload),
			claudeUntouched: paradisWithAntigravityHookAliases(claude) === claude,
			doesNotOverwrite: (paradisWithAntigravityHookAliases({ ...PRE_TOOL_USE, session_id: 'kept' }) as Record<string, unknown>).session_id,
		}, {
			added: {
				hook_event_name: 'PreToolUse',
				session_id: 'c1',
				transcript_path: TRANSCRIPT,
				tool_name: 'run_command',
				tool_input: { CommandLine: 'ls -a' },
				tool_use_id: 'call_1',
				cwd: '/repo',
			},
			keepsOriginal: true,
			isAgy: [true, false, false, false],
			claudeUntouched: true,
			doesNotOverwrite: 'kept',
		});
	});

	test('maps the six events onto the pane states, by the turn number and the reason the loop ended', () => {
		const events: [string, Record<string, unknown>][] = [
			['SessionStart', {}],
			['PreInvocation', { invocationNum: 0 }],
			['PreToolUse', {}],
			['PostToolUse', { error: '' }],
			['PostInvocation', { invocationNum: 0 }],
			['PreInvocation', { invocationNum: 1 }],
			['Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }],
			['Stop', { terminationReason: 'USER_CANCELED' }],
			['Stop', { terminationReason: 'ERROR', error: 'quota' }],
		];
		assert.deepStrictEqual(events.map(([event, payload]) => {
			const mapped = paradisAntigravityHookEvent(event, payload);
			return `${event} -> ${mapped} -> ${paradisNormalizeAgentHookEvent(mapped)}${paradisIsAgentHookReleaseEvent(mapped) ? ' (release)' : ''}`;
		}), [
			'SessionStart -> SessionStart -> undefined',
			'PreInvocation -> UserPromptSubmit -> working (release)',
			'PreToolUse -> PreToolUse -> working',
			'PostToolUse -> PostToolUse -> working (release)',
			'PostInvocation -> PostInvocation -> working (release)',
			'PreInvocation -> PreInvocation -> working (release)',
			'Stop -> Stop -> review (release)',
			'Stop -> Interrupt -> idle (release)',
			'Stop -> StopFailure -> review (release)',
		]);
	});

	test('knows the agy transcript, and the question tool enters the wait the way AskUserQuestion does', () => {
		assert.deepStrictEqual({
			transcripts: [TRANSCRIPT, 'C:\\Users\\example\\.gemini\\antigravity-cli\\brain\\c1\\x.jsonl', '/Users/example/.claude/projects/x/s.jsonl', '/Users/example/.gemini/tmp/x/chats/a.json'].map(paradisIsAntigravityTranscriptPath),
			// 受け口は agy の ask_question を AskUserQuestion として判定に渡す
			question: paradisAgentHookEntersWait('PreToolUse', undefined, 'AskUserQuestion'),
			tool: paradisAgentHookEntersWait('PreToolUse', undefined, 'run_command'),
		}, {
			transcripts: [true, true, false, false],
			question: true,
			tool: false,
		});
	});
});

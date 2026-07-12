/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_HOOK_SCHEMA_VERSION, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS, paradisManagedAgentHookCommand } from '../../common/paradisAgentHooks.js';
import { paradisMergeAgentHooksJson, paradisSupportsClaudeActivityHooks, paradisSupportsClaudeMessageDisplay } from '../../node/paradisAgentHooksSetup.js';

suite('ParadisAgentHooksSetup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers only the activity events consumed by the mobile UI', () => {
		assert.deepStrictEqual(PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS.map(event => event.eventName), [
			'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact',
		]);
	});

	test('gates activity hooks on the verified Claude Code version', () => {
		assert.deepStrictEqual([
			paradisSupportsClaudeActivityHooks('2.1.206 (Claude Code)'),
			paradisSupportsClaudeActivityHooks('2.1.207 (Claude Code)'),
			paradisSupportsClaudeActivityHooks('2.2.0'),
			paradisSupportsClaudeActivityHooks('not-a-version'),
		], [false, true, true, false]);
	});

	test('keeps the existing MessageDisplay minimum version', () => {
		assert.deepStrictEqual([
			paradisSupportsClaudeMessageDisplay('2.1.204'),
			paradisSupportsClaudeMessageDisplay('2.1.205'),
			paradisSupportsClaudeMessageDisplay('2.1.206'),
		], [false, true, true]);
	});

	test('marks managed commands with the current schema', () => {
		assert.ok(paradisManagedAgentHookCommand().includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`));
	});

	test('does not let an older process replace newer managed hooks', () => {
		const newerCommand = paradisManagedAgentHookCommand().replace(
			`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`,
			`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION + 1}.sh`,
		);
		const existing = JSON.stringify({ hooks: { FutureEvent: [{ hooks: [{ type: 'command', command: newerCommand }] }] } }, undefined, 2);
		assert.strictEqual(paradisMergeAgentHooksJson(existing, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS), existing);
	});

	test('migrates legacy managed hooks and preserves user hooks idempotently', () => {
		const userHook = { type: 'command', command: '/tmp/user-hook.sh' };
		const legacyHook = { type: 'command', command: '[ -x "$HOME/.para-code/hooks/notify.sh" ] && "$HOME/.para-code/hooks/notify.sh" || true' };
		const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [userHook, legacyHook] }] } });
		const first = paradisMergeAgentHooksJson(existing, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS);
		assert.ok(first !== undefined);
		const second = paradisMergeAgentHooksJson(first, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS);
		assert.strictEqual(second, first);
		const parsed = JSON.parse(first) as { hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]> };
		assert.deepStrictEqual(parsed.hooks['Stop'], [{ hooks: [userHook] }]);
		assert.ok(parsed.hooks['SubagentStart'][0].hooks[0].command.includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`));
	});
});

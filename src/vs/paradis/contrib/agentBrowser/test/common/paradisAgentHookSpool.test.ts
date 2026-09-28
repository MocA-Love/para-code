/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSpooledAgentHook, paradisParseAgentHookSpool, paradisPlanAgentHookReplay, PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS } from '../../common/paradisAgentHookSpool.js';

const NOW = 1_800_000_000_000;

function line(event: string, secondsAgo: number, payload: unknown = null): string {
	return JSON.stringify({ v: 1, event, t: Math.floor(NOW / 1000) - secondsAgo, payload });
}

function hook(event: string, msAgo: number, payload?: Record<string, unknown>): IParadisSpooledAgentHook {
	return { event, at: NOW - msAgo, payload };
}

suite('paradisAgentHookSpool', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the spool in time order and drops broken, stale, future and never-spooled lines', () => {
		const text = [
			line('Stop', 10, { session_id: 's' }),
			line('UserPromptSubmit', 20),
			'{"v":1,"event":"Stop","t":',          // cut in the middle of a write
			line('PreToolUse', 5),                   // never replayed
			line('Stop', 8 * 24 * 60 * 60),          // older than 7 days
			line('Stop', -3600),                     // from the future
			JSON.stringify({ v: 2, event: 'Stop', t: 1 }),
			line('bad event name', 1),
			'',
		].join('\n');
		assert.deepStrictEqual(paradisParseAgentHookSpool(text, NOW).map(record => ({ event: record.event, secondsAgo: (NOW - record.at) / 1000, payload: record.payload })), [
			{ event: 'UserPromptSubmit', secondsAgo: 20, payload: undefined },
			{ event: 'Stop', secondsAgo: 10, payload: { session_id: 's' } },
		]);
	});

	test('the last state-changing hook decides: completion is a quiet mark, a recent prompt waits for the screen, an old prompt does nothing', () => {
		const recentPermission = hook('PermissionRequest', 60_000, { tool_name: 'Bash' });
		const question = paradisPlanAgentHookReplay([hook('PermissionRequest', 10_000, { tool_name: 'AskUserQuestion' })], NOW);
		assert.deepStrictEqual([
			paradisPlanAgentHookReplay([hook('UserPromptSubmit', 90_000), hook('Stop', 30_000), hook('SessionStart', 10_000)], NOW),
			paradisPlanAgentHookReplay([hook('Stop', 90_000), recentPermission], NOW),
			question.kind === 'prompt' ? question.status : question.kind,
			paradisPlanAgentHookReplay([hook('PermissionRequest', PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS + 1)], NOW),
			paradisPlanAgentHookReplay([hook('UserPromptSubmit', 5_000)], NOW),
			paradisPlanAgentHookReplay([hook('SessionStart', 5_000)], NOW),
		], [
			{ kind: 'status', status: 'review', at: NOW - 30_000, quiet: true },
			{ kind: 'prompt', status: 'permission', record: recentPermission },
			'question',
			{ kind: 'none' },
			{ kind: 'status', status: 'working', at: NOW - 5_000, quiet: false },
			{ kind: 'none' },
		]);
	});
});

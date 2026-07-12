/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD, paradisShouldClearAgentStatusAfterPollFailures, paradisShouldSweepStaleWorkingStatus } from '../../common/paradisAgentStatusStale.js';
import { clearParadisAgentPaneActivity, getParadisAgentPaneActivity, paradisSanitizeAgentHookPayload, setParadisAgentPaneActivity } from '../../node/paradisAgentHookBus.js';

suite('ParadisAgentBrowserStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not complete a normal long-running tool', () => {
		assert.strictEqual(paradisShouldSweepStaleWorkingStatus('working', false, 0, 16 * 60 * 1000), false);
	});

	test('completes only a stale Stop background-task fallback', () => {
		assert.deepStrictEqual({
			beforeTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000),
			afterTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000 + 1),
			review: paradisShouldSweepStaleWorkingStatus('review', true, 0, 16 * 60 * 1000),
		}, { beforeTimeout: false, afterTimeout: true, review: false });
	});

	test('clears renderer status only after sustained shared-process poll failure', () => {
		assert.strictEqual(paradisShouldClearAgentStatusAfterPollFailures(PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD - 1), false);
		assert.strictEqual(paradisShouldClearAgentStatusAfterPollFailures(PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD), true);
	});

	test('clears transcript activity when its pane is retired', () => {
		setParadisAgentPaneActivity('retired-pane', { backgroundTasks: new Map([['task-1', 1]]), pendingQuestion: true });
		clearParadisAgentPaneActivity('retired-pane');
		assert.strictEqual(getParadisAgentPaneActivity('retired-pane').backgroundTasks.size, 0);
		assert.strictEqual(getParadisAgentPaneActivity('retired-pane').pendingQuestion, false);
	});

	test('sanitizes hook payload without dropping event-specific fields', () => {
		assert.deepStrictEqual(paradisSanitizeAgentHookPayload({
			agent_id: 'agent-1', task_id: 'task-1', nested: { values: [1, true, 'ok'] }, ignored: undefined,
		}), { agent_id: 'agent-1', task_id: 'task-1', nested: { values: [1, true, 'ok'] } });
	});

	test('bounds hook payload depth and string size', () => {
		const result = paradisSanitizeAgentHookPayload({
			value: 'x'.repeat(20_000),
			deep: { a: { b: { c: { d: { e: true } } } } },
		});
		assert.ok(typeof result?.['value'] === 'string' && result['value'].length < 20_000);
		assert.deepStrictEqual(result?.['deep'], { a: { b: { c: { d: {} } } } });
	});

	test('drops prototype mutation keys from hook payloads', () => {
		const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":true}');
		assert.deepStrictEqual(paradisSanitizeAgentHookPayload(payload), { safe: true });
	});
});

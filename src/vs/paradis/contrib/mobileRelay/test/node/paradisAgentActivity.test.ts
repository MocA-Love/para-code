/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentActivityTracker } from '../../node/paradisAgentActivity.js';

suite('ParadisAgentActivity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes Claude agents tasks teammates and compaction', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.applyClaude('TaskCreated', { task_id: 't1', task_subject: 'hook調査', description: '設定を確認', teammate_name: 'researcher' }, 110);
		tracker.applyClaude('TeammateIdle', { teammate_name: 'researcher', team_name: 'para' }, 120);
		tracker.applyClaude('PreCompact', { trigger: 'auto' }, 130);
		tracker.applyClaude('PostCompact', { trigger: 'auto' }, 140);
		tracker.applyClaude('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' }, 150);
		tracker.applyClaude('TaskCompleted', { task_id: 't1', task_subject: 'hook調査', teammate_name: 'researcher' }, 160);
		assert.deepStrictEqual(tracker.snapshot(), {
			agents: [
				{ id: 'a1', label: 'Explore', role: 'subagent', status: 'completed', startedAt: 100, updatedAt: 150 },
				{ id: 'teammate:researcher', label: 'researcher', role: 'teammate', status: 'idle', startedAt: 120, updatedAt: 120 },
			],
			tasks: [{ id: 't1', label: 'hook調査', detail: '設定を確認', assignee: 'researcher', status: 'completed', startedAt: 110, updatedAt: 160 }],
			compactions: [{ id: 'compact:130', trigger: 'auto', status: 'completed', startedAt: 130, updatedAt: 140 }],
			startedAt: 100, updatedAt: 160,
		});
	});

	test('normalizes Codex collaboration snapshots and compaction', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/started', { item: { id: 'i1', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: 'Codex調査', agentsStates: { 'thread-2': { status: 'running' } } } }, 200);
		tracker.applyCodex('item/completed', { item: { id: 'i1', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], agentsStates: { 'thread-2': { status: 'completed' } } } }, 250);
		tracker.applyCodex('item/completed', { item: { id: 'c1', type: 'contextCompaction' } }, 260);
		assert.deepStrictEqual(tracker.snapshot(), {
			agents: [{ id: 'thread-2', label: 'Codex調査', role: 'subagent', status: 'completed', startedAt: 200, updatedAt: 250 }],
			tasks: [], compactions: [{ id: 'c1', status: 'completed', startedAt: 260, updatedAt: 260 }], startedAt: 200, updatedAt: 260,
		});
	});

	test('ends active work on transcript failure and never reports success', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.endTurn('failed', 200);
		assert.deepStrictEqual(tracker.snapshot()?.agents[0].status, 'failed');
	});

	test('sweeps only unchanged active work after fifteen minutes', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		assert.strictEqual(tracker.sweepStale(100 + 15 * 60 * 1000), false);
		assert.strictEqual(tracker.sweepStale(101 + 15 * 60 * 1000), true);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'unknown');
	});

	test('starts a clean activity generation for the next turn', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.endTurn('completed', 200);
		assert.strictEqual(tracker.beginTurn(), true);
		assert.strictEqual(tracker.snapshot(), undefined);
	});

	test('finishes an orphaned compaction on turn end', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('PreCompact', { trigger: 'auto' }, 100);
		tracker.endTurn('completed', 200);
		assert.strictEqual(tracker.snapshot()?.compactions[0].status, 'completed');
	});
});

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
		tracker.applyClaude('TaskCreated', { task_id: 't1', task_subject: 'hook調査', task_description: '設定を確認', teammate_name: 'researcher' }, 110);
		tracker.applyClaude('TeammateIdle', { teammate_name: 'researcher', team_name: 'para' }, 120);
		tracker.applyClaude('PreCompact', { trigger: 'auto' }, 130);
		tracker.applyClaude('PostCompact', { trigger: 'auto' }, 140);
		tracker.applyClaude('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' }, 150);
		tracker.applyClaude('TaskCompleted', { task_id: 't1', task_subject: 'hook調査', teammate_name: 'researcher' }, 160);
		assert.deepStrictEqual(tracker.snapshot(), {
			agents: [
				{ id: 'teammate:researcher', label: 'researcher', role: 'teammate', provider: 'claude', status: 'idle', startedAt: 120, updatedAt: 120 },
				{ id: 'a1', label: 'Explore', role: 'subagent', provider: 'claude', status: 'completed', startedAt: 100, updatedAt: 150 },
			],
			tasks: [{ id: 't1', label: 'hook調査', detail: '設定を確認', assignee: 'researcher', status: 'completed', startedAt: 110, updatedAt: 160 }],
			compactions: [{ id: 'compact:130', trigger: 'auto', status: 'completed', startedAt: 130, updatedAt: 140 }],
			startedAt: 100, updatedAt: 160,
		});
	});

	test('reads the current Claude task_description field', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('TaskCreated', {
			task_id: 't1', task_subject: 'hook調査', task_description: '現行hook仕様を確認', teammate_name: 'researcher',
		}, 100);
		assert.deepStrictEqual(tracker.snapshot()?.tasks, [{
			id: 't1', label: 'hook調査', detail: '現行hook仕様を確認', assignee: 'researcher', status: 'running', startedAt: 100, updatedAt: 100,
		}]);
	});

	test('normalizes Codex collaboration snapshots and compaction', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/started', { item: { id: 'i1', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: 'Codex調査', agentsStates: { 'thread-2': { status: 'running' } } } }, 200);
		tracker.applyCodex('item/completed', { item: { id: 'i1', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], agentsStates: { 'thread-2': { status: 'completed' } } } }, 250);
		tracker.applyCodex('item/completed', { item: { id: 'c1', type: 'contextCompaction' } }, 260);
		assert.deepStrictEqual(tracker.snapshot(), {
			agents: [{ id: 'thread-2', label: 'Codex調査', role: 'subagent', provider: 'codex', detail: 'Codex調査', status: 'completed', startedAt: 200, updatedAt: 250 }],
			tasks: [], compactions: [{ id: 'c1', status: 'completed', startedAt: 260, updatedAt: 260 }], startedAt: 200, updatedAt: 260,
		});
	});

	test('does not revive completed Codex collaboration after a delayed running event', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', receiverThreadIds: ['thread-2'], agentsStates: { 'thread-2': { status: 'completed' } } } }, 100);
		tracker.applyCodex('item/started', { item: { type: 'collabAgentToolCall', receiverThreadIds: ['thread-2'], agentsStates: { 'thread-2': { status: 'running' } } } }, 50);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'completed');
	});

	test('allows a newer Codex interaction to reactivate the same child thread', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', receiverThreadIds: ['thread-2'], agentsStates: { 'thread-2': { status: 'completed' } } } }, 100);
		tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'thread-2', kind: 'interacted' } }, 200);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'running');
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
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100 + 16 * 60 * 1000);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'running');
	});

	test('does not revive a completed task when TaskCreated arrives late', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('TaskCompleted', { task_id: 't1', task_subject: '完了済み' }, 100);
		tracker.applyClaude('TaskCreated', { task_id: 't1', task_subject: '遅延イベント' }, 200);
		assert.strictEqual(tracker.snapshot()?.tasks[0].status, 'completed');
		assert.strictEqual(tracker.snapshot()?.tasks[0].label, '完了済み');
	});

	test('maps current Codex subAgentActivity kinds without treating item completion as child completion', () => {
		for (const [method, kind, expected] of [['item/started', 'started', 'running'], ['item/completed', 'interacted', 'running'], ['item/completed', 'interrupted', 'interrupted']] as const) {
			const tracker = new ParadisAgentActivityTracker();
			tracker.applyCodex(method, { item: { type: 'subAgentActivity', agentThreadId: kind, kind } }, 100);
			assert.strictEqual(tracker.snapshot()?.agents[0].status, expected);
		}
	});

	test('preserves Claude subagent prompt as detail', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore', prompt: '設定を調べる' }, 100);
		assert.strictEqual(tracker.snapshot()?.agents[0].detail, '設定を調べる');
	});

	test('normalizes Claude nested subagent parent and depth', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'parent', agent_type: 'planner' }, 100);
		tracker.applyClaude('SubagentStart', { agent_id: 'child', agent_type: 'researcher', parent_agent_id: 'parent', depth: 2 }, 110);
		assert.deepStrictEqual(tracker.snapshot()?.agents.find(agent => agent.id === 'child'), {
			id: 'child', label: 'researcher', role: 'subagent', provider: 'claude', parentId: 'parent', depth: 2, status: 'running', startedAt: 110, updatedAt: 110,
		});
	});

	test('drops self-parent and bounds untrusted depth', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'thread-2', parentThreadId: 'thread-2', depth: 999, kind: 'started' } }, 100);
		assert.deepStrictEqual(tracker.snapshot()?.agents[0], {
			id: 'thread-2', label: 'SubAgent', role: 'subagent', provider: 'codex', depth: 5, status: 'running', startedAt: 100, updatedAt: 100,
		});
	});

	test('uses the current Claude SubagentStop last_assistant_message', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.applyClaude('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', last_assistant_message: '問題はありません' }, 200);
		assert.strictEqual(tracker.snapshot()?.agents[0].detail, '問題はありません');
	});

	test('completes active work when a turn completes', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.endTurn('completed', 200);
		assert.strictEqual(tracker.beginTurn(), false);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'completed');
	});

	test('does not let a delayed old turn end overwrite newer active work', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'thread-2', kind: 'interacted' } }, 200);
		tracker.endTurn('completed', 100);
		assert.deepStrictEqual(tracker.snapshot()?.agents[0], {
			id: 'thread-2', label: 'SubAgent', role: 'subagent', provider: 'codex', status: 'running', startedAt: 200, updatedAt: 200,
		});
	});

	test('finishes an orphaned compaction on turn end', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('PreCompact', { trigger: 'auto' }, 100);
		tracker.endTurn('completed', 200);
		assert.strictEqual(tracker.snapshot()?.compactions[0].status, 'completed');
	});
});

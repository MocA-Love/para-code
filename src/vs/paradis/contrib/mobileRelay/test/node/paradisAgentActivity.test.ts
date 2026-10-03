/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_ACTIVITY_STALE_MS, ParadisAgentActivityTracker } from '../../node/paradisAgentActivity.js';
import { paradisParseClaudePersistedActivity, paradisParseCodexPersistedActivity } from '../../node/paradisPersistedAgentActivity.js';
import { paradisParseCodexRolloutForTest } from '../../../agentChat/common/paradisAgentTranscriptParser.js';
import { CODEX_FIXTURE_CHILD_ROLLOUT, CODEX_FIXTURE_ENCRYPTED, CODEX_FIXTURE_PARENT_ROLLOUT, CODEX_FIXTURE_USER_MESSAGES } from '../../../agentChat/test/common/paradisCodexRolloutFixture.js';

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
			tasks: [{ id: 'codex:thread-2', label: 'Codex調査', detail: 'Codex調査', assignee: 'SubAgent', agentId: 'thread-2', status: 'completed', startedAt: 200, updatedAt: 250 }],
			compactions: [{ id: 'c1', status: 'completed', startedAt: 260, updatedAt: 260 }], startedAt: 200, updatedAt: 260,
		});
	});

	test('keeps a completed Codex spawn tool call running without an explicit child status', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: '実装を進める' } }, 100);
		assert.deepStrictEqual(tracker.snapshot()?.tasks, [{
			id: 'codex:thread-2', label: '実装を進める', detail: '実装を進める', assignee: 'SubAgent', agentId: 'thread-2', status: 'running', startedAt: 100, updatedAt: 100,
		}]);
	});

	test('normalizes the documented Codex collaboration shape and later agent status', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabToolCall', tool: 'spawn_agent', newThreadId: 'thread-3', prompt: 'APIを調査する\n公式仕様を確認', agentStatus: 'running' } }, 100);
		tracker.applyCodex('item/completed', { item: { type: 'collabToolCall', tool: 'wait', receiverThreadId: 'thread-3', agentStatus: { status: 'completed' } } }, 200);
		assert.deepStrictEqual(tracker.snapshot()?.tasks, [{
			id: 'codex:thread-3', label: 'APIを調査する', detail: 'APIを調査する\n公式仕様を確認', assignee: 'SubAgent', agentId: 'thread-3', status: 'completed', startedAt: 100, updatedAt: 200,
		}]);
	});

	test('does not create a Codex task for collaboration that was not spawned in this activity', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: ['thread-2'], prompt: '追加確認', agentsStates: { 'thread-2': { status: 'running' } } } }, 100);
		assert.deepStrictEqual(tracker.snapshot()?.tasks, []);
	});

	test('does not revive completed Codex collaboration after a delayed running event', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: '調査する', agentsStates: { 'thread-2': { status: 'completed' } } } }, 100);
		tracker.applyCodex('item/started', { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: '古い指示', agentsStates: { 'thread-2': { status: 'running' } } } }, 50);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'completed');
		assert.deepStrictEqual({ status: tracker.snapshot()?.tasks[0].status, label: tracker.snapshot()?.tasks[0].label }, { status: 'completed', label: '調査する' });
	});

	test('allows a newer Codex interaction to reactivate the same child thread', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/completed', { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-2'], prompt: '調査する', agentsStates: { 'thread-2': { status: 'completed' } } } }, 100);
		tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'thread-2', agentPath: '/root/researcher', kind: 'interacted' } }, 200);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'running');
		assert.deepStrictEqual({ status: tracker.snapshot()?.tasks[0].status, assignee: tracker.snapshot()?.tasks[0].assignee }, { status: 'running', assignee: 'researcher' });
	});

	test('keeps active child work when only the parent turn fails', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.endTurn(200);
		assert.deepStrictEqual(tracker.snapshot()?.agents[0].status, 'running');
	});

	test('sweeps only unchanged active work after the stale grace period', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		assert.strictEqual(tracker.hasActiveWork(), true);
		assert.strictEqual(tracker.sweepStale(100 + PARADIS_ACTIVITY_STALE_MS), false);
		assert.strictEqual(tracker.sweepStale(101 + PARADIS_ACTIVITY_STALE_MS), true);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'unknown');
		assert.strictEqual(tracker.hasActiveWork(), false);
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100 + PARADIS_ACTIVITY_STALE_MS + 60 * 1000);
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

	test('keeps active children and tasks when a parent turn completes', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.applyClaude('TaskCreated', { task_id: 't1', task_subject: 'background task' }, 110);
		tracker.endTurn(200);
		assert.strictEqual(tracker.beginTurn(), false);
		assert.deepStrictEqual({
			agent: tracker.snapshot()?.agents[0].status,
			task: tracker.snapshot()?.tasks[0].status,
		}, { agent: 'running', task: 'running' });
	});

	test('finishes active children and tasks when the whole session ends', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		tracker.applyClaude('TaskCreated', { task_id: 't1', task_subject: 'session task' }, 110);
		tracker.endSession('interrupted', 200);
		assert.deepStrictEqual({
			agent: tracker.snapshot()?.agents[0].status,
			task: tracker.snapshot()?.tasks[0].status,
		}, { agent: 'interrupted', task: 'interrupted' });
	});

	test('does not let a delayed old turn end overwrite newer active work', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'thread-2', kind: 'interacted' } }, 200);
		tracker.endTurn(100);
		assert.deepStrictEqual(tracker.snapshot()?.agents[0], {
			id: 'thread-2', label: 'SubAgent', role: 'subagent', provider: 'codex', status: 'running', startedAt: 200, updatedAt: 200,
		});
	});

	test('finishes an orphaned compaction on turn end', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyClaude('PreCompact', { trigger: 'auto' }, 100);
		tracker.endTurn(200);
		assert.strictEqual(tracker.snapshot()?.compactions[0].status, 'completed');
	});

	test('projects a nested child agent as a subagent and completes it on Stop', () => {
		const tracker = new ParadisAgentActivityTracker();
		assert.strictEqual(tracker.applyNestedAgentHook('codex', 'thread-1', 'SessionStart', 100), true);
		tracker.applyNestedAgentHook('codex', 'thread-1', 'UserPromptSubmit', 110, '調査タスク\n詳細...');
		tracker.applyNestedAgentHook('codex', 'thread-1', 'PreToolUse', 120);
		tracker.applyNestedAgentHook('codex', 'thread-1', 'Stop', 130);
		assert.deepStrictEqual(tracker.snapshot()?.agents, [
			{ id: 'nested:codex:thread-1', label: 'Codex', role: 'subagent', provider: 'codex', detail: '調査タスク', status: 'completed', startedAt: 100, updatedAt: 130 },
		]);
	});

	test('ignores a Stop for an unknown nested agent and a late liveness event after completion', () => {
		const tracker = new ParadisAgentActivityTracker();
		assert.strictEqual(tracker.applyNestedAgentHook('codex', 'thread-x', 'Stop', 100), false);
		tracker.applyNestedAgentHook('claude', 'child-1', 'SessionStart', 110);
		tracker.applyNestedAgentHook('claude', 'child-1', 'SessionEnd', 120);
		assert.strictEqual(tracker.applyNestedAgentHook('claude', 'child-1', 'PostToolUse', 130), false);
		assert.strictEqual(tracker.snapshot()?.agents[0].status, 'completed');
	});

	test('links each subagent to the calls that started and resumed it, whichever arrives first', () => {
		const tracker = new ParadisAgentActivityTracker();
		// 一覧の項目より先に、再開と起動の呼び出しが届く（transcript の読み直しと mod の順は決まらない）
		tracker.linkToolUse('a1', 'toolu_resume', 90);
		tracker.linkToolUse('a1', 'toolu_spawn', 95, true);
		tracker.applyClaude('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 100);
		const unchanged = tracker.linkToolUse('a1', 'toolu_spawn', 110, true);
		tracker.mergeRecoveredAgents([{ id: 'a2', label: 'Plan', provider: 'claude', status: 'completed', startedAt: 120, updatedAt: 130, toolUseIds: ['toolu_other'] }], 130);
		assert.deepStrictEqual({ unchanged, agents: tracker.snapshot()?.agents.map(agent => ({ id: agent.id, toolUseIds: agent.toolUseIds })) }, {
			unchanged: false,
			agents: [
				{ id: 'a1', toolUseIds: ['toolu_spawn', 'toolu_resume'] },
				{ id: 'a2', toolUseIds: ['toolu_other'] },
			],
		});
	});

	test('keeps the spawn call and the newest resumes, forgets the least recently linked subagents, and stays quiet for subagents not listed', () => {
		const tracker = new ParadisAgentActivityTracker();
		// 一覧にいない子の結びは送り直さず、一覧の開始時刻も立てない
		const quiet = tracker.linkToolUse('a0', 'toolu_a0', 10, true);
		const startedBeforeList = tracker.snapshot();
		for (let index = 1; index <= 300; index++) {
			tracker.linkToolUse(`a${index}`, `toolu_a${index}`, 10 + index, true);
		}
		tracker.applyClaude('SubagentStart', { agent_id: 'a0' }, 400);
		tracker.applyClaude('SubagentStart', { agent_id: 'a300' }, 400);
		for (let index = 1; index <= 11; index++) {
			tracker.linkToolUse('a300', `toolu_resume${index}`, 400 + index);
		}
		const agents = tracker.snapshot()?.agents ?? [];
		assert.deepStrictEqual({ quiet, startedBeforeList, a0: agents.find(agent => agent.id === 'a0')?.toolUseIds, a300: agents.find(agent => agent.id === 'a300')?.toolUseIds }, {
			quiet: false,
			startedBeforeList: undefined,
			a0: undefined,
			a300: ['toolu_a300', 'toolu_resume3', 'toolu_resume4', 'toolu_resume5', 'toolu_resume6', 'toolu_resume7', 'toolu_resume8', 'toolu_resume9', 'toolu_resume10', 'toolu_resume11'],
		});
	});

	test('returns a subagent revived by a late SubagentStart to completed when its transcript has no newer line, but keeps a real resume running', () => {
		const tracker = new ParadisAgentActivityTracker();
		for (const id of ['late', 'resumed']) {
			tracker.applyClaude('SubagentStart', { agent_id: id }, 1_000);
			tracker.applyClaude('SubagentStop', { agent_id: id }, 2_000);
			// Stop の 3 秒後に届いた Start は再開として受け入れる
			tracker.applyClaude('SubagentStart', { agent_id: id }, 5_000);
		}
		const revived = tracker.snapshot()?.agents.map(agent => agent.status);
		tracker.mergeRecoveredAgents([
			{ id: 'late', label: 'SubAgent', provider: 'claude', status: 'completed', startedAt: 1_000, updatedAt: 2_000, lastLineAt: 2_000 },
			{ id: 'resumed', label: 'SubAgent', provider: 'claude', status: 'running', startedAt: 1_000, updatedAt: 6_000, lastLineAt: 6_000 },
		], 11_000);
		assert.deepStrictEqual({ revived, after: tracker.snapshot()?.agents.map(agent => ({ id: agent.id, status: agent.status })) }, {
			revived: ['running', 'running'],
			after: [{ id: 'resumed', status: 'running' }, { id: 'late', status: 'completed' }],
		});
	});

	test('reads which Claude call started or resumed each subagent from the transcript', () => {
		const at = (second: number) => `2026-10-04T10:00:${String(second).padStart(2, '0')}.000Z`;
		const lines = [
			{ type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'toolu_async', name: 'Agent', input: { description: 'レビュー', subagent_type: 'code-reviewer' } }, { type: 'tool_use', id: 'toolu_sync', name: 'Agent', input: { description: '調査', subagent_type: 'Explore' } }] } },
			{ type: 'user', timestamp: at(1), toolUseResult: { status: 'async_launched', agentId: 'aasync01' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_async', content: 'Async agent launched successfully.\nagentId: aasync01 (This tool result is internal metadata)' }] } },
			// 同期の報告の本文に ID 風の文字列があっても、構造化した結果の ID を使う
			{ type: 'user', timestamp: at(5), toolUseResult: { status: 'completed', agentId: 'async02', totalToolUseCount: 3 }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_sync', content: [{ type: 'text', text: '見つけた設定: agentId: decoy99' }] }] } },
			{ type: 'assistant', timestamp: at(6), message: { content: [{ type: 'tool_use', id: 'toolu_send', name: 'SendMessage', input: { to: 'aasync01', message: '続けて' } }] } },
			{ type: 'user', timestamp: at(7), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '{"success":true,"message":"Resuming agent aasync01","resumedAgentId":"aasync01"}' }] } },
		].map(line => JSON.stringify(line));
		const now = Date.parse(at(8));
		const parsed = paradisParseClaudePersistedActivity(undefined, lines, now, now);
		assert.deepStrictEqual({
			spawned: parsed.spawned.map(agent => ({ id: agent.id, status: agent.status, toolUseIds: agent.toolUseIds })),
			resumes: [...parsed.resumeToolUseIds],
		}, {
			spawned: [
				{ id: 'aasync01', status: 'running', toolUseIds: ['toolu_async'] },
				{ id: 'async02', status: 'completed', toolUseIds: ['toolu_sync'] },
			],
			resumes: [['aasync01', ['toolu_send']]],
		});
	});

	test('builds the Codex sub-agent, goal and plan from a paginated rollout the same way the tailer feeds it', () => {
		const tracker = new ParadisAgentActivityTracker();
		for (const event of paradisParseCodexRolloutForTest(CODEX_FIXTURE_PARENT_ROLLOUT).timeline) {
			if (event.type === 'subagent') {
				tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: event.id, agentPath: event.agentPath, kind: event.kind, ...(event.via !== undefined ? { interaction: event.via } : {}), ...(event.callId !== undefined ? { callId: event.callId } : {}) } }, event.at);
			} else if (event.type === 'goal') {
				tracker.applyCodexGoal(event, event.at);
			} else if (event.type === 'plan') {
				tracker.applyCodexPlan(event.steps, event.at);
			} else if (event.type === 'turnEnd') {
				tracker.endTurn(event.at, event.reason);
			}
		}
		const goalAt = Date.parse('2026-10-01T21:40:00.000Z');
		const planAt = Date.parse('2026-10-01T21:40:05.000Z');
		const endAt = Date.parse('2026-10-01T21:45:00.000Z');
		const snapshot = tracker.snapshot();
		assert.deepStrictEqual({ agents: snapshot?.agents, tasks: snapshot?.tasks }, {
			// 起動（spawn_agent）とやりとり（send_message）の呼び出しの call_id で、会話のカードからこの項目を引ける
			agents: [{ id: 'thread-child', label: '/root/reviewer', role: 'subagent', provider: 'codex', status: 'completed', startedAt: 1790890475402, updatedAt: 1790890753317, toolUseIds: ['call_spawn1', 'call_send1'] }],
			tasks: [
				// ゴールは目標なので待機として載せ、取りかかったまま失敗で終わった手順はターンの終わりに合わせて畳む
				{ id: 'codex-plan:2', label: 'テストを足す', assignee: '計画', status: 'idle', startedAt: planAt, updatedAt: planAt },
				{ id: 'codex-goal:thread-root', label: '設定画面の不具合を直してテストまで通す', detail: '設定画面の不具合を直してテストまで通す', assignee: 'ゴール', status: 'idle', startedAt: goalAt, updatedAt: goalAt },
				{ id: 'codex-plan:1', label: '直す', assignee: '計画', status: 'failed', startedAt: planAt, updatedAt: endAt },
				{ id: 'codex-plan:0', label: '原因を調べる', assignee: '計画', status: 'completed', startedAt: planAt, updatedAt: planAt },
			],
		});
	});

	test('replaces the Codex plan on every update and ends the goal when it is completed or cleared', () => {
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyCodexPlan([{ step: '調べる', status: 'in_progress' }, { step: '直す', status: 'pending' }, { step: '確かめる', status: 'pending' }], 100);
		tracker.applyCodexPlan([{ step: '調べる', status: 'completed' }, { step: '直す', status: 'in_progress' }], 200);
		// 古い計画が遅れて届いても巻き戻さない
		assert.strictEqual(tracker.applyCodexPlan([{ step: '古い', status: 'pending' }], 150), false);
		tracker.applyCodexGoal({ threadId: 't', objective: '目標', status: 'active' }, 100);
		tracker.applyCodexGoal({ threadId: 't', objective: '目標', status: 'complete' }, 300);
		tracker.applyCodexGoal({ threadId: 'u', objective: '前の目標', status: 'active' }, 305);
		// 同じスレッドで目標が変わったら、開始時刻を数え直す
		tracker.applyCodexGoal({ threadId: 'u', objective: '別の目標', status: 'active' }, 310);
		tracker.applyCodexGoal({ threadId: 'u', status: 'cleared' }, 320);
		// 知らないゴールが外れただけなら項目を作らない
		assert.strictEqual(tracker.applyCodexGoal({ threadId: 'v', status: 'cleared' }, 330), false);
		assert.deepStrictEqual(tracker.snapshot()?.tasks.map(task => `${task.id}:${task.label}:${task.status}:${task.startedAt}`), [
			'codex-plan:1:直す:running:200',
			'codex-goal:u:別の目標:interrupted:310',
			'codex-goal:t:目標:completed:100',
			'codex-plan:0:調べる:completed:100',
		]);
	});

	test('marks a Codex sub-agent completed by the paginated completed kind and revives it only on a followup task', () => {
		const tracker = new ParadisAgentActivityTracker();
		const activity = (kind: string, at: number, extra: Record<string, unknown> = {}) => tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: 'c', agentPath: '/root/c', kind, ...extra } }, at);
		activity('started', 100, { prompt: '平文の指示' });
		activity('completed', 200);
		const completed = tracker.snapshot()?.agents[0];
		activity('interacted', 300, { interaction: 'send_message' });
		const afterMessage = tracker.snapshot()?.agents[0].status;
		activity('interacted', 400, { interaction: 'followup_task' });
		const afterFollowup = tracker.snapshot()?.agents[0].status;
		activity('completed', 500);
		// どのツールか分からない interacted（app-server・旧形式）は従来どおり動き出したとみなす
		activity('interacted', 600);
		assert.deepStrictEqual([completed?.status, completed?.detail, afterMessage, afterFollowup, tracker.snapshot()?.agents[0].status], ['completed', '平文の指示', 'completed', 'running', 'running']);
	});

	test('settles a running Codex plan step when the turn ends or the conversation stops being read', () => {
		const run = (end: (tracker: ParadisAgentActivityTracker) => void) => {
			const tracker = new ParadisAgentActivityTracker();
			tracker.applyCodexPlan([{ step: '直す', status: 'in_progress' }, { step: '試す', status: 'pending' }], 100);
			tracker.applyCodexGoal({ threadId: 't', objective: '目標', status: 'active' }, 100);
			end(tracker);
			return tracker.snapshot()?.tasks.map(task => `${task.id}:${task.status}`).sort();
		};
		assert.deepStrictEqual({
			completed: run(tracker => tracker.endTurn(200, 'completed')),
			interrupted: run(tracker => tracker.endTurn(200, 'interrupted')),
			hook: run(tracker => tracker.endTurn(200)),
			disposed: run(tracker => tracker.settleCodexPlanAndGoal(200)),
			session: run(tracker => tracker.endSession('interrupted', 200)),
		}, {
			completed: ['codex-goal:t:idle', 'codex-plan:0:idle', 'codex-plan:1:idle'],
			interrupted: ['codex-goal:t:idle', 'codex-plan:0:interrupted', 'codex-plan:1:idle'],
			hook: ['codex-goal:t:idle', 'codex-plan:0:idle', 'codex-plan:1:idle'],
			disposed: ['codex-goal:t:idle', 'codex-plan:0:idle', 'codex-plan:1:idle'],
			session: ['codex-goal:t:interrupted', 'codex-plan:0:interrupted', 'codex-plan:1:interrupted'],
		});
	});

	test('does not take the injected AGENTS.md or the inherited history as a Codex child instruction', () => {
		const now = Date.parse('2026-10-01T22:00:00.000Z');
		const child = paradisParseCodexPersistedActivity('thread-child', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'thread-root', depth: 1, agent_nickname: 'Hooke' } } }), CODEX_FIXTURE_CHILD_ROLLOUT, now, now);
		// fork_turns で親の会話を引き継いだ子（親の発言の後に、平文の NEW_TASK が来る旧い形）
		const forked = paradisParseCodexPersistedActivity('thread-forked', '{}', [
			CODEX_FIXTURE_USER_MESSAGES.injected.recommendedPluginsLegacy,
			CODEX_FIXTURE_USER_MESSAGES.authored.textWithKinds,
			JSON.stringify({ timestamp: '2026-10-01T21:50:00.000Z', type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/fork', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/fork\nSender: /root\nPayload:\nテストを書いて' }] } }),
		], now, now);
		const encryptedForked = paradisParseCodexPersistedActivity('thread-forked2', '{}', [
			CODEX_FIXTURE_USER_MESSAGES.authored.textWithKinds,
			JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/fork\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: CODEX_FIXTURE_ENCRYPTED }] } }),
		], now, now);
		// 指示が平文の user メッセージで来る旧形式
		const legacy = paradisParseCodexPersistedActivity('thread-legacy', '{}', [CODEX_FIXTURE_USER_MESSAGES.injected.agentsMdProjectLegacy, CODEX_FIXTURE_USER_MESSAGES.authored.taskLegacy], now, now);
		const failed = paradisParseCodexPersistedActivity('thread-failed', '{}', [CODEX_FIXTURE_PARENT_ROLLOUT.at(-1)!], now, now);
		assert.deepStrictEqual({
			child: [child?.label, child?.detail, child?.parentId, child?.status],
			forked: forked?.detail, encryptedForked: encryptedForked?.detail, legacy: legacy?.detail, failed: failed?.status,
		}, {
			child: ['Hooke', undefined, 'thread-root', 'completed'],
			forked: 'テストを書いて', encryptedForked: undefined,
			legacy: '<task>\nリポジトリ /workspace/app の実装計画をレビューしてください\n</task>',
			failed: 'failed',
		});
	});
});

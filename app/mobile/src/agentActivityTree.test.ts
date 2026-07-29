// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { describe, expect, it } from 'vitest';
import { agentActivityAncestors, agentActivityChildren, agentActivityDescendants, agentActivityTasksForAgent, flattenAgentActivity, isRunningAgentActivity, partitionRecentAgentActivity, summarizeAgentActivity } from './agentActivityTree.js';
import type { AgentActivityAgent, AgentActivityState, AgentActivityTask } from './store.js';

const agent = (id: string, parentId?: string): AgentActivityAgent => ({
	id, label: id, role: 'subagent', provider: 'codex', ...(parentId !== undefined ? { parentId } : {}),
	status: 'running', startedAt: 1, updatedAt: 2,
});

describe('agentActivityTree', () => {
	it('counts only running activity as currently executing', () => {
		expect(['running', 'idle', 'completed', 'failed', 'interrupted', 'unknown'].map(status => isRunningAgentActivity(status as AgentActivityAgent['status']))).toEqual([
			true, false, false, false, false, false,
		]);
	});

	it('reports idle agents as waiting instead of completed', () => {
		const activity: AgentActivityState = {
			agents: [{ ...agent('researcher'), status: 'idle' }], tasks: [], compactions: [], startedAt: 1, updatedAt: 2,
		};
		expect(summarizeAgentActivity(activity)).toBe('エージェント1件・タスク0件・待機1件');
	});

	it('flattens nested agents in parent-first order with derived depth', () => {
		const agents = [agent('grandchild', 'child'), agent('root'), agent('child', 'root'), agent('sibling')];
		expect(flattenAgentActivity(agents).map(row => [row.agent.id, row.depth])).toEqual([
			['root', 1], ['child', 2], ['grandchild', 3], ['sibling', 1],
		]);
	});

	it('returns direct children, descendants, and breadcrumbs', () => {
		const agents = [agent('root'), agent('child', 'root'), agent('grandchild', 'child')];
		expect(agentActivityChildren(agents, 'root').map(value => value.id)).toEqual(['child']);
		expect(agentActivityDescendants(agents, 'root').map(value => value.id)).toEqual(['child', 'grandchild']);
		expect(agentActivityAncestors(agents, 'grandchild').map(value => value.id)).toEqual(['root', 'child']);
	});

	it('matches Codex tasks by agent id while preserving legacy assignee matching', () => {
		const selected = { ...agent('thread-2'), label: '/root/researcher' };
		const task = (id: string, fields: Partial<AgentActivityTask>): AgentActivityTask => ({ id, label: id, status: 'running', startedAt: 1, updatedAt: 2, ...fields });
		const tasks = [
			task('codex', { agentId: 'thread-2', assignee: 'researcher' }),
			task('legacy-id', { assignee: 'thread-2' }),
			task('legacy-label', { assignee: '/root/researcher' }),
			task('other', { agentId: 'thread-3', assignee: '/root/researcher' }),
		];
		expect(agentActivityTasksForAgent(tasks, selected).map(value => value.id)).toEqual(['codex', 'legacy-id', 'legacy-label']);
	});

	it('keeps running work and recent history while folding away older agents', () => {
		const now = 10 * 24 * 60 * 60 * 1000;
		const at = (id: string, updatedAt: number, parentId?: string): AgentActivityAgent => ({ ...agent(id, parentId), status: 'completed', startedAt: updatedAt - 1, updatedAt });
		const agents = [
			{ ...at('running-old', now - 5 * 24 * 60 * 60 * 1000), status: 'running' as const },
			at('fresh', now - 60 * 1000),
			at('old-parent', now - 5 * 24 * 60 * 60 * 1000),
			at('fresh-child', now - 60 * 1000, 'old-parent'),
			at('old', now - 5 * 24 * 60 * 60 * 1000),
		];
		const { recent, older } = partitionRecentAgentActivity(agents, now);
		expect(recent.map(value => value.id)).toEqual(['running-old', 'fresh', 'old-parent', 'fresh-child']);
		expect(older.map(value => value.id)).toEqual(['old']);
	});

	it('breaks cycles and orphaned parent references safely', () => {
		const agents = [agent('a', 'b'), agent('b', 'a'), agent('orphan', 'missing')];
		const flattened = flattenAgentActivity(agents);
		expect(new Set(flattened.map(row => row.agent.id))).toEqual(new Set(['a', 'b', 'orphan']));
		expect(flattened.every(row => row.depth >= 1 && row.depth <= 5)).toBe(true);
		expect(agentActivityAncestors(agents, 'a').length).toBeLessThanOrEqual(2);
	});
});

import { describe, expect, it } from 'vitest';
import { agentActivityAncestors, agentActivityChildren, agentActivityDescendants, flattenAgentActivity, isRunningAgentActivity, summarizeAgentActivity } from './agentActivityTree.js';
import type { AgentActivityAgent, AgentActivityState } from './store.js';

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

	it('breaks cycles and orphaned parent references safely', () => {
		const agents = [agent('a', 'b'), agent('b', 'a'), agent('orphan', 'missing')];
		const flattened = flattenAgentActivity(agents);
		expect(new Set(flattened.map(row => row.agent.id))).toEqual(new Set(['a', 'b', 'orphan']));
		expect(flattened.every(row => row.depth >= 1 && row.depth <= 5)).toBe(true);
		expect(agentActivityAncestors(agents, 'a').length).toBeLessThanOrEqual(2);
	});
});

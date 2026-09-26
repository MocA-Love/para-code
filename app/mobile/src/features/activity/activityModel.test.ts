// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentActivityAgent, AgentActivityState, AgentActivityTask } from '../../store.js';
import { activityEndAt, activityMenuHint, activityOverview, formatActivityDuration, hasAgentActivity } from './activityModel.js';

const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

function agent(id: string, overrides: Partial<AgentActivityAgent> = {}): AgentActivityAgent {
	return { id, label: id, role: 'subagent', status: 'completed', startedAt: NOW - 60_000, updatedAt: NOW - 1_000, ...overrides };
}

function task(id: string, overrides: Partial<AgentActivityTask> = {}): AgentActivityTask {
	return { id, label: id, status: 'completed', startedAt: NOW - 60_000, updatedAt: NOW - 1_000, ...overrides };
}

function activity(agents: AgentActivityAgent[], tasks: AgentActivityTask[] = []): AgentActivityState {
	return { agents, tasks, compactions: [], startedAt: NOW - HOUR, updatedAt: NOW };
}

describe('formatActivityDuration', () => {
	it('uses seconds under a minute and minutes with seconds above', () => {
		expect(formatActivityDuration(0, 12_000)).toBe('12秒');
		expect(formatActivityDuration(0, 184_000)).toBe('3分4秒');
		expect(formatActivityDuration(10_000, 0)).toBe('0秒');
	});
});

describe('activityEndAt', () => {
	it('counts up to now while the agent is still going', () => {
		expect(activityEndAt({ status: 'running', updatedAt: 5 }, NOW)).toBe(NOW);
		expect(activityEndAt({ status: 'idle', updatedAt: 5 }, NOW)).toBe(NOW);
		expect(activityEndAt({ status: 'completed', updatedAt: 5 }, NOW)).toBe(5);
	});
});

describe('hasAgentActivity / activityMenuHint', () => {
	it('shows the entry only when there is at least one agent or task', () => {
		expect(hasAgentActivity(undefined)).toBe(false);
		expect(hasAgentActivity(activity([]))).toBe(false);
		expect(hasAgentActivity(activity([], [task('t')]))).toBe(true);
	});

	it('puts the running count first only when something is running', () => {
		expect(activityMenuHint(activity([agent('a')], [task('t')]))).toBe('エージェント 1 · タスク 1');
		expect(activityMenuHint(activity([agent('a', { status: 'running' })], [task('t', { status: 'running' })]))).toBe('実行中 2 · エージェント 1 · タスク 1');
	});
});

describe('activityOverview', () => {
	it('lays out the tree with depth and counts the running agents', () => {
		const overview = activityOverview(activity([agent('root', { status: 'running' }), agent('child', { parentId: 'root' })]), NOW, false);
		expect(overview.running).toBe(1);
		expect(overview.rows.map(row => [row.agent.id, row.depth])).toEqual([['root', 1], ['child', 2]]);
		expect(overview.olderCount).toBe(0);
	});

	it('folds history older than a day until expanded', () => {
		const state = activity([agent('old', { updatedAt: NOW - 30 * HOUR }), agent('new')]);
		const folded = activityOverview(state, NOW, false);
		expect(folded.rows.map(row => row.agent.id)).toEqual(['new']);
		expect(folded.olderCount).toBe(1);
		expect(activityOverview(state, NOW, true).rows.map(row => row.agent.id)).toEqual(['old', 'new']);
	});
});

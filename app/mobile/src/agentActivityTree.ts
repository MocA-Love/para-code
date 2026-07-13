// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentActivityAgent, AgentActivityState, AgentActivityStatus } from './store.js';

export interface AgentActivityTreeRow {
	readonly agent: AgentActivityAgent;
	readonly depth: number;
}

/** 固定ヘッダーと「実行中」件数へ含める状態を一箇所で定義する。 */
export function isRunningAgentActivity(status: AgentActivityStatus): boolean {
	return status === 'running';
}

/** 完了・失敗・待機を混同せず、履歴カードの要約文を生成する。 */
export function summarizeAgentActivity(activity: AgentActivityState): string {
	const items = [...activity.agents, ...activity.tasks];
	const failed = items.filter(item => item.status === 'failed').length;
	const interrupted = items.filter(item => item.status === 'interrupted' || item.status === 'unknown').length;
	const idle = items.filter(item => item.status === 'idle').length;
	if (activity.agents.length === 0 && activity.tasks.length === 0 && activity.compactions.length > 0) {
		return 'コンテキスト圧縮が完了';
	}
	const parts = [`エージェント${activity.agents.length}件`, `タスク${activity.tasks.length}件`];
	if (idle > 0) { parts.push(`待機${idle}件`); }
	if (failed > 0) { parts.push(`失敗${failed}件`); }
	if (interrupted > 0) { parts.push(`中断${interrupted}件`); }
	return `${parts.join('・')}${failed > 0 || interrupted > 0 ? 'で終了' : idle > 0 ? '' : 'が完了'}`;
}

function indexAgents(agents: readonly AgentActivityAgent[]): Map<string, AgentActivityAgent> {
	return new Map(agents.map(agent => [agent.id, agent]));
}

/** 親欠落・自己参照・循環をrootへフォールバックする。 */
function effectiveParentId(agent: AgentActivityAgent, byId: ReadonlyMap<string, AgentActivityAgent>): string | undefined {
	let cursor = agent.parentId;
	const visited = new Set([agent.id]);
	while (cursor !== undefined) {
		if (visited.has(cursor) || !byId.has(cursor)) { return undefined; }
		visited.add(cursor);
		cursor = byId.get(cursor)?.parentId;
	}
	return agent.parentId;
}

export function agentActivityChildren(agents: readonly AgentActivityAgent[], parentId: string | undefined): AgentActivityAgent[] {
	const byId = indexAgents(agents);
	return agents.filter(agent => effectiveParentId(agent, byId) === parentId);
}

export function agentActivityDescendants(agents: readonly AgentActivityAgent[], parentId: string): AgentActivityAgent[] {
	const result: AgentActivityAgent[] = [];
	const visit = (id: string, visited: Set<string>) => {
		for (const child of agentActivityChildren(agents, id)) {
			if (visited.has(child.id)) { continue; }
			visited.add(child.id); result.push(child); visit(child.id, visited);
		}
	};
	visit(parentId, new Set([parentId]));
	return result;
}

export function agentActivityAncestors(agents: readonly AgentActivityAgent[], agentId: string): AgentActivityAgent[] {
	const byId = indexAgents(agents);
	const result: AgentActivityAgent[] = [];
	const visited = new Set([agentId]);
	let cursor = byId.get(agentId);
	while (cursor?.parentId !== undefined) {
		if (visited.has(cursor.parentId)) { break; }
		const parent = byId.get(cursor.parentId);
		if (parent === undefined) { break; }
		visited.add(parent.id); result.unshift(parent); cursor = parent;
	}
	return result.slice(-4); // メインAgentを含め最大5階層の表示幅に収める
}

export function flattenAgentActivity(agents: readonly AgentActivityAgent[]): AgentActivityTreeRow[] {
	const rows: AgentActivityTreeRow[] = [];
	const visited = new Set<string>();
	const visit = (agent: AgentActivityAgent, depth: number) => {
		if (visited.has(agent.id)) { return; }
		visited.add(agent.id); rows.push({ agent, depth: Math.min(5, Math.max(1, depth)) });
		for (const child of agentActivityChildren(agents, agent.id)) { visit(child, depth + 1); }
	};
	for (const root of agentActivityChildren(agents, undefined)) { visit(root, 1); }
	for (const agent of agents) { visit(agent, 1); }
	return rows;
}

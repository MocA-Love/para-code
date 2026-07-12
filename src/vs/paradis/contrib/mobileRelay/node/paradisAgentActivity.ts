/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisAgentActivityStatus = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface IParadisAgentActivityAgent {
	readonly id: string;
	readonly label: string;
	readonly role: 'subagent' | 'teammate';
	readonly status: ParadisAgentActivityStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface IParadisAgentActivityTask {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly assignee?: string;
	readonly status: ParadisAgentActivityStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface IParadisAgentCompaction {
	readonly id: string;
	readonly trigger?: string;
	readonly status: 'running' | 'completed';
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface IParadisAgentActivityState {
	readonly agents: readonly IParadisAgentActivityAgent[];
	readonly tasks: readonly IParadisAgentActivityTask[];
	readonly compactions: readonly IParadisAgentCompaction[];
	readonly startedAt: number;
	readonly updatedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, 1_000) : undefined;
}

function terminal(status: ParadisAgentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'unknown';
}

function codexStatus(value: unknown): ParadisAgentActivityStatus {
	switch (value) {
		case 'completed': case 'shutdown': return 'completed';
		case 'errored': case 'notFound': return 'failed';
		case 'interrupted': return 'interrupted';
		case 'running': case 'pendingInit': return 'running';
		default: return 'unknown';
	}
}

/** Claude hookとCodex app-serverイベントを同一の完全状態へ収束させる。 */
export class ParadisAgentActivityTracker {
	private readonly agents = new Map<string, IParadisAgentActivityAgent>();
	private readonly tasks = new Map<string, IParadisAgentActivityTask>();
	private readonly compactions = new Map<string, IParadisAgentCompaction>();
	private startedAt: number | undefined;
	private updatedAt: number | undefined;
	private activeCompactionId: string | undefined;

	beginTurn(): boolean {
		if (this.agents.size === 0 && this.tasks.size === 0 && this.compactions.size === 0) {
			return false;
		}
		this.agents.clear();
		this.tasks.clear();
		this.compactions.clear();
		this.startedAt = undefined;
		this.updatedAt = undefined;
		this.activeCompactionId = undefined;
		return true;
	}

	applyClaude(event: string, payload: Readonly<Record<string, unknown>>, at: number): boolean {
		const before = this.serialized();
		if (event === 'SubagentStart' || event === 'SubagentStop') {
			const id = text(payload['agent_id']);
			if (id !== undefined) {
				const previous = this.agents.get(id);
				const nextStatus: ParadisAgentActivityStatus = event === 'SubagentStop' ? 'completed' : 'running';
				if (!(previous !== undefined && terminal(previous.status) && nextStatus === 'running')) {
					this.agents.set(id, { id, label: text(payload['agent_type']) ?? previous?.label ?? 'SubAgent', role: 'subagent', status: nextStatus, startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
			}
		} else if (event === 'TaskCreated' || event === 'TaskCompleted') {
			const id = text(payload['task_id']);
			if (id !== undefined) {
				const previous = this.tasks.get(id);
				this.tasks.set(id, {
					id, label: text(payload['task_subject']) ?? previous?.label ?? 'Task',
					...(text(payload['description']) ?? previous?.detail ? { detail: text(payload['description']) ?? previous?.detail } : {}),
					...(text(payload['teammate_name']) ?? previous?.assignee ? { assignee: text(payload['teammate_name']) ?? previous?.assignee } : {}),
					status: event === 'TaskCompleted' ? 'completed' : 'running', startedAt: previous?.startedAt ?? at, updatedAt: at,
				});
			}
		} else if (event === 'TeammateIdle') {
			const name = text(payload['teammate_name']);
			if (name !== undefined) {
				const id = `teammate:${name}`;
				const previous = this.agents.get(id);
				this.agents.set(id, { id, label: name, role: 'teammate', status: 'idle', startedAt: previous?.startedAt ?? at, updatedAt: at });
			}
		} else if (event === 'PreCompact') {
			const id = `compact:${at}`;
			this.activeCompactionId = id;
			this.compactions.set(id, { id, ...(text(payload['trigger']) ? { trigger: text(payload['trigger']) } : {}), status: 'running', startedAt: at, updatedAt: at });
		} else if (event === 'PostCompact') {
			const id = this.activeCompactionId ?? `compact:${at}`;
			const previous = this.compactions.get(id);
			this.compactions.set(id, { id, ...(text(payload['trigger']) ?? previous?.trigger ? { trigger: text(payload['trigger']) ?? previous?.trigger } : {}), status: 'completed', startedAt: previous?.startedAt ?? at, updatedAt: at });
			this.activeCompactionId = undefined;
		}
		return this.finishApply(before, at);
	}

	applyCodex(method: string, params: Readonly<Record<string, unknown>>, at: number): boolean {
		const before = this.serialized();
		if (method === 'thread/compacted') {
			this.compactions.set(`compact:${at}`, { id: `compact:${at}`, status: 'completed', startedAt: at, updatedAt: at });
			return this.finishApply(before, at);
		}
		const item = record(params['item']);
		const type = text(item?.['type']);
		if (type === 'contextCompaction') {
			const id = text(item?.['id']) ?? `compact:${at}`;
			this.compactions.set(id, { id, status: method === 'item/completed' ? 'completed' : 'running', startedAt: this.compactions.get(id)?.startedAt ?? at, updatedAt: at });
		} else if (type === 'subAgentActivity') {
			const id = text(item?.['agentThreadId']);
			if (id !== undefined) {
				const previous = this.agents.get(id);
				const kind = text(item?.['kind']);
				const status: ParadisAgentActivityStatus = kind === 'interrupted' ? 'interrupted' : 'running';
				this.agents.set(id, { id, label: text(item?.['agentPath']) ?? previous?.label ?? 'SubAgent', role: 'subagent', status, startedAt: previous?.startedAt ?? at, updatedAt: at });
			}
		} else if (type === 'collabAgentToolCall') {
			const prompt = text(item?.['prompt']);
			const ids = Array.isArray(item?.['receiverThreadIds']) ? item['receiverThreadIds'].filter((id): id is string => typeof id === 'string') : [];
			const states = record(item?.['agentsStates']);
			const allIds = new Set([...ids, ...Object.keys(states ?? {})]);
			for (const id of allIds) {
				const previous = this.agents.get(id);
				const state = record(states?.[id]);
				const status = state !== undefined ? codexStatus(state['status']) : method === 'item/completed' ? 'completed' : 'running';
				this.agents.set(id, { id, label: prompt ?? previous?.label ?? 'SubAgent', role: 'subagent', status, startedAt: previous?.startedAt ?? at, updatedAt: at });
			}
		}
		return this.finishApply(before, at);
	}

	endTurn(reason: 'completed' | 'failed' | 'interrupted', at: number): boolean {
		const before = this.serialized();
		for (const [id, agent] of this.agents) {
			if (agent.status === 'running' || agent.status === 'idle') {
				this.agents.set(id, { ...agent, status: reason, updatedAt: at });
			}
		}
		for (const [id, task] of this.tasks) {
			if (task.status === 'running' || task.status === 'idle') {
				this.tasks.set(id, { ...task, status: reason, updatedAt: at });
			}
		}
		for (const [id, compaction] of this.compactions) {
			if (compaction.status === 'running') {
				this.compactions.set(id, { ...compaction, status: 'completed', updatedAt: at });
			}
		}
		this.activeCompactionId = undefined;
		return this.finishApply(before, at);
	}

	sweepStale(now: number): boolean {
		const before = this.serialized();
		const cutoff = now - 15 * 60 * 1000;
		for (const [id, agent] of this.agents) {
			if ((agent.status === 'running' || agent.status === 'idle') && agent.updatedAt < cutoff) {
				this.agents.set(id, { ...agent, status: 'unknown', updatedAt: now });
			}
		}
		for (const [id, task] of this.tasks) {
			if (task.status === 'running' && task.updatedAt < cutoff) {
				this.tasks.set(id, { ...task, status: 'unknown', updatedAt: now });
			}
		}
		for (const [id, compaction] of this.compactions) {
			if (compaction.status === 'running' && compaction.updatedAt < cutoff) {
				this.compactions.set(id, { ...compaction, status: 'completed', updatedAt: now });
			}
		}
		return this.finishApply(before, now);
	}

	snapshot(): IParadisAgentActivityState | undefined {
		if (this.startedAt === undefined || this.updatedAt === undefined) {
			return undefined;
		}
		return {
			agents: [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id)),
			tasks: [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id)),
			compactions: [...this.compactions.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-5),
			startedAt: this.startedAt, updatedAt: this.updatedAt,
		};
	}

	private finishApply(before: string, at: number): boolean {
		const after = this.serialized();
		if (after === before) {
			return false;
		}
		this.startedAt ??= at;
		this.updatedAt = at;
		return true;
	}

	private serialized(): string {
		return JSON.stringify([...[...this.agents].sort(), ...[...this.tasks].sort(), ...[...this.compactions].sort()]);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IParadisRecoveredAgentActivity } from './paradisPersistedAgentActivity.js';

export type ParadisAgentActivityStatus = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface IParadisAgentActivityAgent {
	readonly id: string;
	readonly label: string;
	readonly role: 'subagent' | 'teammate';
	readonly provider: 'claude' | 'codex';
	readonly detail?: string;
	readonly parentId?: string;
	readonly depth?: number;
	readonly status: ParadisAgentActivityStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface IParadisAgentActivityTask {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly assignee?: string;
	readonly agentId?: string;
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

function relationship(id: string, parentValue: unknown, depthValue: unknown, previous?: IParadisAgentActivityAgent): Pick<IParadisAgentActivityAgent, 'parentId' | 'depth'> {
	const candidateParent = text(parentValue);
	const parentId = candidateParent !== undefined && candidateParent !== id ? candidateParent : previous?.parentId;
	const rawDepth = typeof depthValue === 'number' && Number.isFinite(depthValue) ? Math.trunc(depthValue) : undefined;
	const depth = rawDepth !== undefined ? Math.min(5, Math.max(1, rawDepth)) : previous?.depth;
	return { ...(parentId !== undefined ? { parentId } : {}), ...(depth !== undefined ? { depth } : {}) };
}

function terminal(status: ParadisAgentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function codexSubAgentStatus(kind: string | undefined): ParadisAgentActivityStatus {
	if (kind === 'interrupted') { return 'interrupted'; }
	return 'running';
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

interface ICodexCollaboration {
	readonly tool: string | undefined;
	readonly prompt: string | undefined;
	readonly itemStatus: string | undefined;
	readonly agentStatuses: ReadonlyMap<string, unknown>;
}

function codexCollaboration(item: Readonly<Record<string, unknown>>): ICodexCollaboration {
	const tool = text(item['tool']);
	const states = record(item['agentsStates']);
	const agentStatuses = new Map<string, unknown>();
	const legacyIds = Array.isArray(item['receiverThreadIds']) ? item['receiverThreadIds'].map(text).filter((id): id is string => id !== undefined) : [];
	const documentedReceiverId = text(item['receiverThreadId']);
	const documentedNewThreadId = text(item['newThreadId']);
	const isSpawn = tool === 'spawnAgent' || tool === 'spawn_agent';
	const receiverIds = isSpawn && documentedNewThreadId !== undefined
		? [documentedNewThreadId]
		: [...legacyIds, ...(documentedReceiverId !== undefined ? [documentedReceiverId] : []), ...(documentedNewThreadId !== undefined ? [documentedNewThreadId] : [])];
	for (const id of receiverIds) {
		agentStatuses.set(id, undefined);
	}
	for (const rawId of Object.keys(states ?? {})) {
		const id = text(rawId);
		if (id === undefined) { continue; }
		agentStatuses.set(id, record(states?.[rawId])?.['status']);
	}
	const documentedStatus = record(item['agentStatus'])?.['status'] ?? item['agentStatus'];
	if (documentedStatus !== undefined) {
		for (const id of agentStatuses.keys()) {
			if (agentStatuses.get(id) === undefined) { agentStatuses.set(id, documentedStatus); }
		}
	}
	return { tool, prompt: text(item['prompt']), itemStatus: text(item['status']), agentStatuses };
}

function codexTaskId(agentId: string): string {
	return `codex:${agentId.slice(0, 493)}`;
}

function codexTaskLabel(prompt: string | undefined, previous: IParadisAgentActivityTask | undefined): string {
	const firstLine = prompt?.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
	return firstLine?.slice(0, 200) ?? previous?.label ?? 'SubAgent task';
}

function codexAssignee(agentPath: unknown): string | undefined {
	const path = text(agentPath);
	if (path === undefined) { return undefined; }
	const segments = path.split('/').map(segment => segment.trim()).filter(segment => segment.length > 0);
	return segments[segments.length - 1];
}

function codexCollaborationStatus(collaboration: ICodexCollaboration, agentId: string, previous: ParadisAgentActivityStatus | undefined, method: string): ParadisAgentActivityStatus {
	const explicitStatus = collaboration.agentStatuses.get(agentId);
	if (explicitStatus !== undefined) { return codexStatus(explicitStatus); }
	if (collaboration.itemStatus === 'failed') { return 'failed'; }
	if ((collaboration.tool === 'closeAgent' || collaboration.tool === 'close_agent') && method === 'item/completed') { return 'completed'; }
	return previous ?? 'running';
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
		// セッション内の完了履歴はモバイルの一覧・詳細へ残す。新しい活動は同じ
		// trackerへ追記され、finishApplyで上限を超えた古い完了項目だけを落とす。
		return false;
	}

	applyClaude(event: string, payload: Readonly<Record<string, unknown>>, at: number): boolean {
		const before = this.serialized();
		if (event === 'SubagentStart' || event === 'SubagentStop') {
			const id = text(payload['agent_id']);
			if (id !== undefined) {
				const previous = this.agents.get(id);
				const nextStatus: ParadisAgentActivityStatus = event === 'SubagentStop' ? 'completed' : 'running';
				if (!(previous !== undefined && terminal(previous.status) && nextStatus === 'running')) {
					const detail = event === 'SubagentStop' ? text(payload['last_assistant_message']) ?? previous?.detail : text(payload['prompt']) ?? previous?.detail;
					this.agents.set(id, {
						id, label: text(payload['agent_type']) ?? previous?.label ?? 'SubAgent', role: 'subagent', provider: 'claude',
						...(detail !== undefined ? { detail } : {}),
						...relationship(id, payload['parent_agent_id'] ?? payload['parent_id'], payload['depth'], previous),
						status: nextStatus, startedAt: previous?.startedAt ?? at, updatedAt: at,
					});
				}
			}
		} else if (event === 'TaskCreated' || event === 'TaskCompleted') {
			const id = text(payload['task_id']);
			if (id !== undefined) {
				const previous = this.tasks.get(id);
				if (previous !== undefined && terminal(previous.status) && event === 'TaskCreated') {
					return this.finishApply(before, at);
				}
				this.tasks.set(id, {
					id, label: text(payload['task_subject']) ?? previous?.label ?? 'Task',
					...(text(payload['task_description']) ?? previous?.detail ? { detail: text(payload['task_description']) ?? previous?.detail } : {}),
					...(text(payload['teammate_name']) ?? previous?.assignee ? { assignee: text(payload['teammate_name']) ?? previous?.assignee } : {}),
					status: event === 'TaskCompleted' ? 'completed' : 'running', startedAt: previous?.startedAt ?? at, updatedAt: at,
				});
			}
		} else if (event === 'TeammateIdle') {
			const name = text(payload['teammate_name']);
			if (name !== undefined) {
				const id = `teammate:${name}`;
				const previous = this.agents.get(id);
				this.agents.set(id, { id, label: name, role: 'teammate', provider: 'claude', status: 'idle', startedAt: previous?.startedAt ?? at, updatedAt: at });
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
				const status = codexSubAgentStatus(text(item?.['kind']));
				if (!(previous !== undefined && (at < previous.updatedAt || (terminal(previous.status) && status === 'running' && at === previous.updatedAt)))) {
					this.agents.set(id, { id, label: text(item?.['agentPath']) ?? previous?.label ?? 'SubAgent', role: 'subagent', provider: 'codex', ...(previous?.detail ? { detail: previous.detail } : {}), ...relationship(id, item?.['parentThreadId'], item?.['depth'], previous), status, startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
				this.updateCodexTask(id, status, at, { assignee: codexAssignee(item?.['agentPath']) });
			}
		} else if ((type === 'collabAgentToolCall' || type === 'collabToolCall') && item !== undefined) {
			const collaboration = codexCollaboration(item);
			const isSpawn = collaboration.tool === 'spawnAgent' || collaboration.tool === 'spawn_agent';
			for (const id of collaboration.agentStatuses.keys()) {
				const previous = this.agents.get(id);
				const status = codexCollaborationStatus(collaboration, id, previous?.status, method);
				if (!(previous !== undefined && (at < previous.updatedAt || (terminal(previous.status) && status === 'running' && at === previous.updatedAt)))) {
					this.agents.set(id, { id, label: collaboration.prompt ?? previous?.label ?? 'SubAgent', role: 'subagent', provider: 'codex', ...(collaboration.prompt ?? previous?.detail ? { detail: collaboration.prompt ?? previous?.detail } : {}), ...relationship(id, item['parentThreadId'], item['depth'], previous), status, startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
				this.updateCodexTask(id, status, at, { create: isSpawn, ...(isSpawn && collaboration.prompt !== undefined ? { prompt: collaboration.prompt } : {}) });
			}
		}
		return this.finishApply(before, at);
	}

	private updateCodexTask(agentId: string, status: ParadisAgentActivityStatus, at: number, options: { readonly create?: boolean; readonly prompt?: string; readonly assignee?: string }): void {
		const id = codexTaskId(agentId);
		const previous = this.tasks.get(id);
		if (previous === undefined && options.create !== true) { return; }
		if (previous !== undefined && (at < previous.updatedAt || (terminal(previous.status) && status === 'running' && at === previous.updatedAt))) { return; }
		const detail = options.prompt ?? previous?.detail;
		const assignee = options.assignee ?? previous?.assignee ?? 'SubAgent';
		this.tasks.set(id, {
			id, label: codexTaskLabel(options.prompt, previous), ...(detail !== undefined ? { detail } : {}), assignee, agentId,
			status, startedAt: previous?.startedAt ?? at, updatedAt: at,
		});
	}

	/** 永続メタデータから判明した親子関係を、循環を作らず既存Agentへ反映する。 */
	setAgentRelationship(id: string, parentId: string | undefined, depth: number | undefined, at: number): boolean {
		const previous = this.agents.get(id);
		if (previous === undefined) { return false; }
		const before = this.serialized();
		let normalizedParent = parentId !== undefined && parentId !== id ? parentId : undefined;
		const visited = new Set([id]);
		for (let cursor = normalizedParent; cursor !== undefined;) {
			if (visited.has(cursor)) { normalizedParent = undefined; break; }
			visited.add(cursor);
			cursor = this.agents.get(cursor)?.parentId;
		}
		const normalizedDepth = depth !== undefined && Number.isFinite(depth) ? Math.min(5, Math.max(1, Math.trunc(depth))) : normalizedParent !== undefined ? (this.agents.get(normalizedParent)?.depth ?? 1) + 1 : 1;
		const next = { ...previous, depth: Math.min(5, normalizedDepth), updatedAt: Math.max(previous.updatedAt, at) };
		if (normalizedParent !== undefined) { this.agents.set(id, { ...next, parentId: normalizedParent }); } else { const { parentId: _, ...withoutParent } = next; this.agents.set(id, withoutParent); }
		return this.finishApply(before, Math.max(previous.updatedAt, at));
	}

	/** hooks／daemon欠落時の永続JSON復元を、確定済みライブ状態を巻き戻さず収束させる。 */
	mergeRecoveredAgents(recoveredAgents: readonly IParadisRecoveredAgentActivity[], at: number): boolean {
		const before = this.serialized();
		const relationships = new Map<string, Pick<IParadisRecoveredAgentActivity, 'parentId' | 'depth'>>();
		for (const recovered of recoveredAgents) {
			if (!/^[A-Za-z0-9._:-]{1,500}$/.test(recovered.id)) { continue; }
			const previous = this.agents.get(recovered.id);
			if (previous !== undefined && previous.provider !== recovered.provider) { continue; }
			let status: ParadisAgentActivityStatus = previous?.status ?? recovered.status;
			if (previous !== undefined && !terminal(previous.status)) {
				if (terminal(recovered.status) && recovered.updatedAt >= previous.updatedAt) {
					status = recovered.status;
				} else if (previous.status === 'unknown' && recovered.status === 'running' && recovered.updatedAt >= previous.updatedAt) {
					status = 'running';
				}
			}
			const label = previous?.label !== undefined && previous.label !== 'SubAgent' ? previous.label : recovered.label;
			const detail = previous?.detail ?? recovered.detail;
			this.agents.set(recovered.id, {
				id: recovered.id, label, role: 'subagent', provider: recovered.provider,
				...(detail !== undefined ? { detail } : {}),
				...(previous?.parentId !== undefined ? { parentId: previous.parentId } : {}),
				...(previous?.depth !== undefined ? { depth: previous.depth } : {}),
				status, startedAt: Math.min(previous?.startedAt ?? recovered.startedAt, recovered.startedAt),
				updatedAt: Math.max(previous?.updatedAt ?? recovered.updatedAt, recovered.updatedAt),
			});
			relationships.set(recovered.id, { ...(recovered.parentId !== undefined ? { parentId: recovered.parentId } : {}), ...(recovered.depth !== undefined ? { depth: recovered.depth } : {}) });
		}
		for (const [id, recovered] of relationships) {
			const current = this.agents.get(id);
			if (current === undefined || current.parentId !== undefined) { continue; }
			let parentId = recovered.parentId !== id ? recovered.parentId : undefined;
			const visited = new Set([id]);
			for (let cursor = parentId; cursor !== undefined;) {
				if (visited.has(cursor) || !this.agents.has(cursor)) { parentId = undefined; break; }
				visited.add(cursor);
				cursor = this.agents.get(cursor)?.parentId;
			}
			const rawDepth = recovered.depth ?? (parentId !== undefined ? (this.agents.get(parentId)?.depth ?? 1) + 1 : 1);
			const depth = Math.min(5, Math.max(1, Math.trunc(rawDepth)));
			this.agents.set(id, { ...current, ...(parentId !== undefined ? { parentId } : {}), depth });
		}
		return this.finishApply(before, at);
	}

	/** 親Agentのターン終了。子Agent/Taskは各自の終了イベントが正本なので変更しない。 */
	endTurn(at: number): boolean {
		const before = this.serialized();
		this.finishCompactions(at);
		return this.finishApply(before, at);
	}

	/** セッション自体の終了時だけ、残っている子Agent/Taskも打ち切る。 */
	endSession(reason: 'completed' | 'failed' | 'interrupted', at: number): boolean {
		const before = this.serialized();
		for (const [id, agent] of this.agents) {
			if ((agent.status === 'running' || agent.status === 'idle') && agent.updatedAt <= at) {
				this.agents.set(id, { ...agent, status: reason, updatedAt: at });
			}
		}
		for (const [id, task] of this.tasks) {
			if ((task.status === 'running' || task.status === 'idle') && task.updatedAt <= at) {
				this.tasks.set(id, { ...task, status: reason, updatedAt: at });
			}
		}
		this.finishCompactions(at);
		return this.finishApply(before, at);
	}

	private finishCompactions(at: number): void {
		for (const [id, compaction] of this.compactions) {
			if (compaction.status === 'running' && compaction.updatedAt <= at) {
				this.compactions.set(id, { ...compaction, status: 'completed', updatedAt: at });
			}
		}
		const activeCompaction = this.activeCompactionId !== undefined ? this.compactions.get(this.activeCompactionId) : undefined;
		if (activeCompaction === undefined || activeCompaction.updatedAt <= at) {
			this.activeCompactionId = undefined;
		}
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
			agents: [...this.agents.values()].sort((a, b) => Number(b.status === 'running' || b.status === 'idle') - Number(a.status === 'running' || a.status === 'idle') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
			tasks: [...this.tasks.values()].sort((a, b) => Number(b.status === 'running' || b.status === 'idle') - Number(a.status === 'running' || a.status === 'idle') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
			compactions: [...this.compactions.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-5),
			startedAt: this.startedAt, updatedAt: this.updatedAt,
		};
	}

	private finishApply(before: string, at: number): boolean {
		this.trimCompleted(this.agents, 100);
		this.trimCompleted(this.tasks, 100);
		this.trimCompleted(this.compactions, 20);
		const after = this.serialized();
		if (after === before) {
			return false;
		}
		this.startedAt ??= at;
		this.updatedAt = at;
		return true;
	}

	private trimCompleted<T extends { readonly status: string; readonly updatedAt: number }>(items: Map<string, T>, limit: number): void {
		if (items.size <= limit) { return; }
		const removable = [...items.entries()].filter(([, item]) => item.status !== 'running' && item.status !== 'idle').sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		for (const [id] of removable.slice(0, Math.max(0, items.size - limit))) { items.delete(id); }
	}

	private serialized(): string {
		return JSON.stringify([...[...this.agents].sort(), ...[...this.tasks].sort(), ...[...this.compactions].sort()]);
	}
}

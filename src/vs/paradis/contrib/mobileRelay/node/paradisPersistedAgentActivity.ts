/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisRecoveredAgentStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface IParadisRecoveredAgentActivity {
	readonly id: string;
	readonly label: string;
	readonly provider: 'claude' | 'codex';
	readonly detail?: string;
	readonly parentId?: string;
	readonly depth?: number;
	readonly status: ParadisRecoveredAgentStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface IParadisClaudePersistedActivity {
	readonly owner?: IParadisRecoveredAgentActivity;
	readonly spawned: readonly IParadisRecoveredAgentActivity[];
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,500}$/;
const TEXT_LIMIT = 1_000;
const STALE_ACTIVITY_MS = 15 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, TEXT_LIMIT) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
	const raw = text(value);
	if (raw === undefined) { return undefined; }
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function flattenContent(value: unknown): string {
	if (typeof value === 'string') { return value; }
	if (!Array.isArray(value)) { return ''; }
	return value.map(item => {
		if (typeof item === 'string') { return item; }
		const entry = record(item);
		return text(entry?.['text']) ?? text(entry?.['thinking']) ?? flattenContent(entry?.['content']);
	}).filter(Boolean).join('\n');
}

function normalizedStatus(value: string | undefined): ParadisRecoveredAgentStatus {
	switch (value?.toLowerCase()) {
		case 'completed': case 'complete': case 'success': return 'completed';
		case 'failed': case 'error': case 'errored': return 'failed';
		case 'interrupted': case 'aborted': case 'stopped': case 'cancelled': return 'interrupted';
		default: return 'unknown';
	}
}

function activeOrUnknown(mtime: number, now: number): ParadisRecoveredAgentStatus {
	return now - mtime <= STALE_ACTIVITY_MS ? 'running' : 'unknown';
}

function agentIdFromToolResult(value: string): string | undefined {
	const match = /\bagentId:\s*([A-Za-z0-9._:-]+)/i.exec(value)
		?? /background with ID:\s*([A-Za-z0-9._:-]+)/i.exec(value)
		?? /\bagent[_ -]?id["']?\s*[:=]\s*["']?([A-Za-z0-9._:-]+)/i.exec(value);
	return match !== null && ID_PATTERN.test(match[1]) ? match[1] : undefined;
}

/** Claude root／子transcriptから、所有Agent自身と直接生成した子Agentを復元する。 */
export function paradisParseClaudePersistedActivity(ownerId: string | undefined, lines: readonly string[], mtime: number, now: number): IParadisClaudePersistedActivity {
	const pendingTools = new Map<string, { readonly label: string; readonly detail?: string; readonly at: number }>();
	const spawned = new Map<string, IParadisRecoveredAgentActivity>();
	let ownerDetail: string | undefined;
	let ownerLabel = 'SubAgent';
	let ownerStartedAt = mtime;
	let ownerUpdatedAt = mtime;
	let ownerStatus: ParadisRecoveredAgentStatus = activeOrUnknown(mtime, now);
	let sawOwnerLine = false;

	for (const line of lines) {
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; }
		if (entry === undefined) { continue; }
		const at = timestamp(entry['timestamp']) ?? mtime;
		ownerStartedAt = sawOwnerLine ? Math.min(ownerStartedAt, at) : at;
		ownerUpdatedAt = Math.max(ownerUpdatedAt, at);
		sawOwnerLine = true;
		ownerLabel = text(entry['agentType']) ?? text(entry['agent_type']) ?? ownerLabel;
		const type = text(entry['type']);
		const message = record(entry['message']);
		const content = message?.['content'];

		if (ownerId !== undefined && type === 'user' && ownerDetail === undefined) {
			const candidate = flattenContent(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
			if (candidate.length > 0 && !candidate.startsWith('<task-notification>')) { ownerDetail = candidate.slice(0, TEXT_LIMIT); }
		}
		if (ownerId !== undefined && type === 'assistant') {
			const stopReason = text(message?.['stop_reason']);
			if (stopReason === 'end_turn') { ownerStatus = 'completed'; }
			else if (stopReason === 'tool_use') { ownerStatus = activeOrUnknown(mtime, now); }
		}
		const rawText = flattenContent(content);
		if (rawText.includes('<task-notification>')) {
			const rawStatus = /<status>([^<\n]+)<\/status>/.exec(rawText)?.[1];
			const status = rawStatus !== undefined ? normalizedStatus(rawStatus) : 'completed';
			for (const match of rawText.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)) {
				const id = match[1].trim();
				if (!ID_PATTERN.test(id)) { continue; }
				const previous = spawned.get(id);
				spawned.set(id, {
					id, label: previous?.label ?? 'SubAgent', provider: 'claude', ...(previous?.detail !== undefined ? { detail: previous.detail } : {}),
					...(previous?.parentId !== undefined ? { parentId: previous.parentId } : ownerId !== undefined ? { parentId: ownerId } : {}),
					status, startedAt: previous?.startedAt ?? at, updatedAt: at,
				});
			}
		}
		if (!Array.isArray(content)) { continue; }
		for (const rawBlock of content) {
			const block = record(rawBlock);
			if (block === undefined) { continue; }
			if (block['type'] === 'tool_use') {
				const tool = text(block['name']);
				const toolUseId = text(block['id']);
				if ((tool === 'Agent' || tool === 'Task') && toolUseId !== undefined) {
					const input = record(block['input']);
					const detail = text(input?.['description']) ?? text(input?.['prompt']);
					const label = text(input?.['subagent_type']) ?? text(input?.['agent_type']) ?? 'SubAgent';
					pendingTools.set(toolUseId, { label, ...(detail !== undefined ? { detail } : {}), at });
				}
			} else if (block['type'] === 'tool_result') {
				const resultText = flattenContent(block['content']);
				const id = agentIdFromToolResult(resultText);
				const tool = pendingTools.get(text(block['tool_use_id']) ?? '');
				if (id !== undefined && (tool !== undefined || /Async agent launched|running in the background/i.test(resultText))) {
					spawned.set(id, {
						id, label: tool?.label ?? 'SubAgent', provider: 'claude', ...(tool?.detail !== undefined ? { detail: tool.detail } : {}),
						...(ownerId !== undefined ? { parentId: ownerId } : {}), status: activeOrUnknown(mtime, now), startedAt: tool?.at ?? at, updatedAt: at,
					});
				}
			}
		}
	}

	const owner = ownerId !== undefined && ID_PATTERN.test(ownerId) ? {
		id: ownerId, label: ownerLabel, provider: 'claude' as const, ...(ownerDetail !== undefined ? { detail: ownerDetail } : {}),
		status: ownerStatus, startedAt: ownerStartedAt, updatedAt: ownerUpdatedAt,
	} : undefined;
	return { ...(owner !== undefined ? { owner } : {}), spawned: [...spawned.values()] };
}

function parseCodexSource(source: string): { readonly parentId?: string; readonly depth?: number; readonly label?: string } {
	try {
		const root = record(JSON.parse(source));
		const spawn = record(record(root?.['subagent'])?.['thread_spawn']);
		const parentId = text(spawn?.['parent_thread_id']);
		const rawDepth = number(spawn?.['depth']);
		const depth = rawDepth !== undefined ? Math.min(5, Math.max(1, Math.trunc(rawDepth))) : undefined;
		const label = text(spawn?.['agent_nickname']) ?? text(spawn?.['agent_role']);
		return { ...(parentId !== undefined ? { parentId } : {}), ...(depth !== undefined ? { depth } : {}), ...(label !== undefined ? { label } : {}) };
	} catch { return {}; }
}

/** Codex child threadのsourceとrolloutから、親子関係・指示・終端状態を復元する。 */
export function paradisParseCodexPersistedActivity(id: string, source: string, lines: readonly string[], mtime: number, now: number): IParadisRecoveredAgentActivity | undefined {
	if (!ID_PATTERN.test(id)) { return undefined; }
	const sourceInfo = parseCodexSource(source);
	let label = sourceInfo.label ?? 'SubAgent';
	let detail: string | undefined;
	let startedAt = mtime;
	let updatedAt = mtime;
	let sawLine = false;
	let status: ParadisRecoveredAgentStatus = activeOrUnknown(mtime, now);
	for (const line of lines) {
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; }
		if (entry === undefined) { continue; }
		const at = timestamp(entry['timestamp']) ?? mtime;
		startedAt = sawLine ? Math.min(startedAt, at) : at;
		updatedAt = Math.max(updatedAt, at);
		sawLine = true;
		if (entry['type'] === 'session_meta') {
			const payload = record(entry['payload']);
			label = text(payload?.['agent_nickname']) ?? text(payload?.['agent_path']) ?? label;
		} else if (entry['type'] === 'response_item') {
			const payload = record(entry['payload']);
			if (payload?.['type'] === 'message' && payload['role'] === 'user' && detail === undefined) {
				detail = text(flattenContent(payload['content']));
			}
		} else if (entry['type'] === 'event_msg') {
			const payload = record(entry['payload']);
			switch (text(payload?.['type'])) {
				case 'task_started': status = activeOrUnknown(mtime, now); break;
				case 'task_complete': status = 'completed'; break;
				case 'error': status = 'failed'; break;
				case 'turn_aborted': status = 'interrupted'; break;
			}
		}
	}
	return {
		id, label, provider: 'codex', ...(detail !== undefined ? { detail } : {}),
		...(sourceInfo.parentId !== undefined && sourceInfo.parentId !== id ? { parentId: sourceInfo.parentId } : {}),
		...(sourceInfo.depth !== undefined ? { depth: sourceInfo.depth } : {}), status, startedAt, updatedAt,
	};
}

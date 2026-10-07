/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IParadisCodexGoal, IParadisCodexPlanStep } from '../../agentChat/common/paradisAgentTranscriptParser.js';
import type { IParadisRecoveredAgentActivity } from './paradisPersistedAgentActivity.js';

export type ParadisAgentActivityStatus = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'unknown';

/**
 * 完了シグナルを取りこぼした活動を「状態不明」へ落とすまでの猶予。
 *
 * 親のhookは子Agentの実行中には一切届かない（Agent toolの完了まで無音）ため、これを短くすると
 * 長く走っている子Agentが実際には動いているのに状態不明として表示されてしまう。呼び出し側は
 * 失効させる前に永続transcriptで生存を確認する。
 */
export const PARADIS_ACTIVITY_STALE_MS = 30 * 60 * 1000;

/**
 * 終わった子に届いた SubagentStart を、再開として受け入れるまでの最短の間隔。hook は別々の HTTP
 * 要求として届き、受け取った側の処理の待ち時間で順序が入れ替わりうる。すぐ終わる子の Start が Stop の
 * 直後に処理されたものを、再開と取り違えないための幅（SendMessage での再開はこれよりずっと後に来る）。
 */
const SUBAGENT_RESTART_MIN_GAP_MS = 2_000;

/** 1 つの子に覚える呼び出しの id の上限（起動の 1 件は必ず残し、再開は新しい方から残す）。 */
const MAX_TOOL_USE_IDS_PER_AGENT = 10;
/** 呼び出しの id を覚えておく子の数の上限（一覧の上限 100 件より多く持ち、一覧へ後から載る子にも当てる）。 */
const MAX_LINKED_AGENTS = 300;
/**
 * 再開とみなして戻した子を、記録の読み直しで終わりへ戻すまでの猶予。本物の再開（SendMessage）では子がすぐに
 * 新しい指示の行を書くので、それより長く行が無ければ遅れて届いた開始の知らせとみなす。
 */
const SUBAGENT_REVIVAL_GRACE_MS = 5_000;
const LINKED_AGENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,500}$/;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

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
	/**
	 * この子を起動した呼び出し（Claude の Agent / Task、Codex の spawn_agent）の toolUseId と、その後に再開した
	 * 呼び出し（SendMessage・followup_task）の toolUseId。先頭が起動の呼び出し。モバイルの会話のカードは、
	 * 呼び出しの toolUseId でこの項目を引いて状態と詳細への入口を出す。古いアプリは知らない項目として捨てる。
	 */
	readonly toolUseIds?: readonly string[];
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

/**
 * Claude Code の Advisor（API のサーバー側ツール）への相談 1 回。会話の transcript と子 transcript から読む。
 * 古いアプリは `advisors` を知らない項目として捨てる。
 */
export interface IParadisAgentActivityAdvisor {
	/** `server_tool_use` の id。 */
	readonly id: string;
	readonly model?: string;
	readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
	/** 結果の種別（終わったものだけ）。`redacted` は暗号化されて読めない返答、`text` は平文（旧世代）。 */
	readonly outcome?: 'redacted' | 'text' | 'error';
	readonly errorCode?: string;
	/** サブエージェントの中で呼んだときの、そのサブエージェントの ID。 */
	readonly ownerId?: string;
	readonly startedAt: number;
	readonly updatedAt: number;
}

/**
 * {@link ParadisAgentActivityTracker.applyAdvisors} へ渡す相談。平文の返答（旧世代のモデルだけ）は一覧には載せず、
 * tracker が持っておいて、詳細を開いたとき（activity-detail）に返す（{@link ParadisAgentActivityTracker.advisorReply}）。
 */
export interface IParadisAgentAdvisorUpdate extends IParadisAgentActivityAdvisor {
	/** 平文の返答（上限 {@link ADVISOR_TEXT_LIMIT} 字）。 */
	readonly text?: string;
	/** 返答を切り詰めた（会話の追記の上限、または {@link ADVISOR_TEXT_LIMIT}）。 */
	readonly textTruncated?: boolean;
}

/** 一覧に残す Advisor の相談の数（新しい方から）。 */
const MAX_ADVISORS = 50;
/** Advisor の平文の返答を持っておく上限（1 件あたり）。50 件で最大 200,000 字。 */
export const ADVISOR_TEXT_LIMIT = 4_000;
/** 結果の無い相談を中断とみなすまでの長さ（実測は 8 秒〜2 分）。 */
const ADVISOR_STALE_MS = 15 * 60 * 1_000;

function sameAdvisor(a: IParadisAgentActivityAdvisor | undefined, b: IParadisAgentActivityAdvisor): boolean {
	return a !== undefined && a.id === b.id && a.model === b.model && a.status === b.status && a.outcome === b.outcome && a.errorCode === b.errorCode
		&& a.ownerId === b.ownerId && a.startedAt === b.startedAt && a.updatedAt === b.updatedAt;
}

export interface IParadisAgentActivityState {
	readonly agents: readonly IParadisAgentActivityAgent[];
	readonly tasks: readonly IParadisAgentActivityTask[];
	readonly compactions: readonly IParadisAgentCompaction[];
	/** Advisor への相談（1 回も無ければ省く）。 */
	readonly advisors?: readonly IParadisAgentActivityAdvisor[];
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
	// 今の rollout（paginated）は子が答えを返し終えたとき `completed` を書く。followup で再び動けば `interacted` が来る
	if (kind === 'completed') { return 'completed'; }
	return 'running';
}

/** Codex のゴールを表すタスクの ID の接頭辞（スレッドごとに 1 件）。 */
const CODEX_GOAL_TASK_PREFIX = 'codex-goal:';
/** Codex の計画（update_plan）の手順を表すタスクの ID の接頭辞（手順の番号を後ろに付ける）。 */
const CODEX_PLAN_TASK_PREFIX = 'codex-plan:';

function codexGoalTaskStatus(status: IParadisCodexGoal['status']): ParadisAgentActivityStatus {
	switch (status) {
		// ゴールは作業ではなく目標なので「実行中」には数えない（ターンが終わっても残り続けるため）
		case 'active': case 'paused': return 'idle';
		case 'complete': return 'completed';
		case 'budgetLimited': case 'cleared': return 'interrupted';
		default: return 'unknown';
	}
}

function codexPlanTaskStatus(status: IParadisCodexPlanStep['status']): ParadisAgentActivityStatus {
	switch (status) {
		case 'in_progress': return 'running';
		case 'completed': return 'completed';
		default: return 'idle';
	}
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
	const tool = text(item.tool);
	const states = record(item.agentsStates);
	const agentStatuses = new Map<string, unknown>();
	const legacyIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(text).filter((id): id is string => id !== undefined) : [];
	const documentedReceiverId = text(item.receiverThreadId);
	const documentedNewThreadId = text(item.newThreadId);
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
		agentStatuses.set(id, record(states?.[rawId])?.status);
	}
	const documentedStatus = record(item.agentStatus)?.status ?? item.agentStatus;
	if (documentedStatus !== undefined) {
		for (const id of agentStatuses.keys()) {
			if (agentStatuses.get(id) === undefined) { agentStatuses.set(id, documentedStatus); }
		}
	}
	return { tool, prompt: text(item.prompt), itemStatus: text(item.status), agentStatuses };
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
	/** 名前付きのエージェント（チームメイト）の名前 → 子 transcript の ID。TeammateIdle を同じ項目へ当てる。 */
	private readonly agentIdsByName = new Map<string, string>();
	/**
	 * 子の ID → 起動・再開した呼び出しの toolUseId（{@link IParadisAgentActivityAgent.toolUseIds}）。一覧の項目とは
	 * 別に持つ。起動の知らせ（mod・transcript・rollout）と一覧の項目のどちらが先に来ても結べるようにするため。
	 */
	private readonly toolUseIdsByAgent = new Map<string, string[]>();
	/**
	 * 終わった後の SubagentStart で動いているに戻した子 → 戻した時刻。遅れて届いた Start（Stop が落ちた・順序の
	 * 入れ替わり）で戻ったものは、記録の読み直しで再開後の行が無いと分かったら終わりへ戻す（{@link mergeRecoveredAgents}）。
	 */
	private readonly revivedAt = new Map<string, number>();
	/** Advisor への相談（id → 項目）。変える時は {@link setAdvisor} を通す（{@link advisorGeneration} を進めるため）。 */
	private readonly advisors = new Map<string, IParadisAgentActivityAdvisor>();
	/** 平文の返答（id → 本文と、切り詰めたか）。一覧には載せない。 */
	private readonly advisorReplies = new Map<string, { readonly text: string; readonly truncated: boolean }>();
	/** 相談の中身が変わった回数。変化の判定（serialized）は相談の表を JSON にせず、この数だけを比べる。 */
	private advisorGeneration = 0;
	/** 最後に分かった Advisor のモデル名（mod の行など、モデル名の無い知らせを補う）。 */
	private lastAdvisorModel: string | undefined;
	/** 一覧にいる子の結びが変わった回数。変化の判定（serialized）は大きな表を JSON にせず、この数だけを比べる。 */
	private linkGeneration = 0;

	beginTurn(): boolean {
		// セッション内の完了履歴はモバイルの一覧・詳細へ残す。新しい活動は同じ
		// trackerへ追記され、finishApplyで上限を超えた古い完了項目だけを落とす。
		return false;
	}

	applyClaude(event: string, payload: Readonly<Record<string, unknown>>, at: number): boolean {
		const before = this.serialized();
		if (event === 'SubagentStart' || event === 'SubagentStop') {
			const id = text(payload.agent_id);
			if (id !== undefined) {
				const previous = this.agents.get(id);
				const nextStatus: ParadisAgentActivityStatus = event === 'SubagentStop' ? 'completed' : 'running';
				// SendMessage で再開した子には、同じ agent_id で SubagentStart がもう一度届く（Claude Code
				// 2.1.287 で実測）。終わった後に届いた Start は蘇生として受け入れ、Stop の直後に処理されたもの
				// （{@link SUBAGENT_RESTART_MIN_GAP_MS} 以内）は順序が入れ替わった遅着として捨てる。
				if (!(previous !== undefined && terminal(previous.status) && nextStatus === 'running' && at - previous.updatedAt < SUBAGENT_RESTART_MIN_GAP_MS)) {
					if (previous !== undefined && terminal(previous.status) && nextStatus === 'running') {
						this.revivedAt.delete(id);
						this.revivedAt.set(id, at);
						for (const oldest of [...this.revivedAt.keys()].slice(0, Math.max(0, this.revivedAt.size - MAX_LINKED_AGENTS))) {
							this.revivedAt.delete(oldest);
						}
					} else if (nextStatus !== 'running') {
						this.revivedAt.delete(id);
					}
					if (event === 'SubagentStop') {
						// 子が終わったら、その子の結果の無い相談はもう返らない（結果があとから読めれば完了に直る）
						this.endAdvisors('interrupted', at, advisor => advisor.ownerId === id);
					}
					const detail = event === 'SubagentStop' ? text(payload.last_assistant_message) ?? previous?.detail : text(payload.prompt) ?? previous?.detail;
					this.agents.set(id, {
						// 子の記録からチームメイトと分かった項目は、hook で上書きしてもチームメイトのまま
						id, label: text(payload.agent_type) ?? previous?.label ?? 'SubAgent', role: previous?.role ?? 'subagent', provider: 'claude',
						...(detail !== undefined ? { detail } : {}),
						...relationship(id, payload.parent_agent_id ?? payload.parent_id, payload.depth, previous),
						status: nextStatus, startedAt: previous?.startedAt ?? at, updatedAt: at,
					});
				}
			}
		} else if (event === 'TaskCreated' || event === 'TaskCompleted') {
			const id = text(payload.task_id);
			if (id !== undefined) {
				const previous = this.tasks.get(id);
				if (previous !== undefined && terminal(previous.status) && event === 'TaskCreated') {
					return this.finishApply(before, at);
				}
				this.tasks.set(id, {
					id, label: text(payload.task_subject) ?? previous?.label ?? 'Task',
					...(text(payload.task_description) ?? previous?.detail ? { detail: text(payload.task_description) ?? previous?.detail } : {}),
					...(text(payload.teammate_name) ?? previous?.assignee ? { assignee: text(payload.teammate_name) ?? previous?.assignee } : {}),
					status: event === 'TaskCompleted' ? 'completed' : 'running', startedAt: previous?.startedAt ?? at, updatedAt: at,
				});
			}
		} else if (event === 'TeammateIdle') {
			const name = text(payload.teammate_name);
			if (name !== undefined) {
				// 子 transcript から既に分かっているチームメイトなら、その項目を待機中にする（別項目を増やさない）
				const knownId = this.agentIdsByName.get(name);
				const known = knownId !== undefined ? this.agents.get(knownId) : undefined;
				if (known !== undefined) {
					this.agents.set(known.id, { ...known, status: 'idle', updatedAt: Math.max(known.updatedAt, at) });
				} else {
					const id = `teammate:${name}`;
					const previous = this.agents.get(id);
					this.agents.set(id, { id, label: name, role: 'teammate', provider: 'claude', status: 'idle', startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
			}
		} else if (event === 'PreCompact') {
			const id = `compact:${at}`;
			this.activeCompactionId = id;
			this.compactions.set(id, { id, ...(text(payload.trigger) ? { trigger: text(payload.trigger) } : {}), status: 'running', startedAt: at, updatedAt: at });
		} else if (event === 'PostCompact') {
			const id = this.activeCompactionId ?? `compact:${at}`;
			const previous = this.compactions.get(id);
			this.compactions.set(id, { id, ...(text(payload.trigger) ?? previous?.trigger ? { trigger: text(payload.trigger) ?? previous?.trigger } : {}), status: 'completed', startedAt: previous?.startedAt ?? at, updatedAt: at });
			this.activeCompactionId = undefined;
		}
		return this.finishApply(before, at);
	}

	/**
	 * Claude Code の mod（Claude Mods）が知らせた子の終わり（agentId 付きの turn.complete）。TaskStop で止めたときは
	 * SubagentStop が来ないので、これが唯一の終わりの知らせになる。一覧にある動いている子だけを終える（Claude Code の
	 * 内部の補助エージェントにも turn.complete は来ないが、来ても一覧に無いので増やさない）。
	 */
	applyClaudeSubagentEnd(id: string, status: 'completed' | 'interrupted' | 'failed', at: number): boolean {
		const previous = this.agents.get(id);
		if (previous === undefined || terminal(previous.status)) {
			return false;
		}
		const before = this.serialized();
		this.revivedAt.delete(id);
		this.agents.set(id, { ...previous, status, updatedAt: Math.max(previous.updatedAt, at) });
		this.endAdvisors('interrupted', at, advisor => advisor.ownerId === id);
		return this.finishApply(before, at);
	}

	/**
	 * ネストした子エージェント（ペイン所有者のCLI配下で起動された別のエージェントCLI。
	 * ingress の所有権分類が 'nested' としたhook）を活動ツリーへ投影する。
	 * ペインの親セッション・ライブ状態には一切影響しない。
	 */
	applyNestedAgentHook(provider: 'claude' | 'codex', key: string, event: string, at: number, prompt?: string): boolean {
		const before = this.serialized();
		const id = `nested:${provider}:${key}`.slice(0, 500);
		const previous = this.agents.get(id);
		let status: ParadisAgentActivityStatus;
		if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') {
			if (previous === undefined) {
				return false;
			}
			status = 'completed';
		} else if (event === 'SessionStart' || event === 'UserPromptSubmit') {
			status = 'running';
		} else if (previous !== undefined && terminal(previous.status)) {
			// ツール実行等の生存シグナルの遅着で、終了済み表示を蘇生させない。
			return false;
		} else {
			status = previous?.status ?? 'running';
		}
		const detail = text(prompt?.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)) ?? previous?.detail;
		this.agents.set(id, {
			id, label: provider === 'codex' ? 'Codex' : 'Claude', role: 'subagent', provider,
			...(detail !== undefined ? { detail } : {}),
			status, startedAt: previous?.startedAt ?? at, updatedAt: at,
		});
		return this.finishApply(before, at);
	}

	applyCodex(method: string, params: Readonly<Record<string, unknown>>, at: number): boolean {
		const before = this.serialized();
		if (method === 'thread/compacted') {
			this.compactions.set(`compact:${at}`, { id: `compact:${at}`, status: 'completed', startedAt: at, updatedAt: at });
			return this.finishApply(before, at);
		}
		const item = record(params.item);
		const type = text(item?.type);
		if (type === 'contextCompaction') {
			const id = text(item?.id) ?? `compact:${at}`;
			this.compactions.set(id, { id, status: method === 'item/completed' ? 'completed' : 'running', startedAt: this.compactions.get(id)?.startedAt ?? at, updatedAt: at });
		} else if (type === 'subAgentActivity') {
			const id = text(item?.agentThreadId);
			if (id !== undefined) {
				const previous = this.agents.get(id);
				const kind = text(item?.kind);
				const via = text(item?.interaction);
				// 終わった子への interacted は、followup_task（新しい仕事）なら再び動き出すが、send_message 等の知らせだけなら
				// 子は動かない。どのツールか分からない（app-server・旧形式）ときは従来どおり動き出したとみなす
				const keepsTerminal = kind === 'interacted' && via !== undefined && via !== 'followup_task' && previous !== undefined && terminal(previous.status);
				const status = keepsTerminal ? previous.status : codexSubAgentStatus(kind);
				if (!(previous !== undefined && (at < previous.updatedAt || (terminal(previous.status) && status === 'running' && at === previous.updatedAt)))) {
					const detail = previous?.detail ?? text(item?.prompt);
					this.agents.set(id, { id, label: text(item?.agentPath) ?? previous?.label ?? 'SubAgent', role: 'subagent', provider: 'codex', ...(detail !== undefined ? { detail } : {}), ...relationship(id, item?.parentThreadId, item?.depth, previous), status, startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
				this.updateCodexTask(id, status, at, { assignee: codexAssignee(item?.agentPath) });
				// 今の rollout では、子の活動の id が起動（spawn_agent）・やりとり（followup_task 等）の呼び出しの call_id
				const callId = text(item?.callId);
				if (callId !== undefined) { this.linkToolUseQuietly(id, callId, kind === 'started'); }
			}
		} else if ((type === 'collabAgentToolCall' || type === 'collabToolCall') && item !== undefined) {
			const collaboration = codexCollaboration(item);
			const isSpawn = collaboration.tool === 'spawnAgent' || collaboration.tool === 'spawn_agent';
			for (const id of collaboration.agentStatuses.keys()) {
				const previous = this.agents.get(id);
				const status = codexCollaborationStatus(collaboration, id, previous?.status, method);
				if (!(previous !== undefined && (at < previous.updatedAt || (terminal(previous.status) && status === 'running' && at === previous.updatedAt)))) {
					this.agents.set(id, { id, label: collaboration.prompt ?? previous?.label ?? 'SubAgent', role: 'subagent', provider: 'codex', ...(collaboration.prompt ?? previous?.detail ? { detail: collaboration.prompt ?? previous?.detail } : {}), ...relationship(id, item.parentThreadId, item.depth, previous), status, startedAt: previous?.startedAt ?? at, updatedAt: at });
				}
				this.updateCodexTask(id, status, at, { create: isSpawn, ...(isSpawn && collaboration.prompt !== undefined ? { prompt: collaboration.prompt } : {}) });
			}
		}
		return this.finishApply(before, at);
	}

	/**
	 * Codex の `/goal`（rollout の `thread_goal_updated`）を、Claude Code のタスクと同じ一覧へ 1 件として載せる。
	 * ゴールはスレッドに 1 つだけなので、同じスレッドの更新は同じ項目を書き換える。
	 */
	applyCodexGoal(goal: IParadisCodexGoal, at: number): boolean {
		const before = this.serialized();
		const id = `${CODEX_GOAL_TASK_PREFIX}${(goal.threadId ?? 'thread').slice(0, 480)}`;
		const previous = this.tasks.get(id);
		if (previous !== undefined && at < previous.updatedAt) {
			return false;
		}
		const objective = goal.objective ?? previous?.detail;
		if (objective === undefined) {
			return false; // 外されたゴールを、知らないまま新しく作らない
		}
		const label = objective.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 200) ?? 'Goal';
		this.tasks.set(id, {
			// allow-any-unicode-next-line
			id, label, detail: objective, assignee: 'ゴール',
			// 同じスレッドでも目標が変わったら、新しいゴールとして数え直す
			status: codexGoalTaskStatus(goal.status), startedAt: previous !== undefined && previous.detail === objective ? previous.startedAt : at, updatedAt: at,
		});
		return this.finishApply(before, at);
	}

	/**
	 * Codex の計画（`update_plan`）。呼ばれるたびに計画は丸ごと置き換わるので、前の計画の手順は消して並べ直す。
	 * 同じ位置の同じ手順は開始時刻を引き継ぐ。
	 */
	applyCodexPlan(steps: readonly IParadisCodexPlanStep[], at: number): boolean {
		const before = this.serialized();
		const previousSteps = new Map([...this.tasks].filter(([id]) => id.startsWith(CODEX_PLAN_TASK_PREFIX)));
		if ([...previousSteps.values()].some(task => at < task.updatedAt)) {
			return false;
		}
		for (const id of previousSteps.keys()) {
			this.tasks.delete(id);
		}
		steps.forEach((step, index) => {
			const id = `${CODEX_PLAN_TASK_PREFIX}${index}`;
			const previous = previousSteps.get(id);
			const label = step.step.split(/\r?\n/)[0].slice(0, 200);
			const status = codexPlanTaskStatus(step.status);
			// 同じ手順を続けている間は開始時刻を引き継ぐ。待っていた手順に取りかかったら、そこから数える
			const startedAt = previous !== undefined && previous.label === label && !(previous.status === 'idle' && status !== 'idle') ? previous.startedAt : at;
			this.tasks.set(id, {
				// allow-any-unicode-next-line
				id, label, ...(label !== step.step ? { detail: step.step } : {}), assignee: '計画',
				status, startedAt, updatedAt: at,
			});
		});
		return this.finishApply(before, at);
	}

	/**
	 * {@link linkToolUse} の、時刻の更新を呼び出し側の finishApply に任せる版。一覧にいる子の結びが変わったときだけ
	 * true を返す（一覧にいない子の結びは、子が一覧へ載るときの変化と一緒に届く）。
	 */
	private linkToolUseQuietly(agentId: string, toolUseId: string, spawn: boolean): boolean {
		if (!LINKED_AGENT_ID_PATTERN.test(agentId) || !TOOL_USE_ID_PATTERN.test(toolUseId)) {
			return false;
		}
		const previous = this.toolUseIdsByAgent.get(agentId) ?? [];
		if (previous.includes(toolUseId)) {
			return false;
		}
		const next = spawn ? [toolUseId, ...previous] : [...previous, toolUseId];
		// 新しく知らせた子を後ろへ回し、上限を超えたら長く知らせの無い子から忘れる
		this.toolUseIdsByAgent.delete(agentId);
		this.toolUseIdsByAgent.set(agentId, next.length > MAX_TOOL_USE_IDS_PER_AGENT ? [next[0], ...next.slice(next.length - MAX_TOOL_USE_IDS_PER_AGENT + 1)] : next);
		for (const oldest of [...this.toolUseIdsByAgent.keys()].slice(0, Math.max(0, this.toolUseIdsByAgent.size - MAX_LINKED_AGENTS))) {
			this.toolUseIdsByAgent.delete(oldest);
		}
		if (!this.agents.has(agentId)) {
			return false;
		}
		this.linkGeneration++;
		return true;
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

	/**
	 * 子を起動した（`spawn`）または再開した呼び出しの toolUseId を覚える。同じ組を何度知らせても変わらない。
	 * 一覧にいる子の結びが変わったときだけ true（送り直す）。結びだけの変化では一覧の開始時刻を立てない。
	 */
	linkToolUse(agentId: string, toolUseId: string, at: number, spawn = false): boolean {
		if (!this.linkToolUseQuietly(agentId, toolUseId, spawn) || this.updatedAt === undefined) {
			return false;
		}
		this.updatedAt = Math.max(this.updatedAt, at);
		return true;
	}

	/**
	 * Advisor への相談を足す・更新する（会話の追記と、transcript の読み直しの両方から来る）。終わった相談を
	 * 遅れて届いた開始で動いているに戻さない。上限を超えたら古い方から忘れる。
	 */
	applyAdvisors(advisors: readonly IParadisAgentAdvisorUpdate[], at: number): boolean {
		const before = this.serialized();
		for (const advisor of advisors) {
			if (!/^[A-Za-z0-9._:-]{1,200}$/.test(advisor.id)) {
				continue;
			}
			const previous = this.advisors.get(advisor.id);
			// 決着した相談を、遅れて届いた開始や、読み直しで推定した中断（結果の行がまだ読めていない）で上書きしない
			if (previous !== undefined && previous.status !== 'running' && (advisor.status === 'running' || advisor.status === 'interrupted')) {
				continue;
			}
			const ownerId = advisor.ownerId ?? previous?.ownerId;
			const model = advisor.model ?? previous?.model;
			if (advisor.model !== undefined) {
				this.lastAdvisorModel = advisor.model;
			}
			const { text, textTruncated, ...rest } = advisor;
			this.setAdvisor({
				...rest,
				...(model !== undefined ? { model } : {}),
				...(ownerId !== undefined ? { ownerId } : {}),
				startedAt: Math.min(previous?.startedAt ?? advisor.startedAt, advisor.startedAt),
			});
			// 会話の追記の本文は切り詰めてある。transcript の読み直しで取った長い方を残す
			const reply = this.advisorReplies.get(advisor.id);
			if (text !== undefined && advisor.status !== 'running' && (reply === undefined || text.length >= reply.text.length)) {
				this.advisorReplies.set(advisor.id, { text: text.slice(0, ADVISOR_TEXT_LIMIT), truncated: textTruncated === true || text.length > ADVISOR_TEXT_LIMIT });
			}
		}
		if (this.advisors.size > MAX_ADVISORS) {
			const oldest = [...this.advisors.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, this.advisors.size - MAX_ADVISORS);
			for (const advisor of oldest) {
				this.advisors.delete(advisor.id);
				this.advisorReplies.delete(advisor.id);
				this.advisorGeneration++;
			}
		}
		return this.finishApply(before, at);
	}

	/** 相談を置く。中身が変わったときだけ {@link advisorGeneration} を進める。 */
	private setAdvisor(advisor: IParadisAgentActivityAdvisor): void {
		if (!sameAdvisor(this.advisors.get(advisor.id), advisor)) {
			this.advisors.set(advisor.id, advisor);
			this.advisorGeneration++;
		}
	}

	/** 結果の無い相談を終わりにする（`filter` に当たる、`at` より前に始めたもの）。 */
	private endAdvisors(status: 'completed' | 'failed' | 'interrupted', at: number, filter: (advisor: IParadisAgentActivityAdvisor) => boolean): void {
		for (const advisor of [...this.advisors.values()]) {
			if (advisor.status === 'running' && advisor.startedAt <= at && filter(advisor)) {
				this.setAdvisor({ ...advisor, status, updatedAt: at });
			}
		}
	}

	/** 平文の返答（詳細を開いたときに返す）。平文の返答の無い相談・知らない相談なら undefined。 */
	advisorReply(id: string): { readonly advisor: IParadisAgentActivityAdvisor; readonly text: string; readonly truncated: boolean } | undefined {
		const advisor = this.advisors.get(id);
		const reply = this.advisorReplies.get(id);
		return advisor !== undefined && reply !== undefined && advisor.outcome === 'text' ? { advisor, ...reply } : undefined;
	}

	/** 最後に分かった Advisor のモデル名。 */
	advisorModel(): string | undefined {
		return this.lastAdvisorModel;
	}

	/** 一覧に子がいるか（SubagentStart が新しい起動か再開かを見分ける）。 */
	hasAgent(agentId: string): boolean {
		return this.agents.has(agentId);
	}

	/** 一覧の子の呼び名と種類（許可のカードの送り元に出す）。一覧にいなければ undefined。 */
	agentSummary(agentId: string): { readonly label: string; readonly role: 'subagent' | 'teammate' } | undefined {
		const agent = this.agents.get(agentId);
		return agent !== undefined ? { label: agent.label, role: agent.role } : undefined;
	}

	/** 一覧の子が終わっているか（完了・失敗・中断）。 */
	hasEndedAgent(agentId: string): boolean {
		const agent = this.agents.get(agentId);
		return agent !== undefined && terminal(agent.status);
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
			const revivedAt = this.revivedAt.get(recovered.id);
			if (previous !== undefined && !terminal(previous.status)) {
				if (terminal(recovered.status) && recovered.updatedAt >= previous.updatedAt) {
					status = recovered.status;
				} else if (terminal(recovered.status) && revivedAt !== undefined && at - revivedAt >= SUBAGENT_REVIVAL_GRACE_MS && (recovered.lastLineAt ?? recovered.updatedAt) < revivedAt) {
					// 終わった後の Start で戻したが、子の記録に戻した後の行が無い（遅れて届いた Start）。終わりへ戻す
					status = recovered.status;
				} else if (previous.status === 'unknown' && recovered.status === 'running' && recovered.updatedAt >= previous.updatedAt) {
					status = 'running';
				}
			} else if (previous !== undefined && recovered.status === 'running' && recovered.updatedAt > previous.updatedAt) {
				// 終わった後に子 transcript へ新しい作業が書かれた（SendMessage での再開など）
				status = 'running';
			}
			if (terminal(status) || (revivedAt !== undefined && (recovered.lastLineAt ?? 0) >= revivedAt)) {
				// 終わった、または戻した後の行が子の記録にある（本物の再開）。もう疑わない
				this.revivedAt.delete(recovered.id);
			}
			// 名前付きの起動は名前で見分ける（hook の agent_type で先に作った項目は種類名を持っている）
			const label = recovered.name ?? (previous?.label !== undefined && previous.label !== 'SubAgent' ? previous.label : recovered.label);
			const detail = previous?.detail ?? recovered.detail;
			this.agents.set(recovered.id, {
				id: recovered.id, label, role: recovered.teammate === true || previous?.role === 'teammate' ? 'teammate' : 'subagent', provider: recovered.provider,
				...(detail !== undefined ? { detail } : {}),
				...(previous?.parentId !== undefined ? { parentId: previous.parentId } : {}),
				...(previous?.depth !== undefined ? { depth: previous.depth } : {}),
				status, startedAt: Math.min(previous?.startedAt ?? recovered.startedAt, recovered.startedAt),
				updatedAt: Math.max(previous?.updatedAt ?? recovered.updatedAt, recovered.updatedAt),
			});
			relationships.set(recovered.id, { ...(recovered.parentId !== undefined ? { parentId: recovered.parentId } : {}), ...(recovered.depth !== undefined ? { depth: recovered.depth } : {}) });
			recovered.toolUseIds?.forEach((toolUseId, index) => this.linkToolUseQuietly(recovered.id, toolUseId, index === 0));
			if (recovered.name !== undefined && recovered.name !== recovered.id) {
				// 先に TeammateIdle で作った仮の項目があれば、子 transcript の項目へ畳む
				this.agentIdsByName.set(recovered.name, recovered.id);
				const placeholder = this.agents.get(`teammate:${recovered.name}`);
				if (placeholder !== undefined) {
					this.agents.delete(placeholder.id);
					const current = this.agents.get(recovered.id);
					if (current !== undefined && placeholder.updatedAt > current.updatedAt && !terminal(current.status)) {
						this.agents.set(recovered.id, { ...current, status: placeholder.status, updatedAt: placeholder.updatedAt });
					}
				}
			}
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

	/**
	 * 親Agentのターン終了。子Agent/Taskは各自の終了イベントが正本なので変更しない。ただし Codex の計画の手順は
	 * 親のターンの中の作業なので、取りかかったまま終わった手順は畳む（失敗・中断はそのまま、それ以外は待機）
	 * （更新されずに終わる計画が実データで約 4 割あり、実行中のまま残ってしまう）。
	 */
	endTurn(at: number, reason?: 'completed' | 'failed' | 'interrupted'): boolean {
		const before = this.serialized();
		this.finishCompactions(at);
		// 正常に終わったターンでも、取りかかったままの手順は終わっていない。完了とは見せず待機へ戻す
		this.settleCodexPlan(reason === 'failed' || reason === 'interrupted' ? reason : 'idle', at);
		// 親のターンが終わったのに結果の無い Advisor の相談は、もう返らない（中断）。サブエージェントの中の相談は子が持つ
		this.endAdvisors('interrupted', at, advisor => advisor.ownerId === undefined);
		return this.finishApply(before, at);
	}

	/**
	 * 会話を読むのをやめる（tailer の破棄）ときに、Codex の計画とゴールを「動いている」扱いのまま残さない。
	 * 時刻は変えないので、読み直したときに同じ記録が来れば元どおりに組み直される。
	 */
	settleCodexPlanAndGoal(at: number): boolean {
		const before = this.serialized();
		for (const [id, task] of this.tasks) {
			if ((id.startsWith(CODEX_PLAN_TASK_PREFIX) || id.startsWith(CODEX_GOAL_TASK_PREFIX)) && task.status === 'running') {
				this.tasks.set(id, { ...task, status: 'idle' });
			}
		}
		return this.finishApply(before, at);
	}

	private settleCodexPlan(status: ParadisAgentActivityStatus, at: number): void {
		for (const [id, task] of this.tasks) {
			if (id.startsWith(CODEX_PLAN_TASK_PREFIX) && task.status === 'running' && task.updatedAt <= at) {
				this.tasks.set(id, { ...task, status, updatedAt: at });
			}
		}
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
		// 会話が終わったら、結果の無い相談はもう返らない（サブエージェントの中の相談も含めて）
		this.endAdvisors('interrupted', at, () => true);
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

	/** 実行中とみなしている子Agent/Taskを抱えているか（失効前の生存確認に使う）。 */
	hasActiveWork(): boolean {
		return [...this.agents.values()].some(agent => agent.status === 'running' || agent.status === 'idle')
			|| [...this.tasks.values()].some(task => task.status === 'running')
			|| [...this.advisors.values()].some(advisor => advisor.status === 'running');
	}

	sweepStale(now: number): boolean {
		const before = this.serialized();
		const cutoff = now - PARADIS_ACTIVITY_STALE_MS;
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
		// 結果の届かないまま古くなった相談（transcript の読み直しが止まった・結果の行が落ちた）
		const advisorCutoff = now - ADVISOR_STALE_MS;
		this.endAdvisors('interrupted', now, advisor => advisor.updatedAt < advisorCutoff);
		return this.finishApply(before, now);
	}

	snapshot(): IParadisAgentActivityState | undefined {
		if (this.startedAt === undefined || this.updatedAt === undefined) {
			return undefined;
		}
		return {
			agents: [...this.agents.values()].map(agent => {
				const toolUseIds = this.toolUseIdsByAgent.get(agent.id);
				return toolUseIds !== undefined ? { ...agent, toolUseIds: [...toolUseIds] } : agent;
			}).sort((a, b) => Number(b.status === 'running' || b.status === 'idle') - Number(a.status === 'running' || a.status === 'idle') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
			tasks: [...this.tasks.values()].sort((a, b) => Number(b.status === 'running' || b.status === 'idle') - Number(a.status === 'running' || a.status === 'idle') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
			compactions: [...this.compactions.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-5),
			...(this.advisors.size > 0 ? { advisors: [...this.advisors.values()].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)) } : {}),
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
		return JSON.stringify([...[...this.agents].sort(), ...[...this.tasks].sort(), ...[...this.compactions].sort(), this.advisorGeneration, this.linkGeneration]);
	}
}

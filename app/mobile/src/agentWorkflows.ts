// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code の Workflow（台本で子を束ねるバックグラウンドの実行）を、トークの 1 枚のカードと段階ごとの画面に出す
 * ための純ロジック（`workflow-card-mock.html` の案 A。Q259 A: 子のシェルはカードへ寄せる。Q260 A: 完了した子は畳む）。
 *
 * PC は agent の snapshot / delta に任意項目 `workflows`・`workflowsAt` を載せる（`agent.workflows.v1`。PC 側は
 * `src/vs/paradis/contrib/agentChat/common/paradisAgentWorkflows.ts`）。子が多いと大きいので、PC は変わったときだけ載せる。
 * 古い PC は送らないので、そのときは一覧が無い（undefined）＝トークは今までどおり Workflow の行を出す。
 *
 * 実行中のトークン・ツール回数は PC でも分からない（子の transcript を足し上げないと出ない）ので、終わってから出す。
 */

import type { AgentShell } from './agentShells.js';

export type AgentWorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type AgentWorkflowAgentState = 'running' | 'done' | 'failed' | 'stopped';

export interface AgentWorkflowPhase {
	title: string;
	detail?: string;
}

export interface AgentWorkflowAgent {
	id: string;
	label?: string;
	/** 段階の番号（`phases` の添字）。 */
	phase?: number;
	state: AgentWorkflowAgentState;
	/** 手元の時計。 */
	startedAt?: number;
	durationMs?: number;
	tokens?: number;
	toolCalls?: number;
	lastTool?: string;
	cached?: true;
}

export interface AgentWorkflowCounts {
	running: number;
	done: number;
	failed: number;
	stopped: number;
}

export interface AgentWorkflow {
	runId: string;
	taskId?: string;
	toolUseId?: string;
	name: string;
	summary?: string;
	status: AgentWorkflowStatus;
	estimated?: true;
	/** 手元の時計。 */
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	phases: AgentWorkflowPhase[];
	agents: AgentWorkflowAgent[];
	agentCount: number;
	counts: AgentWorkflowCounts;
	totalTokens?: number;
	totalToolCalls?: number;
	error?: string;
}

/** カード・画面の状態の言い方。partial は「完了したが失敗した子がいる」。 */
export type AgentWorkflowTone = 'running' | 'done' | 'partial' | 'failed' | 'stopped';

const MAX_WORKFLOWS = 20;
const MAX_AGENTS = 300;
const MAX_PHASES = 40;
const STATUSES = new Set<AgentWorkflowStatus>(['running', 'completed', 'failed', 'stopped']);
const AGENT_STATES = new Set<AgentWorkflowAgentState>(['running', 'done', 'failed', 'stopped']);
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, limit) : undefined;
}

function count(value: unknown): number {
	return finite(value) ? Math.trunc(value) : 0;
}

/** PC から届いた `workflows` を読む。配列でなければ undefined（古い PC・壊れた値）。形の合わない要素は捨てる。 */
export function parseAgentWorkflows(value: unknown): AgentWorkflow[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const workflows: AgentWorkflow[] = [];
	for (const candidate of value.slice(-MAX_WORKFLOWS)) {
		const item = record(candidate);
		const runId = item?.['runId'];
		if (item === undefined || typeof runId !== 'string' || !ID.test(runId) || !STATUSES.has(item['status'] as AgentWorkflowStatus) || !finite(item['startedAt'])) {
			continue;
		}
		const phases: AgentWorkflowPhase[] = [];
		for (const raw of Array.isArray(item['phases']) ? item['phases'].slice(0, MAX_PHASES) : []) {
			const phase = record(raw);
			const title = text(phase?.['title'], 120);
			if (title === undefined) {
				continue;
			}
			const detail = text(phase?.['detail'], 300);
			phases.push({ title, ...(detail !== undefined ? { detail } : {}) });
		}
		const agents: AgentWorkflowAgent[] = [];
		for (const raw of Array.isArray(item['agents']) ? item['agents'].slice(0, MAX_AGENTS) : []) {
			const agent = record(raw);
			const id = agent?.['id'];
			if (agent === undefined || typeof id !== 'string' || !ID.test(id) || !AGENT_STATES.has(agent['state'] as AgentWorkflowAgentState)) {
				continue;
			}
			const label = text(agent['label'], 200);
			const phase = finite(agent['phase']) && agent['phase'] < phases.length ? Math.trunc(agent['phase']) : undefined;
			const lastTool = text(agent['lastTool'], 80);
			agents.push({
				id,
				...(label !== undefined ? { label } : {}),
				...(phase !== undefined ? { phase } : {}),
				state: agent['state'] as AgentWorkflowAgentState,
				...(finite(agent['startedAt']) ? { startedAt: agent['startedAt'] } : {}),
				...(finite(agent['durationMs']) ? { durationMs: agent['durationMs'] } : {}),
				...(finite(agent['tokens']) ? { tokens: agent['tokens'] } : {}),
				...(finite(agent['toolCalls']) ? { toolCalls: agent['toolCalls'] } : {}),
				...(lastTool !== undefined ? { lastTool } : {}),
				...(agent['cached'] === true ? { cached: true as const } : {}),
			});
		}
		const rawCounts = record(item['counts']);
		const counts: AgentWorkflowCounts = rawCounts !== undefined
			? { running: count(rawCounts['running']), done: count(rawCounts['done']), failed: count(rawCounts['failed']), stopped: count(rawCounts['stopped']) }
			: countAgents(agents);
		const taskId = text(item['taskId'], 200);
		const toolUseId = text(item['toolUseId'], 200);
		const summary = text(item['summary'], 500);
		const error = text(item['error'], 500);
		workflows.push({
			runId,
			...(taskId !== undefined ? { taskId } : {}),
			...(toolUseId !== undefined ? { toolUseId } : {}),
			name: text(item['name'], 200) ?? runId,
			...(summary !== undefined ? { summary } : {}),
			status: item['status'] as AgentWorkflowStatus,
			...(item['estimated'] === true ? { estimated: true as const } : {}),
			startedAt: item['startedAt'],
			...(finite(item['endedAt']) ? { endedAt: item['endedAt'] } : {}),
			...(finite(item['durationMs']) ? { durationMs: item['durationMs'] } : {}),
			phases,
			agents,
			agentCount: Math.max(agents.length, count(item['agentCount'])),
			counts,
			...(finite(item['totalTokens']) ? { totalTokens: item['totalTokens'] } : {}),
			...(finite(item['totalToolCalls']) ? { totalToolCalls: item['totalToolCalls'] } : {}),
			...(error !== undefined ? { error } : {}),
		});
	}
	return workflows;
}

function countAgents(agents: readonly AgentWorkflowAgent[]): AgentWorkflowCounts {
	const counts: AgentWorkflowCounts = { running: 0, done: 0, failed: 0, stopped: 0 };
	for (const agent of agents) {
		counts[agent.state]++;
	}
	return counts;
}

/** PC の時計の時刻を手元の時計へ直す（`workflowsAt` は PC の送信時刻）。 */
export function localizeAgentWorkflows(workflows: readonly AgentWorkflow[], workflowsAt: unknown, receivedAt: number): AgentWorkflow[] {
	if (!finite(workflowsAt)) {
		return [...workflows];
	}
	const shift = receivedAt - workflowsAt;
	return workflows.map(workflow => ({
		...workflow,
		startedAt: workflow.startedAt + shift,
		...(workflow.endedAt !== undefined ? { endedAt: workflow.endedAt + shift } : {}),
		agents: workflow.agents.map(agent => agent.startedAt !== undefined ? { ...agent, startedAt: agent.startedAt + shift } : agent),
	}));
}

/** カードと画面の状態。完了でも失敗した子がいれば「一部失敗」。 */
export function workflowTone(workflow: Pick<AgentWorkflow, 'status' | 'counts'>): AgentWorkflowTone {
	switch (workflow.status) {
		case 'running': return 'running';
		case 'failed': return 'failed';
		case 'stopped': return 'stopped';
		default: return workflow.counts.failed > 0 ? 'partial' : 'done';
	}
}

export const WORKFLOW_TONE_LABEL: Record<AgentWorkflowTone, string> = {
	running: '実行中',
	done: '完了',
	partial: '一部失敗',
	failed: '失敗',
	stopped: '中断',
};

export const WORKFLOW_AGENT_STATE_LABEL: Record<AgentWorkflowAgentState, string> = {
	running: '実行中',
	done: '完了',
	failed: '失敗',
	stopped: '中断',
};

/** 段階 1 つの状態（子がいなければ未開始）。 */
export type WorkflowPhaseTone = 'pending' | 'running' | 'done' | 'partial' | 'failed';

export interface WorkflowPhaseView {
	readonly index: number;
	readonly title: string;
	readonly detail?: string;
	readonly tone: WorkflowPhaseTone;
	readonly agents: readonly AgentWorkflowAgent[];
	readonly counts: AgentWorkflowCounts;
}

/**
 * 段階ごとに子を分ける。段階の分からない子は最後の「その他」へ入れる（段階の一覧が空なら「子」1 つにまとめる）。
 * 今の段階は、動いている子のいる最後の段階、無ければ子のいる最後の段階。
 */
export function workflowPhaseViews(workflow: AgentWorkflow): { readonly phases: readonly WorkflowPhaseView[]; readonly current: number } {
	const groups = workflow.phases.map(() => [] as AgentWorkflowAgent[]);
	const loose: AgentWorkflowAgent[] = [];
	for (const agent of workflow.agents) {
		const group = agent.phase !== undefined ? groups[agent.phase] : undefined;
		(group ?? loose).push(agent);
	}
	const phases: WorkflowPhaseView[] = workflow.phases.map((phase, index) => view(index, phase.title, phase.detail, groups[index] ?? [], workflow.status));
	if (loose.length > 0) {
		phases.push(view(phases.length, phases.length === 0 ? '子' : 'その他', undefined, loose, workflow.status));
	}
	let current = -1;
	phases.forEach((phase, index) => {
		if (phase.counts.running > 0) {
			current = index;
		}
	});
	if (current < 0) {
		phases.forEach((phase, index) => {
			if (phase.agents.length > 0) {
				current = index;
			}
		});
	}
	return { phases, current: Math.max(0, current) };
}

function view(index: number, title: string, detail: string | undefined, agents: readonly AgentWorkflowAgent[], status: AgentWorkflowStatus): WorkflowPhaseView {
	const counts = countAgents(agents);
	const tone: WorkflowPhaseTone = agents.length === 0 ? 'pending'
		: counts.running > 0 ? 'running'
			: counts.failed > 0 ? (counts.stopped > 0 || status === 'failed' ? 'failed' : 'partial')
				: counts.stopped > 0 ? 'failed' : 'done';
	return { index, title, ...(detail !== undefined ? { detail } : {}), tone, agents, counts };
}

const AGENT_RANK: Record<AgentWorkflowAgentState, number> = { failed: 0, running: 1, stopped: 2, done: 3 };

/**
 * 段階の中の子を、開いて見せるものと畳むもの（完了）に分ける（Q260 A）。開くものは失敗・実行中・中断の順。
 */
export function splitWorkflowAgents(agents: readonly AgentWorkflowAgent[]): { readonly open: readonly AgentWorkflowAgent[]; readonly done: readonly AgentWorkflowAgent[] } {
	const open = agents.filter(agent => agent.state !== 'done');
	return {
		open: open.map((agent, order) => ({ agent, order })).sort((a, b) => AGENT_RANK[a.agent.state] - AGENT_RANK[b.agent.state] || a.order - b.order).map(item => item.agent),
		done: agents.filter(agent => agent.state === 'done'),
	};
}

/** Workflow の子が起動したシェル（Q259 A: カードへ寄せる）。子の ID → シェル。 */
export function workflowShellsByAgent(workflow: Pick<AgentWorkflow, 'agents'>, shells: readonly AgentShell[] | undefined): ReadonlyMap<string, readonly AgentShell[]> {
	const ids = new Set(workflow.agents.map(agent => agent.id));
	const byAgent = new Map<string, AgentShell[]>();
	for (const shell of shells ?? []) {
		if (shell.ownerAgentId !== undefined && ids.has(shell.ownerAgentId)) {
			const list = byAgent.get(shell.ownerAgentId) ?? [];
			list.push(shell);
			byAgent.set(shell.ownerAgentId, list);
		}
	}
	return byAgent;
}

/**
 * ペインのピル・シートに出すシェル。Workflow の子が起動したものはカードへ寄せたので外す（Workflow の一覧が無い＝古い PC
 * なら全部のまま）。
 */
export function paneShells(shells: readonly AgentShell[] | undefined, workflows: readonly AgentWorkflow[] | undefined): AgentShell[] | undefined {
	if (shells === undefined || workflows === undefined || workflows.length === 0) {
		return shells === undefined ? undefined : [...shells];
	}
	const owned = new Set(workflows.flatMap(workflow => workflow.agents.map(agent => agent.id)));
	return shells.filter(shell => shell.ownerAgentId === undefined || !owned.has(shell.ownerAgentId));
}

/** トークの Workflow の行（起動の tool_use の ID）に当たる実行。 */
export function workflowForToolUse(workflows: readonly AgentWorkflow[] | undefined, toolUseId: string | undefined): AgentWorkflow | undefined {
	return toolUseId === undefined ? undefined : workflows?.find(workflow => workflow.toolUseId === toolUseId);
}

/** 経過・所要時間（「38分」「1時間20分」「42秒」）。 */
export function formatWorkflowDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) {
		return `${seconds}秒`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}分`;
	}
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours}時間` : `${hours}時間${minutes % 60}分`;
}

/** トークン数（「38,452」「4.2M」「910k」）。 */
export function formatWorkflowTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 10_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}
	return tokens.toLocaleString('en-US');
}

/** 経過（動いていれば今まで、終わっていれば所要時間）。 */
export function workflowElapsedMs(workflow: Pick<AgentWorkflow, 'status' | 'startedAt' | 'endedAt' | 'durationMs'>, now: number): number {
	if (workflow.durationMs !== undefined && workflow.status !== 'running') {
		return workflow.durationMs;
	}
	return Math.max(0, (workflow.endedAt ?? now) - workflow.startedAt);
}

/** カードの小さなチップ（モックの順: 段階・子・失敗・トークン・ツール・経過・シェル）。 */
export interface WorkflowChip {
	readonly key: string;
	readonly text: string;
	readonly tone?: 'red' | 'yellow';
}

export function workflowChips(workflow: AgentWorkflow, now: number, shellCount: number): WorkflowChip[] {
	const { phases, current } = workflowPhaseViews(workflow);
	const chips: WorkflowChip[] = [];
	const phase = phases[current];
	if (phase !== undefined && workflow.phases.length > 0) {
		chips.push({ key: 'phase', text: `段階 ${Math.min(current + 1, workflow.phases.length)}/${workflow.phases.length} ${phase.title}` });
	}
	chips.push({ key: 'agents', text: `子 ${workflow.agentCount}${workflow.counts.running > 0 ? `（実行中 ${workflow.counts.running}）` : ''}` });
	if (workflow.counts.failed > 0) {
		chips.push({ key: 'failed', text: `失敗 ${workflow.counts.failed}`, tone: 'red' });
	}
	if (workflow.totalTokens !== undefined) {
		chips.push({ key: 'tokens', text: `${formatWorkflowTokens(workflow.totalTokens)} tokens` });
	}
	if (workflow.totalToolCalls !== undefined) {
		chips.push({ key: 'tools', text: `ツール ${workflow.totalToolCalls.toLocaleString('en-US')}` });
	}
	chips.push({ key: 'elapsed', text: formatWorkflowDuration(workflowElapsedMs(workflow, now)) });
	if (shellCount > 0) {
		chips.push({ key: 'shells', text: `シェル ${shellCount}`, tone: 'yellow' });
	}
	return chips;
}

/** 子の行の下の 1 行（経過・最後のツール・シェル。待ちなら説明）。 */
export function workflowAgentMeta(agent: AgentWorkflowAgent, now: number, shells: readonly AgentShell[] | undefined): string {
	const parts: string[] = [];
	if (agent.durationMs !== undefined) {
		parts.push(formatWorkflowDuration(agent.durationMs));
	} else if (agent.state === 'running' && agent.startedAt !== undefined) {
		parts.push(formatWorkflowDuration(now - agent.startedAt));
	}
	if (agent.cached === true) {
		parts.push('前回の結果');
	}
	if (agent.state === 'running' && agent.lastTool !== undefined) {
		parts.push(`最後: ${agent.lastTool}`);
	}
	if (agent.tokens !== undefined) {
		parts.push(`${formatWorkflowTokens(agent.tokens)} tokens`);
	}
	const running = (shells ?? []).filter(shell => shell.status === 'running');
	if (running.length > 0) {
		parts.push(`シェル: ${running.map(shell => shell.description ?? shell.command ?? shell.id).join(', ')}`);
	}
	return parts.join(' · ');
}

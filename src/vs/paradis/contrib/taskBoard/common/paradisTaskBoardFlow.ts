/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	ITaskBoardFlow,
	ITaskBoardIntake,
	ITaskBoardStep,
	ITaskBoardWorkspacePolicy,
	TASK_BOARD_DONE,
	TASK_BOARD_TODO,
	TaskBoardFlowScope,
	TaskBoardIntakeSource,
	TaskBoardStepAgent,
	TaskBoardStepKind,
} from './paradisTaskBoard.js';

/*
 * フロー定義の既定値・検証・保存形式。
 *
 * 保存先（Q346 A）:
 * - チーム共通: `<repo>/.para-code/paracode.json` の `workflows`
 * - 個人: `<repo>/.para-code/<GitHub のユーザー名>/workflows.json` の `workflows`
 * - 旧 `<repo>/.paracode.json` の `workflows` は、新しい共通ファイルが無いときだけ読む
 * 同じ id のフローは個人が共通より優先する。
 */

export const TASK_BOARD_MAX_STEPS = 24;
export const TASK_BOARD_MAX_RUNNING = 12;

export const TASK_BOARD_DEFAULT_FLOW: ITaskBoardFlow = {
	id: 'default',
	name: '標準',
	scope: 'builtin',
	intake: { source: 'github-issues', todoValues: ['Todo'] },
	workspace: { kind: 'clone-pool', releaseOn: 'pr-opened', maxRunning: 4 },
	steps: [
		{ id: 'plan', name: '調査・計画', kind: 'agent', agent: 'any', prompt: '{issue} を調査して計画を書いて。迷う点は board_ask_human で聞いて', onFail: '' },
		{ id: 'approve', name: '計画の承認', kind: 'human', gate: 'approve', onFail: 'plan' },
		{ id: 'build', name: '実装', kind: 'agent', agent: 'any', prompt: '承認された計画どおりに実装して' },
		{ id: 'review', name: 'レビュー', kind: 'agent', agent: 'codex', prompt: '差分をレビューして、指摘があれば直して', onFail: 'build' },
		{ id: 'pr', name: 'ドラフト PR', kind: 'run', run: 'draft-pr' },
		{ id: 'bot', name: 'レビューボット', kind: 'wait', wait: 'review', onFail: 'build' },
		{ id: 'e2e', name: 'E2E', kind: 'run', run: 'command', command: 'scripts/test-integration.sh', onFail: 'build' },
		{ id: 'shots', name: 'スクショ添付', kind: 'agent', agent: 'any', prompt: '変更した画面のスクショを撮って PR に添付して' },
		{ id: 'merge', name: 'マージ', kind: 'human', gate: 'merge', onFail: 'build' },
	],
};

const STEP_KINDS: readonly TaskBoardStepKind[] = ['agent', 'human', 'run', 'wait'];
const STEP_AGENTS: readonly TaskBoardStepAgent[] = ['any', 'claude', 'codex'];
const INTAKE_SOURCES: readonly TaskBoardIntakeSource[] = ['github-project', 'github-issues', 'none'];
const RESERVED_STEP_IDS = new Set([TASK_BOARD_TODO, TASK_BOARD_DONE]);

export interface ITaskBoardFlowProblem {
	readonly path: string;
	readonly message: string;
}

export interface ITaskBoardFlowParseResult {
	readonly flows: ITaskBoardFlow[];
	readonly problems: ITaskBoardFlowProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 工程の id に使える形へ寄せる（英小文字・数字・ハイフン）。 */
export function taskBoardSlug(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || 'step';
}

function parseStep(raw: unknown, index: number, path: string, problems: ITaskBoardFlowProblem[], used: Set<string>): ITaskBoardStep | undefined {
	if (!isRecord(raw)) {
		problems.push({ path, message: 'step must be an object' });
		return undefined;
	}
	const kind = STEP_KINDS.find(k => k === raw.kind);
	if (!kind) {
		problems.push({ path: `${path}.kind`, message: `unknown kind: ${String(raw.kind)}` });
		return undefined;
	}
	const name = str(raw.name) ?? `step ${index + 1}`;
	let id = taskBoardSlug(str(raw.id) ?? name);
	if (RESERVED_STEP_IDS.has(id)) {
		id = `${id}-step`;
	}
	let unique = id;
	for (let n = 2; used.has(unique); n++) {
		unique = `${id}-${n}`;
	}
	if (unique !== str(raw.id) && raw.id !== undefined) {
		problems.push({ path: `${path}.id`, message: `id changed to ${unique}` });
	}
	used.add(unique);
	const step: { -readonly [K in keyof ITaskBoardStep]: ITaskBoardStep[K] } = { id: unique, name, kind };
	const onFail = str(raw.onFail);
	if (onFail) {
		step.onFail = onFail;
	}
	const projectOption = str(raw.projectOption);
	if (projectOption) {
		step.projectOption = projectOption;
	}
	if (kind === 'agent') {
		step.agent = STEP_AGENTS.find(a => a === raw.agent) ?? 'any';
		step.prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
	} else if (kind === 'human') {
		step.gate = raw.gate === 'merge' ? 'merge' : 'approve';
		if (typeof raw.prompt === 'string') {
			step.prompt = raw.prompt;
		}
	} else if (kind === 'run') {
		step.run = raw.run === 'draft-pr' ? 'draft-pr' : 'command';
		if (step.run === 'command') {
			step.command = typeof raw.command === 'string' ? raw.command : '';
		}
	} else {
		step.wait = raw.wait === 'checks' ? 'checks' : 'review';
	}
	return step;
}

function parseIntake(raw: unknown): ITaskBoardIntake {
	if (!isRecord(raw)) {
		return { source: 'none' };
	}
	const source = INTAKE_SOURCES.find(s => s === raw.source) ?? 'none';
	const project = typeof raw.project === 'number' && Number.isInteger(raw.project) && raw.project > 0 ? raw.project : undefined;
	const todoValues = Array.isArray(raw.todoValues) ? raw.todoValues.filter((v): v is string => typeof v === 'string' && v.length > 0) : undefined;
	return {
		source,
		owner: str(raw.owner),
		repo: str(raw.repo),
		project,
		statusField: str(raw.statusField),
		todoValues: todoValues && todoValues.length ? todoValues : undefined,
		dueField: str(raw.dueField),
		priorityField: str(raw.priorityField),
		stageField: str(raw.stageField),
		doneOption: str(raw.doneOption),
		writeBack: typeof raw.writeBack === 'boolean' ? raw.writeBack : undefined,
	};
}

function parseWorkspace(raw: unknown): ITaskBoardWorkspacePolicy {
	const fallback = TASK_BOARD_DEFAULT_FLOW.workspace;
	if (!isRecord(raw)) {
		return fallback;
	}
	const max = typeof raw.maxRunning === 'number' && Number.isFinite(raw.maxRunning) ? Math.round(raw.maxRunning) : fallback.maxRunning;
	return {
		kind: raw.kind === 'worktree' ? 'worktree' : 'clone-pool',
		releaseOn: raw.releaseOn === 'merged' ? 'merged' : 'pr-opened',
		maxRunning: Math.min(TASK_BOARD_MAX_RUNNING, Math.max(1, max)),
		...(raw.commit === 'agent' || raw.commit === 'board' ? { commit: raw.commit } : {}),
	};
}

/** 1 つのフローを検証して正規化する。直せないときは undefined。 */
export function parseTaskBoardFlow(raw: unknown, scope: TaskBoardFlowScope, path: string, problems: ITaskBoardFlowProblem[]): ITaskBoardFlow | undefined {
	if (!isRecord(raw)) {
		problems.push({ path, message: 'flow must be an object' });
		return undefined;
	}
	const name = str(raw.name);
	if (!name) {
		problems.push({ path: `${path}.name`, message: 'name is required' });
		return undefined;
	}
	const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, TASK_BOARD_MAX_STEPS) : [];
	const used = new Set<string>();
	const steps = rawSteps.map((s, i) => parseStep(s, i, `${path}.steps[${i}]`, problems, used)).filter((s): s is ITaskBoardStep => Boolean(s));
	if (!steps.length) {
		problems.push({ path: `${path}.steps`, message: 'at least one step is required' });
		return undefined;
	}
	// 差し戻し先が無い工程を指していたら外す
	const ids = new Set(steps.map(s => s.id));
	const fixed = steps.map(s => {
		if (s.onFail && (!ids.has(s.onFail) || s.onFail === s.id)) {
			problems.push({ path: `${path}.steps.${s.id}.onFail`, message: `unknown step: ${s.onFail}` });
			const { onFail: _drop, ...rest } = s;
			return rest;
		}
		return s;
	});
	return {
		id: taskBoardSlug(str(raw.id) ?? name),
		name,
		scope,
		intake: parseIntake(raw.intake),
		workspace: parseWorkspace(raw.workspace),
		steps: fixed,
	};
}

/** `{ "workflows": [...] }` を読む。 */
export function parseTaskBoardFlowFile(raw: unknown, scope: TaskBoardFlowScope, file: string): ITaskBoardFlowParseResult {
	const problems: ITaskBoardFlowProblem[] = [];
	const flows: ITaskBoardFlow[] = [];
	if (!isRecord(raw)) {
		return { flows, problems: [{ path: file, message: 'file must contain an object' }] };
	}
	const list = raw.workflows;
	if (list === undefined) {
		return { flows, problems };
	}
	if (!Array.isArray(list)) {
		return { flows, problems: [{ path: `${file}#workflows`, message: 'workflows must be an array' }] };
	}
	const seen = new Set<string>();
	list.forEach((item, i) => {
		const flow = parseTaskBoardFlow(item, scope, `${file}#workflows[${i}]`, problems);
		if (flow && !seen.has(flow.id)) {
			seen.add(flow.id);
			flows.push(flow);
		}
	});
	return { flows, problems };
}

/** 保存用の形（scope は保存先で決まるので書かない）。 */
export function serializeTaskBoardFlow(flow: ITaskBoardFlow): Record<string, unknown> {
	return {
		id: flow.id,
		name: flow.name,
		intake: Object.fromEntries(Object.entries(flow.intake).filter(([, v]) => v !== undefined)),
		workspace: flow.workspace,
		steps: flow.steps.map(s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''))),
	};
}

/** 組み込み・共通・個人を重ねる。同じ id は後のものが勝つ。並びは最初に現れた順。 */
export function mergeTaskBoardFlows(...layers: readonly (readonly ITaskBoardFlow[])[]): ITaskBoardFlow[] {
	const order: string[] = [];
	const byId = new Map<string, ITaskBoardFlow>();
	for (const layer of layers) {
		for (const flow of layer) {
			if (!byId.has(flow.id)) {
				order.push(flow.id);
			}
			byId.set(flow.id, flow);
		}
	}
	return order.map(id => byId.get(id)!);
}

/* ---------------- Projects の欄と工程の対応 ---------------- */

export interface ITaskBoardOptionLike {
	readonly name: string;
	readonly description?: string;
}

/**
 * 軸の欄の選択肢 1 つを、どの種類の工程にするか推測する（名前と説明から）。
 * 'done' は完了に当たる選択肢、'skip' は未着手など工程にしないもの。
 */
export function taskBoardGuessStepKind(option: ITaskBoardOptionLike): Pick<ITaskBoardStep, 'kind' | 'agent' | 'gate' | 'run' | 'wait'> | 'done' | 'skip' {
	const text = `${option.name} ${option.description ?? ''}`.toLowerCase();
	const name = option.name.toLowerCase();
	if (/^(done|完了|closed|merged)$/.test(name) || /^done\b/.test(name)) {
		return 'done';
	}
	if (/^(todo|backlog|未着手|icebox|triage)$/.test(name)) {
		return 'skip';
	}
	const description = (option.description ?? '').toLowerCase();
	// 説明文は「承認待ち」のような言い回しのときだけ見る（「承認された方針に沿って…」を承認の工程と取り違えない）
	if (/plan review|承認|approv|sign.?off/.test(name) || /承認待ち|承認を待|awaiting approval|needs approval/.test(description)) {
		return { kind: 'human', gate: 'approve' };
	}
	if (/merge|マージ待ち/.test(name)) {
		return { kind: 'human', gate: 'merge' };
	}
	if (/pr created|pr を作成|pull request created|draft pr|ドラフト pr/.test(text)) {
		return { kind: 'run', run: 'draft-pr' };
	}
	if (/local review|待って|waiting|待ち|ci の結果|checks?/.test(text) && !/対応|address|fix/.test(text)) {
		return { kind: 'wait', wait: /ci|check|チェック/.test(text) && !/review|レビュー/.test(text) ? 'checks' : 'review' };
	}
	return { kind: 'agent', agent: 'any' };
}

/** 軸の欄の選択肢から工程を組む。選択肢の名前を工程の名前と projectOption に使う。 */
export function taskBoardStepsFromOptions(options: readonly ITaskBoardOptionLike[]): { steps: ITaskBoardStep[]; doneOption?: string } {
	const used = new Set<string>();
	const steps: ITaskBoardStep[] = [];
	let doneOption: string | undefined;
	for (const option of options) {
		const guess = taskBoardGuessStepKind(option);
		if (guess === 'done') {
			doneOption ??= option.name;
			continue;
		}
		if (guess === 'skip') {
			continue;
		}
		let id = taskBoardSlug(option.name);
		for (let n = 2; used.has(id) || RESERVED_STEP_IDS.has(id); n++) {
			id = `${taskBoardSlug(option.name)}-${n}`;
		}
		used.add(id);
		const step: { -readonly [K in keyof ITaskBoardStep]: ITaskBoardStep[K] } = { id, name: option.name, projectOption: option.name, ...guess };
		if (guess.kind === 'agent') {
			step.prompt = `{issue} について「${option.name}」を進めて。${option.description ? `（${option.description}）` : ''}`;
		}
		steps.push(step);
	}
	// 待ちや承認の工程の差し戻し先は、直前のエージェントの工程にする
	for (let i = 0; i < steps.length; i++) {
		if (steps[i].kind !== 'agent') {
			const back = [...steps.slice(0, i)].reverse().find(s => s.kind === 'agent');
			if (back) {
				steps[i] = { ...steps[i], onFail: back.id };
			}
		}
	}
	return { steps, doneOption };
}

export function taskBoardStepIndex(flow: ITaskBoardFlow, stepId: string): number {
	return flow.steps.findIndex(s => s.id === stepId);
}

/**
 * タスクの位置を 0 始まりの数で表す。todo は -1、done は工程数。
 * 工程が見つからないときは undefined。
 */
export function taskBoardPosition(flow: ITaskBoardFlow, stepId: string): number | undefined {
	if (stepId === TASK_BOARD_TODO) {
		return -1;
	}
	if (stepId === TASK_BOARD_DONE) {
		return flow.steps.length;
	}
	const index = taskBoardStepIndex(flow, stepId);
	return index >= 0 ? index : undefined;
}

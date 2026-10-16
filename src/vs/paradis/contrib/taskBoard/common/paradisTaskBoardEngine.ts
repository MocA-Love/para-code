/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	ITaskBoardActivity,
	ITaskBoardArtifact,
	ITaskBoardFlow,
	ITaskBoardHistoryEntry,
	ITaskBoardIssueRef,
	ITaskBoardLabel,
	ITaskBoardNotice,
	ITaskBoardPrRef,
	ITaskBoardQuestion,
	ITaskBoardQuestionOption,
	ITaskBoardSlot,
	ITaskBoardStep,
	ITaskBoardTask,
	TASK_BOARD_DONE,
	TASK_BOARD_TODO,
	TaskBoardActivityKind,
	TaskBoardAgentKind,
	TaskBoardArtifactKind,
	TaskBoardError,
	TaskBoardHistoryResult,
	TaskBoardNoticeKind,
	TaskBoardTaskSource,
} from './paradisTaskBoard.js';
import { TASK_BOARD_DEFAULT_FLOW, taskBoardPosition, taskBoardStepIndex } from './paradisTaskBoardFlow.js';

/*
 * タスクボードのエンジン。台帳を持ち、工程の進め方と作業場所の貸し出しを決める。
 *
 * 時計・id・エージェント・コマンド実行・作業場所の準備は「口（port）」として外から渡す。
 * 開発用サーバーではシミュレーション、Para Code では本物の実装を渡す。
 *
 * 遅れて届く報告の扱い: タスクは工程に入るたびに試行番号（attempt）を 1 増やす。口からの報告と
 * 作業場所の準備の結果は、始めたときの試行番号で照合し、違えば捨てる。やり直し・差し戻し・中止の後に
 * 前の試行の報告が届いても、台帳は動かない。
 *
 * 作業場所の返却は、その作業場所の準備（git 操作）が終わるのを待ってから行い、返し終えるまでは
 * ほかのタスクに貸さない（準備と片付けが同じディレクトリで並んで走らないように）。
 */

const MAX_ACTIVITIES = 200;
const MAX_LOG_LINES = 400;
const MAX_ARTIFACTS = 60;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 20000;
/** 準備の終わりを待つ上限。口が応答しなくても、作業場所を永久に抱えないように。 */
const PREPARE_WAIT_MS = 5 * 60 * 1000;

/** エージェント工程の指示の末尾に足す、報告の仕方。 */
export const TASK_BOARD_PROMPT_SUFFIX = '計画・モック・スクショ・報告などのファイルは、作業場所の .para/ に置いて（git には入れない）。この工程が終わったら、成果物（そのファイルの path か本文）を添えて para-browser の board_complete_step で報告して。人に決めてほしいことがあれば board_ask_human で聞いて、ターンを終えて回答を待って。';

/** コミットをエージェントに任せるフローで、指示に書き足す一言。 */
export const TASK_BOARD_COMMIT_PROMPT = 'ファイルを変更したら、タスクのブランチにコミットして（push と PR の作成はボードが行うので、しないで）。.para/ の中はコミットしないで。';

/** 報告を忘れて止まったエージェントへ送る一言。 */
export const TASK_BOARD_NUDGE_PROMPT = 'この工程が終わっていれば、成果物を添えて board_complete_step を呼んでください。終わっていなければ続けてください。';

export interface ITaskBoardAgentPort {
	/** 工程を始めさせる。終わりは reportStepComplete などで、task.attempt を添えて返ってくる。 */
	startStep(task: ITaskBoardTask, step: ITaskBoardStep, prompt: string): void;
	answer(task: ITaskBoardTask, question: ITaskBoardQuestion, answer: string): void;
	sendInput(task: ITaskBoardTask, text: string): void;
	sendKey(task: ITaskBoardTask, key: string): void;
	stop(task: ITaskBoardTask): void;
}

export interface ITaskBoardRunPort {
	/** run 工程を実行する。結果は reportRunResult で、task.attempt を添えて返ってくる。 */
	run(task: ITaskBoardTask, step: ITaskBoardStep): void;
	/** 実行中の run 工程を止める（やり直し・差し戻し・中止のとき）。 */
	cancel(task: ITaskBoardTask): void;
}

/** 作業場所の準備の失敗。dirty は未コミットの変更があって使えない作業場所。 */
export class TaskBoardWorkspaceError extends Error {
	readonly reason: 'dirty' | 'missing' | 'other';
	constructor(message: string, reason: 'dirty' | 'missing' | 'other' = 'other') {
		super(message);
		this.reason = reason;
		this.name = 'TaskBoardWorkspaceError';
	}
}

export interface ITaskBoardWorkspacePort {
	/** 借りた作業場所を、ブランチ `branch` で使える状態にする（リモートに同名のブランチがあればそれを追う）。 */
	prepare(task: ITaskBoardTask, slot: ITaskBoardSlot, branch: string): Promise<{ readonly branch: string; readonly path?: string }>;
	/** 返した作業場所を片付ける（ワークツリーなら消す）。失敗しても台帳は返却済みとして扱う。 */
	release(task: ITaskBoardTask, slot: ITaskBoardSlot): Promise<void>;
}

export interface ITaskBoardEngineOptions {
	readonly clock: () => number;
	readonly newId: () => string;
	readonly agents: ITaskBoardAgentPort;
	readonly runner: ITaskBoardRunPort;
	readonly workspaces: ITaskBoardWorkspacePort;
}

export interface ITaskBoardIntakeItem {
	readonly issue: ITaskBoardIssueRef;
	readonly title: string;
	readonly labels: readonly ITaskBoardLabel[];
	readonly assignees: readonly string[];
	readonly avatars?: Readonly<Record<string, string>>;
	readonly due?: string;
	readonly priority?: string;
	readonly projectStatus?: string;
	readonly projectItemId?: string;
	readonly projectStage?: string;
	readonly body?: string;
}

export interface ITaskBoardQuestionInput {
	readonly kind?: 'question' | 'permission';
	readonly text: string;
	readonly options: readonly ITaskBoardQuestionOption[];
	readonly allowText?: boolean;
}

export interface ITaskBoardArtifactInput {
	readonly kind: TaskBoardArtifactKind;
	readonly title: string;
	readonly path?: string;
	readonly content?: string;
}

export interface ITaskBoardRunResult {
	readonly ok: boolean;
	readonly detail?: string;
	readonly log?: readonly string[];
	readonly pr?: ITaskBoardPrRef;
	/** PR を作れなかった理由が、作業場所の未コミットの変更（ファイルの一覧）。 */
	readonly uncommitted?: readonly string[];
	/** そのうち、git が追跡していない新しいファイル。 */
	readonly untracked?: readonly string[];
}

export interface ITaskBoardPersisted {
	readonly version: 1;
	readonly activeFlowId: string;
	readonly tasks: readonly ITaskBoardTask[];
	/** ワークツリーの作業場所のパス（タスク id ごと）。再起動の後も同じ作業場所で続けられるように。 */
	readonly worktreePaths?: Readonly<Record<string, string>>;
}

interface IStepInput {
	readonly prompt?: string;
	readonly feedback?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface ITaskRecord extends Mutable<Omit<ITaskBoardTask, 'activities' | 'history' | 'artifacts' | 'log' | 'labels' | 'assignees'>> {
	activities: ITaskBoardActivity[];
	history: ITaskBoardHistoryEntry[];
	artifacts: ITaskBoardArtifact[];
	log: string[];
	labels: ITaskBoardLabel[];
	assignees: string[];
}

const ACTIVE_AGENT_STATUSES = new Set(['working', 'question', 'permission', 'stalled', 'preparing']);

function clip(text: string, max = MAX_TEXT): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `promise` が終わるか `ms` 経つまで待つ（待ち終えたらタイマーは片付ける）。 */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		void promise.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function issueKey(issue: ITaskBoardIssueRef): string {
	return `gh:${issue.owner}/${issue.repo}#${issue.number}`.toLowerCase();
}

/** 作業場所（ディレクトリ）を借りて行う工程か。エージェントと、任意のコマンドを走らせる run 工程。 */
/** 作業場所が要る工程。ドラフト PR も、作業場所の変更をコミットして送るので作業場所で動かす。 */
export function taskBoardStepNeedsPlace(step: ITaskBoardStep): boolean {
	return step.kind === 'agent' || step.kind === 'run';
}

function sameStepShape(a: ITaskBoardStep, b: ITaskBoardStep): boolean {
	return a.kind === b.kind && a.run === b.run && a.wait === b.wait && a.gate === b.gate;
}

export class TaskBoardEngine {

	private readonly tasks = new Map<string, ITaskRecord>();
	private flows: ITaskBoardFlow[] = [TASK_BOARD_DEFAULT_FLOW];
	private activeFlowId = TASK_BOARD_DEFAULT_FLOW.id;
	private poolSlots: ITaskBoardSlot[] = [];
	/** ワークツリー方式で借りるたびに作る作業場所。タスクの id で引く。 */
	private readonly worktreeSlots = new Map<string, ITaskBoardSlot>();
	/** 準備（git 操作）中の作業場所。返却はこれが終わるのを待つ。 */
	private readonly preparing = new Map<string, Promise<void>>();
	/** 片付け中の作業場所。終わるまでほかのタスクに貸さない。 */
	private readonly releasing = new Set<string>();
	private readonly changeListeners = new Set<() => void>();
	private readonly noticeListeners = new Set<(notice: ITaskBoardNotice) => void>();
	private version = 0;

	constructor(private readonly options: ITaskBoardEngineOptions) { }

	/* ---------------- 購読 ---------------- */

	onDidChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	onDidNotice(listener: (notice: ITaskBoardNotice) => void): () => void {
		this.noticeListeners.add(listener);
		return () => this.noticeListeners.delete(listener);
	}

	private changed(): void {
		this.version++;
		for (const listener of [...this.changeListeners]) {
			listener();
		}
	}

	private notice(kind: TaskBoardNoticeKind, task?: ITaskRecord, detail?: string): void {
		const notice: ITaskBoardNotice = { id: this.options.newId(), kind, at: this.now(), taskId: task?.id, stepId: task?.step, detail };
		for (const listener of [...this.noticeListeners]) {
			listener(notice);
		}
	}

	private now(): number {
		return this.options.clock();
	}

	/* ---------------- 読み取り ---------------- */

	getVersion(): number {
		return this.version;
	}

	getTasks(): ITaskBoardTask[] {
		return [...this.tasks.values()].map(t => ({ ...t, activities: [...t.activities], history: [...t.history], artifacts: [...t.artifacts], log: [...t.log], labels: [...t.labels], assignees: [...t.assignees] }));
	}

	getTask(taskId: string): ITaskBoardTask | undefined {
		return this.tasks.get(taskId);
	}

	getFlows(): readonly ITaskBoardFlow[] {
		return this.flows;
	}

	getActiveFlowId(): string {
		return this.activeFlowId;
	}

	getActiveFlow(): ITaskBoardFlow {
		return this.flows.find(f => f.id === this.activeFlowId) ?? this.flows[0];
	}

	getSlots(): ITaskBoardSlot[] {
		const holders = new Map([...this.tasks.values()].filter(t => t.place).map(t => [t.place!, t.id]));
		return [...this.poolSlots.map(s => ({ ...s, leasedBy: holders.get(s.id) })), ...this.worktreeSlots.values()];
	}

	/** 作業場所を借りているタスクの数（フロー外から取り込んだものは数えない）。 */
	getLeaseCount(): number {
		return [...this.tasks.values()].filter(t => t.place && !t.place.startsWith('manual:')).length;
	}

	flowOf(task: ITaskBoardTask): ITaskBoardFlow {
		return this.flows.find(f => f.id === task.flowId) ?? this.getActiveFlow();
	}

	private require(taskId: string): ITaskRecord {
		const task = this.tasks.get(taskId);
		if (!task) {
			throw new TaskBoardError('not-found', `task not found: ${taskId}`);
		}
		return task;
	}

	/** 画面の確認ダイアログを開いた後に工程が進んでいたら断る（古い画面からの操作で別の工程を動かさない）。 */
	private expectStep(task: ITaskRecord, from: string | undefined, attempt?: number): void {
		if ((from !== undefined && task.step !== from) || (attempt !== undefined && task.attempt !== attempt)) {
			throw new TaskBoardError('invalid-state', `the task has moved on (now in ${task.step})`);
		}
	}

	private stepOf(task: ITaskBoardTask): ITaskBoardStep | undefined {
		return this.flowOf(task).steps.find(s => s.id === task.step);
	}

	/* ---------------- 設定 ---------------- */

	/**
	 * フローを差し替える。進行中のタスクがいる工程を消す変更や、その工程の種類を変える変更は拒む。
	 * `force` は起動時の読み込み用で、行き場の無いタスクを未着手へ戻す。
	 */
	setFlows(flows: readonly ITaskBoardFlow[], activeFlowId?: string, force = false): void {
		const next = flows.length ? [...flows] : [TASK_BOARD_DEFAULT_FLOW];
		if (!force) {
			for (const task of this.tasks.values()) {
				if (task.step === TASK_BOARD_TODO || task.step === TASK_BOARD_DONE) {
					continue;
				}
				const before = this.stepOf(task);
				const step = next.find(f => f.id === task.flowId)?.steps.find(s => s.id === task.step);
				if (!step || (before && !sameStepShape(before, step))) {
					throw new TaskBoardError('step-in-use', `task ${task.id} is in step ${task.step}`);
				}
			}
		}
		this.flows = next;
		const wanted = activeFlowId ?? this.activeFlowId;
		this.activeFlowId = next.some(f => f.id === wanted) ? wanted : next[0].id;
		this.normalizeTasks();
		this.changed();
	}

	/** 行き場の無いタスク（フローや工程が消えた）を未着手へ戻す。 */
	private normalizeTasks(): void {
		for (const task of this.tasks.values()) {
			if (!this.flows.some(f => f.id === task.flowId)) {
				task.flowId = this.activeFlowId;
			}
			if (task.step !== TASK_BOARD_TODO && task.step !== TASK_BOARD_DONE && taskBoardStepIndex(this.flowOf(task), task.step) < 0) {
				this.releasePlace(task);
				task.step = TASK_BOARD_TODO;
				task.status = 'todo';
				task.question = undefined;
				task.pending = undefined;
				task.attempt++;
				this.activity(task, 'system', 'flow-changed');
			}
		}
	}

	setActiveFlow(flowId: string): void {
		if (!this.flows.some(f => f.id === flowId)) {
			throw new TaskBoardError('not-found', `flow not found: ${flowId}`);
		}
		this.activeFlowId = flowId;
		for (const task of this.tasks.values()) {
			if (task.step === TASK_BOARD_TODO) {
				task.flowId = flowId;
			}
		}
		this.changed();
	}

	/** クローンの使い回しで貸し出す作業場所を差し替える。貸し出し中のものは残す。 */
	setPoolSlots(slots: readonly ITaskBoardSlot[]): void {
		const leased = new Set([...this.tasks.values()].map(t => t.place).filter(Boolean));
		const kept = this.poolSlots.filter(s => leased.has(s.id) && !slots.some(n => n.id === s.id));
		this.poolSlots = [...slots.map(s => ({ ...s, leasedBy: undefined })), ...kept];
		this.dispatch();
		this.changed();
	}

	/* ---------------- 保存と復元 ---------------- */

	serialize(): ITaskBoardPersisted {
		const worktreePaths = Object.fromEntries([...this.worktreeSlots].filter(([, slot]) => slot.path).map(([taskId, slot]) => [taskId, slot.path]));
		return { version: 1, activeFlowId: this.activeFlowId, tasks: this.getTasks(), ...(Object.keys(worktreePaths).length ? { worktreePaths } : {}) };
	}

	/**
	 * 保存した台帳を読み込む。動いていたエージェントとコマンドはサーバーの再起動で消えているので、
	 * 作業中・準備中だったものは「報告なしで停止」（コマンドは失敗）にして人に見せる。
	 */
	restore(data: ITaskBoardPersisted): void {
		this.tasks.clear();
		this.worktreeSlots.clear();
		if (this.flows.some(f => f.id === data.activeFlowId)) {
			this.activeFlowId = data.activeFlowId;
		}
		for (const raw of data.tasks ?? []) {
			const task: ITaskRecord = {
				...raw,
				attempt: raw.attempt ?? 0,
				activities: [...(raw.activities ?? [])],
				history: [...(raw.history ?? [])],
				artifacts: [...(raw.artifacts ?? [])],
				log: [...(raw.log ?? [])],
				labels: [...(raw.labels ?? [])],
				assignees: [...(raw.assignees ?? [])],
			};
			this.tasks.set(task.id, task);
			if (task.status === 'working' || task.status === 'preparing') {
				task.status = this.stepOf(task)?.kind === 'agent' ? 'stalled' : 'failed';
				task.error = 'restarted';
				task.attempt++;
			}
			if (task.place?.startsWith('wt:')) {
				this.worktreeSlots.set(task.id, { id: task.place, name: task.branch ?? task.place, path: data.worktreePaths?.[task.id] ?? '', kind: 'worktree', leasedBy: task.id });
			}
		}
		this.normalizeTasks();
		this.dispatch();
		this.changed();
	}

	/* ---------------- タスクを足す ---------------- */

	private create(source: TaskBoardTaskSource, id: string, title: string, extra: Partial<ITaskRecord> = {}): ITaskRecord {
		const now = this.now();
		const task: ITaskRecord = {
			id,
			title: clip(title, 300),
			source,
			labels: [],
			assignees: [],
			flowId: this.activeFlowId,
			step: TASK_BOARD_TODO,
			status: 'todo',
			stepSince: now,
			attempt: 0,
			createdAt: now,
			updatedAt: now,
			activities: [],
			history: [],
			artifacts: [],
			log: [],
			...extra,
		};
		this.tasks.set(id, task);
		return task;
	}

	addTask(input: { title: string; due?: string; body?: string; labels?: readonly string[] }): string {
		const title = input.title?.trim();
		if (!title) {
			throw new TaskBoardError('invalid-params', 'title is required');
		}
		if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
			throw new TaskBoardError('invalid-params', 'due must be YYYY-MM-DD');
		}
		const id = `t-${this.options.newId()}`;
		this.create('manual', id, title, {
			due: input.due || undefined,
			body: input.body ? clip(input.body) : undefined,
			labels: (input.labels ?? []).filter(Boolean).map(name => ({ name })),
		});
		this.changed();
		return id;
	}

	/**
	 * 取り込み元の一覧を台帳へ反映する。新しいものは未着手で足し、既にあるものは中身だけ更新する。
	 * `complete` のときだけ、一覧から消えた未着手のものを外す（件数の上限で打ち切った一覧では外さない）。
	 */
	syncIntake(items: readonly ITaskBoardIntakeItem[], complete = true): { added: number; updated: number; removed: number } {
		const seen = new Set<string>();
		let added = 0;
		let updated = 0;
		let removed = 0;
		for (const item of items) {
			const id = issueKey(item.issue);
			seen.add(id);
			const existing = this.tasks.get(id);
			const meta = {
				title: clip(item.title, 300),
				issue: item.issue,
				labels: [...item.labels],
				assignees: [...item.assignees],
				avatars: item.avatars ?? existing?.avatars,
				due: item.due,
				priority: item.priority,
				projectStatus: item.projectStatus,
				projectItemId: item.projectItemId ?? existing?.projectItemId,
				projectStage: item.projectItemId ? item.projectStage : existing?.projectStage,
				body: item.body !== undefined ? clip(item.body) : existing?.body,
			};
			if (existing) {
				const before = JSON.stringify([existing.title, existing.labels, existing.assignees, existing.due, existing.priority, existing.projectStatus, existing.projectStage, existing.body]);
				Object.assign(existing, meta);
				if (before !== JSON.stringify([existing.title, existing.labels, existing.assignees, existing.due, existing.priority, existing.projectStatus, existing.projectStage, existing.body])) {
					existing.updatedAt = this.now();
					updated++;
				}
			} else {
				this.create('github', id, item.title, meta);
				added++;
			}
		}
		if (complete) {
			for (const task of [...this.tasks.values()]) {
				if (task.source === 'github' && task.step === TASK_BOARD_TODO && !seen.has(task.id)) {
					this.tasks.delete(task.id);
					removed++;
				}
			}
		}
		if (added || updated || removed) {
			this.changed();
		}
		return { added, updated, removed };
	}

	removeTask(taskId: string): void {
		const task = this.require(taskId);
		if (task.step !== TASK_BOARD_TODO && task.step !== TASK_BOARD_DONE) {
			throw new TaskBoardError('invalid-state', 'cancel the task before removing it');
		}
		if (task.source === 'github' && task.step === TASK_BOARD_TODO) {
			throw new TaskBoardError('invalid-state', 'tasks from GitHub are removed by the intake');
		}
		this.tasks.delete(taskId);
		this.changed();
	}

	/** 手で起動したエージェントを、フローの途中の工程にいるタスクとして取り込む。 */
	adopt(input: { sessionId: string; title: string; agent: TaskBoardAgentKind; branch?: string; place?: string }): string {
		const flow = this.getActiveFlow();
		const step = flow.steps.find(s => s.id === 'build' && s.kind === 'agent') ?? flow.steps.find(s => s.kind === 'agent') ?? flow.steps[0];
		const id = `a-${this.options.newId()}`;
		const task = this.create('adopted', id, input.title || input.sessionId, {
			agent: input.agent,
			branch: input.branch,
			place: `manual:${input.place ?? input.sessionId}`,
			step: step.id,
			status: step.kind === 'agent' ? 'working' : 'approval',
		});
		this.activity(task, 'system', 'adopted', input.sessionId);
		this.changed();
		return id;
	}

	/* ---------------- 工程を動かす ---------------- */

	/** 未着手のタスクに着手する。`stepId` を指定すると、その前の工程を飛ばす。 */
	start(taskId: string, input: { stepId?: string; agent: TaskBoardAgentKind; prompt?: string }): void {
		const task = this.require(taskId);
		if (task.step !== TASK_BOARD_TODO) {
			throw new TaskBoardError('invalid-state', 'task already started');
		}
		const flow = this.flowOf(task);
		const stepId = input.stepId ?? flow.steps[0].id;
		const index = taskBoardStepIndex(flow, stepId);
		if (index < 0) {
			throw new TaskBoardError('not-found', `step not found: ${stepId}`);
		}
		task.agent = input.agent;
		const now = this.now();
		for (const skipped of flow.steps.slice(0, index)) {
			task.history.push({ stepId: skipped.id, startedAt: now, endedAt: now, result: 'skipped' });
		}
		this.activity(task, 'system', 'started', flow.steps[index].name);
		this.enterStep(task, stepId, { prompt: input.prompt });
		this.notice('started', task);
		this.changed();
	}

	/**
	 * ボードでのドラッグ。確認は画面が済ませている前提で、移動先に応じて
	 * 着手・中止・完了・差し戻し・完了扱い・飛ばしのどれかにする。
	 */
	move(taskId: string, to: string, reason?: string, from?: string, attempt?: number): void {
		const task = this.require(taskId);
		this.expectStep(task, from, attempt);
		if (task.step === to) {
			return;
		}
		const flow = this.flowOf(task);
		const fromPos = taskBoardPosition(flow, task.step);
		const target = taskBoardPosition(flow, to);
		if (fromPos === undefined || target === undefined) {
			throw new TaskBoardError('not-found', `step not found: ${to}`);
		}
		if (task.step === TASK_BOARD_TODO) {
			if (to === TASK_BOARD_DONE) {
				this.finish(task, 'skipped');
				this.changed();
				return;
			}
			this.start(taskId, { stepId: to, agent: task.agent ?? 'claude' });
			return;
		}
		if (to === TASK_BOARD_TODO) {
			this.cancel(taskId);
			return;
		}
		if (to === TASK_BOARD_DONE) {
			this.markDone(taskId);
			return;
		}
		if (target < fromPos) {
			this.sendBack(taskId, to, reason);
			return;
		}
		if (target === fromPos + 1) {
			this.complete(taskId);
			return;
		}
		this.stopCurrent(task);
		this.closeStep(task, 'skipped', 'manual');
		const now = this.now();
		for (const skipped of flow.steps.slice(fromPos + 1, target)) {
			task.history.push({ stepId: skipped.id, startedAt: now, endedAt: now, result: 'skipped' });
		}
		this.enterStep(task, to);
		this.changed();
	}

	answer(taskId: string, questionId: string, input: { optionIndex?: number; text?: string }): void {
		const task = this.require(taskId);
		const question = task.question;
		if (!question || question.id !== questionId || (task.status !== 'question' && task.status !== 'permission')) {
			throw new TaskBoardError('invalid-state', 'the question is no longer open');
		}
		let text: string | undefined;
		if (input.optionIndex !== undefined) {
			text = question.options[input.optionIndex]?.label;
		} else if (input.text !== undefined && question.allowText) {
			text = input.text.trim();
		}
		if (!text) {
			throw new TaskBoardError('invalid-params', 'answer is empty');
		}
		task.question = undefined;
		task.status = 'working';
		task.activity = undefined;
		this.activity(task, 'answer', clip(text, 2000));
		this.options.agents.answer(task, question, text);
		this.touch(task);
	}

	approve(taskId: string, note?: string, from?: string, attempt?: number): void {
		const task = this.require(taskId);
		this.expectStep(task, from, attempt);
		const step = this.stepOf(task);
		if (task.status !== 'approval' || step?.kind !== 'human') {
			throw new TaskBoardError('invalid-state', 'nothing to approve');
		}
		if (note?.trim()) {
			this.activity(task, 'input', clip(note.trim(), 2000));
		}
		this.completeCurrent(task, 'done', note?.trim() || undefined);
		this.changed();
	}

	/** 差し戻す。`to` を省くと工程の差し戻し先、それも無ければ直前のエージェント工程。 */
	sendBack(taskId: string, to?: string, reason?: string, from?: string, attempt?: number): void {
		const task = this.require(taskId);
		this.expectStep(task, from, attempt);
		const flow = this.flowOf(task);
		const current = taskBoardStepIndex(flow, task.step);
		if (current < 0) {
			throw new TaskBoardError('invalid-state', 'task is not in a step');
		}
		const target = to ?? this.stepOf(task)?.onFail ?? [...flow.steps.slice(0, current)].reverse().find(s => s.kind === 'agent')?.id;
		const targetIndex = target ? taskBoardStepIndex(flow, target) : -1;
		if (targetIndex < 0 || targetIndex > current) {
			throw new TaskBoardError('invalid-params', 'no step to send back to');
		}
		const note = reason?.trim() || undefined;
		this.stopCurrent(task);
		this.closeStep(task, 'sentBack', note);
		if (note) {
			this.activity(task, 'input', clip(note, 2000), 'sendBack');
		}
		this.enterStep(task, flow.steps[targetIndex].id, { feedback: note });
		this.notice('sentBack', task, note);
		this.changed();
	}

	/** 今の工程を終わったことにして次へ進める。 */
	complete(taskId: string, from?: string, attempt?: number): void {
		const task = this.require(taskId);
		this.expectStep(task, from, attempt);
		if (!this.stepOf(task)) {
			throw new TaskBoardError('invalid-state', 'task is not in a step');
		}
		this.stopCurrent(task);
		this.completeCurrent(task, 'done', 'manual');
		this.changed();
	}

	/** 今の工程をやり直す（前の試行の報告は捨てる）。 */
	retry(taskId: string, from?: string, attempt?: number): void {
		const task = this.require(taskId);
		this.expectStep(task, from, attempt);
		if (!this.stepOf(task)) {
			throw new TaskBoardError('invalid-state', 'task is not in a step');
		}
		this.stopCurrent(task);
		this.enterStep(task, task.step, task.pending);
		this.changed();
	}

	cancel(taskId: string): void {
		const task = this.require(taskId);
		if (task.step === TASK_BOARD_TODO) {
			return;
		}
		this.stopCurrent(task);
		if (this.stepOf(task)) {
			this.closeStep(task, 'cancelled');
		}
		this.enterStep(task, TASK_BOARD_TODO);
		this.changed();
	}

	markDone(taskId: string): void {
		const task = this.require(taskId);
		this.stopCurrent(task);
		this.finish(task, 'done');
		this.changed();
	}

	/** 止まったエージェントに、報告を促す一言を送る。 */
	nudge(taskId: string): void {
		const task = this.require(taskId);
		if (task.status !== 'stalled') {
			throw new TaskBoardError('invalid-state', 'task is not stalled');
		}
		task.status = 'working';
		task.error = undefined;
		this.activity(task, 'input', 'nudge');
		this.options.agents.sendInput(task, TASK_BOARD_NUDGE_PROMPT);
		this.touch(task);
	}

	sendInput(taskId: string, text: string): void {
		const task = this.require(taskId);
		if (!task.place || !text.trim()) {
			throw new TaskBoardError('invalid-state', 'no agent to send to');
		}
		this.activity(task, 'input', clip(text.trim(), 2000));
		this.pushLog(task, [`› ${text.trim()}`]);
		this.options.agents.sendInput(task, text.trim());
		this.touch(task);
	}

	sendKey(taskId: string, key: string): void {
		const task = this.require(taskId);
		if (!task.place) {
			throw new TaskBoardError('invalid-state', 'no agent to send to');
		}
		this.pushLog(task, [`[key ${key}]`]);
		this.options.agents.sendKey(task, key);
		this.touch(task);
	}

	/* ---------------- 口からの報告（attempt で照合する） ---------------- */

	private live(taskId: string, attempt: number): ITaskRecord | undefined {
		const task = this.tasks.get(taskId);
		return task && task.attempt === attempt && task.status !== 'done' && task.status !== 'todo' ? task : undefined;
	}

	reportToolUse(taskId: string, attempt: number, label: string, detail?: string, contextPct?: number): void {
		const task = this.live(taskId, attempt);
		if (!task) {
			return;
		}
		this.activity(task, 'tool', clip(label, 200), detail ? clip(detail, 500) : undefined);
		if (contextPct !== undefined) {
			task.contextPct = Math.max(0, Math.min(100, Math.round(contextPct)));
		}
		if (task.status === 'stalled') {
			task.status = 'working';
		}
		this.touch(task);
	}

	reportMessage(taskId: string, attempt: number, text: string): void {
		const task = this.live(taskId, attempt);
		if (!task) {
			return;
		}
		task.activity = clip(text, 300);
		this.activity(task, 'message', clip(text, 2000));
		this.touch(task);
	}

	reportOutput(taskId: string, lines: readonly string[]): void {
		const task = this.tasks.get(taskId);
		if (!task) {
			return;
		}
		this.pushLog(task, lines);
		this.touch(task);
	}

	reportModel(taskId: string, model: string): void {
		const task = this.tasks.get(taskId);
		if (task && task.model !== model) {
			task.model = model;
			this.touch(task);
		}
	}

	reportQuestion(taskId: string, attempt: number, input: ITaskBoardQuestionInput): string | undefined {
		const task = this.live(taskId, attempt);
		if (!task) {
			return undefined;
		}
		const question: ITaskBoardQuestion = {
			id: this.options.newId(),
			kind: input.kind ?? 'question',
			text: clip(input.text, 4000),
			options: input.options.slice(0, 9).map(o => ({ label: clip(o.label, 300), detail: o.detail ? clip(o.detail, 600) : undefined, artifactId: o.artifactId })),
			allowText: input.allowText ?? true,
			askedAt: this.now(),
		};
		task.question = question;
		task.status = question.kind;
		this.activity(task, 'message', question.text, question.kind);
		this.notice(question.kind, task, question.text);
		this.touch(task);
		return question.id;
	}

	addArtifact(taskId: string, attempt: number, input: ITaskBoardArtifactInput): string | undefined {
		const task = this.live(taskId, attempt);
		if (!task) {
			return undefined;
		}
		if (input.content && input.content.length > MAX_ARTIFACT_BYTES) {
			throw new TaskBoardError('invalid-params', 'artifact is too large');
		}
		const artifact: ITaskBoardArtifact = { id: this.options.newId(), kind: input.kind, title: clip(input.title, 200), stepId: task.step, createdAt: this.now(), path: input.path, content: input.content };
		// 同じ工程・同じ種類・同じ題の成果物は差し替える（計画の書き直しなど）
		const same = task.artifacts.findIndex(a => a.stepId === task.step && a.kind === input.kind && a.title === artifact.title);
		if (same >= 0) {
			task.artifacts.splice(same, 1, artifact);
		} else {
			task.artifacts.push(artifact);
			if (task.artifacts.length > MAX_ARTIFACTS) {
				task.artifacts.splice(0, task.artifacts.length - MAX_ARTIFACTS);
			}
		}
		this.touch(task);
		return artifact.id;
	}

	reportStepComplete(taskId: string, attempt: number, input: { summary?: string; artifacts?: readonly ITaskBoardArtifactInput[] } = {}): boolean {
		const task = this.live(taskId, attempt);
		if (!task) {
			return false;
		}
		for (const artifact of input.artifacts ?? []) {
			this.addArtifact(taskId, attempt, artifact);
		}
		if (input.summary) {
			this.activity(task, 'message', clip(input.summary, 2000), 'summary');
		}
		this.completeCurrent(task, 'done', input.summary ? clip(input.summary, 300) : undefined);
		this.changed();
		return true;
	}

	/** エージェントのターンが complete_step 無しで終わった。 */
	reportIdle(taskId: string, attempt: number): void {
		const task = this.live(taskId, attempt);
		if (!task || task.status !== 'working' || this.stepOf(task)?.kind !== 'agent') {
			return;
		}
		task.status = 'stalled';
		this.notice('stalled', task);
		this.touch(task);
	}

	/** 回答をエージェントへ届けられなかった。まだ同じ試行で次の質問が来ていなければ、質問を出し直す。 */
	reportAnswerFailed(taskId: string, attempt: number, question: ITaskBoardQuestion, message: string): void {
		const task = this.live(taskId, attempt);
		if (!task || task.question || task.status !== 'working') {
			return;
		}
		task.question = question;
		task.status = question.kind;
		task.activity = undefined;
		this.activity(task, 'error', clip(message, 1000));
		this.notice(question.kind, task, clip(message, 1000));
		this.touch(task);
	}

	reportAgentError(taskId: string, attempt: number, message: string): void {
		const task = this.live(taskId, attempt);
		if (!task) {
			return;
		}
		task.status = 'failed';
		task.error = clip(message, 1000);
		this.activity(task, 'error', task.error);
		this.notice('failed', task, task.error);
		this.touch(task);
	}

	reportRunResult(taskId: string, attempt: number, result: ITaskBoardRunResult): void {
		const task = this.live(taskId, attempt);
		if (!task || task.status !== 'working') {
			return;
		}
		if (result.log?.length) {
			this.pushLog(task, result.log);
		}
		if (result.pr) {
			task.pr = result.pr;
			task.prOwned = true;
		}
		if (result.ok) {
			this.completeCurrent(task, 'done', result.detail);
		} else {
			task.status = 'failed';
			task.error = result.detail ? clip(result.detail, 1000) : 'failed';
			task.uncommitted = result.uncommitted?.length ? result.uncommitted.slice(0, 50) : undefined;
			task.untracked = result.untracked?.length ? result.untracked.slice(0, 50) : undefined;
			this.activity(task, 'error', task.error);
			this.notice('failed', task, task.error);
		}
		this.changed();
	}

	/**
	 * PR の状態が分かった（GitHub の見張り、またはシミュレーション）。
	 * 着手した後に初めて結び付いた PR は、このタスクの PR として工程の判定と作業場所の返却に使う。
	 * 取り込んだ時点で付いていた PR（ほかの人の PR かもしれない）は表示だけにする。
	 */
	reportPullRequest(taskId: string, pr: ITaskBoardPrRef): void {
		const task = this.tasks.get(taskId);
		if (!task) {
			return;
		}
		const key = (value: ITaskBoardPrRef | undefined) => value ? JSON.stringify({ ...value, updatedAt: undefined }) : '';
		if (key(task.pr) === key(pr)) {
			return;
		}
		// シミュレーションの PR と本物の PR は、番号が同じでも別物として扱う
		const samePr = task.pr && task.pr.number === pr.number && task.pr.repo === pr.repo && task.pr.owner === pr.owner && Boolean(task.pr.simulated) === Boolean(pr.simulated);
		if (task.pr && !samePr && task.prOwned) {
			// 自分の PR を持っている間は、ほかの PR（取り込みが選び直した古い PR など）で上書きしない。
			// 自分の PR が閉じられ、着手中に開いた新しい PR が付いたときだけ乗り換える
			const replacement = task.pr.state === 'closed' && (pr.state === 'open' || pr.state === 'draft') && task.step !== TASK_BOARD_TODO && task.step !== TASK_BOARD_DONE;
			if (!replacement) {
				return;
			}
		}
		if (!samePr) {
			task.prOwned = task.step !== TASK_BOARD_TODO;
		}
		task.pr = { ...pr, updatedAt: this.now() };
		this.evaluatePullRequest(task);
		this.touch(task);
	}

	/** 軸の欄の、GitHub 側の値を覚える（書き戻した後や、同期で読んだとき）。 */
	setProjectStage(taskId: string, value: string | undefined): void {
		const task = this.tasks.get(taskId);
		if (task && task.projectStage !== value) {
			task.projectStage = value;
			this.touch(task);
		}
	}

	/** 工程に対応する、軸の欄の選択肢（書き戻す値）。対応が無ければ undefined。 */
	desiredProjectStage(task: ITaskBoardTask): string | undefined {
		const flow = this.flowOf(task);
		if (!flow.intake.stageField) {
			return undefined;
		}
		if (task.step === TASK_BOARD_DONE) {
			return flow.intake.doneOption;
		}
		return flow.steps.find(s => s.id === task.step)?.projectOption;
	}

	setContext(taskId: string, pct: number): void {
		const task = this.tasks.get(taskId);
		if (task) {
			task.contextPct = Math.max(0, Math.min(100, Math.round(pct)));
			this.touch(task);
		}
	}

	/* ---------------- 内部 ---------------- */

	/**
	 * PR の状態で工程を進める。工程に入った直後の評価（`allowFail` = false）では、
	 * 前から付いている「変更を求める」レビューや失敗で即座に失敗へ戻さない（やり直しで待ち直せるように）。
	 */
	private evaluatePullRequest(task: ITaskRecord, allowFail = true): void {
		const pr = task.pr;
		if (!pr || !task.prOwned) {
			return;
		}
		if (pr.state === 'merged' && task.step !== TASK_BOARD_DONE && task.step !== TASK_BOARD_TODO) {
			this.activity(task, 'system', 'merged', `#${pr.number}`);
			this.stopCurrent(task);
			this.finish(task, 'done');
			return;
		}
		const step = this.stepOf(task);
		if (step?.kind !== 'wait' || task.status !== 'waiting') {
			return;
		}
		if (step.wait === 'review') {
			if (pr.review === 'changes') {
				if (allowFail) {
					this.waitFailed(task, step, 'changes-requested');
				}
			} else if (pr.review !== 'none') {
				this.completeCurrent(task, 'done', pr.review);
			}
			return;
		}
		if (pr.checks === 'success') {
			this.completeCurrent(task, 'done', 'checks');
		} else if (pr.checks === 'failure' && allowFail) {
			this.waitFailed(task, step, 'checks-failed');
		}
	}

	private waitFailed(task: ITaskRecord, step: ITaskBoardStep, reason: string): void {
		task.status = 'failed';
		task.error = reason;
		this.activity(task, 'error', reason, step.id);
		this.notice('failed', task, reason);
	}

	/** 今の工程で動いているエージェントやコマンドを止める。 */
	private stopCurrent(task: ITaskRecord): void {
		const step = this.stepOf(task);
		if (!step) {
			return;
		}
		if (step.kind === 'agent' && ACTIVE_AGENT_STATUSES.has(task.status)) {
			this.options.agents.stop(task);
		} else if (step.kind === 'run' && (task.status === 'working' || task.status === 'preparing')) {
			this.options.runner.cancel(task);
		}
	}

	private closeStep(task: ITaskRecord, result: TaskBoardHistoryResult, note?: string): void {
		const step = this.stepOf(task);
		if (!step) {
			return;
		}
		task.history.push({ stepId: step.id, startedAt: task.stepSince, endedAt: this.now(), result, note, agent: step.kind === 'agent' ? task.agent : undefined });
	}

	private completeCurrent(task: ITaskRecord, result: TaskBoardHistoryResult, note?: string): void {
		const flow = this.flowOf(task);
		const index = taskBoardStepIndex(flow, task.step);
		this.closeStep(task, result, note);
		const next = flow.steps[index + 1];
		this.enterStep(task, next ? next.id : TASK_BOARD_DONE);
	}

	private finish(task: ITaskRecord, result: TaskBoardHistoryResult): void {
		if (this.stepOf(task)) {
			this.closeStep(task, result);
		}
		this.enterStep(task, TASK_BOARD_DONE);
	}

	/** 工程に入る。試行番号を進め、前の試行の報告を受け付けなくする。 */
	private enterStep(task: ITaskRecord, stepId: string, input?: IStepInput): void {
		const now = this.now();
		// 空き待ちのままやり直したときは、列の位置（待ち始めた時刻）を保つ
		const keepQueue = task.status === 'queued' && task.step === stepId ? task.queuedAt : undefined;
		task.attempt++;
		task.step = stepId;
		task.stepSince = now;
		task.stepPrompt = undefined;
		task.uncommitted = undefined;
		task.untracked = undefined;
		task.question = undefined;
		task.error = undefined;
		task.activity = undefined;
		task.queuedAt = keepQueue;
		task.pending = undefined;
		task.updatedAt = now;
		if (stepId === TASK_BOARD_DONE) {
			task.status = 'done';
			this.releasePlace(task);
			this.notice('done', task);
			this.dispatch();
			return;
		}
		if (stepId === TASK_BOARD_TODO) {
			task.status = 'todo';
			this.releasePlace(task);
			this.dispatch();
			return;
		}
		const flow = this.flowOf(task);
		const step = flow.steps.find(s => s.id === stepId);
		if (!step) {
			throw new TaskBoardError('not-found', `step not found: ${stepId}`);
		}
		if (!taskBoardStepNeedsPlace(step) && task.prOwned && flow.workspace.releaseOn === 'pr-opened' && task.place && !task.place.startsWith('manual:')) {
			this.releasePlace(task);
			this.dispatch();
		}
		if (taskBoardStepNeedsPlace(step)) {
			this.enterPlacedStep(task, flow, step, input ?? {});
		} else if (step.kind === 'human') {
			task.status = step.gate === 'merge' ? 'ready' : 'approval';
			this.notice(step.gate === 'merge' ? 'ready' : 'approval', task);
		} else if (step.kind === 'run') {
			task.status = 'working';
			this.options.runner.run(task, step);
		} else {
			task.status = 'waiting';
			this.evaluatePullRequest(task, false);
		}
	}

	/** 作業場所が要る工程に入る。無ければ借り、空きが無ければ空き待ちにする。 */
	private enterPlacedStep(task: ITaskRecord, flow: ITaskBoardFlow, step: ITaskBoardStep, input: IStepInput): void {
		if (task.place) {
			this.launch(task, step, input);
			return;
		}
		const slot = this.lease(task, flow);
		if (!slot) {
			if (task.status !== 'queued') {
				task.status = 'queued';
				task.queuedAt = this.now();
				this.notice('queued', task);
			}
			task.pending = input.prompt || input.feedback ? input : undefined;
			return;
		}
		task.place = slot.id;
		task.status = 'preparing';
		const attempt = task.attempt;
		const branch = task.branch ?? taskBoardBranchName(task);
		const prepared = this.options.workspaces.prepare(task, slot, branch);
		const settled = prepared.then(() => undefined, () => undefined);
		this.preparing.set(slot.id, settled);
		void settled.then(() => {
			if (this.preparing.get(slot.id) === settled) {
				this.preparing.delete(slot.id);
			}
		});
		prepared.then(result => {
			const current = this.tasks.get(task.id);
			if (!current || current.attempt !== attempt || current.place !== slot.id || current.status !== 'preparing') {
				return;
			}
			current.branch = result.branch;
			if (slot.kind === 'worktree' && result.path) {
				this.worktreeSlots.set(current.id, { ...slot, path: result.path });
			}
			this.launch(current, step, input);
			this.changed();
		}, (err: unknown) => {
			const current = this.tasks.get(task.id);
			if (err instanceof TaskBoardWorkspaceError && err.reason === 'dirty' && slot.kind === 'clone-pool') {
				// 汚れた作業場所は、次に起動し直すまで貸さない（空き待ちが順に失敗し続けないように）
				this.poolSlots = this.poolSlots.map(s => s.id === slot.id ? { ...s, dirty: true } : s);
			}
			if (!current || current.attempt !== attempt || current.place !== slot.id || current.status !== 'preparing') {
				this.changed();
				return;
			}
			this.releasePlace(current);
			current.status = 'failed';
			current.error = clip(err instanceof Error ? err.message : String(err), 1000);
			this.activity(current, 'error', current.error, 'workspace');
			this.notice('failed', current, current.error);
			this.dispatch();
			this.changed();
		});
	}

	private launch(task: ITaskRecord, step: ITaskBoardStep, input: IStepInput): void {
		task.status = 'working';
		task.pending = undefined;
		if (step.kind !== 'agent') {
			this.options.runner.run(task, step);
			return;
		}
		if (step.agent === 'claude' || step.agent === 'codex') {
			task.agent = step.agent;
		} else if (!task.agent) {
			task.agent = 'claude';
		}
		const prompt = this.composePrompt(task, step, input);
		task.stepPrompt = prompt.body;
		this.options.agents.startStep(task, step, prompt.full);
	}

	private composePrompt(task: ITaskRecord, step: ITaskBoardStep, input: IStepInput): { body: string; full: string } {
		const issue = task.issue ? `#${task.issue.number}「${task.title}」` : `「${task.title}」`;
		const base = (input.prompt ?? step.prompt ?? '').replace(/\{issue\}/g, issue).trim() || `${issue} の「${step.name}」を進めて`;
		const body = input.feedback ? `差し戻し: ${input.feedback}\n\n${base}` : base;
		const commit = this.flowOf(task).workspace.commit === 'agent' ? `\n\n${TASK_BOARD_COMMIT_PROMPT}` : '';
		return { body, full: `${body}${commit}\n\n${TASK_BOARD_PROMPT_SUFFIX}` };
	}

	private lease(task: ITaskRecord, flow: ITaskBoardFlow): ITaskBoardSlot | undefined {
		if (this.getLeaseCount() >= flow.workspace.maxRunning) {
			return undefined;
		}
		if (flow.workspace.kind === 'worktree') {
			if (this.releasing.has(`wt:${task.id}`)) {
				return undefined; // 前のワークツリーの片付けが終わってから作り直す
			}
			const branch = task.branch ?? taskBoardBranchName(task);
			// path は準備（prepare）が決める。返却は path が無ければブランチ名から場所を求める
			const slot: ITaskBoardSlot = { id: `wt:${task.id}`, name: branch.replace(/^para\//, ''), path: '', kind: 'worktree', leasedBy: task.id };
			this.worktreeSlots.set(task.id, slot);
			return slot;
		}
		const used = new Set([...this.tasks.values()].map(t => t.place).filter(Boolean));
		return this.poolSlots.find(s => !used.has(s.id) && !this.releasing.has(s.id) && !s.dirty && !s.missing);
	}

	private releasePlace(task: ITaskRecord): void {
		const placeId = task.place;
		if (!placeId) {
			return;
		}
		task.place = undefined;
		if (placeId.startsWith('manual:')) {
			return;
		}
		const slot = this.worktreeSlots.get(task.id) ?? this.poolSlots.find(s => s.id === placeId);
		this.worktreeSlots.delete(task.id);
		if (!slot) {
			return;
		}
		const snapshot: ITaskBoardTask = { ...task };
		this.releasing.add(slot.id);
		const pending = this.preparing.get(slot.id);
		const before = pending ? settleWithin(pending, PREPARE_WAIT_MS) : Promise.resolve();
		void before
			.then(() => this.options.workspaces.release(snapshot, slot))
			.catch(() => { /* 台帳は返却済みとして扱う */ })
			.finally(() => {
				this.releasing.delete(slot.id);
				this.dispatch();
				this.changed();
			});
	}

	/** 空き待ちのタスクに、空いた作業場所を順に渡す。 */
	private dispatch(): void {
		const queued = [...this.tasks.values()].filter(t => t.status === 'queued').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
		for (const task of queued) {
			const flow = this.flowOf(task);
			const step = this.stepOf(task);
			if (!step || !taskBoardStepNeedsPlace(step)) {
				continue;
			}
			if (this.getLeaseCount() >= flow.workspace.maxRunning) {
				break;
			}
			this.enterPlacedStep(task, flow, step, task.pending ?? {});
			if (task.status !== 'queued') {
				this.notice('dequeued', task);
			}
		}
	}

	private activity(task: ITaskRecord, kind: TaskBoardActivityKind, label: string, detail?: string): void {
		task.activities.push({ at: this.now(), kind, label, detail });
		if (task.activities.length > MAX_ACTIVITIES) {
			task.activities.splice(0, task.activities.length - MAX_ACTIVITIES);
		}
	}

	private pushLog(task: ITaskRecord, lines: readonly string[]): void {
		for (const line of lines) {
			task.log.push(clip(line, 2000));
		}
		if (task.log.length > MAX_LOG_LINES) {
			task.log.splice(0, task.log.length - MAX_LOG_LINES);
		}
	}

	private touch(task: ITaskRecord): void {
		task.updatedAt = this.now();
		this.changed();
	}
}

/** タスクのブランチ名。Issue があれば番号を入れる。 */
export function taskBoardBranchName(task: Pick<ITaskBoardTask, 'id' | 'issue' | 'title'>): string {
	const ascii = task.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
	const head = task.issue ? String(task.issue.number) : task.id.replace(/^[a-z]+-/, '').slice(0, 8);
	return `para/${head}${ascii ? `-${ascii}` : '-task'}`;
}

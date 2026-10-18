// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardFlow, ITaskBoardQuestion, ITaskBoardSlot, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardError } from '@engine/paradisTaskBoard.js';
import { TaskBoardEngine, TaskBoardWorkspaceError, taskBoardBranchName, type ITaskBoardAgentPort, type ITaskBoardRunPort, type ITaskBoardWorkspacePort } from '@engine/paradisTaskBoardEngine.js';
import { mergeTaskBoardFlows, parseTaskBoardFlowFile, TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';

class FakePorts implements ITaskBoardAgentPort, ITaskBoardRunPort, ITaskBoardWorkspacePort {
	readonly calls: string[] = [];
	readonly prompts: string[] = [];
	released: string[] = [];
	failPrepare: Error | undefined;
	hold: { resolve: () => void; reject: (e: Error) => void }[] = [];
	holdPrepare = false;
	startStep(task: ITaskBoardTask, step: ITaskBoardStep, prompt: string): void {
		this.calls.push(`start:${task.id}:${step.id}`);
		this.prompts.push(prompt);
	}
	answer(task: ITaskBoardTask, _q: ITaskBoardQuestion, answer: string): void {
		this.calls.push(`answer:${task.id}:${answer}`);
	}
	sendInput(task: ITaskBoardTask, text: string): void {
		this.calls.push(`input:${task.id}:${text.slice(0, 10)}`);
	}
	sendKey(task: ITaskBoardTask, key: string): void {
		this.calls.push(`key:${task.id}:${key}`);
	}
	stop(task: ITaskBoardTask): void {
		this.calls.push(`stop:${task.id}`);
	}
	run(task: ITaskBoardTask, step: ITaskBoardStep): void {
		this.calls.push(`run:${task.id}:${step.id}`);
	}
	cancel(task: ITaskBoardTask): void {
		this.calls.push(`cancelRun:${task.id}`);
	}
	prepare(task: ITaskBoardTask, slot: ITaskBoardSlot, branch: string) {
		this.calls.push(`prepare:${task.id}:${slot.id}`);
		const result = { branch, path: slot.kind === 'worktree' ? `/tmp/${branch}` : undefined };
		if (this.holdPrepare) {
			return new Promise<typeof result>((resolve, reject) => this.hold.push({ resolve: () => resolve(result), reject }));
		}
		return this.failPrepare ? Promise.reject(this.failPrepare) : Promise.resolve(result);
	}
	release(task: ITaskBoardTask, slot: ITaskBoardSlot): Promise<void> {
		this.released.push(`${task.id}:${slot.id}${slot.path ? `@${slot.path}` : ''}`);
		return Promise.resolve();
	}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(flow: ITaskBoardFlow = TASK_BOARD_DEFAULT_FLOW, slots = 2) {
	let now = 1_000_000;
	let seq = 0;
	const ports = new FakePorts();
	const engine = new TaskBoardEngine({ clock: () => now, newId: () => `id${++seq}`, agents: ports, runner: ports, workspaces: ports });
	engine.setFlows([flow], flow.id, true);
	engine.setPoolSlots(Array.from({ length: slots }, (_, i) => ({ id: `s${i + 1}`, name: `clone-${i + 1}`, path: `/c/${i + 1}`, kind: 'clone-pool' as const })));
	const notices: string[] = [];
	engine.onDidNotice(n => notices.push(`${n.kind}:${n.taskId ?? ''}`));
	return { engine, ports, notices, tick: (ms: number) => { now += ms; } };
}

function intake(n: number, extra: object = {}) {
	return { issue: { owner: 'o', repo: 'r', number: n, url: `https://github.com/o/r/issues/${n}` }, title: `Issue ${n}`, labels: [], assignees: ['me'], ...extra };
}

describe('TaskBoardEngine', () => {
	test('start leases a slot, prepares it and starts the agent with the issue in the prompt', async () => {
		const { engine, ports } = setup();
		engine.syncIntake([intake(7)]);
		engine.start('gh:o/r#7', { agent: 'codex' });
		expect(engine.getTask('gh:o/r#7')).toMatchObject({ step: 'plan', status: 'preparing', place: 's1', agent: 'codex' });
		await flush();
		const task = engine.getTask('gh:o/r#7')!;
		expect({ status: task.status, branch: task.branch, calls: ports.calls }).toEqual({
			status: 'working',
			branch: 'para/7-issue-7',
			calls: ['prepare:gh:o/r#7:s1', 'start:gh:o/r#7:plan'],
		});
		expect(ports.prompts[0]).toContain('#7「Issue 7」');
	});

	test('queues when all slots are leased and dispatches when a slot is returned', async () => {
		const { engine, notices } = setup(TASK_BOARD_DEFAULT_FLOW, 1);
		engine.syncIntake([intake(1), intake(2)]);
		engine.start('gh:o/r#1', { agent: 'claude' });
		engine.start('gh:o/r#2', { agent: 'claude' });
		await flush();
		expect(engine.getTask('gh:o/r#2')!.status).toBe('queued');
		engine.cancel('gh:o/r#1');
		await flush();
		expect(engine.getTask('gh:o/r#2')).toMatchObject({ status: 'working', place: 's1' });
		expect(notices).toContain('dequeued:gh:o/r#2');
	});

	test('question → answer → complete → approval gate → approve moves to build', async () => {
		const { engine, ports, notices } = setup();
		const id = engine.addTask({ title: 'Manual task' });
		engine.start(id, { agent: 'claude' });
		await flush();
		const qid = engine.reportQuestion(id, engine.getTask(id)!.attempt, { text: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] })!;
		expect(engine.getTask(id)!.status).toBe('question');
		expect(() => engine.answer(id, 'wrong', { optionIndex: 0 })).toThrow(TaskBoardError);
		engine.answer(id, qid, { optionIndex: 1 });
		expect(ports.calls).toContain(`answer:${id}:B`);
		engine.reportStepComplete(id, engine.getTask(id)!.attempt, { artifacts: [{ kind: 'plan', title: '計画', content: '# plan' }] });
		expect(engine.getTask(id)).toMatchObject({ step: 'approve', status: 'approval' });
		expect(notices).toContain(`approval:${id}`);
		engine.approve(id);
		expect(engine.getTask(id)).toMatchObject({ step: 'build', status: 'working' });
		expect(engine.getTask(id)!.history.map(h => `${h.stepId}:${h.result}`)).toEqual(['plan:done', 'approve:done']);
	});

	test('send back puts the reason in front of the prompt and ignores stale reports', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'build' });
		await flush();
		engine.reportStepComplete(id, engine.getTask(id)!.attempt);
		expect(engine.getTask(id)!.step).toBe('review');
		await flush();
		const staleAttempt = engine.getTask(id)!.attempt;
		engine.sendBack(id, undefined, 'テストが足りない');
		expect(engine.getTask(id)!.step).toBe('build');
		expect(ports.prompts.at(-1)).toMatch(/^差し戻し: テストが足りない/);
		// 差し戻し前の review 工程からの遅れた報告は捨てる
		expect(engine.reportStepComplete(id, staleAttempt)).toBe(false);
		expect(engine.getTask(id)!.step).toBe('build');
	});

	test('move: forward one completes, forward many skips, back sends back, todo cancels, done finishes', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.move(id, 'plan');
		await flush();
		engine.move(id, 'approve');
		expect(engine.getTask(id)!.status).toBe('approval');
		engine.move(id, 'e2e');
		expect(engine.getTask(id)!.step).toBe('e2e');
		expect(engine.getTask(id)!.history.filter(h => h.result === 'skipped').map(h => h.stepId)).toEqual(['approve', 'build', 'review', 'pr', 'bot']);
		expect(ports.calls.at(-1)).toBe(`run:${id}:e2e`);
		engine.move(id, 'build', 'やり直し');
		expect(engine.getTask(id)!.history.at(-1)!.result).toBe('sentBack');
		engine.move(id, 'todo');
		expect(engine.getTask(id)).toMatchObject({ step: 'todo', status: 'todo', place: undefined });
		engine.move(id, 'done');
		expect(engine.getTask(id)!.status).toBe('done');
	});

	test('run result failure marks the task failed; wait step follows PR reviews and merge finishes', async () => {
		const { engine } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'pr' });
		await flush(); // ドラフト PR も作業場所で動くので、準備を待つ
		const pr = { owner: 'o', repo: 'r', number: 5, url: '', state: 'draft' as const, checks: 'pending' as const, review: 'none' as const };
		engine.reportRunResult(id, engine.getTask(id)!.attempt, { ok: true, pr });
		expect(engine.getTask(id)).toMatchObject({ step: 'bot', status: 'waiting' });
		engine.reportPullRequest(id, { ...pr, review: 'changes' });
		expect(engine.getTask(id)).toMatchObject({ status: 'failed', error: 'changes-requested' });
		engine.retry(id);
		engine.reportPullRequest(id, { ...pr, review: 'commented' });
		// E2E は作業場所を借りて走らせるので、準備を挟む
		expect(engine.getTask(id)).toMatchObject({ step: 'e2e', status: 'preparing' });
		await flush();
		expect(engine.getTask(id)).toMatchObject({ step: 'e2e', status: 'working' });
		engine.reportRunResult(id, engine.getTask(id)!.attempt, { ok: false, detail: '2 failing' });
		expect(engine.getTask(id)).toMatchObject({ status: 'failed', error: '2 failing' });
		engine.reportPullRequest(id, { ...pr, state: 'merged', review: 'commented' });
		expect(engine.getTask(id)!.status).toBe('done');
	});

	test('releases the clone when the PR is opened and the next step is not an agent step', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'review' });
		await flush();
		engine.reportStepComplete(id, engine.getTask(id)!.attempt);
		expect(engine.getTask(id)!.place).toBe('s1');
		engine.reportRunResult(id, engine.getTask(id)!.attempt, { ok: true, pr: { owner: 'o', repo: 'r', number: 1, url: '', state: 'draft', checks: 'none', review: 'none' } });
		expect(engine.getTask(id)!.place).toBeUndefined();
		await flush();
		expect(ports.released).toEqual([`${id}:s1@/c/1`]);
	});

	test('stalled agents can be nudged; prepare failures release the slot', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude' });
		await flush();
		engine.reportIdle(id, engine.getTask(id)!.attempt);
		expect(engine.getTask(id)!.status).toBe('stalled');
		engine.nudge(id);
		expect(engine.getTask(id)!.status).toBe('working');
		ports.failPrepare = new Error('dirty');
		const id2 = engine.addTask({ title: 'U' });
		engine.start(id2, { agent: 'claude' });
		await flush();
		expect(engine.getTask(id2)).toMatchObject({ status: 'failed', error: 'dirty', place: undefined });
	});

	test('syncIntake adds, updates and removes only untouched todo tasks', () => {
		const { engine } = setup();
		expect(engine.syncIntake([intake(1), intake(2)])).toEqual({ added: 2, updated: 0, removed: 0 });
		engine.start('gh:o/r#2', { agent: 'claude' });
		expect(engine.syncIntake([intake(1, { title: 'renamed', due: '2026-10-20' })])).toEqual({ added: 0, updated: 1, removed: 0 });
		expect(engine.getTask('gh:o/r#1')).toMatchObject({ title: 'renamed', due: '2026-10-20' });
		expect(engine.syncIntake([])).toEqual({ added: 0, updated: 0, removed: 1 });
		expect(engine.getTask('gh:o/r#2')).toBeDefined();
	});

	test('setFlows refuses to drop a step that has tasks unless forced; restore marks running tasks stalled', async () => {
		const { engine } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'build' });
		await flush();
		const smaller: ITaskBoardFlow = { ...TASK_BOARD_DEFAULT_FLOW, steps: TASK_BOARD_DEFAULT_FLOW.steps.filter(s => s.id !== 'build') };
		expect(() => engine.setFlows([smaller])).toThrow(/build/);
		const saved = engine.serialize();
		const { engine: fresh } = setup();
		fresh.restore(saved);
		expect(fresh.getTask(id)).toMatchObject({ status: 'stalled', error: 'restarted' });
		fresh.setFlows([smaller], undefined, true);
		expect(fresh.getTask(id)).toMatchObject({ step: 'todo', status: 'todo' });
	});

	test('worktree flows create a slot per task and remove it on release', async () => {
		const flow: ITaskBoardFlow = { ...TASK_BOARD_DEFAULT_FLOW, workspace: { kind: 'worktree', releaseOn: 'merged', maxRunning: 1 } };
		const { engine, ports } = setup(flow, 0);
		const id = engine.addTask({ title: 'Fix the thing' });
		engine.start(id, { agent: 'claude' });
		await flush();
		expect(engine.getSlots().map(s => s.kind)).toEqual(['worktree']);
		const other = engine.addTask({ title: 'Other' });
		engine.start(other, { agent: 'claude' });
		expect(engine.getTask(other)!.status).toBe('queued');
		engine.markDone(id);
		await flush();
		expect(ports.released[0]).toMatch(/^t-id\d+:wt:t-id\d+@\/tmp\/para\/id\d+-fix-the-thing$/);
		expect(engine.getTask(other)!.status).toBe('working');
	});

	test('a worktree keeps its path after the board is restarted', async () => {
		const flow: ITaskBoardFlow = { ...TASK_BOARD_DEFAULT_FLOW, workspace: { kind: 'worktree', releaseOn: 'merged', maxRunning: 1 } };
		const { engine } = setup(flow, 0);
		const id = engine.addTask({ title: 'Fix the thing' });
		engine.start(id, { agent: 'claude' });
		await flush();
		const before = engine.getSlots()[0].path;
		const fresh = setup(flow, 0);
		fresh.engine.restore(engine.serialize());
		expect({ before: before.length > 0, after: fresh.engine.getSlots()[0].path }).toEqual({ before: true, after: before });
	});

	test('a question keeps where it came from after the board is restarted, and only a screen question closes when answered elsewhere', async () => {
		const { engine } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'codex' });
		await flush();
		const attempt = engine.getTask(id)!.attempt;
		const asked = engine.reportQuestion(id, attempt, { text: 'Hallo?', options: [], origin: 'agent' })!;
		const fresh = setup();
		fresh.engine.restore(engine.serialize());
		const restored = fresh.engine.getTask(id)!;
		const origin = restored.question?.origin;
		fresh.engine.reportQuestionAnsweredElsewhere(id, restored.attempt, asked);
		const agentKept = fresh.engine.getTask(id)!.status;
		const screen = fresh.engine.reportQuestion(id, restored.attempt, { kind: 'permission', text: 'Bash: gh', options: [], origin: 'screen' })!;
		fresh.engine.reportQuestionAnsweredElsewhere(id, restored.attempt, screen);
		expect({ origin, agentKept, after: fresh.engine.getTask(id)!.status }).toEqual({ origin: 'agent', agentKept: 'question', after: 'working' });
	});

	test('retry ignores the late report of the previous attempt and cancels the previous run', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'e2e' });
		await flush();
		const first = engine.getTask(id)!.attempt;
		engine.retry(id);
		expect(ports.calls.filter(c => c.startsWith('cancelRun:'))).toEqual([`cancelRun:${id}`]);
		engine.reportRunResult(id, first, { ok: true });
		expect(engine.getTask(id)).toMatchObject({ step: 'e2e', status: 'working' });
		engine.reportRunResult(id, engine.getTask(id)!.attempt, { ok: true });
		expect(engine.getTask(id)!.step).toBe('shots');
	});

	test('cancelling while preparing: the old prepare does not start an agent, and the slot is released after the prepare settles', async () => {
		const { engine, ports } = setup(TASK_BOARD_DEFAULT_FLOW, 1);
		ports.holdPrepare = true;
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude' });
		expect(engine.getTask(id)!.status).toBe('preparing');
		engine.cancel(id);
		engine.start(id, { agent: 'claude' });
		// 片付けが終わるまでは同じ作業場所を貸さない
		expect(engine.getTask(id)!.status).toBe('queued');
		ports.hold[0].resolve();
		await flush();
		await flush();
		expect(ports.released).toEqual([`${id}:s1@/c/1`]);
		expect(engine.getTask(id)!.status).toBe('preparing');
		expect(ports.calls.filter(c => c.startsWith('start:'))).toEqual([]);
		ports.hold[1].resolve();
		await flush();
		expect(engine.getTask(id)!.status).toBe('working');
		expect(ports.calls.filter(c => c.startsWith('start:'))).toEqual([`start:${id}:plan`]);
	});

	test('a dirty clone is not lent again after a failed prepare', async () => {
		const { engine, ports } = setup(TASK_BOARD_DEFAULT_FLOW, 2);
		ports.failPrepare = new TaskBoardWorkspaceError('dirty', 'dirty');
		const a = engine.addTask({ title: 'A' });
		engine.start(a, { agent: 'claude' });
		await flush();
		expect(engine.getSlots().find(s => s.id === 's1')!.dirty).toBe(true);
		ports.failPrepare = undefined;
		const b = engine.addTask({ title: 'B' });
		engine.start(b, { agent: 'claude' });
		await flush();
		expect(engine.getTask(b)).toMatchObject({ status: 'working', place: 's2' });
	});

	test('queued prompts are composed once when the task is dispatched', async () => {
		const { engine, ports, notices } = setup(TASK_BOARD_DEFAULT_FLOW, 1);
		const a = engine.addTask({ title: 'A' });
		const b = engine.addTask({ title: 'B' });
		engine.start(a, { agent: 'claude' });
		engine.start(b, { agent: 'claude', prompt: 'B をやって' });
		await flush();
		engine.retry(b);
		engine.retry(b);
		engine.cancel(a);
		await flush();
		await flush();
		const prompt = ports.prompts.at(-1)!;
		expect(prompt.startsWith('B をやって')).toBe(true);
		expect(prompt.split('complete_step').length - 1).toBe(1);
		expect(notices.filter(n => n === `queued:${b}`)).toHaveLength(1);
	});

	test('restore dispatches queued tasks and keeps the pending prompt', async () => {
		const { engine } = setup(TASK_BOARD_DEFAULT_FLOW, 1);
		const a = engine.addTask({ title: 'A' });
		const b = engine.addTask({ title: 'B' });
		engine.start(a, { agent: 'claude' });
		engine.start(b, { agent: 'claude', prompt: 'keep me' });
		await flush();
		const saved = engine.serialize();
		const fresh = setup(TASK_BOARD_DEFAULT_FLOW, 2);
		fresh.engine.restore(saved);
		await flush();
		expect(fresh.engine.getTask(b)!.status).toBe('working');
		expect(fresh.ports.prompts.at(-1)!.startsWith('keep me')).toBe(true);
	});

	test('a stale dialog cannot move a task that has moved on', async () => {
		const { engine } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude' });
		await flush();
		engine.reportStepComplete(id, engine.getTask(id)!.attempt);
		expect(() => engine.complete(id, 'plan')).toThrow(/moved on/);
		expect(() => engine.sendBack(id, 'plan', 'x', 'build')).toThrow(/moved on/);
		expect(engine.getTask(id)!.step).toBe('approve');
	});

	test('skipping two steps ahead stops the running agent', async () => {
		const { engine, ports } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude' });
		await flush();
		engine.move(id, 'build');
		expect(ports.calls).toContain(`stop:${id}`);
	});

	test('a PR that was already linked when the task was imported does not finish or release the task', async () => {
		const { engine, ports } = setup();
		engine.syncIntake([intake(9)]);
		const id = 'gh:o/r#9';
		engine.reportPullRequest(id, { owner: 'o', repo: 'r', number: 3, url: '', state: 'merged', checks: 'success', review: 'approved' });
		engine.start(id, { agent: 'claude', stepId: 'bot' });
		expect(engine.getTask(id)).toMatchObject({ step: 'bot', status: 'waiting', prOwned: false });
		// 着手した後に結び付いた新しい PR は、このタスクの PR として扱う
		engine.reportPullRequest(id, { owner: 'o', repo: 'r', number: 4, url: '', state: 'open', checks: 'pending', review: 'commented' });
		expect(engine.getTask(id)).toMatchObject({ step: 'e2e', prOwned: true });
		expect(ports.released).toEqual([]);
	});

	test('changing the kind of an occupied step is refused', async () => {
		const { engine } = setup();
		const id = engine.addTask({ title: 'T' });
		engine.start(id, { agent: 'claude', stepId: 'build' });
		await flush();
		const changed: ITaskBoardFlow = { ...TASK_BOARD_DEFAULT_FLOW, steps: TASK_BOARD_DEFAULT_FLOW.steps.map(s => s.id === 'build' ? { id: 'build', name: '実装', kind: 'human', gate: 'approve' } : s) };
		expect(() => engine.setFlows([changed])).toThrow(/build/);
	});

	test('a truncated intake does not remove todo tasks', () => {
		const { engine } = setup();
		engine.syncIntake([intake(1), intake(2)]);
		expect(engine.syncIntake([intake(1)], false)).toEqual({ added: 0, updated: 0, removed: 0 });
		expect(engine.getTask('gh:o/r#2')).toBeDefined();
	});

	test('an owned PR is not replaced by an older PR that the intake reports again', async () => {
		const { engine } = setup();
		engine.syncIntake([intake(5)]);
		const id = 'gh:o/r#5';
		const old = { owner: 'o', repo: 'r', number: 150, url: '', state: 'merged' as const, checks: 'success' as const, review: 'approved' as const };
		engine.reportPullRequest(id, old);
		engine.start(id, { agent: 'claude', stepId: 'pr' });
		await flush();
		engine.reportRunResult(id, engine.getTask(id)!.attempt, { ok: true, pr: { owner: 'o', repo: 'r', number: 9001, url: '', state: 'draft', checks: 'pending', review: 'none', simulated: true } });
		engine.reportPullRequest(id, old);
		expect(engine.getTask(id)).toMatchObject({ step: 'bot', status: 'waiting', pr: { number: 9001 }, prOwned: true });
	});

	test('a worktree is not lent again to the same task until the previous one is cleaned up', async () => {
		const flow: ITaskBoardFlow = { ...TASK_BOARD_DEFAULT_FLOW, workspace: { kind: 'worktree', releaseOn: 'merged', maxRunning: 2 } };
		const { engine, ports } = setup(flow, 0);
		ports.holdPrepare = true;
		const id = engine.addTask({ title: 'W' });
		engine.start(id, { agent: 'claude' });
		engine.cancel(id);
		engine.start(id, { agent: 'claude' });
		expect(engine.getTask(id)!.status).toBe('queued');
		expect(ports.calls.filter(c => c.startsWith('prepare:'))).toHaveLength(1);
		ports.hold[0].resolve();
		await flush();
		await flush();
		expect(ports.calls.filter(c => c.startsWith('prepare:'))).toHaveLength(2);
	});

	test('retrying a queued task keeps its place in the queue', async () => {
		const { engine, tick } = setup(TASK_BOARD_DEFAULT_FLOW, 1);
		const a = engine.addTask({ title: 'A' });
		const b = engine.addTask({ title: 'B' });
		const c = engine.addTask({ title: 'C' });
		engine.start(a, { agent: 'claude' });
		engine.start(b, { agent: 'claude' });
		tick(1000);
		engine.start(c, { agent: 'claude' });
		tick(1000);
		engine.retry(b);
		engine.cancel(a);
		await flush();
		await flush();
		expect([engine.getTask(b)!.status, engine.getTask(c)!.status]).toEqual(['working', 'queued']);
	});
});

describe('simulation and engine together', () => {
	test('cancelling while the simulated workspace is being prepared does not leak the slot', async () => {
		const { Simulation } = await import('../server/sim.js');
		let engine!: TaskBoardEngine;
		const sim = new Simulation({ engine: () => engine, onManualChange: () => { } });
		sim.setSpeed(20);
		let seq = 0;
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => `s${++seq}`, agents: sim, runner: sim, workspaces: sim });
		engine.setPoolSlots([{ id: 'only', name: 'only', path: '/x', kind: 'clone-pool' }]);
		const a = engine.addTask({ title: 'A' });
		const b = engine.addTask({ title: 'B' });
		engine.start(a, { agent: 'claude' });
		engine.cancel(a);
		engine.start(b, { agent: 'claude' });
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(engine.getTask(b)).toMatchObject({ status: 'working', place: 'only' });
		sim.dispose();
	});
});

describe('flows', () => {
	test('parse fixes ids, drops unknown send-back targets and reports problems', () => {
		const { flows, problems } = parseTaskBoardFlowFile({
			workflows: [
				{ name: 'Mine', steps: [{ name: 'Plan', kind: 'agent', agent: 'codex' }, { id: 'todo', name: 'Gate', kind: 'human', onFail: 'nope' }, { kind: 'bogus' }] },
				{ name: 'Empty', steps: [] },
			],
		}, 'personal', 'workflows.json');
		expect(flows).toHaveLength(1);
		expect(flows[0].steps.map(s => [s.id, s.kind, s.onFail ?? ''])).toEqual([['plan', 'agent', ''], ['todo-step', 'human', '']]);
		expect(problems.map(p => p.message)).toEqual(['id changed to todo-step', 'unknown kind: bogus', 'unknown step: nope', 'at least one step is required']);
	});

	test('personal flows override team flows with the same id', () => {
		const team = { ...TASK_BOARD_DEFAULT_FLOW, id: 'x', name: 'team', scope: 'team' as const };
		const mine = { ...team, name: 'mine', scope: 'personal' as const };
		expect(mergeTaskBoardFlows([TASK_BOARD_DEFAULT_FLOW], [team], [mine]).map(f => f.name)).toEqual(['標準', 'mine']);
	});

	test('branch names use the issue number and an ascii slug', () => {
		expect(taskBoardBranchName({ id: 'gh:o/r#12', issue: { owner: 'o', repo: 'r', number: 12, url: '' }, title: 'Fix: zoom indicator position!' })).toBe('para/12-fix-zoom-indicator-position');
		expect(taskBoardBranchName({ id: 't-abcdef123', title: 'ズームを直す' })).toBe('para/abcdef12-task');
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardQuestion, ITaskBoardSlot, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardEngine, type ITaskBoardAgentPort, type ITaskBoardRunPort, type ITaskBoardWorkspacePort } from '@engine/paradisTaskBoardEngine.js';
import { TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';
import { taskBoardAskOf, type ITaskBoardAsk, type TaskBoardAskAnswer } from '@engine/paradisTaskBoardAsks.js';
import { AskPublisher, askLedgerId } from '../server/asks.js';

class FakePorts implements ITaskBoardAgentPort, ITaskBoardRunPort, ITaskBoardWorkspacePort {
	readonly calls: string[] = [];
	startStep(task: ITaskBoardTask, step: ITaskBoardStep): void {
		this.calls.push(`start:${step.id}`);
	}
	answer(_task: ITaskBoardTask, _question: ITaskBoardQuestion, answer: string): void {
		this.calls.push(`answer:${answer}`);
	}
	sendInput(_task: ITaskBoardTask, text: string): void {
		this.calls.push(`input:${text.slice(0, 12)}`);
	}
	sendKey(): void { }
	stop(): void {
		this.calls.push('stop');
	}
	run(_task: ITaskBoardTask, step: ITaskBoardStep): void {
		this.calls.push(`run:${step.id}`);
	}
	cancel(): void { }
	prepare(_task: ITaskBoardTask, _slot: ITaskBoardSlot, branch: string) {
		return Promise.resolve({ branch });
	}
	release(): Promise<void> {
		return Promise.resolve();
	}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const LEDGER = '0123456789abcdef';
const ID = 'gh:o/r#7';

interface IRequest {
	readonly route: string;
	readonly asks?: readonly ITaskBoardAsk[];
	readonly answered?: readonly string[];
	readonly claim?: string;
	readonly ok?: boolean;
}

async function setup() {
	let now = 1_000_000;
	let seq = 0;
	const ports = new FakePorts();
	const engine = new TaskBoardEngine({ clock: () => now, newId: () => `id${++seq}`, agents: ports, runner: ports, workspaces: ports });
	engine.setFlows([TASK_BOARD_DEFAULT_FLOW], TASK_BOARD_DEFAULT_FLOW.id, true);
	engine.setPoolSlots([{ id: 's1', name: 'clone-1', path: '/c/1', kind: 'clone-pool' }]);
	engine.addIssues([{ issue: { owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/issues/7' }, title: 'Issue 7', labels: [], assignees: [] }]);
	const requests: IRequest[] = [];
	const bridge = { fail: false, hold: undefined as Promise<void> | undefined };
	const publisher = new AskPublisher({
		engine: () => engine,
		ledgerId: LEDGER,
		terminalOf: () => 't_0123456789ab',
		clock: () => now,
		request: async (method, route, body) => {
			await bridge.hold;
			if (bridge.fail) {
				throw new Error('offline');
			}
			requests.push({ route: `${method} ${route}`, ...(body as object) });
			return { ok: true };
		},
	});
	engine.onDidChange(() => publisher.onEngineChange());
	publisher.onConnection(true);
	engine.start(ID, { agent: 'claude' });
	await flush();
	const task = () => engine.getTask(ID)!;
	const ask = () => taskBoardAskOf(task(), engine.flowOf(task()), LEDGER);
	/** 最後に知らせた一覧（id と種類と押せるもの）。 */
	const published = () => {
		const last = requests.filter(request => request.route === 'PUT /v1/asks').at(-1);
		return { asks: (last?.asks ?? []).map(entry => `${entry.id} ${entry.kind} [${[...entry.questions.flatMap(q => q.options.map(o => o.label)), ...entry.actions.map(a => a.label)].join('|')}]`), answered: last?.answered };
	};
	const settled = () => requests.filter(request => request.route === 'POST /v1/asks/settle').map(request => `${request.claim} ${request.ok}`);
	const answer = (id: string, value: TaskBoardAskAnswer, claim = 'c1') => publisher.onAskAnswer({ type: 'ask-answer', claim, id, answer: value });
	return { engine, ports, publisher, requests, bridge, task, ask, published, settled, answer, tick: (ms: number) => { now += ms; } };
}

describe('task board asks for the Para Code ledger', () => {
	test('each kind of human turn becomes one ask with the buttons the board shows', async () => {
		const { engine, task, ask } = await setup();
		const seen: unknown[] = [];
		const note = () => {
			const entry = ask()!;
			// 質問の id はエンジンが振るので、問いの id と同じ値が鍵の末尾に入ることだけを確かめる
			const questionId = task().question?.id;
			const mask = (value: string) => questionId ? value.replace(questionId, 'Q') : value;
			seen.push({ id: mask(entry.id), kind: entry.kind, from: entry.from, preface: entry.preface, questions: entry.questions.map(question => ({ ...question, id: mask(question.id) })), actions: entry.actions });
		};
		engine.reportQuestion(ID, task().attempt, { text: 'Which one?', options: [{ label: 'A', detail: 'first' }, { label: 'B' }], origin: 'agent' });
		note();
		engine.answer(ID, task().question!.id, { optionIndex: 0 });
		engine.reportQuestion(ID, task().attempt, { kind: 'permission', text: 'Bash: npm test', options: [{ label: '許可する' }, { label: '拒否する' }], allowText: false, origin: 'screen' });
		note();
		engine.answer(ID, task().question!.id, { optionIndex: 0 });
		// 台帳の上限（ボタン 6 個）を超える許可は、切らずに「ここからは答えられない」にする
		engine.reportQuestion(ID, task().attempt, { kind: 'permission', text: 'Pick', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })), allowText: false, origin: 'screen' });
		note();
		engine.answer(ID, task().question!.id, { optionIndex: 0 });
		engine.reportIdle(ID, task().attempt);
		note();
		engine.reportStepComplete(ID, task().attempt);
		note();
		engine.approve(ID);
		await flush();
		engine.move(ID, 'review');
		await flush();
		engine.reportAgentError(ID, task().attempt, 'boom');
		note();
		expect(seen).toEqual([
			{ id: `${LEDGER}:${ID}:Q`, kind: 'question', from: { title: '#7 Issue 7', detail: '調査・計画' }, preface: undefined, questions: [{ id: 'Q', text: 'Which one?', options: [{ id: '0', label: 'A', detail: 'first' }, { id: '1', label: 'B' }], allowText: true }], actions: [] },
			{ id: `${LEDGER}:${ID}:Q`, kind: 'permission', from: { title: '#7 Issue 7', detail: '調査・計画' }, preface: 'Bash: npm test', questions: [], actions: [{ id: '0', label: '許可する' }, { id: '1', label: '拒否する' }] },
			{ id: `${LEDGER}:${ID}:Q`, kind: 'permission', from: { title: '#7 Issue 7', detail: '調査・計画' }, preface: 'Pick', questions: [], actions: [] },
			{ id: `${LEDGER}:${ID}:stalled:1`, kind: 'stalled', from: { title: '#7 Issue 7', detail: '調査・計画' }, preface: 'board_complete_step の報告がないまま止まりました', questions: [], actions: [{ id: 'nudge', label: '報告を促す' }, { id: 'complete', label: '完了扱いにする' }] },
			{ id: `${LEDGER}:${ID}:approval:2`, kind: 'approval', from: { title: '#7 Issue 7', detail: '計画の承認' }, preface: '承認を待っています', questions: [], actions: [{ id: 'approve', label: '承認して次へ', allowText: true }, { id: 'sendBack', label: '差し戻す', allowText: true }] },
			{ id: `${LEDGER}:${ID}:failed:4`, kind: 'stalled', from: { title: '#7 Issue 7', detail: 'レビュー' }, preface: 'boom', questions: [], actions: [{ id: 'sendBack', label: '実装へ戻す', allowText: true }, { id: 'retry', label: 'やり直す' }] },
		]);
	});

	test('an answer from the ledger runs the same engine operation as the board button and is always settled', async () => {
		const { engine, ports, task, ask, answer, settled } = await setup();
		const steps: string[] = [];
		const note = () => steps.push(`${task().step}/${task().status}`);
		engine.reportQuestion(ID, task().attempt, { text: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], origin: 'agent' });
		await answer(ask()!.id, { type: 'answers', answers: [{ questionId: task().question!.id, optionIds: ['1'] }] }, 'c1');
		note();
		engine.reportQuestion(ID, task().attempt, { text: 'And?', options: [{ label: 'A' }], origin: 'agent' });
		await answer(ask()!.id, { type: 'answers', answers: [{ questionId: task().question!.id, optionIds: ['0'], text: 'but smaller' }] }, 'c2');
		note();
		engine.reportQuestion(ID, task().attempt, { kind: 'permission', text: 'Bash', options: [{ label: '許可する' }, { label: '拒否する' }], allowText: false, origin: 'screen' });
		await answer(ask()!.id, { type: 'action', actionId: '1' }, 'c3');
		note();
		engine.reportIdle(ID, task().attempt);
		await answer(ask()!.id, { type: 'action', actionId: 'nudge' }, 'c4');
		note();
		engine.reportIdle(ID, task().attempt);
		await answer(ask()!.id, { type: 'action', actionId: 'complete' }, 'c5');
		note();
		const approval = ask()!.id;
		await answer(approval, { type: 'action', actionId: 'sendBack', text: 'more detail' }, 'c6');
		await flush();
		note();
		// もう待っていない 1 件・今の状態に無いボタン・別の問いへの答えは「届かなかった」で返す（何も動かさない）
		await answer(approval, { type: 'action', actionId: 'approve' }, 'c7');
		engine.reportStepComplete(ID, task().attempt);
		await answer(ask()!.id, { type: 'action', actionId: 'retry' }, 'c8');
		await answer(ask()!.id, { type: 'answers', answers: [{ questionId: 'gone', optionIds: ['0'] }] }, 'c9');
		note();
		await answer(ask()!.id, { type: 'action', actionId: 'approve', text: 'ok' }, 'c10');
		await flush();
		note();
		expect({ steps, settled: settled(), agent: ports.calls.filter(call => call.startsWith('answer:') || call.startsWith('input:')) }).toEqual({
			steps: ['plan/working', 'plan/working', 'plan/working', 'plan/working', 'approve/approval', 'plan/working', 'approve/approval', 'build/working'],
			settled: ['c1 true', 'c2 true', 'c3 true', 'c4 true', 'c5 true', 'c6 true', 'c7 false', 'c8 false', 'c9 false', 'c10 true'],
			agent: ['answer:B', 'answer:A: but smaller', 'answer:拒否する', expect.stringMatching(/^input:/)],
		});
	});

	test('the list is sent one at a time, resent after a reconnect, and a turn answered on the board is reported as answered', async () => {
		const { engine, publisher, requests, bridge, task, published, tick } = await setup();
		const puts = () => requests.filter(request => request.route === 'PUT /v1/asks').length;
		const before = puts();
		let release!: () => void;
		bridge.hold = new Promise<void>(resolve => { release = resolve; });
		engine.reportQuestion(ID, task().attempt, { text: 'Q1', options: [{ label: 'A' }], origin: 'agent' });
		const first = `${LEDGER}:${ID}:${task().question!.id}`;
		// 送っている間の変化は、終わってから最新の 1 回にまとめる
		publisher.markAnsweredHere(ID);
		engine.answer(ID, task().question!.id, { optionIndex: 0 });
		engine.reportIdle(ID, task().attempt);
		bridge.hold = undefined;
		release();
		await flush();
		await flush();
		const afterBoardAnswer = { sent: puts() - before, ...published() };
		// 同じ中身は変更のたびに送らない。つなぎ直しでは送り直す
		engine.reportOutput(ID, ['noise']);
		await flush();
		const afterNoise = requests.length;
		publisher.onConnection(false);
		publisher.onConnection(true);
		await flush();
		const afterReconnect = requests.length;
		// 「報告を促す」の後にまた止まると、同じ id で出直す（Para Code の台帳は、次に届いた一覧で待ちへ戻す）
		engine.nudge(ID);
		await flush();
		const whileWorking = published().asks;
		engine.reportIdle(ID, task().attempt);
		await flush();
		// 送れなかった一覧は、次の送り直しでやり直す
		bridge.fail = true;
		engine.reportStepComplete(ID, task().attempt);
		await flush();
		bridge.fail = false;
		tick(1);
		publisher.onConnection(true);
		await flush();
		expect({ afterBoardAnswer, resent: afterReconnect - afterNoise, whileWorking, stalledAgain: requests.at(-2)?.asks?.map(entry => entry.id), final: published() }).toEqual({
			afterBoardAnswer: { sent: 2, asks: [`${LEDGER}:${ID}:stalled:1 stalled [報告を促す|完了扱いにする]`], answered: [first] },
			resent: 1,
			whileWorking: [],
			stalledAgain: [`${LEDGER}:${ID}:stalled:1`],
			final: { asks: [`${LEDGER}:${ID}:approval:2 approval [承認して次へ|差し戻す]`], answered: undefined },
		});
		expect(requests.find(request => request.asks?.length)?.asks?.[0]).toMatchObject({ terminal: 't_0123456789ab', canSkip: false });
	});

	test('the ledger id differs per repository', () => {
		expect([askLedgerId('/a'), askLedgerId('/a') === askLedgerId('/b')]).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/), false]);
	});
});

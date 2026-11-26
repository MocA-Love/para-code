/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ボードの「あなたの番」を、Para Code の「人が答えるもの」の台帳（humanAsk）の 1 件へ写す規則と、
// 台帳の側から届いた答えをエンジンの操作へ引き直す規則。
//
// ボードのサーバー（app/taskboard）がそのまま import するので、VS Code の土台（vs/base）にも humanAsk にも
// 依存しない。1 件の形は humanAsk の `IParadisHumanAskInput` と同じ並びで、接続口が受け取るときに
// `paradisSanitizeHumanAskInput` で検める（ここで作った 1 件がそのまま通ることを、本体側のテストで確かめる）。
//
// 持ち主はボードのまま（元の記録は台帳ファイル state.json）。ここで作るのは、その写し。

import { ITaskBoardFlow, ITaskBoardPaneAsk, ITaskBoardStep, ITaskBoardTask, TASK_BOARD_DONE, TaskBoardError } from './paradisTaskBoard.js';
import type { TaskBoardEngine } from './paradisTaskBoardEngine.js';

/** 接続口の口。ボード → Para Code（今の人の出番の丸ごとの一覧）。 */
export const TASK_BOARD_ASKS_ROUTE = '/v1/asks';
/** 接続口の口。ボード → Para Code（台帳の側から頼まれた答えを届けた結果）。 */
export const TASK_BOARD_ASKS_SETTLE_ROUTE = '/v1/asks/settle';
/** SSE のイベントの種類。Para Code → ボード（台帳の側で答えられたので、届けてほしい）。 */
export const TASK_BOARD_ASK_ANSWER_EVENT = 'ask-answer';
/** 接続口の口。手元のボード → Para Code（ボードの外のペインの待ちに、ボードの画面で答える）。 */
export const TASK_BOARD_PANE_ASK_ANSWER_ROUTE = '/v1/asks/pane-answer';
/** SSE のイベントの種類。Para Code → 手元のボード（ボードの外のペインの今の待ち、丸ごと）。 */
export const TASK_BOARD_PANE_ASKS_EVENT = 'pane-asks';
/** 1 回に知らせる件数の上限（台帳の待ちの上限と同じ）。 */
export const TASK_BOARD_ASKS_LIMIT = 500;

/** 台帳の上限（humanAsk の定数と同じ値。超える 1 件は切らずに「ここからは答えられない」にする）。 */
const OPTION_LIMIT = 10;
const ACTION_LIMIT = 6;
const ID_LIMIT = 400;
const TITLE_LIMIT = 200;
const LABEL_LIMIT = 400;

export interface ITaskBoardAskOption {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
}

export interface ITaskBoardAskQuestion {
	readonly id: string;
	readonly text: string;
	readonly options: readonly ITaskBoardAskOption[];
	readonly allowText: boolean;
}

export interface ITaskBoardAskAction {
	readonly id: string;
	readonly label: string;
	readonly allowText?: boolean;
	/** 押す前の確認（ボードの画面がそのボタンで出す確認と同じ文）。受信箱はこれを通してから送る。 */
	readonly confirm?: { readonly title: string; readonly body?: string; readonly ok: string };
}

/** ボードが接続口へ知らせる 1 件。`terminal` は、その問いが出ているターミナル（接続口がペインの鍵と窓に引き直す）。 */
export interface ITaskBoardAsk {
	readonly id: string;
	readonly kind: 'question' | 'permission' | 'approval' | 'stalled';
	readonly from: { readonly title: string; readonly detail?: string };
	readonly preface?: string;
	readonly questions: readonly ITaskBoardAskQuestion[];
	readonly actions: readonly ITaskBoardAskAction[];
	readonly canSkip: false;
	readonly askedAt: number;
	readonly terminal?: string;
}

/** 台帳の側から届く答え（humanAsk の `ParadisHumanAskAnswer` と同じ形。ボードでは `skip` を出さない）。 */
export type TaskBoardAskAnswer =
	| { readonly type: 'answers'; readonly answers: readonly { readonly questionId: string; readonly optionIds?: readonly string[]; readonly text?: string }[] }
	| { readonly type: 'action'; readonly actionId: string; readonly text?: string }
	| { readonly type: 'skip' };

/** SSE で届く、ボードの外のペインの今の待ち（丸ごと）。 */
export interface ITaskBoardPaneAsksEvent {
	readonly type: typeof TASK_BOARD_PANE_ASKS_EVENT;
	readonly asks: readonly ITaskBoardPaneAsk[];
}

/** SSE で届く、答えを届けてほしいという依頼。`claim` は結果を返すときに添える。 */
export interface ITaskBoardAskAnswerEvent {
	readonly type: typeof TASK_BOARD_ASK_ANSWER_EVENT;
	readonly claim: string;
	readonly id: string;
	readonly answer: TaskBoardAskAnswer;
}

/** ボタンの id（意味はここだけが知る）。 */
const ACTION_APPROVE = 'approve';
const ACTION_SEND_BACK = 'sendBack';
const ACTION_RETRY = 'retry';
const ACTION_NUDGE = 'nudge';
const ACTION_COMPLETE = 'complete';

export function taskBoardErrorText(error: string): string {
	switch (error) {
		case 'restarted': return 'サーバーの再起動でエージェントとの接続が切れました';
		case 'changes-requested': return 'レビューで変更を求められました';
		case 'checks-failed': return 'チェックが失敗しました';
		case 'dirty': return '作業場所に未コミットの変更があります';
		default: return error;
	}
}

/** タスクが今していること・止まっている理由の 1 行（ボードの画面と台帳の前置きで同じ文を使う）。 */
export function taskBoardActivityText(task: ITaskBoardTask, flow: ITaskBoardFlow | undefined): string {
	if (task.error && (task.status === 'failed' || task.status === 'stalled')) {
		return taskBoardErrorText(task.error);
	}
	if (task.activity) {
		return task.activity;
	}
	const step = flow?.steps.find(s => s.id === task.step);
	switch (task.status) {
		case 'queued': return '作業場所の空きを待っています';
		case 'preparing': return '作業場所を準備しています';
		case 'working': return step ? `${step.name}をしています` : '作業しています';
		case 'stalled': return 'board_complete_step の報告がないまま止まりました';
		case 'waiting': return step?.wait === 'checks' ? 'チェックの結果を待っています' : 'レビューを待っています';
		case 'ready': return task.pr ? `PR #${task.pr.number} のマージを待っています` : 'マージを待っています';
		case 'approval': return '承認を待っています';
		default: return '';
	}
}

function stepOf(task: ITaskBoardTask, flow: ITaskBoardFlow): ITaskBoardStep | undefined {
	return flow.steps.find(step => step.id === task.step);
}

function usableLabels(options: readonly { readonly label: string }[], limit: number): boolean {
	return options.length <= limit && options.every(option => option.label.trim().length > 0 && option.label.length <= LABEL_LIMIT);
}

// ボードの画面（app/taskboard/src/actions.tsx の move・SendBackDialog）が同じボタンで出す確認と同じ文。
// 受信箱から押すときもこれを通す（台帳の側からはボードの確認のダイアログが出ないため）。

/** 「完了扱いにする」: 次の工程へ進める（最後の工程なら完了にする）。 */
function completeConfirm(task: ITaskBoardTask, flow: ITaskBoardFlow): NonNullable<ITaskBoardAskAction['confirm']> {
	const index = flow.steps.findIndex(step => step.id === task.step);
	if (flow.steps[index + 1] === undefined) {
		return { title: `${task.issue ? `#${task.issue.number}` : 'このタスク'} を完了にしますか`, body: 'PR はマージしません。ボード上で完了として扱い、作業場所を返します。', ok: '完了にする' };
	}
	return { title: `「${stepOf(task, flow)?.name ?? task.step}」を終わったことにして進めますか`.slice(0, TITLE_LIMIT), body: 'エージェントからの完了の報告を待たずに、次の工程を始めます。', ok: '進める' };
}

/** 「〜へ戻す」: 差し戻す。 */
function sendBackConfirm(back: ITaskBoardStep): NonNullable<ITaskBoardAskAction['confirm']> {
	return { title: '差し戻す', body: `${back.name}からやり直します`.slice(0, LABEL_LIMIT), ok: '差し戻す' };
}

/**
 * タスクの今の「人の出番」を台帳の 1 件にする。出番でなければ undefined。
 *
 * id は 1 回の問いごとに変える: 質問・許可は質問の id、それ以外は状態と試行番号。`ledgerId` はボードの
 * 台帳の名前（リポジトリごとに違う）で、別のリポジトリの同じ番号のタスクと重ならないようにする。
 */
export function taskBoardAskOf(task: ITaskBoardTask, flow: ITaskBoardFlow, ledgerId: string): ITaskBoardAsk | undefined {
	const step = stepOf(task, flow);
	const title = `${task.issue ? `#${task.issue.number} ` : ''}${task.title}`.trim().slice(0, TITLE_LIMIT) || 'タスク';
	const from = { title, ...(step ? { detail: step.name.slice(0, TITLE_LIMIT) } : {}) };
	const base = { from, canSkip: false as const };
	let ask: ITaskBoardAsk | undefined;
	if ((task.status === 'question' || task.status === 'permission') && task.question) {
		const question = task.question;
		const id = `${ledgerId}:${task.id}:${question.id}`;
		const options = question.options.map((option, index) => ({ id: String(index), label: option.label, ...(option.detail ? { detail: option.detail.slice(0, LABEL_LIMIT) } : {}) }));
		const text = question.text.trim();
		if (task.status === 'question' && text.length > 0 && usableLabels(options, OPTION_LIMIT)) {
			ask = { ...base, id, kind: 'question', questions: [{ id: question.id, text: question.text, options, allowText: question.allowText || options.length === 0 }], actions: [], askedAt: question.askedAt };
		} else if (task.status === 'permission' && options.length > 0 && usableLabels(options, ACTION_LIMIT)) {
			ask = { ...base, id, kind: 'permission', ...(text ? { preface: text } : {}), questions: [], actions: options.map(option => ({ id: option.id, label: option.label })), askedAt: question.askedAt };
		} else {
			// 台帳の上限に収まらない・選択肢の名前が空。切ると選べない選択肢のある問いになるので、ここからは答えさせない
			ask = { ...base, id, kind: task.status, ...(text ? { preface: text } : {}), questions: [], actions: [], askedAt: question.askedAt };
		}
	} else if (task.status === 'approval' || task.status === 'stalled' || task.status === 'failed' || task.status === 'ready') {
		const id = `${ledgerId}:${task.id}:${task.status}:${task.attempt}`;
		const preface = taskBoardActivityText(task, flow);
		const common = { ...base, id, ...(preface ? { preface } : {}), questions: [], askedAt: task.stepSince };
		if (task.status === 'approval') {
			// 差し戻す先はエンジンの既定と同じ（工程の onFail、無ければ手前のエージェントの工程）。先が無ければ確認の文に工程名を入れない
			const index = flow.steps.findIndex(candidate => candidate.id === task.step);
			const backId = step?.onFail ?? [...flow.steps.slice(0, Math.max(0, index))].reverse().find(candidate => candidate.kind === 'agent')?.id;
			const back = backId !== undefined ? flow.steps.find(candidate => candidate.id === backId) : undefined;
			ask = { ...common, kind: 'approval', actions: step?.kind === 'human' ? [{ id: ACTION_APPROVE, label: '承認して次へ', allowText: true }, { id: ACTION_SEND_BACK, label: '差し戻す', allowText: true, ...(back ? { confirm: sendBackConfirm(back) } : {}) }] : [] };
		} else if (task.status === 'failed') {
			const back = step?.onFail !== undefined ? flow.steps.find(candidate => candidate.id === step.onFail) : undefined;
			ask = { ...common, kind: 'stalled', actions: step ? [...(back ? [{ id: ACTION_SEND_BACK, label: `${back.name}へ戻す`.slice(0, LABEL_LIMIT), allowText: true, confirm: sendBackConfirm(back) }] : []), { id: ACTION_RETRY, label: 'やり直す' }] : [] };
		} else if (task.status === 'stalled') {
			ask = { ...common, kind: 'stalled', actions: step ? [task.error === 'restarted' ? { id: ACTION_RETRY, label: '工程をやり直す' } : { id: ACTION_NUDGE, label: '報告を促す' }, { id: ACTION_COMPLETE, label: '完了扱いにする', confirm: completeConfirm(task, flow) }] : [] };
		} else {
			// マージは GitHub で行うので、ここからは答えられない（タスクを開くだけ）
			ask = { ...common, kind: 'approval', actions: [] };
		}
	}
	return ask !== undefined && ask.id.length <= ID_LIMIT ? ask : undefined;
}

/** ボードの今の「人の出番」の一覧（古い順）。上限を超えた分は知らせない。 */
export function taskBoardAsks(tasks: readonly ITaskBoardTask[], flowOf: (task: ITaskBoardTask) => ITaskBoardFlow, ledgerId: string): ITaskBoardAsk[] {
	const asks: ITaskBoardAsk[] = [];
	for (const task of tasks) {
		const ask = taskBoardAskOf(task, flowOf(task), ledgerId);
		if (ask) {
			asks.push(ask);
		}
	}
	return asks.sort((a, b) => a.askedAt - b.askedAt).slice(0, TASK_BOARD_ASKS_LIMIT);
}

type AskEngine = Pick<TaskBoardEngine, 'answer' | 'approve' | 'sendBack' | 'retry' | 'nudge' | 'move'>;

/**
 * 台帳の側から届いた答えを、ボードの画面のボタンと同じエンジンの操作にする。`ask` は今のタスクから作り直した
 * 1 件（呼び出し側が id で引き当てる）。今の状態に合わない答えは {@link TaskBoardError} を投げる。工程と試行番号を
 * 添えるので、引き当ての後にタスクが先へ進んでいれば、エンジンが断る。
 */
export function taskBoardApplyAskAnswer(engine: AskEngine, task: ITaskBoardTask, flow: ITaskBoardFlow, ask: ITaskBoardAsk, answer: TaskBoardAskAnswer): void {
	const invalid = () => new TaskBoardError('invalid-params', 'the answer does not match what the task is waiting for');
	if (answer.type === 'answers') {
		const question = ask.questions[0];
		const given = answer.answers[0];
		if (!task.question || !question || answer.answers.length !== 1 || given.questionId !== question.id) {
			throw invalid();
		}
		const chosen = given.optionIds ?? [];
		const option = chosen.length === 1 ? question.options.find(candidate => candidate.id === chosen[0]) : undefined;
		const text = given.text?.trim();
		if (chosen.length > 0 && !option) {
			throw invalid();
		}
		// 選択肢に文を添えた答えは、選んだ名前を頭に付けた文として送る（エンジンの回答は選択肢か文のどちらか）。
		// 画面の質問への文はターミナルへ打ち込むので、途中で確定しないよう改行でつながない
		if (text) {
			engine.answer(task.id, task.question.id, { text: option ? `${option.label}: ${text}` : text });
		} else if (option) {
			engine.answer(task.id, task.question.id, { optionIndex: Number(option.id) });
		} else {
			throw invalid();
		}
		return;
	}
	if (answer.type !== 'action' || !ask.actions.some(action => action.id === answer.actionId)) {
		throw invalid();
	}
	const note = answer.text?.trim() || undefined;
	if (ask.kind === 'permission') {
		if (!task.question) {
			throw invalid();
		}
		engine.answer(task.id, task.question.id, { optionIndex: Number(answer.actionId) });
		return;
	}
	switch (answer.actionId) {
		case ACTION_APPROVE: return engine.approve(task.id, note, task.step, task.attempt);
		case ACTION_SEND_BACK: return engine.sendBack(task.id, task.status === 'failed' ? stepOf(task, flow)?.onFail : undefined, note, task.step, task.attempt);
		case ACTION_RETRY: return engine.retry(task.id, task.step, task.attempt);
		case ACTION_NUDGE: return engine.nudge(task.id);
		case ACTION_COMPLETE: {
			const index = flow.steps.findIndex(step => step.id === task.step);
			return engine.move(task.id, flow.steps[index + 1]?.id ?? TASK_BOARD_DONE, undefined, task.step, task.attempt);
		}
	}
	throw invalid();
}

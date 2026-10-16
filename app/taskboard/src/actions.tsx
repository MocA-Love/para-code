// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { ConfirmDialog, MoveDialog, SendBackDialog, StartDialog } from './components/dialogs.js';
import { useApp } from './context.js';
import { stepName } from './format.js';
import type { IMenuItem } from './components/atoms.js';

/*
 * タスクへの操作。ドラッグ・メニュー・ボタンのどこから呼んでも、同じ確認を挟んでから送る。
 */
export function useTaskActions() {
	const app = useApp();

	const position = (task: ITaskBoardTask, stepId: string) => {
		const flow = app.flowOf(task);
		return stepId === 'todo' ? -1 : stepId === 'done' ? flow.steps.length : flow.steps.findIndex(s => s.id === stepId);
	};

	const start = (task: ITaskBoardTask, stepId?: string) => {
		const flow = app.flowOf(task);
		const step = flow.steps.find(s => s.id === (stepId ?? flow.steps[0].id)) ?? flow.steps[0];
		app.showDialog(<StartDialog task={task} step={step} flow={flow} />);
	};

	const move = (task: ITaskBoardTask, to: string) => {
		if (task.step === to) {
			return;
		}
		const flow = app.flowOf(task);
		const from = position(task, task.step);
		const target = position(task, to);
		const ref = task.issue ? `#${task.issue.number}` : 'このタスク';
		if (from === -1 && target >= 0 && target < flow.steps.length) {
			if (target === 0) {
				start(task, to);
				return;
			}
			app.showDialog(<ConfirmDialog title={`前の工程を飛ばして「${stepName(flow, to)}」から始めますか`} body={`${flow.steps.slice(0, target).map(s => s.name).join('、')} を行いません。`} ok="飛ばして始める" onOk={() => { setTimeout(() => start(task, to), 0); }} />);
			return;
		}
		if (to === 'todo') {
			cancel(task);
			return;
		}
		if (to === 'done') {
			app.showDialog(<ConfirmDialog title={`${ref} を完了にしますか`} body="PR はマージしません。ボード上で完了として扱い、作業場所を返します。" ok="完了にする" onOk={() => app.call('markDone', { taskId: task.id }, { title: '完了にしました', body: task.title, tone: 'green' })} />);
			return;
		}
		if (target < from) {
			app.showDialog(<SendBackDialog task={task} flow={flow} to={to} />);
			return;
		}
		if (target === from + 1) {
			app.showDialog(<ConfirmDialog title={`「${stepName(flow, task.step)}」を終わったことにして進めますか`} body="エージェントからの完了の報告を待たずに、次の工程を始めます。" ok="進める" onOk={() => app.call('complete', { taskId: task.id, from: task.step, attempt: task.attempt })} />);
			return;
		}
		app.showDialog(<ConfirmDialog title={`工程を飛ばして「${stepName(flow, to)}」へ進めますか`} body={`${flow.steps.slice(from + 1, target).map(s => s.name).join('、')} を行いません。`} ok="飛ばして進める" onOk={() => app.call('move', { taskId: task.id, to, from: task.step, attempt: task.attempt })} />);
	};

	const cancel = (task: ITaskBoardTask) => {
		app.showDialog(<ConfirmDialog title={`${task.issue ? `#${task.issue.number}` : 'このタスク'} を中止しますか`} body="エージェントを止め、作業場所を返して未着手に戻します。ブランチと PR は残します。" ok="中止する" danger onOk={() => app.call('cancel', { taskId: task.id }, { title: '中止しました', body: task.title, tone: 'gray' })} />);
	};

	const sendBack = (task: ITaskBoardTask, to?: string) => {
		app.showDialog(<SendBackDialog task={task} flow={app.flowOf(task)} to={to} />);
	};

	const approve = (task: ITaskBoardTask, note?: string) => app.call('approve', { taskId: task.id, note, from: task.step, attempt: task.attempt }, { title: '承認しました', body: '次の工程を始めます', tone: 'green', taskId: task.id });

	const answer = (task: ITaskBoardTask, optionIndex?: number, text?: string) => {
		if (!task.question) {
			return Promise.resolve(undefined);
		}
		return app.call('answer', { taskId: task.id, questionId: task.question.id, optionIndex, text }, { title: '回答しました', body: optionIndex !== undefined ? task.question.options[optionIndex]?.label : text, tone: 'blue', taskId: task.id });
	};

	const openMove = (task: ITaskBoardTask) => {
		app.showDialog(<MoveDialog task={task} flow={app.flowOf(task)} onPick={to => setTimeout(() => move(task, to), 0)} />);
	};

	const githubUrl = (task: ITaskBoardTask) => task.pr && !task.pr.simulated && task.pr.url ? task.pr.url : task.issue?.url || undefined;

	/** カードやパネルの「…」メニュー。 */
	const menuItems = (task: ITaskBoardTask): IMenuItem[] => {
		const items: IMenuItem[] = [
			{ label: '開く', icon: 'eye', run: () => app.openTask(task.id) },
			{ label: '工程を移す…', icon: 'move', run: () => openMove(task) },
		];
		if (task.step === 'todo') {
			items.push({ label: '着手する…', icon: 'play', run: () => start(task) });
		} else if (task.step !== 'done') {
			items.push({ label: 'やり直す', icon: 'retry', run: () => void app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt }) });
			if (app.snapshot.runtime.agents === 'para-code' && app.flowOf(task).steps.find(s => s.id === task.step)?.kind === 'agent') {
				// エージェントが止まったのに「作業中」のまま固まったとき、ターミナルごと始め直す
				items.push({ label: 'エージェントを起動し直す', icon: 'retry', run: () => void app.call('restartAgent', { taskId: task.id, attempt: task.attempt }, { title: 'エージェントを起動し直します', body: task.title, tone: 'blue' }) });
			}
			items.push({ label: '差し戻す…', icon: 'undo', run: () => sendBack(task) });
			items.push({ label: '中止して未着手に戻す', icon: 'stop', danger: true, run: () => cancel(task) });
		}
		const url = githubUrl(task);
		if (url) {
			items.push({ separator: true, label: '' }, { label: 'GitHub で開く', icon: 'ext', run: () => window.open(url, '_blank', 'noopener') });
		}
		if (task.source !== 'github' && (task.step === 'todo' || task.step === 'done')) {
			items.push({ separator: true, label: '' }, { label: 'ボードから消す', icon: 'trash', danger: true, run: () => app.showDialog(<ConfirmDialog title="ボードから消しますか" body={task.title} ok="消す" danger onOk={() => app.call('removeTask', { taskId: task.id })} />) });
		}
		return items;
	};

	return { start, move, cancel, sendBack, approve, answer, openMove, menuItems, githubUrl };
}

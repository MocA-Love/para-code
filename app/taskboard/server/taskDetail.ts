// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardArtifact, ITaskBoardTask, ITaskBoardTaskDetail, TaskBoardClientMessage, TaskBoardServerMessage } from '@engine/paradisTaskBoard.js';

/*
 * 一覧のスナップショットと、開いているタスクの詳しい分（活動とターミナルの出力）を分ける。
 * 活動は 1 タスク 200 件、出力は 400 行まで溜まり、完了したタスクも人が消すまで残るので、
 * 全タスク分を変更のたびに送ると、使うほど 1 回の送信が大きくなる。
 */

/** 一覧に載せる形。成果物の本文・活動・ターミナルの出力を外す。 */
export function listTask(task: ITaskBoardTask): ITaskBoardTask {
	return {
		...task,
		artifacts: task.artifacts.map((a): ITaskBoardArtifact => ({ ...a, content: undefined, hasContent: Boolean(a.content) })),
		activities: [],
		log: [],
	};
}

export function taskDetail(task: ITaskBoardTask): ITaskBoardTaskDetail {
	return { taskId: task.id, activities: task.activities, log: task.log };
}

const MAX_TASK_ID = 200;

/** 画面から届いたメッセージを読む。知らない形は `undefined`（無視する）。 */
export function parseClientMessage(data: string): TaskBoardClientMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'focus') {
		return undefined;
	}
	const taskId = (value as { taskId?: unknown }).taskId;
	if (taskId === undefined || taskId === null) {
		return { type: 'focus' };
	}
	return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= MAX_TASK_ID ? { type: 'focus', taskId } : undefined;
}

/** 開いているタスクの詳しい分を引く先（エンジン）。 */
export interface ITaskDetailSource {
	getTask(taskId: string): ITaskBoardTask | undefined;
	/** 活動か出力が足された回数。上限で古いものを捨てても増え続ける。 */
	getTaskDetailRevision(taskId: string): number;
}

/**
 * 画面ごとの開いているタスクを覚え、そのタスクの活動と出力をその画面にだけ送る。
 * 開いた直後と、足された回数が前に送ったときから変わったときだけ送る。つなぎ直した画面は新しい接続として知らせ直してくる。
 */
export class TaskDetailFeed<TSocket> {
	private readonly focused = new Map<TSocket, { readonly taskId: string; revision?: number }>();

	constructor(
		private readonly source: ITaskDetailSource,
		/** 送れない（閉じかけの）接続には何もしない。 */
		private readonly send: (socket: TSocket, text: string) => void,
	) { }

	/** 画面から届いたメッセージ。 */
	receive(socket: TSocket, data: string): void {
		const message = parseClientMessage(data);
		if (message?.type !== 'focus') {
			return;
		}
		if (message.taskId === undefined) {
			this.focused.delete(socket);
			return;
		}
		this.focused.set(socket, { taskId: message.taskId });
		this.sendDetail(socket);
	}

	closed(socket: TSocket): void {
		this.focused.delete(socket);
	}

	/** 台帳が変わった（一覧を送った）ときに呼ぶ。 */
	changed(): void {
		for (const socket of this.focused.keys()) {
			this.sendDetail(socket);
		}
	}

	private sendDetail(socket: TSocket): void {
		const focus = this.focused.get(socket);
		const task = focus && this.source.getTask(focus.taskId);
		if (!focus || !task) {
			return;
		}
		const revision = this.source.getTaskDetailRevision(task.id);
		if (revision === focus.revision) {
			return;
		}
		focus.revision = revision;
		this.send(socket, JSON.stringify({ type: 'taskDetail', detail: taskDetail(task) } satisfies TaskBoardServerMessage));
	}
}

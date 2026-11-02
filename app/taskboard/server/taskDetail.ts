// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardArtifact, ITaskBoardTask, ITaskBoardTaskDetail, TaskBoardClientMessage } from '@engine/paradisTaskBoard.js';

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

/**
 * 詳しい分が前に送ったものから変わったかを見る目印。どちらも後ろに足すだけで、上限に達すると先頭から捨てるので、
 * 件数と最後の 1 件で足りる。
 */
export function taskDetailSignature(task: ITaskBoardTask): string {
	return JSON.stringify([task.activities.length, task.activities.at(-1), task.log.length, task.log.at(-1)]);
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

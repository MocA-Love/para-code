// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardSnapshot, ITaskBoardTaskDetail } from '@engine/paradisTaskBoard.js';

/**
 * 一覧のスナップショットには活動とターミナルの出力が入っていない。開いているタスクの分（別のメッセージで届く）を
 * そのタスクに戻し、画面の部品からは今までどおり `task.activities` と `task.log` で読めるようにする。
 */
export function withTaskDetail(snapshot: ITaskBoardSnapshot, detail: ITaskBoardTaskDetail | undefined): ITaskBoardSnapshot {
	if (!detail || !snapshot.tasks.some(task => task.id === detail.taskId)) {
		return snapshot;
	}
	return { ...snapshot, tasks: snapshot.tasks.map(task => task.id === detail.taskId ? { ...task, activities: detail.activities, log: detail.log } : task) };
}

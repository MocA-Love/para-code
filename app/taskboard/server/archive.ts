// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';

/*
 * 完了してから日が経ったタスクを、台帳（state.json）から台帳のディレクトリの archive.jsonl へ移す。
 * 完了したタスクは人が消すまで残るので、使うほど台帳と一覧の送信が大きくなる。
 * 移したタスクは 1 行 1 タスク（成果物の本文を含む）で追記する。読む画面はまだ無い。
 */

/** 完了からこの日数が経ったら移す（Q534）。 */
export const TASK_BOARD_ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 移すかを調べる間隔。 */
export const TASK_BOARD_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

export interface IArchiveEngine {
	archivableTasks(ageMs: number): ITaskBoardTask[];
	archiveTasks(taskIds: readonly string[]): number;
}

export function archiveFile(directory: string): string {
	return path.join(directory, 'archive.jsonl');
}

/**
 * 移せるタスクを書き足してから台帳から外す。**書けなかったら外さない**（外してから書くと、失敗したときに消える）。
 * 書いた後に落ちても、次の回にもう一度書くだけ（重複した行が残るが、記録は失われない）。外した数を返す。
 */
export async function archiveDoneTasks(engine: IArchiveEngine, file: string, ageMs = TASK_BOARD_ARCHIVE_AGE_MS, append: (file: string, text: string) => Promise<void> = appendText): Promise<number> {
	const tasks = engine.archivableTasks(ageMs);
	if (!tasks.length) {
		return 0;
	}
	const archivedAt = Date.now();
	await append(file, tasks.map(task => `${JSON.stringify({ archivedAt, task })}\n`).join(''));
	return engine.archiveTasks(tasks.map(task => task.id));
}

async function appendText(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, text, 'utf8');
}

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ITaskBoardArchivedTask, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardError } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardArchiveStamp } from '@engine/paradisTaskBoardEngine.js';

/*
 * 完了してから日が経ったタスクを、台帳（state.json）から台帳のディレクトリの archive.jsonl へ移す。
 * 完了したタスクは人が消すまで残るので、使うほど台帳と一覧の送信が大きくなる。
 * 移したタスクは 1 行 1 タスク（成果物の本文を含む）で書き足す。ボードの「完了」の列から見返し、1 件ずつ戻せる。
 * 戻したタスクの行は消さない（台帳にあるタスクは一覧に出さない。また移すと新しい行が足され、後の行が勝つ）。
 */

/** 完了からこの日数が経ったら移す（Q534）。 */
export const TASK_BOARD_ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 移すかを調べる間隔。 */
export const TASK_BOARD_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
/** 1 回に書くタスクの数。初回は古い完了タスクがまとめて対象になるので、分けて書いて間に処理を返す。 */
const ARCHIVE_BATCH = 20;

export interface IArchiveEngine {
	archivableTasks(ageMs: number): ITaskBoardTask[];
	archiveStamp(task: ITaskBoardTask): ITaskBoardArchiveStamp;
	archiveTasks(stamps: readonly ITaskBoardArchiveStamp[]): number;
}

export interface IArchiveFiles {
	append(file: string, text: string): Promise<void>;
	/** ファイルの最後の 1 文字。無い・空なら `undefined`。 */
	lastChar(file: string): Promise<string | undefined>;
}

interface IArchiveLine {
	readonly archivedAt: number;
	readonly task: ITaskBoardTask;
}

export function archiveFile(directory: string): string {
	return path.join(directory, 'archive.jsonl');
}

/**
 * 移せるタスクを書き足してから台帳から外す。**書けなかったら外さない**（外してから書くと、失敗したときに消える）。
 * 書いている間に変わったタスクは外さない（エンジンが目印で確かめる）。書いた後に落ちても、次の回にもう一度書くだけ
 * （重複した行が残るが、後の行が勝つので記録は失われない）。外した数を返す。
 */
export async function archiveDoneTasks(engine: IArchiveEngine, file: string, ageMs = TASK_BOARD_ARCHIVE_AGE_MS, files: IArchiveFiles = nodeFiles): Promise<number> {
	const tasks = engine.archivableTasks(ageMs);
	let archived = 0;
	for (let start = 0; start < tasks.length; start += ARCHIVE_BATCH) {
		const batch = tasks.slice(start, start + ARCHIVE_BATCH);
		const stamps = batch.map(task => engine.archiveStamp(task));
		const archivedAt = Date.now();
		const text = batch.map(task => `${JSON.stringify({ archivedAt, task } satisfies IArchiveLine)}\n`).join('');
		// 前に途中で落ちて半端な行が残っていたら、その後ろにつなげない
		const last = await files.lastChar(file);
		await files.append(file, last !== undefined && last !== '\n' ? `\n${text}` : text);
		archived += engine.archiveTasks(stamps);
		await new Promise(resolve => setImmediate(resolve));
	}
	return archived;
}

/** ファイルの中のタスク（同じ id は後の行が勝つ）。読めない行は飛ばす。 */
export async function readArchive(file: string): Promise<Map<string, IArchiveLine>> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return new Map();
		}
		throw err;
	}
	const entries = new Map<string, IArchiveLine>();
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const entry = JSON.parse(line) as IArchiveLine;
			if (entry && typeof entry.archivedAt === 'number' && typeof entry.task?.id === 'string') {
				entries.set(entry.task.id, entry);
			}
		} catch {
			// 途中で落ちて残った半端な行
		}
	}
	return entries;
}

/** 見返す一覧（台帳に戻したものは除く。新しく移したものが先）。 */
export function listArchived(entries: ReadonlyMap<string, IArchiveLine>, onBoard: (taskId: string) => boolean): ITaskBoardArchivedTask[] {
	return [...entries.values()]
		.filter(entry => !onBoard(entry.task.id))
		.sort((a, b) => b.archivedAt - a.archivedAt)
		.map(({ archivedAt, task }) => ({ id: task.id, title: task.title, ...(task.issue ? { issue: task.issue } : {}), finishedAt: task.stepSince, archivedAt }));
}

/** ファイルから読んだタスクをボードに戻す。 */
export async function restoreFromArchive(engine: { getTask(taskId: string): ITaskBoardTask | undefined; restoreArchivedTask(task: ITaskBoardTask): void }, file: string, taskId: string): Promise<void> {
	const entry = (await readArchive(file)).get(taskId);
	if (!entry || engine.getTask(taskId)) {
		throw new TaskBoardError('not-found', 'archived task not found');
	}
	engine.restoreArchivedTask(entry.task);
}

const nodeFiles: IArchiveFiles = {
	async append(file, text) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.appendFile(file, text, 'utf8');
	},
	async lastChar(file) {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(file, 'r');
			const { size } = await handle.stat();
			if (size === 0) {
				return undefined;
			}
			const buffer = Buffer.alloc(1);
			await handle.read(buffer, 0, 1, size - 1);
			return buffer.toString('utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw err;
		} finally {
			await handle?.close();
		}
	},
};

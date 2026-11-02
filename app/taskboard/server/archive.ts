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
	/** ファイルの大きさ（バイト）と最後の 1 バイト。無いときは大きさ 0。 */
	tail(file: string): Promise<{ readonly size: number; readonly last: string | undefined }>;
}

interface IArchiveLine {
	readonly archivedAt: number;
	readonly task: ITaskBoardTask;
}

/** 索引の 1 行。件数と一覧は索引だけを読み、戻すときは位置から 1 行だけ読む。 */
interface IArchiveIndexEntry {
	readonly id: string;
	readonly title: string;
	readonly issue?: ITaskBoardArchivedTask['issue'];
	readonly finishedAt: number;
	readonly archivedAt: number;
	/** archive.jsonl の中の位置（バイト）と長さ（改行を含まない）。 */
	readonly offset: number;
	readonly length: number;
}

/** 索引の最後の行。ここまで書けた時の archive.jsonl の大きさ。食い違えば索引を作り直す。 */
interface IArchiveIndexCheckpoint {
	readonly size: number;
}

export function archiveFile(directory: string): string {
	return path.join(directory, 'archive.jsonl');
}

function indexFile(file: string): string {
	return file.replace(/\.jsonl$/, '.index.jsonl');
}

function indexEntry(line: IArchiveLine, offset: number, length: number): IArchiveIndexEntry {
	const { task, archivedAt } = line;
	return { id: task.id, title: task.title, ...(task.issue ? { issue: task.issue } : {}), finishedAt: task.stepSince, archivedAt, offset, length };
}

/**
 * 移せるタスクを書き足してから台帳から外す。**書けなかったら外さない**（外してから書くと、失敗したときに消える）。
 * 書いている間に変わったタスクは外さない（エンジンが目印で確かめる）。書いた後に落ちても、次の回にもう一度書くだけ
 * （重複した行が残るが、後の行が勝つので記録は失われない）。外した数を返す。
 */
export async function archiveDoneTasks(engine: IArchiveEngine, file: string, ageMs = TASK_BOARD_ARCHIVE_AGE_MS, files: IArchiveFiles = nodeFiles): Promise<number> {
	const tasks = engine.archivableTasks(ageMs);
	if (!tasks.length) {
		return 0;
	}
	// 書き足す前に索引が今のファイルと合っているか確かめる（合っていなければ作り直す）
	await readIndex(file, files);
	let archived = 0;
	for (let start = 0; start < tasks.length; start += ARCHIVE_BATCH) {
		const batch = tasks.slice(start, start + ARCHIVE_BATCH);
		const stamps = batch.map(task => engine.archiveStamp(task));
		const archivedAt = Date.now();
		const { size, last } = await files.tail(file);
		// 前に途中で落ちて半端な行が残っていたら、その後ろにつなげない
		const prefix = size > 0 && last !== '\n' ? '\n' : '';
		let offset = size + prefix.length;
		const lines: string[] = [];
		const entries: IArchiveIndexEntry[] = [];
		for (const task of batch) {
			const line: IArchiveLine = { archivedAt, task };
			const text = JSON.stringify(line);
			const length = Buffer.byteLength(text, 'utf8');
			lines.push(text);
			entries.push(indexEntry(line, offset, length));
			offset += length + 1;
		}
		await files.append(file, `${prefix}${lines.join('\n')}\n`);
		await files.append(indexFile(file), `${[...entries, { size: offset } satisfies IArchiveIndexCheckpoint].map(e => JSON.stringify(e)).join('\n')}\n`);
		archived += engine.archiveTasks(stamps);
		await new Promise(resolve => setImmediate(resolve));
	}
	return archived;
}

/**
 * 索引を読む（同じ id は後の行が勝つ）。索引が無い・壊れている・最後の大きさが archive.jsonl と合わないときは、
 * archive.jsonl を 1 行ずつ流して作り直す（丸ごとは読まない）。
 */
export async function readIndex(file: string, files: Pick<IArchiveFiles, 'tail'> = nodeFiles): Promise<Map<string, IArchiveIndexEntry>> {
	const { size } = await files.tail(file);
	const parsed = await parseIndex(indexFile(file));
	if (parsed && parsed.size === size) {
		return parsed.entries;
	}
	return rebuildIndex(file);
}

async function parseIndex(index: string): Promise<{ readonly entries: Map<string, IArchiveIndexEntry>; readonly size: number } | undefined> {
	let text: string;
	try {
		text = await fs.readFile(index, 'utf8');
	} catch {
		return undefined;
	}
	const entries = new Map<string, IArchiveIndexEntry>();
	let size: number | undefined;
	for (const line of text.split('\n')) {
		if (!line) {
			continue;
		}
		let value: Partial<IArchiveIndexEntry & IArchiveIndexCheckpoint>;
		try {
			value = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof value.id === 'string' && typeof value.offset === 'number' && typeof value.length === 'number') {
			entries.set(value.id, value as IArchiveIndexEntry);
			size = undefined;
		} else if (typeof value.size === 'number') {
			size = value.size;
		} else {
			return undefined;
		}
	}
	return size === undefined && entries.size ? undefined : { entries, size: size ?? 0 };
}

async function rebuildIndex(file: string): Promise<Map<string, IArchiveIndexEntry>> {
	const entries = new Map<string, IArchiveIndexEntry>();
	let size = 0;
	try {
		const handle = await fs.open(file, 'r');
		try {
			let offset = 0;
			let pending: Buffer[] = [];
			let pendingStart = 0;
			for await (const chunk of handle.createReadStream() as AsyncIterable<Buffer>) {
				let from = 0;
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] !== 0x0a) {
						continue;
					}
					pending.push(chunk.subarray(from, i));
					addRebuiltLine(entries, Buffer.concat(pending), pendingStart);
					pending = [];
					from = i + 1;
					pendingStart = offset + from;
				}
				if (from < chunk.length) {
					pending.push(chunk.subarray(from));
				}
				offset += chunk.length;
			}
			if (pending.length) {
				addRebuiltLine(entries, Buffer.concat(pending), pendingStart);
			}
			size = offset;
		} finally {
			await handle.close();
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	const text = [...entries.values(), { size } satisfies IArchiveIndexCheckpoint].map(e => JSON.stringify(e)).join('\n');
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${indexFile(file)}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${text}\n`, 'utf8');
	await fs.rename(tmp, indexFile(file));
	return entries;
}

function addRebuiltLine(entries: Map<string, IArchiveIndexEntry>, bytes: Buffer, offset: number): void {
	if (!bytes.length) {
		return;
	}
	try {
		const line = JSON.parse(bytes.toString('utf8')) as IArchiveLine;
		if (line && typeof line.archivedAt === 'number' && typeof line.task?.id === 'string') {
			entries.set(line.task.id, indexEntry(line, offset, bytes.length));
		}
	} catch {
		// 途中で落ちて残った半端な行
	}
}

/** 見返す一覧（台帳に戻したものは除く。新しく移したものが先）。 */
export function listArchived(entries: ReadonlyMap<string, IArchiveIndexEntry>, onBoard: (taskId: string) => boolean): ITaskBoardArchivedTask[] {
	return [...entries.values()]
		.filter(entry => !onBoard(entry.id))
		.sort((a, b) => b.archivedAt - a.archivedAt)
		.map(({ id, title, issue, finishedAt, archivedAt }) => ({ id, title, ...(issue ? { issue } : {}), finishedAt, archivedAt }));
}

/** ファイルから 1 行だけ読んでタスクをボードに戻す。 */
export async function restoreFromArchive(engine: { getTask(taskId: string): ITaskBoardTask | undefined; restoreArchivedTask(task: ITaskBoardTask): void }, file: string, taskId: string): Promise<void> {
	const entry = (await readIndex(file)).get(taskId);
	if (!entry || engine.getTask(taskId)) {
		throw new TaskBoardError('not-found', 'archived task not found');
	}
	const handle = await fs.open(file, 'r');
	let line: IArchiveLine;
	try {
		const buffer = Buffer.alloc(entry.length);
		await handle.read(buffer, 0, entry.length, entry.offset);
		line = JSON.parse(buffer.toString('utf8')) as IArchiveLine;
	} finally {
		await handle.close();
	}
	if (line?.task?.id !== taskId) {
		throw new TaskBoardError('not-found', 'archived task not found');
	}
	engine.restoreArchivedTask(line.task);
}

const nodeFiles: IArchiveFiles = {
	async append(file, text) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.appendFile(file, text, 'utf8');
	},
	async tail(file) {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(file, 'r');
			const { size } = await handle.stat();
			if (size === 0) {
				return { size, last: undefined };
			}
			const buffer = Buffer.alloc(1);
			await handle.read(buffer, 0, 1, size - 1);
			return { size, last: buffer.toString('latin1') };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return { size: 0, last: undefined };
			}
			throw err;
		} finally {
			await handle?.close();
		}
	},
};

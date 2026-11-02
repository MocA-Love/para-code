// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardArchiveStamp } from '@engine/paradisTaskBoardEngine.js';
import { archiveDoneTasks, archiveFile, listArchived, readArchive, restoreFromArchive, type IArchiveEngine, type IArchiveFiles } from '../server/archive.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempFile(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'taskboard-archive-'));
	dirs.push(dir);
	return archiveFile(dir);
}

const task = (id: string): ITaskBoardTask => ({ id, title: `T ${id}`, stepSince: 5, updatedAt: 1, artifacts: [{ id: 'a', kind: 'plan', title: 'p', content: '# plan' }] } as unknown as ITaskBoardTask);

function fakeEngine(ids: string[]): IArchiveEngine & { readonly removed: string[] } {
	const removed: string[] = [];
	return {
		removed,
		archivableTasks: () => ids.map(task),
		archiveStamp: t => ({ id: t.id, updatedAt: t.updatedAt, revision: 0 }),
		archiveTasks: (stamps: readonly ITaskBoardArchiveStamp[]) => { removed.push(...stamps.map(s => s.id)); return stamps.length; },
	};
}

describe('完了したタスクをファイルへ移す', () => {
	test('本文ごと書き足してから外し、書けなければ外さない。数十件ずつに分け、半端な行の後ろにはつなげない', async () => {
		const file = tempFile();
		const many = fakeEngine(Array.from({ length: 45 }, (_, i) => `m${i}`));
		const appends: number[] = [];
		const counting: IArchiveFiles = {
			append: async (f, text) => { appends.push(text.split('\n').filter(Boolean).length); appendFileSync(f, text); },
			lastChar: async f => { try { return readFileSync(f, 'utf8').slice(-1) || undefined; } catch { return undefined; } },
		};
		const archived = await archiveDoneTasks(many, file, undefined, counting);
		appendFileSync(file, '{"archivedAt":1,"task":{"id":"half'); // 途中で落ちた半端な行
		const afterHalf = await archiveDoneTasks(fakeEngine(['t4']), file, undefined, counting);
		const failing = fakeEngine(['t3']);
		const failure = await archiveDoneTasks(failing, file, undefined, { ...counting, append: () => Promise.reject(new Error('disk full')) }).catch((err: Error) => err.message);
		const entries = await readArchive(file);

		expect({
			archived, afterHalf, failure,
			appends,
			failingRemoved: failing.removed,
			entries: entries.size,
			t4: entries.get('t4')?.task.artifacts[0].content,
			lastLineIntact: readFileSync(file, 'utf8').trim().split('\n').at(-1)?.startsWith('{"archivedAt"'),
		}).toEqual({
			archived: 45, afterHalf: 1, failure: 'disk full',
			appends: [20, 20, 5, 1],
			failingRemoved: [],
			entries: 46,
			t4: '# plan',
			lastLineIntact: true,
		});
	});

	test('見返す一覧は台帳にあるものを除いて新しい順に並べ、後の行が勝つ。戻すとエンジンへ渡す', async () => {
		const file = tempFile();
		writeFileSync(file, [
			JSON.stringify({ archivedAt: 10, task: task('a') }),
			JSON.stringify({ archivedAt: 20, task: task('b') }),
			JSON.stringify({ archivedAt: 30, task: { ...task('a'), title: 'T a again' } }),
			JSON.stringify({ archivedAt: 40, task: task('onBoard') }),
		].join('\n') + '\n');
		const entries = await readArchive(file);
		const restored: string[] = [];
		const engine = { getTask: (id: string) => id === 'onBoard' ? task(id) : undefined, restoreArchivedTask: (t: ITaskBoardTask) => { restored.push(t.title); } };
		await restoreFromArchive(engine, file, 'a');
		const missing = await restoreFromArchive(engine, file, 'nope').then(() => 'ok', (err: Error) => err.message);
		const onBoard = await restoreFromArchive(engine, file, 'onBoard').then(() => 'ok', (err: Error) => err.message);

		expect({
			list: listArchived(entries, id => id === 'onBoard').map(t => [t.id, t.title, t.archivedAt, t.finishedAt]),
			restored, missing, onBoard,
		}).toEqual({
			list: [['a', 'T a again', 30, 5], ['b', 'T b', 20, 5]],
			restored: ['T a again'],
			missing: 'archived task not found',
			onBoard: 'archived task not found',
		});
	});
});

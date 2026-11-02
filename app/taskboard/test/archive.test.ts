// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardArchiveStamp } from '@engine/paradisTaskBoardEngine.js';
import { archiveDoneTasks, archiveFile, listArchived, readIndex, restoreFromArchive, type IArchiveEngine, type IArchiveFiles } from '../server/archive.js';

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
			append: async (f, text) => { if (f === file) { appends.push(text.split('\n').filter(Boolean).length); } appendFileSync(f, text); },
			tail: async f => { try { const b = readFileSync(f); return { size: b.length, last: b.length ? String.fromCharCode(b[b.length - 1]) : undefined }; } catch { return { size: 0, last: undefined }; } },
		};
		const archived = await archiveDoneTasks(many, file, undefined, counting);
		appendFileSync(file, '{"archivedAt":1,"task":{"id":"half'); // 途中で落ちた半端な行
		const afterHalf = await archiveDoneTasks(fakeEngine(['t4']), file, undefined, counting);
		const failing = fakeEngine(['t3']);
		const failure = await archiveDoneTasks(failing, file, undefined, { ...counting, append: () => Promise.reject(new Error('disk full')) }).catch((err: Error) => err.message);
		const entries = await readIndex(file);

		expect({
			archived, afterHalf, failure,
			appends,
			failingRemoved: failing.removed,
			entries: entries.size,
			t4: entries.get('t4')?.title,
			lastLineIntact: readFileSync(file, 'utf8').trim().split('\n').at(-1)?.startsWith('{"archivedAt"'),
		}).toEqual({
			archived: 45, afterHalf: 1, failure: 'disk full',
			appends: [20, 20, 5, 1],
			failingRemoved: [],
			entries: 46,
			t4: 'T t4',
			lastLineIntact: true,
		});
	});

	test('件数と一覧は索引だけを読み、戻すときは位置から 1 行だけ読む。索引が無い・合わないときは流して作り直す', async () => {
		const file = tempFile();
		writeFileSync(file, [
			JSON.stringify({ archivedAt: 10, task: task('a') }),
			JSON.stringify({ archivedAt: 20, task: { ...task('b'), title: 'T b ✓' } }),
			JSON.stringify({ archivedAt: 30, task: { ...task('a'), title: 'T a again' } }),
			'{"archivedAt":35,"task":{"id":"half',
			JSON.stringify({ archivedAt: 40, task: task('onBoard') }),
		].join('\n') + '\n');
		// 索引が無いので作り直す（半端な行は飛ばし、後の行が勝つ）
		const rebuilt = await readIndex(file);
		const indexText = readFileSync(file.replace(/\.jsonl$/, '.index.jsonl'), 'utf8');
		const restored: string[] = [];
		const engine = { getTask: (id: string) => id === 'onBoard' ? task(id) : undefined, restoreArchivedTask: (t: ITaskBoardTask) => { restored.push(t.title); } };
		await restoreFromArchive(engine, file, 'b');
		await restoreFromArchive(engine, file, 'a');
		const missing = await restoreFromArchive(engine, file, 'nope').then(() => 'ok', (err: Error) => err.message);
		const onBoard = await restoreFromArchive(engine, file, 'onBoard').then(() => 'ok', (err: Error) => err.message);
		// 索引の後ろで archive.jsonl だけが伸びた（索引を書く前に落ちた）→ 合わないので作り直す
		appendFileSync(file, `${JSON.stringify({ archivedAt: 50, task: task('late') })}\n`);
		const afterGrowth = await readIndex(file);

		expect({
			list: listArchived(rebuilt, id => id === 'onBoard').map(t => [t.id, t.title, t.archivedAt, t.finishedAt]),
			indexHasNoBodies: !indexText.includes('# plan'),
			restored, missing, onBoard,
			afterGrowth: [...afterGrowth.keys()].sort(),
		}).toEqual({
			list: [['a', 'T a again', 30, 5], ['b', 'T b ✓', 20, 5]],
			indexHasNoBodies: true,
			restored: ['T b ✓', 'T a again'],
			missing: 'archived task not found',
			onBoard: 'archived task not found',
			afterGrowth: ['a', 'b', 'late', 'onBoard'],
		});
	});
});

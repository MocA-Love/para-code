// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { archiveDoneTasks, archiveFile, type IArchiveEngine } from '../server/archive.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakeEngine(ids: string[]): IArchiveEngine & { readonly removed: string[] } {
	const removed: string[] = [];
	return {
		removed,
		archivableTasks: () => ids.map(id => ({ id, artifacts: [{ id: 'a', kind: 'plan', title: 'p', content: '# plan' }] } as unknown as ITaskBoardTask)),
		archiveTasks: taskIds => { removed.push(...taskIds); return taskIds.length; },
	};
}

describe('完了したタスクをファイルへ移す', () => {
	test('本文ごと 1 行 1 タスクで書き足してから台帳から外し、書けなければ外さない', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'taskboard-archive-'));
		dirs.push(dir);
		const file = archiveFile(dir);
		const ok = fakeEngine(['t1', 't2']);
		const failing = fakeEngine(['t3']);
		const none = fakeEngine([]);

		const archived = await archiveDoneTasks(ok, file);
		const again = await archiveDoneTasks(fakeEngine(['t4']), file);
		const failure = await archiveDoneTasks(failing, file, undefined, () => Promise.reject(new Error('disk full'))).catch((err: Error) => err.message);
		const nothing = await archiveDoneTasks(none, file, undefined, () => Promise.reject(new Error('must not write')));
		const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { task: ITaskBoardTask });

		expect({
			archived, again, failure, nothing,
			removed: [ok.removed, failing.removed],
			lines: lines.map(line => [line.task.id, line.task.artifacts[0].content]),
		}).toEqual({
			archived: 2, again: 1, failure: 'disk full', nothing: 0,
			removed: [['t1', 't2'], []],
			lines: [['t1', '# plan'], ['t2', '# plan'], ['t4', '# plan']],
		});
	});
});

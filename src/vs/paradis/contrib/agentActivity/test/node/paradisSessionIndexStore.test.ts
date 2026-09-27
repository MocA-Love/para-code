/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { IParadisIndexFile, ParadisSessionIndexStore } from '../../node/paradisSessionIndexStore.js';
import { ParadisAgentActivityWorkerHost } from '../../node/paradisAgentActivityWorkerHost.js';

const WORKER_PATH = FileAccess.asFileUri('vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain.js').fsPath;

function line(role: 'user' | 'assistant', text: string): string {
	return JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content: text } });
}

suite('ParadisSessionIndexStore', function () {
	this.timeout(20_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-index-store-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function indexFile(path: string): Promise<IParadisIndexFile> {
		const stat = await fs.stat(path);
		return { path, agent: 'claude', catalogId: 'c1', dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
	}

	test('drops what it read when the transcript was swapped after listing, so the next update does not duplicate it', async () => {
		const transcript = join(root, 'a.jsonl');
		await fs.writeFile(transcript, `${line('user', 'スワップ前の依頼です')}\n${line('assistant', '返答です')}\n`);
		const store = new ParadisSessionIndexStore(join(root, 'index.sqlite'));
		try {
			const listed = await indexFile(transcript);
			// 列挙した後に別のファイルへ差し替えられた状態（開いたファイルの inode が列挙時と違う）
			await store.update([{ ...listed, ino: listed.ino + 1 }], { includeToolOutput: false });
			const afterSwap = store.stats();
			await store.update([await indexFile(transcript)], { includeToolOutput: false });
			const afterReread = store.stats();
			assert.deepStrictEqual({ afterSwap, afterReread, hits: store.search('スワップ前', ['c1']).matches.map(match => match.matchCount) }, {
				afterSwap: { files: 1, messages: 0 },
				afterReread: { files: 1, messages: 2 },
				hits: [1],
			});
		} finally {
			store.close();
		}
	});

	test('stops at a line boundary when asked and continues from there on the next update', async () => {
		const transcript = join(root, 'b.jsonl');
		await fs.writeFile(transcript, [line('user', '一つ目の依頼'), line('assistant', '二つ目の返答'), line('user', '三つ目の依頼')].join('\n') + '\n');
		const store = new ParadisSessionIndexStore(join(root, 'index.sqlite'));
		try {
			let lines = 0;
			const aborted = await store.update([await indexFile(transcript)], { includeToolOutput: false }, () => ++lines < 2);
			const partial = store.stats();
			const resumed = await store.update([await indexFile(transcript)], { includeToolOutput: false });
			assert.deepStrictEqual({ aborted: aborted.aborted, partial, resumed: resumed.aborted, full: store.stats() }, {
				aborted: true,
				partial: { files: 1, messages: 1 },
				resumed: false,
				full: { files: 1, messages: 3 },
			});
		} finally {
			store.close();
		}
	});

	test('recreates a database it cannot open', async () => {
		const dbPath = join(root, 'broken.sqlite');
		await fs.writeFile(dbPath, 'this is not a database');
		const store = new ParadisSessionIndexStore(dbPath);
		try {
			assert.deepStrictEqual(store.stats(), { files: 0, messages: 0 });
		} finally {
			store.close();
		}
	});

	/** DB と、その隣の WAL の生のバイト列に `text` が含まれるか。 */
	async function onDisk(dbPath: string, text: string): Promise<boolean> {
		const needle = Buffer.from(text, 'utf8');
		for (const file of [dbPath, `${dbPath}-wal`]) {
			const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0));
			if (bytes.includes(needle)) {
				return true;
			}
		}
		return false;
	}

	test('leaves no deleted text in the database or the WAL after retention and after a transcript disappears, without rewriting the index', async () => {
		const dbPath = join(root, 'index.sqlite');
		const expiring = join(root, 'expiring.jsonl');
		const removed = join(root, 'removed.jsonl');
		const kept = join(root, 'kept.jsonl');
		await fs.writeFile(expiring, `${line('user', 'EXPIRING_SECRET_A1B2C3 を保存')}\n`);
		await fs.writeFile(removed, `${line('user', 'REMOVED_SECRET_D4E5F6 を保存')}\n`);
		await fs.writeFile(kept, `${line('user', '残る会話の本文です')}\n`);
		const store = new ParadisSessionIndexStore(dbPath);
		try {
			const files = [
				{ ...await indexFile(expiring), catalogId: 'expiring', mtimeMs: 1_000 },
				{ ...await indexFile(removed), catalogId: 'removed', mtimeMs: 50_000 },
				{ ...await indexFile(kept), catalogId: 'kept', mtimeMs: 50_000 },
			];
			await store.update(files, { includeToolOutput: false });
			const before = [await onDisk(dbPath, 'EXPIRING_SECRET_A1B2C3'), await onDisk(dbPath, 'REMOVED_SECRET_D4E5F6')];
			const pruned = store.prune(10_000, false);
			const afterPrune = await onDisk(dbPath, 'EXPIRING_SECRET_A1B2C3');
			await store.update(files.filter(file => file.catalogId === 'kept'), { includeToolOutput: false });
			const afterRemoval = await onDisk(dbPath, 'REMOVED_SECRET_D4E5F6');
			const nothingExpired = store.prune(10_000, false);
			assert.deepStrictEqual({ before, pruned, afterPrune, afterRemoval, nothingExpired, stats: store.stats(), kept: store.search('残る会話', ['kept']).matches.length }, {
				before: [true, true], pruned: 1, afterPrune: false, afterRemoval: false, nothingExpired: 0, stats: { files: 1, messages: 1 }, kept: 1,
			});
		} finally {
			store.close();
		}
	});

	test('does not count a transcript as indexed until it has been read to the end', async () => {
		const transcript = join(root, 'partial.jsonl');
		await fs.writeFile(transcript, [line('user', '一つ目の依頼です'), line('user', '二つ目の依頼です')].join('\n') + '\n');
		const store = new ParadisSessionIndexStore(join(root, 'index.sqlite'));
		try {
			let calls = 0;
			await store.update([await indexFile(transcript)], { includeToolOutput: false }, () => ++calls < 2);
			const partial = store.search('一つ目の依頼', ['c1']);
			await store.update([await indexFile(transcript)], { includeToolOutput: false });
			const complete = store.search('一つ目の依頼', ['c1']);
			assert.deepStrictEqual({ partial: [partial.uncovered, partial.matches.length], complete: [complete.uncovered, complete.matches.length] }, {
				partial: [['c1'], 0], complete: [[], 1],
			});
		} finally {
			store.close();
		}
	});

	test('stops updates that were queued before an abort, even if they have not started yet, and deletes the index after them', async () => {
		const dbPath = join(root, 'worker.sqlite');
		const files: IParadisIndexFile[] = [];
		for (let index = 0; index < 20; index++) {
			const path = join(root, `many-${index}.jsonl`);
			await fs.writeFile(path, Array.from({ length: 50 }, (_, n) => line('user', `会話 ${index} の ${n} 番目の依頼です`)).join('\n') + '\n');
			files.push({ ...await indexFile(path), catalogId: `c${index}` });
		}
		const host = disposables.add(new ParadisAgentActivityWorkerHost(ParadisAgentActivityWorkerHost.workerFactory(WORKER_PATH), 10_000));
		const first = host.request<{ aborted: boolean }>({ op: 'indexUpdate', dbPath, files, includeToolOutput: false });
		const queued = host.request<{ aborted: boolean }>({ op: 'indexUpdate', dbPath, files, includeToolOutput: false });
		await host.request({ op: 'indexAbort' });
		const deleted = host.request({ op: 'indexDelete', dbPath });
		const results = [(await first).aborted, (await queued).aborted];
		await deleted;
		assert.deepStrictEqual({ results, databaseRemoved: await fs.stat(dbPath).then(() => false, () => true) }, { results: [true, true], databaseRemoved: true });
	});
});

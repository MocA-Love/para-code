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
import { IParadisIndexFile, ParadisSessionIndexStore } from '../../node/paradisSessionIndexStore.js';

function line(role: 'user' | 'assistant', text: string): string {
	return JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content: text } });
}

suite('ParadisSessionIndexStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
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
});

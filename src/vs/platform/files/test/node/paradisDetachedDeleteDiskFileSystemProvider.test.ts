/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, promises } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../../base/common/async.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ParadisDetachedDeleteDiskFileSystemProvider, paradisSpawnRemove } from '../../node/paradisDetachedDeleteDiskFileSystemProvider.js';

(isWindows ? suite.skip : suite)('ParadisDetachedDeleteDiskFileSystemProvider', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let dataPath: string;
	let removed: string[];

	setup(async () => {
		root = getRandomTestPath(tmpdir(), 'vsctests', 'paradisdetacheddelete');
		dataPath = join(root, 'data');
		removed = [];
		await promises.mkdir(join(root, 'work', 'big', 'nested'), { recursive: true });
		await promises.writeFile(join(root, 'work', 'big', 'nested', 'a.js'), 'a');
		await promises.writeFile(join(root, 'work', 'single.txt'), 's');
	});

	teardown(() => promises.rm(root, { recursive: true, force: true }));

	/** 消す処理を記録し、実際に消してから終了コードを返す替え玉。 */
	function recordingRemove(code: number | null = 0): (path: string) => Promise<number | null> {
		return async path => {
			removed.push(path);
			await promises.rm(path, { recursive: true, force: true });
			return code;
		};
	}

	function create(spawnRemove: (path: string) => Promise<number | null>, data: string | undefined = dataPath): ParadisDetachedDeleteDiskFileSystemProvider {
		return store.add(new ParadisDetachedDeleteDiskFileSystemProvider(new NullLogService(), data, spawnRemove));
	}

	test('moves a folder deleted with its contents into the data folder and removes it in another process without waiting', async () => {
		const removing = new DeferredPromise<number | null>();
		const calls: string[] = [];
		const provider = create(path => { calls.push(path); return removing.p; });
		const target = join(root, 'work', 'big');

		await provider.delete(URI.file(target), { recursive: true, useTrash: false, atomic: false });
		const moved = calls[0];
		const state = {
			targetExists: existsSync(target),
			calls: calls.length,
			movedInto: moved === undefined ? undefined : dirname(moved),
			movedName: moved === undefined ? undefined : basename(moved).startsWith('.para-deleting-'),
			movedStillThere: moved === undefined ? undefined : existsSync(join(moved, 'nested', 'a.js')),
		};
		removing.complete(0);
		assert.deepStrictEqual(state, {
			targetExists: false,
			calls: 1,
			movedInto: join(dataPath, 'paradisDeleting'),
			movedName: true,
			movedStillThere: true,
		});
	});

	test('waits for another process to remove a folder it cannot move, and falls back to the upstream delete when that fails', async () => {
		// atomic の退避先が既にあると rename できない。
		const target = join(root, 'work', 'big');
		await promises.mkdir(`${target}.bak`, { recursive: true });
		await promises.writeFile(join(`${target}.bak`, 'keep.txt'), 'k');
		const provider = create(recordingRemove());
		await provider.delete(URI.file(target), { recursive: true, useTrash: false, atomic: { postfix: '.bak' } });

		const failing = create(async path => { removed.push(path); return 1; });
		await promises.mkdir(join(root, 'work', 'other'), { recursive: true });
		await promises.mkdir(join(root, 'work', 'other.bak', 'x'), { recursive: true });
		await failing.delete(URI.file(join(root, 'work', 'other')), { recursive: true, useTrash: false, atomic: { postfix: '.bak' } });

		assert.deepStrictEqual({
			removed,
			targetExists: existsSync(target),
			otherExists: existsSync(join(root, 'work', 'other')),
			backupKept: existsSync(join(`${target}.bak`, 'keep.txt')),
		}, {
			removed: [target, join(root, 'work', 'other')],
			targetExists: false,
			otherExists: false,
			backupKept: true,
		});
	});

	test('leaves files, the trash and missing folders to the upstream delete', async () => {
		const provider = create(recordingRemove());
		await provider.delete(URI.file(join(root, 'work', 'single.txt')), { recursive: false, useTrash: false, atomic: false });
		await provider.delete(URI.file(join(root, 'work', 'missing')), { recursive: true, useTrash: false, atomic: false });
		assert.deepStrictEqual({ removed, singleExists: existsSync(join(root, 'work', 'single.txt')) }, { removed: [], singleExists: false });
	});

	test('removes leftovers of an earlier server in the data folder, and nothing else, when it starts', async () => {
		const trash = join(dataPath, 'paradisDeleting');
		await promises.mkdir(join(trash, '.para-deleting-left', 'x'), { recursive: true });
		await promises.writeFile(join(trash, 'unrelated.txt'), 'u');
		const done = new DeferredPromise<void>();
		create(async path => {
			removed.push(path);
			await promises.rm(path, { recursive: true, force: true });
			done.complete();
			return 0;
		});
		await done.p;
		assert.deepStrictEqual({ removed, unrelated: existsSync(join(trash, 'unrelated.txt')) }, { removed: [join(trash, '.para-deleting-left')], unrelated: true });
	});

	test('removes a folder with rm in a child process', async () => {
		const target = join(root, 'work', 'big');
		const code = await paradisSpawnRemove(target);
		assert.deepStrictEqual({ code, exists: existsSync(target) }, { code: 0, exists: false });
	});
});

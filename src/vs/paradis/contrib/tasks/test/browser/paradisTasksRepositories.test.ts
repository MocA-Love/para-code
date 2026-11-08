/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisTasksResolveRepositories, paradisTasksResolveRepository } from '../../browser/paradisTasksRepositories.js';

suite('ParadisTasksRepositories', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// git に解かせた origin（~/.gitconfig の insteadOf まで当てたもの）を使い、読めなければ .git/config の字面に戻す
	test('uses the origin git resolved, and falls back to .git/config when git cannot be asked', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const folder = URI.file('/work/repo');
		await fileService.writeFile(URI.file('/work/repo/.git/config'), VSBuffer.fromString('[remote "origin"]\n\turl = gh:owner/from-config\n[url "git@github.com:"]\n\tinsteadOf = gh:\n'));
		const plain = URI.file('/work/plain');
		await fileService.createFolder(plain);

		assert.deepStrictEqual(await Promise.all([
			paradisTasksResolveRepository(fileService, folder, async () => 'git@github.com:owner/from-git.git'),
			paradisTasksResolveRepository(fileService, folder, async () => undefined),
			paradisTasksResolveRepository(fileService, folder, async () => { throw new Error('old host'); }),
			paradisTasksResolveRepository(fileService, folder),
			// .git の無いフォルダは git に聞かない（親のリポジトリの origin を拾わない）
			paradisTasksResolveRepository(fileService, plain, async () => 'git@github.com:owner/parent.git'),
		]), ['owner/from-git', 'owner/from-config', 'owner/from-config', 'owner/from-config', undefined]);
	});

	// スペースが多くても、git は同時に 4 本までしか起動しない
	test('asks git for at most four folders at a time', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const sources = [];
		for (let index = 0; index < 10; index++) {
			await fileService.writeFile(URI.file(`/work/repo${index}/.git/config`), VSBuffer.fromString(''));
			sources.push({ name: `repo${index}`, uri: URI.file(`/work/repo${index}`) });
		}
		let running = 0;
		let most = 0;
		const repositories = await paradisTasksResolveRepositories(fileService, sources, async folder => {
			most = Math.max(most, ++running);
			await new Promise(resolve => setTimeout(resolve, 1));
			running--;
			return `git@github.com:owner/${folder.path.split('/').pop()}.git`;
		});
		assert.deepStrictEqual({ most, count: repositories.length }, { most: 4, count: 10 });
	});
});

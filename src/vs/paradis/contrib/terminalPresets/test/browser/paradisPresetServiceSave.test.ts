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
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IFileStatWithMetadata, IWriteFileOptions } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IParadisAgentStatusStore, IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisPresetService } from '../../browser/paradisPresetService.js';

suite('ParadisPresetService save', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a preset another window saved between reading and writing .paracode.json', async () => {
		// 書くたびに mtime が進む。etag はその値で代用する。
		const file = { text: JSON.stringify({ presets: [{ name: 'a', commands: ['a'] }] }), mtime: 1 };
		let reads = 0;
		const folders: URI[] = [];
		const service = store.add(new ParadisPresetService(
			upcastPartial<IConfigurationService>({ onDidChangeConfiguration: Event.None, getValue: () => undefined }),
			upcastPartial<IWorkspaceContextService>({
				onDidChangeWorkspaceFolders: Event.None,
				getWorkspace: () => upcastPartial<IWorkspace>({ folders: folders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) }),
			}),
			upcastPartial<IFileService>({
				readFile: async () => {
					const content = upcastPartial<IFileContent>({ value: VSBuffer.fromString(file.text), etag: String(file.mtime), mtime: file.mtime });
					if (++reads === 1) {
						// 読んだ直後に、別のウィンドウが同じファイルへ保存する。
						file.text = JSON.stringify({ presets: [{ name: 'a', commands: ['a'] }, { name: 'other', commands: ['o'] }] });
						file.mtime++;
					}
					return content;
				},
				writeFile: (async (_resource: URI, buffer: VSBuffer, options?: IWriteFileOptions) => {
					// FileService と同じく、mtime と etag の両方があり、読んだ後に変わっていたときだけ拒む。
					// どちらも無ければそのまま上書きする。
					if (typeof options?.mtime === 'number' && typeof options.etag === 'string' && options.mtime < file.mtime && options.etag !== String(file.mtime)) {
						throw new FileOperationError('modified since', FileOperationResult.FILE_MODIFIED_SINCE);
					}
					file.text = buffer.toString();
					file.mtime++;
					return upcastPartial<IFileStatWithMetadata>({});
				}) as IFileService['writeFile'],
			}),
			upcastPartial<ITerminalService>({ instances: [], onDidCreateInstance: Event.None }),
			upcastPartial<IEditorGroupsService>({ activeGroup: upcastPartial<IEditorGroup>({ id: 1 }), getGroups: () => [] }),
			upcastPartial<IWorkspaceTrustManagementService>({ onDidChangeTrust: Event.None }),
			new NullLogService(),
			upcastPartial<IParadisTerminalScopeService>({}),
			store.add(new InMemoryStorageService()),
			upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: undefined }),
			upcastPartial<IParadisAgentStatusStore>({}),
			upcastPartial<IParadisAuxiliaryWindowScopeService>({}),
			upcastPartial<IParadisWorkspaceSwitchService>({ onDidChangeRepositories: Event.None, repositories: [] }),
			upcastPartial<IParadisWorktreeService>({ onDidChangeWorktrees: Event.None, getWorktrees: () => [] }),
		));
		// フォルダの監視を張らせないよう、サービスを作った後でフォルダを開いた状態にする。
		folders.push(URI.file('/repos/a'));

		await service.savePreset({ name: 'mine', commands: ['m'] }, 'workspace');

		assert.deepStrictEqual((JSON.parse(file.text).presets as { name: string }[]).map(preset => preset.name), ['a', 'other', 'mine']);
	});
});

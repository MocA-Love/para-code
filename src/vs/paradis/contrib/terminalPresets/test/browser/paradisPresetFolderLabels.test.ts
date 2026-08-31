/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IParadisTerminalScopeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisPresetService } from '../../browser/paradisPresetService.js';
import { paradisPresetFolderKey } from '../../common/paradisTerminalPresets.js';

class TestTerminalService extends mock<ITerminalService>() {
	override readonly instances = [];
	override readonly onDidCreateInstance = Event.None;
}

class TestWorkspaceTrustService extends mock<IWorkspaceTrustManagementService>() {
	override readonly onDidChangeTrust = Event.None;
	override isWorkspaceTrusted(): boolean { return true; }
}

suite('ParadisPresetService folder labels', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(storage: InMemoryStorageService): ParadisPresetService {
		return disposables.add(new ParadisPresetService(
			new TestConfigurationService(),
			new TestContextService(testWorkspace()),
			new class extends mock<IFileService>() { },
			new TestTerminalService(),
			new class extends mock<IEditorGroupsService>() { },
			new TestWorkspaceTrustService(),
			new NullLogService(),
			new class extends mock<IParadisTerminalScopeService>() { },
			storage,
			{ remoteAuthority: undefined } as IWorkbenchEnvironmentService,
		));
	}

	test('keys separate user and repository folders while ignoring display whitespace', () => {
		const workspaceA = URI.file('/repo-a/.paracode.json');
		const workspaceB = URI.file('/repo-b/.paracode.json');

		assert.deepStrictEqual(
			[
				paradisPresetFolderKey({ source: 'user' }, ' Build '),
				paradisPresetFolderKey({ source: 'workspace', sourceUri: workspaceA }, 'Build'),
				paradisPresetFolderKey({ source: 'workspace', sourceUri: workspaceB }, 'Build'),
			],
			[
				'user::Build',
				`workspace:${workspaceA.toString()}::Build`,
				`workspace:${workspaceB.toString()}::Build`,
			],
		);
	});

	test('merges folder label choices made by different windows sharing the profile', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const firstWindow = createService(storage);
		const secondWindow = createService(storage);
		const build = paradisPresetFolderKey({ source: 'user' }, 'Build');
		const test = paradisPresetFolderKey({ source: 'user' }, 'Test');

		firstWindow.setFolderLabelShown(build, true);
		secondWindow.setFolderLabelShown(test, true);

		assert.deepStrictEqual(
			{
				first: [firstWindow.isFolderLabelShown(build), firstWindow.isFolderLabelShown(test)],
				second: [secondWindow.isFolderLabelShown(build), secondWindow.isFolderLabelShown(test)],
			},
			{ first: [true, true], second: [true, true] },
		);

		firstWindow.setFolderLabelShown(build, false);
		assert.deepStrictEqual(
			{
				first: [firstWindow.isFolderLabelShown(build), firstWindow.isFolderLabelShown(test)],
				second: [secondWindow.isFolderLabelShown(build), secondWindow.isFolderLabelShown(test)],
			},
			{ first: [false, true], second: [false, true] },
		);
	});
});

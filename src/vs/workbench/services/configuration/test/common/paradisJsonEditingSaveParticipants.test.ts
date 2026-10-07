/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IFilesConfigurationService } from '../../../filesConfiguration/common/filesConfigurationService.js';
import { ITextFileSaveOptions, ITextFileService } from '../../../textfile/common/textfiles.js';
import { JSONEditingService } from '../../common/jsonEditingService.js';
import { paradisSetManagedWorkspaceWindowForTest } from '../../../../../paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitch.js';

suite('JSONEditingService (Para Code save participants)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function writeAndCaptureSaveOptions(resource: URI): Promise<ITextFileSaveOptions | undefined | 'not-saved'> {
		const model = store.add(createTextModel('{}', null, undefined, resource));
		let saved: ITextFileSaveOptions | undefined | 'not-saved' = 'not-saved';
		const service = new JSONEditingService(
			{ exists: async () => true } as unknown as IFileService,
			{ createModelReference: async () => ({ object: { textEditorModel: model }, dispose: () => { } }) } as unknown as ITextModelService,
			{ files: { get: () => undefined }, save: async (_resource: URI, options?: ITextFileSaveOptions) => { saved = options; return resource; } } as unknown as ITextFileService,
			{ enableAutoSaveAfterShortDelay: () => Disposable.None } as unknown as IFilesConfigurationService,
		);
		await service.write(resource, [{ path: ['folders'], value: [{ path: '/workspace-b' }] }]);
		return saved;
	}

	test('skips save participants only for workspace files of a window that switches spaces', async () => {
		const workspaceFile = URI.file('/home/example/.para-code/para.code-workspace');
		const previous = paradisSetManagedWorkspaceWindowForTest(true);
		try {
			const managed = {
				workspaceFile: await writeAndCaptureSaveOptions(workspaceFile),
				settingsFile: await writeAndCaptureSaveOptions(URI.file('/home/example/.config/settings.json')),
			};
			paradisSetManagedWorkspaceWindowForTest(false);
			const unmanagedWorkspaceFile = await writeAndCaptureSaveOptions(workspaceFile);
			assert.deepStrictEqual({ managed, unmanagedWorkspaceFile }, {
				managed: {
					// para.code-workspace は Para Code がスペースの切り替えのたびに書く。整形や拡張の onWillSave を待たない。
					workspaceFile: { skipSaveParticipants: true },
					// ユーザー設定などは従来どおり。
					settingsFile: undefined,
				},
				// スペースを切り替えないウィンドウ (普通の .code-workspace) は upstream どおり。
				unmanagedWorkspaceFile: undefined,
			});
		} finally {
			paradisSetManagedWorkspaceWindowForTest(previous);
		}
	});
});

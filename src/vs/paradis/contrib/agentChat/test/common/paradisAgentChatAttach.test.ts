/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatAttachDialogOptions, paradisAgentChatAttachPaths } from '../../common/paradisAgentChatAttach.js';

suite('paradisAgentChatAttach', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('offers only the files where the agent runs and drops files from the other side', () => {
		const local = URI.file('/Users/example/notes.md');
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/example/app.ts' });
		assert.deepStrictEqual({
			localDialog: paradisAgentChatAttachDialogOptions(undefined, 't').availableFileSystems,
			remoteDialog: paradisAgentChatAttachDialogOptions('ssh-remote+host', 't').availableFileSystems,
			folders: paradisAgentChatAttachDialogOptions(undefined, 't').canSelectFolders,
			localWindow: paradisAgentChatAttachPaths([local, remote], undefined),
			remoteWindow: paradisAgentChatAttachPaths([local, remote], 'ssh-remote+host'),
		}, {
			localDialog: ['file'],
			remoteDialog: ['vscode-remote'],
			folders: false,
			localWindow: [local.fsPath],
			remoteWindow: ['/home/example/app.ts'],
		});
	});
});

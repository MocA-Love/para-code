/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { DOWNLOAD_COMMAND_ID } from '../../../../../workbench/contrib/files/browser/fileActions.js';
import { paradisExplorerDownloadHandler } from '../../electron-browser/paradisExplorerDownload.js';

suite('Paradis file transfer - explorer download command', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// upstream が ID を変えると、差し替えが黙って効かなくなる。ID と、後から登録した方が使われることを確かめる
	test('replaces the upstream explorer.download handler', () => {
		assert.deepStrictEqual({
			id: DOWNLOAD_COMMAND_ID,
			replaced: CommandsRegistry.getCommand(DOWNLOAD_COMMAND_ID)?.handler === paradisExplorerDownloadHandler,
		}, { id: 'explorer.download', replaced: true });
	});
});

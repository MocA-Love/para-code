/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDocWatchPaneTokens } from '../../electron-browser/paradisAgentDocsPaneFolder.js';

suite('paradisAgentDocsPaneFolder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a changed document is reported with the panes of the deepest space folder that contains it', () => {
		const panes = [
			{ token: 'repo-1', folder: URI.file('/work/repo') },
			{ token: 'repo-2', folder: URI.file('/work/repo') },
			// リポジトリのフォルダの中に置いたワークツリーのスペース
			{ token: 'worktree', folder: URI.file('/work/repo/.worktrees/feature') },
			{ token: 'other', folder: URI.file('/work/other') },
			{ token: 'unknown', folder: undefined },
			{ token: 'remote', folder: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/work/repo' }) },
		];
		assert.deepStrictEqual([
			paradisDocWatchPaneTokens(URI.file('/work/repo/docs/report.html'), panes),
			paradisDocWatchPaneTokens(URI.file('/work/repo/.worktrees/feature/notes.md'), panes),
			paradisDocWatchPaneTokens(URI.file('/work/repository/x.md'), panes),
			paradisDocWatchPaneTokens(URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/work/repo/x.md' }), panes),
		], [['repo-1', 'repo-2'], ['worktree'], [], ['remote']]);
	});
});

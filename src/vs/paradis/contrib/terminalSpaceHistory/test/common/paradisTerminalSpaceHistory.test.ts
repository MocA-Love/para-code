/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFishHistoryFileName, paradisSpaceHistoryDirectory, paradisSpaceHistoryId } from '../../common/paradisTerminalSpaceHistory.js';

suite('paradisTerminalSpaceHistory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('derives a stable, file-name-safe id per space', () => {
		const repositoryId = paradisSpaceHistoryId('0b0f2c4e-9a55-4d59-a8c2-7f1b8c1e2d3a');
		const worktreeId = paradisSpaceHistoryId('worktree:file:///Users/example/repo-wt');
		assert.deepStrictEqual({
			stable: repositoryId === paradisSpaceHistoryId('0b0f2c4e-9a55-4d59-a8c2-7f1b8c1e2d3a'),
			distinct: repositoryId !== worktreeId,
			safe: /^[0-9a-f]{16}$/.test(repositoryId) && /^[0-9a-f]{16}$/.test(worktreeId),
			directory: paradisSpaceHistoryDirectory('/data/terminal-history/', 'abc', '/'),
			windowsDirectory: paradisSpaceHistoryDirectory('C:\\data\\terminal-history', 'abc', '\\'),
			fish: paradisFishHistoryFileName('abc'),
		}, {
			stable: true,
			distinct: true,
			safe: true,
			directory: '/data/terminal-history/abc',
			windowsDirectory: 'C:\\data\\terminal-history\\abc',
			fish: 'paracode_abc_history',
		});
	});
});

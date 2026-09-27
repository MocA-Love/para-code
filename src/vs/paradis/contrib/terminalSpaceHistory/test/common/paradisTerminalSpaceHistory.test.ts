/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_ORPHAN_HISTORY_MIN_AGE_MS, paradisFishHistoryFileName, paradisParseCreatedHistoryIds, paradisSerializeCreatedHistoryIds, paradisShouldDeleteOrphanHistory, paradisSpaceHistoryDirectory, paradisSpaceHistoryId } from '../../common/paradisTerminalSpaceHistory.js';

suite('paradisTerminalSpaceHistory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('derives a stable, file-name-safe id per space', () => {
		const repositoryId = paradisSpaceHistoryId('0b0f2c4e-9a55-4d59-a8c2-7f1b8c1e2d3a');
		const worktreeId = paradisSpaceHistoryId('worktree:file:///Users/example/repo-wt');
		assert.deepStrictEqual({
			stable: repositoryId === paradisSpaceHistoryId('0b0f2c4e-9a55-4d59-a8c2-7f1b8c1e2d3a'),
			distinct: repositoryId !== worktreeId,
			safe: /^[0-9a-f]{16}$/.test(repositoryId) && /^[0-9a-f]{16}$/.test(worktreeId),
			directory: paradisSpaceHistoryDirectory('/data/terminal-history/', 'abc'),
			windowsDirectory: paradisSpaceHistoryDirectory('C:/data/terminal-history', 'abc'),
			fish: paradisFishHistoryFileName('abc'),
			createdIds: [...paradisParseCreatedHistoryIds(JSON.stringify([['0123456789abcdef', 'space-a'], ['1111111111111111', 'space-c', 2], ['../escape', 'space-b'], ['fedcba9876543210', ''], 'garbage']))],
			brokenCreatedIds: paradisParseCreatedHistoryIds('{').size,
		}, {
			stable: true,
			distinct: true,
			safe: true,
			directory: '/data/terminal-history/abc',
			windowsDirectory: 'C:/data/terminal-history/abc',
			fish: 'paracode_abc_history',
			createdIds: [['0123456789abcdef', { stateKey: 'space-a', missedStartups: 0 }], ['1111111111111111', { stateKey: 'space-c', missedStartups: 2 }]],
			brokenCreatedIds: 0,
		});
	});

	// 起動時の worktree の列挙が一時的に失敗しても、生きているスペースの履歴を消さない。
	test('deletes an orphaned history only after several missed startups and a long idle time', () => {
		const now = 1_800_000_000_000;
		const old = now - PARADIS_ORPHAN_HISTORY_MIN_AGE_MS;
		const recent = now - 60_000;
		const ids = new Map([['0123456789abcdef', { stateKey: 'space-a', missedStartups: 0 }], ['1111111111111111', { stateKey: 'space-c', missedStartups: 2 }]]);
		assert.deepStrictEqual({
			firstMiss: paradisShouldDeleteOrphanHistory(1, old, now),
			thirdMissRecentlyWritten: paradisShouldDeleteOrphanHistory(3, recent, now),
			thirdMissOld: paradisShouldDeleteOrphanHistory(3, old, now),
			thirdMissNoFolder: paradisShouldDeleteOrphanHistory(3, undefined, now),
			serialized: paradisSerializeCreatedHistoryIds(ids, 10),
		}, {
			firstMiss: false,
			thirdMissRecentlyWritten: false,
			thirdMissOld: true,
			thirdMissNoFolder: true,
			serialized: '[["0123456789abcdef","space-a"],["1111111111111111","space-c",2]]',
		});
	});
});

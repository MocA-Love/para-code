/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCommandRecord } from '../../common/paradisTerminalCommandRecords.js';
import { IParadisHistoryPanelItem, paradisFilterHistory, paradisMergeHistory, paradisMoveHistorySelection, paradisPlaceHistoryPanel, paradisShortenCwd } from '../../common/paradisTerminalHistoryPanelModel.js';

function record(command: string, timestamp: number, exitCode?: number, cwd?: string): IParadisCommandRecord {
	return { command, timestamp, exitCode, cwd, duration: undefined };
}

function summary(items: readonly IParadisHistoryPanelItem[]): string[] {
	return items.map(item => item.last === undefined ? item.command : `${item.command} (t=${item.last.timestamp}, exit=${item.last.exitCode}, ×${item.count})`);
}

suite('ParadisTerminalHistoryPanelModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts recorded commands first by time, then unrecorded history newest first without duplicates', () => {
		const items = paradisMergeHistory(
			[record('git status', 10, 0), record('npm test', 20, 1), record('git status', 30, 0), record('npm test', 25, 0)],
			[
				['git clone x', 'git status', 'bun run dev', ' ', 'git push'],
				['git push', 'docker ps'],
			],
		);
		assert.deepStrictEqual(summary(items), [
			'git status (t=30, exit=0, ×2)',
			'npm test (t=25, exit=0, ×2)',
			'git push',
			'bun run dev',
			'git clone x',
			'docker ps',
		]);
	});

	test('stops at the limit', () => {
		assert.deepStrictEqual(paradisMergeHistory([], [['a', 'b', 'c', 'd']], 2).map(item => item.command), ['d', 'c']);
	});

	test('filters by the typed prefix, case-sensitively, ignoring leading spaces and keeping an exact match', () => {
		const items = paradisMergeHistory([], [['git', 'Git log', 'git status', 'gitk', 'npm test']]);
		assert.deepStrictEqual({
			git: paradisFilterHistory(items, 'git').map(item => item.command),
			leadingSpace: paradisFilterHistory(items, '  git s').map(item => item.command),
			gitSpace: paradisFilterHistory(items, 'git ').map(item => item.command),
			none: paradisFilterHistory(items, 'cargo').map(item => item.command),
			empty: paradisFilterHistory(items, '').length,
		}, {
			git: ['gitk', 'git status', 'git'],
			leadingSpace: ['git status'],
			gitSpace: ['git status'],
			none: [],
			empty: 5,
		});
	});

	test('moves older with Down, newer with Up, and closes on Up at the newest', () => {
		assert.deepStrictEqual([
			paradisMoveHistorySelection(0, 3, 'older'),
			paradisMoveHistorySelection(2, 3, 'older'),
			paradisMoveHistorySelection(2, 3, 'newer'),
			paradisMoveHistorySelection(1, 3, 'newer'),
			paradisMoveHistorySelection(0, 3, 'newer'),
			paradisMoveHistorySelection(0, 0, 'older'),
			paradisMoveHistorySelection(0, 0, 'newer'),
		], [
			{ kind: 'select', index: 1 },
			{ kind: 'select', index: 2 },
			{ kind: 'select', index: 1 },
			{ kind: 'select', index: 0 },
			{ kind: 'close' },
			{ kind: 'select', index: 0 },
			{ kind: 'close' },
		]);
	});

	test('places the panel below the prompt with the newest on top, and above with the newest at the bottom when below is short', () => {
		assert.deepStrictEqual([
			paradisPlaceHistoryPanel(12, 3, 10),
			paradisPlaceHistoryPanel(4, 20, 10),
			paradisPlaceHistoryPanel(4, 2, 10),
			paradisPlaceHistoryPanel(0, 0, 10),
			paradisPlaceHistoryPanel(5, 20, 2),
		], [
			{ place: 'below', rows: 10, newestOnTop: true },
			{ place: 'above', rows: 10, newestOnTop: false },
			{ place: 'below', rows: 4, newestOnTop: true },
			{ place: 'below', rows: 3, newestOnTop: true },
			{ place: 'below', rows: 2, newestOnTop: true },
		]);
	});

	test('shortens a cwd under the home folder', () => {
		assert.deepStrictEqual([
			paradisShortenCwd('/Users/example/projects/app', '/Users/example'),
			paradisShortenCwd('/Users/example', '/Users/example/'),
			paradisShortenCwd('/Users/example2/app', '/Users/example'),
			paradisShortenCwd('C:\\Users\\example\\app', 'C:\\Users\\example'),
			paradisShortenCwd(undefined, '/Users/example'),
			paradisShortenCwd('/tmp', undefined),
		], ['~/projects/app', '~', '/Users/example2/app', '~\\app', undefined, '/tmp']);
	});
});

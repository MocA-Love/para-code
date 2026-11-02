/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseParadisRtkDiscover } from '../../node/paradisRtkChannel.js';
import { paradisReadRtkHistoryStats, paradisRtkHistoryDbCandidates, paradisRtkUtcStamp } from '../../node/paradisRtkHistoryDb.js';

const nodeRequire = createRequire(import.meta.url);

suite('ParadisRtkHistoryDb', function () {
	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks for the history DB in the data folder of each OS', () => {
		assert.deepStrictEqual({
			linux: paradisRtkHistoryDbCandidates('linux', {}, '/home/u'),
			linuxXdg: paradisRtkHistoryDbCandidates('linux', { XDG_DATA_HOME: '/data' }, '/home/u'),
			mac: paradisRtkHistoryDbCandidates('darwin', {}, '/Users/u'),
			windowsWithoutAppData: paradisRtkHistoryDbCandidates('win32', {}, 'C:/Users/u'),
		}, {
			linux: [join('/home/u', '.local', 'share', 'rtk', 'history.db')],
			linuxXdg: [join('/data', 'rtk', 'history.db')],
			mac: [join('/Users/u', 'Library', 'Application Support', 'rtk', 'history.db')],
			windowsWithoutAppData: [],
		});
	});

	// コマンドは先頭の 2 語（git などは 3 語）でまとめ、引数（URL やパス）は画面に出さない。期間の外の行は数えない
	test('counts the period by command head and by working folder, and gives up on a DB of another shape', async () => {
		// The Electron renderer test host cannot launch worker_threads. The node unit runner is the
		// production execution boundary (shared process / remote server) and runs this test.
		if (process.type === 'renderer') { return; }
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-rtk-db-'));
		try {
			const dbPath = join(root, 'history.db');
			const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
			const db = new DatabaseSync(dbPath);
			db.exec(`CREATE TABLE commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL, exec_time_ms INTEGER DEFAULT 0, project_path TEXT DEFAULT '')`);
			const insert = db.prepare('INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
			const inDay = `${paradisRtkUtcStamp('2026-11-02', 0)}.123456789+00:00`;
			const before = `${paradisRtkUtcStamp('2026-11-01', 0)}.000+00:00`;
			insert.run(inDay, 'grep', 'rtk grep -n foo src', 100, 40, 60, 60, 10, '/w/a');
			insert.run(inDay, 'grep', 'rtk grep bar', 50, 30, 20, 40, 30, '/w/a');
			insert.run(inDay, 'git', 'rtk git diff main...feature', 300, 30, 270, 90, 5, '/w/b');
			insert.run(inDay, 'curl', 'rtk curl -fsS https://example.com/x?token=secret', 10, 9, 1, 10, 7, '');
			insert.run(before, 'grep', 'rtk grep old', 1000, 0, 1000, 100, 1, '/w/a');
			db.close();

			const stats = await paradisReadRtkHistoryStats(dbPath, '2026-11-02', '2026-11-02');
			const otherPath = join(root, 'other.db');
			const other = new DatabaseSync(otherPath);
			other.exec('CREATE TABLE commands (id INTEGER PRIMARY KEY, when_at TEXT)');
			other.close();
			assert.deepStrictEqual({
				stats,
				otherShape: await paradisReadRtkHistoryStats(otherPath, '2026-11-02', '2026-11-02'),
				missing: await paradisReadRtkHistoryStats(join(root, 'missing.db'), '2026-11-02', '2026-11-02'),
			}, {
				stats: {
					totals: { commands: 4, inputTokens: 460, savedTokens: 351, execMs: 52 },
					commands: [
						{ command: 'rtk git diff', count: 1, inputTokens: 300, savedTokens: 270, execMs: 5 },
						{ command: 'rtk grep', count: 2, inputTokens: 150, savedTokens: 80, execMs: 40 },
						{ command: 'rtk curl', count: 1, inputTokens: 10, savedTokens: 1, execMs: 7 },
					],
					projects: [
						{ path: '', count: 1, savedTokens: 1 },
						{ path: '/w/a', count: 2, savedTokens: 80 },
						{ path: '/w/b', count: 1, savedTokens: 270 },
					],
				},
				otherShape: undefined,
				missing: undefined,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('reads the commands rtk discover found outside rtk, largest saving first', () => {
		const stdout = JSON.stringify({
			sessions_scanned: 3,
			supported: [
				{ command: 'cat -n', count: 5, rtk_equivalent: 'rtk read', estimated_savings_tokens: 100 },
				{ command: 'grep -n', count: 9, rtk_equivalent: 'rtk grep', estimated_savings_tokens: 900 },
				{ count: 1 },
			],
		});
		assert.deepStrictEqual(parseParadisRtkDiscover(stdout), [
			{ command: 'grep -n', rtkEquivalent: 'rtk grep', count: 9, estimatedSavedTokens: 900 },
			{ command: 'cat -n', rtkEquivalent: 'rtk read', count: 5, estimatedSavedTokens: 100 },
		]);
	});
});

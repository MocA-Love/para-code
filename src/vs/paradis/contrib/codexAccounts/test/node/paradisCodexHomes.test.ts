/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCodexHomeCandidates, paradisCodexHomes, paradisEachCodexHome, paradisIsWithinCodexHome, paradisNormalizeCodexHomePath } from '../../../agentBrowser/node/paradisAgentHome.js';

suite('Paradis Codex homes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let home: string;

	setup(() => {
		home = mkdtempSync(join(tmpdir(), 'paradis-codex-homes-'));
		for (const name of ['.codex', '.codex-2', '.codex-3', '.codex-10', '.codex-backup', '.codexbar', 'codex-4', 'work-codex']) {
			mkdirSync(join(home, name), { recursive: true });
		}
		for (const name of ['.codex-2', '.codex-10', '.codex-backup', 'work-codex']) {
			writeFileSync(join(home, name, 'auth.json'), '{}');
		}
		writeFileSync(join(home, '.codex-5'), 'not a directory');
	});

	teardown(() => {
		rmSync(home, { recursive: true, force: true });
	});

	// 手で作った ~/.codex-backup には hook も設定も書かない。設定で足したホームは加える。
	test('treats only Para Code account homes and configured homes as Codex homes, and only signed-in ones as accounts', () => {
		const configured = [join(home, 'work-codex')];
		assert.deepStrictEqual({
			accounts: paradisCodexHomes({ homeDirectory: home, configured }),
			candidates: paradisCodexHomeCandidates({ homeDirectory: home, configured }),
		}, {
			accounts: [join(home, '.codex'), join(home, '.codex-2'), join(home, '.codex-10'), join(home, 'work-codex')],
			candidates: [join(home, '.codex'), join(home, '.codex-2'), join(home, '.codex-3'), join(home, '.codex-10'), join(home, 'work-codex')],
		});
	});

	// 設定の書き方の違い（~ や末尾の区切り）で、パネルと切替が別のホームとして扱わないように。
	test('normalizes configured homes the same way everywhere', () => {
		assert.deepStrictEqual([
			paradisNormalizeCodexHomePath('~/work-codex/', home),
			paradisNormalizeCodexHomePath(`${home}/a/../work-codex`, home),
			paradisNormalizeCodexHomePath('relative/path', home),
			paradisNormalizeCodexHomePath(42, home),
		], [join(home, 'work-codex'), join(home, 'work-codex'), undefined, undefined]);
	});

	// SSH の接続先などアカウント切替を有効にしていないプロセスでは、従来どおり既定のホームだけ。
	test('only the default home is used until account homes are enabled', () => {
		assert.deepStrictEqual(paradisCodexHomes().length, 1);
	});

	test('treats transcripts in any Codex home as Codex and expands homes one by one', () => {
		const homes = paradisCodexHomes({ homeDirectory: home });
		const expanded = paradisEachCodexHome({ claude: join(home, '.claude'), codex: homes[0], codexHomes: homes, matchCwd: '/work' });
		assert.deepStrictEqual({
			inSecond: paradisIsWithinCodexHome(join(home, '.codex-2', 'sessions', 'rollout-a.jsonl'), homes),
			outside: paradisIsWithinCodexHome(join(home, '.codex-backup', 'x.jsonl'), homes),
			expanded: expanded.map(entry => entry.codex),
		}, {
			inSecond: true,
			outside: false,
			expanded: homes,
		});
	});
});

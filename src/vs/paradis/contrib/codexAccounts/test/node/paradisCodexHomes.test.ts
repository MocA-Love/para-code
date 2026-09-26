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
import { paradisCodexAccountHomes, paradisCodexHomes, paradisEachCodexHome, paradisIsWithinCodexHome } from '../../../agentBrowser/node/paradisAgentHome.js';

suite('Paradis Codex homes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let home: string;

	setup(() => {
		home = mkdtempSync(join(tmpdir(), 'paradis-codex-homes-'));
		for (const name of ['.codex', '.codex-2', '.codex-3', '.codexbar', 'codex-4']) {
			mkdirSync(join(home, name), { recursive: true });
		}
		writeFileSync(join(home, '.codex-2', 'auth.json'), '{}');
		writeFileSync(join(home, '.codex-5'), 'not a directory');
	});

	teardown(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test('finds every Codex home but writes settings only to signed-in ones', () => {
		assert.deepStrictEqual({
			all: paradisCodexHomes(home),
			accounts: paradisCodexAccountHomes(home),
		}, {
			all: [join(home, '.codex'), join(home, '.codex-2'), join(home, '.codex-3')],
			accounts: [join(home, '.codex'), join(home, '.codex-2')],
		});
	});

	test('treats transcripts in any Codex home as Codex and expands homes one by one', () => {
		const homes = paradisCodexHomes(home);
		const expanded = paradisEachCodexHome({ claude: join(home, '.claude'), codex: homes[0], codexHomes: homes, matchCwd: '/work' });
		assert.deepStrictEqual({
			inSecond: paradisIsWithinCodexHome(join(home, '.codex-2', 'sessions', 'rollout-a.jsonl'), homes),
			outside: paradisIsWithinCodexHome(join(home, '.codexbar', 'x.jsonl'), homes),
			expanded: expanded.map(entry => entry.codex),
		}, {
			inSecond: true,
			outside: false,
			expanded: homes,
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CLI の実行ファイルの探し方（limitsMonitor・ccusage・codexAccounts・Claude のアカウント追加・
// hook の信頼・モデル一覧が共有する）。実ファイルは見ず、有無を決めた偽の fileExists で確かめる。

import assert from 'assert';
import { isWindows } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisAgentCliFallbackDirs, paradisResolveAgentCli } from '../../node/paradisAgentCli.js';

(isWindows ? suite.skip : suite)('Paradis agent CLI resolution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const HOME = '/home/u';

	function existing(...paths: string[]): { fileExists: (path: string) => Promise<boolean>; asked: string[] } {
		const asked: string[] = [];
		return { asked, fileExists: async path => { asked.push(path); return paths.includes(path); } };
	}

	test('finds the CLI on PATH, skipping relative entries and the pane launcher directory', async () => {
		const files = existing('/launcher/codex', 'relative/codex', '/usr/bin/codex');
		const found = await paradisResolveAgentCli('codex', { PATH: '/launcher:relative:/usr/bin' }, { excludeDirs: ['/launcher'], homeDir: HOME, platform: 'linux', fileExists: files.fileExists });
		assert.deepStrictEqual({ found, asked: files.asked }, { found: '/usr/bin/codex', asked: ['/usr/bin/codex'] });
	});

	test('falls back to the common install locations in one shared order', async () => {
		const claude = await paradisResolveAgentCli('claude', { PATH: '' }, { homeDir: HOME, platform: 'linux', fileExists: existing(`${HOME}/.claude/local/claude`).fileExists });
		const missing = await paradisResolveAgentCli('codex', {}, { homeDir: HOME, platform: 'linux', fileExists: existing().fileExists });
		assert.deepStrictEqual({
			claude,
			missing,
			dirs: {
				claude: paradisAgentCliFallbackDirs('claude', HOME, 'linux'),
				codex: paradisAgentCliFallbackDirs('codex', HOME, 'linux'),
				ccusage: paradisAgentCliFallbackDirs('ccusage', HOME, 'linux'),
			},
		}, {
			claude: `${HOME}/.claude/local/claude`,
			missing: undefined,
			dirs: {
				claude: [`${HOME}/.local/bin`, `${HOME}/.npm-global/bin`, `${HOME}/.bun/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${HOME}/.claude/local`],
				codex: [`${HOME}/.local/bin`, `${HOME}/.npm-global/bin`, `${HOME}/.bun/bin`, '/opt/homebrew/bin', '/usr/local/bin'],
				ccusage: [`${HOME}/.npm-global/bin`, `${HOME}/.bun/bin`, `${HOME}/.local/bin`, `${HOME}/.deno/bin`, '/opt/homebrew/bin', '/usr/local/bin'],
			},
		});
	});

	test('uses the PATH probe instead of scanning PATH when one is given, and returns the bare name', async () => {
		const probed: string[] = [];
		const onPath = await paradisResolveAgentCli('ccusage', { PATH: '/usr/bin' }, { homeDir: HOME, platform: 'linux', isOnPath: async name => { probed.push(name); return true; }, fileExists: existing('/usr/bin/ccusage').fileExists });
		const fallback = await paradisResolveAgentCli('ccusage', {}, { homeDir: HOME, platform: 'linux', isOnPath: async () => false, fileExists: existing(`${HOME}/.deno/bin/ccusage`).fileExists });
		assert.deepStrictEqual({ onPath, probed, fallback }, { onPath: 'ccusage', probed: ['ccusage'], fallback: `${HOME}/.deno/bin/ccusage` });
	});
});

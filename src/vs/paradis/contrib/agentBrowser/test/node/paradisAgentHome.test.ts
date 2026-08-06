/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClaudeConfigDir, paradisCodexHome, paradisLocalAgentPath, paradisResolveAgentHomes } from '../../node/paradisAgentHome.js';

suite('ParadisAgentHome', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('leaves non-WSL working directories on the process own home', () => {
		// これがいちばん壊してはいけない不変条件。WSL を使っていない利用者にとっては、
		// 探索先も突き合わせに使う作業ディレクトリも従来と1バイトも変わってはいけない。
		for (const cwd of ['/Users/x/repo', 'C:\\repo', '/home/x/repo', '\\\\nas\\share\\repo']) {
			assert.deepStrictEqual(paradisResolveAgentHomes(cwd), {
				claude: paradisClaudeConfigDir(),
				codex: paradisCodexHome(),
				matchCwd: cwd,
			});
		}
	});

	test('follows the working directory into the distro when it lives inside WSL', () => {
		const homes = paradisResolveAgentHomes('\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis\\projects\\repo');

		assert.deepStrictEqual({ claude: homes.claude, codex: homes.codex, matchCwd: homes.matchCwd, distro: homes.wsl?.distro }, {
			claude: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis\\.claude',
			codex: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis\\.codex',
			// スラッグも state DB の突合もこの表記でなければ当たらない
			matchCwd: '/home/paradis/projects/repo',
			distro: 'Ubuntu-26.04',
		});
	});

	test('rewrites paths the agent recorded inside the distro, and leaves local ones alone', () => {
		const wsl = paradisResolveAgentHomes('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo');
		const local = paradisResolveAgentHomes('/Users/x/repo');

		assert.deepStrictEqual([
			// Codex が state DB へ書くのは Linux 側の表記。そのまま開いても存在しない
			paradisLocalAgentPath(wsl, '/home/u/.codex/sessions/2026/08/07/rollout-x.jsonl'),
			// 既に Windows 側の表記になっているものは触らない
			paradisLocalAgentPath(wsl, '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex\\x.jsonl'),
			paradisLocalAgentPath(local, '/Users/x/.codex/sessions/rollout-x.jsonl'),
		], [
			'\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex\\sessions\\2026\\08\\07\\rollout-x.jsonl',
			'\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex\\x.jsonl',
			'/Users/x/.codex/sessions/rollout-x.jsonl',
		]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAddCodexProjectTrust, paradisGrantCodexWorktreeTrust, paradisReadCodexTrustMarker, paradisRemoveCodexProjectTrust, paradisRevokeCodexWorktreeTrust } from '../../node/paradisCodexFolderTrust.js';

const PATH = '/work/repo-worktrees/fix-a';

suite('paradisCodexFolderTrust', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('appends one table and leaves the rest of config.toml as it was', () => {
		assert.deepStrictEqual([
			paradisAddCodexProjectTrust('', PATH),
			paradisAddCodexProjectTrust('model = "x"', PATH),
			paradisAddCodexProjectTrust('model = "x"\n\n[tui]\ntheme = "dark"\n', PATH),
			paradisAddCodexProjectTrust('a = 1\r\n', PATH),
			paradisAddCodexProjectTrust('[projects."/other"]\ntrust_level = "trusted"\n', PATH),
		], [
			`[projects."${PATH}"]\ntrust_level = "trusted"\n`,
			`model = "x"\n\n[projects."${PATH}"]\ntrust_level = "trusted"\n`,
			`model = "x"\n\n[tui]\ntheme = "dark"\n\n[projects."${PATH}"]\ntrust_level = "trusted"\n`,
			`a = 1\r\n\r\n[projects."${PATH}"]\ntrust_level = "trusted"\r\n`.replace('\ntrust', '\r\ntrust'),
			`[projects."/other"]\ntrust_level = "trusted"\n\n[projects."${PATH}"]\ntrust_level = "trusted"\n`,
		]);
	});

	test('writes nothing when the folder already has an entry in any spelling, or when a table could be defined twice', () => {
		assert.deepStrictEqual([
			paradisAddCodexProjectTrust(`[projects."${PATH}"]\ntrust_level = "untrusted"\n`, PATH),
			paradisAddCodexProjectTrust(`[projects.'${PATH}']\n`, PATH),
			paradisAddCodexProjectTrust(`[projects]\n"${PATH}" = { trust_level = "trusted" }\n`, PATH),
			paradisAddCodexProjectTrust(`projects = { "/other" = { trust_level = "trusted" } }\n`, PATH),
			paradisAddCodexProjectTrust(`projects."/other".trust_level = "trusted"\n`, PATH),
			paradisAddCodexProjectTrust('[[projects]]\nname = "x"\n', PATH),
			paradisAddCodexProjectTrust('note = """\n[projects."x"]\n', PATH),
			// 複数行の文字列の中の見出しは見出しにしない
			paradisAddCodexProjectTrust(`note = """\n[projects."${PATH}"]\n"""\n`, PATH) !== 'unchanged',
		], ['unchanged', 'unchanged', 'unchanged', 'unsupported', 'unsupported', 'unsupported', 'unsupported', true]);
	});

	test('removes only a table that is still exactly what it wrote', () => {
		const added = paradisAddCodexProjectTrust('model = "x"\n\n[tui]\ntheme = "dark"\n', PATH) as string;
		const between = `model = "x"\n\n[projects."${PATH}"]\ntrust_level = "trusted"\n\n[tui]\ntheme = "dark"\n`;
		assert.deepStrictEqual([
			paradisRemoveCodexProjectTrust(added, PATH),
			paradisRemoveCodexProjectTrust(between, PATH),
			paradisRemoveCodexProjectTrust(`[projects."${PATH}"]\ntrust_level = "trusted"\n`, PATH),
			paradisRemoveCodexProjectTrust(`[projects."${PATH}"]\ntrust_level = "trusted"\nmodel = "y"\n`, PATH),
			paradisRemoveCodexProjectTrust(`[projects."${PATH}"]\ntrust_level = "untrusted"\n`, PATH),
			paradisRemoveCodexProjectTrust('model = "x"\n', PATH),
		], [
			'model = "x"\n\n[tui]\ntheme = "dark"\n',
			'model = "x"\n\n[tui]\ntheme = "dark"\n',
			'',
			'unchanged',
			'unchanged',
			'unchanged',
		]);
	});

	test('grants trust in every Codex home that exists, notes it, and revokes it', async () => {
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-codex-trust-')));
		try {
			// 一時フォルダの CODEX_HOME だけを使う（本物の ~/.codex* には触らない）
			const homeWithConfig = join(root, 'codex');
			const homeWithoutConfig = join(root, 'codex-2');
			const missingHome = join(root, 'codex-3');
			await fs.mkdir(homeWithConfig);
			await fs.mkdir(homeWithoutConfig);
			await fs.writeFile(join(homeWithConfig, 'config.toml'), 'model = "x"\n');
			const worktree = join(root, 'repo-worktrees', 'fix-a');
			const admin = join(root, 'repo', '.git', 'worktrees', 'fix-a');
			await fs.mkdir(worktree, { recursive: true });
			await fs.mkdir(admin, { recursive: true });
			await fs.writeFile(join(worktree, '.git'), `gitdir: ${admin}\n`);
			const outcomes = await paradisGrantCodexWorktreeTrust(worktree, [homeWithConfig, homeWithoutConfig, missingHome]);
			const granted = await fs.readFile(join(homeWithConfig, 'config.toml'), 'utf8');
			const created = await fs.readFile(join(homeWithoutConfig, 'config.toml'), 'utf8');
			const createdMode = (await fs.stat(join(homeWithoutConfig, 'config.toml'))).mode & 0o777;
			const again = await paradisGrantCodexWorktreeTrust(worktree, [homeWithConfig]);
			const marker = await paradisReadCodexTrustMarker(worktree);
			const revoked = marker !== undefined ? await paradisRevokeCodexWorktreeTrust(marker) : [];
			assert.deepStrictEqual({
				outcomes, again, granted, created, createdMode: isWindows ? 0o600 : createdMode, revoked,
				markerFiles: marker?.entries.map(entry => entry.configFile),
				afterRevoke: [await fs.readFile(join(homeWithConfig, 'config.toml'), 'utf8'), await fs.readFile(join(homeWithoutConfig, 'config.toml'), 'utf8')],
				missingHomeCreated: await fs.stat(missingHome).then(() => true, () => false),
			}, {
				outcomes: ['granted', 'granted'], again: ['unchanged'],
				granted: `model = "x"\n\n[projects."${worktree}"]\ntrust_level = "trusted"\n`,
				created: `[projects."${worktree}"]\ntrust_level = "trusted"\n`,
				createdMode: 0o600, revoked: ['granted', 'granted'],
				markerFiles: [join(homeWithConfig, 'config.toml'), join(homeWithoutConfig, 'config.toml')],
				afterRevoke: ['model = "x"\n', ''],
				missingHomeCreated: false,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

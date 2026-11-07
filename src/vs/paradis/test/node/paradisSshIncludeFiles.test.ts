/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { PARADIS_SSH_CONFIG_MAX_BYTES, paradisReadSshConfigFile, paradisResolveSshIncludePath, paradisSshIncludeFiles } from '../../node/paradisSshIncludeFiles.js';

suite('paradisSshIncludeFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('expands a glob in an Include to the matching files in name order, and keeps a plain path', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-ssh-include-'));
		try {
			for (const name of ['b.conf', 'a.conf', 'notes.txt']) {
				await fs.writeFile(join(directory, name), '');
			}
			assert.deepStrictEqual({
				glob: await paradisSshIncludeFiles(join(directory, '*.conf')),
				plain: await paradisSshIncludeFiles(join(directory, 'b.conf')),
				missing: await paradisSshIncludeFiles(join(directory, 'nowhere', '*.conf')),
			}, {
				glob: [join(directory, 'a.conf'), join(directory, 'b.conf')],
				plain: [join(directory, 'b.conf')],
				missing: [],
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('resolves a relative Include from ~/.ssh wherever it is written, and expands ~', () => {
		const home = join(tmpdir(), 'home');
		assert.deepStrictEqual({
			relative: paradisResolveSshIncludePath('conf.d/a.conf', home),
			tilde: paradisResolveSshIncludePath('~/other/b.conf', home),
			absolute: paradisResolveSshIncludePath(join(tmpdir(), 'c.conf'), home),
		}, {
			relative: join(home, '.ssh', 'conf.d', 'a.conf'),
			tilde: join(home, 'other', 'b.conf'),
			absolute: join(tmpdir(), 'c.conf'),
		});
	});

	test('reads only regular config files up to the size limit', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-ssh-read-'));
		try {
			await fs.writeFile(join(directory, 'small'), 'Host a\n');
			await fs.writeFile(join(directory, 'big'), Buffer.alloc(PARADIS_SSH_CONFIG_MAX_BYTES + 1));
			assert.deepStrictEqual({
				small: await paradisReadSshConfigFile(join(directory, 'small')),
				big: await paradisReadSshConfigFile(join(directory, 'big')),
				folder: await paradisReadSshConfigFile(directory),
				missing: await paradisReadSshConfigFile(join(directory, 'missing')),
			}, { small: 'Host a\n', big: undefined, folder: undefined, missing: undefined });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

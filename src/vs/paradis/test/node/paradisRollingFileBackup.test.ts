/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisOriginalBackupPath, paradisRollingBackupPath, paradisWriteRollingBackup, paradisWriteRollingBackupSync } from '../../node/paradisRollingFileBackup.js';

suite('paradisRollingFileBackup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let directory: string;

	setup(async () => {
		directory = join(tmpdir(), `paradis-rolling-backup-${generateUuid()}`);
		await fs.mkdir(directory, { recursive: true });
	});

	teardown(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('keeps one copy of the previous content and the first original, with the same permissions, and skips a missing file', async () => {
		const file = join(directory, 'settings.json');
		const missing = [paradisWriteRollingBackupSync(file), await paradisWriteRollingBackup(file)];
		await fs.writeFile(file, 'first', { mode: 0o600 });
		await fs.chmod(file, 0o600);
		const firstSync = paradisWriteRollingBackupSync(file);
		const afterFirst = await fs.readFile(paradisRollingBackupPath(file), 'utf8');
		await fs.writeFile(file, 'second');
		const secondAsync = await paradisWriteRollingBackup(file);
		const mode = (await fs.stat(paradisRollingBackupPath(file))).mode & 0o777;
		assert.deepStrictEqual({
			missing,
			firstSync,
			afterFirst,
			secondAsync,
			afterSecond: await fs.readFile(paradisRollingBackupPath(file), 'utf8'),
			original: await fs.readFile(paradisOriginalBackupPath(file), 'utf8'),
			mode: isWindows ? 0o600 : mode,
			entries: (await fs.readdir(directory)).sort(),
		}, {
			missing: [false, false],
			firstSync: true,
			afterFirst: 'first',
			secondAsync: true,
			afterSecond: 'second',
			original: 'first',
			mode: 0o600,
			entries: ['settings.json', 'settings.json.paradis.bak', 'settings.json.paradis.orig.bak'],
		});
	});

	test('refuses to write through a symlinked backup', async function () {
		if (isWindows) {
			this.skip();
		}
		const file = join(directory, 'config.toml');
		const elsewhere = join(directory, 'dotfiles-config.toml');
		await fs.writeFile(file, 'new');
		await fs.writeFile(elsewhere, 'keep me');
		await fs.symlink(elsewhere, paradisRollingBackupPath(file));
		const syncError = (() => {
			try {
				paradisWriteRollingBackupSync(file);
				return undefined;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code;
			}
		})();
		const asyncError = await paradisWriteRollingBackup(file).then(() => undefined, (error: NodeJS.ErrnoException) => error.code);
		assert.deepStrictEqual({ syncError, asyncError, elsewhere: await fs.readFile(elsewhere, 'utf8') }, { syncError: 'ELOOP', asyncError: 'ELOOP', elsewhere: 'keep me' });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 原子的な書き込みの非同期版のオプション（置き換える直前の確認、symlink の拒否、権限の固定）。
// 一時フォルダだけを使う。

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisWriteFileAtomic } from '../../node/paradisWriteFileAtomic.js';

(isWindows ? suite.skip : suite)('Paradis atomic file write', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-atomic-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('does not replace the file and leaves no temporary file when the check before replacing throws', async () => {
		const file = join(root, 'config.toml');
		await fs.writeFile(file, 'old');
		const failure = await paradisWriteFileAtomic(file, 'new', { beforeReplace: async () => { throw new Error('changed'); } }).then(() => undefined, (error: Error) => error.message);
		assert.deepStrictEqual({ failure, content: await fs.readFile(file, 'utf8'), files: await fs.readdir(root) }, { failure: 'changed', content: 'old', files: ['config.toml'] });
	});

	test('refuses to write through a symbolic link and forces the mode when asked, as Claude Code does for credentials', async () => {
		const real = join(root, 'real.json');
		const link = join(root, '.credentials.json');
		await fs.writeFile(real, 'real');
		await fs.symlink(real, link);
		const refused = await paradisWriteFileAtomic(link, 'secret', { rejectSymlink: true, forceMode: 0o600 }).then(() => 'written', (error: NodeJS.ErrnoException) => error.code);

		const plain = join(root, 'plain.json');
		await fs.writeFile(plain, 'old', { mode: 0o644 });
		await fs.chmod(plain, 0o644);
		await paradisWriteFileAtomic(plain, 'new', { rejectSymlink: true, forceMode: 0o600 });
		assert.deepStrictEqual({
			refused,
			real: await fs.readFile(real, 'utf8'),
			plain: await fs.readFile(plain, 'utf8'),
			mode: (await fs.stat(plain)).mode & 0o777,
		}, { refused: 'ELOOP', real: 'real', plain: 'new', mode: 0o600 });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../base/common/path.js';

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * 一時ファイルへ書いて fsync し、rename で置き換える。symlink のときは実体の側を置き換える
 * （リンク自体を普通のファイルで潰さない）。元の権限は umask に削られないよう当て直す。
 *
 * 置き場所は userData のような Para Code 専用の場所を想定している（ハードリンクは考えない）。
 * rename が失敗したとき（Windows で相手が開いたままなど）は、その場へ直接書く。
 */
export async function paradisWriteFileAtomic(path: string, content: Buffer): Promise<void> {
	let target = path;
	try {
		target = await fs.realpath(path);
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	let mode = 0o600;
	try {
		mode = (await fs.stat(target)).mode & 0o777;
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	const temporary = join(dirname(target), `.${basename(target)}.paradis-${randomUUID()}.tmp`);
	try {
		const handle = await fs.open(temporary, 'wx', mode);
		try {
			await handle.writeFile(content);
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.rename(temporary, target);
		} catch {
			await fs.writeFile(target, content);
		}
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

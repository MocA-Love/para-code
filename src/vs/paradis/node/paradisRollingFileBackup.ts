/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 利用者の設定ファイル（`~/.claude/settings.json`・`~/.claude.json`・`~/.codex/hooks.json`・
// `~/.codex/config.toml` など、Para Code だけのものではないファイル）を書き換える直前に、今の中身を
// 隣の `<名前>.paradis.bak` へ1つだけ残す（Orca `rolling-file-backup.ts` と同じ考え方）。
// 書き換えのたびに上書きするので増え続けない。マージの不具合で設定を壊したときに、利用者が
// 1つ前へ戻せるようにするため。
//
// ログイン情報（`.credentials.json`・`auth.json`）には使わない。秘密をもう1か所に置くことになるため。

import { randomUUID } from 'crypto';
import { copyFileSync, lstatSync, promises as fs, renameSync, rmSync } from 'fs';

/** 控えの名前に足す接尾辞。利用者が自分で置いた `.bak` を上書きしないよう、Para Code の名前を入れる。 */
export const PARADIS_ROLLING_BACKUP_SUFFIX = '.paradis.bak';

/** `filePath` の控えの置き場所。symlink の設定でも、リンク先ではなく書き換える名前の隣に置く。 */
export function paradisRollingBackupPath(filePath: string): string {
	return `${filePath}${PARADIS_ROLLING_BACKUP_SUFFIX}`;
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function refuseSymlinkedBackup(backupPath: string, isSymbolicLink: boolean): void {
	if (isSymbolicLink) {
		// copyFile は行き先の symlink を辿るので、無関係なファイル（dotfiles の実体など）を潰しうる
		throw Object.assign(new Error(`Refusing to overwrite a symlinked backup: ${backupPath}`), { code: 'ELOOP', path: backupPath });
	}
}

/**
 * 書き換える前の中身を控えへ写す（同期）。一時ファイルへ写してから rename で差し替えるので、
 * 写している途中で落ちても前の控えは残る。権限は元のファイルのものを引き継ぐ。
 * @returns 写したか（元のファイルが無ければ false）
 */
export function paradisWriteRollingBackupSync(filePath: string): boolean {
	const backupPath = paradisRollingBackupPath(filePath);
	try {
		refuseSymlinkedBackup(backupPath, lstatSync(backupPath).isSymbolicLink());
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		try {
			copyFileSync(filePath, temporary);
		} catch (error) {
			if (isNotFound(error)) {
				return false;
			}
			throw error;
		}
		renameSync(temporary, backupPath);
		return true;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** {@link paradisWriteRollingBackupSync} の非同期版。 */
export async function paradisWriteRollingBackup(filePath: string): Promise<boolean> {
	const backupPath = paradisRollingBackupPath(filePath);
	try {
		refuseSymlinkedBackup(backupPath, (await fs.lstat(backupPath)).isSymbolicLink());
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		try {
			await fs.copyFile(filePath, temporary);
		} catch (error) {
			if (isNotFound(error)) {
				return false;
			}
			throw error;
		}
		await fs.rename(temporary, backupPath);
		return true;
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

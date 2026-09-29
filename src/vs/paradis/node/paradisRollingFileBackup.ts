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
// 1つ前だけだと、Para Code が続けて2回書き換えたときに、利用者の元の中身が Para Code 自身の書いた
// 中身で上書きされる。そこで頼まれたとき（`keepOriginal`。hook の設定ファイル）は、最初の1回だけ
// `<名前>.paradis.orig.bak` にも写す（以後は触らない）。秘密を持ちうるファイル（`~/.claude.json` など）では
// 頼まない: 消えない写しが残り、秘密を変えても古い値が残り続けるため。
//
// ログイン情報（`.credentials.json`・`auth.json`）には使わない。秘密をもう1か所に置くことになるため。

import { randomUUID } from 'crypto';
import { copyFileSync, linkSync, lstatSync, promises as fs, renameSync, rmSync } from 'fs';

/** 控えの名前に足す接尾辞。利用者が自分で置いた `.bak` を上書きしないよう、Para Code の名前を入れる。 */
export const PARADIS_ROLLING_BACKUP_SUFFIX = '.paradis.bak';

/** 最初の1回だけ写す控えの接尾辞。 */
export const PARADIS_ORIGINAL_BACKUP_SUFFIX = '.paradis.orig.bak';

export interface IParadisRollingBackupOptions {
	/** 最初の1回だけ、元の中身を `<名前>.paradis.orig.bak` にも写す。秘密を持ちうるファイルには使わない */
	readonly keepOriginal?: boolean;
}

/** `filePath` の控えの置き場所。symlink の設定でも、リンク先ではなく書き換える名前の隣に置く。 */
export function paradisRollingBackupPath(filePath: string): string {
	return `${filePath}${PARADIS_ROLLING_BACKUP_SUFFIX}`;
}

/** `filePath` を Para Code が初めて書き換える前の中身の置き場所。 */
export function paradisOriginalBackupPath(filePath: string): string {
	return `${filePath}${PARADIS_ORIGINAL_BACKUP_SUFFIX}`;
}

/**
 * 元の中身の控えが無ければ置く。一時ファイルへ写してからハードリンクで置くので、書きかけを残さない。
 * link は行き先が既にあれば（symlink でも）失敗し、辿りもしないので、最初の1回だけ置かれる。
 * 1つ前の控えとは別のファイルにする（同じ実体にすると、片方を直したときにもう片方も変わる）。
 * 置けなくても控えは保険なので黙って諦める（リンクできないファイルシステムなど）。
 */
function writeOriginalBackupSync(filePath: string): void {
	const originalPath = paradisOriginalBackupPath(filePath);
	try {
		lstatSync(originalPath);
		return;
	} catch {
		// 無い（か確かめられない）ので置いてみる
	}
	const temporary = `${originalPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		copyFileSync(filePath, temporary);
		linkSync(temporary, originalPath);
	} catch {
		// 既にある（EEXIST）・元が無い・リンクできない
	} finally {
		rmSync(temporary, { force: true });
	}
}

async function writeOriginalBackup(filePath: string): Promise<void> {
	const originalPath = paradisOriginalBackupPath(filePath);
	try {
		await fs.lstat(originalPath);
		return;
	} catch {
		// 無い（か確かめられない）ので置いてみる
	}
	const temporary = `${originalPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.copyFile(filePath, temporary);
		await fs.link(temporary, originalPath);
	} catch {
		// 既にある（EEXIST）・元が無い・リンクできない
	} finally {
		await fs.rm(temporary, { force: true });
	}
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
export function paradisWriteRollingBackupSync(filePath: string, options?: IParadisRollingBackupOptions): boolean {
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
		if (options?.keepOriginal) {
			writeOriginalBackupSync(filePath);
		}
		renameSync(temporary, backupPath);
		return true;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** {@link paradisWriteRollingBackupSync} の非同期版。 */
export async function paradisWriteRollingBackup(filePath: string, options?: IParadisRollingBackupOptions): Promise<boolean> {
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
		if (options?.keepOriginal) {
			await writeOriginalBackup(filePath);
		}
		await fs.rename(temporary, backupPath);
		return true;
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

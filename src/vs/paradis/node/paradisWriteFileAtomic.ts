/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルを原子的に置き換える（同じディレクトリの一時ファイルへ書いてから rename で差し替える）。
// 読む側（Claude Code / Codex / Para Code 自身）が書きかけの中身を見ないようにするため。
//
// 以前は hook の設置（同期、ハードリンクと読み取り専用の扱いあり）、MCP 設定（書く直前に元の
// ファイルが変わっていないか確かめる）、Claude のログイン情報、userData の小さな JSON がそれぞれ
// 自前で持っていた。違いはオプションで残し、置き場所をここ1つにした。

import { randomUUID } from 'crypto';
import { accessSync, chmodSync, constants as fsConstants, lstatSync, promises as fs, readlinkSync, realpathSync, renameSync, Stats, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from '../../base/common/path.js';

/** symlink の段数の上限（OS の ELOOP と同程度）。循環していたら諦めてリンクそのものへ書く。 */
const MAX_SYMLINK_HOPS = 40;

/**
 * 書き込み先の実体。symlink を最後まで辿る（辿った先がまだ無い symlink も、リンク先へ書く）。
 * dotfiles をリポジトリから symlink している人の設定が、ただのファイルに化けないようにするため。
 */
function resolveWriteTarget(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch {
		// 無いファイル、またはリンク先がまだ無い symlink（多段を含む）
	}
	let current = filePath;
	for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
		try {
			if (!lstatSync(current).isSymbolicLink()) {
				return current;
			}
			current = resolve(dirname(current), readlinkSync(current));
		} catch {
			return current; // 辿った先が無い。ここへ新しく作る
		}
	}
	return filePath;
}

function temporaryPathFor(target: string): string {
	return join(dirname(target), `.${basename(target)}.paradis-${randomUUID()}.tmp`);
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function removeQuietly(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// 作れていなかった
	}
}

/**
 * 設定ファイルを原子的に置き換える（同期）。hook の設置が使う（読み比べてから書くまでの間に
 * イベントループへ制御を返さないため同期にしている）。
 *
 * - symlink は壊さない。実体（多段でも最後まで辿った先）の隣に一時ファイルを作って実体を差し替える
 * - 元のファイルの mode（`~/.claude.json` の 0600 など）を引き継ぐ。新規作成のときは umask に任せる
 * - ユーザーが書き込めなくしたファイル（`chmod 444` など）は、その場へ書くときと同じく失敗させる。
 *   `rename` はディレクトリの権限で通ってしまい、読み取り専用の意図を黙って破るため
 * - ハードリンク（リンク数が2以上）は、差し替えると片方だけが新しい中身になるので、その場へ書く
 * - 一時ファイルを作れない（ディレクトリに書き込めない等）ときや `rename` が通らないとき（Windows で
 *   他のプロセスが開いている等）は、一時ファイルを消してこれまでどおりその場へ書く。原子的でなく
 *   なるだけで、設定が置けないよりはよい
 *
 * 所有者・ACL・拡張属性は一時ファイルへ引き継がない（NOTES.md の hook の節を参照）。
 */
export function paradisWriteFileAtomicSync(filePath: string, content: string): void {
	const target = resolveWriteTarget(filePath);
	let stat: Stats | undefined;
	try {
		stat = statSync(target);
	} catch {
		stat = undefined; // まだ無い（新規作成）
	}
	if (stat) {
		if ((stat.mode & 0o200) === 0) {
			// root は accessSync が通ってしまうので、所有者の書き込みビットでも見る
			throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: 'EACCES', path: target });
		}
		accessSync(target, fsConstants.W_OK);
		if (stat.nlink > 1) {
			writeFileSync(target, content);
			return;
		}
	}
	const mode = stat ? stat.mode & 0o7777 : undefined;
	const temp = temporaryPathFor(target);
	try {
		writeFileSync(temp, content, { mode: mode ?? 0o666, flag: 'wx' });
		if (mode !== undefined) {
			// writeFileSync の mode は umask で削られるので、元と同じになるよう当て直す
			chmodSync(temp, mode);
		}
	} catch {
		removeQuietly(temp);
		writeFileSync(target, content);
		return;
	}
	try {
		renameSync(temp, target);
	} catch {
		removeQuietly(temp);
		writeFileSync(target, content);
	}
}

export interface IParadisWriteFileAtomicOptions {
	/** 新しく作るときの権限（既定 0o600）。既にあるファイルは元の権限を保つ。 */
	readonly newFileMode?: number;
	/** 親のフォルダが無ければ、この権限で作る。省略時は作らない（無ければ失敗する）。 */
	readonly createParentMode?: number;
	/**
	 * 一時ファイルを書き終え、置き換える直前に呼ぶ。投げたら置き換えずに一時ファイルを消して、その例外を
	 * 投げ直す（読んでから書くまでに、ほかのプロセスが元のファイルを書き換えていないかの確認に使う）。
	 */
	readonly beforeReplace?: () => Promise<void>;
	/**
	 * 置き換え（rename）が通らないとき（Windows で相手が開いたままなど）、その場へ直接書く（既定）。
	 * false なら例外にする（中途半端に書くより、書かない方が安全な認証情報や設定）。
	 */
	readonly fallbackToInPlace?: boolean;
}

/**
 * 一時ファイルへ書いて fsync し、rename で置き換える。symlink のときは実体の側を置き換える
 * （リンク自体を普通のファイルで潰さない）。元の権限は umask に削られないよう当て直す。
 */
export async function paradisWriteFileAtomic(path: string, content: Buffer | string, options: IParadisWriteFileAtomicOptions = {}): Promise<void> {
	const target = resolveWriteTarget(path);
	let mode = options.newFileMode ?? 0o600;
	try {
		mode = (await fs.stat(target)).mode & 0o777;
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	if (options.createParentMode !== undefined) {
		await fs.mkdir(dirname(target), { recursive: true, mode: options.createParentMode });
	}
	const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
	const temporary = temporaryPathFor(target);
	try {
		const handle = await fs.open(temporary, 'wx', mode);
		try {
			await handle.writeFile(data);
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await options.beforeReplace?.();
		try {
			await fs.rename(temporary, target);
		} catch (error) {
			if (options.fallbackToInPlace === false) {
				throw error;
			}
			await fs.writeFile(target, data);
		}
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

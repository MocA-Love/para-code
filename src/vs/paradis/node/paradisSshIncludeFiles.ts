/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fsp } from 'fs';
import { dirname, isAbsolute, join } from '../../base/common/path.js';

/** Include をたどる深さの上限（OpenSSH の READCONF_MAX_DEPTH と同じ）。 */
export const PARADIS_SSH_INCLUDE_MAX_DEPTH = 16;
/** 読む ssh config 1 つの大きさの上限。これより大きいもの（設定ではないファイルを指す Include など）は読まない。 */
export const PARADIS_SSH_CONFIG_MAX_BYTES = 1024 * 1024;

/**
 * Include のパスを解く。`~` は利用者のホーム、相対パスは OpenSSH と同じく利用者の設定では `~/.ssh` から解く
 * （どのファイルの中の Include でも同じ。ホストの一覧と SFTP の接続で揃える）。
 */
export function paradisResolveSshIncludePath(pattern: string, home: string): string {
	const expanded = pattern === '~' ? home : pattern.replace(/^~(?=[/\\])/, home);
	return isAbsolute(expanded) ? expanded : join(home, '.ssh', expanded);
}

/** ssh config を 1 つ読む。普通のファイルで上限より小さいときだけ読み、読めなければ undefined。 */
export async function paradisReadSshConfigFile(path: string): Promise<string | undefined> {
	try {
		const stat = await fsp.stat(path);
		if (!stat.isFile() || stat.size > PARADIS_SSH_CONFIG_MAX_BYTES) {
			return undefined;
		}
		return await fsp.readFile(path, 'utf-8');
	} catch {
		return undefined;
	}
}

/**
 * ssh config の `Include` の 1 つのパス（`~` と相対パスは解いた後）を、読むファイルの一覧にする。
 * 名前に `*`・`?` があれば、そのフォルダーの合う名前を名前順に並べる（`Include ~/.ssh/conf.d/*.conf` など）。
 * 無ければそのまま 1 件。フォルダーを読めなければ空。
 */
export async function paradisSshIncludeFiles(resolved: string): Promise<string[]> {
	if (!/[*?]/.test(resolved)) {
		return [resolved];
	}
	const directory = dirname(resolved);
	const base = resolved.slice(directory.length + 1);
	const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	const files = await fsp.readdir(directory).catch(() => [] as string[]);
	return files.filter(name => regex.test(name)).sort().map(name => join(directory, name));
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Claude Code がフォルダ名をそのまま使う長さの上限。超える分は切り詰めてハッシュを足す。 */
const MAX_SLUG_LENGTH = 200;

/**
 * Claude Code が作業ディレクトリから作る、記録の置き場のフォルダ名（`~/.claude/projects/<これ>`）。
 *
 * Claude Code 2.1.309 のバイナリと同じ作り方にしている。英数字以外を `-` にし、200 文字を超えるときは
 * 先頭 200 文字の後ろに `-` と、元のパスの 32 ビットのハッシュ（`(h << 5) - h + 文字コード`）の
 * 絶対値の 36 進数を足す。ハッシュは置き換える前のパスから作る。
 */
export function paradisClaudeProjectSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	if (slug.length <= MAX_SLUG_LENGTH) {
		return slug;
	}
	let hash = 0;
	for (let index = 0; index < cwd.length; index++) {
		hash = (hash << 5) - hash + cwd.charCodeAt(index) | 0;
	}
	return `${slug.slice(0, MAX_SLUG_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

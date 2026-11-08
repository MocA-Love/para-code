/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのファイル検索 (find/grep) を、そのワークスペースがあるマシン (shared process /
// SSH 接続先の REH サーバー) へ問い合わせるためのチャネル契約。実体は node/paradisMobileSearch.ts
// (ripgrep 実行)。shared process 版と REH 版は同じ実装をそのまま登録するだけで済むよう、
// この専用チャネルへ切り出してある。

export const PARADIS_REMOTE_SEARCH_CHANNEL = 'paradisRemoteSearch';

export interface IParadisFileSearchResult {
	/** ルート相対パス ('/'区切り)。ランク順。 */
	readonly files: string[];
	readonly truncated: boolean;
}

export interface IParadisTextSearchMatch {
	/** ルート相対パス ('/'区切り)。 */
	readonly path: string;
	/** 1始まりの行番号。 */
	readonly line: number;
	/** マッチ行のテキスト (トリム・長さ制限済み)。 */
	readonly text: string;
}

export interface IParadisTextSearchResult {
	readonly matches: IParadisTextSearchMatch[];
	readonly truncated: boolean;
}

/**
 * 検索をフォルダで絞るとき（`fs.find-dir.v1`）のフォルダの相対パスを、ripgrep に渡せる形にする。スペースの根からの
 * '/'区切りの相対パスだけを通し、空・絶対パス・`..`・`.`・`\`・NUL・ドライブ名やスキームは `undefined`（受け付けない）。
 * 末尾の '/' は落とす。シンボリックリンクでスペースの外へ出ないことは、呼び出し側が realpath で確かめる
 * （`paradisResolveMobileWorkspacePath`）。ここは REH の古い/新しいの組み合わせでも同じ検査を二重に掛けるための入口。
 */
export function paradisSanitizeSearchDir(dir: unknown): string | undefined {
	if (typeof dir !== 'string' || dir.length === 0 || dir.length > 1024) {
		return undefined;
	}
	if (dir.includes('\0') || dir.includes('\\') || dir.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dir)) {
		return undefined;
	}
	const segments = dir.split('/').filter(segment => segment.length > 0);
	if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
		return undefined;
	}
	return segments.join('/');
}

/** `path`（スペースの根からの相対）が、フォルダ `dir`（{@link paradisSanitizeSearchDir} 済み）の中か。 */
export function paradisIsInSearchDir(path: string, dir: string): boolean {
	return path.startsWith(`${dir}/`);
}

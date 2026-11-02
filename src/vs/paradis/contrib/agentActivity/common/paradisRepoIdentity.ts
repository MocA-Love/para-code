/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 作業フォルダをリポジトリへ束ねる鍵（AI コストの「リポジトリ別」。Q537 の 13 A）。環境に依らない部分だけを置く
// （ファイルを読むのは node/paradisRepoIdentityResolver.ts）。
//
// 鍵は上から順に試す:
//  1. `remote.origin.url` を正規化したもの（別の場所へ並列にクローンしたものもまとまる）
//  2. git の共通ディレクトリ（ワークツリーは本体と同じ共通ディレクトリを持つので、remote が無くてもまとまる）
//  3. どれも無ければ「リポジトリ外」

/** git の外の作業フォルダをまとめる入れ物の鍵。 */
export const PARADIS_REPO_OUTSIDE_KEY = '__paradis_outside_repo__';

export interface IParadisRepoIdentity {
	/** 束ねる鍵（`remote:<正規化した URL>` か `git:<共通ディレクトリ>`、git の外なら {@link PARADIS_REPO_OUTSIDE_KEY}）。 */
	readonly key: string;
	/** 画面に出す名前（リポジトリ名）。 */
	readonly name: string;
}

/**
 * remote の URL を、書き方の違い（スキーム・ユーザー名・`git@host:` の形・末尾の `.git`・大文字小文字）に依らない形にする。
 * `git@github.com:Owner/Repo.git` と `https://github.com/owner/repo` は同じ `github.com/owner/repo` になる。
 * 読めない形なら undefined。
 */
export function paradisNormalizeRemoteUrl(url: string): string | undefined {
	let value = url.trim();
	if (!value) {
		return undefined;
	}
	// scp の形（user@host:path）。Windows のドライブ文字（C:\）とは区別する
	const scp = /^(?:[^@/\s]+@)?(?<host>[^:/\s]+):(?!\/\/)(?<path>.+)$/.exec(value);
	if (scp?.groups && !/^[a-zA-Z]$/.test(scp.groups.host)) {
		value = `${scp.groups.host}/${scp.groups.path}`;
	} else {
		const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(?<rest>.+)$/i.exec(value);
		if (match?.groups) {
			value = match.groups.rest;
		}
	}
	value = value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
	// ポート（host:22/...）は同じリポジトリの書き方の違いなので落とす
	value = value.replace(/^([^/]+):\d+\//, '$1/');
	return value ? value.toLowerCase() : undefined;
}

/** git の config の中身から `[remote "origin"]` の `url` を読む。無ければ undefined。 */
export function paradisReadOriginUrl(config: string): string | undefined {
	let inOrigin = false;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('[')) {
			inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
			continue;
		}
		if (inOrigin) {
			const match = /^url\s*=\s*(?<url>.+)$/i.exec(line);
			if (match?.groups) {
				return match.groups.url.trim().replace(/^"(.*)"$/, '$1');
			}
		}
	}
	return undefined;
}

/** `.git` ファイル（ワークツリー・サブモジュール）の中身から gitdir を読む。 */
export function paradisReadGitdirPointer(content: string): string | undefined {
	const match = /^gitdir:\s*(?<path>.+)$/im.exec(content);
	return match?.groups?.path.trim() || undefined;
}

/** remote の URL から、画面に出す名前（最後の区切りの後ろ、`.git` を除く）を取る。大文字小文字は元のまま。 */
export function paradisRepoNameFromRemote(url: string): string {
	const parts = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/:]/).filter(part => part.length > 0);
	return parts[parts.length - 1] ?? url;
}

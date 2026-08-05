/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { toSlashes } from '../../base/common/extpath.js';
import { joinPath } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { Schemas } from '../../base/common/network.js';

/** パスとして妥当な長さの上限。これを超える gitdir は破損とみなす。 */
const MAX_GITDIR_PATH_LENGTH = 4096;

/**
 * 外部由来のパス文字列がどの種類の絶対パスか。`Relative` は絶対パスでないことを表す。
 */
const enum ParadisPathKind {
	Relative,
	/** `/home/u/repo` */
	Posix,
	/** `C:\repo` / `C:/repo` */
	WindowsDrive,
	/** `\\host\share\repo` / `//host/share/repo` */
	Unc
}

function paradisClassifyPath(rawPath: string): ParadisPathKind {
	if (/^[\\/]{2}[^\\/]/.test(rawPath)) {
		return ParadisPathKind.Unc;
	}
	if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
		return ParadisPathKind.WindowsDrive;
	}
	// `\foo` は Windows ではカレントドライブのルート基準の絶対パス。`vs/base/common/path` の
	// isAbsolute も Windows ではこれを絶対と見なすので、相対に落として base 配下へ繋いではいけない
	if (/^[\\/]/.test(rawPath)) {
		return ParadisPathKind.Posix;
	}
	return ParadisPathKind.Relative;
}

/** UNC の URI (`file://host/share/...`) から共有名 (`share`) を取り出す。 */
function paradisShareName(path: string): string | undefined {
	return /^\/([^/]+)/.exec(path)?.[1];
}

/**
 * 外部（git のメタデータ、ユーザー設定、他プロセスからの電文）で得たパス文字列を、
 * `base` と同じ scheme / authority のリソースへ写す。相対パスは `base` からの相対として解決する。
 *
 * `URI.file()` を直接使うと scheme と authority が落ちる。Windows から WSL のリポジトリを
 * `\\wsl.localhost\<distro>\...` で開いている場合、WSL 側の git が書いた `/home/u/...` は
 * distro 名を持たないため、そのまま `URI.file()` に渡すと存在しない場所を指してしまう。
 *
 * `undefined` を返すのは次の2つだけで、それ以外は必ず URI を返す:
 * - `rawPath` が空白のみ
 * - `base` が UNC (`file:` + authority) なのに共有名にあたるセグメントを持たない（`file://share/` 等）
 *
 * 注意: UNC の `base` に POSIX 絶対パスを写す分岐は「共有のルート＝ファイルシステムのルート」を
 * 前提にしている。これが成り立つのは `\\wsl.localhost\<distro>` や `\\wsl$\<distro>` の類で、
 * 一般の SMB 共有（`\\nas\projects`）では共有内の相対位置がずれる。
 */
export function paradisResolveExternalPath(base: URI, rawPath: string): URI | undefined {
	const raw = rawPath.trim();
	if (!raw) {
		return undefined;
	}

	const kind = paradisClassifyPath(raw);
	if (kind === ParadisPathKind.Relative) {
		const segments = raw.split(/[\\/]+/).filter(segment => segment.length > 0);
		return segments.length > 0 ? joinPath(base, ...segments) : base;
	}

	// 素のローカル（file: かつ authority なし）は従来どおり URI.file に委ねる。戻り値が
	// 1バイトでも変わると、URI 文字列をキーに永続化している側が既存エントリを見失うため、
	// ここでの挙動は絶対に変えないこと（下の UNC 分岐と違って toSlashes を通さないのも同じ理由）。
	if (base.scheme === Schemas.file && !base.authority) {
		return URI.file(raw);
	}

	// UNC はホスト名を自分で持つので、どの名前空間から見ても同じ場所を指す。
	// URI.file() が UNC を authority へ切り出すのは先頭が `//` のときだけなので、
	// Windows 以外で走るユニットテストでも同じ結果になるよう先に区切りを揃える。
	if (kind === ParadisPathKind.Unc) {
		return URI.file(toSlashes(raw));
	}

	if (base.scheme === Schemas.file) {
		// base 自身が UNC 共有（`\\wsl.localhost\<distro>\...` など）。共有名は base.path の
		// 先頭セグメントにあり、その先が共有内の絶対パスと一対一で対応する。
		if (kind === ParadisPathKind.WindowsDrive) {
			// ドライブレターは観測者（同じ Windows 機）から見て自己記述的なので共有をまたがない。
			return URI.file(toSlashes(raw));
		}
		const share = paradisShareName(base.path);
		return share ? base.with({ path: `/${share}${toSlashes(raw)}` }) : undefined;
	}

	// vscode-remote 等。パスはリモート側の名前空間そのものなので付け替えるだけでよい。
	// authority を持つ URI は path が `/` で始まらないと URI の検証で例外になる。
	if (kind === ParadisPathKind.WindowsDrive) {
		return base.with({ path: `/${toSlashes(raw)}` });
	}
	return base.with({ path: toSlashes(raw) });
}

/**
 * `.git/worktrees/<name>/gitdir` の内容から作業ツリーのパスを取り出す（末尾の `/.git` を落とす）。
 * 内容が相対パスのことがある（git 2.48 以降の `worktree.useRelativePaths`）。その基準は gitdir
 * ファイルのあるディレクトリなので、解決するときの `base` を取り違えないこと。
 *
 * worktree 側の `.git` ファイルに書かれた `gitdir:` 行は逆向き（作業ツリー → リポジトリ）を指すので
 * ここへ渡してはいけない。
 *
 * upstream（`extensions/git/src/git.ts` の `getWorktreesFS`）は `/\/.git.*$/` を使うが、
 * これは最左マッチのため `/home/u/.github/wt/.git` が `/home/u` に化ける。ドットが
 * エスケープされていないので `/agit/...` にも当たる。ここは意図的に異なる実装にしている。
 */
export function paradisWorktreePathFromGitdir(gitdirContent: string): string | undefined {
	// 中身は1行のパス。破損して巨大になったファイルを丸ごと正規表現に食わせると
	// バックトラックで二次関数的に遅くなり、UI スレッドが止まるので先に切り詰める
	const raw = gitdirContent.split('\n', 1)[0].trim();
	if (raw.length > MAX_GITDIR_PATH_LENGTH) {
		return undefined;
	}
	return /^(?<worktree>.+)[\\/]\.git(?:[\\/].*)?$/.exec(raw)?.groups?.worktree;
}

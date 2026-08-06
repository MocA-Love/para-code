/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの作業ディレクトリから、そのエージェントCLIが実際に使っているホームを推定する。
//
// 背景: リポジトリを `\\wsl.localhost\<distro>\home\<user>\projects\<repo>` として開いている場合、
// claude / codex は WSL の中で動くので、transcript は Linux 側の `~/.claude` `~/.codex` に書かれる。
// Windows から見ればそれは `\\wsl.localhost\<distro>\home\<user>\.claude` であって、Windows 側の
// `C:\Users\<me>\.claude` ではない。探索先をペインごとに切り替えないと、実在するセッションを
// 一件も見つけられない。
//
// 「どのユーザーのホームか」は作業ディレクトリから決める。ディストロの既定ユーザーを聞きに行く
// 手もあるが、エージェントは ssh 越しなど既定とは別のユーザーで動いていることがあり、
// 「そのリポジトリを持っている人のホーム」のほうが実態に合う。

import { paradisParseWslUncPath } from './paradisWslPath.js';

/** ディストロの中から見たホームディレクトリの絶対パス。 */
function paradisWslHomeForLinuxPath(linuxPath: string): string | undefined {
	if (linuxPath === '/root' || linuxPath.startsWith('/root/')) {
		return '/root';
	}
	const user = /^\/home\/([^/]+)(?:\/|$)/.exec(linuxPath)?.[1];
	return user !== undefined ? `/home/${user}` : undefined;
}

export interface IParadisWslAgentHome {
	/** UNC のホスト名（`wsl.localhost` / `wsl$`）。登録時の綴りを保つ。 */
	readonly host: string;
	/** `wsl.exe -d` に渡せるディストロ名。 */
	readonly distro: string;
	/** Windows から読める `\\wsl.localhost\<distro>\home\<user>` 形式のホーム。 */
	readonly homeUncPath: string;
	/** ディストロの中から見た作業ディレクトリ。transcript の突き合わせにはこちらを使う。 */
	readonly linuxCwd: string;
}

/**
 * 作業ディレクトリが WSL の中を指しているなら、そのホームを Windows から読めるパスで返す。
 *
 * ホームを特定できない場所（`/srv/...` や `/mnt/...` など）では undefined を返す。推測で
 * 別のユーザーのホームを覗きに行くより、見つからないままのほうが安全なため。
 */
export function paradisResolveWslAgentHome(cwd: string): IParadisWslAgentHome | undefined {
	const location = paradisParseWslUncPath(cwd);
	if (location === undefined) {
		return undefined;
	}
	const home = paradisWslHomeForLinuxPath(location.linuxPath);
	if (home === undefined) {
		return undefined;
	}
	// UNC の区切りへ戻す。ホスト名は登録時に書かれていた綴り（`wsl.localhost` / `wsl$`）を保つ。
	return {
		host: location.host,
		distro: location.distro,
		homeUncPath: `\\\\${location.host}\\${location.distro}${home.replace(/\//g, '\\')}`,
		linuxCwd: location.linuxPath,
	};
}

/**
 * ディストロの中の絶対パス（`/home/u/.codex/sessions/x.jsonl`）を、Windows から読める UNC へ戻す。
 *
 * Codex の state DB や rollout の中身に書かれているのは Linux 側の表記なので、そのまま開こうと
 * しても Windows のプロセスからは存在しないパスになる。読む前に必ずここを通すこと。
 */
export function paradisWslUncPathFrom(home: Pick<IParadisWslAgentHome, 'host' | 'distro'>, linuxPath: string): string {
	return `\\\\${home.host}\\${home.distro}${linuxPath.replace(/\//g, '\\')}`;
}

/**
 * WSL のディストロの中にあるエージェントCLIのホーム配下を指すパスか。
 *
 * transcript の許可判定に使う。「今どのターミナルが開いているか」には**依存させない**。
 * 生きているペインから許可集合を組み立てると、まだ作業ディレクトリが判明していない起動直後に
 * 「許可されていない」と「まだ分からない」が同じ答えに潰れ、永続化してあったセッションを
 * 消してしまう。形だけで判定すればその窓は生まれない。
 *
 * 判定は Windows のパス規則に合わせて大文字小文字を無視する。
 */
export function paradisIsWslAgentHomePath(path: string): boolean {
	return /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/](?:home[\\/][^\\/]+|root)[\\/]\.(?:claude|codex)(?:[\\/]|$)/i.test(path);
}

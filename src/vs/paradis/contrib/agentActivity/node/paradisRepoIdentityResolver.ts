/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログの作業フォルダから、そのリポジトリの鍵を決める（AI コストの「リポジトリ別」。Q537 の 13 A）。
// git は起動せず、`.git`（ディレクトリかワークツリーのファイル）と共通ディレクトリの `config` を読むだけにする。
// 作業フォルダごとに 1 回だけ読み、覚えておく（消したワークツリーも、この shared process が生きている間は束ねられる）。

import { promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from '../../../../base/common/path.js';
import { IParadisRepoIdentity, PARADIS_REPO_OUTSIDE_KEY, paradisNormalizeRemoteUrl, paradisReadGitdirPointer, paradisReadOriginUrl, paradisRepoNameFromRemote } from '../common/paradisRepoIdentity.js';

/** ファイルを読む口。テストで差し替える。 */
export interface IParadisRepoIdentityFileSystem {
	readFile(path: string): Promise<string>;
	/** ディレクトリなら 'dir'、ファイルなら 'file'、無ければ undefined。 */
	kind(path: string): Promise<'dir' | 'file' | undefined>;
}

const nodeFileSystem: IParadisRepoIdentityFileSystem = {
	readFile: path => fs.readFile(path, 'utf8'),
	kind: async path => {
		try {
			const stat = await fs.stat(path);
			return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
		} catch {
			return undefined;
		}
	},
};

/** 上へ辿る上限（シンボリックリンクの輪などで止まらなくならないように）。 */
const MAX_DEPTH = 64;

const OUTSIDE: IParadisRepoIdentity = { key: PARADIS_REPO_OUTSIDE_KEY, name: '' };

export class ParadisRepoIdentityResolver {

	private readonly cache = new Map<string, Promise<IParadisRepoIdentity>>();

	constructor(private readonly fileSystem: IParadisRepoIdentityFileSystem = nodeFileSystem) { }

	/** 作業フォルダのリポジトリの鍵。読めなければ「リポジトリ外」。 */
	resolve(cwd: string): Promise<IParadisRepoIdentity> {
		let result = this.cache.get(cwd);
		if (!result) {
			result = this.resolveUncached(cwd).catch(() => OUTSIDE);
			this.cache.set(cwd, result);
		}
		return result;
	}

	private async resolveUncached(cwd: string): Promise<IParadisRepoIdentity> {
		if (!isAbsolute(cwd)) {
			return OUTSIDE;
		}
		let dir = resolve(cwd);
		for (let depth = 0; depth < MAX_DEPTH; depth++) {
			const dotGit = join(dir, '.git');
			const kind = await this.fileSystem.kind(dotGit);
			if (kind) {
				const gitDir = kind === 'dir' ? dotGit : await this.gitdirFromFile(dotGit, dir);
				return gitDir ? this.identityFromGitDir(gitDir, dir) : OUTSIDE;
			}
			const parent = dirname(dir);
			if (parent === dir) {
				break;
			}
			dir = parent;
		}
		return OUTSIDE;
	}

	/** ワークツリー・サブモジュールの `.git` ファイルが指す gitdir。 */
	private async gitdirFromFile(dotGit: string, topLevel: string): Promise<string | undefined> {
		const pointer = paradisReadGitdirPointer(await this.fileSystem.readFile(dotGit));
		return pointer ? resolve(topLevel, pointer) : undefined;
	}

	private async identityFromGitDir(gitDir: string, topLevel: string): Promise<IParadisRepoIdentity> {
		// ワークツリーの gitdir（<本体>/.git/worktrees/<名前>）は commondir で本体の .git を指す
		let commonDir = gitDir;
		try {
			const pointer = (await this.fileSystem.readFile(join(gitDir, 'commondir'))).trim();
			if (pointer) {
				commonDir = resolve(gitDir, pointer);
			}
		} catch {
			// commondir が無ければ gitdir がそのまま共通ディレクトリ
		}
		let originUrl: string | undefined;
		try {
			originUrl = paradisReadOriginUrl(await this.fileSystem.readFile(join(commonDir, 'config')));
		} catch {
			originUrl = undefined;
		}
		const normalized = originUrl !== undefined ? paradisNormalizeRemoteUrl(originUrl) : undefined;
		if (originUrl !== undefined && normalized) {
			return { key: `remote:${normalized}`, name: paradisRepoNameFromRemote(originUrl) };
		}
		// remote が無いときは共通ディレクトリで束ねる。名前は本体の作業フォルダ（<本体>/.git の親）の名前
		const name = basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(topLevel);
		return { key: `git:${commonDir}`, name };
	}
}

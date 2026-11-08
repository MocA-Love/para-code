/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面で選べるリポジトリ（github.com の `owner/name`）を、この窓のスペースから集める。
// git の設定（`.git/config`）は IFileService で読むので、SSH の窓では接続先のファイルを読む（手元と取り違えない）。
// ワークツリー（`.git` がファイル）は gitdir → commondir をたどって本体の config を読む。

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { paradisReadGitdirPointer, paradisReadOriginUrl } from '../../agentActivity/common/paradisRepoIdentity.js';
import { paradisTasksApplyInsteadOf, paradisTasksGithubRepositoryFromRemote } from '../common/paradisTasks.js';

export interface IParadisTasksRepository {
	/** `owner/name`。 */
	readonly name: string;
	/** この名前を見つけたスペースの表示名（同じリポジトリのワークツリーが並んでも 1 つにまとめる）。 */
	readonly spaceName: string;
	/** 見つけたスペースのフォルダ（ボードへ渡すときの行き先）。 */
	readonly folder: URI;
}

export interface IParadisTasksRepositorySource {
	readonly name: string;
	readonly uri: URI;
}

/** パス（絶対か、base からの相対）を base と同じスキーム・authority の URI にする。 */
function resolvePath(base: URI, path: string): URI {
	const normalized = path.replace(/\\/g, '/');
	if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
		return base.with({ path: normalized.startsWith('/') ? normalized : `/${normalized}` });
	}
	return joinPath(base, normalized);
}

async function readText(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		return (await fileService.readFile(uri, { limits: { size: 256 * 1024 } })).value.toString();
	} catch {
		return undefined;
	}
}

/** フォルダの git の config の場所。git の外なら undefined。 */
async function gitConfigOf(fileService: IFileService, folder: URI): Promise<URI | undefined> {
	const dotGit = joinPath(folder, '.git');
	let isDirectory: boolean;
	try {
		isDirectory = (await fileService.stat(dotGit)).isDirectory;
	} catch {
		return undefined;
	}
	if (isDirectory) {
		return joinPath(dotGit, 'config');
	}
	const pointer = paradisReadGitdirPointer(await readText(fileService, dotGit) ?? '');
	if (!pointer) {
		return undefined;
	}
	const gitdir = resolvePath(folder, pointer);
	const commondir = (await readText(fileService, joinPath(gitdir, 'commondir')))?.trim();
	return joinPath(commondir ? resolvePath(gitdir, commondir) : gitdir, 'config');
}

/** 1 つのフォルダの origin が github.com を指していれば、その `owner/name`。 */
export async function paradisTasksResolveRepository(fileService: IFileService, folder: URI): Promise<string | undefined> {
	const config = await gitConfigOf(fileService, folder);
	if (!config) {
		return undefined;
	}
	const text = await readText(fileService, config) ?? '';
	const origin = paradisReadOriginUrl(text);
	// `gh:owner/repo` のような短縮名は、同じ config の insteadOf で git が使う URL に戻してから読む
	return origin ? paradisTasksGithubRepositoryFromRemote(paradisTasksApplyInsteadOf(origin, text)) : undefined;
}

/**
 * スペースの並びから、github.com のリポジトリを重ねずに集める（大文字小文字は区別しない。先に見つけたスペースの表記を使う）。
 * 読めないもの・github.com 以外のものは黙って外す。
 */
export async function paradisTasksResolveRepositories(fileService: IFileService, sources: readonly IParadisTasksRepositorySource[]): Promise<IParadisTasksRepository[]> {
	const resolved = await Promise.all(sources.map(async source => ({ source, name: await paradisTasksResolveRepository(fileService, source.uri) })));
	const seen = new Set<string>();
	const repositories: IParadisTasksRepository[] = [];
	for (const { source, name } of resolved) {
		if (!name || seen.has(name.toLowerCase())) {
			continue;
		}
		seen.add(name.toLowerCase());
		repositories.push({ name, spaceName: source.name, folder: source.uri });
	}
	return repositories;
}


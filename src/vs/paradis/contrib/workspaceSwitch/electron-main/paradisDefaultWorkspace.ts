/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

interface IParadisWorkspaceLikePath {
	/** IWorkspaceIdentifier (configPath あり) または ISingleFolderWorkspaceIdentifier (uri のみ) */
	readonly workspace?: object;
}

function workspaceConfigPathOf(path: IParadisWorkspaceLikePath): URI | undefined {
	const configPath = (path.workspace as { readonly configPath?: unknown } | undefined)?.configPath;
	return URI.isUri(configPath) ? configPath : undefined;
}

/**
 * 素の起動 (CLI引数なし・前セッション復元パス) で、Superset のように必ずデフォルトの
 * マルチリポワークスペース (~/.para-code/para.code-workspace) のウィンドウが含まれるようにする
 * (機能1 Phase E)。windowsMainService の PARA-PATCH 1点から呼ばれる。
 *
 * - 復元セットに既に含まれていれば何もしない (重複ウィンドウを開かない)
 * - ワークスペースファイル未作成 (Para Code: Initialize Multi-Repo Workspace 未実行) なら何もしない
 * - 明示的な CLI / API オープンや2枚目以降のウィンドウはこの関数を通らず従来挙動
 */
export async function paradisEnsureDefaultWorkspace<T extends IParadisWorkspaceLikePath>(
	paths: T[],
	resolve: (openable: { workspaceUri: URI }) => Promise<T | undefined>
): Promise<T[]> {
	const configPath = join(homedir(), '.para-code', 'para.code-workspace');
	if (!existsSync(configPath)) {
		return paths;
	}

	const uri = URI.file(configPath);
	if (paths.some(path => {
		const pathConfigUri = workspaceConfigPathOf(path);
		return pathConfigUri !== undefined && extUriBiasedIgnorePathCase.isEqual(pathConfigUri, uri);
	})) {
		return paths;
	}

	const resolved = await resolve({ workspaceUri: uri });
	if (!resolved || workspaceConfigPathOf(resolved) === undefined) {
		return paths;
	}

	// 先頭に置く = 最後にフォーカスされるのは従来の復元ウィンドウ側 (unshift 相当)
	return [resolved, ...paths];
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/**
 * 「Para ホスト」ビューの ID。リモートエクスプローラー (workbench.view.remote) の中に置く。
 * ホスト → スペース → ファイルの3階層ツリーで、SSH 先と手元の間でファイルを行き来できるようにする。
 */
export const PARADIS_REMOTE_HOSTS_VIEW_ID = 'workbench.view.paradisRemoteHosts.hosts';

/** リモートエクスプローラーコンテナの ID。remoteExplorer.ts (VIEWLET_ID) と同じ値。
 *  値だけを写す — import してしまうと remote contrib モジュール全体の評価順序に依存し、
 *  コンテナ未登録状態での registerViews が失敗しかねないため。 */
export const PARADIS_REMOTE_EXPLORER_CONTAINER_ID = 'workbench.view.remote';

// --- ツリー要素 ----------------------------------------------------------------------------------

/** ツリーの要素。ホスト(このマシン / 接続先) → スペース(登録スペース / ホーム) → ファイル。 */
export type ParadisRemoteHostsElement =
	| ParadisRemoteHost
	| ParadisRemoteSpace
	| ParadisRemoteFileEntry;

/** 「このマシン」「接続先ホスト」の見出し行。 */
export interface ParadisRemoteHost {
	readonly type: 'host';
	/** 手元は空文字、接続先は remoteAuthority ('ssh-remote+...')。
	 *  workspaceSwitchService.hostKey と同じ約束。 */
	readonly hostKey: string;
	readonly label: string;
	/** このウィンドウ自身がそのホストへ繋がっているか */
	readonly connected: boolean;
	/** ユーザーホーム。取得できない環境(web など)は undefined */
	readonly homeUri: URI | undefined;
}

/** スペース行。台帳に登録されたリポジトリと、合成エントリの「ホーム」を同じ形で扱う。 */
export interface ParadisRemoteSpace {
	readonly type: 'space';
	readonly hostKey: string;
	readonly repositoryId: string;
	readonly name: string;
	readonly uri: URI;
	readonly color?: string;
}

/** ファイル / フォルダ行。 */
export interface ParadisRemoteFileEntry {
	readonly type: 'file' | 'dir';
	readonly hostKey: string;
	readonly uri: URI;
	readonly name: string;
}

export function isParadisRemoteHost(element: ParadisRemoteHostsElement): element is ParadisRemoteHost {
	return element.type === 'host';
}

export function isParadisRemoteSpace(element: ParadisRemoteHostsElement): element is ParadisRemoteSpace {
	return element.type === 'space';
}

export function isParadisRemoteFileEntry(element: ParadisRemoteHostsElement): element is ParadisRemoteFileEntry {
	return element.type === 'file' || element.type === 'dir';
}

/**
 * その行の集合を、その転送先へドロップしてよいか。
 *
 * このビューは**マシン間のコピー専用**の入口なので、転送先と同じマシンのものが**1件でも**
 * 混ざっていたら受けない。以前は「全件が転送先と同じホストなら拒否」だったため、両ホストに
 * またがる複数選択だけが受理をすり抜け、同じマシン内のぶんまで転送経路（上書き確認つきの
 * コピー）へ流れていた。同じマシン内のファイル操作はエクスプローラーの仕事として、
 * ここでは一切引き受けない。
 */
export function paradisAllowsHostDrop(sourceHostKeys: readonly string[], targetHostKey: string): boolean {
	return sourceHostKeys.length > 0 && sourceHostKeys.every(hostKey => hostKey !== targetHostKey);
}

/** その場所が属するホストの鍵。手元は空文字。workspaceSwitchService.belongsToThisHost と同一の約束。 */
export function paradisHostKeyFor(uri: URI): string {
	return uri.scheme === Schemas.vscodeRemote ? uri.authority : '';
}

/**
 * スペース台帳 (workspaceSwitch の保存領域) を読み、接続先ごとに分類する。
 *
 * 台帳は接続先ごとのワークスペース保管領域に分かれて書かれるため、1つのウィンドウから
 * 読めるのは「このウィンドウの繋がっている側」ぶんだけ。それでも両サイドのビューとして
 * 一貫した形になる (手元ウィンドウでは手元の台帳、SSH ウィンドウでは SSH 側の台帳)。
 */
export function paradisParseSpacesByHost(storageService: IStorageService): Map<string, IParadisWorkspaceRepository[]> {
	const result = new Map<string, IParadisWorkspaceRepository[]>();
	const raw = storageService.get(PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, StorageScope.WORKSPACE);
	if (!raw) {
		return result;
	}
	try {
		const parsed: Array<{ id: string; name: string; uri: string; color?: string }> = JSON.parse(raw);
		for (const entry of parsed) {
			const repository: IParadisWorkspaceRepository = {
				id: entry.id,
				name: entry.name,
				uri: URI.parse(entry.uri),
				color: entry.color,
			};
			const hostKey = paradisHostKeyFor(repository.uri);
			const list = result.get(hostKey);
			if (list) {
				list.push(repository);
			} else {
				result.set(hostKey, [repository]);
			}
		}
	} catch {
		// 壊れた台帳は空として扱う (Workspaces ビュー本体も parse 失敗時に [] を返す)
	}
	return result;
}

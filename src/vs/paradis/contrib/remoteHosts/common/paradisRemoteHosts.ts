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
	/**
	 * このウィンドウが繋がっていない、`~/.ssh/config` 由来のホスト。
	 *
	 * 繋がっているホストは既存の SSH 接続 (`vscode-remote://` + IFileService) で読めるが、
	 * こちらは読むたびに `ssh` を起こす。転送系 (IFileService.copy) はこの URI を解決できないので
	 * **閲覧専用**として扱う (行った先で失敗するより、最初から出さない方がよい)。
	 */
	readonly offline?: boolean;
	/** offline ホストの ssh 接続先エイリアス (`~/.ssh/config` の Host 名)。 */
	readonly sshAlias?: string;
}

/** 未接続ホストを `ssh` 越しに読むためのバックエンド。electron-browser 側だけが実装を持つ。 */
export const PARADIS_REMOTE_HOSTS_CHANNEL = 'paradisRemoteHosts';

/** `ssh <host> ls` 相当で得られる 1 エントリ。 */
export interface IParadisSshDirEntry {
	readonly name: string;
	readonly isDirectory: boolean;
}

/** 未接続ホストの一覧取得要求。`path` は空ならホームディレクトリ。 */
export interface IParadisSshListRequest {
	readonly host: string;
	readonly path: string;
}

/** 一覧結果。`truncated` なら上限で打ち切っている (「これで全部」と読ませないため)。 */
export interface IParadisSshListing {
	readonly entries: readonly IParadisSshDirEntry[];
	readonly truncated: boolean;
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
 * 未接続ホストの hostKey に付ける印。接続中ホストの hostKey (= remoteAuthority) と
 * 混ざると転送の可否判定が壊れるので、別空間だと分かる形にしておく。
 */
export const PARADIS_OFFLINE_HOST_PREFIX = 'paradis-offline+';

/** 未接続ホストのファイル行に使う URI スキーム。実在の file:// と取り違えないための印。 */
export const PARADIS_OFFLINE_URI_SCHEME = 'paradis-offline';

/** その hostKey が未接続ホストのものか。 */
export function paradisIsOfflineHostKey(hostKey: string): boolean {
	return hostKey.startsWith(PARADIS_OFFLINE_HOST_PREFIX);
}

/** 未接続ホストの hostKey から ssh 別名を取り出す。違うものなら undefined。 */
export function paradisOfflineAliasOf(hostKey: string): string | undefined {
	return paradisIsOfflineHostKey(hostKey) ? hostKey.slice(PARADIS_OFFLINE_HOST_PREFIX.length) : undefined;
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
	// 未接続ホストは閲覧専用。転送は IFileService.copy に載っていて、その URI は解決できない。
	// hostKey が違うだけの判定では `''`(このマシン) と `paradis-offline+xxx` が「違うマシン」に
	// なって素通りするので、ここで明示的に落とす (メニュー側だけ塞いでも D&D は別経路)
	if (paradisIsOfflineHostKey(targetHostKey) || sourceHostKeys.some(paradisIsOfflineHostKey)) {
		return false;
	}
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

// --- 未接続ホストのブラウズ ------------------------------------------------------------------

/**
 * 未接続ホスト (`~/.ssh/config` に書いてあるだけのホスト) を読むための入口。
 *
 * ビュー本体は browser 層にあり Web ビルドにも載るが、ssh を起こせるのは Electron の
 * shared process だけ。DI で任意依存にはできない (登録の無いサービスを解決すると起動時に
 * 落ちる) ので、sentry の reporter と同じく**実装側から差し込む**形にする。
 * 差し込まれない環境 (Web) では未接続ホストの行そのものを出さない。
 * 実装は electron-browser/paradisRemoteHostBrowser.ts。
 */
export interface IParadisRemoteHostBrowser {
	/** `~/.ssh/config` のホスト別名 (ワイルドカードは除く)。 */
	listConfiguredHosts(): Promise<readonly string[]>;
	/** ssh 越しに1階層読む。`path` が空ならホームディレクトリ。 */
	listDirectory(host: string, path: string): Promise<IParadisSshListing>;
}

let remoteHostBrowser: IParadisRemoteHostBrowser | undefined;

/**
 * Electron 側の実装を差し込む。読み込まれない環境では未接続ホストの機能が丸ごと無効になる。
 * `undefined` を渡すと解除できる (ウィンドウを閉じるときに、消えた実装を掴んだままにしない)。
 */
export function configureParadisRemoteHostBrowser(value: IParadisRemoteHostBrowser | undefined): void {
	remoteHostBrowser = value;
}

/** 差し込まれていれば未接続ホストを読める。Web では undefined。 */
export function paradisRemoteHostBrowser(): IParadisRemoteHostBrowser | undefined {
	return remoteHostBrowser;
}

/**
 * `ls -Ap` の出力を1階層分のエントリへ直す。
 *
 * `-p` はディレクトリにだけ `/` を付けるので、1回の往復で種別まで分かる (`ls -l` の書式は
 * 実装差が大きく、`find -printf` は BSD 系に無い)。名前に改行を含むエントリは種別を誤るため、
 * 行末が `/` かどうかだけで判定し、それ以外の解釈はしない。
 *
 * `max` を超えた分は落とし、落としたことだけを `truncated` で返す (巨大ディレクトリで
 * shared process のメモリを食い潰さないための保険)。
 */
export function paradisParseSshListing(stdout: string, max: number): { entries: IParadisSshDirEntry[]; truncated: boolean } {
	const lines = stdout.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0);
	const truncated = lines.length > max;
	const entries: IParadisSshDirEntry[] = [];
	for (const line of lines.slice(0, max)) {
		const isDirectory = line.endsWith('/');
		const name = isDirectory ? line.slice(0, -1) : line;
		if (name.length === 0 || name === '.' || name === '..') {
			continue;
		}
		entries.push({ name, isDirectory });
	}
	entries.sort((a, b) =>
		Number(b.isDirectory) - Number(a.isDirectory) ||
		a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	return { entries, truncated };
}

/**
 * ssh へ渡してよいホスト名か。`-oProxyCommand=...` のようなオプション注入を防ぐため、
 * `~/.ssh/config` の Host 名として妥当な文字だけ通す。
 *
 * **先頭のハイフンは許さない**。文字クラスの末尾に `-` を置くとリテラルのハイフンとして
 * 通ってしまい、`-G` のような単体オプションが宛先として渡る (実行時は `--` でも守るが、
 * ここで落とす方が意図が明確)。
 */
const PARADIS_SAFE_SSH_HOST = /^[A-Za-z0-9._@][A-Za-z0-9._@:-]*$/;

export function paradisIsSafeSshHost(host: string): boolean {
	const trimmed = host.trim();
	return trimmed.length > 0 && PARADIS_SAFE_SSH_HOST.test(trimmed);
}

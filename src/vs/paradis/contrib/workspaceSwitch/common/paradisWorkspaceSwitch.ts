/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IParadisWorkspaceSwitchService = createDecorator<IParadisWorkspaceSwitchService>('paradisWorkspaceSwitchService');

/**
 * ワークスペース切り替え(機能1)の切り替え対象として登録されたリポジトリ1件分。
 * uri がワークスペースのルートフォルダとして folders に投入される。
 */
export interface IParadisWorkspaceRepository {
	readonly id: string;
	readonly name: string;
	readonly uri: URI;
}

/**
 * 複数リポジトリを単一のマルチルートワークスペース内で瞬時に切り替えるサービス。
 * ワークスペースの identity (configPath 由来の workspace id) を固定したまま
 * IWorkspaceEditingService.updateFolders で folders だけを入れ替えることで、
 * WORKSPACE スコープの storage (エディタ viewState / 展開状態 / タスク履歴等) を
 * リポジトリ間で共有しつつ Extension Host を再起動させない (relauncher 側の PARA-PATCH と対)。
 */
export interface IParadisWorkspaceSwitchService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRepositories: Event<void>;

	/**
	 * 切り替え処理の冒頭 (状態退避の直前) に発火する。ペイロードは切り替え元
	 * (登録リスト外のフォルダを開いていた場合は undefined)。SCM入力の退避など、
	 * updateFolders でリソースが破棄される前に済ませたい処理のためのフック。
	 */
	readonly onWillSwitchRepository: Event<IParadisWorkspaceRepository | undefined>;
	readonly onDidSwitchRepository: Event<IParadisWorkspaceRepository>;

	readonly repositories: readonly IParadisWorkspaceRepository[];

	/**
	 * 現在ワークスペースのルートに入っている登録済みリポジトリ。
	 * 登録リスト外のフォルダが開かれている場合は undefined。
	 */
	readonly activeRepository: IParadisWorkspaceRepository | undefined;

	/**
	 * switchRepository の実行中 (退避 → updateFolders → 復元 の間) は true。
	 * ブラウザスコープ側が「切り替えによるエディタクローズ」と「ユーザーによる
	 * タブクローズ」を区別して dispose を veto するために使う。
	 */
	readonly isSwitching: boolean;

	addRepository(uri: URI, name?: string): Promise<IParadisWorkspaceRepository>;
	removeRepository(id: string): Promise<void>;

	/**
	 * ワークスペースの folders を対象リポジトリ1つに入れ替える。
	 * マルチルート (WORKSPACE) 状態でのみ動作する (単一フォルダ状態から呼ぶと
	 * upstream が新規 untitled workspace を作ってしまい workspace id が変わるため拒否する)。
	 */
	switchRepository(id: string): Promise<void>;
}

// --- Extension Host 再起動の抑止フラグ ---------------------------------------------------------
//
// upstream の WorkspaceChangeExtHostRelauncher (relauncher.contribution.ts) は folders[0] の
// 変化を検知すると Extension Host を全再起動する。根拠は非推奨 workspace.rootPath 互換のみ。
// Paradis のワークスペース切り替えは folders を丸ごと入れ替えるため、この再起動が起きると
// 切り替えのたびに全拡張機能が落ちて「瞬時の切り替え」が成立しない。
// このウィンドウが Paradis 管理下 (リポジトリ切り替え運用中) になった時点でフラグを立て、
// relauncher 側の PARA-PATCH がこれを読んで再起動をスキップする。
// module スコープの変数で持つのは、relauncher (upstream ファイル) 側の変更を
// 「import 1行 + 条件 1語」に抑えるため (DI サービス注入はコンフリクト面が広がる)。

let paradisManagedWorkspaceWindow = false;

/**
 * このウィンドウを Paradis 管理下 (リポジトリ切り替え運用中) として記録する。
 * 一度立てたらウィンドウの生存中は下ろさない。
 */
export function markParadisManagedWorkspaceWindow(): void {
	paradisManagedWorkspaceWindow = true;
}

/**
 * relauncher の PARA-PATCH から参照される。true の間は folders[0] 変化による
 * Extension Host 再起動をスキップする。
 */
export function isParadisManagedWorkspaceWindow(): boolean {
	return paradisManagedWorkspaceWindow;
}

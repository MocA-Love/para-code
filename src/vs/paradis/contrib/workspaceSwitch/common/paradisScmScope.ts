/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * ソース管理のリポジトリを現在のスペースに絞る機能のオン/オフ (既定 true)。
 * 表示制御 (`paradisScmRepoScope`) と一覧の絞り込み (`paradisScopedScmViewService`) が同じ設定を
 * 見るよう、キーはここでのみ定義する。
 */
export const PARADIS_SCM_SCOPE_SETTING_ID = 'paradis.workspaceSwitch.scopeScmRepositories';

/**
 * ソース管理のリポジトリが「現在のワークスペースフォルダに関係するもの」かを判定する (機能1)。
 *
 * 「リポジトリのルートがワークスペースフォルダ配下にある」か「ワークスペースフォルダがリポジトリ
 * 配下にある」(リポジトリ内のサブフォルダだけを開いている場合) をスコープ内とする。したがって
 * 祖先ディレクトリのリポジトリはスコープ内であり、スコープ外になるのは兄弟関係のもの — 切り替え
 * 前のスペースや、そこにぶら下がる worktree — に限られる。
 *
 * ルート未設定のプロバイダ (ファイルシステム上の場所を持たないもの) と空ウィンドウでは、絞り込む
 * 基準が無いため常にスコープ内として扱う。
 *
 * 判定を `paradisScmRepoScope` (表示の制御) と `paradisScopedScmViewService` (一覧の絞り込み) の
 * 双方から使うため、UI に依存しない純関数としてここに置く。
 */
export function paradisIsScmRootInScope(root: URI | undefined, folders: readonly URI[], extUri: IExtUri): boolean {
	if (!root || folders.length === 0) {
		return true;
	}
	return folders.some(folder => extUri.isEqualOrParent(root, folder) || extUri.isEqualOrParent(folder, root));
}

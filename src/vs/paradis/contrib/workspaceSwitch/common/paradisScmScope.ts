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
 * ソース管理のリポジトリが「現在のワークスペースフォルダ（＝今のスペース）に属するもの」かを判定する (機能1)。
 *
 * git の「いちばん近い `.git` が持ち主」という規則に揃える。git 拡張の待避の判定
 * (`extensions/git/src/paradisUnaccountedToPark.ts` の `paradisRepositoryBelongsToFolder`) と同じ規則にする
 * (別のビルド単位なので関数は共有できない。片方を変えたらもう片方も変えること)。
 *
 * - ルートとワークスペースフォルダが同じ: スコープ内
 * - ワークスペースフォルダがリポジトリ配下にある (リポジトリ内のサブフォルダだけを開いている場合): スコープ内。
 *   ただし、その間に別のリポジトリのルートがあれば (入れ子のワークツリーのスペース等)、外側のリポジトリは
 *   スコープ外。間にあるかは `otherRoots` (登録済みのリポジトリのルート) で見る
 * - リポジトリのルートがワークスペースフォルダ配下にある (入れ子のリポジトリ): スコープ内。ただしリンクされた
 *   ワークツリー (`kind` が `'worktree'`。git 拡張が `contextValue` に入れる) は、フォルダからワークツリーまでの
 *   間に別のリポジトリ (メイン) のルートがあれば、それ自体が別のスペースなのでスコープ外 (入れ子のサブモジュール・
 *   独立したリポジトリ、リポジトリでないフォルダの中のワークツリーは今までどおりスコープ内)
 *
 * スコープ外になるのは、兄弟関係のもの (切り替え前のスペースや、そこにぶら下がる worktree) と、上の 2 つの
 * 例外に限られる。ルート未設定のプロバイダ (ファイルシステム上の場所を持たないもの) と空ウィンドウでは、
 * 絞り込む基準が無いため常にスコープ内として扱う。
 *
 * 判定を `paradisScmRepoScope` (表示の制御) と `paradisScopedScmViewService` (一覧の絞り込み) の
 * 双方から使うため、UI に依存しない純関数としてここに置く。
 */
export function paradisIsScmRootInScope(root: URI | undefined, folders: readonly URI[], extUri: IExtUri, kind?: string, otherRoots: readonly URI[] = []): boolean {
	if (!root || folders.length === 0) {
		return true;
	}
	return folders.some(folder => extUri.isEqual(root, folder)
		|| (extUri.isEqualOrParent(folder, root) && !otherRoots.some(other => !extUri.isEqual(other, root) && extUri.isEqualOrParent(other, root) && extUri.isEqualOrParent(folder, other)))
		|| (extUri.isEqualOrParent(root, folder) && !(kind === 'worktree' && otherRoots.some(other => !extUri.isEqual(other, root) && extUri.isEqualOrParent(other, folder) && extUri.isEqualOrParent(root, other)))));
}

/**
 * ソース管理の一覧で、このリポジトリを入れ子として並べる親の id。親 (`parentId`) が一覧に無いとき
 * (スペースの絞り込みで外れたメインのリポジトリなど) は `undefined` を返し、最上位に出す。「リポジトリ」
 * ビューは子を親の下にしか並べないため、そのままでは子ごと見えなくなる。
 */
export function paradisScmDisplayedParentId(repository: { readonly provider: { readonly parentId?: string } }, repositories: readonly { readonly provider: { readonly id: string } }[]): string | undefined {
	const parentId = repository.provider.parentId;
	return parentId !== undefined && repositories.some(candidate => candidate.provider.id === parentId) ? parentId : undefined;
}

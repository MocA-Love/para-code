/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../../workbench/contrib/scm/common/scm.js';

/**
 * ソース管理ビューの表示リポジトリを「現在のワークスペースフォルダに関係するもの」だけに絞る (機能1)。
 *
 * git 拡張は既定 (git.autoRepositoryDetection=true) で「見えているエディタのファイルが属する
 * リポジトリ」を自動で開く。さらに worktree を開いていると、その親リポジトリと兄弟 worktree は
 * 「ワークスペース内」と見なされて確認なしで開かれる (extensions/git/src/model.ts の
 * isRepositoryOutsideWorkspace が repository.worktrees を参照するため)。一度こうして開いた
 * リポジトリはフォルダ入れ替えでは閉じられず (close 対象は「削除されたフォルダのリポジトリ」のみ)、
 * スペースを切り替えるたびに SCM ビューへ蓄積していく。
 *
 * ここでは git 拡張側の状態には一切触れず (Model.close は closedRepositories として永続記憶され、
 * そのスペースへ戻ったとき自動で再オープンされなくなる罠がある)、workbench 側の
 * ISCMViewService.visibleRepositories で「表示」だけをスコープに絞る。リポジトリ自体は開いたままの
 * ため、ガター差分などスコープ外ファイルの編集機能は損なわれない。
 * `paradis.workspaceSwitch.scopeScmRepositories` (既定 true) で無効化できる。
 */
class ParadisScmRepoScope extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisScmRepoScope';

	private static readonly SETTING_ID = 'paradis.workspaceSwitch.scopeScmRepositories';

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// 新しく登録されたリポジトリがスコープ外なら、そのリポジトリだけ非表示にする。
		// (ユーザーが SCM ビューで手動で表示を切り替えた分は、次のフォルダ変更まで尊重する)
		// ISCMViewService は DI 注入時点で構築済み = 自身の onDidAddRepository リスナーの方が先に
		// 登録されているため、このハンドラ実行時には表示状態の初期化 (選択) が済んでいる
		this._register(this.scmService.onDidAddRepository(repository => {
			if (this.isEnabled() && !this.isInScope(repository)) {
				this.scmViewService.toggleVisibility(repository, false);
			}
		}));

		// フォルダ入れ替え (= スペース/worktree の切り替え) で全リポジトリを絞り直す
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.applyToAll()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ParadisScmRepoScope.SETTING_ID)) {
				if (this.isEnabled()) {
					this.applyToAll();
				} else {
					// 無効化されたら全リポジトリを表示に戻す
					this.scmViewService.visibleRepositories = [...this.scmService.repositories];
				}
			}
		}));

		this.applyToAll();
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(ParadisScmRepoScope.SETTING_ID) !== false;
	}

	/**
	 * 「リポジトリのルートがワークスペースフォルダ配下にある」か「ワークスペースフォルダが
	 * リポジトリ配下にある」(リポジトリ内のサブフォルダだけを開いている場合) をスコープ内とする。
	 * worktree の親リポジトリや切り替え前のスペースはどちらにも該当せず、非表示になる。
	 */
	private isInScope(repository: ISCMRepository): boolean {
		const root = repository.provider.rootUri;
		if (!root) {
			return true;
		}

		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			// 空ウィンドウでは絞り込まない
			return true;
		}

		const extUri = this.uriIdentityService.extUri;
		return folders.some(folder => extUri.isEqualOrParent(root, folder.uri) || extUri.isEqualOrParent(folder.uri, root));
	}

	private applyToAll(): void {
		if (!this.isEnabled()) {
			return;
		}
		this.scmViewService.visibleRepositories = [...this.scmService.repositories].filter(repository => this.isInScope(repository));
	}
}

registerWorkbenchContribution2(ParadisScmRepoScope.ID, ParadisScmRepoScope, WorkbenchPhase.AfterRestored);

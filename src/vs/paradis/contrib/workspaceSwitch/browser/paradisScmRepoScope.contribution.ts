/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../../workbench/contrib/scm/common/scm.js';

/**
 * ソース管理ビューのリポジトリを「現在のワークスペースフォルダに関係するもの」だけに絞る (機能1)。
 *
 * git 拡張は既定 (git.autoRepositoryDetection=true) で「見えているエディタのファイルが属する
 * リポジトリ」を自動で開く。さらに worktree を開いていると、その親リポジトリと兄弟 worktree は
 * 「ワークスペース内」と見なされて確認なしで開かれる (extensions/git/src/model.ts の
 * isRepositoryOutsideWorkspace が repository.worktrees を参照するため)。一度こうして開いた
 * リポジトリはフォルダ入れ替えでは閉じられず (close 対象は「削除されたフォルダのリポジトリ」のみ)、
 * スペースを切り替えるたびに SCM ビューへ蓄積していく。
 *
 * 2段構えで絞る:
 *  1. 即時: workbench 側の ISCMViewService.visibleRepositories で「変更」ビューの表示を絞る
 *     (同期・確実。ただし「リポジトリ」一覧セクションは開いている全リポジトリを表示するため残る)
 *  2. 遅延 (reconcile): スコープ外の git リポジトリを `git.close` で git 拡張ごと閉じ、
 *     「リポジトリ」一覧からも消す。Model.close は closedRepositories として永続記憶され
 *     「そのスペースへ戻ったとき自動再オープンされない」罠があるため、切り替えのたびに現在の
 *     ワークスペースフォルダを `git.openRepository` で明示的に開き直して記憶から復帰させる
 *     (openIfClosed=true で closedRepositories からも削除される)。コミットメッセージの下書きは
 *     paradisScmInputScope が onDidAddRepository で復元するため close/reopen を跨いで保持される。
 * `paradis.workspaceSwitch.scopeScmRepositories` (既定 true) で無効化できる。
 */
class ParadisScmRepoScope extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisScmRepoScope';

	private static readonly SETTING_ID = 'paradis.workspaceSwitch.scopeScmRepositories';

	/** 自身の非表示化・絞り込み操作が発火させる可視変更イベントへの再入を防ぐ。 */
	private _enforcing = false;

	/**
	 * リポジトリroot (比較キー) → git.close を実行した回数。
	 *
	 * スコープ判定 (isInScope の URI 比較) と git 拡張の root 解決 (realpath ベース) は、
	 * フォルダパスに symlink 等が含まれると食い違うことがある。その場合、reconcile の
	 * openRepository (openIfClosed=true, openIfParent=true で各種ガードをバイパスする) が
	 * 「スコープ外」と判定される親リポジトリを毎回開き直してしまい、close → open → close の
	 * 無限ループになる (実際に2秒周期のループが発生した)。同一 root への close 試行回数に
	 * 上限を設け、上限到達後は「開いたまま非表示」で妥協してループを遮断する。
	 * フォルダ入れ替え (= 本物のスペース切り替え) でリセットして再試行を許す。
	 */
	private readonly _closeAttempts = new Map<string, number>();
	private static readonly MAX_CLOSE_ATTEMPTS = 3;

	/**
	 * スコープ外リポジトリの close / 現フォルダの openRepository を git 拡張へ依頼する遅延実行。
	 * 切り替え直後は git 拡張自身がフォルダ変更を処理中のため、少し置いてから・連打は集約して行う。
	 */
	private readonly _reconcileScheduler = this._register(new RunOnceScheduler(() => { void this.reconcileOpenRepositories(); }, 2000));

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// 新しく登録されたリポジトリがスコープ外なら、そのリポジトリだけ即座に非表示にし、
		// 併せて close の reconcile を予約する (git 拡張が worktree の親などを後から開いた場合)。
		// ISCMViewService は DI 注入時点で構築済み = 自身の onDidAddRepository リスナーの方が先に
		// 登録されているため、このハンドラ実行時には表示状態の初期化 (選択) が済んでいる
		this._register(this.scmService.onDidAddRepository(repository => {
			if (this.isEnabled() && !this.isInScope(repository)) {
				this.hide([repository]);
				this._reconcileScheduler.schedule();
			}
		}));

		// upstream の SCMViewService には、絞り込みを覆して「スコープ外リポジトリを表示に戻す」経路が
		// 少なくとも2つある (scmViewService.ts):
		//  - onDidRemoveRepository: 可視リポジトリが 0 になると _repositories[0] を強制表示する。
		//    スペース切り替え直後は「新スペースのリポジトリがまだ開いておらず全て非表示」の瞬間があり、
		//    そこへ旧スペースのリポジトリの close が届くと、別スペースのリポジトリが表示されてしまう
		//  - onDidAddRepository の起動時分岐: 保存済み state (previousState) に無いリポジトリが来ると
		//    全リポジトリの selectionIndex を振り直して一括再表示する
		// どちらも個別に追うのではなく、「表示に追加された」イベントを監視してスコープ外なら隠すことで
		// 一律に打ち消す。この結果、ユーザーがスコープ外リポジトリを手動で表示する操作も維持されなく
		// なるが、全リポジトリを見たい場合は設定 (SETTING_ID) を無効にすればよい。
		// 自身の hide は removed のみのイベントで added は空のため、このハンドラが自身の操作へ
		// 再帰することはない (_enforcing は同期発火するセッターイベントへの保険)。
		this._register(this.scmViewService.onDidChangeVisibleRepositories(({ added }) => {
			if (this._enforcing || !this.isEnabled()) {
				return;
			}
			const outOfScope = [...added].filter(repository => !this.isInScope(repository));
			if (outOfScope.length > 0) {
				this.hide(outOfScope);
			}
		}));

		// フォルダ入れ替え (= スペース/worktree の切り替え) で全リポジトリを絞り直し、
		// スコープ外リポジトリの close と現フォルダの開き直しを予約する
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => {
			this._closeAttempts.clear();
			this.applyToAll();
			this._reconcileScheduler.schedule();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ParadisScmRepoScope.SETTING_ID)) {
				if (this.isEnabled()) {
					this._closeAttempts.clear();
					this.applyToAll();
					this._reconcileScheduler.schedule();
				} else {
					// 無効化されたら全リポジトリを表示に戻す
					this.scmViewService.visibleRepositories = [...this.scmService.repositories];
				}
			}
		}));

		this.applyToAll();
		this._reconcileScheduler.schedule();
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

	/** reconcile の直列化フラグ。実行中の再スケジュールは末尾で1回だけ追い掛け実行する。 */
	private _reconciling = false;
	private _reconcileAgain = false;

	/**
	 * スコープ外の git リポジトリを git 拡張ごと閉じ (「リポジトリ」一覧からも消える)、
	 * 現在のワークスペースフォルダのリポジトリを明示的に開き直す。
	 * 開き直しは「過去の close で closedRepositories に記憶され自動再オープンが抑止されている」
	 * 状態からの復帰のため、対象リポジトリが既に開いている場合も含め毎回行う (既に開いていれば
	 * git 拡張側で即 no-op)。git 拡張が未起動・無効の場合は静かに諦め、次の切り替えで再試行する。
	 */
	private async reconcileOpenRepositories(): Promise<void> {
		// await を跨いだ並行実行を防ぐ (並行すると close 済みリポジトリへ再度 git.close を投げ、
		// git 側の hint 解決失敗 → pickRepository フォールバックで誤 close やモーダルが起きうる)
		if (this._reconciling) {
			this._reconcileAgain = true;
			return;
		}
		this._reconciling = true;
		try {
			if (!this.isEnabled()) {
				return;
			}
			const folders = this.contextService.getWorkspace().folders;
			if (folders.length === 0) {
				return;
			}

			for (const repository of [...this.scmService.repositories]) {
				const root = repository.provider.rootUri;
				// close するのは git 拡張のリポジトリのみ (providerId は createSourceControl の第一引数 = 'git')。
				// 他の SCM プロバイダ (エージェントセッション等) には触れない。
				// ループ中の await でリポジトリ集合は変わりうるため、実行直前に「まだ開いているか」を
				// 再確認する (閉じたリポジトリの root を git.close に渡すと hint 解決に失敗し、
				// pickRepository フォールバックが別リポジトリを閉じたり QuickPick を出したりする)。
				if (root && repository.provider.providerId === 'git' && !this.isInScope(repository) && [...this.scmService.repositories].includes(repository)) {
					// ループ遮断: 同一 root を既に規定回数 close していたら、再オープンされ続けて
					// いる (スコープ判定と git の root 解決の食い違い) と見なし、以後は close せず
					// 「開いたまま非表示」に留める (_closeAttempts のコメント参照)
					const rootKey = this.uriIdentityService.extUri.getComparisonKey(root);
					const attempts = this._closeAttempts.get(rootKey) ?? 0;
					if (attempts >= ParadisScmRepoScope.MAX_CLOSE_ATTEMPTS) {
						if (attempts === ParadisScmRepoScope.MAX_CLOSE_ATTEMPTS) {
							this._closeAttempts.set(rootKey, attempts + 1);
							this.logService.info(`[ParadisScmRepoScope] repository keeps reopening after ${attempts} closes, giving up closing (kept hidden): ${root.toString()}`);
						}
						continue;
					}
					this._closeAttempts.set(rootKey, attempts + 1);
					try {
						this.logService.trace(`[ParadisScmRepoScope] closing out-of-scope repository: ${root.toString()}`);
						await this.commandService.executeCommand('git.close', root);
					} catch (error) {
						// git 拡張未起動・コマンド未登録などは次回の reconcile で再試行される
						this.logService.trace('[ParadisScmRepoScope] git.close failed', error);
					}
				}
			}

			for (const folder of folders) {
				// git.openRepository は falsy な path を渡すとフォルダ選択ダイアログを開いてしまうため、
				// ローカル (file) の実パスを持つフォルダのみ対象にする
				if (folder.uri.scheme !== Schemas.file || folder.uri.fsPath.length === 0) {
					continue;
				}
				try {
					await this.commandService.executeCommand('git.openRepository', folder.uri.fsPath);
				} catch (error) {
					// フォルダが git リポジトリでない場合も含め、失敗は無害 (git 拡張側で何も起きない)
					this.logService.trace('[ParadisScmRepoScope] git.openRepository failed', error);
				}
			}
		} finally {
			this._reconciling = false;
			if (this._reconcileAgain) {
				this._reconcileAgain = false;
				this._reconcileScheduler.schedule();
			}
		}
	}

	private hide(repositories: readonly ISCMRepository[]): void {
		this._enforcing = true;
		try {
			for (const repository of repositories) {
				this.scmViewService.toggleVisibility(repository, false);
			}
		} finally {
			this._enforcing = false;
		}
	}

	private applyToAll(): void {
		if (!this.isEnabled()) {
			return;
		}
		this._enforcing = true;
		try {
			this.scmViewService.visibleRepositories = [...this.scmService.repositories].filter(repository => this.isInScope(repository));
		} finally {
			this._enforcing = false;
		}
	}
}

registerWorkbenchContribution2(ParadisScmRepoScope.ID, ParadisScmRepoScope, WorkbenchPhase.AfterRestored);

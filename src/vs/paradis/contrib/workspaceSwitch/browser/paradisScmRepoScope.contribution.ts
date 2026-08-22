/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../../workbench/contrib/scm/common/scm.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_SCM_SCOPE_SETTING_ID, paradisIsScmRootInScope } from '../common/paradisScmScope.js';
import { paradisScopeRootPath } from '../common/paradisWorkspaceSwitch.js';

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
 * 絞り込みは2つのクラスで分担する:
 *  1. **このクラス**: workbench 側の ISCMViewService.visibleRepositories を操作して「変更」ビューの
 *     表示を絞る (同期・確実)
 *  2. `ParadisScopedScmViewService`: 「リポジトリ」一覧セクションが直接描画する `repositories`
 *     自体を絞る
 * 2 が入ったことで **スコープ外リポジトリを閉じる必要はなくなった**。
 *
 * かつてはここから `git.close` を投げて git 拡張ごと閉じていたが、これは以下の理由で撤去した
 * (2026-08-03)。upstream の `git.close` は `{ repository: true }` 付きで登録されているため、
 * 第一引数からリポジトリを解決できないと **確認なしで `model.pickRepository()` にフォールバック
 * する** (extensions/git/src/commands.ts の createCommand)。そのときの挙動は git 拡張側で開いて
 * いるリポジトリ数で変わり、どれも実害があった:
 *  - 0件: 「利用可能なリポジトリがありません」を throw → モーダルのエラーダイアログ
 *  - 1件: **確認なしでその1件を閉じる** (閉じてはいけないリポジトリでも閉じる)
 *  - 2件以上: 「Choose a repository」の QuickPick が唐突に出る
 * そして解決に失敗する状況は日常的に起きる。フォルダ入れ替え時、git 拡張は外れたフォルダの
 * リポジトリを `Model.close` ではなく `OpenRepository.dispose()` で直接破棄し (model.ts の
 * onDidChangeWorkspaceFolders)、その後わざわざ新しいフォルダを開き直す。この「dispose 済みで
 * まだ開き直せていない」窓の間、git 拡張の openRepositories は 0〜数件まで減る (dispose 対象は
 * 「外れたフォルダのリポジトリ」かつ「可視エディタで未使用」かつ「残るフォルダの配下でない」もの
 * だけなので、何件残るかは状況次第。ただし 0件・1件・2件以上のどれになっても上の3分岐のいずれかを
 * 踏む)。Windows では git のプロセス起動が遅く (実測でコマンド1本あたり数百ms〜1.7秒)、リポジトリを
 * 1つ開くのに何本も必要なため、この窓は秒単位で開く。一方 renderer 側の scmService.repositories には
 * dispose の伝播が届くまで古いリポジトリが残るので、「renderer には見えるが ext host にはもう無い」
 * 相手へ close を投げてしまう。renderer からは ext host の実態を確認する術がなく、遅延を伸ばしても
 * 塞ぎきれない。
 *
 * 撤去で失うものが2つあることは承知の上で選んでいる (どちらも「見えないところに残る」だけで、
 * ユーザー操作を遮るモーダルや無確認の誤 close より軽いと判断した):
 *  - `pickRepository` は git 拡張側の openRepositories を列挙するため、`git.commit` / `git.pull` /
 *    `git.push` / `git.sync` などをコマンドパレットから引数なしで実行すると、一覧では隠れている
 *    スコープ外リポジトリが選択候補に現れる。`Repository.isHidden` はコンストラクタで固定されるので
 *    renderer から後付けで隠すことはできない
 *  - 開いたままの Repository は再帰ファイルウォッチャー・DotGitWatcher・AutoFetcher を保持し続ける
 *    (repository.ts)。ワークスペースフォルダから外れたものは git 拡張自身が dispose するが、
 *    auto-detection で開かれた親リポジトリと兄弟 worktree は `removed` フォルダに紐づかないため
 *    残る。監視ハンドルが増える方向なので、多スペース運用では実機で確認する価値がある
 *
 *   → 2点目は 2026-08 に model.ts 側の PARA-PATCH で解消した。フォルダ入れ替え時に「どの
 *   フォルダにも紐づかない open repository」も park 対象になり (parking lot LRU 4件、超過分は
 *   dispose)、監視ハンドルは回収される。park 中は `openRepositories` から外れるため pickRepository
 *   候補にも出ない。1点目の picker 表示は park されたリポジトリでは自然に消え、フォルダイベントと
 *   editor イベントの間だけ残る (editor での自動再オープンは既定の autoRepositoryDetection 時)。
 *  - {@link ParadisScopedScmViewService} が絞るのは `ISCMViewService` 経由の参照だけなので、
 *    `ISCMService` を直接読む画面はスコープ外を見る (履歴/グラフビューの初期リポジトリ選択、
 *    検索の「変更されたファイルのみ」等)。アクティビティバーのバッジは `visibleRepositories`
 *    由来なので影響しない
 * いずれも close していた頃から実際には達成できていなかった (上記のとおり close はほとんど成立
 * していなかった) ため、新たな劣化ではなく「元から無かったことが確定した」に近い。
 *
 * 現在このクラスが reconcile で行うのは `git.openRepository` による開き直しだけ。これは過去の
 * `git.close` が closedRepositories として永続記憶した「そのスペースへ戻っても自動再オープン
 * されない」状態からの復帰用で、`{ repository: false }` 登録なので上記のフォールバックは踏まない。
 * ただしコマンド側が `model.openRepository(path, true, true)` と固定しており、第3引数の
 * `openIfParent` が親フォルダガードを丸ごと外す。つまり `git.openRepositoryInParentFolders`
 * (既定 `prompt`) の確認を飛ばして祖先リポジトリを黙って開く副作用があり、しかも祖先は
 * {@link paradisIsScmRootInScope} がスコープ内と判定するので一覧にも出る。コマンドがフラグを
 * 固定している以上、避けるにはこの開き直し自体を捨てるしかない。
 * `paradis.workspaceSwitch.scopeScmRepositories` (既定 true) で無効化できる。
 */
class ParadisScmRepoScope extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisScmRepoScope';

	private static readonly SETTING_ID = PARADIS_SCM_SCOPE_SETTING_ID;

	/** 自身の非表示化・絞り込み操作が発火させる可視変更イベントへの再入を防ぐ。 */
	private _enforcing = false;

	/**
	 * 現フォルダの openRepository を git 拡張へ依頼する遅延実行。
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
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) {
		super();

		// 新しく登録されたリポジトリがスコープ外なら、そのリポジトリだけ即座に非表示にする
		// (git 拡張が worktree の親などを後から開いた場合)。
		// ISCMViewService は DI 注入時点で構築済み = 自身の onDidAddRepository リスナーの方が先に
		// 登録されているため、このハンドラ実行時には表示状態の初期化 (選択) が済んでいる
		this._register(this.scmService.onDidAddRepository(repository => {
			if (this.isEnabled() && !this.isInScope(repository)) {
				this.hide([repository]);
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
		// なお ISCMViewService が ParadisScopedScmViewService に差し替わって以降、added はスコープ内に
		// 絞られて届くため、この打ち消しは通常到達しない。設定を無効にした状態 (= 絞り込みを外した状態)
		// でも表示制御だけは効かせるための保険として残している。
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
		// 現フォルダの開き直しを予約する
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => {
			this.applyToAll();
			this._reconcileScheduler.schedule();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ParadisScmRepoScope.SETTING_ID)) {
				if (this.isEnabled()) {
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

	/** 判定は {@link paradisIsScmRootInScope} と共有する ({@link ParadisScopedScmViewService} も同じ基準で一覧を絞る)。 */
	private isInScope(repository: ISCMRepository): boolean {
		const folders = this.contextService.getWorkspace().folders.map(folder => folder.uri);
		return paradisIsScmRootInScope(repository.provider.rootUri, folders, this.uriIdentityService.extUri);
	}

	/** reconcile の直列化フラグ。実行中の再スケジュールは末尾で1回だけ追い掛け実行する。 */
	private _reconciling = false;
	private _reconcileAgain = false;

	/**
	 * 現在のワークスペースフォルダのリポジトリを明示的に開き直す。
	 *
	 * 過去のバージョンがここでスコープ外リポジトリを `git.close` していた名残で、閉じられた記憶
	 * (closedRepositories) が残っている環境があり、そのままでは「そのスペースへ戻っても自動再
	 * オープンされない」。対象が既に開いている場合も含め毎回行う (既に開いていれば git 拡張側で
	 * 即 no-op)。git 拡張が未起動・無効の場合は静かに諦め、次の切り替えで再試行する。
	 *
	 * スコープ外リポジトリを閉じる処理はここには無い (クラスのコメント参照)。
	 */
	private async reconcileOpenRepositories(): Promise<void> {
		// await を跨いだ並行実行を防ぎ、重複した openRepository を投げないようにする
		// (git 拡張側の model.openRepository も @sequentialize されているため実害は無いが、
		// 無駄な git プロセスの起動を避ける)
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

			const connectedAuthority = this.remoteAgentService.getConnection()?.remoteAuthority;
			for (const folder of folders) {
				// git.openRepository は falsy な path を渡すとフォルダ選択ダイアログを開いてしまうため、
				// 実パスを持つフォルダのみ対象にする。git 拡張は workspace kind なので、SSH 接続中は
				// リモート側の extension host で実行される — そちらから見た絶対パス表記
				// (vscode-remote なら常に POSIX 表記の uri.path) を渡す必要がある。fsPath は
				// 呼び出し元 (常にローカル) の OS で区切りを付け替えるため、Windows から Linux の
				// 接続先へ渡すと区切りが化ける。別ホストの vscode-remote・未接続中の vscode-remote は
				// paradisScopeRootPath が弾く（手元へ流すと、絶対パスが一致する無関係な手元の
				// フォルダを誤って git.openRepository へ渡しかねない）。
				const path = paradisScopeRootPath(folder.uri, connectedAuthority);
				if (!path || path.length === 0) {
					continue;
				}
				try {
					await this.commandService.executeCommand('git.openRepository', path);
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

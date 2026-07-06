/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { combinedDisposable, Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/**
 * 内蔵ブラウザのタブをリポジトリ単位でスコープする (機能1 Phase 3)。
 *
 * - 新しいブラウザビューは出現時のアクティブリポジトリでタグ付けする
 * - リポジトリ切り替え中 (isSwitching) のエディタクローズによる BrowserEditorInput の
 *   dispose を veto する。input と model (main プロセスの WebContentsView) が生存する
 *   ため、切り替え先から戻って working set が同じ id を getOrCreateLazy すると
 *   生きている実体にそのまま再接続され、ページは**リロードされない**
 * - 切り替え開始時 (onWillSwitchScope) に生存中の全 WebContentsView を即座に隠す。
 *   WCV はワークスペース DOM ではなくウィンドウに重なるネイティブビューで、veto で
 *   生かしたままにする都合上、隠蔽は WebContentsViewRendererFeature の可視性追従
 *   (requestAnimationFrame 遅延 + main への非同期 IPC) だけに頼っている。updateFolders の
 *   再レイアウト中に旧ページが古い bounds のまま数フレーム残る (残像) のを防ぐため、
 *   レイアウトが変わる前にここで先回りして隠す
 * - ユーザーが自分でタブを閉じた場合 (isSwitching ではない) は veto せず通常どおり破棄
 * - contextual filter で、ブラウザタブの一覧系 UI を現リポジトリのタブに絞る
 * - リポジトリがリストから削除されたら、そのリポジトリの退避中タブを強制破棄して
 *   WebContentsView のリークを防ぐ
 *
 * 既知の制限: WebContentsView はウィンドウに紐づくため、ウィンドウリロードを跨ぐと
 * ページ自体は再ロードされる (URL は working set 経由で復元される)。
 */
class ParadisBrowserWorkspaceScope extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisBrowserWorkspaceScope';

	/** browser view id → 所属リポジトリID。untagged はスコープ外 (常に表示・veto 対象外) */
	private readonly _viewRepositories = new Map<string, string>();

	/** input ごとの veto / 破棄追跡リスナー (実 dispose 時に自動解放) */
	private readonly _inputListeners = this._register(new DisposableMap<string>());

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();

		this._register(Event.runAndSubscribe(this.browserViewWorkbenchService.onDidChangeBrowserViews, () => this.hookAndTagViews()));
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.cleanupRemovedRepositories()));

		// 切り替えでレイアウトが変わる前に、生存中のネイティブビューを先回りして隠す (残像対策)。
		this._register(this.workspaceSwitchService.onWillSwitchScope(() => this.hideAllBrowserViews()));

		// 切り替え完了で contextual filter の結果が変わったことを通知する
		const filterChanged = this._register(new Emitter<void>());
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => filterChanged.fire()));
		this._register(this.browserViewWorkbenchService.registerContextualFilter({
			include: input => this.isInActiveScope(input),
			onDidChange: filterChanged.event
		}));
	}

	/**
	 * 生存中の全ブラウザビューのネイティブ WebContentsView を隠す。切り替え完了後に
	 * 切り替え先の (可視化された) ブラウザエディタが WebContentsViewRendererFeature の
	 * 可視性追従で自身を再表示するため、ここで隠しても復帰する。model 未解決 (WCV 未生成)
	 * のビューは隠す対象が無いので何もしない。
	 */
	private hideAllBrowserViews(): void {
		for (const [, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (input.model?.visible) {
				void input.model.setVisible(false);
			}
		}
	}

	private isInActiveScope(input: BrowserEditorInput): boolean {
		const stateKey = this._viewRepositories.get(input.serialize().id);
		return stateKey === undefined || stateKey === this.workspaceSwitchService.activeStateKey;
	}

	private hookAndTagViews(): void {
		const activeStateKey = this.workspaceSwitchService.activeStateKey;

		for (const [id, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (!this._inputListeners.has(id)) {
				this._inputListeners.set(id, combinedDisposable(
					input.onBeforeDispose(e => {
						// 切り替えによるクローズだけ veto して WebContentsView を生かしたまま退避する
						if (this.workspaceSwitchService.isSwitching) {
							e.veto();
						}
					}),
					input.onWillDispose(() => {
						this._viewRepositories.delete(id);
						this._inputListeners.deleteAndDispose(id);
					})
				));
			}

			if (!this._viewRepositories.has(id) && activeStateKey !== undefined) {
				this._viewRepositories.set(id, activeStateKey);
			}
		}
	}

	private cleanupRemovedRepositories(): void {
		const repositoryIds = new Set(this.workspaceSwitchService.repositories.map(repository => repository.id));

		for (const [id, input] of [...this.browserViewWorkbenchService.getKnownBrowserViews()]) {
			const stateKey = this._viewRepositories.get(id);
			// worktree スコープ ('worktree:' プレフィックス) はリポジトリ削除の対象外
			// (worktree の増減は頻繁なので、ページはユーザーが閉じるまで生かしておく)
			if (stateKey !== undefined && !stateKey.startsWith('worktree:') && !repositoryIds.has(stateKey)) {
				this._viewRepositories.delete(id);
				input.dispose(true); // veto を通さず破棄
			}
		}
	}
}

registerWorkbenchContribution2(ParadisBrowserWorkspaceScope.ID, ParadisBrowserWorkspaceScope, WorkbenchPhase.AfterRestored);

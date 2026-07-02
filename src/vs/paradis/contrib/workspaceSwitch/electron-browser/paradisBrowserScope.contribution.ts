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

		// 切り替え完了で contextual filter の結果が変わったことを通知する
		const filterChanged = this._register(new Emitter<void>());
		this._register(this.workspaceSwitchService.onDidSwitchRepository(() => filterChanged.fire()));
		this._register(this.browserViewWorkbenchService.registerContextualFilter({
			include: input => this.isInActiveScope(input),
			onDidChange: filterChanged.event
		}));
	}

	private isInActiveScope(input: BrowserEditorInput): boolean {
		const repositoryId = this._viewRepositories.get(input.serialize().id);
		return repositoryId === undefined || repositoryId === this.workspaceSwitchService.activeRepository?.id;
	}

	private hookAndTagViews(): void {
		const activeRepository = this.workspaceSwitchService.activeRepository;

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

			if (!this._viewRepositories.has(id) && activeRepository) {
				this._viewRepositories.set(id, activeRepository.id);
			}
		}
	}

	private cleanupRemovedRepositories(): void {
		const repositoryIds = new Set(this.workspaceSwitchService.repositories.map(repository => repository.id));

		for (const [id, input] of [...this.browserViewWorkbenchService.getKnownBrowserViews()]) {
			const repositoryId = this._viewRepositories.get(id);
			if (repositoryId !== undefined && !repositoryIds.has(repositoryId)) {
				this._viewRepositories.delete(id);
				input.dispose(true); // veto を通さず破棄
			}
		}
	}
}

registerWorkbenchContribution2(ParadisBrowserWorkspaceScope.ID, ParadisBrowserWorkspaceScope, WorkbenchPhase.AfterRestored);

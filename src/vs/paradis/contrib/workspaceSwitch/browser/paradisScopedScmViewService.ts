/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { SCMViewService } from '../../../../workbench/contrib/scm/browser/scmViewService.js';
import { ISCMMenus, ISCMRepository, ISCMRepositorySelectionMode, ISCMRepositorySortKey, ISCMViewService, ISCMViewVisibleRepositoryChangeEvent } from '../../../../workbench/contrib/scm/common/scm.js';
import { PARADIS_SCM_SCOPE_SETTING_ID, paradisIsScmRootInScope } from '../common/paradisScmScope.js';

/**
 * 2つの集合の差分を {@link ISCMViewVisibleRepositoryChangeEvent} として返す。差分が無ければ
 * `undefined` を返し、呼び出し側がイベントの空撃ちを避けられるようにする。
 */
function paradisDiffRepositories(previous: ReadonlySet<ISCMRepository>, next: ReadonlySet<ISCMRepository>): ISCMViewVisibleRepositoryChangeEvent | undefined {
	const added = new Set<ISCMRepository>();
	const removed = new Set<ISCMRepository>();

	for (const repository of next) {
		if (!previous.has(repository)) {
			added.add(repository);
		}
	}
	for (const repository of previous) {
		if (!next.has(repository)) {
			removed.add(repository);
		}
	}

	if (added.size === 0 && removed.size === 0) {
		return undefined;
	}
	return { added, removed };
}

/**
 * ソース管理のリポジトリ一覧を「現在のワークスペースフォルダに関係するもの」だけに絞る (機能1)。
 *
 * `paradisScmRepoScope` は `visibleRepositories` を操作してスコープ外リポジトリを隠すが、これは
 * 「変更」ビューにしか効かない。「リポジトリ」一覧セクションは `ISCMViewService.repositories` を
 * そのまま描画するため、スコープ外のリポジトリが残り続ける。同 contribution はそれを `git.close`
 * で閉じて消そうとするが、他の拡張 (GitHub Pull Requests 等) がリポジトリを掴んだままだと即座に
 * 開き直され、close ↔ open のループを避けるための試行上限に達したあとは「開いたまま非表示」に
 * 妥協するしかなく、結果として切り替え前のスペースのリポジトリが一覧に残っていた。
 *
 * そこで「閉じる」ことに頼らず、ビューへ見せる一覧そのものを絞る。`repositories` を参照するのは
 * リポジトリ一覧・リポジトリピッカー・バッジなど、いずれもスコープ外を出す理由が無い箇所なので、
 * サービス境界で一度だけ絞るのが最も影響範囲が小さい。
 *
 * upstream の {@link SCMViewService} は置き換えずに内包し、絞り込み以外は素通しする。フォルダの
 * 入れ替えでは upstream 側のイベントが発火しない (リポジトリの開閉が起きないため) ので、
 * ワークスペースフォルダの変更を自分で監視して差分イベントを流し、ビューを追従させる。
 *
 * `paradis.workspaceSwitch.scopeScmRepositories` (既定 true) で無効化できる。
 */
export class ParadisScopedScmViewService extends Disposable implements ISCMViewService {

	declare readonly _serviceBrand: undefined;

	private readonly _inner: SCMViewService;

	/** 直近に外へ見せた集合。フォルダ入れ替えでの差分イベント生成に使う。 */
	private _lastRepositories: ReadonlySet<ISCMRepository>;
	private _lastVisibleRepositories: ReadonlySet<ISCMRepository>;

	private readonly _onDidChangeRepositories = this._register(new Emitter<ISCMViewVisibleRepositoryChangeEvent>());
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	private readonly _onDidChangeVisibleRepositories = this._register(new Emitter<ISCMViewVisibleRepositoryChangeEvent>());
	readonly onDidChangeVisibleRepositories = this._onDidChangeVisibleRepositories.event;

	/**
	 * `focusedRepository` がスコープ外を返さないのに合わせ、通知側でもスコープ外は落とす。
	 * `Event.filter` は読むたびに内部 Emitter を作るため、getter ではなく一度だけ組んで持つ
	 * (upstream の `ISCMViewService` も安定したフィールドとして宣言している)。
	 */
	readonly onDidFocusRepository: Event<ISCMRepository | undefined>;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._inner = this._register(instantiationService.createInstance(SCMViewService));
		this.onDidFocusRepository = Event.filter(this._inner.onDidFocusRepository, repository => !repository || this._isInScope(repository), this._store);
		this._lastRepositories = new Set(this.repositories);
		this._lastVisibleRepositories = new Set(this.visibleRepositories);

		// upstream 由来のイベントは、差分が空でもそのまま前へ流す。upstream は空ペイロードを
		// 「集合は同じだが読み直してほしい」の合図として使っており (並べ替え: SCMViewService の
		// toggleSortKey)、握り潰すと並べ替えが一覧に反映されない。また visible 側は upstream で
		// デバウンス合流済みのため、素通しすることで起動時の連続追加のまとまりも保てる。
		this._register(this._inner.onDidChangeRepositories(e => {
			this._syncBaselines();
			this._onDidChangeRepositories.fire(this._scopeEvent(e));
		}));
		this._register(this._inner.onDidChangeVisibleRepositories(e => {
			this._syncBaselines();
			this._onDidChangeVisibleRepositories.fire(this._scopeEvent(e));
		}));
		// フォルダ入れ替え (= スペース/worktree の切り替え) はリポジトリの開閉を伴わないことがあり、
		// その場合 upstream 側は何も通知しない。スコープの変化はここでしか拾えない。
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._refreshScope()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_SCM_SCOPE_SETTING_ID)) {
				this._refreshScope();
			}
		}));
	}

	/**
	 * 差分計算の基準を現在値に揃える。リポジトリの増減は可視集合も同時に変えるが、upstream の可視
	 * イベントはデバウンス越しに遅れて届くため、片方だけ更新すると隙間に入ったフォルダ変更で
	 * `_refreshScope()` が既に流れる予定の差分を先出ししてしまう。両方まとめて更新して防ぐ。
	 */
	private _syncBaselines(): void {
		this._lastRepositories = new Set(this.repositories);
		this._lastVisibleRepositories = new Set(this.visibleRepositories);
	}

	/**
	 * upstream のイベントを外へ流す際、`added` からスコープ外を落とす。`removed` は落とさない
	 * (既に消えたリポジトリの後始末を購読側が取りこぼさないようにするため)。
	 */
	private _scopeEvent(e: ISCMViewVisibleRepositoryChangeEvent): ISCMViewVisibleRepositoryChangeEvent {
		if (!this._isEnabled()) {
			return e;
		}
		return { added: [...e.added].filter(repository => this._isInScope(repository)), removed: e.removed };
	}

	private _isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_SCM_SCOPE_SETTING_ID) !== false;
	}

	private _isInScope(repository: ISCMRepository): boolean {
		if (!this._isEnabled()) {
			return true;
		}
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		return paradisIsScmRootInScope(repository.provider.rootUri, folders, this.uriIdentityService.extUri);
	}

	private _filter(repositories: readonly ISCMRepository[]): ISCMRepository[] {
		if (!this._isEnabled()) {
			return [...repositories];
		}
		// getter は描画のたびに読まれるため、設定とフォルダの解決はリポジトリ1件ごとではなく1回だけ行う。
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		const extUri = this.uriIdentityService.extUri;
		return repositories.filter(repository => paradisIsScmRootInScope(repository.provider.rootUri, folders, extUri));
	}

	/**
	 * スコープ自体が変わったとき (フォルダ入れ替え・設定変更) に、絞り込み後の集合を取り直して
	 * 変化した分だけイベントを流す。upstream 由来の変化はコンストラクタ側で素通ししている。
	 */
	private _refreshScope(): void {
		const repositories = new Set(this.repositories);
		const repositoriesChange = paradisDiffRepositories(this._lastRepositories, repositories);
		this._lastRepositories = repositories;
		if (repositoriesChange) {
			this._onDidChangeRepositories.fire(repositoriesChange);
		}

		// 可視集合は上のリスナーが同期的に書き換えることがあるため、fire の後に取り直す。
		const visibleRepositories = new Set(this.visibleRepositories);
		const visibleChange = paradisDiffRepositories(this._lastVisibleRepositories, visibleRepositories);
		this._lastVisibleRepositories = visibleRepositories;
		if (visibleChange) {
			this._onDidChangeVisibleRepositories.fire(visibleChange);
		}
	}

	get repositories(): ISCMRepository[] {
		return this._filter(this._inner.repositories);
	}

	get visibleRepositories(): readonly ISCMRepository[] {
		return this._filter(this._inner.visibleRepositories);
	}

	set visibleRepositories(repositories: readonly ISCMRepository[]) {
		this._inner.visibleRepositories = [...repositories];
	}

	isVisible(repository: ISCMRepository): boolean {
		return this._isInScope(repository) && this._inner.isVisible(repository);
	}

	get focusedRepository(): ISCMRepository | undefined {
		const focused = this._inner.focusedRepository;
		return focused && this._isInScope(focused) ? focused : undefined;
	}

	// 以下は絞り込みに関係しないため素通しする。

	get menus(): ISCMMenus { return this._inner.menus; }
	get selectionModeConfig(): IObservable<ISCMRepositorySelectionMode> { return this._inner.selectionModeConfig; }
	get explorerEnabledConfig(): IObservable<boolean> { return this._inner.explorerEnabledConfig; }
	get graphShowIncomingChangesConfig(): IObservable<boolean> { return this._inner.graphShowIncomingChangesConfig; }
	get graphShowOutgoingChangesConfig(): IObservable<boolean> { return this._inner.graphShowOutgoingChangesConfig; }
	get didFinishLoadingRepositories(): IObservable<boolean> { return this._inner.didFinishLoadingRepositories; }
	get activeRepository(): IObservable<{ repository: ISCMRepository; pinned: boolean } | undefined> { return this._inner.activeRepository; }

	toggleVisibility(repository: ISCMRepository, visible?: boolean): void {
		this._inner.toggleVisibility(repository, visible);
	}

	toggleSortKey(sortKey: ISCMRepositorySortKey): void {
		this._inner.toggleSortKey(sortKey);
	}

	toggleSelectionMode(selectionMode: ISCMRepositorySelectionMode): void {
		this._inner.toggleSelectionMode(selectionMode);
	}

	focus(repository: ISCMRepository): void {
		this._inner.focus(repository);
	}

	pinActiveRepository(repository: ISCMRepository | undefined): void {
		this._inner.pinActiveRepository(repository);
	}
}

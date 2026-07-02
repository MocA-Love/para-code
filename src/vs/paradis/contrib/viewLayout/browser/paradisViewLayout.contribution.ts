/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../../workbench/common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** 配置の指定方法。'left' = 左サイドバー / 'right' = 右セカンダリサイドバー / 'hidden' = 指定ビューを非表示。 */
type ParadisViewPlacement = 'left' | 'right' | 'hidden';

interface IParadisContainerPlacement {
	readonly containerId: string;
	readonly placement: ParadisViewPlacement;
	/** 'hidden' 指定時に非表示にするビューID。独自コンテナは全ビュー、標準コンテナ（scm/explorer）は差し込みビューだけを列挙する。 */
	readonly viewIds?: readonly string[];
}

/**
 * Para Code の既定ビュー配置。初回起動時に一度だけ適用し、以後はユーザーの操作を尊重する。
 * mock で決定した配置指定に対応。存在しないコンテナ/ビューは黙ってスキップする。
 */
const DEFAULT_PLACEMENTS: readonly IParadisContainerPlacement[] = [
	// GitLens: すべて非表示
	{ containerId: 'gitlens', placement: 'hidden', viewIds: ['gitlens.views.welcome', 'gitlens.views.home', 'gitlens.views.launchpad', 'gitlens.views.drafts', 'gitlens.views.workspaces'] },
	{ containerId: 'gitlensInspect', placement: 'hidden', viewIds: ['gitlens.views.commitDetails', 'gitlens.views.pullRequest', 'gitlens.views.lineHistory', 'gitlens.views.fileHistory', 'gitlens.views.timeline', 'gitlens.views.searchAndCompare'] },
	{ containerId: 'gitlensPatch', placement: 'hidden', viewIds: ['gitlens.views.patchDetails'] },
	{ containerId: 'gitlensPanel', placement: 'hidden', viewIds: ['gitlens.views.graph'] },
	{ containerId: 'workbench.view.scm', placement: 'hidden', viewIds: ['gitlens.views.repositories', 'gitlens.views.commits', 'gitlens.views.branches', 'gitlens.views.remotes', 'gitlens.views.stashes', 'gitlens.views.tags', 'gitlens.views.worktrees', 'gitlens.views.contributors', 'gitlens.views.scm.grouped'] },
	// GitHub PR / Actions: 右へ
	{ containerId: 'github-pull-requests', placement: 'right' },
	{ containerId: 'github-pull-request', placement: 'right' },
	{ containerId: 'github-actions', placement: 'right' },
	// Claude Code: チャット本体は右のまま、左のフォールバック版とセッション一覧は非表示
	{ containerId: 'claude-sidebar', placement: 'hidden', viewIds: ['claudeVSCodeSidebar'] },
	{ containerId: 'claude-sessions-sidebar', placement: 'hidden', viewIds: ['claudeVSCodeSessionsList'] },
	{ containerId: 'claude-sidebar-secondary', placement: 'right' },
	// Codex(ChatGPT): 同上
	{ containerId: 'codexViewContainer', placement: 'hidden', viewIds: ['chatgpt.sidebarView'] },
	{ containerId: 'codexSecondaryViewContainer', placement: 'right' },
	// Houston: エクスプローラー内の挨拶ビューを非表示
	{ containerId: 'workbench.view.explorer', placement: 'hidden', viewIds: ['houston.hello'] }
];

// 移動系（left/right）はコンテナ単位、非表示系はビュー単位で「適用済み」を記録する。
// 拡張のアクティベーションでコンテナやビューが遅れて登録されるため、両者を別々に追跡し、
// 取りこぼした分は未適用のまま残して次回起動で再試行する（全体フラグを立てない）。
const APPLIED_CONTAINERS_KEY = 'paradis.viewLayout.appliedContainerIds';
const APPLIED_VIEWS_KEY = 'paradis.viewLayout.appliedViewIds';
// この起動で遅れて登録されるコンテナ/ビューを拾うための購読時間。ここで拾えなかった分は次回起動で再試行される。
const WATCH_DURATION_MS = 90_000;

/**
 * 初回起動時に既定のビュー配置（左右移動・非表示）を適用する contribution。
 * ビュー系サービスは browser レイヤーで解決できるため web/desktop 共通で登録する。
 */
class ParadisViewLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisViewLayout';

	private readonly appliedContainers: Set<string>;
	private readonly appliedViews: Set<string>;
	/** 未処理のコンテナ移動: containerId -> 目的ロケーション */
	private readonly pendingMoves = new Map<string, ViewContainerLocation>();
	/** 未処理の非表示ビューID */
	private readonly pendingHides = new Set<string>();

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.appliedContainers = this.readSet(APPLIED_CONTAINERS_KEY);
		this.appliedViews = this.readSet(APPLIED_VIEWS_KEY);

		for (const p of DEFAULT_PLACEMENTS) {
			if (p.placement === 'hidden') {
				for (const viewId of p.viewIds ?? []) {
					if (!this.appliedViews.has(viewId)) {
						this.pendingHides.add(viewId);
					}
				}
			} else if (!this.appliedContainers.has(p.containerId)) {
				this.pendingMoves.set(p.containerId, p.placement === 'left' ? ViewContainerLocation.Sidebar : ViewContainerLocation.AuxiliaryBar);
			}
		}

		if (this.pendingMoves.size === 0 && this.pendingHides.size === 0) {
			return; // 全て適用済み。以後はユーザーの配置を尊重する
		}

		// 起動時点で既に登録済みのコンテナ/ビューをまず処理（storage書き込みは最後に1回だけ）
		for (const [containerId, location] of [...this.pendingMoves]) {
			const container = this.viewDescriptorService.getViewContainerById(containerId);
			if (container) {
				this.moveContainer(container, location);
				this.pendingMoves.delete(containerId);
				this.appliedContainers.add(containerId);
			}
		}
		for (const viewId of [...this.pendingHides]) {
			if (this.tryHideView(viewId)) {
				this.pendingHides.delete(viewId);
				this.appliedViews.add(viewId);
			}
		}
		this.flush();

		if (this.pendingMoves.size === 0 && this.pendingHides.size === 0) {
			return;
		}

		// 遅れて登場するコンテナ/ビューを一定期間だけ購読する。
		const watchStore = this._register(new DisposableStore());

		// コンテナの増減 → 未処理の移動を適用
		watchStore.add(this.viewDescriptorService.onDidChangeViewContainers(({ added }) => {
			let changed = false;
			for (const { container } of added) {
				const location = this.pendingMoves.get(container.id);
				if (location !== undefined) {
					this.moveContainer(container, location);
					this.pendingMoves.delete(container.id);
					this.appliedContainers.add(container.id);
					changed = true;
				}
			}
			if (changed) {
				this.flush();
				this.disposeIfDone(watchStore);
			}
		}));

		// 既存コンテナへのビュー追加は onDidChangeViewContainers では発火しないため、
		// ビュー登録イベント（グローバル）を購読して未処理の非表示を適用する。
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		watchStore.add(viewsRegistry.onViewsRegistered(groups => {
			let changed = false;
			for (const { views } of groups) {
				for (const view of views) {
					if (this.pendingHides.has(view.id) && this.tryHideView(view.id)) {
						this.pendingHides.delete(view.id);
						this.appliedViews.add(view.id);
						changed = true;
					}
				}
			}
			if (changed) {
				this.flush();
				this.disposeIfDone(watchStore);
			}
		}));

		const timer = setTimeout(() => watchStore.dispose(), WATCH_DURATION_MS);
		this._register({ dispose: () => clearTimeout(timer) });
	}

	private readSet(key: string): Set<string> {
		try {
			return new Set<string>(JSON.parse(this.storageService.get(key, StorageScope.APPLICATION, '[]')));
		} catch {
			return new Set<string>();
		}
	}

	private flush(): void {
		this.storageService.store(APPLIED_CONTAINERS_KEY, JSON.stringify([...this.appliedContainers]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(APPLIED_VIEWS_KEY, JSON.stringify([...this.appliedViews]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private disposeIfDone(watchStore: DisposableStore): void {
		if (this.pendingMoves.size === 0 && this.pendingHides.size === 0) {
			watchStore.dispose();
		}
	}

	private moveContainer(container: ViewContainer, location: ViewContainerLocation): void {
		try {
			if (this.viewDescriptorService.getViewContainerLocation(container) !== location) {
				this.viewDescriptorService.moveViewContainerToLocation(container, location, undefined, 'paradisDefaultViewLayout');
			}
		} catch {
			// 移動不可のコンテナは黙ってスキップ（fork の既定配置は best-effort）
		}
	}

	/**
	 * 指定ビューを非表示にする。ビューがまだ登録されていない・非表示にできない場合は false を返し、
	 * 呼び出し側は未処理のまま残す（後続のビュー登録イベントで再試行される）。
	 */
	private tryHideView(viewId: string): boolean {
		const container = this.viewDescriptorService.getViewContainerByViewId(viewId);
		if (!container) {
			return false;
		}
		const model = this.viewDescriptorService.getViewContainerModel(container);
		if (!model.allViewDescriptors.some(v => v.id === viewId)) {
			return false;
		}
		try {
			if (model.isVisible(viewId)) {
				model.setVisible(viewId, false);
			}
		} catch {
			// 非表示にできないビューはスキップ扱い（下の判定で false を返し次回再試行に委ねる）
		}
		return !model.isVisible(viewId);
	}
}

registerWorkbenchContribution2(ParadisViewLayoutContribution.ID, ParadisViewLayoutContribution, WorkbenchPhase.AfterRestored);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** 配置の指定方法。'left' = 左サイドバー / 'right' = 右セカンダリサイドバー / 'hidden' = コンテナ内全ビューを非表示。 */
type ParadisViewPlacement = 'left' | 'right' | 'hidden';

interface IParadisContainerPlacement {
	readonly containerId: string;
	readonly placement: ParadisViewPlacement;
	/** 'hidden' 指定時、非表示にするビューID。標準コンテナ（scm/explorer 等）への差し込みビューはこれを使って個別に隠す。 */
	readonly viewIds?: readonly string[];
}

/**
 * Para Code の既定ビュー配置。初回起動時に一度だけ適用し、以後はユーザーの操作を尊重する。
 * mock で決定した配置指定に対応。Claude/Codex のように環境で排他表示されるコンテナは、
 * 実在するものだけ適用される（存在しないIDは黙ってスキップ）。
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

// コンテナ単位で「既定配置を適用済み」を記録するストレージキー。
// 全体フラグではなくコンテナ個別に記録するのが要点: 自動インストールが重く（例: IntelliCode 68MB）
// 今回の起動で登場しなかった拡張のコンテナは「未適用」のまま残り、次回起動時に改めて配置される。
// これにより購読の打ち切り時間を短く保っても取りこぼしが起きない。
const APPLIED_IDS_STORAGE_KEY = 'paradis.viewLayout.appliedContainerIds';
// この起動で遅れて登録されるコンテナ（拡張アクティベーション直後の分）を拾うための購読時間。
// ここで拾えなかった分は未適用のまま残り次回起動で再試行されるため、短めでも安全。
const WATCH_DURATION_MS = 90_000;

/**
 * 初回起動時に既定のビュー配置（左右移動・非表示）を適用する contribution。
 * ビュー系サービスは browser レイヤーで解決できるため web/desktop 共通で登録する。
 */
class ParadisViewLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisViewLayout';

	private readonly pending = new Map<string, IParadisContainerPlacement>();
	private readonly appliedIds: Set<string>;

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.appliedIds = this.readAppliedIds();

		// まだ適用していないコンテナだけを対象にする
		for (const p of DEFAULT_PLACEMENTS) {
			if (!this.appliedIds.has(p.containerId)) {
				this.pending.set(p.containerId, p);
			}
		}

		if (this.pending.size === 0) {
			return; // 全て適用済み。以後はユーザーの配置を尊重する
		}

		// 既に登録済みのコンテナをまず処理
		for (const p of [...this.pending.values()]) {
			const container = this.viewDescriptorService.getViewContainerById(p.containerId);
			if (container) {
				this.applyPlacement(container, p);
				this.pending.delete(p.containerId);
			}
		}

		if (this.pending.size === 0) {
			return;
		}

		// 遅れて登録されるコンテナ（拡張アクティベーション後）を一定期間だけ待つ。
		// 期限内に登場しなかったコンテナは未適用のまま残し、次回起動で再試行する。
		const watchStore = this._register(new DisposableStore());
		watchStore.add(this.viewDescriptorService.onDidChangeViewContainers(({ added }) => {
			for (const { container } of added) {
				const p = this.pending.get(container.id);
				if (p) {
					this.applyPlacement(container, p);
					this.pending.delete(container.id);
				}
			}
			if (this.pending.size === 0) {
				watchStore.dispose();
			}
		}));

		const timer = setTimeout(() => watchStore.dispose(), WATCH_DURATION_MS);
		this._register({ dispose: () => clearTimeout(timer) });
	}

	private readAppliedIds(): Set<string> {
		try {
			return new Set<string>(JSON.parse(this.storageService.get(APPLIED_IDS_STORAGE_KEY, StorageScope.APPLICATION, '[]')));
		} catch {
			return new Set<string>();
		}
	}

	private markContainerApplied(containerId: string): void {
		this.appliedIds.add(containerId);
		this.storageService.store(APPLIED_IDS_STORAGE_KEY, JSON.stringify([...this.appliedIds]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private applyPlacement(container: ViewContainer, placement: IParadisContainerPlacement): void {
		try {
			if (placement.placement === 'hidden') {
				const model = this.viewDescriptorService.getViewContainerModel(container);
				const targetIds = placement.viewIds ?? model.allViewDescriptors.map(v => v.id);
				for (const id of targetIds) {
					if (model.isVisible(id)) {
						model.setVisible(id, false);
					}
				}
			} else {
				const location = placement.placement === 'left' ? ViewContainerLocation.Sidebar : ViewContainerLocation.AuxiliaryBar;
				if (this.viewDescriptorService.getViewContainerLocation(container) !== location) {
					this.viewDescriptorService.moveViewContainerToLocation(container, location, undefined, 'paradisDefaultViewLayout');
				}
			}
		} catch {
			// 移動不可・非表示不可のコンテナは黙ってスキップ（fork の既定配置は best-effort）
		}

		// 適用を試みたコンテナは（best-effort の成否によらず）記録し、次回起動で再処理しない
		this.markContainerApplied(container.id);
	}
}

registerWorkbenchContribution2(ParadisViewLayoutContribution.ID, ParadisViewLayoutContribution, WorkbenchPhase.AfterRestored);

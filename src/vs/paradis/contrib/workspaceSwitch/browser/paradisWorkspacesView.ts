/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisWorkspaceSwitch.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, PARADIS_WORKSPACE_COLORS, paradisWorkspaceColorHex, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisDiffStat } from '../common/paradisWorktreeCreate.js';

/** browser 層は electron-browser 層のコマンドIDを直接 import できないため、既存の
 * createWorktree/removeWorktree コマンドと同様に ID 文字列を直書きする (web ビルドでは
 * 未登録 = executeCommand が undefined を返すだけで安全に無効化される)。 */
const GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
/** diff 統計のポーリング間隔。編集の即時反映より、常時ポーリングによる負荷を避けることを優先する。 */
const DIFF_STATS_POLL_INTERVAL_MS = 10_000;

export const PARADIS_WORKSPACES_VIEW_ID = 'workbench.view.paradisWorkspaces.repositories';

type WorkspaceTreeElement = IParadisWorkspaceRepository | IParadisWorktree;

function isWorktree(element: WorkspaceTreeElement): element is IParadisWorktree {
	return (element as IParadisWorktree).repositoryId !== undefined;
}

/** パレットIDの表示名 (Superset の12色) */
function colorLabel(colorId: string): string {
	switch (colorId) {
		case 'red': return localize('paradis.color.red', "Red");
		case 'orange': return localize('paradis.color.orange', "Orange");
		case 'yellow': return localize('paradis.color.yellow', "Yellow");
		case 'lime': return localize('paradis.color.lime', "Lime");
		case 'green': return localize('paradis.color.green', "Green");
		case 'teal': return localize('paradis.color.teal', "Teal");
		case 'cyan': return localize('paradis.color.cyan', "Cyan");
		case 'blue': return localize('paradis.color.blue', "Blue");
		case 'indigo': return localize('paradis.color.indigo', "Indigo");
		case 'purple': return localize('paradis.color.purple', "Purple");
		case 'pink': return localize('paradis.color.pink', "Pink");
		case 'slate': return localize('paradis.color.slate', "Slate");
		default: return colorId;
	}
}

/** リポジトリ本体 (main checkout) を表す合成 worktree 行の表示名。 */
const STR_MAIN_CHECKOUT_NAME = localize('paradis.workspaceSwitch.mainCheckoutName', "local");

/** worktree の状態キー。main checkout の合成行は repositoryId をそのまま状態キーとして使う。 */
function worktreeStateKeyFor(worktree: IParadisWorktree): string {
	return worktree.isMainCheckout ? worktree.repositoryId : paradisWorktreeStateKey(worktree.uri);
}

/** OSごとの「Finder/Explorerで表示」ラベル (upstream の revealFileInOS と同じ出し分け) */
function revealLabel(): string {
	return isWindows
		? localize('paradis.workspaceSwitch.revealWindows', "Reveal in File Explorer")
		: isMacintosh
			? localize('paradis.workspaceSwitch.revealMac', "Reveal in Finder")
			: localize('paradis.workspaceSwitch.revealLinux', "Open Containing Folder");
}

/**
 * エージェント実行状態に応じたアイコンを適用する (Superset の WorkspaceIcon 相当)。
 * working = スピナー / permission = 赤の脈動ドット / review = 緑ドット / なし = 通常アイコン
 */
function applyStatusIcon(iconElement: HTMLElement, status: ParadisAgentStatus | undefined, fallback: ThemeIcon): void {
	const icon = status === 'working' ? Codicon.loading
		: status === 'permission' || status === 'question' || status === 'review' ? Codicon.circleFilled
			: fallback;
	iconElement.className = `codicon ${ThemeIcon.asClassName(icon).replace('codicon ', '')}`;
	if (status === 'working') {
		iconElement.classList.add('codicon-modifier-spin', 'paradis-status-working');
	} else if (status === 'permission' || status === 'question') {
		// 質問(AskUserQuestion)も許可要求と同じ「人間の対応が必要」= 赤の脈動表示
		iconElement.classList.add('paradis-status-permission');
	} else if (status === 'review') {
		iconElement.classList.add('paradis-status-review');
	}
}

interface IRepositoryTemplateData {
	readonly row: HTMLElement;
	readonly name: HTMLElement;
	readonly count: HTMLElement;
	readonly actionBar: ActionBar;
}

interface IWorktreeTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly branch: HTMLElement;
	readonly diff: HTMLElement;
	readonly diffAdded: HTMLElement;
	readonly diffRemoved: HTMLElement;
}

class WorkspaceTreeDelegate implements IListVirtualDelegate<WorkspaceTreeElement> {
	getHeight(element: WorkspaceTreeElement): number {
		// リポジトリ行は純粋なグルーピング見出し (main checkout も worktree 行として
		// 子要素に含まれる)。worktree 行は名前の下にブランチ名を重ねる2段表示のため高くする
		return isWorktree(element) ? 44 : 30;
	}

	getTemplateId(element: WorkspaceTreeElement): string {
		return isWorktree(element) ? WorktreeRenderer.TEMPLATE_ID : RepositoryRenderer.TEMPLATE_ID;
	}
}

/**
 * リポジトリ行は「グループ見出し」専用 (Superset と異なり、main checkout もリスト内の1行として
 * WorktreeRenderer 側に混ぜ込むため)。クリックでの切り替えは行わず、展開/折りたたみと
 * 件数バッジ・ホバー時の「新規worktree作成」ボタンのみを持つ。
 */
class RepositoryRenderer implements ITreeRenderer<IParadisWorkspaceRepository, FuzzyScore, IRepositoryTemplateData> {

	static readonly TEMPLATE_ID = 'paradisRepository';
	readonly templateId = RepositoryRenderer.TEMPLATE_ID;

	constructor(
		private readonly onCreateWorktree: (repository: IParadisWorkspaceRepository) => void,
	) { }

	renderTemplate(container: HTMLElement): IRepositoryTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-workspace-row'));
		const name = DOM.append(row, DOM.$('.paradis-workspace-name'));
		const count = DOM.append(row, DOM.$('.paradis-workspace-count'));
		const actionsContainer = DOM.append(row, DOM.$('.paradis-workspace-actions'));
		const actionBar = new ActionBar(actionsContainer);
		return { row, name, count, actionBar };
	}

	renderElement(node: ITreeNode<IParadisWorkspaceRepository, FuzzyScore>, _index: number, templateData: IRepositoryTemplateData): void {
		const repository = node.element;
		templateData.name.textContent = repository.name;
		templateData.count.textContent = String(node.children.length);

		// Superset と同じ固定パレットの色を行左端の色バーに反映する。
		// 色バーは chevron より左に置くため .monaco-tl-row の ::before で描画し、
		// 色はカスタムプロパティで渡す (media/paradisWorkspaceSwitch.css 参照)。
		// worktree 行 (WorktreeRenderer) 側にも同じ色を継続させ、リポジトリ内で
		// 色の帯が途切れないようにする (getRepositoryColorHex 経由)
		const colorHex = paradisWorkspaceColorHex(repository.color);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');

		templateData.actionBar.clear();
		templateData.actionBar.push(new Action(
			'paradis.workspaceSwitch.createWorktreeInline',
			localize('paradis.workspaceSwitch.createWorktreeContext', "New Worktree Space..."),
			ThemeIcon.asClassName(Codicon.add),
			true,
			() => this.onCreateWorktree(repository)
		), { icon: true, label: false });
	}

	disposeTemplate(templateData: IRepositoryTemplateData): void {
		templateData.actionBar.dispose();
	}
}

class WorktreeRenderer implements ITreeRenderer<IParadisWorktree, FuzzyScore, IWorktreeTemplateData> {

	static readonly TEMPLATE_ID = 'paradisWorktree';
	readonly templateId = WorktreeRenderer.TEMPLATE_ID;

	constructor(
		private readonly isActive: (worktree: IParadisWorktree) => boolean,
		private readonly getStatus: (stateKey: string) => ParadisAgentStatus | undefined,
		private readonly getDiffStat: (worktree: IParadisWorktree) => IParadisDiffStat | undefined,
		private readonly getRepositoryColorHex: (repositoryId: string) => string | undefined,
	) { }

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-worktree-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		// 名前の下にブランチ名を重ねる2段表示 (リポジトリ行が見出し化される前の従来スタイルを踏襲)
		const labels = DOM.append(row, DOM.$('.paradis-worktree-labels'));
		const name = DOM.append(labels, DOM.$('.paradis-worktree-name'));
		const branch = DOM.append(labels, DOM.$('.paradis-worktree-branch'));
		const diff = DOM.append(row, DOM.$('.paradis-worktree-diff'));
		const diffAdded = DOM.append(diff, DOM.$('span.paradis-worktree-diff-added'));
		const diffRemoved = DOM.append(diff, DOM.$('span.paradis-worktree-diff-removed'));
		return { row, icon, name, branch, diff, diffAdded, diffRemoved };
	}

	renderElement(node: ITreeNode<IParadisWorktree, FuzzyScore>, _index: number, templateData: IWorktreeTemplateData): void {
		const worktree = node.element;
		const active = this.isActive(worktree);
		const status = worktree.missing ? undefined : this.getStatus(worktreeStateKeyFor(worktree));
		const fallback = worktree.missing ? Codicon.warning : active ? Codicon.check : worktree.isMainCheckout ? Codicon.repo : Codicon.gitBranch;
		applyStatusIcon(templateData.icon, status, fallback);
		templateData.name.textContent = worktree.name;
		templateData.branch.textContent = worktree.missing
			? localize('paradis.workspaceSwitch.worktreeMissing', "missing")
			: worktree.branch ?? '';
		templateData.row.classList.toggle('active', active);
		templateData.row.classList.toggle('missing', !!worktree.missing);

		// リポジトリ見出し行と同じ色を worktree 行にも継続させる (RepositoryRenderer.renderElement 参照)。
		// 別要素の .monaco-tl-row なのでカスタムプロパティは継承されず、ここで明示的に設定する必要がある
		const colorHex = this.getRepositoryColorHex(worktree.repositoryId);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');

		const diffStat = worktree.missing ? undefined : this.getDiffStat(worktree);
		const hasDiff = !!diffStat && (diffStat.insertions > 0 || diffStat.deletions > 0);
		templateData.diff.classList.toggle('hidden', !hasDiff);
		if (hasDiff && diffStat) {
			templateData.diffAdded.textContent = diffStat.insertions > 0 ? `+${diffStat.insertions}` : '';
			templateData.diffRemoved.textContent = diffStat.deletions > 0 ? `-${diffStat.deletions}` : '';
		}
	}

	disposeTemplate(_templateData: IWorktreeTemplateData): void {
		// テンプレートDOMはツリー側が破棄する
	}
}

/**
 * FleetView 風のリポジトリ一覧ビュー (機能1 Phase 4 / Phase B)。
 * リポジトリを親、git worktree を子とする2階層ツリー。クリックで即座に切り替える。
 */
export class ParadisWorkspacesView extends ViewPane {

	private tree: WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore> | undefined;
	/** worktree の uri.fsPath → 未コミット差分統計。ポーリングでのみ更新する (refreshDiffStats 参照) */
	private readonly _diffStats = new Map<string, IParadisDiffStat>();
	private readonly _diffStatsScheduler: RunOnceScheduler;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._diffStatsScheduler = this._register(new RunOnceScheduler(() => this.refreshDiffStats(), DIFF_STATS_POLL_INTERVAL_MS));

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.updateTree(); this._diffStatsScheduler.schedule(0); }));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.updateTree()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => { this.updateTree(); this._diffStatsScheduler.schedule(0); }));
		// 注意: 引数なしの tree.rerender() は行の renderElement を再実行しないため、
		// setChildren で作り直す (identityProvider により選択/折りたたみ状態は保持される)
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.updateTree()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = DOM.append(container, DOM.$('.paradis-workspaces-list'));
		const getStatus = (stateKey: string) => this.agentStatusStore.getScopeStatus(stateKey);
		const repositoryRenderer = new RepositoryRenderer(
			repository => this.commandService.executeCommand('paradis.workspaceSwitch.createWorktree', repository.id)
		);
		const worktreeRenderer = new WorktreeRenderer(
			worktree => this.workspaceSwitchService.activeStateKey === worktreeStateKeyFor(worktree),
			getStatus,
			worktree => this._diffStats.get(worktree.uri.fsPath),
			repositoryId => paradisWorkspaceColorHex(this.workspaceSwitchService.repositories.find(repository => repository.id === repositoryId)?.color)
		);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore>,
			'ParadisWorkspaces',
			treeContainer,
			new WorkspaceTreeDelegate(),
			[repositoryRenderer, worktreeRenderer],
			{
				identityProvider: {
					getId: (element: WorkspaceTreeElement) => isWorktree(element) ? `worktree:${worktreeStateKeyFor(element)}` : `repo:${element.id}`
				},
				horizontalScrolling: false,
				// worktree 行本体のクリックは「切り替え」専用にし、リポジトリ見出しの開閉は
				// 左端の chevron でのみ行う (見出し行本体のクリックは何もしない)
				expandOnlyOnTwistieClick: true,
				accessibilityProvider: {
					getAriaLabel: (element: WorkspaceTreeElement) => element.name,
					getWidgetAriaLabel: () => localize('paradisWorkspaces', "Workspaces")
				}
			}
		));

		// クリック / Enter で切り替え。リポジトリ行は純粋なグルーピング見出しのため何もしない
		// (main checkout も worktree 行として子要素に含まれ、そちらのクリックで切り替わる)
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element || !isWorktree(element)) {
				return;
			}
			this.openWorktree(element);
		}));

		this._register(this.tree.onContextMenu(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => isWorktree(element)
					? this.buildWorktreeContextMenuActions(element)
					: this.buildRepositoryContextMenuActions(element)
			});
		}));

		this.updateTree();
		this._diffStatsScheduler.schedule(0);
	}

	/** worktree 行 (main checkout の合成行を含む) のクリックで、その作業ツリーへ切り替える。 */
	private openWorktree(worktree: IParadisWorktree): void {
		if (worktree.missing) {
			return;
		}
		// 切り替えは updateFolders / ディスク状態の変化で reject しうる。握り潰さず通知する
		// (放置すると unhandled rejection になりビュー上は「無反応」に見える)。
		const promise = worktree.isMainCheckout
			? this.workspaceSwitchService.switchRepository(worktree.repositoryId)
			: this.workspaceSwitchService.switchToWorktree(worktree);
		promise.catch(error => this.notificationService.error(error));
	}

	/** refreshDiffStats の多重実行防止 (await 中に schedule(0) が割り込むと再入しうる) */
	private _diffStatsInFlight = false;

	/** diff 統計 (+N/-N) をポーリングで取得する。View可視時のみ実行し、非可視時は間隔だけ空けて再チェックする。 */
	private async refreshDiffStats(): Promise<void> {
		if (this._diffStatsInFlight) {
			this._diffStatsScheduler.schedule();
			return;
		}
		if (!this.isBodyVisible()) {
			this._diffStatsScheduler.schedule();
			return;
		}

		const paths = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			paths.add(repository.uri.fsPath);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing) {
					paths.add(worktree.uri.fsPath);
				}
			}
		}

		if (paths.size === 0) {
			this._diffStatsScheduler.schedule();
			return;
		}

		this._diffStatsInFlight = true;
		try {
			const result = await this.commandService.executeCommand<Record<string, IParadisDiffStat>>(GET_DIFF_STATS_COMMAND_ID, [...paths]);
			if (result) {
				this._diffStats.clear();
				for (const [path, stat] of Object.entries(result)) {
					this._diffStats.set(path, stat);
				}
				this.updateTree();
			}
		} catch {
			// web ビルド等でコマンド未登録の場合は無視 (diff バッジを出さないだけで安全に成立する)
		} finally {
			this._diffStatsInFlight = false;
			this._diffStatsScheduler.schedule();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override shouldShowWelcome(): boolean {
		return this.workspaceSwitchService.repositories.length === 0;
	}

	private updateTree(): void {
		if (!this.tree) {
			return;
		}

		const elements: IObjectTreeElement<WorkspaceTreeElement>[] = this.workspaceSwitchService.repositories.map(repository => {
			const worktrees = this.worktreeService.getWorktrees(repository.id);
			// リポジトリ行は純粋なグルーピング見出しにしたため、main checkout (リポジトリ本体) も
			// worktree 行として先頭に混ぜ込む。これにより「今開いているのはどれか」の表示・切り替え・
			// diff統計バッジがすべて worktree 行側のロジックだけで完結する
			const mainCheckout: IParadisWorktree = {
				repositoryId: repository.id,
				name: STR_MAIN_CHECKOUT_NAME,
				branch: this.worktreeService.getRepositoryBranch(repository.id),
				uri: repository.uri,
				isMainCheckout: true
			};
			const children: WorkspaceTreeElement[] = [mainCheckout, ...worktrees];
			return {
				element: repository,
				children: children.map(worktree => ({ element: worktree })),
				collapsible: true,
				collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded
			};
		});
		this.tree.setChildren(null, elements);
		this._onDidChangeViewWelcomeState.fire();
	}

	private buildRepositoryContextMenuActions(repository: IParadisWorkspaceRepository): IAction[] {
		return [
			new Action(
				'paradis.workspaceSwitch.createWorktreeContext',
				localize('paradis.workspaceSwitch.createWorktreeContext', "New Worktree Space..."),
				undefined,
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.createWorktree', repository.id)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.rename',
				localize('paradis.workspaceSwitch.renameContext', "Rename..."),
				undefined,
				true,
				() => this.promptRename(repository)
			),
			// 色選択は QuickPick で行う。以前はコンテキストメニューのサブメニュー + CSS の
			// aria-label 属性セレクタでスウォッチを描画していたが、macOS のコンテキストメニューは
			// ネイティブ (HTML でない) ため色が一切表示されなかった。QuickPick なら全プラットフォームで
			// SVG data URI のスウォッチを表示できる
			new Action(
				'paradis.workspaceSwitch.setColor',
				localize('paradis.workspaceSwitch.setColorPick', "Set Color..."),
				undefined,
				true,
				() => this.promptColor(repository)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.reveal',
				revealLabel(),
				undefined,
				true,
				() => this.commandService.executeCommand('revealFileInOS', repository.uri)
			),
			new Action(
				'paradis.workspaceSwitch.copyPath',
				localize('paradis.workspaceSwitch.copyPath', "Copy Path"),
				undefined,
				true,
				() => this.clipboardService.writeText(repository.uri.fsPath)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.configureLifecycleScripts',
				localize('paradis.workspaceSwitch.configureLifecycleScriptsContext', "Setup/Teardown Scripts..."),
				undefined,
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.configureLifecycleScripts', repository.id)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.removeFromList',
				localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
				undefined,
				true,
				() => this.workspaceSwitchService.removeRepository(repository.id).catch(error => this.notificationService.error(error))
			)
		];
	}

	/** 現在のリポジトリ内での worktree の並び順における位置。存在しない (main checkout 等) 場合は -1。 */
	private worktreeSiblingIndex(worktree: IParadisWorktree): { siblings: readonly IParadisWorktree[]; index: number } {
		const siblings = this.worktreeService.getWorktrees(worktree.repositoryId);
		const index = siblings.findIndex(candidate => candidate.uri.toString() === worktree.uri.toString());
		return { siblings, index };
	}

	/** 隣接する worktree と表示順を入れ替える (Move Up/Down)。 */
	private moveWorktree(worktree: IParadisWorktree, direction: -1 | 1): void {
		const { siblings, index } = this.worktreeSiblingIndex(worktree);
		const targetIndex = index + direction;
		if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
			return;
		}
		const reordered = siblings.map(candidate => candidate.uri.toString());
		[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
		this.worktreeService.setWorktreeOrder(worktree.repositoryId, reordered);
	}

	private buildWorktreeContextMenuActions(worktree: IParadisWorktree): IAction[] {
		const actions: IAction[] = [
			new Action(
				'paradis.workspaceSwitch.worktree.reveal',
				revealLabel(),
				undefined,
				!worktree.missing,
				() => this.commandService.executeCommand('revealFileInOS', worktree.uri)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.copyPath',
				localize('paradis.workspaceSwitch.copyPath', "Copy Path"),
				undefined,
				true,
				() => this.clipboardService.writeText(worktree.uri.fsPath)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.copyBranchName',
				localize('paradis.workspaceSwitch.copyBranchName', "Copy Branch Name"),
				undefined,
				!!worktree.branch,
				() => this.clipboardService.writeText(worktree.branch ?? '')
			)
		];

		// main checkout (リポジトリ本体) は並び替え・削除の対象外。常に先頭固定で、
		// 削除相当の操作はリポジトリ行側の「Remove from List」で行う
		if (worktree.isMainCheckout) {
			return actions;
		}

		const { siblings, index } = this.worktreeSiblingIndex(worktree);
		actions.push(
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.rename',
				localize('paradis.workspaceSwitch.worktreeRenameContext', "Rename..."),
				undefined,
				!worktree.missing,
				() => this.promptRenameWorktree(worktree)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.moveUp',
				localize('paradis.workspaceSwitch.moveUp', "Move Up"),
				undefined,
				index > 0,
				() => this.moveWorktree(worktree, -1)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.moveDown',
				localize('paradis.workspaceSwitch.moveDown', "Move Down"),
				undefined,
				index >= 0 && index < siblings.length - 1,
				() => this.moveWorktree(worktree, 1)
			)
		);

		if (worktree.missing) {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.removeFromList',
					localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
					undefined,
					true,
					async () => this.worktreeService.removeKnownWorktree(worktree)
				)
			);
		} else {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.remove',
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.worktreeRemoveContext', "ワークツリーを削除"),
					undefined,
					true,
					// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
					// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
					() => this.commandService.executeCommand('paradis.workspaceSwitch.removeWorktree', worktree)
				)
			);
		}

		return actions;
	}

	/**
	 * 色選択 QuickPick。スウォッチ (色見本) は SVG の data URI を iconPath として渡して描画する
	 * (QuickPick は HTML 描画なので macOS でも確実に色が見える)。
	 */
	private async promptColor(repository: IParadisWorkspaceRepository): Promise<void> {
		type ColorPickItem = IQuickPickItem & { readonly colorId: string | undefined };
		const swatchIcon = (hex: string): { dark: URI } => {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${hex}"/></svg>`;
			return { dark: URI.parse(`data:image/svg+xml;base64,${btoa(svg)}`) };
		};
		const items: ColorPickItem[] = PARADIS_WORKSPACE_COLORS.map(color => ({
			colorId: color.id,
			label: colorLabel(color.id),
			iconPath: swatchIcon(color.hex),
			description: repository.color === color.id ? localize('paradis.workspaceSwitch.colorCurrent', "current") : undefined
		}));
		items.push({
			colorId: undefined,
			label: localize('paradis.workspaceSwitch.colorDefault', "Default"),
			iconClass: ThemeIcon.asClassName(Codicon.circleSlash),
			description: repository.color === undefined ? localize('paradis.workspaceSwitch.colorCurrent', "current") : undefined
		});

		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('paradis.workspaceSwitch.setColorPlaceholder', "Select a color for '{0}'", repository.name),
			activeItem: items.find(item => item.colorId === repository.color)
		});
		if (picked) {
			await this.workspaceSwitchService.setRepositoryColor(repository.id, picked.colorId);
		}
	}

	private async promptRename(repository: IParadisWorkspaceRepository): Promise<void> {
		const name = await this.quickInputService.input({
			value: repository.name,
			valueSelection: [0, repository.name.length],
			prompt: localize('paradis.workspaceSwitch.renamePrompt', "Enter a new name for this repository"),
			validateInput: async value => value.trim()
				? undefined
				: localize('paradis.workspaceSwitch.renameEmpty', "Name cannot be empty")
		});
		if (name !== undefined && name.trim()) {
			await this.workspaceSwitchService.renameRepository(repository.id, name.trim());
		}
	}

	/**
	 * worktree の表示名を変更する。専用の rename API は用意せず、既存の
	 * addKnownWorktree (同一 path があれば name を上書きする実装) をそのまま使う
	 * (paradisWorktreeService.ts 参照)。main checkout (isMainCheckout) はこの
	 * 台帳の管理外の合成エントリのため対象外 (呼び出し元でメニュー自体を出さない)。
	 */
	private async promptRenameWorktree(worktree: IParadisWorktree): Promise<void> {
		const name = await this.quickInputService.input({
			value: worktree.name,
			valueSelection: [0, worktree.name.length],
			prompt: localize('paradis.workspaceSwitch.worktreeRenamePrompt', "Enter a new name for this worktree"),
			validateInput: async value => value.trim()
				? undefined
				: localize('paradis.workspaceSwitch.renameEmpty', "Name cannot be empty")
		});
		if (name !== undefined && name.trim()) {
			this.worktreeService.addKnownWorktree({ ...worktree, name: name.trim() });
		}
	}
}

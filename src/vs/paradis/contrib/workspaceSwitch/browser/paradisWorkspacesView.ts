/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisWorkspaceSwitch.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
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
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, PARADIS_WORKSPACE_COLORS, paradisWorkspaceColorHex, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

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
		: status === 'permission' || status === 'review' ? Codicon.circleFilled
			: fallback;
	iconElement.className = `codicon ${ThemeIcon.asClassName(icon).replace('codicon ', '')}`;
	if (status === 'working') {
		iconElement.classList.add('codicon-modifier-spin', 'paradis-status-working');
	} else if (status === 'permission') {
		iconElement.classList.add('paradis-status-permission');
	} else if (status === 'review') {
		iconElement.classList.add('paradis-status-review');
	}
}

interface IRepositoryTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly branch: HTMLElement;
}

interface IWorktreeTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly branch: HTMLElement;
}

class WorkspaceTreeDelegate implements IListVirtualDelegate<WorkspaceTreeElement> {
	getHeight(element: WorkspaceTreeElement): number {
		return isWorktree(element) ? 30 : 55;
	}

	getTemplateId(element: WorkspaceTreeElement): string {
		return isWorktree(element) ? WorktreeRenderer.TEMPLATE_ID : RepositoryRenderer.TEMPLATE_ID;
	}
}

class RepositoryRenderer implements ITreeRenderer<IParadisWorkspaceRepository, FuzzyScore, IRepositoryTemplateData> {

	static readonly TEMPLATE_ID = 'paradisRepository';
	readonly templateId = RepositoryRenderer.TEMPLATE_ID;

	constructor(
		private readonly isActive: (repository: IParadisWorkspaceRepository) => boolean,
		private readonly getStatus: (stateKey: string) => ParadisAgentStatus | undefined,
		private readonly getBranch: (repository: IParadisWorkspaceRepository) => string | undefined,
	) { }

	renderTemplate(container: HTMLElement): IRepositoryTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-workspace-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		const labels = DOM.append(row, DOM.$('.paradis-workspace-labels'));
		const name = DOM.append(labels, DOM.$('.paradis-workspace-name'));
		const branch = DOM.append(labels, DOM.$('.paradis-workspace-branch'));
		return { row, icon, name, branch };
	}

	renderElement(node: ITreeNode<IParadisWorkspaceRepository, FuzzyScore>, _index: number, templateData: IRepositoryTemplateData): void {
		const repository = node.element;
		const active = this.isActive(repository);
		const status = this.getStatus(repository.id);
		applyStatusIcon(templateData.icon, status, active ? Codicon.check : Codicon.repo);
		templateData.name.textContent = repository.name;
		// Superset に合わせ、名前の下にはパスではなく main checkout のブランチ名を出す
		// (git 管理外などブランチが取れない場合のみパスにフォールバック)
		templateData.branch.textContent = this.getBranch(repository) ?? repository.uri.fsPath;
		templateData.row.classList.toggle('active', active);

		// Superset と同じ固定パレットの色をアイコンと行左端の色バーに反映。
		// 状態表示中はアイコン色を状態色 (CSSクラス) に譲る。
		// 色バーは chevron より左に置くため .monaco-tl-row の ::before で描画し、
		// 色はカスタムプロパティで渡す (media/paradisWorkspaceSwitch.css 参照)
		const colorHex = paradisWorkspaceColorHex(repository.color);
		templateData.icon.style.color = status !== undefined ? '' : colorHex ?? '';
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');
	}

	disposeTemplate(_templateData: IRepositoryTemplateData): void {
		// テンプレートDOMはツリー側が破棄する
	}
}

class WorktreeRenderer implements ITreeRenderer<IParadisWorktree, FuzzyScore, IWorktreeTemplateData> {

	static readonly TEMPLATE_ID = 'paradisWorktree';
	readonly templateId = WorktreeRenderer.TEMPLATE_ID;

	constructor(
		private readonly isActive: (worktree: IParadisWorktree) => boolean,
		private readonly getStatus: (stateKey: string) => ParadisAgentStatus | undefined,
	) { }

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-worktree-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		const name = DOM.append(row, DOM.$('.paradis-worktree-name'));
		const branch = DOM.append(row, DOM.$('.paradis-worktree-branch'));
		return { row, icon, name, branch };
	}

	renderElement(node: ITreeNode<IParadisWorktree, FuzzyScore>, _index: number, templateData: IWorktreeTemplateData): void {
		const worktree = node.element;
		const active = this.isActive(worktree);
		const status = worktree.missing ? undefined : this.getStatus(paradisWorktreeStateKey(worktree.uri));
		const fallback = worktree.missing ? Codicon.warning : active ? Codicon.check : Codicon.gitBranch;
		applyStatusIcon(templateData.icon, status, fallback);
		templateData.name.textContent = worktree.name;
		templateData.branch.textContent = worktree.missing
			? localize('paradis.workspaceSwitch.worktreeMissing', "missing")
			: worktree.branch ?? '';
		templateData.row.classList.toggle('active', active);
		templateData.row.classList.toggle('missing', !!worktree.missing);
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.updateTree()));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.updateTree()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => this.updateTree()));
		// 注意: 引数なしの tree.rerender() は行の renderElement を再実行しないため、
		// setChildren で作り直す (identityProvider により選択/折りたたみ状態は保持される)
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.updateTree()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = DOM.append(container, DOM.$('.paradis-workspaces-list'));
		const getStatus = (stateKey: string) => this.agentStatusStore.getScopeStatus(stateKey);
		const repositoryRenderer = new RepositoryRenderer(
			repository => this.workspaceSwitchService.activeStateKey === repository.id,
			getStatus,
			repository => this.worktreeService.getRepositoryBranch(repository.id)
		);
		const worktreeRenderer = new WorktreeRenderer(worktree => this.workspaceSwitchService.activeStateKey === paradisWorktreeStateKey(worktree.uri), getStatus);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore>,
			'ParadisWorkspaces',
			treeContainer,
			new WorkspaceTreeDelegate(),
			[repositoryRenderer, worktreeRenderer],
			{
				identityProvider: {
					getId: (element: WorkspaceTreeElement) => isWorktree(element) ? paradisWorktreeStateKey(element.uri) : element.id
				},
				horizontalScrolling: false,
				// 行本体のクリックは「切り替え」専用にし、worktree の開閉は左端の chevron でのみ行う
				expandOnlyOnTwistieClick: true,
				accessibilityProvider: {
					getAriaLabel: (element: WorkspaceTreeElement) => element.name,
					getWidgetAriaLabel: () => localize('paradisWorkspaces', "Workspaces")
				}
			}
		));

		// クリック / Enter で切り替え
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (isWorktree(element)) {
				if (!element.missing) {
					this.workspaceSwitchService.switchToWorktree(element);
				}
			} else {
				this.workspaceSwitchService.switchRepository(element.id);
			}
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
			return {
				element: repository,
				children: worktrees.map(worktree => ({ element: worktree as WorkspaceTreeElement })),
				collapsible: worktrees.length > 0,
				collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded
			};
		});
		this.tree.setChildren(null, elements);
		this._onDidChangeViewWelcomeState.fire();
	}

	private buildRepositoryContextMenuActions(repository: IParadisWorkspaceRepository): IAction[] {
		return [
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
				'paradis.workspaceSwitch.removeFromList',
				localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
				undefined,
				true,
				() => this.workspaceSwitchService.removeRepository(repository.id)
			)
		];
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
			)
		];

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
}

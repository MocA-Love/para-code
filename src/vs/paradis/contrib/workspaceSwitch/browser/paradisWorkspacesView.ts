/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisWorkspaceSwitch.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

export const PARADIS_WORKSPACES_VIEW_ID = 'workbench.view.paradisWorkspaces.repositories';

interface IRepositoryTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly path: HTMLElement;
}

class RepositoryDelegate implements IListVirtualDelegate<IParadisWorkspaceRepository> {
	getHeight(): number {
		return 44;
	}

	getTemplateId(): string {
		return RepositoryRenderer.TEMPLATE_ID;
	}
}

class RepositoryRenderer implements IListRenderer<IParadisWorkspaceRepository, IRepositoryTemplateData> {

	static readonly TEMPLATE_ID = 'paradisRepository';
	readonly templateId = RepositoryRenderer.TEMPLATE_ID;

	constructor(private readonly isActive: (repository: IParadisWorkspaceRepository) => boolean) { }

	renderTemplate(container: HTMLElement): IRepositoryTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-workspace-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		const labels = DOM.append(row, DOM.$('.paradis-workspace-labels'));
		const name = DOM.append(labels, DOM.$('.paradis-workspace-name'));
		const path = DOM.append(labels, DOM.$('.paradis-workspace-path'));
		return { row, icon, name, path };
	}

	renderElement(repository: IParadisWorkspaceRepository, _index: number, templateData: IRepositoryTemplateData): void {
		const active = this.isActive(repository);
		templateData.icon.className = `codicon ${active ? ThemeIcon.asClassName(Codicon.check).replace('codicon ', '') : ThemeIcon.asClassName(Codicon.repo).replace('codicon ', '')}`;
		templateData.name.textContent = repository.name;
		templateData.path.textContent = repository.uri.fsPath;
		templateData.row.classList.toggle('active', active);
	}

	disposeTemplate(_templateData: IRepositoryTemplateData): void {
		// テンプレートDOMはリスト側が破棄する
	}
}

/**
 * FleetView 風のリポジトリ一覧ビュー (機能1 Phase 4)。クリックで即座にワークスペースを
 * 切り替える。アクティブなリポジトリにはチェックアイコンを表示する。
 */
export class ParadisWorkspacesView extends ViewPane {

	private list: WorkbenchList<IParadisWorkspaceRepository> | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.updateList()));
		this._register(this.workspaceSwitchService.onDidSwitchRepository(() => this.updateList()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const listContainer = DOM.append(container, DOM.$('.paradis-workspaces-list'));
		const renderer = new RepositoryRenderer(repository => this.workspaceSwitchService.activeRepository?.id === repository.id);
		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IParadisWorkspaceRepository>,
			'ParadisWorkspaces',
			listContainer,
			new RepositoryDelegate(),
			[renderer],
			{
				identityProvider: { getId: (repository: IParadisWorkspaceRepository) => repository.id },
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: (repository: IParadisWorkspaceRepository) => repository.name,
					getWidgetAriaLabel: () => localize('paradisWorkspaces', "Workspaces")
				}
			}
		));

		// クリック / Enter で切り替え
		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this.workspaceSwitchService.switchRepository(e.element.id);
			}
		}));

		// 右クリックでリストから削除
		this._register(this.list.onContextMenu(e => {
			const repository = e.element;
			if (!repository) {
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => [
					new Action(
						'paradis.workspaceSwitch.removeFromList',
						localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
						undefined,
						true,
						() => this.workspaceSwitchService.removeRepository(repository.id)
					)
				]
			});
		}));

		this.updateList();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.list?.layout(height, width);
	}

	override shouldShowWelcome(): boolean {
		return this.workspaceSwitchService.repositories.length === 0;
	}

	private updateList(): void {
		if (!this.list) {
			return;
		}
		const repositories = [...this.workspaceSwitchService.repositories];
		this.list.splice(0, this.list.length, repositories);
		this._onDidChangeViewWelcomeState.fire();
	}
}

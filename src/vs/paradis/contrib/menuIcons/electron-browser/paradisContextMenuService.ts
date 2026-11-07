/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IContextMenuDelegate } from '../../../../base/browser/contextmenu.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuMenuDelegate, IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ContextMenuMenuDelegate } from '../../../../platform/contextview/browser/contextMenuService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { hasNativeContextMenu } from '../../../../platform/window/common/window.js';
import { ContextMenuService } from '../../../../workbench/services/contextmenu/electron-browser/contextmenuService.js';
import { paradisDecorateMenuActions } from '../browser/paradisMenuIcons.js';

/**
 * Desktop context menu service that adds the fork's icons and danger color to upstream commands
 * (paradisMenuIcons.ts) before the menu is drawn. Only HTML menus (window.menuStyle: custom) can show
 * them; native menus get the actions unchanged.
 *
 * It wraps upstream's desktop ContextMenuService (created through the instantiation service, so this
 * file does not depend on its constructor) and replaces upstream's registration through
 * registerSingleton: this file is imported from paradis.electron-browser.contribution.ts, which
 * workbench.desktop.main.ts loads after services/contextmenu/electron-browser/contextmenuService.js,
 * and the workbench applies the registrations in order, so this one wins.
 */
export class ParadisContextMenuService extends Disposable implements IContextMenuService {

	declare readonly _serviceBrand: undefined;

	private readonly inner: ContextMenuService;

	get onDidShowContextMenu(): Event<void> { return this.inner.onDidShowContextMenu; }
	get onDidHideContextMenu(): Event<void> { return this.inner.onDidHideContextMenu; }

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.inner = this._register(instantiationService.createInstance(ContextMenuService));
	}

	showContextMenu(delegate: IContextMenuDelegate | IContextMenuMenuDelegate): void {
		if (hasNativeContextMenu(this.configurationService)) {
			this.inner.showContextMenu(delegate);
			return;
		}
		// transform() keeps the menuId on the delegate it returns; drop it so the HTML service does not
		// resolve the menu a second time and add its items again.
		const { menuId: _menuId, ...resolved } = ContextMenuMenuDelegate.transform(delegate, this.menuService, this.contextKeyService) as IContextMenuDelegate & Partial<IContextMenuMenuDelegate>;
		this.inner.showContextMenu({
			...resolved,
			getActions: () => paradisDecorateMenuActions(resolved.getActions()),
		});
	}
}

registerSingleton(IContextMenuService, ParadisContextMenuService, InstantiationType.Delayed);

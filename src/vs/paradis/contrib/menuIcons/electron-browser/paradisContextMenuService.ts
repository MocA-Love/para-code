/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IContextMenuDelegate } from '../../../../base/browser/contextmenu.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuMenuDelegate, IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ContextMenuMenuDelegate } from '../../../../platform/contextview/browser/contextMenuService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { hasNativeContextMenu } from '../../../../platform/window/common/window.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ContextMenuService } from '../../../../workbench/services/contextmenu/electron-browser/contextmenuService.js';
import { paradisDecorateMenuActions } from '../browser/paradisMenuIcons.js';

/**
 * Desktop context menu service that adds the fork's icons and danger color to upstream commands
 * (paradisMenuIcons.ts) before the menu is drawn. Only HTML menus (window.menuStyle: custom) can show
 * them; native menus get the actions unchanged.
 *
 * Replaces upstream's registration through registerSingleton: this file is imported from
 * paradis.electron-browser.contribution.ts, which workbench.desktop.main.ts loads after
 * services/contextmenu/electron-browser/contextmenuService.js, and the workbench applies the
 * registrations in order, so this one wins.
 */
export class ParadisContextMenuService extends ContextMenuService {

	constructor(
		@INotificationService notificationService: INotificationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService private readonly paradisConfigurationService: IConfigurationService,
		@IContextViewService contextViewService: IContextViewService,
		@IMenuService private readonly paradisMenuService: IMenuService,
		@IContextKeyService private readonly paradisContextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
	) {
		super(notificationService, telemetryService, keybindingService, paradisConfigurationService, contextViewService, paradisMenuService, paradisContextKeyService, hostService);
	}

	override showContextMenu(delegate: IContextMenuDelegate | IContextMenuMenuDelegate): void {
		if (hasNativeContextMenu(this.paradisConfigurationService)) {
			super.showContextMenu(delegate);
			return;
		}
		// transform() keeps the menuId on the delegate it returns; drop it so the HTML service does not
		// resolve the menu a second time and add its items again.
		const { menuId: _menuId, ...resolved } = ContextMenuMenuDelegate.transform(delegate, this.paradisMenuService, this.paradisContextKeyService) as IContextMenuDelegate & Partial<IContextMenuMenuDelegate>;
		super.showContextMenu({
			...resolved,
			getActions: () => paradisDecorateMenuActions(resolved.getActions()),
		});
	}
}

registerSingleton(IContextMenuService, ParadisContextMenuService, InstantiationType.Delayed);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の管理画面を開くコマンドと、共有の確認に使う窓口。
// paradis.electron-browser.contribution.ts への import 1 行で有効になる。

import './media/paradisBrowserExtensions.css';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserActionCategory } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { PARADIS_MANAGE_BROWSER_EXTENSIONS_COMMAND_ID } from '../common/paradisBrowserExtensions.js';
import { paradisShowBrowserExtensionsDialog } from './paradisBrowserExtensionsDialog.js';
import { IParadisBrowserExtensionsService, ParadisBrowserExtensionsService } from './paradisBrowserExtensionsService.js';
import { ParadisBrowserExtensionTabActivationContribution } from './paradisBrowserExtensionTabActivation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

registerSingleton(IParadisBrowserExtensionsService, ParadisBrowserExtensionsService, InstantiationType.Delayed);
registerWorkbenchContribution2(ParadisBrowserExtensionTabActivationContribution.ID, ParadisBrowserExtensionTabActivationContribution, WorkbenchPhase.AfterRestored);

registerAction2(class ParadisManageBrowserExtensionsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_MANAGE_BROWSER_EXTENSIONS_COMMAND_ID,
			title: localize2('paradis.browserExtensions.action.manage', "Manage Browser Extensions (Experimental)"),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		paradisShowBrowserExtensionsDialog(accessor.get(IInstantiationService));
	}
});

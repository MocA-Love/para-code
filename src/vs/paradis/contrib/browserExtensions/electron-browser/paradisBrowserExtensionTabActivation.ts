/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能が tabs.update({ active: true }) などで内蔵ブラウザのタブを前に出したいとき、main からの求めを
// 受けて、このウィンドウのエディタでそのタブを開く（タブがエディタのどこにあるかは workbench しか知らない）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisBrowserExtensionsMainService, PARADIS_BROWSER_EXTENSIONS_CHANNEL } from '../common/paradisBrowserExtensions.js';

export class ParadisBrowserExtensionTabActivationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserExtensionTabActivation';

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IBrowserViewWorkbenchService browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@ILogService logService: ILogService,
	) {
		super();
		const mainService = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));
		this._register(mainService.onDidRequestActivateTab(({ viewId }) => {
			// このウィンドウ（と補助ウィンドウ）にあるタブだけを扱う。ほかのウィンドウは自分のタブを扱う
			const input = browserViewWorkbenchService.getKnownBrowserViews().get(viewId);
			if (!input) {
				return;
			}
			const group = editorGroupsService.groups.find(candidate => candidate.contains(input));
			editorService.openEditor(input, { preserveFocus: false }, group).catch(error => logService.warn('[paradis] could not bring a browser tab forward for an extension', error));
		}));
	}
}

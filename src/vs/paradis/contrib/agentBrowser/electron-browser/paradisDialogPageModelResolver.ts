/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisBrowserScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { paradisResolveDialogPage } from './paradisDialogPageResolver.js';

/**
 * バインディングダイアログの対象ページを解決する。サービス参照は待機前に取得し、
 * ServicesAccessor の呼び出し寿命を非同期処理へ持ち越さない。
 */
export function resolveDialogPageModel(accessor: ServicesAccessor, instanceId?: number): Promise<IBrowserViewModel | undefined> {
	const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
	const browserScopeService = accessor.get(IParadisBrowserScopeService);
	const editorService = accessor.get(IEditorService);
	let exactPageId: string | undefined;
	if (instanceId !== undefined) {
		const bindingModel = accessor.get(IParadisAgentBrowserBindingModel);
		const paneTokenService = accessor.get(IParadisPaneTokenService);
		const token = paneTokenService.getTokenForInstance(instanceId);
		exactPageId = token ? bindingModel.getBindingForToken(token)?.pageId : undefined;
	}

	return paradisResolveDialogPage({
		exactPageId,
		getKnownPage: pageId => browserViewWorkbenchService.getKnownBrowserViews().get(pageId)?.model,
		initializationBarrier: browserScopeService.initializationBarrier,
		getActivePage: () => {
			const input = editorService.activeEditor;
			return input instanceof BrowserEditorInput ? input.model : undefined;
		},
		getContextualPage: () => [...browserViewWorkbenchService.getContextualBrowserViews().values()].find(input => !!input.model)?.model,
		isStableContextualPage: page => {
			const contextualInput = browserViewWorkbenchService.getContextualBrowserViews().get(page.id);
			return contextualInput?.model === page && browserScopeService.resolveScope(page.id).kind !== 'pending';
		},
	});
}
